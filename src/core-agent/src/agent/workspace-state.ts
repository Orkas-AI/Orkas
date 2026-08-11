import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type {
  CommandExecutionObservation,
  FileChangeObservation,
  FileReadObservation,
  ToolObservations,
} from "../tools/base.js";

export const WORKSPACE_OBSERVATION_MAX_ENTRIES = 256;
export const WORKSPACE_SNAPSHOT_MAX_CHARS = 512_000;
export const WORKSPACE_SNAPSHOT_TOTAL_MAX_CHARS = 8_000_000;
export const WORKSPACE_CONTEXT_MAX_FILES = 20;
export const WORKSPACE_CONTEXT_MAX_COMMANDS = 6;
export const WORKSPACE_DIFF_DEFAULT_MAX_CHARS = 50_000;
export const WORKSPACE_DIFF_MAX_CHARS = 120_000;
const WORKSPACE_DIFF_MAX_PATHS = 32;
const LCS_MAX_CELLS = 1_500_000;
const DIFF_CONTEXT_LINES = 3;
const STALE_HASH_MAX_BYTES = 8 * 1024 * 1024;
const WORKSPACE_RECONCILE_MAX_PATHS = 128;
const WORKSPACE_RECONCILE_FILE_MAX_BYTES = 2 * 1024 * 1024;
const WORKSPACE_RECONCILE_TOTAL_MAX_BYTES = 16 * 1024 * 1024;
const WORKSPACE_COMPACTED_MAX_PATHS = 2_048;
const WORKSPACE_COMPACTED_MAX_TURNS = 16;
const WORKSPACE_COMPACTED_MAX_READS = 256;

export type WorkspaceObservationEntry = {
  sequence: number;
  turnId: number;
  toolCallId?: string;
  tool: string;
  recordedAt: number;
  fileReads?: FileReadObservation[];
  fileChanges?: FileChangeObservation[];
  execution?: CommandExecutionObservation;
};

export type WorkspaceObservationState = {
  version: 1;
  nextSequence: number;
  entries: WorkspaceObservationEntry[];
  compacted?: WorkspaceCompactedState;
};

export type WorkspaceCompactedState = {
  throughSequence: number;
  sessionFileChanges: FileChangeObservation[];
  turns: Array<{
    turnId: number;
    throughSequence: number;
    fileChanges: FileChangeObservation[];
  }>;
  latestReads: Array<{
    turnId: number;
    sequence: number;
    read: FileReadObservation;
  }>;
};

export type WorkspaceDiffRequest = {
  scope?: "turn" | "session";
  format?: "summary" | "unified";
  paths?: string[];
  max_chars?: number;
};

type NetChange = {
  originalPath: string;
  currentPath: string;
  beforeExists: boolean;
  afterExists: boolean;
  beforeHash?: string;
  afterHash?: string;
  beforeBytes?: number;
  afterBytes?: number;
  beforeContent?: string;
  afterContent?: string;
  binary: boolean;
  coverage: "exact" | "partial";
  firstSequence: number;
  lastSequence: number;
};

type DiffRow = {
  kind: " " | "+" | "-";
  text: string;
  oldLine?: number;
  newLine?: number;
};

export function emptyWorkspaceObservationState(): WorkspaceObservationState {
  return { version: 1, nextSequence: 1, entries: [] };
}

export function cloneWorkspaceObservationState(
  input: WorkspaceObservationState | undefined,
): WorkspaceObservationState {
  if (!input) return emptyWorkspaceObservationState();
  return {
    version: 1,
    nextSequence: Math.max(1, Math.trunc(input.nextSequence || 1)),
    entries: input.entries.map(cloneEntry),
    ...(input.compacted ? { compacted: cloneCompactedState(input.compacted) } : {}),
  };
}

export function normalizeWorkspaceObservationState(input: unknown): WorkspaceObservationState {
  if (!input || typeof input !== "object") return emptyWorkspaceObservationState();
  const raw = input as Partial<WorkspaceObservationState>;
  if (raw.version !== 1 || !Array.isArray(raw.entries)) return emptyWorkspaceObservationState();
  const parsedEntries = raw.entries
    .filter((entry): entry is WorkspaceObservationEntry => (
      !!entry
      && typeof entry === "object"
      && Number.isFinite(entry.sequence)
      && Number.isFinite(entry.turnId)
      && typeof entry.tool === "string"
    ))
    .map(cloneEntry);
  const compacted = normalizeCompactedState(raw.compacted);
  const overflow = Math.max(0, parsedEntries.length - WORKSPACE_OBSERVATION_MAX_ENTRIES);
  const entries = overflow ? parsedEntries.slice(overflow) : parsedEntries;
  const highest = entries.reduce((max, entry) => Math.max(max, entry.sequence), 0);
  const compactedHighest = compacted?.throughSequence ?? 0;
  const nextSequence = Number.isFinite(raw.nextSequence)
    ? Math.max(highest + 1, compactedHighest + 1, Math.trunc(raw.nextSequence!))
    : Math.max(highest, compactedHighest) + 1;
  const state: WorkspaceObservationState = {
    version: 1,
    nextSequence,
    entries,
    ...(compacted ? { compacted } : {}),
  };
  if (overflow) compactEntries(state, parsedEntries.slice(0, overflow));
  enforceSnapshotBudget(state);
  return state;
}

