import fs from "node:fs/promises";
import path from "node:path";
import type { Stats } from "node:fs";
import type { Session } from "./session.js";

export const REPOSITORY_INSTRUCTION_MAX_FILE_BYTES = 32 * 1024;
export const REPOSITORY_INSTRUCTION_MAX_TOTAL_BYTES = 64 * 1024;
export const REPOSITORY_INSTRUCTION_MAX_FILES = 16;
export type RepositoryInstructionFile = {
  path: string;
  directory: string;
  content: string;
  truncated: boolean;
};

export type RepositoryInstructions = {
  version: 1;
  workingDir: string;
  repositoryRoot: string;
  files: RepositoryInstructionFile[];
  discoveryTruncated?: boolean;
};

type InstructionSnapshot = { signature: string; context: RepositoryInstructions };
// Runners are rebuilt each turn; Session identity survives until eviction/reload.
// One bounded snapshot per live Session, never shared across accounts or persisted.
const snapshots = new WeakMap<Session, InstructionSnapshot>();

/** Read only the root-to-cwd instruction chain. Revalidate candidate metadata
 * each run (including absent files); reuse bodies while that chain is unchanged.
 * Descendant scopes are read by the model on demand through existing file tools. */
export async function discoverRepositoryInstructions(
  workingDir: string | undefined,
  session?: Session,
): Promise<RepositoryInstructions | undefined> {
  const cached = session ? snapshots.get(session) : undefined;
  // A failed/partial refresh must not leave an old snapshot available to reuse.
  if (session) snapshots.delete(session);
  if (!workingDir) return undefined;
  const cwd = path.resolve(workingDir);
  try {
    if (!(await fs.stat(cwd)).isDirectory()) return undefined;
  } catch {
    return undefined;
  }

  const repositoryRoot = await findRepositoryRoot(cwd) ?? cwd;
  const directories = repositoryDirectories(repositoryRoot, cwd);
  let cacheable = true;
  const candidates = await Promise.all(directories.map(async (directory) => {
    const filePath = path.join(directory, "AGENTS.md");
    let stat: Stats | undefined;
    try {
      stat = await fs.stat(filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") cacheable = false;
    }
    return { directory, filePath, stat };
  }));
  const signature = JSON.stringify([cwd, repositoryRoot, candidates.map(({ filePath, stat }) => [
    filePath,
    stat ? [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.size, stat.mtimeMs, stat.ctimeMs] : null,
  ])]);
  if (cacheable && cached?.signature === signature) {
    if (session) snapshots.set(session, cached);
    return copyContext(cached.context);
  }

  const files: RepositoryInstructionFile[] = [];
  let remaining = REPOSITORY_INSTRUCTION_MAX_TOTAL_BYTES;
  let discoveryTruncated = !cacheable;
  for (const { directory, filePath, stat } of candidates) {
    if (files.length >= REPOSITORY_INSTRUCTION_MAX_FILES || remaining <= 0) {
      discoveryTruncated = true;
      break;
    }
    if (!stat?.isFile() || stat.size <= 0) continue;
    try {
      const instruction = await readBoundedInstruction(filePath, directory, remaining, stat);
      if (!instruction) continue;
      files.push(instruction);
      remaining -= Buffer.byteLength(instruction.content, "utf8");
      if (instruction.truncated) discoveryTruncated = true;
    } catch {
      cacheable = false;
      discoveryTruncated = true;
    }
  }
  const context: RepositoryInstructions = {
    version: 1,
    workingDir: cwd,
    repositoryRoot,
    files,
    ...(discoveryTruncated ? { discoveryTruncated: true } : {}),
  };
  if (session && cacheable) snapshots.set(session, { signature, context: copyContext(context) });
  return context;
}

function copyContext(context: RepositoryInstructions): RepositoryInstructions {
  return { ...context, files: context.files.map((file) => ({ ...file })) };
}

export function repositoryInstructionsText(
  context: RepositoryInstructions | undefined,
): string {
  if (!context) return "";
  const lines = [
    "[Repository context — host-discovered facts]",
    `Working directory: ${context.workingDir}`,
    `Repository root: ${context.repositoryRoot}`,
    "Only root-to-working-directory AGENTS.md files are preloaded below; subdirectories are not scanned. Do not reread these files solely to reload unchanged instructions.",
    "Before modifying files in a deeper or other authorized directory, check the target's ancestor directories for applicable AGENTS.md files not loaded here and read them with existing file tools. Reuse rules already read in this turn unless they change.",
    "AGENTS.md files are ordered shallow-to-deep. Each file applies only to files inside its directory subtree; a deeper applicable file takes precedence.",
  ];
  if (context.files.length) {
    for (const file of context.files) {
      lines.push(
        `\n--- ${file.path} (scope: ${file.directory}) ---\n`
        + `${file.content}${file.truncated ? "\n... [AGENTS.md truncated by host]" : ""}`,
      );
    }
  }
  if (context.discoveryTruncated) {
    lines.push(
      "Some repository instructions could not be fully loaded. Read missing or truncated applicable instructions before modifying files.",
    );
  }
  return lines.join("\n");
}

async function findRepositoryRoot(start: string): Promise<string | undefined> {
  let cursor = start;
  while (true) {
    try {
      const marker = await fs.stat(path.join(cursor, ".git"));
      if (marker.isDirectory() || marker.isFile()) return cursor;
    } catch { /* keep walking */ }
    const parent = path.dirname(cursor);
    if (parent === cursor) return undefined;
    cursor = parent;
  }
}

function repositoryDirectories(root: string, cwd: string): string[] {
  const relative = path.relative(root, cwd);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return [root];
  const directories = [root];
  let cursor = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    directories.push(cursor);
  }
  return directories;
}

async function readBoundedInstruction(
  filePath: string,
  directory: string,
  remainingBytes: number,
  stat: Stats,
): Promise<RepositoryInstructionFile | undefined> {
  const maxBytes = Math.min(
    REPOSITORY_INSTRUCTION_MAX_FILE_BYTES,
    remainingBytes,
    stat.size,
  );
  if (maxBytes <= 0) return undefined;

  let handle;
  try {
    handle = await fs.open(filePath, "r");
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    const content = buffer.subarray(0, bytesRead).toString("utf8").trim();
    if (!content) return undefined;
    return {
      path: filePath,
      directory,
      content,
      truncated: stat.size > bytesRead,
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
