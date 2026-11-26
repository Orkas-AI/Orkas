/**
 * "Since the user was last here": what changed in a project that the user has
 * not seen yet (Common/docs/plans/commander-project-continuity.md §3.3).
 *
 * Computed from existing state only (to-dos, their result notes and status
 * times, automation runs) and the times this device last showed the user the
 * project's changes. There is no event log. One function serves the project
 * page and the project Commander, so both show the same facts.
 *
 * A change the user has already seen is not news: one made in the
 * conversation they are in, a status they set themselves in the app, or
 * anything before the last time they were shown the project's changes. The
 * page and Commander keep separate records: a reply that told the user stops
 * Commander repeating it but leaves it on the page until the page shows it,
 * and Commander leaves out what the page has shown. With no record (first
 * open, just upgraded) the window is the last 7 days, so an upgrade does not
 * replay weeks of old work.
 *
 * Stored times have one-second resolution, so a digest covers the whole
 * seconds before it was computed and a seen record is that boundary. A
 * change in the current second waits for the next digest: recording this one
 * as seen can neither hide that change nor show it twice.
 *
 * Shared projects are left as they are in this version: their to-dos carry no
 * notes or status times yet.
 */
import { projectRecapStateFile } from '../paths';
import { localIsoAt, readJson, writeJson } from '../storage';
import * as projectTasks from './project_tasks';
import { createLogger } from '../logger';
import { fileEditLock } from '../util/locks';
import { logErrorSummary, maskId } from '../util/log-redact';

const log = createLogger('project-recap');

const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Items listed per group and in all; counts stay exact. */
export const RECAP_GROUP_ITEMS = 3;
export const RECAP_TOTAL_ITEMS = 8;
const TITLE_CHARS = 40;
const NOTE_CHARS = 60;
/** A run still open after this long is reported as unfinished, as the
 *  open-work facts do: without its terminal a crash and a long run look alike. */
const UNFINISHED_RUN_AFTER_MS = 60 * 60 * 1000;

/** Lines in priority order; the first two share the "stuck" group's budget. */
export type RecapLine = 'stuck' | 'started' | 'review' | 'done' | 'automation_failed' | 'automation_unfinished' | 'added';
const LINE_ORDER: readonly RecapLine[] = ['stuck', 'started', 'review', 'done', 'automation_failed', 'automation_unfinished', 'added'];
const LINE_GROUP: Record<RecapLine, string> = {
  stuck: 'stuck', started: 'stuck', review: 'review', done: 'done',
  automation_failed: 'automation', automation_unfinished: 'automation', added: 'added',
};

export interface RecapItem {
  kind: 'task' | 'automation';
  id: string;
  /** First line of the content or the automation title, unbounded here. */
  text: string;
  /** Result note to show with it, when there is one for this line. */
  note?: string;
  /** When the change happened: local ISO for to-dos, the run's own stamp for automations. */
  at: string;
  /** The conversation to open for it, when there is one. */
  cid?: string;
}

export interface ProjectRecap {
  /** Start of the window: when this surface last showed the changes (for
   *  Commander, the later of its own record and the page's), or 7 days ago. */
  since: string;
  /** When this digest was computed, to the second; it covers changes before
   *  this time, and acknowledging it records this time. */
  computed_at: string;
  /** A change in the current second waits for the next digest. */
  settling: boolean;
  /** Every item per line, newest first; `listed` says which ones are shown. */
  lines: Record<RecapLine, RecapItem[]>;
  /** The items within the per-group and total bounds, in priority order. */
  listed: Array<{ line: RecapLine; items: RecapItem[] }>;
  total: number;
}

function ms(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : NaN;
}

/** When the to-do's current status began. Records from before status times
 *  fall back to the closest stamp they have. */
function statusTime(task: projectTasks.ProjectTask): string {
  return task.status_changed_at || (task.status === 'done' ? task.done_at : undefined) || task.updated_at || task.created_at;
}

function newestFirst(items: RecapItem[]): RecapItem[] {
  return items.sort((a, b) => (ms(b.at) || 0) - (ms(a.at) || 0) || a.id.localeCompare(b.id));
}

// ── Seen records (machine-private, never synced) ────────────────────────────

export type RecapSurface = 'page' | 'commander';
const SURFACES: readonly RecapSurface[] = ['page', 'commander'];

/** When each surface last showed the user the project's changes. */
type SeenRecord = Partial<Record<RecapSurface, string>>;