export function appendWorkspaceObservations(
  state: WorkspaceObservationState,
  input: {
    turnId: number;
    toolCallId?: string;
    tool: string;
    observations: ToolObservations;
    recordedAt?: number;
  },
): WorkspaceObservationEntry | undefined {
  const observations = normalizeObservations(input.observations);
  if (
    !observations.fileReads?.length
    && !observations.fileChanges?.length
    && !observations.execution
  ) {
    return undefined;
  }
  const entry: WorkspaceObservationEntry = {
    sequence: state.nextSequence++,
    turnId: input.turnId,
    ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
    tool: input.tool,
    recordedAt: input.recordedAt ?? Date.now(),
    ...observations,
  };
  state.entries.push(entry);
  if (state.entries.length > WORKSPACE_OBSERVATION_MAX_ENTRIES) {
    const evicted = state.entries.splice(
      0,
      state.entries.length - WORKSPACE_OBSERVATION_MAX_ENTRIES,
    );
    compactEntries(state, evicted);
  }
  enforceSnapshotBudget(state);
  return cloneEntry(entry);
}

/**
 * Reconcile the bounded set of files the agent has already observed against
 * disk. This intentionally does not scan the whole repository: it detects
 * external/editor changes to known paths without turning every model loop into
 * an unbounded workspace crawl.
 */
export function reconcileWorkspaceObservations(
  state: WorkspaceObservationState,
  input: { turnId: number; recordedAt?: number },
): WorkspaceObservationEntry | undefined {
  if (!hasWorkspaceState(state)) return undefined;

  const changes: FileChangeObservation[] = [];
  const readBudget = { remaining: WORKSPACE_RECONCILE_TOTAL_MAX_BYTES };
  const sessionEntries = workspaceEntriesForSession(state);
  const net = netChanges(sessionEntries);
  const trackedPaths = new Set(net.flatMap((change) => [
    path.resolve(change.originalPath),
    path.resolve(change.currentPath),
  ]));

  for (const expected of net.slice(-WORKSPACE_RECONCILE_MAX_PATHS)) {
    const current = readReconcileSnapshot(expected.currentPath, readBudget);
    if (!snapshotDefinitelyChanged(expected, current)) continue;
    changes.push(reconciledChange({
      filePath: expected.currentPath,
      beforeExists: expected.afterExists,
      beforeHash: expected.afterHash,
      beforeBytes: expected.afterBytes,
      beforeContent: expected.afterContent,
      beforeBinary: expected.binary,
      beforeCoverage: expected.coverage,
      current,
    }));
  }

  if (changes.length < WORKSPACE_RECONCILE_MAX_PATHS) {
    const latestReads = latestFileReads([
      ...compactedReadEntries(state),
      ...state.entries,
    ]);
    for (const read of latestReads) {
      const filePath = path.resolve(read.path);
      if (trackedPaths.has(filePath) || !read.hash) continue;
      const current = readReconcileSnapshot(filePath, readBudget);
      if (current.exists && (!current.hash || current.hash === read.hash)) continue;
      changes.push(reconciledChange({
        filePath,
        beforeExists: true,
        beforeHash: read.hash,
        beforeBinary: false,
        beforeCoverage: "exact",
        current,
      }));
      if (changes.length >= WORKSPACE_RECONCILE_MAX_PATHS) break;
    }
  }

  if (!changes.length) return undefined;
  return appendWorkspaceObservations(state, {
    turnId: input.turnId,
    tool: "workspace_reconcile",
    recordedAt: input.recordedAt,
    observations: { fileChanges: changes },
  });
}

export type WorkspaceReadRepetition = {
  /** File reads recorded after the boundary. */
  readsAfter: number;
  /** Of those, reads of a path that had already been read before it. */
  repeatedPaths: number;
  /** Of those, reads whose content hash also matches the earlier read — the
   *  file had not changed, so the re-read recovered nothing new. */
  repeatedIdenticalContent: number;
};

/**
 * How much of what was read after a boundary had already been read before it.
 *
 * Compaction trades context size against re-reading: whatever the checkpoint
 * fails to carry, the model fetches again. That trade is measurable rather than
 * arguable, and this is the measurement — the thresholds and ceilings in
 * `context-budget.ts` were chosen conservatively and are meant to be calibrated
 * against it rather than by argument.
 *
 * `repeatedIdenticalContent` is the sharper number: the same path AND the same
 * content hash means the second read returned exactly what the first one did.
 *
 * Bounded by the observation history that survives (`WORKSPACE_COMPACTED_MAX_READS`
 * entries), so on a very long run this under-counts rather than over-counts.
 */
