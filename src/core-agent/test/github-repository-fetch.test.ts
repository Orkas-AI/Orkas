import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchGitHubRepositorySnapshot,
  identifyGitHubRepositoryResource,
} from "../src/tools/github-repository-fetch.js";
import { getBuiltinTools } from "../src/tools/index.js";

const REPOSITORY_URL = "https://github.com/example/project";
const METADATA_URL = "https://api.github.com/repos/example/project";
const README_URL = `${METADATA_URL}/readme`;
const RAW_URL = "https://raw.githubusercontent.com/example/project/main/README.md";

const metadata = {
  full_name: "example/project",
  description: "Example desktop assistant",
  pushed_at: "2026-07-28T10:00:00Z",
  license: {
    name: "Apache License 2.0",
    spdx_id: "Apache-2.0",
    url: "https://api.github.com/licenses/apache-2.0",
  },
};

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.toString() : input.url;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function textResponse(value: string, status = 200): Response {
  return new Response(value, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function repositoryResource() {
  const resource = identifyGitHubRepositoryResource(REPOSITORY_URL);
  if (!resource) throw new Error("test repository URL was not recognized");
  return resource;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("GitHub repository web_fetch provider", () => {
  it.each([false, true])("fetches an independent raw source after a denied root (in flight: %s)", async inFlight => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (requestUrl(input) === RAW_URL) return textResponse("# Independent README\nRecovered source.");
      if (inFlight) await gate;
      return textResponse("Forbidden", 403);
    });
    vi.stubGlobal("fetch", fetchMock);
    const webFetch = getBuiltinTools().find(tool => tool.name === "web_fetch")!;
    const context = { state: { runScopedLedger: new Map() } };
    const root = webFetch.execute({ url: REPOSITORY_URL }, context);
    if (!inFlight) await root;
    const raw = webFetch.execute({ url: RAW_URL }, context);
    try {
      // The raw host must be contacted even while GitHub's API is still pending.
      await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url]) => requestUrl(url) === RAW_URL)).toBe(true), { timeout: 150 });
    } finally {
      release();
      await root;
      await raw;
    }
    expect((await root).isError).toBe(true);
    expect((await raw).isError).toBeUndefined();
    expect((await raw).content).toContain("Recovered source.");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each(["readme", "metadata"] as const)("reuses only the acquired component when %s fails", async failed => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url === METADATA_URL) return failed === "metadata" ? textResponse("unavailable", 503) : jsonResponse(metadata);
      if (url === README_URL) return failed === "readme" ? textResponse("unavailable", 503) : textResponse("# Acquired README");
      if (url === RAW_URL) return textResponse("# Raw recovery");
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const webFetch = getBuiltinTools().find(tool => tool.name === "web_fetch")!;
    const context = { state: {} };
    const snapshot = await webFetch.execute({ url: REPOSITORY_URL }, context);
    const missing = await webFetch.execute({ url: failed === "readme" ? README_URL : METADATA_URL }, context);
    const acquired = await webFetch.execute({ url: failed === "readme" ? METADATA_URL : README_URL }, context);
    const raw = await webFetch.execute({ url: RAW_URL }, context);
    expect(snapshot.isError).toBeUndefined();
    expect(snapshot.content).toContain("unavailable: HTTP 503");
    expect(missing.isError).toBe(true);
    expect(missing.content).toContain("HTTP 503");
    expect(missing.content).not.toContain("GITHUB_REPOSITORY_SNAPSHOT_CACHE_HIT");
    expect(acquired.isError).toBeUndefined();
    expect(acquired.content).toContain("GITHUB_REPOSITORY_SNAPSHOT_CACHE_HIT");
    expect(acquired.content).not.toContain("metadata and README were already fetched");
    expect(raw.content).toBe("# Raw recovery");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("keeps raw refs, nested paths and API ref queries independent while deduplicating exact URLs", async () => {
    const sources = new Map([
      [RAW_URL, "# Main source"],
      [RAW_URL.replace("/main/", "/release/"), "# Release source"],
      [RAW_URL.replace("/README.md", "/docs/README.md"), "# Nested source"],
      [`${README_URL}?ref=release`, "# API release source"],
    ]);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url === METADATA_URL) return jsonResponse(metadata);
      if (url === README_URL) return textResponse("# Default snapshot source");
      if (sources.has(url)) return textResponse(sources.get(url)!);
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const webFetch = getBuiltinTools().find(tool => tool.name === "web_fetch")!;
    const runScopedLedger = new Map();
    await webFetch.execute({ url: REPOSITORY_URL }, { state: { runScopedLedger } });
    for (const [url, body] of sources) {
      const [first, duplicate] = await Promise.all([
        webFetch.execute({ url }, { state: { runScopedLedger } }),
        webFetch.execute({ url: `${url}#section` }, { state: { runScopedLedger } }),
      ]);
      expect(first.isError).toBeUndefined();
      expect(first.content).toBe(body);
      expect(duplicate.content).toBe(body);
    }
    expect(fetchMock).toHaveBeenCalledTimes(6);
    const otherRun = await webFetch.execute({ url: RAW_URL }, { state: {} });
    expect(otherRun.content).toBe(sources.get(RAW_URL));
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it.each([403, 503])("preserves the raw URL's own failure policy after root success (HTTP %s)", async status => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url === METADATA_URL) return jsonResponse(metadata);
      if (url === README_URL) return textResponse("# Default README");
      return textResponse("failed", status);
    });
    vi.stubGlobal("fetch", fetchMock);
    const webFetch = getBuiltinTools().find(tool => tool.name === "web_fetch")!;
    const context = { state: {} };
    await webFetch.execute({ url: REPOSITORY_URL }, context);
    const first = await webFetch.execute({ url: RAW_URL }, context);
    const second = await webFetch.execute({ url: RAW_URL }, context);
    const third = await webFetch.execute({ url: RAW_URL }, context);
    expect(first.isError).toBe(true);
    expect(first.content).toContain(`HTTP ${status}`);
    expect(third.content).toContain("E_WEB_FETCH_NONRETRYABLE_CACHE_HIT");
    if (status === 503) expect(second.content).toContain("E_WEB_FETCH_RETRY_LIMIT");
    else expect(second.content).toContain("E_WEB_FETCH_NONRETRYABLE_CACHE_HIT");
    expect(fetchMock).toHaveBeenCalledTimes(status === 503 ? 4 : 3);
  });

  it("does not contact raw sources after cancellation, even with a cached root", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => requestUrl(input) === METADATA_URL
      ? jsonResponse(metadata) : textResponse("# Default README"));
    vi.stubGlobal("fetch", fetchMock);
    const webFetch = getBuiltinTools().find(tool => tool.name === "web_fetch")!;
    const context = { state: {} };
    await webFetch.execute({ url: REPOSITORY_URL }, context);
    const controller = new AbortController();
    controller.abort();
    const result = await webFetch.execute({ url: RAW_URL }, { ...context, signal: controller.signal });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("cancelled");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["metadata", "invalid JSON"],
    ["metadata", "null"],
    ["readme", " \n\t"],
  ] as const)("does not certify an unusable %s component (%j)", async (component, body) => {
    const failedUrl = component === "metadata" ? METADATA_URL : README_URL;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (requestUrl(input) === failedUrl) return textResponse(body);
      return component === "metadata" ? textResponse("# Available README") : jsonResponse(metadata);
    }));
    const webFetch = getBuiltinTools().find(tool => tool.name === "web_fetch")!;
    const context = { state: {} };
    const root = await webFetch.execute({ url: REPOSITORY_URL }, context);
    const unusable = await webFetch.execute({ url: failedUrl }, context);
    const available = await webFetch.execute({ url: component === "metadata" ? README_URL : METADATA_URL }, context);
    expect(root.isError).toBeUndefined();
    expect(root.content).toContain(component === "metadata" ? "# Available README" : "- Full name: example/project");
    expect(unusable.isError).toBe(true);
    expect(unusable.content).not.toContain("GITHUB_REPOSITORY_SNAPSHOT_CACHE_HIT");
    expect(available.isError).toBeUndefined();
    expect(available.content).toContain("GITHUB_REPOSITORY_SNAPSHOT_CACHE_HIT");
  });

  it("cancels an active independent raw request and releases its deadline", async () => {
    vi.useFakeTimers();
    let rawSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((input: string | URL | Request, init: RequestInit) => {
      const url = requestUrl(input);
      if (url === METADATA_URL) return Promise.resolve(jsonResponse(metadata));
      if (url === README_URL) return Promise.resolve(textResponse("# Default README"));
      rawSignal = init.signal!;
      return new Promise<Response>((_resolve, reject) => {
        rawSignal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const webFetch = getBuiltinTools().find(tool => tool.name === "web_fetch")!;
    const context = { state: {} };
    await webFetch.execute({ url: REPOSITORY_URL }, context);
    const controller = new AbortController();
    const pending = webFetch.execute({ url: RAW_URL }, { ...context, signal: controller.signal });
    controller.abort();
    const result = await pending;
    expect(rawSignal?.aborted).toBe(true);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("cancelled");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails a snapshot with no usable components even when both HTTP responses are successful", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => textResponse(
      requestUrl(input) === METADATA_URL ? "invalid JSON" : " \n\t",
    )));
    const webFetch = getBuiltinTools().find(tool => tool.name === "web_fetch")!;
    const result = await webFetch.execute({ url: REPOSITORY_URL }, { state: {} });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Metadata unavailable: GitHub metadata response was not valid JSON");
    expect(result.content).toContain("README unavailable: GitHub README response was empty");
  });

  it.each([false, true])("does not claim cached source evidence after a denied repository fetch (in flight: %s)", async inFlight => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fetchMock = vi.fn(async () => {
      if (inFlight) await gate;
      return textResponse("Forbidden", 403);
    });
    vi.stubGlobal("fetch", fetchMock);
    const webFetch = getBuiltinTools().find(tool => tool.name === "web_fetch")!;
    const context = { state: { runScopedLedger: new Map() } };
    const root = webFetch.execute({ url: REPOSITORY_URL }, context);
    if (!inFlight) await root;
    const alias = webFetch.execute({ url: README_URL }, context);
    release();
    expect((await root).isError).toBe(true);
    for (const result of [await alias, await webFetch.execute({ url: METADATA_URL }, context)]) {
      expect(result.isError).toBe(true);
      expect(result.content).toContain("HTTP 403");
      expect(result.content).not.toContain("GITHUB_REPOSITORY_SNAPSHOT_CACHE_HIT");
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not start repository requests after the task was cancelled", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(metadata));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    controller.abort();
    const webFetch = getBuiltinTools().find(tool => tool.name === "web_fetch")!;
    const result = await webFetch.execute({ url: REPOSITORY_URL }, { state: {}, signal: controller.signal });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("cancelled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("releases the sibling request when one parallel request fails", async () => {
    let siblingSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init: RequestInit) => {
      if (requestUrl(input) === METADATA_URL) return Promise.reject(new Error("fetch failed"));
      siblingSignal = init.signal!;
      return new Promise<Response>((_resolve, reject) => {
        siblingSignal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }));
    const { result } = await fetchGitHubRepositorySnapshot(repositoryResource());
    expect(result.isError).toBe(true);
    expect(siblingSignal?.aborted).toBe(true);
  });

  it.each(["headers", "body"])("cancels both repository requests while waiting for %s", async stage => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn((_input: unknown, init: RequestInit) => {
      const signal = init.signal!;
      signals.push(signal);
      if (stage === "headers") {
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        });
      }
      return Promise.resolve(new Response(new ReadableStream({
        start(stream) {
          signal.addEventListener("abort", () => stream.error(new DOMException("aborted", "AbortError")), { once: true });
        },
      })));
    });
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const webFetch = getBuiltinTools().find(tool => tool.name === "web_fetch")!;
    const pending = webFetch.execute({ url: REPOSITORY_URL }, { state: {}, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    try {
      expect(signals).toHaveLength(2);
      expect(signals.every(signal => signal.aborted)).toBe(true);
      const result = await pending;
      expect(result.isError).toBe(true);
      expect(result.content).toContain("cancelled");
      expect(result.content).not.toContain("Timeout");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      // Also release the pre-fix implementation through its existing deadline.
      await vi.advanceTimersByTimeAsync(60_000);
      await pending;
    }
  });

  it("keeps metadata when the README request fails", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url === METADATA_URL) return jsonResponse(metadata);
      if (url === README_URL) return textResponse("unavailable", 503);
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = await fetchGitHubRepositorySnapshot(repositoryResource());

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Title: example/project");
    expect(result.content).toContain("- License SPDX ID: Apache-2.0");
    expect(result.content).toContain("- README unavailable: HTTP 503");
    expect(result.content).toContain("README unavailable; do not infer README-backed claims.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the README when the metadata request fails", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url === METADATA_URL) return jsonResponse({ error: "unavailable" }, 503);
      if (url === README_URL) return textResponse("# Project\nRuns locally on Windows.");
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = await fetchGitHubRepositorySnapshot(repositoryResource());

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Title: Not provided");
    expect(result.content).toContain("- Metadata unavailable: HTTP 503");
    expect(result.content).toContain("# Project\nRuns locally on Windows.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache a snapshot when both GitHub requests fail", async () => {
    const fetchMock = vi.fn(async () => textResponse("unavailable", 503));
    vi.stubGlobal("fetch", fetchMock);
    const webFetch = getBuiltinTools().find((tool) => tool.name === "web_fetch")!;
    const context = { state: {} };

    const first = await webFetch.execute({ url: REPOSITORY_URL }, context);
    const second = await webFetch.execute({ url: REPOSITORY_URL }, context);

    expect(first.isError).toBe(true);
    expect(second.isError).toBe(true);
    expect(first.content).toContain("Metadata: HTTP 503");
    expect(first.content).toContain("README: HTTP 503");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("recognizes repository sources without intercepting issues, pull requests, or trees", () => {
    expect(identifyGitHubRepositoryResource(REPOSITORY_URL)).toMatchObject({
      kind: "repository",
      key: "example/project",
    });
    expect(identifyGitHubRepositoryResource(METADATA_URL)).toMatchObject({
      kind: "metadata",
      key: "example/project",
    });
    expect(identifyGitHubRepositoryResource(README_URL)).toMatchObject({
      kind: "readme",
      key: "example/project",
    });
    expect(
      identifyGitHubRepositoryResource(
        "https://raw.githubusercontent.com/example/project/main/README.md",
      ),
    ).toMatchObject({
      kind: "readme",
      key: "example/project",
    });
    expect(identifyGitHubRepositoryResource(`${REPOSITORY_URL}/issues/1`)).toBeNull();
    expect(identifyGitHubRepositoryResource(`${REPOSITORY_URL}/pull/2`)).toBeNull();
    expect(identifyGitHubRepositoryResource(`${REPOSITORY_URL}/tree/main`)).toBeNull();
  });

  it("decodes GitHub's base64 README representation", async () => {
    const readme = "# Project\nInstall the signed desktop package.";
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url === METADATA_URL) return jsonResponse(metadata);
      if (url === README_URL) {
        return jsonResponse({
          encoding: "base64",
          content: Buffer.from(readme, "utf8").toString("base64"),
        });
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = await fetchGitHubRepositorySnapshot(repositoryResource());

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain(readme);
    expect(result.content).not.toContain(Buffer.from(readme, "utf8").toString("base64"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
