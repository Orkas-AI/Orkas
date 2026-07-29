import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createApplyPatchTool } from "../src/tools/apply-patch.js";
import type { ToolContext } from "../src/tools/base.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "core-apply-patch-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function context(workingDir: string): ToolContext {
  return { workingDir, state: {} };
}

describe("apply_patch", () => {
  it("commits add, update, move, and delete as one transaction", async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, "update.txt"), "alpha\r\nbeta\r\n", "utf8");
    await fs.writeFile(path.join(dir, "remove.txt"), "obsolete\n", "utf8");
    const committed: string[] = [];
    const tool = createApplyPatchTool({
      onCommitted(file) {
        committed.push(`${file.operation}:${path.basename(file.destinationPath)}`);
      },
    });

    const result = await tool.execute({
      patch: [
        "*** Begin Patch",
        "*** Update File: update.txt",
        "*** Move to: moved.txt",
        "@@",
        " alpha",
        "-beta",
        "+gamma",
        "*** Add File: added.txt",
        "+new",
        "*** Delete File: remove.txt",
        "*** End Patch",
      ].join("\n"),
    }, context(dir));

    expect(result.isError).toBeUndefined();
    expect(await fs.readFile(path.join(dir, "moved.txt"), "utf8")).toBe("alpha\r\ngamma\r\n");
    await expect(fs.stat(path.join(dir, "update.txt"))).rejects.toThrow();
    await expect(fs.readFile(path.join(dir, "added.txt"), "utf8")).resolves.toBe("new\n");
    await expect(fs.stat(path.join(dir, "remove.txt"))).rejects.toThrow();
    expect(committed.sort()).toEqual(["add:added.txt", "delete:remove.txt", "update:moved.txt"]);
    expect(result.observations?.fileChanges).toHaveLength(3);
    expect(result.observations?.fileChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        operation: "rename",
        sourcePath: path.join(dir, "update.txt"),
        destinationPath: path.join(dir, "moved.txt"),
        beforeContent: "alpha\r\nbeta\r\n",
        afterContent: "alpha\r\ngamma\r\n",
        coverage: "exact",
      }),
      expect.objectContaining({
        operation: "create",
        sourcePath: path.join(dir, "added.txt"),
        beforeExists: false,
        afterContent: "new\n",
      }),
      expect.objectContaining({
        operation: "delete",
        sourcePath: path.join(dir, "remove.txt"),
        beforeContent: "obsolete\n",
        afterExists: false,
      }),
    ]));
  });

  it("preflights every path before changing any file", async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, "first.txt"), "old\n", "utf8");
    const tool = createApplyPatchTool({
      validatePath(check) {
        if (check.path.endsWith("denied.txt")) {
          return { content: "E_DENIED: host rejected path", isError: true };
        }
      },
    });

    const result = await tool.execute({
      patch: [
        "*** Begin Patch",
        "*** Update File: first.txt",
        "@@",
        "-old",
        "+new",
        "*** Add File: denied.txt",
        "+no",
        "*** End Patch",
      ].join("\n"),
    }, context(dir));

    expect(result.isError).toBe(true);
    expect(result.content).toContain("E_DENIED");
    await expect(fs.readFile(path.join(dir, "first.txt"), "utf8")).resolves.toBe("old\n");
    await expect(fs.stat(path.join(dir, "denied.txt"))).rejects.toThrow();
  });

  it("returns recovery context when a hunk is stale or ambiguous", async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, "target.txt"), "same\nsame\n", "utf8");
    const tool = createApplyPatchTool();
    const result = await tool.execute({
      patch: [
        "*** Begin Patch",
        "*** Update File: target.txt",
        "@@",
        "-same",
        "+changed",
        "*** End Patch",
      ].join("\n"),
    }, context(dir));

    expect(result.isError).toBe(true);
    expect(result.content).toContain("E_PATCH_AMBIGUOUS");
    expect(result.content).toContain("<patch-recovery");
    await expect(fs.readFile(path.join(dir, "target.txt"), "utf8")).resolves.toBe("same\nsame\n");
  });
});