export function workspaceReadRepetition(
  state: WorkspaceObservationState | undefined,
  boundarySequence: number,
): WorkspaceReadRepetition {
  const empty: WorkspaceReadRepetition = {
    readsAfter: 0,
    repeatedPaths: 0,
    repeatedIdenticalContent: 0,
  };
  if (!state) return empty;

  const before = new Map<string, Set<string>>();
  const after: FileReadObservation[] = [];
  const consider = (sequence: number, read: FileReadObservation): void => {
    if (!read?.path) return;
    // `boundarySequence` is the cursor value taken at the compaction point,
    // i.e. the next sequence to be assigned — so anything below it happened
    // before, and the cursor value itself belongs to the first read after.
    if (sequence < boundarySequence) {
      const hashes = before.get(read.path) ?? new Set<string>();
      if (read.hash) hashes.add(read.hash);
      before.set(read.path, hashes);
      return;
    }
    after.push(read);
  };

  for (const item of state.compacted?.latestReads ?? []) consider(item.sequence, item.read);
  for (const entry of state.entries) {
    for (const read of entry.fileReads ?? []) consider(entry.sequence, read);
  }

  let repeatedPaths = 0;
  let repeatedIdenticalContent = 0;
  for (const read of after) {
    const hashes = before.get(read.path);
    if (!hashes) continue;
    repeatedPaths++;
    if (read.hash && hashes.has(read.hash)) repeatedIdenticalContent++;
  }
  return { readsAfter: after.length, repeatedPaths, repeatedIdenticalContent };
}

export function renderWorkspaceContext(
  state: WorkspaceObservationState | undefined,
  activeTurnId: number,
  workingDir?: string,
): string {
  if (!hasWorkspaceState(state)) return "";
  const entries = workspaceEntriesForTurn(state!, activeTurnId);
  const changes = netChanges(entries);
  const changed = changes.filter(hasNetChange);
  if (!changed.length) return "";
  const lastChangeSequence = Math.max(...changed.map((change) => change.lastSequence));
  const commands = entries
    .filter((entry) => entry.execution && entry.sequence > lastChangeSequence)
    .slice(-WORKSPACE_CONTEXT_MAX_COMMANDS);
  const lines = [
    "[Workspace changes — deterministic host state]",
    "These are tool-observed file facts for the current user turn, not a model summary.",
    "Changed:",
  ];
  for (const change of changed.slice(0, WORKSPACE_CONTEXT_MAX_FILES)) {
    lines.push(`- ${changeStatus(change)} ${displayPath(change.currentPath, workingDir)}`
      + (change.originalPath !== change.currentPath
        ? ` (from ${displayPath(change.originalPath, workingDir)})`
        : "")
      + (change.afterHash ? ` ${change.afterHash}` : "")
      + (changeIsStale(change) ? " stale=true" : "")
      + (change.coverage === "partial" ? " coverage=partial" : ""));
  }
  if (changed.length > WORKSPACE_CONTEXT_MAX_FILES) {
    lines.push(`- ... ${changed.length - WORKSPACE_CONTEXT_MAX_FILES} more changed file(s); use workspace_diff`);
  }
  if (commands.length) {
    lines.push("Commands after latest observed change:");
    for (const entry of commands) {
      const execution = entry.execution!;
      lines.push(`- ${entry.tool}: status=${execution.status} exit_code=${execution.exitCode ?? "null"} duration_ms=${execution.durationMs}`);
    }
  }
  lines.push("Use workspace_diff for the bounded current diff; do not infer unrecorded shell changes as exact.");
  return lines.join("\n");
}

export function renderWorkspaceDiff(
  state: WorkspaceObservationState | undefined,
  request: WorkspaceDiffRequest,
  opts: { activeTurnId?: number; workingDir?: string } = {},
): string {
  const scope = request.scope === "session" ? "session" : "turn";
  const format = request.format === "summary" ? "summary" : "unified";
  const maxChars = clampInt(
    request.max_chars,
    1_000,
    WORKSPACE_DIFF_MAX_CHARS,
    WORKSPACE_DIFF_DEFAULT_MAX_CHARS,
  );
  if (!hasWorkspaceState(state)) {
    return `<workspace-diff scope="${scope}" files_changed="0">No observed workspace changes.</workspace-diff>`;
  }
  const entries = scope === "session"
    ? workspaceEntriesForSession(state!)
    : workspaceEntriesForTurn(state!, opts.activeTurnId);
  const filters = normalizePathFilters(request.paths, opts.workingDir);
  let changes = netChanges(entries).filter(hasNetChange);
  if (filters.length) {
    changes = changes.filter((change) => (
      filters.some((filter) => samePath(filter, change.originalPath) || samePath(filter, change.currentPath))
    ));
  }
  if (!changes.length) {
    return `<workspace-diff scope="${scope}" files_changed="0">No observed workspace changes matched this request.</workspace-diff>`;
  }

  const creates = changes.filter((change) => !change.beforeExists && change.afterExists).length;
  const deletes = changes.filter((change) => change.beforeExists && !change.afterExists).length;
  const renames = changes.filter((change) => change.originalPath !== change.currentPath).length;
  const updates = changes.length - creates - deletes - renames;
  const coverage = changes.some((change) => change.coverage === "partial") ? "partial" : "exact";
  const stale = changes.filter(changeIsStale).length;
  const header =
    `<workspace-diff scope="${scope}" files_changed="${changes.length}" creates="${creates}" `
    + `updates="${updates}" deletes="${deletes}" renames="${renames}" coverage="${coverage}" stale="${stale}">`;
  const lines = [header];
  for (const change of changes) {
    lines.push(changeSummary(change, opts.workingDir));
  }
  if (format === "unified") {
    for (const change of changes) {
      const diff = unifiedDiff(change, opts.workingDir);
      if (diff) lines.push("", diff);
    }
  }
  lines.push("</workspace-diff>");
  const output = lines.join("\n");
  if (output.length <= maxChars) return output;
  return `${output.slice(0, Math.max(0, maxChars - 120))}\n...[workspace diff truncated; narrow with paths or summary format]\n</workspace-diff>`;
}

