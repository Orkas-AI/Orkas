/**
 * Relocate one conversation's bytes between the unprojected root and a project.
 *
 * Project membership is a storage location, not a field: messages, the group
 * companion dir, the commander and per-agent sessions, attachments and
 * artifacts all live under `cloud/projects/<pid>/` once a conversation belongs
 * to a project. The set moved here is the same set the boot migration moves
 * (`migrate-project-layout-v4.ts::migrateConversation`), which is the only
 * other code in the app that relocates a conversation.
 *
 * Either direction is the same prefix rewrite between `cloud/` and
 * `cloud/projects/<pid>/`: both layouts use the same file names, so the pair
 * list is built once from the two roots and oriented by `direction`. Filing a
 * conversation is what the picker and the model-facing tool do; unfiling is how
 * an automatic filing stays reversible.
 *
 * A local write-ahead record precedes every runtime move. An explicit commit
 * marker follows the index/meta writes; activation rolls back uncommitted
 * records before layout repair or ghost cleanup can interpret partial state.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  projectChatArtifactCidDir,
  projectChatAttachmentDir,
  projectChatJsonlFile,
  projectGroupChatDir,
  projectSessionsDir,
  userChatArtifactsDir,
  userChatAttachmentsDir,
  userChatsDir,
  userRoot,
  userConversationMovesDir,
  projectChatIndexFile,
  userSessionsDir,
} from '../paths';
import { createLogger } from '../logger';
import { safeId, writeJsonSync } from '../storage';
import { logErrorSummary, maskId } from './log-redact';
import { cloudRelForAbs, invalidateConversationProjectCache, setConversationRelocationBlocked } from './project-layout';

const log = createLogger('conversation-relocate');

/** A sync domain plus the paths that changed inside it. */
export interface RelocatedPaths {
  domain: 'chats' | 'sessions' | 'chat_attachments' | 'chat_artifacts';
  /** Cloud-relative path the bytes left. */
  from: string;
  /** Cloud-relative path the bytes now occupy. */
  to: string;
  /** File-level old paths: sync manifests do not contain directory entries. */
  files: string[];
}

interface Pair {
  domain: RelocatedPaths['domain'];
  src: string;
  dst: string;
}

/** Session sidecars share a stem, so each is matched by its own suffix. */
const SESSION_SUFFIXES = ['.jsonl', '.jsonl.context.json', '.tool-results'] as const;

/** `into` files a loose conversation under a project; `out` returns it to the
 *  unprojected root. */
export type RelocationDirection = 'into' | 'out';

/**
 * Every source/destination pair for `cid`, whether or not the source exists.
 * Enumerating the session directory is the truth source: `members.json` can
 * already be gone or stale, which is what leaked orphan member sessions in the
 * delete path before it started globbing too. The session directory to
 * enumerate is the one the bytes currently sit in.
 */
function relocationPairs(
  uid: string,
  cid: string,
  pid: string,
  direction: RelocationDirection,
): Pair[] {
  const chatRoot = userChatsDir(uid);
  const both: { domain: Pair['domain']; root: string; project: string }[] = [
    { domain: 'chats', root: path.join(chatRoot, `${cid}.jsonl`), project: projectChatJsonlFile(uid, pid, cid) },
    { domain: 'chats', root: path.join(chatRoot, cid), project: projectGroupChatDir(uid, pid, cid) },
  ];

  const sessionsRoot = direction === 'into' ? userSessionsDir(uid) : projectSessionsDir(uid, pid);
  let names: string[] = [];
  try { names = fs.readdirSync(sessionsRoot); } catch { names = []; }
  const commanderStem = `gconv-${cid}`;
  const memberPrefix = `gmember-${cid}-`;
  for (const name of names) {
    const owned = name === `${commanderStem}.jsonl`
      || name === `${commanderStem}.jsonl.context.json`
      || name === `${commanderStem}.tool-results`
      || (name.startsWith(memberPrefix) && SESSION_SUFFIXES.some((suffix) => name.endsWith(suffix)));
    if (!owned) continue;
    both.push({
      domain: 'sessions',
      root: path.join(userSessionsDir(uid), name),
      project: path.join(projectSessionsDir(uid, pid), name),
    });
  }

  both.push({
    domain: 'chat_attachments',
    root: path.join(userChatAttachmentsDir(uid), cid),
    project: projectChatAttachmentDir(uid, pid, cid),
  });
  both.push({
    domain: 'chat_artifacts',
    root: path.join(userChatArtifactsDir(uid), cid),
    project: projectChatArtifactCidDir(uid, pid, cid),
  });
  return both.map(({ domain, root, project }) => direction === 'into'
    ? { domain, src: root, dst: project }
    : { domain, src: project, dst: root });
}