async function readSeenRecord(uid: string, pid: string): Promise<SeenRecord> {
  try {
    const raw = await readJson<Record<string, unknown>>(projectRecapStateFile(uid, pid));
    const record: SeenRecord = {};
    for (const surface of SURFACES) {
      const value = raw[`${surface}_seen_at`];
      if (typeof value === 'string' && Number.isFinite(Date.parse(value))) record[surface] = value;
    }
    return record;
  } catch {
    return {};
  }
}

/** When this surface last showed the user the project's changes. */
export async function readSeenAt(uid: string, pid: string, surface: RecapSurface): Promise<string | null> {
  return (await readSeenRecord(uid, pid))[surface] ?? null;
}

export interface RecapCounts { stuck: number; review: number; done: number; automation: number; added: number }

export function recapCounts(recap: ProjectRecap): RecapCounts {
  const count = (...lines: RecapLine[]) => lines.reduce((sum, line) => sum + recap.lines[line].length, 0);
  return {
    stuck: count('stuck', 'started'),
    review: count('review'),
    done: count('done'),
    automation: count('automation_failed', 'automation_unfinished'),
    added: count('added'),
  };
}

/**
 * Record that this surface showed the user the project's changes up to
 * `seenAt`. Each record only moves forward, so an older digest acknowledged
 * late cannot bring back changes the user has since been shown.
 */
export async function markProjectRecapSeen(
  uid: string, pid: string, seenAt: string, surface: RecapSurface, counts?: RecapCounts,
): Promise<boolean> {
  // Never ahead of the clock: a future record would hide every later change.
  const at = Math.min(ms(seenAt), Date.now());
  if (!Number.isFinite(at)) return false;
  const file = projectRecapStateFile(uid, pid);
  // One update at a time, so neither surface writes over the other's time.
  const moved = await fileEditLock(file).runExclusive(async () => {
    const project = await (await import('./projects')).getProject(uid, pid);
    // A stale page or late turn must not recreate a deleted local project.
    if (!project) return false;
    const record = await readSeenRecord(uid, pid);
    const previous = record[surface];
    if (previous && ms(previous) >= at) return false;
    record[surface] = localIsoAt(at);
    try {
      // Never markDirty: local/ is machine-private and must never sync.
      await writeJson(file, Object.fromEntries(SURFACES.filter((key) => record[key]).map((key) => [`${key}_seen_at`, record[key]])));
      return true;
    } catch (error) {
      log.warn('seen record write failed', { pid: maskId(pid), error: logErrorSummary(error) });
      // Keep an actual persistence failure distinct from an idempotent no-op;
      // the visible page can acknowledge it on its next look. No disk path
      // or underlying exception text crosses the IPC boundary.
      throw new Error('project_recap_seen_write_failed');
    }
  });
  if (!moved) return false;
  return true;
}

// ── Shown by a Commander turn, seen once that turn is delivered ────────────

/** The digest a Commander turn carried. */
export interface ShownRecap { projectId: string; computed_at: string; counts: RecapCounts }

/** Digests shown by the current run of a conversation, until that run ends. */
const _shown = new Map<string, ShownRecap & { turnId?: string }>();
let _subscribed = false;

function _shownKey(uid: string, cid: string): string {
  return `${uid}\0${cid}`;
}

/** Whether a turn of this conversation's current run already told the user. The host can
 *  put the same turn together again when its request never reached the model; that turn
 *  has told the user nothing yet, so it still carries the digest. */
export function recapShownInCurrentRun(uid: string, cid: string, turnId?: string): boolean {
  const shown = _shown.get(_shownKey(uid, cid));
  return !!shown && !(turnId && shown.turnId === turnId);
}

/**
 * Called once the turn carrying the digest is assembled. Commander's record
 * moves when that run ends with its reply delivered; a failed, stopped or
 * cancelled run leaves the changes unseen, so the next turn reports them again.
 */
export function noteRecapShown(uid: string, cid: string, shown: ShownRecap, turnId?: string): void {
  _shown.set(_shownKey(uid, cid), turnId ? { ...shown, turnId } : shown);
  if (_subscribed) return;
  try {
    // Lazy: the bus pulls in the whole conversation runtime.
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const bus = require('./group_chat/bus') as typeof import('./group_chat/bus');
    bus.subscribeTaskTerminals((event) => {
      const key = _shownKey(event.user_id, event.conversation_id);
      const recap = _shown.get(key);
      if (!recap) return;
      _shown.delete(key);
      if (event.status !== 'completed' && event.status !== 'waiting_input') return;
      void markProjectRecapSeen(event.user_id, recap.projectId, recap.computed_at, 'commander', recap.counts)
        .catch((error) => log.warn('seen record update failed', { error: logErrorSummary(error) }));
    });
    _subscribed = true;
  } catch (error) {
    log.warn('turn terminal subscription unavailable', { error: logErrorSummary(error) });
  }
}

