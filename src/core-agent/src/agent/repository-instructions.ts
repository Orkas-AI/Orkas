import fs from "node:fs/promises";
import path from "node:path";

export const REPOSITORY_INSTRUCTION_MAX_FILE_BYTES = 32 * 1024;
export const REPOSITORY_INSTRUCTION_MAX_TOTAL_BYTES = 64 * 1024;
export const REPOSITORY_INSTRUCTION_MAX_FILES = 16;
const REPOSITORY_INSTRUCTION_MAX_SCANNED_DIRECTORIES = 4_096;
const REPOSITORY_INSTRUCTION_EXCLUDED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".cache",
  "target",
  "__pycache__",
  ".venv",
]);

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

/** Discover repository facts and scoped AGENTS.md files without invoking Git
 * or changing the workspace. Ancestor instructions are ordered root-to-cwd,
 * followed by bounded descendant scopes in shallow-to-deep order. */
export async function discoverRepositoryInstructions(
  workingDir: string | undefined,
): Promise<RepositoryInstructions | undefined> {
  if (!workingDir) return undefined;
  const cwd = path.resolve(workingDir);
  try {
    if (!(await fs.stat(cwd)).isDirectory()) return undefined;
  } catch {
    return undefined;
  }

  const repositoryRoot = await findRepositoryRoot(cwd) ?? cwd;
  const directories = repositoryDirectories(repositoryRoot, cwd);

  const files: RepositoryInstructionFile[] = [];
  let remaining = REPOSITORY_INSTRUCTION_MAX_TOTAL_BYTES;
  let discoveryTruncated = false;
  for (const directory of directories) {
    if (files.length >= REPOSITORY_INSTRUCTION_MAX_FILES || remaining <= 0) {
      discoveryTruncated = true;
      break;
    }
    const filePath = path.join(directory, "AGENTS.md");
    const instruction = await readBoundedInstruction(filePath, directory, remaining);
    if (!instruction) continue;
    files.push(instruction);
    remaining -= Buffer.byteLength(instruction.content, "utf8");
    if (instruction.truncated) discoveryTruncated = true;
  }

  if (files.length < REPOSITORY_INSTRUCTION_MAX_FILES && remaining > 0) {
    const descendants = await discoverDescendantInstructions(
      cwd,
      REPOSITORY_INSTRUCTION_MAX_FILES - files.length,
    );
    discoveryTruncated ||= descendants.truncated;
    for (const filePath of descendants.paths) {
      if (files.length >= REPOSITORY_INSTRUCTION_MAX_FILES || remaining <= 0) {
        discoveryTruncated = true;
        break;
      }
      const directory = path.dirname(filePath);
      const instruction = await readBoundedInstruction(filePath, directory, remaining);
      if (!instruction) continue;
      files.push(instruction);
      remaining -= Buffer.byteLength(instruction.content, "utf8");
      if (instruction.truncated) discoveryTruncated = true;
    }
  }
  return {
    version: 1,
    workingDir: cwd,
    repositoryRoot,
    files,
    ...(discoveryTruncated ? { discoveryTruncated: true } : {}),
  };
}

export function repositoryInstructionsText(
  context: RepositoryInstructions | undefined,
): string {
  if (!context) return "";
  const lines = [
    "[Repository context — host-discovered facts]",
    `Working directory: ${context.workingDir}`,
    `Repository root: ${context.repositoryRoot}`,
  ];
  if (context.files.length) {
    lines.push(
      "AGENTS.md files are ordered shallow-to-deep. Each file applies only to files inside its directory subtree; a deeper applicable file takes precedence.",
    );
    for (const file of context.files) {
      lines.push(
        `\n--- ${file.path} (scope: ${file.directory}) ---\n`
        + `${file.content}${file.truncated ? "\n... [AGENTS.md truncated by host]" : ""}`,
      );
    }
  }
  if (context.discoveryTruncated) {
    lines.push(
      "Repository instruction discovery was bounded. Before editing a deeper target, check for a nearer AGENTS.md if its scope is not listed above.",
    );
  }
  return lines.join("\n");
}

async function discoverDescendantInstructions(
  cwd: string,
  maxFiles: number,
): Promise<{ paths: string[]; truncated: boolean }> {
  if (maxFiles <= 0) return { paths: [], truncated: true };
  const queue = [cwd];
  const found: string[] = [];
  let scannedDirectories = 0;
  let truncated = false;
  while (queue.length) {
    const directory = queue.shift()!;
    scannedDirectories++;
    if (scannedDirectories > REPOSITORY_INSTRUCTION_MAX_SCANNED_DIRECTORIES) {
      truncated = true;
      break;
    }
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isFile() && entry.name === "AGENTS.md" && directory !== cwd) {
        found.push(path.join(directory, entry.name));
        if (found.length >= maxFiles) {
          truncated = queue.length > 0 || entries.some((candidate) => (
            candidate !== entry
            && candidate.name === "AGENTS.md"
            && candidate.isFile()
          ));
          return { paths: found, truncated };
        }
        continue;
      }
      if (
        entry.isDirectory()
        && !REPOSITORY_INSTRUCTION_EXCLUDED_DIRECTORIES.has(entry.name)
      ) {
        queue.push(path.join(directory, entry.name));
      }
    }
  }
  return { paths: found, truncated };
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
): Promise<RepositoryInstructionFile | undefined> {
  let stat;
  try { stat = await fs.stat(filePath); } catch { return undefined; }
  if (!stat.isFile() || stat.size <= 0) return undefined;
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
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