function normalizeObservations(input: ToolObservations): ToolObservations {
  const fileReads = Array.isArray(input.fileReads)
    ? input.fileReads.filter(validRead).map((read) => ({
        path: path.resolve(read.path),
        ...(read.hash ? { hash: read.hash } : {}),
        ...(read.charRange ? { charRange: [...read.charRange] as [number, number] } : {}),
        ...(read.lineRange ? { lineRange: [...read.lineRange] as [number, number] } : {}),
      }))
    : undefined;
  const fileChanges = Array.isArray(input.fileChanges)
    ? input.fileChanges.filter(validChange).map((change) => ({
        ...change,
        sourcePath: path.resolve(change.sourcePath),
        ...(change.destinationPath ? { destinationPath: path.resolve(change.destinationPath) } : {}),
        ...(typeof change.beforeContent === "string" && change.beforeContent.length <= WORKSPACE_SNAPSHOT_MAX_CHARS
          ? { beforeContent: change.beforeContent }
          : { beforeContent: undefined }),
        ...(typeof change.afterContent === "string" && change.afterContent.length <= WORKSPACE_SNAPSHOT_MAX_CHARS
          ? { afterContent: change.afterContent }
          : { afterContent: undefined }),
      }))
    : undefined;
  return {
    ...(fileReads?.length ? { fileReads } : {}),
    ...(fileChanges?.length ? { fileChanges } : {}),
    ...(input.execution ? { execution: cloneExecution(input.execution) } : {}),
  };
}

function validRead(input: FileReadObservation): boolean {
  return !!input && typeof input.path === "string" && !!input.path;
}

function validChange(input: FileChangeObservation): boolean {
  return !!input
    && typeof input.sourcePath === "string"
    && !!input.sourcePath
    && typeof input.beforeExists === "boolean"
    && typeof input.afterExists === "boolean";
}

function cloneEntry(entry: WorkspaceObservationEntry): WorkspaceObservationEntry {
  return {
    ...entry,
    ...(entry.fileReads ? {
      fileReads: entry.fileReads.map((read) => ({
        ...read,
        ...(read.charRange ? { charRange: [...read.charRange] as [number, number] } : {}),
        ...(read.lineRange ? { lineRange: [...read.lineRange] as [number, number] } : {}),
      })),
    } : {}),
    ...(entry.fileChanges ? { fileChanges: entry.fileChanges.map((change) => ({ ...change })) } : {}),
    ...(entry.execution ? { execution: cloneExecution(entry.execution) } : {}),
  };
}

function cloneExecution(input: CommandExecutionObservation): CommandExecutionObservation {
  return {
    ...input,
    stdout: { ...input.stdout },
    stderr: { ...input.stderr },
  };
}

function cloneRead(read: FileReadObservation): FileReadObservation {
  return {
    ...read,
    ...(read.charRange ? { charRange: [...read.charRange] as [number, number] } : {}),
    ...(read.lineRange ? { lineRange: [...read.lineRange] as [number, number] } : {}),
  };
}

function cloneCompactedState(input: WorkspaceCompactedState): WorkspaceCompactedState {
  return {
    throughSequence: input.throughSequence,
    sessionFileChanges: input.sessionFileChanges.map((change) => ({ ...change })),
    turns: input.turns.map((turn) => ({
      turnId: turn.turnId,
      throughSequence: turn.throughSequence,
      fileChanges: turn.fileChanges.map((change) => ({ ...change })),
    })),
    latestReads: input.latestReads.map((entry) => ({
      turnId: entry.turnId,
      sequence: entry.sequence,
      read: cloneRead(entry.read),
    })),
  };
}

function normalizeCompactedState(input: unknown): WorkspaceCompactedState | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as Partial<WorkspaceCompactedState>;
  if (!Number.isFinite(raw.throughSequence)) return undefined;
  const sessionFileChanges = normalizeObservations({
    fileChanges: Array.isArray(raw.sessionFileChanges)
      ? raw.sessionFileChanges as FileChangeObservation[]
      : [],
  }).fileChanges ?? [];
  const turns = Array.isArray(raw.turns)
    ? raw.turns
      .filter((turn) => (
        !!turn
        && typeof turn === "object"
        && Number.isFinite(turn.turnId)
        && Number.isFinite(turn.throughSequence)
        && Array.isArray(turn.fileChanges)
      ))
      .slice(-WORKSPACE_COMPACTED_MAX_TURNS)
      .map((turn) => ({
        turnId: Math.trunc(turn.turnId),
        throughSequence: Math.trunc(turn.throughSequence),
        fileChanges: normalizeObservations({
          fileChanges: turn.fileChanges as FileChangeObservation[],
        }).fileChanges?.slice(-WORKSPACE_COMPACTED_MAX_PATHS) ?? [],
      }))
    : [];
  const latestReads = Array.isArray(raw.latestReads)
    ? raw.latestReads
      .filter((entry) => (
        !!entry
        && typeof entry === "object"
        && Number.isFinite(entry.turnId)
        && Number.isFinite(entry.sequence)
        && validRead(entry.read)
      ))
      .slice(-WORKSPACE_COMPACTED_MAX_READS)
      .map((entry) => ({
        turnId: Math.trunc(entry.turnId),
        sequence: Math.trunc(entry.sequence),
        read: normalizeObservations({ fileReads: [entry.read] }).fileReads![0],
      }))
    : [];
  return {
    throughSequence: Math.max(0, Math.trunc(raw.throughSequence!)),
    sessionFileChanges: sessionFileChanges.slice(-WORKSPACE_COMPACTED_MAX_PATHS),
    turns,
    latestReads,
  };
}