// ── Digest ──────────────────────────────────────────────────────────────────

export interface RecapOptions {
  /** Who shows it. The page lists what it has not shown; Commander also leaves
   *  out what the page has shown. */
  surface: RecapSurface;
  /** The conversation the user is in: its own changes are already in front of them. */
  excludeCid?: string;
  /** Computation time; defaults to now. */
  now?: number;
  /** Lists the caller already read for this turn, so they are not read twice. */
  tasks?: projectTasks.ProjectTask[];
  automations?: import('./auto_tasks').AutoTask[];
  /** Window start the project page already showed in this visit, so a refresh
   *  keeps listing what it listed instead of dropping what is now seen. */
  since?: string;
  /** Whether a conversation still has a turn in flight; defaults to the conversation runtime. */
  isRunning?: (cid: string) => boolean;
}

/** Whether a conversation still has a turn in flight. In-memory only. */
function conversationRunning(uid: string, cid: string): boolean {
  try {
    // Lazy: the bus pulls in the whole conversation runtime.
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const bus = require('./group_chat/bus') as typeof import('./group_chat/bus');
    return !bus.isQuiescent(uid, cid);
  } catch {
    return false;
  }
}

export async function computeProjectRecap(uid: string, pid: string, opts: RecapOptions): Promise<ProjectRecap> {
  const now = opts.now ?? Date.now();
  const second = (at: number) => Math.floor(at / 1000) * 1000;
  const coveredMs = second(now);
  const pinned = opts.since !== undefined ? ms(opts.since) : NaN;
  let seenMs = NaN;
  if (!Number.isFinite(pinned)) {
    const record = await readSeenRecord(uid, pid);
    const seen = [record.page, opts.surface === 'commander' ? record.commander : undefined].map(ms).filter(Number.isFinite);
    if (seen.length) seenMs = Math.max(...seen);
  }
  const sinceMs = Number.isFinite(pinned) ? Math.min(pinned, coveredMs)
    : Number.isFinite(seenMs) ? Math.min(seenMs, coveredMs) : second(now - DEFAULT_WINDOW_MS);
  let settling = false;
  const fresh = (value: string | undefined): boolean => {
    const at = ms(value);
    if (!Number.isFinite(at) || at < sinceMs) return false;
    if (at < coveredMs) return true;
    if (at <= now) settling = true;
    return false;
  };
  const lines = Object.fromEntries(LINE_ORDER.map((line) => [line, [] as RecapItem[]])) as Record<RecapLine, RecapItem[]>;

  let tasks = opts.tasks;
  if (!tasks) {
    try { tasks = await projectTasks.listTasks(uid, pid); }
    catch (error) {
      log.warn('backlog unavailable for recap', { pid: maskId(pid), error: logErrorSummary(error) });
      tasks = [];
    }
  }
  for (const task of tasks) {
    // Its last change happened where the user is now: it runs there, or a tool
    // call there created it or set its status or note.
    if (opts.excludeCid && (task.origin_cid === opts.excludeCid || task.last_change_cid === opts.excludeCid)) continue;
    const item = (at: string, note?: string): RecapItem => ({
      kind: 'task', id: task.id, text: task.content, at,
      ...(note ? { note } : {}), ...(task.origin_cid ? { cid: task.origin_cid } : {}),
    });
    const resultNote = task.note && task.note_kind !== 'blocker' ? task.note : undefined;
    const open = task.status === 'todo' || task.status === 'progress';
    if (open && task.note && task.note_kind === 'blocker') {
      if (fresh(task.updated_at)) lines.stuck.push(item(task.updated_at, task.note));
      continue;
    }
    if (task.status_changed_by === 'user') continue;
    const changedAt = statusTime(task);
    if (task.status === 'progress') {
      // Still in hand while the conversation it is linked to runs, or the one that last
      // set its status: work picked up again elsewhere keeps its first link.
      const inHand = (cid?: string) => !!cid && (opts.isRunning ? opts.isRunning(cid) : conversationRunning(uid, cid));
      if (!task.note && task.origin_cid && fresh(changedAt) && !inHand(task.origin_cid) && !inHand(task.last_change_cid)) {
        lines.started.push(item(changedAt));
      }
      continue;
    }
    if (task.status === 'review') {
      if (fresh(changedAt)) lines.review.push(item(changedAt, resultNote));
      continue;
    }
    if (task.status === 'done') {
      if (fresh(changedAt)) lines.done.push(item(changedAt, resultNote));
      continue;
    }
    if (task.created_by !== 'user' && fresh(task.created_at)) lines.added.push(item(task.created_at));
  }

  try {
    const automations = opts.automations ?? await (await import('./auto_tasks')).listTasks(uid, { projectId: pid });
    for (const task of automations) {
      const run = task.last_run;
      if (!run || (opts.excludeCid && run.cid === opts.excludeCid) || !fresh(run.started_at)) continue;
      const item: RecapItem = { kind: 'automation', id: task.id, text: task.title || task.content, at: run.started_at, cid: run.cid };
      if (run.status === 'failed') lines.automation_failed.push(item);
      else if (run.status === 'unknown' || (run.status === 'running' && now - ms(run.started_at) > UNFINISHED_RUN_AFTER_MS)) {
        lines.automation_unfinished.push(item);
      }
    }
  } catch (error) {
    log.warn('automations unavailable for recap', { pid: maskId(pid), error: logErrorSummary(error) });
  }

  for (const line of LINE_ORDER) newestFirst(lines[line]);
  const listed: ProjectRecap['listed'] = [];
  const usedByGroup = new Map<string, number>();
  let used = 0;
  for (const line of LINE_ORDER) {
    const group = LINE_GROUP[line];
    const room = Math.min(RECAP_GROUP_ITEMS - (usedByGroup.get(group) || 0), RECAP_TOTAL_ITEMS - used);
    const items = lines[line].slice(0, Math.max(0, room));
    usedByGroup.set(group, (usedByGroup.get(group) || 0) + items.length);
    used += items.length;
    if (lines[line].length) listed.push({ line, items });
  }
  return {
    since: localIsoAt(sinceMs),
    computed_at: localIsoAt(coveredMs),
    settling,
    lines,
    listed,
    total: LINE_ORDER.reduce((sum, line) => sum + lines[line].length, 0),
  };
}

