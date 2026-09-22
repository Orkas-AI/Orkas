import { afterEach, describe, expect, it, vi } from "vitest";
import { createPiProvider } from "../src/providers/pi-provider.js";
import type { CompletionParams } from "../src/providers/base.js";

const routingHeader = "x-codex-turn-state";
const token = (account: string) => `fixture.${Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: account },
})).toString("base64")}.fixture`;
const params = (providerTurnContext?: object): CompletionParams => ({
  model: "gpt-5.5", sessionId: "fixture-session", providerTurnContext,
  messages: [{ role: "user", content: [{ type: "text", text: "Process the next batch" }] }],
});
const provider = (account = "account-a", onPayload?: (value: unknown) => void) => createPiProvider({
  provider: "openai-codex", model: "gpt-5.5", apiKey: token(account), onPayload,
});
function response(state?: string, status = 200): Response {
  const headers: Record<string, string> = { "content-type": "text/event-stream" };
  if (state !== undefined) headers[routingHeader] = state;
  const event = { type: "response.completed", response: {
    id: "fixture-response", status: "completed", output: [],
    usage: { input_tokens: 100, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } },
  } };
  return new Response(status === 200 ? `data: ${JSON.stringify(event)}\n\n` : "fixture service failure", { status, headers });
}
async function stream(p: ReturnType<typeof provider>, request: CompletionParams): Promise<void> {
  for await (const event of p.stream(request)) {
    if (event.type === "error") throw event.error;
  }
}
afterEach(() => vi.unstubAllGlobals());

describe("Codex user-turn routing continuity", () => {
  it.each([undefined, "low"] as const)("replays the first state across rebuilt providers and complete/stream (reasoning=%s)", async (reasoning) => {
    const requests: Headers[] = [];
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      requests.push(new Headers(init.headers));
      bodies.push(typeof init.body === "string" ? init.body : "compressed");
      return response(requests.length === 1 ? "private-routing-first" : "private-routing-later");
    }));
    const request = { ...params({}), reasoning };
    const build = () => provider("account-a", payload => { bodies.push(JSON.stringify(payload)); });
    await stream(build(), request);
    await build().complete(request);
    await stream(build(), request);
    expect(requests.map(h => h.get(routingHeader))).toEqual([null, "private-routing-first", "private-routing-first"]);
    expect(bodies.join(" ")).not.toContain("private-routing");
    expect(JSON.stringify(request)).not.toContain("private-routing");
    expect(requests.map(h => h.get("session-id"))).toEqual(Array(3).fill("fixture-session"));
  });

  it("isolates interleaved tasks and starts a new user turn without the previous state", async () => {
    const requests: Headers[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      requests.push(new Headers(init.headers));
      return response(`state-${requests.length}`);
    }));
    const p = provider(), a = params({}), b = params({});
    await stream(p, a);
    await stream(p, b);
    await stream(p, a);
    await stream(p, b);
    await stream(p, params({}));
    expect(requests.map(h => h.get(routingHeader))).toEqual([null, null, "state-1", "state-2", null]);
  });

  it("drops the state on credential ownership changes, including rotation back to the original account", async () => {
    const requests: Headers[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      requests.push(new Headers(init.headers));
      return response(`state-${requests.length}`);
    }));
    const request = params({});
    for (const account of ["a", "a", "b", "a", "a"]) await stream(provider(account), request);
    expect(requests.map(h => h.get(routingHeader))).toEqual([null, "state-1", null, null, "state-4"]);
  });

  it("does not let a delayed response from an old owner overwrite the new owner's state", async () => {
    let release!: (value: Response) => void;
    const requests: Headers[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      requests.push(new Headers(init.headers));
      if (requests.length === 1) return new Promise<Response>(resolve => { release = resolve; });
      return response("new-owner-state");
    }));
    const request = params({});
    const old = stream(provider("old"), request);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await stream(provider("new"), request);
    release(response("old-owner-state"));
    await old;
    await stream(provider("new"), request);
    expect(requests[2].get(routingHeader)).toBe("new-owner-state");
  });

  it("keeps routing on a recoverable failure without adding retries or accepting an error response's state", async () => {
    const requests: Headers[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      requests.push(new Headers(init.headers));
      return requests.length === 2 ? response("error-state", 503) : response("good-state");
    }));
    const onRequestFailure = vi.fn();
    const request = { ...params({}), onRequestFailure };
    await stream(provider(), request);
    await expect(stream(provider(), request)).rejects.toBeDefined();
    expect(requests).toHaveLength(2);
    await stream(provider(), request);
    await stream(provider(), params({}));
    expect(requests.map(h => h.get(routingHeader))).toEqual([null, "good-state", "good-state", null]);
    expect(onRequestFailure).toHaveBeenCalledTimes(1);
    expect(onRequestFailure).toHaveBeenCalledWith(expect.objectContaining({
      phase: "after_response", httpStatus: 503, aborted: false,
    }));
  });

  it("does not guess a turn from sessionId when no explicit turn context is supplied", async () => {
    const requests: Headers[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      requests.push(new Headers(init.headers));
      return response("must-not-leak");
    }));
    const p = provider();
    await stream(p, params());
    await stream(p, params());
    expect(requests.map(h => h.get(routingHeader))).toEqual([null, null]);
  });

  it("keeps an interrupted turn resumable but does not carry its state to the next turn", async () => {
    const requests: Headers[] = [];
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      requests.push(new Headers(init.headers));
      if (requests.length === 2) {
        controller.abort();
        throw new DOMException("Fixture cancellation", "AbortError");
      }
      return response("turn-state");
    }));
    const request = params({});
    await stream(provider(), request);
    await expect(stream(provider(), { ...request, signal: controller.signal })).rejects.toBeDefined();
    expect(requests).toHaveLength(2);
    await stream(provider(), request);
    await stream(provider(), params({}));
    expect(requests.map(h => h.get(routingHeader))).toEqual([null, "turn-state", "turn-state", null]);
  });

  it("does not send state across endpoint or session changes even if a caller reuses a turn handle", async () => {
    const requests: Headers[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      requests.push(new Headers(init.headers));
      return response(`state-${requests.length}`);
    }));
    const request = params({});
    await stream(provider(), request);
    const changedEndpoint = createPiProvider({ provider: "openai-codex", model: "gpt-5.5",
      apiKey: token("account-a"), baseUrl: "https://fixture.invalid/backend-api" });
    await stream(changedEndpoint, request);
    await stream(changedEndpoint, { ...request, sessionId: "other-session" });
    expect(requests.map(h => h.get(routingHeader))).toEqual([null, null, null]);
  });

  it("allows missing state and captures the first later non-empty state", async () => {
    const requests: Headers[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      requests.push(new Headers(init.headers));
      return response([undefined, "", "later-state", "ignored"][requests.length - 1]);
    }));
    const request = params({});
    for (let i = 0; i < 4; i++) await stream(provider(), request);
    expect(requests.map(h => h.get(routingHeader))).toEqual([null, null, null, "later-state"]);
  });

  it("does not apply the Codex header to ordinary OpenAI Responses", async () => {
    const requests: Headers[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      requests.push(new Headers(init.headers));
      return response("codex-looking-state");
    }));
    const p = createPiProvider({ provider: "openai", model: "gpt-5.5", apiKey: "fixture-key" });
    const request = params({});
    await stream(p, request);
    await stream(p, request);
    expect(requests.map(h => h.get(routingHeader))).toEqual([null, null]);
  });
});
