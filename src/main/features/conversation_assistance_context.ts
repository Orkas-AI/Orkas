/** Entry guidance for Commander; offer guidance for the final user-facing actor. */
import * as crypto from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as chats from './chats';
import * as projectTasks from './project_tasks';
import { createLogger } from '../logger';
import { prompts } from '../prompts/loader';
import { logErrorSummary } from '../util/log-redact';
import { formatConnectorSetupAssistance } from './connector_setup_context';
import { hasPendingConversationFiling } from './conversation_filing';
import { readState } from './group_chat/state';

const log = createLogger('conversation-assistance');
/** Ids listed per group; counts stay exact beyond this. */
const LISTED_ITEMS = 3;
/** A to-do's first line, cut so a listing cannot grow with the content. */
const TITLE_CHARS = 40;
/** An automation's handoff note reaches the run in full up to this many
 *  characters; the rest stays in the file, which the run can read. */
const HANDOFF_NOTE_CHARS = 2000;
/** Bytes read from the note before cutting: enough for the characters above
 *  in any script, bounded whatever a run wrote. */
const HANDOFF_NOTE_READ_BYTES = 16 * 1024;

type Task = projectTasks.ProjectTask;

function isOpen(task: Task): boolean {
  return task.status !== 'done';
}

function touched(task: Task): string {
  return String(task.updated_at || task.created_at || '');
}

function newestFirst(tasks: readonly Task[]): Task[] {
  return [...tasks].sort((a, b) => touched(b).localeCompare(touched(a)) || a.id.localeCompare(b.id));
}

/** One bounded line of a user-written text: its first non-empty line, flattened
 *  and cut, so a listing can never carry instructions or a long body. */