function virtualCompactedEntry(
  sequence: number,
  turnId: number,
  fileChanges?: FileChangeObservation[],
  fileReads?: FileReadObservation[],
): WorkspaceObservationEntry {
  return {
    sequence,
    turnId,
    tool: "workspace_compacted",
    recordedAt: 0,
    ...(fileChanges?.length ? { fileChanges } : {}),
    ...(fileReads?.length ? { fileReads } : {}),
  };
}

function compactedReadEntries(state: WorkspaceObservationState): WorkspaceObservationEntry[] {
  if (!state.compacted?.latestReads.length) return [];
  return state.compacted.latestReads.map((entry) => (
    virtualCompactedEntry(entry.sequence, entry.turnId, undefined, [entry.read])
  ));
}

function workspaceEntriesForSession(
  state: WorkspaceObservationState,
): WorkspaceObservationEntry[] {
  const compacted = state.compacted;
  return [
    ...(compacted?.sessionFileChanges.length
      ? [virtualCompactedEntry(
          compacted.throughSequence,
          0,
          compacted.sessionFileChanges,
        )]
      : []),
    ...state.entries,
  ];
}

function workspaceEntriesForTurn(
  state: WorkspaceObservationState,
  turnId: number | undefined,
): WorkspaceObservationEntry[] {
  if (!Number.isFinite(turnId)) return [];
  const compacted = state.compacted?.turns.find((turn) => turn.turnId === turnId);
  return [
    ...(compacted?.fileChanges.length
      ? [virtualCompactedEntry(
          compacted.throughSequence,
          compacted.turnId,
          compacted.fileChanges,
        )]
      : []),
    ...state.entries.filter((entry) => entry.turnId === turnId),
  ];
}

function hasWorkspaceState(
  state: WorkspaceObservationState | undefined,
): state is WorkspaceObservationState {
  return !!state && (
    state.entries.length > 0
    || !!state.compacted?.sessionFileChanges.length
    || !!state.compacted?.latestReads.length
  );
}

function netChangeToObservation(change: NetChange): FileChangeObservation {
  const operation: FileChangeObservation["operation"] =
    change.originalPath !== change.currentPath
      ? "rename"
      : !change.beforeExists && change.afterExists
        ? "create"
        : change.beforeExists && !change.afterExists
          ? "delete"
          : "update";
  return {
    operation,
    sourcePath: change.originalPath,
    ...(change.originalPath !== change.currentPath
      ? { destinationPath: change.currentPath }
      : {}),
    beforeExists: change.beforeExists,
    afterExists: change.afterExists,
    ...(change.beforeHash ? { beforeHash: change.beforeHash } : {}),
    ...(change.afterHash ? { afterHash: change.afterHash } : {}),
    ...(change.beforeBytes !== undefined ? { beforeBytes: change.beforeBytes } : {}),
    ...(change.afterBytes !== undefined ? { afterBytes: change.afterBytes } : {}),
    ...(change.beforeContent !== undefined ? { beforeContent: change.beforeContent } : {}),
    ...(change.afterContent !== undefined ? { afterContent: change.afterContent } : {}),
    binary: change.binary,
    coverage: change.coverage,
  };
}

function compactedFileChanges(
  prior: FileChangeObservation[],
  priorSequence: number,
  entries: readonly WorkspaceObservationEntry[],
): FileChangeObservation[] {
  const combined = [
    ...(prior.length
      ? [virtualCompactedEntry(priorSequence, 0, prior)]
      : []),
    ...entries,
  ];
  return netChanges(combined)
    .slice(-WORKSPACE_COMPACTED_MAX_PATHS)
    .map(netChangeToObservation);
}

