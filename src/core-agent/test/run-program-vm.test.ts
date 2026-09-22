import { describe, expect, it, vi } from "vitest";

vi.mock("quickjs-emscripten", async (importOriginal) => {
  const actual = await importOriginal<typeof import("quickjs-emscripten")>();
  return {
    ...actual,
    newQuickJSWASMModule: async () => {
      // A cold VM may take longer to load than the guest's CPU allowance.
      // Exercise the real interpreter after delaying only its host startup.
      await new Promise((resolve) => setTimeout(resolve, 80));
      return actual.newQuickJSWASMModule();
    },
  };
});

import { executeProgramVm } from "../src/tools/run-program-vm.js";
import { DEFAULT_RUN_PROGRAM_LIMITS } from "../src/tools/run-program.js";

describe("program VM cold startup", () => {
  it.each([
    { code: "text('ready');", expected: { status: "completed", output: "ready" } },
    { code: "while (true) {}", expected: { status: "failed", code: "E_PROGRAM_CPU_SLICE" } },
  ])("preserves the guest CPU bound after slow initialization: $code", async ({ code, expected }) => {
    const invoke = vi.fn(async () => ({ ok: true as const, content: "unused" }));
    const result = await executeProgramVm({
      executionId: 1,
      code,
      toolNames: [],
      limits: { ...DEFAULT_RUN_PROGRAM_LIMITS, maxSyncSliceMs: 40, maxWallMs: 5_000 },
      deadline: Date.now() + 5_000,
      cancellation: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
    }, invoke);
    expect(result).toMatchObject(expected);
    expect(invoke).not.toHaveBeenCalled();
  });
});
