import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { defineTool, type AgentTool, type ToolContext, type ToolResult } from "./base.js";

export type ApplyPatchOperation = "add" | "update" | "delete";
export type ApplyPatchPathRole = "source" | "destination";

export interface ApplyPatchPathCheck {
  path: string;
  role: ApplyPatchPathRole;
  operation: ApplyPatchOperation;
  sourcePath: string;
  destinationPath: string;
}

export interface ApplyPatchSnapshot {
  path: string;
  content: string;
  stat: fs.Stats;
  hash: string;
}

export interface ApplyPatchContentCheck {
  path: string;
  content: string;
  operation: "add" | "update";
}

export interface ApplyPatchCommittedFile {
  operation: ApplyPatchOperation;
  sourcePath: string;
  destinationPath: string;
  beforeHash?: string;
  afterHash?: string;
  beforeContent?: string;
  afterContent?: string;
}

export interface ApplyPatchToolHooks {
  /** Host path resolution. Defaults to resolving against ToolContext.workingDir. */
  resolvePath?: (rawPath: string, ctx: ToolContext) => string;
  /** Host authorization/scope hook, called for every source and destination. */
  validatePath?: (
    check: ApplyPatchPathCheck,
    ctx: ToolContext,
  ) => void | ToolResult | Promise<void | ToolResult>;
  /** Host validation for an existing source after it has been read and hashed. */
  validateExisting?: (
    snapshot: ApplyPatchSnapshot,
    check: ApplyPatchPathCheck,
    ctx: ToolContext,
  ) => void | ToolResult | Promise<void | ToolResult>;
  /** Host validation for new bytes before staging. */
  validateContent?: (
    check: ApplyPatchContentCheck,
    ctx: ToolContext,
  ) => void | ToolResult | Promise<void | ToolResult>;
  /** Optional host lock provider. Defaults to a process-local keyed lock. */
  acquirePaths?: (
    absolutePaths: readonly string[],
    ctx: ToolContext,
  ) => (() => void) | Promise<() => void>;
  /** Best-effort notification after the transaction is committed. */
  onCommitted?: (
    file: ApplyPatchCommittedFile,
    ctx: ToolContext,
  ) => void | Promise<void>;
}

type ParsedPatchLine = { kind: " " | "+" | "-"; text: string };
type ParsedPatchHunk = {
  header?: string;
  lines: ParsedPatchLine[];
  endOfFile: boolean;
  noNewlineAtEnd: boolean;
};
type ParsedPatchFile =
  | { type: "add"; path: string; content: string }
  | { type: "delete"; path: string }
  | { type: "update"; path: string; moveTo?: string; hunks: ParsedPatchHunk[] };
type StagedPatchFile = {
  parsed: ParsedPatchFile;
  sourceAbs: string;
  destinationAbs: string;
  before?: string;
  next?: string;
  mode?: number;
  beforeHash?: string;
  afterHash?: string;
  tempPath?: string;
  backupPath?: string;
  backupMoved?: boolean;
  targetReplaced?: boolean;
};

export const APPLY_PATCH_MAX_CHARS = 1_000_000;
export const APPLY_PATCH_MAX_FILES = 32;
export const APPLY_PATCH_MAX_HUNKS = 128;

function patchError(code: string, message: string): string {
  return `${code}: ${message}`;
}

function isPatchFileHeader(line: string): boolean {
  return line.startsWith("*** Add File:")
    || line.startsWith("*** Delete File:")
    || line.startsWith("*** Update File:");
}

function patchPathFromHeader(line: string, prefix: string): string | null {
  const value = line.slice(prefix.length).trim();
  if (!value || value.includes("\0")) return null;
  return value;
}

/**
 * Say what is wrong with a header instead of only that something is.
 *
 * 2026-08-08: a caller wrote `*** Update File /path` and read back "expected
 * Add File, Delete File, or Update File; received: *** Update File /path".
 * Expected and received are word-for-word identical there — the difference is
 * one colon — so it could not self-correct, abandoned apply_patch, and spent
 * three more round trips failing at a different tool. A near miss must name
 * the character that is wrong.
 */