function compactEntries(
  state: WorkspaceObservationState,
  evicted: readonly WorkspaceObservationEntry[],
): void {
  if (!evicted.length) return;
  const prior = state.compacted;
  const throughSequence = Math.max(
    prior?.throughSequence ?? 0,
    ...evicted.map((entry) => entry.sequence),
  );
  const sessionFileChanges = compactedFileChanges(
    prior?.sessionFileChanges ?? [],
    prior?.throughSequence ?? 0,
    evicted,
  );

  const turnMap = new Map<number, WorkspaceCompactedState["turns"][number]>();
  for (const turn of prior?.turns ?? []) {
    turnMap.set(turn.turnId, {
      turnId: turn.turnId,
      throughSequence: turn.throughSequence,
      fileChanges: turn.fileChanges.map((change) => ({ ...change })),
    });
  }
  const evictedByTurn = new Map<number, WorkspaceObservationEntry[]>();
  for (const entry of evicted) {
    const grouped = evictedByTurn.get(entry.turnId) ?? [];
    grouped.push(entry);
    evictedByTurn.set(entry.turnId, grouped);
  }
  for (const [turnId, entries] of evictedByTurn) {
    const previousTurn = turnMap.get(turnId);
    const turnThroughSequence = Math.max(
      previousTurn?.throughSequence ?? 0,
      ...entries.map((entry) => entry.sequence),
    );
    turnMap.set(turnId, {
      turnId,
      throughSequence: turnThroughSequence,
      fileChanges: compactedFileChanges(
        previousTurn?.fileChanges ?? [],
        previousTurn?.throughSequence ?? 0,
        entries,
      ),
    });
  }
  const turns = [...turnMap.values()]
    .sort((a, b) => a.throughSequence - b.throughSequence)
    .slice(-WORKSPACE_COMPACTED_MAX_TURNS);

  const readMap = new Map<string, WorkspaceCompactedState["latestReads"][number]>();
  for (const entry of prior?.latestReads ?? []) {
    readMap.set(path.resolve(entry.read.path), {
      turnId: entry.turnId,
      sequence: entry.sequence,
      read: cloneRead(entry.read),
    });
  }
  for (const entry of evicted) {
    for (const read of entry.fileReads ?? []) {
      const filePath = path.resolve(read.path);
      readMap.delete(filePath);
      readMap.set(filePath, {
        turnId: entry.turnId,
        sequence: entry.sequence,
        read: cloneRead(read),
      });
    }
  }
  const latestReads = [...readMap.values()]
    .sort((a, b) => a.sequence - b.sequence)
    .slice(-WORKSPACE_COMPACTED_MAX_READS);

  state.compacted = {
    throughSequence,
    sessionFileChanges,
    turns,
    latestReads,
  };
}

function enforceSnapshotBudget(state: WorkspaceObservationState): void {
  let total = 0;
  const budgetEntries = [
    ...(state.compacted?.turns.map((turn) => (
      virtualCompactedEntry(turn.throughSequence, turn.turnId, turn.fileChanges)
    )) ?? []),
    ...(state.compacted?.sessionFileChanges.length
      ? [virtualCompactedEntry(
          state.compacted.throughSequence,
          0,
          state.compacted.sessionFileChanges,
        )]
      : []),
    ...state.entries,
  ];
  for (const entry of budgetEntries) {
    for (const change of entry.fileChanges ?? []) {
      total += change.beforeContent?.length ?? 0;
      total += change.afterContent?.length ?? 0;
    }
  }
  if (total <= WORKSPACE_SNAPSHOT_TOTAL_MAX_CHARS) return;
  for (const entry of budgetEntries) {
    for (const change of entry.fileChanges ?? []) {
      if (total <= WORKSPACE_SNAPSHOT_TOTAL_MAX_CHARS) return;
      if (change.beforeContent !== undefined) {
        total -= change.beforeContent.length;
        delete change.beforeContent;
      }
      if (total <= WORKSPACE_SNAPSHOT_TOTAL_MAX_CHARS) return;
      if (change.afterContent !== undefined) {
        total -= change.afterContent.length;
        delete change.afterContent;
      }
    }
  }
}

type ReconcileSnapshot = {
  exists: boolean;
  bytes?: number;
  hash?: string;
  content?: string;
  binary: boolean;
  coverage: "exact" | "partial";
};

function readReconcileSnapshot(
  filePath: string,
  budget: { remaining: number },
): ReconcileSnapshot {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { exists: false, binary: false, coverage: "exact" };
  }
  if (!stat.isFile()) {
    return {
      exists: true,
      bytes: stat.size,
      binary: true,
      coverage: "partial",
    };
  }
  if (
    stat.size > WORKSPACE_RECONCILE_FILE_MAX_BYTES
    || stat.size > budget.remaining
  ) {
    return {
      exists: true,
      bytes: stat.size,
      binary: false,
      coverage: "partial",
    };
  }
  budget.remaining -= stat.size;
  let body: Buffer;
  try {
    body = fs.readFileSync(filePath);
  } catch {
    return {
      exists: true,
      bytes: stat.size,
      binary: false,
      coverage: "partial",
    };
  }
  const binary = body.includes(0);
  const content = !binary && body.length <= WORKSPACE_SNAPSHOT_MAX_CHARS
    ? body.toString("utf8")
    : undefined;
  return {
    exists: true,
    bytes: body.length,
    hash: `sha256:${createHash("sha256").update(body).digest("hex")}`,
    ...(content !== undefined ? { content } : {}),
    binary,
    coverage: "exact",
  };
}

function snapshotDefinitelyChanged(expected: NetChange, current: ReconcileSnapshot): boolean {
  if (expected.afterExists !== current.exists) return true;
  if (!current.exists) return false;
  if (expected.afterHash && current.hash) return expected.afterHash !== current.hash;
  if (expected.afterBytes !== undefined && current.bytes !== undefined) {
    return expected.afterBytes !== current.bytes;
  }
  if (expected.afterContent !== undefined && current.content !== undefined) {
    return expected.afterContent !== current.content;
  }
  return false;
}