function moveOne(pair: Pair): boolean {
  if (!fs.existsSync(pair.src)) return false;
  // A destination that already exists means an earlier interrupted move, or a
  // cid collision inside the project. Either way the caller must not silently
  // merge two conversations' bytes.
  if (fs.existsSync(pair.dst)) {
    throw new Error(`conversation relocate: destination already exists (${path.basename(pair.dst)})`);
  }
  fs.mkdirSync(path.dirname(pair.dst), { recursive: true });
  fs.renameSync(pair.src, pair.dst);
  return true;
}

/**
 * Move every byte of `cid` between the root and `pid` and report what changed,
 * so the caller can tell sync which paths were retired and which appeared.
 * Throws with the filesystem left as it was found.
 */
function relocateConversation(
  uid: string,
  cid: string,
  pid: string,
  direction: RelocationDirection,
  original?: Record<string, unknown>,
): RelocatedPaths[] {
  const pairs = relocationPairs(uid, cid, pid, direction);
  const files = new Map<Pair, string[]>();
  const collect = (file: string, out: string[]): void => {
    let stat: fs.Stats;
    try { stat = fs.lstatSync(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(file, { withFileTypes: true })) {
        const child = path.join(file, entry.name);
        if (entry.isDirectory()) collect(child, out);
        else if (entry.isFile()) out.push(cloudRelForAbs(uid, child));
      }
    } else if (stat.isFile()) out.push(cloudRelForAbs(uid, file));
  };
  // Keep discovery and rename in one non-yielding section after the idle check.
  // Read directory names only, without per-file stats, symlinks or payload hashes.
  for (const pair of pairs) {
    const leaves: string[] = [];
    collect(pair.src, leaves);
    files.set(pair, leaves);
  }
  // Check every destination before publishing a journal: a pre-existing
  // destination is not ours to roll back, even if a later source is absent.
  const planned = pairs.filter(pair => fs.existsSync(pair.src));
  for (const pair of pairs) {
    if (fs.existsSync(pair.dst)) throw new Error('Conversation move destination conflict');
  }
  if (original) {
    const file = journalPath(uid, cid);
    if (fs.existsSync(file)) {
      // A `prepared` record is an interrupted move whose rollback has not run;
      // moving again would strand it. A `committed` record is only the receipt
      // sync has not consumed yet, and with sync disabled it is never consumed,
      // so an undo must not be blocked by it: the receipt written here
      // supersedes it, and the consumer already skips a retired path whose
      // source is back on disk. An unreadable record fails closed.
      let superseded = false;
      try { superseded = readJournal(uid, cid).phase === 'committed'; }
      catch { superseded = false; }
      if (!superseded) throw new Error('Conversation move recovery is pending');
    }
    persistJournal(uid, {
      // A record an older build cannot interpret must be rejected outright, not
      // rolled back the wrong way, so the reverse direction carries version 2.
      ...(direction === 'into' ? { version: 1 as const } : { version: 2 as const, direction }),
      cid, pid, phase: 'prepared', original,
      moved: planned.map(pair => ({ domain: pair.domain, from: cloudRelForAbs(uid, pair.src),
        to: cloudRelForAbs(uid, pair.dst), files: files.get(pair)! })),
    });
  }
  const done: Pair[] = [];
  try {
    for (const pair of pairs) {
      if (moveOne(pair)) done.push(pair);
    }
  } catch (err) {
    for (const pair of done.reverse()) {
      // Best effort: the throw below reports the original failure, and a
      // rollback that cannot complete leaves evidence in the log rather than
      // masking why the move was refused.
      try {
        fs.mkdirSync(path.dirname(pair.src), { recursive: true });
        fs.renameSync(pair.dst, pair.src);
      } catch { /* reported by the caller's error path */ }
    }
    throw err;
  }
  return done.map((pair) => ({
    domain: pair.domain,
    from: cloudRelForAbs(uid, pair.src),
    to: cloudRelForAbs(uid, pair.dst),
    files: files.get(pair)!,
  }));
}