function patchHeaderHint(header: string): string {
  // Section verbs only. `*** Move to:` is a sub-header inside an Update
  // section, so pointing a caller at its punctuation here would answer a
  // question it did not ask — its real error is the position, not the colon.
  for (const verb of ["Add File", "Delete File", "Update File"] as const) {
    if (!header.startsWith(`*** ${verb}`) || header.startsWith(`*** ${verb}:`)) continue;
    const rest = header.slice(`*** ${verb}`.length);
    return rest.trim()
      ? ` — this looks like \`*** ${verb}:\` with the \`:\` missing`
      : ` — \`*** ${verb}:\` needs a path on the same line`;
  }
  const lower = header.toLowerCase();
  for (const verb of ["add file", "delete file", "update file"] as const) {
    if (lower.startsWith(`*** ${verb}`)) {
      return ` — the header verb is case-sensitive: \`*** ${verb.replace(/\b\w/g, (c) => c.toUpperCase())}:\``;
    }
  }
  if (/^(---|\+\+\+|@@|diff --git|index )/.test(header)) {
    return " — this is a unified diff; apply_patch takes `*** Update File: <path>` sections whose lines are prefixed with a space, `-`, or `+`";
  }
  return "";
}

/** Parse the file-oriented patch envelope used by Codex-style apply_patch.
 * It is intentionally a general text transaction, not a coding-mode protocol. */
