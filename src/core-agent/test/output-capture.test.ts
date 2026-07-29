import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ProcessOutputCapture } from "../src/sandbox/output-capture.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orkas-output-capture-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("ProcessOutputCapture fault recovery", () => {
  it("persists every byte when the filesystem completes writes in short chunks", () => {
    const spoolDir = makeTempDir();
    const originalWriteSync = fs.writeSync.bind(fs);
    vi.spyOn(fs, "writeSync").mockImplementation(((
      fd: number,
      buffer: NodeJS.ArrayBufferView,
      offset?: number,
      length?: number,
      position?: number | null,
    ) => {
      const byteLength = Buffer.byteLength(buffer as Uint8Array);
      const start = typeof offset === "number" ? offset : 0;
      const requested = typeof length === "number" ? length : byteLength - start;
      return originalWriteSync(fd, buffer, start, Math.min(requested, 2), position ?? null);
    }) as typeof fs.writeSync);

    const source = Buffer.from("abcdefghij", "utf8");
    const capture = new ProcessOutputCapture({
      spoolDir,
      prefix: "stdout",
      memoryBytes: 3,
      maxSpoolBytes: 100,
    });

    expect(capture.append(source)).toBe(true);
    const result = capture.finish({ decode: (bytes) => bytes.toString("utf8") });

    expect(result.bytes).toBe(source.length);
    expect(result.streamedOutput?.size).toBe(source.length);
    expect(fs.readFileSync(result.streamedOutput!.path)).toEqual(source);
  });

  it("marks a hard-limit prefix as incomplete instead of claiming full output", () => {
    const spoolDir = makeTempDir();
    const capture = new ProcessOutputCapture({
      spoolDir,
      prefix: "stderr",
      memoryBytes: 3,
      maxSpoolBytes: 5,
    });

    expect(capture.append(Buffer.from("abcdefghij", "utf8"))).toBe(false);
    const result = capture.finish({ decode: (bytes) => bytes.toString("utf8") });

    expect(result.bytes).toBe(5);
    expect(result.streamedOutput).toMatchObject({
      size: 5,
      sourceTruncated: true,
    });
    expect(fs.readFileSync(result.streamedOutput!.path, "utf8")).toBe("abcde");
    expect(result.text).toContain("stored prefix is incomplete");
  });
});