function boundedTitle(text: string): string {
  const firstLine = String(text || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
  // eslint-disable-next-line no-control-regex
  const flat = firstLine.replace(/[\s\u0000-\u001f\u007f]+/g, ' ').replace(/"/g, "'").trim();
  const chars = [...flat];
  return chars.length > TITLE_CHARS ? `${chars.slice(0, TITLE_CHARS).join('')}…` : flat;
}

/** `t_… "first line"`. */
function itemLabel(task: Task): string {
  const title = boundedTitle(task.content);
  return title ? `${task.id} "${title}"` : task.id;
}

/** A run still open after this long is reported as unfinished: without its
 *  terminal the host cannot tell a crash from a long run, and an hour covers
 *  any ordinary one. */
const UNFINISHED_RUN_AFTER_MS = 60 * 60 * 1000;

/** The enabled automations in scope (every scope outside a project, the
 *  project's own inside one) and, among them, the ones whose last run failed
 *  or never reported an end. Empty when nothing is enabled. */
async function automationFacts(userId: string, projectId?: string): Promise<string> {
  try {
    const autoTasks = await import('./auto_tasks');
    const enabled = (await autoTasks.listTasks(userId, projectId === undefined ? undefined : { projectId }))
      .filter((task) => task.enabled);
    if (!enabled.length) return '';
    const now = Date.now();
    const troubled = enabled.filter((task) => {
      const run = task.last_run;
      if (!run) return false;
      if (run.status === 'failed' || run.status === 'stopped' || run.status === 'unknown') return true;
      return run.status === 'running' && now - Date.parse(run.started_at) > UNFINISHED_RUN_AFTER_MS;
    }).sort((a, b) => String(b.last_run!.started_at).localeCompare(String(a.last_run!.started_at)));
    const listed = troubled.slice(0, LISTED_ITEMS).map((task) => {
      const run = task.last_run!;
      const outcome = run.status === 'running' ? 'did not finish' : run.status;
      const title = boundedTitle(task.title || task.content);
      return `${task.id}${title ? ` "${title}"` : ''} (${outcome}, run started ${run.started_at.slice(0, 16)}Z)`;
    });
    const trouble = troubled.length
      ? ` ${troubled.length} of them failed or did not finish on the last run: ${listed.join(', ')}${troubled.length > listed.length ? ', …' : ''}.`
      : '';
    return ` ${enabled.length} enabled automation(s) run on a schedule.${trouble}`
      + ' List them with `auto_tasks` after loading `management.automation`.';
  } catch (err) {
    log.warn('automations unavailable for turn guidance', { error: logErrorSummary(err) });
    return '';
  }
}

/** Whether the automation facts name a run that needs attention; such a run
 *  is open work even when no to-do is. */
function automationFactsNeedAttention(facts: string): boolean {
  return facts.includes(' of them failed or did not finish on the last run: ');
}

function itemList(tasks: readonly Task[]): string {
  if (!tasks.length) return 'none';
  const listed = tasks.slice(0, LISTED_ITEMS).map(itemLabel);
  return listed.join(', ') + (tasks.length > listed.length ? ', …' : '');
}

/** Dated open items, soonest first, each with its day. */
function dueList(tasks: readonly Task[]): string {
  const dated = [...tasks.filter((task) => task.due_at)].sort(projectTasks.compareDueFirst);
  if (!dated.length) return 'none';
  const listed = dated.slice(0, LISTED_ITEMS).map((task) => `${itemLabel(task)} (due ${task.due_at})`);
  return listed.join(', ') + (dated.length > listed.length ? ', …' : '');
}

/** Open to-dos linked to this conversation, in the conversation's own to-do
 *  scope. Only their count and ids reach a named Agent; content can run to
 *  thousands of characters, so it stays behind `todo_tasks` get. */
async function openTodosGuidance(userId: string, cid: string, projectId: string): Promise<string> {
  let tasks: Task[];
  try {
    tasks = await projectTasks.listTasks(userId, projectId);
  } catch (err) {
    log.warn('open to-dos unavailable for turn guidance', { error: logErrorSummary(err) });
    return '';
  }
  const open = newestFirst(tasks.filter((task) => task.origin_cid === cid && isOpen(task)));
  if (!open.length) return '';
  const listed = open.slice(0, LISTED_ITEMS).map((task) => task.id);
  return prompts.load('conversation_open_todos', {
    count: String(open.length),
    ids: listed.join(', ') + (open.length > listed.length ? ', …' : ''),
  }).trim();
}

/** Non-project Commander turns see global to-dos only. Project backlogs are
 * not scanned or exposed through this conversation's open-work block. */
async function accountOpenWorkGuidance(userId: string, cid: string): Promise<string> {
  let rows: Task[];
  try {
    rows = (await projectTasks.listTasks(userId, '')).filter(isOpen);
  } catch (err) {
    log.warn('global to-dos unavailable for turn guidance', { error: logErrorSummary(err) });
    return '';
  }
  const automation = await automationFacts(userId);
  if (!rows.length && !automationFactsNeedAttention(automation)) return '';
  const review = newestFirst(rows.filter((task) => task.status === 'review'));
  const dated = rows.filter((task) => task.due_at).sort(projectTasks.compareDueFirst);
  const listedIds = new Set([...review.slice(0, LISTED_ITEMS), ...dated.slice(0, LISTED_ITEMS)].map((task) => task.id));
  const recent = newestFirst(rows).filter((task) => !listedIds.has(task.id));
  const fromConversation = newestFirst(rows.filter((task) => task.origin_cid === cid));
  return prompts.load('open_work_account', {
    open_count: String(rows.length),
    review_items: itemList(review),
    due_items: dueList(rows),
    recent_items: itemList(recent),
    conversation_items: itemList(fromConversation),
    automation_facts: automation,
  }).trim();
}

/** Commander inside a project: this project's backlog and automations only,
 *  so the account view is never repeated there. Empty when the backlog has
 *  nothing open and no automation run needs attention. */
async function projectOpenWorkGuidance(userId: string, cid: string, projectId: string): Promise<string> {
  let tasks: Task[];
  try {
    tasks = await projectTasks.listTasks(userId, projectId);
  } catch (err) {
    log.warn('project backlog unavailable for turn guidance', { error: logErrorSummary(err) });
    return '';
  }
  const progress = projectTasks.computeProgress(tasks);
  const automation = await automationFacts(userId, projectId);
  if (!progress.open && !automationFactsNeedAttention(automation)) return '';
  const byId = new Map(tasks.map((task) => [task.id, task]));
  // A missing dependency id cannot hold work back; only an unfinished one does.
  const resolved = (depId: string): boolean => {
    const dep = byId.get(depId);
    return !dep || dep.status === 'done';
  };
  // Dated work leads the backlog order, as it does for the auto-advance loop.
  const next = tasks.filter((task) => task.status === 'todo' && (task.depends_on || []).every(resolved))
    .sort(projectTasks.compareDueFirst);
  const review = newestFirst(tasks.filter((task) => task.status === 'review'));
  const open = tasks.filter((task) => isOpen(task));
  const fromConversation = newestFirst(open.filter((task) => task.origin_cid === cid));
  return prompts.load('open_work_project', {
    todo_count: String(progress.by_status.todo),
    progress_count: String(progress.by_status.progress),
    review_count: String(progress.by_status.review),
    done_count: String(progress.done),
    review_items: itemList(review),
    due_items: dueList(open),
    next_items: itemList(next),
    conversation_items: itemList(fromConversation),
    automation_facts: automation,
  }).trim();
}

/** A fence longer than any run of backticks in the body, so the note's own
 *  fences cannot end the block early. */
function fenced(body: string): string {
  const longest = Math.max(3, ...[...body.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}\n${body}\n${fence}`;
}

/** Evidence that the host put a file's complete text in front of the model,
 *  in the shape the file tools stamp on `read_files`, so the run's first edit
 *  of that file is not refused as unread. */
export interface ReadSeed {
  path: string;
  stamp: { mtimeMs: number; size: number; hash: string };
}

/** The first bytes of the note, decoded; never the whole of a large file.
 *  `hash` is present only when the whole file was read, as the same digest
 *  `edit_file` computes over the decoded text. */
async function readNoteHead(notePath: string): Promise<{
  text: string; changedAt: string; stat: { mtimeMs: number; size: number }; hash?: string;
} | null> {
  let handle: fsp.FileHandle | undefined;
  try {
    handle = await fsp.open(notePath, 'r');
    const stat = await handle.stat();
    const buffer = Buffer.alloc(Math.min(HANDOFF_NOTE_READ_BYTES, Math.max(0, stat.size)));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    const complete = bytesRead === stat.size;
    return {
      text,
      changedAt: stat.mtime.toISOString(),
      stat: { mtimeMs: stat.mtimeMs, size: stat.size },
      ...(complete ? { hash: `sha256:${crypto.createHash('sha256').update(text, 'utf8').digest('hex')}` } : {}),
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('automation handoff note unreadable for turn guidance', { error: logErrorSummary(err) });
    }
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** What an automation run cannot see from its own fresh conversation: which
 *  run it is, how the run before it ended, and the handoff note the task
 *  keeps between runs. Only the conversation the run on record opened gets
 *  it; reopening an older run's conversation later is ordinary chat. */
async function automationRunGuidance(userId: string, cid: string, taskId: string): Promise<{
  guidance: string; readSeed?: ReadSeed;
}> {
  let task: import('./auto_tasks').AutoTask | null;
  let notePath: string;
  try {
    const autoTasks = await import('./auto_tasks');
    task = await autoTasks.getTask(userId, taskId);
    if (!task || task.last_run?.cid !== cid) return { guidance: '' };
    notePath = autoTasks.handoffNotePath(userId, task);
  } catch (err) {
    log.warn('automation run facts unavailable for turn guidance', { error: logErrorSummary(err) });
    return { guidance: '' };
  }
  const previous = task.previous_run;
  const previousRunFacts = !previous
    ? 'This is its first run.'
    : `The previous run started ${previous.started_at} and `
      + `${previous.status === 'running' ? 'did not finish' : `ended with status ${previous.status}`}; `
      + `its conversation id is ${previous.cid}.`;
  let noteState = ' and holds nothing yet.';
  let noteBlock = '';
  let readSeed: ReadSeed | undefined;
  const note = await readNoteHead(notePath);
  const text = note ? note.text.replace(/\r\n/g, '\n').trim() : '';
  if (note && text) {
    const chars = [...text];
    const cut = chars.length > HANDOFF_NOTE_CHARS;
    const body = cut
      ? `${chars.slice(0, HANDOFF_NOTE_CHARS).join('')}\n… [cut; read the file for the rest]`
      : text;
    noteState = ` (last changed ${note.changedAt}):`;
    noteBlock = fenced(body);
    // Only a note the model saw whole counts as read: a cut note still needs
    // the file read before an edit, so unseen tail text is never replaced blind.
    if (!cut && note.hash) readSeed = { path: notePath, stamp: { ...note.stat, hash: note.hash } };
  }
  const guidance = prompts.load('automation_run', {
    run_number: String(task.run_count || 1),
    previous_run_facts: previousRunFacts,
    handoff_path: notePath,
    note_state: noteState,
    note_block: noteBlock,
  }).replace(/\n{3,}/g, '\n\n').trim();
  return { guidance, ...(readSeed ? { readSeed } : {}) };
}

export async function resolveConversationAssistanceForTurn(
  userId: string,
  cid: string,
  delivery: { agentId?: string; outputDelivery?: 'final' | 'process' } = {},
): Promise<{
  kind?: chats.ConversationAssistance['kind'];
  guidance: string;
  /** Files whose complete text the guidance carries, stamped as already read
   *  for this run; absent when nothing was shown whole. */
  readSeeds?: ReadSeed[];
}> {
  const conversation = await chats.getConversationMetadata(userId, cid);
  if (!conversation) return { kind: undefined, guidance: '' };
  const commander = !delivery.agentId;
  // The queue owns intermediate delivery; the ledger also covers subsequent
  // user replies during an interactive handoff with remaining Commander work.
  const ledger = delivery.agentId ? (await readState(userId, cid)).orchestration_ledger : undefined;
  const finalDelivery = delivery.outputDelivery !== 'process'
    && !(ledger && ledger.status !== 'interrupted' && ledger.owner_agent_id === delivery.agentId);
  const assistance = commander ? conversation.assistance : undefined;
  const entryGuidance = assistance?.kind === 'app_creation'
    ? prompts.load('app_creation_guidance').trim()
    : formatConnectorSetupAssistance(assistance);
  // The actor delivering an automation run's result learns which run this
  // is, how the previous one ended and what the task's handoff note holds.
  const automation = conversation.origin_auto_task_id && finalDelivery
    ? await automationRunGuidance(userId, cid, conversation.origin_auto_task_id)
    : { guidance: '' };
  const automationRun = automation.guidance;
  const followUp = finalDelivery ? prompts.load('followup_offer_guidance').trim() : '';
  // Project membership gates only the new-project offer. Recurring work and
  // its consent rules also apply inside a project or during relocation.
  const projectOffer = finalDelivery && !conversation.project_id
    && !hasPendingConversationFiling(userId, cid)
    ? prompts.load('project_offer_guidance').trim()
    : '';
  // Scope must be known before tool selection, including a direct navigation
  // reply with no task tool loaded and no global task snapshot to inject.
  const todoScope = finalDelivery && !conversation.project_id
    ? prompts.load('global_todo_scope').trim()
    : '';
  // Commander alone sees the open-work snapshot: global-only outside a
  // project, the project's own backlog inside one. A conversation an
  // automation created runs one scheduled job and gets no snapshot. The
  // snapshot carries this conversation's own to-dos, so the plain facts block
  // remains only where the snapshot is absent.
  const openWork = commander && finalDelivery && !conversation.origin_auto_task_id
    ? (conversation.project_id
      ? await projectOpenWorkGuidance(userId, cid, conversation.project_id)
      : await accountOpenWorkGuidance(userId, cid))
    : '';
  const openTodos = finalDelivery && !openWork
    ? await openTodosGuidance(userId, cid, conversation.project_id || '')
    : '';
  return {
    kind: assistance?.kind,
    guidance: [
      entryGuidance, automationRun, followUp, projectOffer, todoScope, openWork, openTodos,
    ]
      .filter(Boolean)
      .join('\n\n'),
    ...(automation.readSeed ? { readSeeds: [automation.readSeed] } : {}),
  };
}
