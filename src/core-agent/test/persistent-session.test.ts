import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PersistentSession } from "../src/agent/persistent-session.js";

// Mirrors the constant in persistent-session.ts; kept inline (not exported)
// so the heal contract is testable without leaking an internal sentinel.
const INTERRUPTED_TOOL_RESULT =
  "[interrupted: previous run aborted before this tool produced a result]";

function tmpFile(name: string): string {
  return path.join(os.tmpdir(), `core-agent-psession-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
}

describe("PersistentSession", () => {
  let file: string;

  beforeEach(() => {
    file = tmpFile("t.jsonl");
  });

  afterEach(() => {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
    try { fs.unlinkSync(`${file}.tmp`); } catch { /* ignore */ }
  });

  it("starts empty when backing file does not exist", () => {
    const s = new PersistentSession({ sessionFile: file });
    expect(s.length).toBe(0);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("persists messages to disk on add", () => {
    const s = new PersistentSession({ sessionFile: file });
    s.addUserMessage("hello");
    s.addAssistantMessage([{ type: "text", text: "hi back" }]);

    expect(fs.existsSync(file)).toBe(true);
    const lines = fs.readFileSync(file, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    expect(first.role).toBe("user");
    expect(first.content[0]).toEqual({ type: "text", text: "hello" });
    expect(typeof first.ts).toBe("number");
  });

  it("resumes prior messages from disk", () => {
    const s1 = new PersistentSession({ sessionFile: file });
    s1.addUserMessage("msg A");
    s1.addAssistantMessage([{ type: "text", text: "reply A" }]);

    const s2 = new PersistentSession({ sessionFile: file });
    expect(s2.length).toBe(2);
    const msgs = s2.getMessages();
    expect(msgs[0].role).toBe("user");
    expect((msgs[0].content[0] as { text: string }).text).toBe("msg A");
    expect(msgs[1].role).toBe("assistant");
  });

  it("tolerates corrupt + schema-invalid lines and keeps the valid ones", () => {
    // Mix of failure modes that show up in the wild: a half-written line
    // (process killed mid-append), an unknown role (older schema /
    // tampering), a non-array content (manual edit), plus blank tail.
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ role: "user", content: [{ type: "text", text: "good 1" }] }),
        "{not valid json",
        JSON.stringify({ role: "robot", content: [{ type: "text", text: "wrong role" }] }),
        JSON.stringify({ role: "user", content: "string not array" }),
        JSON.stringify({ role: "assistant", content: [{ type: "text", text: "good 2" }] }),
        "",
      ].join("\n"),
      "utf-8",
    );

    const s = new PersistentSession({ sessionFile: file });
    expect(s.length).toBe(2);
    expect(s.getMessages()[0].role).toBe("user");
    expect((s.getMessages()[0].content[0] as { text: string }).text).toBe("good 1");
    expect(s.getMessages()[1].role).toBe("assistant");
  });

  it("compact rewrites the file to match in-memory state", () => {
    const s = new PersistentSession({ sessionFile: file });
    for (let i = 0; i < 6; i++) {
      s.addUserMessage(`msg ${i}`);
      s.addAssistantMessage([{ type: "text", text: `reply ${i}` }]);
    }
    const before = fs.readFileSync(file, "utf-8").trim().split("\n").length;

    s.compact("summary text");

    const after = fs.readFileSync(file, "utf-8").trim().split("\n").length;
    expect(after).toBeLessThan(before);
    // file should match the in-memory state line-for-line
    expect(after).toBe(s.length);
  });

  it("clear truncates backing file", () => {
    const s = new PersistentSession({ sessionFile: file });
    s.addUserMessage("x");
    expect(fs.statSync(file).size).toBeGreaterThan(0);

    s.clear();
    expect(s.length).toBe(0);
    expect(fs.statSync(file).size).toBe(0);
  });

  it("tool result messages round-trip", () => {
    const s1 = new PersistentSession({ sessionFile: file });
    s1.addToolResult("call-123", "tool output", undefined, false);

    const s2 = new PersistentSession({ sessionFile: file });
    expect(s2.length).toBe(1);
    const c = s2.getMessages()[0].content[0];
    expect(c.type).toBe("tool_result");
    expect((c as { toolUseId: string }).toolUseId).toBe("call-123");
  });

  it("creates parent directories if missing", () => {
    const nested = path.join(os.tmpdir(), `core-agent-psess-${Date.now()}`, "sub", "dir", "chat.jsonl");
    try {
      const s = new PersistentSession({ sessionFile: nested });
      s.addUserMessage("hi");
      expect(fs.existsSync(nested)).toBe(true);
    } finally {
      try { fs.rmSync(path.dirname(path.dirname(path.dirname(nested))), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  // ── Heal pass for orphan tool_use ────────────────────────────────────────
  // Background: when a prior run aborted (app killed, watchdog, user stop)
  // after the provider emitted an assistant `tool_use` but before the runner
  // persisted the matching `tool_result`, the session jsonl is left in a
  // state the OpenAI/Anthropic API rejects (tool_use must be followed by
  // tool_result for that id). The next turn then silently hangs waiting on
  // a response the server never produces. loadFromDisk heals these.

  describe("orphan tool_use heal on load", () => {
    it("synthesizes tool_result for a trailing orphan tool_use", () => {
      fs.writeFileSync(
        file,
        [
          JSON.stringify({ role: "user", content: [{ type: "text", text: "run social" }] }),
          JSON.stringify({
            role: "assistant",
            content: [{ type: "tool_use", id: "call-A", name: "some_tool", input: {} }],
          }),
        ].join("\n") + "\n",
        "utf-8",
      );

      const s = new PersistentSession({ sessionFile: file });
      const msgs = s.getMessages();
      expect(msgs).toHaveLength(3); // user + assistant(tool_use) + synthetic user(tool_result)
      const last = msgs[2];
      expect(last.role).toBe("user");
      expect(last.content[0].type).toBe("tool_result");
      expect((last.content[0] as { toolUseId: string }).toolUseId).toBe("call-A");
      expect((last.content[0] as { isError: boolean }).isError).toBe(true);
      expect((last.content[0] as { content: string }).content).toMatch(/interrupted/i);

      // Disk was rewritten — a fresh load produces the same state without
      // re-healing (idempotent).
      const s2 = new PersistentSession({ sessionFile: file });
      expect(s2.length).toBe(3);
      expect(s2.getMessages()[2].content[0].type).toBe("tool_result");
    });

    it("heals an orphan tool_use followed by an unrelated user text", () => {
      // This is the production bug: a long-running tool_use at index N
      // (e.g. abort/restart mid-execution), then the user typed a new
      // message at N+1 without any tool_result in between. The heal must
      // insert the synthetic result *before* the user's text, preserving
      // conversational order.
      fs.writeFileSync(
        file,
        [
          JSON.stringify({ role: "user", content: [{ type: "text", text: "round 1" }] }),
          JSON.stringify({
            role: "assistant",
            content: [{ type: "tool_use", id: "call-X", name: "some_tool", input: {} }],
          }),
          JSON.stringify({ role: "user", content: [{ type: "text", text: "round 2" }] }),
        ].join("\n") + "\n",
        "utf-8",
      );

      const s = new PersistentSession({ sessionFile: file });
      const msgs = s.getMessages();
      expect(msgs).toHaveLength(4);
      expect(msgs[0].role).toBe("user");
      expect(msgs[1].role).toBe("assistant");
      // Synthetic tool_result sits between the tool_use and the user text.
      expect(msgs[2].role).toBe("user");
      expect(msgs[2].content[0].type).toBe("tool_result");
      expect((msgs[2].content[0] as { toolUseId: string }).toolUseId).toBe("call-X");
      expect(msgs[3].role).toBe("user");
      expect(msgs[3].content[0].type).toBe("text");
      expect((msgs[3].content[0] as { text: string }).text).toBe("round 2");
    });

    it("heals multiple orphan tool_uses in the same assistant message", () => {
      // Some providers emit parallel tool calls in one assistant turn. A
      // mid-flight abort orphans all of them at once; each needs its own
      // tool_result entry in the next message.
      fs.writeFileSync(
        file,
        [
          JSON.stringify({
            role: "assistant",
            content: [
              { type: "tool_use", id: "call-1", name: "a", input: {} },
              { type: "tool_use", id: "call-2", name: "b", input: {} },
            ],
          }),
        ].join("\n") + "\n",
        "utf-8",
      );

      const s = new PersistentSession({ sessionFile: file });
      const msgs = s.getMessages();
      expect(msgs).toHaveLength(2);
      const results = msgs[1].content;
      expect(results).toHaveLength(2);
      const ids = results.map((c) => (c as { toolUseId?: string }).toolUseId);
      expect(ids.sort()).toEqual(["call-1", "call-2"]);
    });

    it("heals a partial result set (some ids resolved, others orphaned)", () => {
      // Assistant called two tools; only one tool_result came back before
      // the crash. Heal must fill in the missing id and leave the existing
      // result in place.
      fs.writeFileSync(
        file,
        [
          JSON.stringify({
            role: "assistant",
            content: [
              { type: "tool_use", id: "call-ok", name: "a", input: {} },
              { type: "tool_use", id: "call-orphan", name: "b", input: {} },
            ],
          }),
          JSON.stringify({
            role: "user",
            content: [
              { type: "tool_result", toolUseId: "call-ok", content: "ok", isError: false },
            ],
          }),
        ].join("\n") + "\n",
        "utf-8",
      );

      const s = new PersistentSession({ sessionFile: file });
      const msgs = s.getMessages();
      expect(msgs).toHaveLength(2);
      const results = msgs[1].content;
      expect(results).toHaveLength(2);
      const byId = new Map(results.map((c) => [(c as { toolUseId: string }).toolUseId, c]));
      expect((byId.get("call-ok") as { isError: boolean }).isError).toBe(false);
      expect((byId.get("call-orphan") as { isError: boolean }).isError).toBe(true);
    });

    it("healAndPersist fixes a cached session mid-lifetime", () => {
      // Scenario: PersistentSession is cached (session-store.ts reuses the
      // same instance across turns). A turn aborts mid-tool-execution and
      // leaves an orphan tool_use in the in-memory Session. Constructor
      // heal doesn't re-fire. healAndPersist() must fix both in-memory
      // and on-disk state so the *next* turn sees a valid history.
      const s = new PersistentSession({ sessionFile: file });
      s.addUserMessage("run tool");
      s.addAssistantMessage([
        { type: "tool_use", id: "call-mid", name: "some_tool", input: {} },
      ]);
      // Simulate abort: tool_result never written. Session is now in a
      // broken state but still cached in memory.
      expect(s.length).toBe(2);
      expect(s.getMessages()[1].content[0].type).toBe("tool_use");

      // Post-turn heal hook runs in the `finally` block of client.ts.
      const healed = s.healAndPersist();
      expect(healed).toBe(true);
      expect(s.length).toBe(3);
      expect(s.getMessages()[2].content[0].type).toBe("tool_result");

      // Re-run is idempotent — second call shouldn't re-heal.
      expect(s.healAndPersist()).toBe(false);

      // Disk was persisted → a fresh construction of the same file reads
      // back the healed state.
      const fresh = new PersistentSession({ sessionFile: file });
      expect(fresh.length).toBe(3);
      expect(fresh.getMessages()[2].content[0].type).toBe("tool_result");
    });

    it("merges parallel tool_results split across adjacent user messages", () => {
      // The runner's `addToolResult` writes one user message per tool_use_id.
      // So an assistant turn with 3 parallel tool_calls produces 3 adjacent
      // user messages on disk. Heal must NOT mistake the latter two for
      // orphans (the original i+1-only scan did) — it must scan the whole
      // contiguous tool_result cluster and consolidate.
      fs.writeFileSync(
        file,
        [
          JSON.stringify({ role: "user", content: [{ type: "text", text: "go" }] }),
          JSON.stringify({
            role: "assistant",
            content: [
              { type: "tool_use", id: "p-0", name: "a", input: {} },
              { type: "tool_use", id: "p-1", name: "b", input: {} },
              { type: "tool_use", id: "p-2", name: "c", input: {} },
            ],
          }),
          JSON.stringify({ role: "user", content: [{ type: "tool_result", toolUseId: "p-0", content: "r0", isError: false }] }),
          JSON.stringify({ role: "user", content: [{ type: "tool_result", toolUseId: "p-1", content: "r1", isError: false }] }),
          JSON.stringify({ role: "user", content: [{ type: "tool_result", toolUseId: "p-2", content: "r2", isError: false }] }),
        ].join("\n") + "\n",
        "utf-8",
      );

      const s = new PersistentSession({ sessionFile: file });
      const msgs = s.getMessages();
      expect(msgs).toHaveLength(3); // user + assistant + ONE merged tool_result message
      expect(msgs[2].role).toBe("user");
      expect(msgs[2].content).toHaveLength(3);
      const ids = msgs[2].content.map((c) => (c as { toolUseId: string }).toolUseId);
      expect(ids).toEqual(["p-0", "p-1", "p-2"]); // order matches assistant's tool_uses
      // None of the results are interrupted — all are the real ones.
      expect(msgs[2].content.every((c) => (c as { content: string }).content !== INTERRUPTED_TOOL_RESULT)).toBe(true);
    });

    it("dedupes a tool_call_id that appears as both interrupted and real", () => {
      // Reproduces the corruption that an earlier heal-with-i+1-only logic
      // could produce: assistant has 3 parallel tool_uses, the first user
      // message after assistant carried only the first real result, then
      // heal mistakenly synthesized "interrupted" markers for the other two
      // (because it didn't see the real results in subsequent user
      // messages). The corrupt jsonl ended up with each tool_call_id
      // having both an interrupted and a real result. DeepSeek 400s on
      // duplicate tool_call_id. Heal must dedupe and prefer the real one.
      fs.writeFileSync(
        file,
        [
          JSON.stringify({ role: "user", content: [{ type: "text", text: "go" }] }),
          JSON.stringify({
            role: "assistant",
            content: [
              { type: "tool_use", id: "c-0", name: "a", input: {} },
              { type: "tool_use", id: "c-1", name: "b", input: {} },
              { type: "tool_use", id: "c-2", name: "c", input: {} },
            ],
          }),
          JSON.stringify({
            role: "user",
            content: [
              { type: "tool_result", toolUseId: "c-0", content: "r0", isError: false },
              { type: "tool_result", toolUseId: "c-1", content: INTERRUPTED_TOOL_RESULT, isError: true },
              { type: "tool_result", toolUseId: "c-2", content: INTERRUPTED_TOOL_RESULT, isError: true },
            ],
          }),
          JSON.stringify({ role: "user", content: [{ type: "tool_result", toolUseId: "c-1", content: "r1", isError: false }] }),
          JSON.stringify({ role: "user", content: [{ type: "tool_result", toolUseId: "c-2", content: "r2", isError: false }] }),
        ].join("\n") + "\n",
        "utf-8",
      );

      const s = new PersistentSession({ sessionFile: file });
      const msgs = s.getMessages();
      expect(msgs).toHaveLength(3);
      const results = msgs[2].content as Array<{ toolUseId: string; content: string; isError: boolean }>;
      expect(results).toHaveLength(3);
      const byId = new Map(results.map((r) => [r.toolUseId, r]));
      // Real results win over earlier-seen interrupted markers.
      expect(byId.get("c-0")!.content).toBe("r0");
      expect(byId.get("c-1")!.content).toBe("r1");
      expect(byId.get("c-2")!.content).toBe("r2");
      expect(results.every((r) => !r.content.includes("interrupted"))).toBe(true);
    });

    it("leaves a well-formed history untouched", () => {
      // Regression guard: tool_use followed by tool_result = healthy.
      // Heal pass must be a no-op; flush must NOT rewrite the file.
      fs.writeFileSync(
        file,
        [
          JSON.stringify({
            role: "assistant",
            content: [{ type: "tool_use", id: "call-OK", name: "a", input: {} }],
          }),
          JSON.stringify({
            role: "user",
            content: [{ type: "tool_result", toolUseId: "call-OK", content: "done", isError: false }],
          }),
        ].join("\n") + "\n",
        "utf-8",
      );
      const mtimeBefore = fs.statSync(file).mtimeMs;

      // Sleep a tick so any write would leave a detectable mtime delta.
      const s = new PersistentSession({ sessionFile: file });
      expect(s.length).toBe(2);
      expect(s.getMessages()[1].content).toHaveLength(1);

      // No heal fired → no flushToDisk → mtime unchanged within the
      // resolution of fs.statSync (ms). We accept equality OR tiny drift.
      const mtimeAfter = fs.statSync(file).mtimeMs;
      expect(mtimeAfter).toBe(mtimeBefore);
    });
  });
});