function reconciledChange(input: {
  filePath: string;
  beforeExists: boolean;
  beforeHash?: string;
  beforeBytes?: number;
  beforeContent?: string;
  beforeBinary: boolean;
  beforeCoverage: "exact" | "partial";
  current: ReconcileSnapshot;
}): FileChangeObservation {
  const operation = !input.beforeExists && input.current.exists
    ? "create"
    : input.beforeExists && !input.current.exists
      ? "delete"
      : "update";
  const beforeIsExact = !input.beforeExists || !!input.beforeHash;
  const afterIsExact = !input.current.exists || !!input.current.hash;
  return {
    operation,
    sourcePath: input.filePath,
    beforeExists: input.beforeExists,
    afterExists: input.current.exists,
    ...(input.beforeHash ? { beforeHash: input.beforeHash } : {}),
    ...(input.current.hash ? { afterHash: input.current.hash } : {}),
    ...(input.beforeBytes !== undefined ? { beforeBytes: input.beforeBytes } : {}),
    ...(input.current.bytes !== undefined ? { afterBytes: input.current.bytes } : {}),
    ...(input.beforeContent !== undefined ? { beforeContent: input.beforeContent } : {}),
    ...(input.current.content !== undefined ? { afterContent: input.current.content } : {}),
    binary: input.beforeBinary || input.current.binary,
    coverage: input.beforeCoverage === "exact" && input.current.coverage === "exact"
      && beforeIsExact && afterIsExact
      ? "exact"
      : "partial",
  };
}

function latestFileReads(entries: readonly WorkspaceObservationEntry[]): FileReadObservation[] {
  const latest = new Map<string, FileReadObservation>();
  for (const entry of entries) {
    for (const read of entry.fileReads ?? []) {
      const filePath = path.resolve(read.path);
      latest.delete(filePath);
      latest.set(filePath, read);
    }
  }
  return [...latest.values()].slice(-WORKSPACE_RECONCILE_MAX_PATHS);
}

function netChanges(entries: readonly WorkspaceObservationEntry[]): NetChange[] {
  const byCurrentPath = new Map<string, NetChange>();
  const ordered: NetChange[] = [];
  for (const entry of entries) {
    for (const change of entry.fileChanges ?? []) {
      const source = path.resolve(change.sourcePath);
      const destination = path.resolve(change.destinationPath ?? change.sourcePath);
      let net = byCurrentPath.get(source);
      if (!net) {
        net = {
          originalPath: source,
          currentPath: destination,
          beforeExists: change.beforeExists,
          afterExists: change.afterExists,
          beforeHash: change.beforeHash,
          afterHash: change.afterHash,
          beforeBytes: change.beforeBytes,
          afterBytes: change.afterBytes,
          beforeContent: change.beforeContent,
          afterContent: change.afterContent,
          binary: !!change.binary,
          coverage: change.coverage === "partial" ? "partial" : "exact",
          firstSequence: entry.sequence,
          lastSequence: entry.sequence,
        };
        ordered.push(net);
      } else {
        byCurrentPath.delete(net.currentPath);
        net.currentPath = destination;
        net.afterExists = change.afterExists;
        net.afterHash = change.afterHash;
        net.afterBytes = change.afterBytes;
        net.afterContent = change.afterContent;
        net.binary ||= !!change.binary;
        if (change.coverage === "partial") net.coverage = "partial";
        net.lastSequence = entry.sequence;
      }
      byCurrentPath.set(destination, net);
    }
  }
  return ordered;
}

function hasNetChange(change: NetChange): boolean {
  if (change.beforeExists !== change.afterExists) return true;
  if (change.originalPath !== change.currentPath) return true;
  if (change.beforeHash && change.afterHash) return change.beforeHash !== change.afterHash;
  if (change.beforeContent !== undefined && change.afterContent !== undefined) {
    return change.beforeContent !== change.afterContent;
  }
  return true;
}

function changeStatus(change: NetChange): "A" | "M" | "D" | "R" {
  if (!change.beforeExists && change.afterExists) return "A";
  if (change.beforeExists && !change.afterExists) return "D";
  if (change.originalPath !== change.currentPath) return "R";
  return "M";
}

function changeSummary(change: NetChange, workingDir?: string): string {
  const status = changeStatus(change);
  const current = displayPath(change.currentPath, workingDir);
  const from = displayPath(change.originalPath, workingDir);
  const pathText = status === "R" ? `${from} -> ${current}` : current;
  const details = [
    change.binary ? "binary" : "",
    change.beforeBytes !== undefined ? `before=${change.beforeBytes}` : "",
    change.afterBytes !== undefined ? `after=${change.afterBytes}` : "",
    change.coverage === "partial" ? "coverage=partial" : "",
    changeIsStale(change) ? "stale=true" : "",
  ].filter(Boolean);
  return `${status} ${pathText}${details.length ? ` ${details.join(" ")}` : ""}`;
}

function unifiedDiff(change: NetChange, workingDir?: string): string {
  if (change.binary) return "";
  if (change.beforeContent === undefined && change.beforeExists) {
    return `[text diff unavailable for ${displayPath(change.originalPath, workingDir)}; initial snapshot exceeded the bounded ledger]`;
  }
  if (change.afterContent === undefined && change.afterExists) {
    return `[text diff unavailable for ${displayPath(change.currentPath, workingDir)}; final snapshot exceeded the bounded ledger]`;
  }
  const before = change.beforeExists ? (change.beforeContent ?? "") : "";
  const after = change.afterExists ? (change.afterContent ?? "") : "";
  const oldName = change.beforeExists ? `a/${displayPath(change.originalPath, workingDir)}` : "/dev/null";
  const newName = change.afterExists ? `b/${displayPath(change.currentPath, workingDir)}` : "/dev/null";
  const rows = diffRows(before, after);
  const body = renderDiffHunks(rows);
  if (!body) return "";
  return `--- ${oldName}\n+++ ${newName}\n${body}`;
}