// ── Model-facing lines (appendix A.1) ───────────────────────────────────────

/** One bounded line of untrusted text: first non-empty line, flattened, cut. */
function bounded(text: string | undefined, max: number, firstLine: boolean): string {
  const source = String(text || '');
  const picked = firstLine ? source.split(/\r?\n/).map((part) => part.trim()).find(Boolean) || '' : source;
  // eslint-disable-next-line no-control-regex
  const flat = picked.replace(/[\s\u0000-\u001f\u007f]+/g, ' ').replace(/"/g, "'").trim();
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : flat;
}

function ago(at: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - ms(at)) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

const LINE_LABEL: Record<RecapLine, string> = {
  stuck: 'Stuck',
  started: 'Started but not finished',
  review: "Awaiting the user's review",
  done: 'Done',
  automation_failed: 'Automation failed on its last run',
  automation_unfinished: 'Automation did not finish its last run',
  added: 'Added',
};

function renderItem(line: RecapLine, item: RecapItem, now: number): string {
  if (line === 'added') return item.id;
  const title = bounded(item.text, TITLE_CHARS, true);
  const label = title ? `${item.id} "${title}"` : item.id;
  const note = item.note ? `, note: "${bounded(item.note, NOTE_CHARS, false)}"` : '';
  switch (line) {
    case 'started': return `${label} (its run ended without an update)`;
    case 'review': return `${label} (${ago(item.at, now)})${note}`;
    case 'automation_failed':
    case 'automation_unfinished': return `${label} (run started ${item.at.slice(0, 16).replace('T', ' ')}Z)`;
    default: return `${label}${note}`;
  }
}

/** The `$change_lines` of the Commander block; empty when nothing is new. */
export function formatRecapLines(recap: ProjectRecap): string {
  const now = ms(recap.computed_at);
  return recap.listed.map(({ line, items }) => {
    const count = `- ${LINE_LABEL[line]} (${recap.lines[line].length})`;
    return items.length ? `${count}: ${items.map((item) => renderItem(line, item, now)).join('; ')}` : count;
  }).join('\n');
}

/** `YYYY-MM-DD HH:MM` local, as the to-do times are written. */
export function formatRecapSince(recap: ProjectRecap): string {
  return recap.since.slice(0, 16).replace('T', ' ');
}
