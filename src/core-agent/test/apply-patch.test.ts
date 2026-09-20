import fs from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { fileFailureForLog } from "../src/tools/file-diagnostics.js";
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
  it('bounds escaped ambiguity context and reports omitted insertion anchors', async () => {
    const dir = await tempDir();
    const original = Array.from({ length: 20 }, () => `anchor ${'"\\'.repeat(2000)}\n`).join('');
    await fs.writeFile(path.join(dir, 'target.txt'), original);
    const result = await createApplyPatchTool().execute({ patch: [
      '*** Begin Patch', '*** Update File: target.txt', '@@ anchor', '+inserted', '*** End Patch',
    ].join('\n') }, context(dir));
    expect(result.isError).toBe(true);
    const raw = result.content.split('<patch-recovery>\n')[1].split('\n</patch-recovery>')[0];
    expect(raw.length).toBeLessThanOrEqual(1600);
    const recovery = JSON.parse(raw);
    expect(recovery.match_count).toBe(20);
    expect(recovery.omitted_matches).toBe(17);
    expect(recovery.candidates.map((c: any) => c.line)).toEqual([1, 2, 3]);
    for (const candidate of recovery.candidates) {
      expect(candidate.text).toContain('anchor');
      expect(candidate.truncated).toBe(true);
      expect(candidate.text).toBe(original.slice(candidate.char_start, candidate.char_end));
    }
    expect(await fs.readFile(path.join(dir, 'target.txt'), 'utf8')).toBe(original);
  });

  it.each([
    { eol: '\n', remove: false }, { eol: '\r\n', remove: false },
    { eol: '\n', remove: true }, { eol: '\r\n', remove: true },
  ])("reports original candidate locations after staged line changes ($eol, remove=$remove)", async ({ eol, remove }) => {
    const dir = await tempDir();
    const original = ['start', ...Array.from({ length: 200 }, (_, i) => `padding ${i}`),
      'function first()', 'same', 'end first', 'function second()', 'same', 'end second', ''].join(eol);
    const target = path.join(dir, 'target.txt');
    await fs.writeFile(target, original);
    await fs.writeFile(path.join(dir, 'other.txt'), 'old\n');
    const tool = createApplyPatchTool();
    const result = await tool.execute({ patch: [
      '*** Begin Patch', '*** Update File: other.txt', '@@', '-old', '+new',
      '*** Update File: target.txt', '@@', '-start', ...(remove ? [] : ['+start', '+not committed']),
      '@@', '-same', '+changed', '*** End Patch',
    ].join('\n') }, context(dir));
    expect(result.isError).toBe(true);
    const recovery = JSON.parse(result.content.split('<patch-recovery>\n')[1].split('\n</patch-recovery>')[0]);
    expect(recovery.file_hash).toBe(`sha256:${crypto.createHash('sha256').update(original).digest('hex')}`);
    expect(recovery.match_count).toBe(2);
    expect(recovery.candidates.map((c: any) => c.line)).toEqual([203, 206]);
    expect(recovery.candidates.map((c: any) => c.column)).toEqual([1, 1]);
    expect(recovery.candidates[0].text).toContain(`function first()${eol}same`);
    expect(recovery.candidates[1].text).toContain(`function second()${eol}same`);
    for (const c of recovery.candidates) expect(c.text).toBe(original.slice(c.char_start, c.char_end));
    expect(JSON.stringify(result.observations)).not.toContain('function first');
    expect(result.content).not.toContain('not committed');
    expect(await fs.readFile(target, 'utf8')).toBe(original);
    expect(await fs.readFile(path.join(dir, 'other.txt'), 'utf8')).toBe('old\n');
    const retry = await tool.execute({ patch: [
      '*** Begin Patch', '*** Update File: target.txt', '@@', ' function second()',
      '-same', '+changed', '*** End Patch',
    ].join('\n') }, context(dir));
    expect(retry.isError).toBeUndefined();
    expect(await fs.readFile(target, 'utf8')).toBe(original.replace(`function second()${eol}same`, `function second()${eol}changed`));
  });

  it('drops unknown diagnostic labels instead of leaking arbitrary text into logs', () => {
    expect(fileFailureForLog({ code: 'private error text', reason: 'no_match' })).toBeUndefined();
    expect(fileFailureForLog({ code: 'E_NO_MATCH', reason: '/Users/test/private.txt' })).toBeUndefined();
    expect(fileFailureForLog(null)).toBeUndefined();
  });

  it.each([
    { body: '*** Update File: target.txt\n@@\n-old\n+new', reason: 'patch_envelope', facts: { begin_marker: false, end_marker: false } },
    { body: '*** Begin Patch\n*** Update File: target.txt\n@@\n*** End Patch', reason: 'hunk_without_changes', facts: { line: 3, hunk_index: 1, added_lines: 0, removed_lines: 0, context_lines: 0 } },
    { body: '*** Begin Patch\n*** Update File: target.txt\n@@\n-invalid\nwrong prefix\n*** End Patch', reason: 'hunk_line_prefix', facts: { line: 5, hunk_index: 1 } },
    { body: '*** Begin Patch\n*** Update File: target.txt\n@@\n-absent private text\n+replacement\n*** End Patch', reason: 'no_match', facts: { match_count: 0 } },
  ])('diagnoses $reason without changing files or exposing their content in metadata', async ({ body, reason, facts }) => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, 'target.txt'), 'private content\n');
    const result = await createApplyPatchTool().execute({ patch: body }, context(dir));
    expect(result.isError).toBe(true);
    expect(result.observations?.fileFailure).toMatchObject({ reason, ...facts });
    const metadata = JSON.stringify(result.observations);
    for (const secret of ['private content', 'absent private text', 'target.txt', dir]) expect(metadata).not.toContain(secret);
    expect(await fs.readFile(path.join(dir, 'target.txt'), 'utf8')).toBe('private content\n');
  });

  it.each(["\n", "\r\n"])("uses context-only hunks to locate a later edit with %j line endings", async (eol) => {
    const dir = await tempDir();
    const original = [
      "def other():", "    return price", "def calculate():",
      "    price = 100", "    discount = 10", "    return price", "",
    ].join(eol);
    const target = path.join(dir, "target.py");
    await fs.writeFile(target, original);
    const result = await createApplyPatchTool().execute({ patch: [
      "*** Begin Patch", "*** Update File: target.py",
      "@@", " def calculate():", "@@", "     price = 100",
      "@@", "-    return price", "+    return price - discount", "*** End Patch",
    ].join("\n") }, context(dir));

    expect(result.isError).toBeUndefined();
    expect(await fs.readFile(target, "utf8")).toBe([
      "def other():", "    return price", "def calculate():",
      "    price = 100", "    discount = 10", "    return price - discount", "",
    ].join(eol));
  });

  it.each([
    { original: "different\nold\n", contextLine: "anchor", code: "E_PATCH_NO_MATCH" },
    { original: "anchor\nanchor\nold\n", contextLine: "anchor", code: "E_PATCH_AMBIGUOUS" },
    { original: "anchor\nold\n", contextLine: "anchor", code: "E_PATCH_NO_MATCH", trailingContext: "missing" },
  ])("rejects invalid context without committing any file: $code / $original", async ({ original, contextLine, code, trailingContext }) => {
    const dir = await tempDir();
    const target = path.join(dir, "target.txt");
    await fs.writeFile(target, original);
    const result = await createApplyPatchTool().execute({ patch: [
      "*** Begin Patch", "*** Add File: added.txt", "+must not be created",
      "*** Update File: target.txt", "@@", ` ${contextLine}`,
      "@@", "-old", "+new",
      ...(trailingContext ? ["@@", ` ${trailingContext}`] : []),
      "*** End Patch",
    ].join("\n") }, context(dir));

    expect(result.isError).toBe(true);
    expect(result.content).toContain(code);
    expect(await fs.readFile(target, "utf8")).toBe(original);
    expect((await fs.readdir(dir)).sort()).toEqual(["target.txt"]);
  });

  it("rejects a context-only update that produces no change", async () => {
    const dir = await tempDir();
    const target = path.join(dir, "target.txt");
    await fs.writeFile(target, "anchor\nunchanged\n");
    const result = await createApplyPatchTool().execute({ patch: [
      "*** Begin Patch", "*** Update File: target.txt", "@@", " anchor",
      "@@", " unchanged", "*** End Patch",
    ].join("\n") }, context(dir));

    expect(result.isError).toBe(true);
    expect(result.content).toContain("E_PATCH_NO_CHANGE");
    expect(await fs.readFile(target, "utf8")).toBe("anchor\nunchanged\n");
  });

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