function diffRows(before: string, after: string): DiffRow[] {
  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  const cells = (oldLines.length + 1) * (newLines.length + 1);
  const ops = cells <= LCS_MAX_CELLS
    ? lcsOperations(oldLines, newLines)
    : prefixSuffixOperations(oldLines, newLines);
  let oldLine = 1;
  let newLine = 1;
  return ops.map((op) => {
    const row: DiffRow = { kind: op.kind, text: op.text };
    if (op.kind !== "+") row.oldLine = oldLine++;
    if (op.kind !== "-") row.newLine = newLine++;
    return row;
  });
}

function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function lcsOperations(
  oldLines: readonly string[],
  newLines: readonly string[],
): Array<{ kind: " " | "+" | "-"; text: string }> {
  const width = newLines.length + 1;
  const matrix = new Uint32Array((oldLines.length + 1) * width);
  for (let i = oldLines.length - 1; i >= 0; i--) {
    for (let j = newLines.length - 1; j >= 0; j--) {
      matrix[i * width + j] = oldLines[i] === newLines[j]
        ? matrix[(i + 1) * width + j + 1] + 1
        : Math.max(matrix[(i + 1) * width + j], matrix[i * width + j + 1]);
    }
  }
  const out: Array<{ kind: " " | "+" | "-"; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      out.push({ kind: " ", text: oldLines[i] });
      i++;
      j++;
    } else if (
      j < newLines.length
      && (i >= oldLines.length || matrix[i * width + j + 1] >= matrix[(i + 1) * width + j])
    ) {
      out.push({ kind: "+", text: newLines[j++] });
    } else {
      out.push({ kind: "-", text: oldLines[i++] });
    }
  }
  return out;
}

function prefixSuffixOperations(
  oldLines: readonly string[],
  newLines: readonly string[],
): Array<{ kind: " " | "+" | "-"; text: string }> {
  let prefix = 0;
  while (
    prefix < oldLines.length
    && prefix < newLines.length
    && oldLines[prefix] === newLines[prefix]
  ) prefix++;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix
    && suffix < newLines.length - prefix
    && oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]
  ) suffix++;
  return [
    ...oldLines.slice(0, prefix).map((text) => ({ kind: " " as const, text })),
    ...oldLines.slice(prefix, oldLines.length - suffix).map((text) => ({ kind: "-" as const, text })),
    ...newLines.slice(prefix, newLines.length - suffix).map((text) => ({ kind: "+" as const, text })),
    ...oldLines.slice(oldLines.length - suffix).map((text) => ({ kind: " " as const, text })),
  ];
}

function renderDiffHunks(rows: readonly DiffRow[]): string {
  const changed = rows
    .map((row, index) => row.kind === " " ? -1 : index)
    .filter((index) => index >= 0);
  if (!changed.length) return "";
  const ranges: Array<[number, number]> = [];
  for (const index of changed) {
    const start = Math.max(0, index - DIFF_CONTEXT_LINES);
    const end = Math.min(rows.length, index + DIFF_CONTEXT_LINES + 1);
    const prior = ranges[ranges.length - 1];
    if (prior && start <= prior[1]) prior[1] = Math.max(prior[1], end);
    else ranges.push([start, end]);
  }
  const hunks: string[] = [];
  for (const [start, end] of ranges) {
    const slice = rows.slice(start, end);
    const oldStart = slice.find((row) => row.oldLine !== undefined)?.oldLine
      ?? ((rows[start - 1]?.oldLine ?? 0) + 1);
    const newStart = slice.find((row) => row.newLine !== undefined)?.newLine
      ?? ((rows[start - 1]?.newLine ?? 0) + 1);
    const oldCount = slice.filter((row) => row.kind !== "+").length;
    const newCount = slice.filter((row) => row.kind !== "-").length;
    hunks.push(
      `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n`
      + slice.map((row) => `${row.kind}${row.text}`).join("\n"),
    );
  }
  return hunks.join("\n");
}

function normalizePathFilters(values: unknown, workingDir?: string): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .filter((value): value is string => typeof value === "string" && !!value.trim())
    .slice(0, WORKSPACE_DIFF_MAX_PATHS)
    .map((value) => path.resolve(workingDir ?? ".", value));
}

function displayPath(filePath: string, workingDir?: string): string {
  if (!workingDir) return filePath;
  const relative = path.relative(path.resolve(workingDir), filePath);
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)
    ? relative.split(path.sep).join("/")
    : filePath;
}

function samePath(a: string, b: string): boolean {
  return process.platform === "win32"
    ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
    : path.resolve(a) === path.resolve(b);
}

function changeIsStale(change: NetChange): boolean {
  if (!change.afterExists) return fs.existsSync(change.currentPath);
  let stat: fs.Stats;
  try { stat = fs.statSync(change.currentPath); }
  catch { return true; }
  if (!stat.isFile()) return true;
  if (change.afterBytes !== undefined && stat.size !== change.afterBytes) return true;
  if (!change.afterHash || stat.size > STALE_HASH_MAX_BYTES) return false;
  let body: Buffer;
  try { body = fs.readFileSync(change.currentPath); }
  catch { return true; }
  if (change.afterHash) {
    const hash = `sha256:${createHash("sha256").update(body).digest("hex")}`;
    return hash !== change.afterHash;
  }
  return false;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(numberValue)));
}