/** File a loose conversation under `pid`. */
export function relocateConversationIntoProject(
  uid: string,
  cid: string,
  pid: string,
  original?: Record<string, unknown>,
): RelocatedPaths[] {
  return relocateConversation(uid, cid, pid, 'into', original);
}

/** Return a conversation from `pid` to the unprojected root. */
export function relocateConversationOutOfProject(
  uid: string,
  cid: string,
  pid: string,
  original?: Record<string, unknown>,
): RelocatedPaths[] {
  return relocateConversation(uid, cid, pid, 'out', original);
}

interface MoveJournal {
  /** 1 is the original filing record and carries no `direction`; 2 adds it. */
  version: 1 | 2;
  cid: string;
  pid: string;
  direction?: RelocationDirection;
  phase: 'prepared' | 'committed';
  original: Record<string, unknown>;
  moved: RelocatedPaths[];
}

function journalDirection(journal: MoveJournal): RelocationDirection {
  return journal.direction === 'out' ? 'out' : 'into';
}

function journalPath(uid: string, cid: string): string {
  return path.join(userConversationMovesDir(uid), `${cid}.json`);
}

function persistJournal(uid: string, journal: MoveJournal): void {
  const file = journalPath(uid, journal.cid);
  writeJsonSync(file, journal);
  const fd = fs.openSync(file, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function readJournal(uid: string, cid: string): MoveJournal {
  const journal = JSON.parse(fs.readFileSync(journalPath(uid, cid), 'utf8')) as MoveJournal;
  const direction = journalDirection(journal);
  // The version pins the direction: a filing record stays exactly what earlier
  // builds wrote, and an unfiling record is unreadable to them.
  const versionMatchesDirection = direction === 'into' ? journal.version === 1 : journal.version === 2;
  // The row a rollback restores must belong where the bytes came from.
  const originMatches = direction === 'into'
    ? !journal.original?.project_id
    : journal.original?.project_id === journal.pid;
  if (!versionMatchesDirection || journal.cid !== cid || !safeId(cid) || !safeId(journal.pid)
    || !['prepared', 'committed'].includes(journal.phase)
    || journal.original?.conversation_id !== cid || !originMatches
    || !Array.isArray(journal.moved)) throw new Error('Invalid conversation move recovery record');
  const sourcePrefix = direction === 'into' ? 'cloud/' : `cloud/projects/${journal.pid}/`;
  const targetPrefix = direction === 'into' ? `cloud/projects/${journal.pid}/` : 'cloud/';
  const roots: Record<RelocatedPaths['domain'], string[]> = {
    chats: [`${sourcePrefix}chats/${cid}`, `${sourcePrefix}chats/${cid}.jsonl`],
    sessions: [],
    chat_attachments: [`${sourcePrefix}chat_attachments/${cid}`],
    chat_artifacts: [`${sourcePrefix}chat_artifacts/${cid}`],
  };
  const sessionPrefix = `${sourcePrefix}sessions/`;
  const seen = new Set<string>();
  for (const item of journal.moved) {
    if (!item || typeof item.from !== 'string') throw new Error('Invalid conversation move recovery paths');
    const from = item.from;
    const name = from.startsWith(sessionPrefix) ? from.slice(sessionPrefix.length) : '';
    const session = item.domain === 'sessions' && from.startsWith(sessionPrefix)
      && !name.includes('/') && !name.includes('\\') && !name.includes('..')
      && SESSION_SUFFIXES.some(suffix => name === `gconv-${cid}${suffix}`
        || (name.startsWith(`gmember-${cid}-`) && name.endsWith(suffix)));
    if ((!session && !roots[item.domain]?.includes(from)) || seen.has(from)
      || !from.startsWith(sourcePrefix)
      || item.to !== `${targetPrefix}${from.slice(sourcePrefix.length)}`
      || !Array.isArray(item.files) || !item.files.every(file => typeof file === 'string'
        && (file === from || file.startsWith(`${from}/`))
        && !file.split('/').some(part => part === '..' || part === '.' || !part)
        && !file.includes('\\'))) throw new Error('Invalid conversation move recovery paths');
    seen.add(from);
  }
  return journal;
}

function journalIds(uid: string): string[] {
  try {
    return fs.readdirSync(userConversationMovesDir(uid))
      .filter(name => name.endsWith('.json') && safeId(name.slice(0, -5)))
      .map(name => name.slice(0, -5));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** The commit marker is the transaction boundary, independent of sync availability. */
export function commitConversationRelocation(uid: string, cid: string): void {
  const journal = readJournal(uid, cid);
  persistJournal(uid, { ...journal, phase: 'committed' });
}

function readIndexStrict(file: string): Record<string, unknown>[] {
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const rows = Array.isArray(raw) ? raw : (raw as { items?: unknown })?.items;
  if (!Array.isArray(rows)) throw new Error('Invalid conversation index during recovery');
  return rows;
}

/** Idempotent rollback, including partial index commits. Never replace an
 * existing source with destination bytes or discard an unreadable index. */
export function recoverConversationRelocation(uid: string, cid: string): void {
  if (!fs.existsSync(journalPath(uid, cid))) { setConversationRelocationBlocked(uid, cid, false); return; }
  setConversationRelocationBlocked(uid, cid, true);
  const journal = readJournal(uid, cid);
  if (journal.phase === 'committed') { setConversationRelocationBlocked(uid, cid, false); return; }
  const root = userRoot(uid);
  for (const item of journal.moved) {
    const source = fs.existsSync(path.join(root, item.from));
    const target = fs.existsSync(path.join(root, item.to));
    if (source === target) throw new Error('Conversation recovery needs attention; both copies were preserved');
  }
  const globalIndex = path.join(userChatsDir(uid), '_index.json');
  const projectIndex = projectChatIndexFile(uid, journal.pid);
  const globalRows = readIndexStrict(globalIndex).filter(row => row.conversation_id !== cid);
  const projectRows = readIndexStrict(projectIndex).filter(row => row.conversation_id !== cid);
  for (const item of [...journal.moved].reverse()) {
    const from = path.join(root, item.from);
    const to = path.join(root, item.to);
    if (!fs.existsSync(to)) continue;
    fs.mkdirSync(path.dirname(from), { recursive: true });
    fs.renameSync(to, from);
  }
  // Restore the row and its meta where the bytes came from; the other index
  // loses it. Bytes alone do not carry ownership.
  if (journalDirection(journal) === 'into') {
    writeJsonSync(path.join(userChatsDir(uid), cid, 'meta.json'), journal.original);
    writeJsonSync(globalIndex, [journal.original, ...globalRows]);
    writeJsonSync(projectIndex, projectRows);
  } else {
    writeJsonSync(path.join(projectGroupChatDir(uid, journal.pid, cid), 'meta.json'), journal.original);
    writeJsonSync(projectIndex, [journal.original, ...projectRows]);
    writeJsonSync(globalIndex, globalRows);
  }
  invalidateConversationProjectCache(uid, cid);
  fs.unlinkSync(journalPath(uid, cid));
  setConversationRelocationBlocked(uid, cid, false);
}

/** Run before any activation migration or consumer sees the partial indexes. */
export function recoverConversationRelocations(uid: string): number {
  let failed = 0;
  for (const cid of journalIds(uid)) {
    try { recoverConversationRelocation(uid, cid); }
    catch (err) {
      failed++;
      log.warn('conversation move recovery failed', { cid: maskId(cid), ...logErrorSummary(err) });
    }
  }
  return failed;
}

/** A move whose recovery could not settle: a both-copies conflict left the
 * journal `prepared`, or the record cannot be read by this version. Both its
 * source and target trees stay out of sync until the conversation is resolved
 * locally; every other path of the account keeps syncing. */
export interface UnresolvedRelocation {
  cid: string;
  /** Exact cloud-relative file paths. */
  exact: string[];
  /** Cloud-relative prefixes; a path is covered when it starts with one. */
  prefixes: string[];
}

function _unresolvedFromJournal(journal: MoveJournal): UnresolvedRelocation {
  const exact: string[] = [];
  const prefixes: string[] = [];
  for (const item of journal.moved) {
    exact.push(item.from, item.to);
    prefixes.push(`${item.from}/`, `${item.to}/`);
  }
  return { cid: journal.cid, exact, prefixes };
}

/** An unreadable record still names its conversation in the file name; the
 * target project is used only when the record exposes a well-formed id. */
function _unresolvedByCid(uid: string, cid: string): UnresolvedRelocation {
  let pid = '';
  try {
    const raw = JSON.parse(fs.readFileSync(journalPath(uid, cid), 'utf8')) as { pid?: unknown };
    if (safeId(raw?.pid)) pid = raw.pid as string;
  } catch { /* unreadable record: exclude the global roots only */ }
  const exact: string[] = [];
  const prefixes: string[] = [];
  for (const root of pid ? ['cloud', `cloud/projects/${pid}`] : ['cloud']) {
    exact.push(`${root}/chats/${cid}.jsonl`);
    for (const suffix of SESSION_SUFFIXES) exact.push(`${root}/sessions/gconv-${cid}${suffix}`);
    prefixes.push(`${root}/chats/${cid}/`, `${root}/chat_attachments/${cid}/`, `${root}/chat_artifacts/${cid}/`,
      `${root}/sessions/gconv-${cid}.tool-results/`, `${root}/sessions/gmember-${cid}-`);
  }
  return { cid, exact, prefixes };
}

export function matchesUnresolvedRelocation(unresolved: UnresolvedRelocation[], relPath: string): boolean {
  return unresolved.some(item => item.exact.includes(relPath) || item.prefixes.some(prefix => relPath.startsWith(prefix)));
}

/** Durable sync intents survive disabled sync and repeated process restarts.
 * Reading these never unlinks a source that another device may have restored,
 * and never throws: an unresolved journal is reported, not raised, so one
 * conflicted conversation cannot stop the account's sync. */
export function readConversationRelocationJournals(uid: string): {
  committed: RelocatedPaths[];
  unresolved: UnresolvedRelocation[];
} {
  const committed: RelocatedPaths[] = [];
  const unresolved: UnresolvedRelocation[] = [];
  let ids: string[];
  try { ids = journalIds(uid); }
  catch (err) {
    log.warn('conversation move journals unreadable', logErrorSummary(err));
    return { committed, unresolved };
  }
  for (const cid of ids) {
    let journal: MoveJournal;
    try { journal = readJournal(uid, cid); }
    catch (err) {
      log.warn('conversation move journal invalid; excluded from sync', { cid: maskId(cid), ...logErrorSummary(err) });
      unresolved.push(_unresolvedByCid(uid, cid));
      continue;
    }
    if (journal.phase === 'committed') committed.push(...journal.moved);
    else unresolved.push(_unresolvedFromJournal(journal));
  }
  return { committed, unresolved };
}

export function committedConversationRelocations(uid: string): RelocatedPaths[] {
  return readConversationRelocationJournals(uid).committed;
}

/** Called only for old paths whose remote deletion/absence was confirmed. */
export function consumeConversationRelocationPaths(uid: string, settled: Set<string>): void {
  if (!settled.size) return;
  for (const cid of journalIds(uid)) {
    let journal: MoveJournal;
    try { journal = readJournal(uid, cid); }
    catch { continue; /* reported by readConversationRelocationJournals */ }
    if (journal.phase !== 'committed') continue;
    let changed = false;
    for (const item of journal.moved) {
      const files = item.files.filter(file => !settled.has(file));
      if (files.length !== item.files.length) changed = true;
      item.files = files;
    }
    if (!changed) continue;
    if (journal.moved.every(item => !item.files.length)) fs.unlinkSync(journalPath(uid, cid));
    else persistJournal(uid, journal);
  }
}