export function parseApplyPatch(patch: unknown): ParsedPatchFile[] | ToolResult {
  if (typeof patch !== "string" || !patch) {
    return { content: patchError("E_BAD_INPUT", "`patch` must be a non-empty string"), isError: true };
  }
  if (patch.length > APPLY_PATCH_MAX_CHARS) {
    return {
      content: patchError("E_PATCH_TOO_LARGE", `patch exceeds ${APPLY_PATCH_MAX_CHARS} characters`),
      isError: true,
    };
  }

  const lines = patch.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (lines.shift() !== "*** Begin Patch" || lines.pop() !== "*** End Patch") {
    return {
      content: patchError(
        "E_PATCH_FORMAT",
        "patch must start with `*** Begin Patch` and end with `*** End Patch`",
      ),
      isError: true,
    };
  }

  const files: ParsedPatchFile[] = [];
  let index = 0;
  let hunkCount = 0;
  while (index < lines.length) {
    if (files.length >= APPLY_PATCH_MAX_FILES) {
      return {
        content: patchError(
          "E_PATCH_TOO_LARGE",
          `patch contains more than ${APPLY_PATCH_MAX_FILES} file operations`,
        ),
        isError: true,
      };
    }

    const header = lines[index++];
    if (header.startsWith("*** Add File:")) {
      const filePath = patchPathFromHeader(header, "*** Add File:");
      if (!filePath) {
        return { content: patchError("E_PATCH_FORMAT", "Add File requires a non-empty path"), isError: true };
      }
      const contentLines: string[] = [];
      let noNewlineAtEnd = false;
      while (index < lines.length && !isPatchFileHeader(lines[index])) {
        const line = lines[index];
        if (line === "\\ No newline at end of file") {
          noNewlineAtEnd = true;
          index++;
          continue;
        }
        if (!line.startsWith("+")) {
          return {
            content: patchError(
              "E_PATCH_FORMAT",
              `${filePath}: every Add File content line must start with +`,
            ),
            isError: true,
          };
        }
        contentLines.push(line.slice(1));
        index++;
      }
      const content = contentLines.join("\n") + (contentLines.length && !noNewlineAtEnd ? "\n" : "");
      files.push({ type: "add", path: filePath, content });
      continue;
    }

    if (header.startsWith("*** Delete File:")) {
      const filePath = patchPathFromHeader(header, "*** Delete File:");
      if (!filePath) {
        return { content: patchError("E_PATCH_FORMAT", "Delete File requires a non-empty path"), isError: true };
      }
      if (index < lines.length && !isPatchFileHeader(lines[index])) {
        return {
          content: patchError("E_PATCH_FORMAT", `${filePath}: Delete File does not accept content lines`),
          isError: true,
        };
      }
      files.push({ type: "delete", path: filePath });
      continue;
    }

    if (!header.startsWith("*** Update File:")) {
      return {
        content: patchError(
          "E_PATCH_FORMAT",
          `expected \`*** Add File: <path>\`, \`*** Delete File: <path>\`, or \`*** Update File: <path>\`;`
            + ` received: ${header}${patchHeaderHint(header)}`,
        ),
        isError: true,
      };
    }

    const filePath = patchPathFromHeader(header, "*** Update File:");
    if (!filePath) {
      return { content: patchError("E_PATCH_FORMAT", "Update File requires a non-empty path"), isError: true };
    }
    let moveTo: string | undefined;
    if (lines[index]?.startsWith("*** Move to:")) {
      moveTo = patchPathFromHeader(lines[index++], "*** Move to:") ?? undefined;
      if (!moveTo) {
        return {
          content: patchError("E_PATCH_FORMAT", `${filePath}: Move to requires a non-empty path`),
          isError: true,
        };
      }
    }

    const hunks: ParsedPatchHunk[] = [];
    while (index < lines.length && !isPatchFileHeader(lines[index])) {
      const hunkHeader = lines[index++];
      if (!hunkHeader.startsWith("@@")) {
        return {
          content: patchError("E_PATCH_FORMAT", `${filePath}: expected a hunk beginning with @@`),
          isError: true,
        };
      }
      hunkCount++;
      if (hunkCount > APPLY_PATCH_MAX_HUNKS) {
        return {
          content: patchError(
            "E_PATCH_TOO_LARGE",
            `patch contains more than ${APPLY_PATCH_MAX_HUNKS} hunks`,
          ),
          isError: true,
        };
      }

      let locator = hunkHeader.slice(2).trim();
      if (locator.endsWith("@@")) locator = locator.slice(0, -2).trim();
      if (/^-\d+(?:,\d+)?\s+\+\d+/.test(locator)) locator = "";
      const hunkLines: ParsedPatchLine[] = [];
      let endOfFile = false;
      let noNewlineAtEnd = false;
      while (index < lines.length && !isPatchFileHeader(lines[index]) && !lines[index].startsWith("@@")) {
        const line = lines[index];
        if (line === "*** End of File") {
          endOfFile = true;
          index++;
          break;
        }
        if (line === "\\ No newline at end of file") {
          noNewlineAtEnd = true;
          index++;
          continue;
        }
        const kind = line[0];
        if (kind !== " " && kind !== "+" && kind !== "-") {
          return {
            content: patchError(
              "E_PATCH_FORMAT",
              `${filePath}: hunk lines must start with space, +, or -`,
            ),
            isError: true,
          };
        }
        hunkLines.push({ kind, text: line.slice(1) });
        index++;
      }
      if (!hunkLines.some((line) => line.kind === "+" || line.kind === "-")) {
        return {
          content: patchError(
            "E_PATCH_FORMAT",
            `${filePath}: each hunk must add or remove at least one line`,
          ),
          isError: true,
        };
      }
      hunks.push({
        ...(locator ? { header: locator } : {}),
        lines: hunkLines,
        endOfFile,
        noNewlineAtEnd,
      });
    }
    if (!hunks.length) {
      return {
        content: patchError("E_PATCH_FORMAT", `${filePath}: Update File requires at least one hunk`),
        isError: true,
      };
    }
    files.push({ type: "update", path: filePath, ...(moveTo ? { moveTo } : {}), hunks });
  }

  if (!files.length) {
    return { content: patchError("E_PATCH_FORMAT", "patch contains no file operations"), isError: true };
  }
  return files;
}

function sequenceMatches(lines: readonly string[], sequence: readonly string[], at: number): boolean {
  if (at < 0 || at + sequence.length > lines.length) return false;
  for (let i = 0; i < sequence.length; i++) {
    if (lines[at + i] !== sequence[i]) return false;
  }
  return true;
}

