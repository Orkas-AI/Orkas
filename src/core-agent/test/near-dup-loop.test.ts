import { describe, it, expect } from "vitest";
import {
  normalizedToolCallSignature,
  NEAR_DUP_LOOP_WARN,
  NEAR_DUP_LOOP_HARD,
  LOOP_HARD,
} from "../src/agent/runner.js";

const sig = (name: string, input: unknown) => normalizedToolCallSignature({ name, input });

describe("normalizedToolCallSignature (near-duplicate loop detection)", () => {
  it("fires only after the exact detector could (threshold above LOOP_HARD)", () => {
    expect(NEAR_DUP_LOOP_WARN).toBeGreaterThan(LOOP_HARD);
    expect(NEAR_DUP_LOOP_HARD).toBeGreaterThan(NEAR_DUP_LOOP_WARN);
  });

  describe("MATCH — collapses calls that differ only in volatile id/timestamp fields", () => {
    it("drops request-tracking keys", () => {
      expect(sig("web_fetch", { url: "X", request_id: "a" }))
        .toBe(sig("web_fetch", { url: "X", request_id: "b" }));
      expect(sig("search", { query: "q", trace_id: "t1" }))
        .toBe(sig("search", { query: "q", trace_id: "t2" }));
      expect(sig("act", { action: "go", nonce: "n1" }))
        .toBe(sig("act", { action: "go", nonce: "n2" }));
      expect(sig("read", { path: "A", timestamp: "2026-01-01T00:00:00Z" }))
        .toBe(sig("read", { path: "A", timestamp: "2026-09-09T09:09:09Z" }));
    });
    it("strips recursively in nested objects", () => {
      expect(sig("create", { payload: { spec: "S", request_id: "a" } }))
        .toBe(sig("create", { payload: { spec: "S", request_id: "b" } }));
    });
    it("treats byte-identical calls as equal too", () => {
      expect(sig("read", { path: "A" })).toBe(sig("read", { path: "A" }));
    });
  });

  describe("NON-MATCH — look-alikes that must stay distinct (no false near-duplicate)", () => {
    it("keeps distinct targets distinct", () => {
      expect(sig("web_fetch", { url: "X" })).not.toBe(sig("web_fetch", { url: "Y" }));
      expect(sig("search", { query: "cats" })).not.toBe(sig("search", { query: "dogs" }));
    });
    it("keeps pagination distinct (offset/page are structural, not volatile)", () => {
      expect(sig("read", { path: "A", offset: 0 })).not.toBe(sig("read", { path: "A", offset: 100 }));
      expect(sig("search", { query: "q", page: 1 })).not.toBe(sig("search", { query: "q", page: 2 }));
    });
    it("keeps a meaningful id/ref target distinct even when it looks like a uuid", () => {
      expect(sig("get_record", { id: 123 })).not.toBe(sig("get_record", { id: 456 }));
      expect(sig("get_record", { ref: "11111111-1111-1111-1111-111111111111" }))
        .not.toBe(sig("get_record", { ref: "22222222-2222-2222-2222-222222222222" }));
    });
    it("keeps seed distinct (defines the output, not incidental)", () => {
      expect(sig("generate", { prompt: "p", seed: 1 })).not.toBe(sig("generate", { prompt: "p", seed: 2 }));
    });
    it("keeps different tools distinct even with identical args", () => {
      expect(sig("read", { path: "A" })).not.toBe(sig("write", { path: "A" }));
    });
  });
});