function matchPositions(lines: readonly string[], sequence: readonly string[], from: number): number[] {
  const positions: number[] = [];
  for (let at = Math.max(0, from); at <= lines.length - sequence.length; at++) {
    if (sequenceMatches(lines, sequence, at)) positions.push(at);
  }
  return positions;
}

export function applyPatchHunks(
  original: string,
  filePath: string,
  hunks: readonly ParsedPatchHunk[],
): { content: string } | ToolResult {
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const normalized = original.replace(/\r\n?/g, "\n");
  let trailingNewline = normalized.endsWith("\n");
  const lines = normalized.split("\n");
  if (trailingNewline) lines.pop();
  let cursor = 0;

  for (let hunkIndex = 0; hunkIndex < hunks.length; hunkIndex++) {
    const hunk = hunks[hunkIndex];
    const before = hunk.lines.filter((line) => line.kind !== "+").map((line) => line.text);
    const after = hunk.lines.filter((line) => line.kind !== "-").map((line) => line.text);
    let searchFrom = cursor;
    let anchorPositions: number[] = [];
    if (hunk.header) {
      anchorPositions = lines
        .map((line, at) => ({ line, at }))
        .filter(({ line, at }) => at >= cursor && line.trim().includes(hunk.header!.trim()))
        .map(({ at }) => at);
      if (anchorPositions.length === 1) searchFrom = anchorPositions[0];
    }

    let position: number;
    if (before.length === 0) {
      if (hunk.endOfFile) position = lines.length;
      else if (anchorPositions.length === 1) position = anchorPositions[0] + 1;
      else {
        return {
          content: patchError(
            "E_PATCH_AMBIGUOUS",
            `${filePath}: hunk ${hunkIndex + 1} is a pure insertion without unique context or End of File`,
          ),
          isError: true,
        };
      }
    } else {
      const positions = matchPositions(lines, before, searchFrom)
        .filter((at) => !hunk.endOfFile || at + before.length === lines.length);
      if (positions.length === 0) {
        return {
          content: patchError(
            "E_PATCH_NO_MATCH",
            `${filePath}: hunk ${hunkIndex + 1} does not match the current file`,
          ),
          isError: true,
        };
      }
      if (positions.length > 1) {
        return {
          content: patchError(
            "E_PATCH_AMBIGUOUS",
            `${filePath}: hunk ${hunkIndex + 1} matches ${positions.length} locations; include more unchanged context`,
          ),
          isError: true,
        };
      }
      position = positions[0];
    }

    lines.splice(position, before.length, ...after);
    cursor = position + after.length;
    if (hunk.endOfFile && hunk.noNewlineAtEnd) trailingNewline = false;
  }
  return { content: lines.join(eol) + (trailingNewline && lines.length ? eol : "") };
}

function fileHash(content: string): string {
  return `sha256:${crypto.createHash("sha256").update(content, "utf8").digest("hex")}`;
}

function recoveryContext(body: string, hash: string): string {
  const maxChars = 1_600;
  const excerpt = body.slice(0, maxChars);
  return [
    `<patch-recovery file_hash="${hash}" total_chars="${body.length}">`,
    excerpt + (body.length > maxChars ? `\n...[${body.length - maxChars} chars omitted]` : ""),
    "</patch-recovery>",
    "Read the current file and rebuild the patch against these bytes; do not retry the unchanged patch.",
  ].join("\n");
}

function siblingPath(absolutePath: string, transactionId: string, suffix: "tmp" | "bak"): string {
  return path.join(
    path.dirname(absolutePath),
    `.${path.basename(absolutePath)}.core-agent-patch-${transactionId}.${suffix}`,
  );
}

class KeyedMutex {
  private tail = Promise.resolve();
  private pending = 0;

  async acquire(onIdle: () => void): Promise<() => void> {
    this.pending++;
    let unlock!: () => void;
    const gate = new Promise<void>((resolve) => { unlock = resolve; });
    const previous = this.tail;
    this.tail = previous.then(() => gate);
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pending--;
      unlock();
      if (this.pending === 0) onIdle();
    };
  }
}

const patchLocks = new Map<string, KeyedMutex>();

async function acquireDefaultLocks(paths: readonly string[]): Promise<() => void> {
  const releases: Array<() => void> = [];
  for (const absolutePath of [...new Set(paths)].sort()) {
    let mutex = patchLocks.get(absolutePath);
    if (!mutex) {
      mutex = new KeyedMutex();
      patchLocks.set(absolutePath, mutex);
    }
    const current = mutex;
    releases.push(await current.acquire(() => {
      if (patchLocks.get(absolutePath) === current) patchLocks.delete(absolutePath);
    }));
  }
  return () => {
    for (const release of releases.reverse()) release();
  };
}

function callbackError(value: void | ToolResult): ToolResult | null {
  return value && typeof value.content === "string" ? value : null;
}

export function createApplyPatchTool(hooks: ApplyPatchToolHooks = {}): AgentTool {
  return defineTool({
    name: "apply_patch",
    description:
      "Apply one transactional patch to existing or new text files. Supports *** Add File, *** Update File with @@ hunks, optional *** Move to, and *** Delete File inside *** Begin Patch / *** End Patch. Read existing targets first. Every target is validated before any file changes; conflicts fail the whole patch. Prefer a targeted edit tool for one small replacement and apply_patch for multiple edits or files.",
    inputSchema: {
      type: "object",
      properties: {
        patch: {
          type: "string",
          description:
            "File-oriented patch text. Context lines start with space, removals with -, additions with +. Paths may be relative to the working directory or absolute.",
        },
      },
      required: ["patch"],
    },
    async execute(input, ctx) {
      const parsed = parseApplyPatch(input.patch);
      if (!Array.isArray(parsed)) return parsed;

      const resolvePath = hooks.resolvePath
        ?? ((rawPath: string, toolCtx: ToolContext) => path.resolve(toolCtx.workingDir ?? ".", rawPath));
      const staged: StagedPatchFile[] = [];
      const touchedBy = new Map<string, number>();

      for (let index = 0; index < parsed.length; index++) {
        const operation = parsed[index];
        const sourceAbs = resolvePath(operation.path, ctx);
        const destinationAbs = operation.type === "update" && operation.moveTo
          ? resolvePath(operation.moveTo, ctx)
          : sourceAbs;
        const checks: ApplyPatchPathCheck[] = [{
          path: sourceAbs,
          role: "source",
          operation: operation.type,
          sourcePath: sourceAbs,
          destinationPath: destinationAbs,
        }];
        if (destinationAbs !== sourceAbs) {
          checks.push({
            path: destinationAbs,
            role: "destination",
            operation: operation.type,
            sourcePath: sourceAbs,
            destinationPath: destinationAbs,
          });
        }
        for (const check of checks) {
          const owner = touchedBy.get(check.path);
          if (owner !== undefined && owner !== index) {
            return {
              content: patchError(
                "E_PATCH_CONFLICT",
                `multiple operations touch the same path: ${check.path}`,
              ),
              isError: true,
            };
          }
          touchedBy.set(check.path, index);
          const denied = callbackError(await hooks.validatePath?.(check, ctx));
          if (denied) return denied;
        }
        staged.push({ parsed: operation, sourceAbs, destinationAbs });
      }

      const transactionId = crypto.randomBytes(10).toString("hex");
      const release = hooks.acquirePaths
        ? await hooks.acquirePaths([...touchedBy.keys()].sort(), ctx)
        : await acquireDefaultLocks([...touchedBy.keys()]);
      try {
        for (const file of staged) {
          const operation = file.parsed;
          if (operation.type === "add") {
            if (fs.existsSync(file.destinationAbs)) {
              return {
                content: patchError(
                  "E_PATCH_CONFLICT",
                  `${file.destinationAbs}: Add File target already exists`,
                ),
                isError: true,
              };
            }
            if (operation.content.includes("\0")) {
              return {
                content: patchError(
                  "E_NOT_EDITABLE",
                  `${file.destinationAbs}: apply_patch supports text files only`,
                ),
                isError: true,
              };
            }
            const denied = callbackError(await hooks.validateContent?.({
              path: file.destinationAbs,
              content: operation.content,
              operation: "add",
            }, ctx));
            if (denied) return denied;
            file.next = operation.content;
            file.afterHash = fileHash(operation.content);
            continue;
          }

          let stat: fs.Stats;
          try {
            stat = fs.statSync(file.sourceAbs);
          } catch {
            return {
              content: patchError("E_PATCH_CONFLICT", `${file.sourceAbs}: target does not exist`),
              isError: true,
            };
          }
          if (!stat.isFile()) {
            return {
              content: patchError(
                "E_NOT_EDITABLE",
                `${file.sourceAbs}: apply_patch supports regular text files only`,
              ),
              isError: true,
            };
          }
          let current: string;
          try {
            current = fs.readFileSync(file.sourceAbs, "utf8");
          } catch (error) {
            return {
              content: patchError(
                "E_PATCH_READ_FAILED",
                `${file.sourceAbs}: ${(error as Error).message}`,
              ),
              isError: true,
            };
          }
          if (current.includes("\0")) {
            return {
              content: patchError(
                "E_NOT_EDITABLE",
                `${file.sourceAbs}: apply_patch supports regular text files only`,
              ),
              isError: true,
            };
          }
          const currentHash = fileHash(current);
          const sourceCheck: ApplyPatchPathCheck = {
            path: file.sourceAbs,
            role: "source",
            operation: operation.type,
            sourcePath: file.sourceAbs,
            destinationPath: file.destinationAbs,
          };
          const denied = callbackError(await hooks.validateExisting?.({
            path: file.sourceAbs,
            content: current,
            stat,
            hash: currentHash,
          }, sourceCheck, ctx));
          if (denied) return denied;
          if (file.destinationAbs !== file.sourceAbs && fs.existsSync(file.destinationAbs)) {
            return {
              content: patchError(
                "E_PATCH_CONFLICT",
                `${file.destinationAbs}: Move to target already exists`,
              ),
              isError: true,
            };
          }

          file.beforeHash = currentHash;
          file.before = current;
          file.mode = stat.mode;
          if (operation.type === "delete") continue;
          const applied = applyPatchHunks(current, file.sourceAbs, operation.hunks);
          if ("isError" in applied && applied.isError) {
            return {
              ...applied,
              content: `${applied.content}\n${recoveryContext(current, currentHash)}`,
            };
          }
          if (applied.content === current && file.destinationAbs === file.sourceAbs) {
            return {
              content: patchError("E_PATCH_NO_CHANGE", `${file.sourceAbs}: patch produces no change`),
              isError: true,
            };
          }
          const contentDenied = callbackError(await hooks.validateContent?.({
            path: file.destinationAbs,
            content: applied.content,
            operation: "update",
          }, ctx));
          if (contentDenied) return contentDenied;
          file.next = applied.content;
          file.afterHash = fileHash(applied.content);
        }

        try {
          for (const file of staged) {
            if (file.parsed.type === "delete") continue;
            fs.mkdirSync(path.dirname(file.destinationAbs), { recursive: true });
            file.tempPath = siblingPath(file.destinationAbs, transactionId, "tmp");
            fs.writeFileSync(file.tempPath, file.next!, { encoding: "utf8", flag: "wx" });
            if (file.mode !== undefined) fs.chmodSync(file.tempPath, file.mode);
          }
        } catch (error) {
          for (const file of staged) {
            if (file.tempPath) {
              try { fs.unlinkSync(file.tempPath); } catch { /* best effort */ }
            }
          }
          return {
            content: patchError("E_PATCH_STAGE_FAILED", (error as Error).message),
            isError: true,
          };
        }

        let commitError: unknown;
        try {
          for (const file of staged) {
            if (file.parsed.type !== "add") {
              file.backupPath = siblingPath(file.sourceAbs, transactionId, "bak");
              fs.renameSync(file.sourceAbs, file.backupPath);
              file.backupMoved = true;
            }
            if (file.parsed.type !== "delete") {
              fs.renameSync(file.tempPath!, file.destinationAbs);
              file.targetReplaced = true;
            }
          }
        } catch (error) {
          commitError = error;
        }

        if (commitError) {
          for (const file of [...staged].reverse()) {
            if (file.targetReplaced && fs.existsSync(file.destinationAbs)) {
              try { fs.unlinkSync(file.destinationAbs); } catch { /* best effort */ }
            }
            if (file.backupMoved && file.backupPath && fs.existsSync(file.backupPath)) {
              try { fs.renameSync(file.backupPath, file.sourceAbs); } catch { /* best effort */ }
            }
            if (file.tempPath && fs.existsSync(file.tempPath)) {
              try { fs.unlinkSync(file.tempPath); } catch { /* best effort */ }
            }
          }
          return {
            content: patchError("E_PATCH_COMMIT_FAILED", (commitError as Error).message),
            isError: true,
          };
        }

        const committed: ApplyPatchCommittedFile[] = staged.map((file) => ({
          operation: file.parsed.type,
          sourcePath: file.sourceAbs,
          destinationPath: file.destinationAbs,
          ...(file.beforeHash ? { beforeHash: file.beforeHash } : {}),
          ...(file.afterHash ? { afterHash: file.afterHash } : {}),
          ...(file.parsed.type !== "add" && file.parsed.type !== "delete" && file.next !== undefined
            ? { afterContent: file.next }
            : {}),
          ...(file.parsed.type === "add" && file.next !== undefined ? { afterContent: file.next } : {}),
          ...(file.before !== undefined ? { beforeContent: file.before } : {}),
        }));
        for (const file of staged) {
          if (file.backupPath) {
            try { fs.unlinkSync(file.backupPath); } catch { /* best effort */ }
          }
        }
        const callbackWarnings: string[] = [];
        for (const file of committed) {
          try {
            await hooks.onCommitted?.(file, ctx);
          } catch (error) {
            callbackWarnings.push(`${file.destinationPath}: ${(error as Error).message}`);
          }
        }

        return {
          content: JSON.stringify({
            ok: true,
            transaction: transactionId,
            files: committed.map((file) => ({
              path: file.sourcePath,
              operation: file.operation,
              ...(file.destinationPath !== file.sourcePath ? { moved_to: file.destinationPath } : {}),
              ...(file.afterHash ? { file_hash: file.afterHash } : {}),
            })),
            ...(callbackWarnings.length ? { callback_warnings: callbackWarnings } : {}),
          }),
          observations: {
            fileChanges: committed.map((file) => {
              const renamed = file.destinationPath !== file.sourcePath;
              return {
                operation: renamed
                  ? "rename" as const
                  : file.operation === "add"
                    ? "create" as const
                    : file.operation === "delete"
                      ? "delete" as const
                      : "update" as const,
                sourcePath: file.sourcePath,
                ...(renamed ? { destinationPath: file.destinationPath } : {}),
                beforeExists: file.operation !== "add",
                afterExists: file.operation !== "delete",
                ...(file.beforeHash ? { beforeHash: file.beforeHash } : {}),
                ...(file.afterHash ? { afterHash: file.afterHash } : {}),
                ...(file.beforeContent !== undefined
                  ? {
                      beforeContent: file.beforeContent,
                      beforeBytes: Buffer.byteLength(file.beforeContent),
                    }
                  : {}),
                ...(file.afterContent !== undefined
                  ? {
                      afterContent: file.afterContent,
                      afterBytes: Buffer.byteLength(file.afterContent),
                    }
                  : {}),
                coverage: "exact" as const,
              };
            }),
          },
        };
      } finally {
        release();
      }
    },
  });
}

export const applyPatchTool = createApplyPatchTool();
