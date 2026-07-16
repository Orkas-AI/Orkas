import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  userRoot,
  userLocalRoot,
  userChatsDir,
  userSessionsDir,
  userChatAttachmentsDir,
  userChatArtifactsDir,
  userAutoTasksDir,
  projectMetaFile,
  projectChatIndexFile,
  projectChatJsonlFile,
  projectGroupChatDir,
  projectSessionFile,
  projectSessionCloudToolResultsDir,
  projectChatAttachmentDir,
  projectChatArtifactCidDir,
  projectAutoTaskDir,
  projectAutoTaskConfigFile,
  projectContextsDir,
  projectLegacyFilesDir,
  userSyncProjectLayoutMovesFile,
} from '../paths';
import { readJsonSync, safeId, writeJsonSync } from '../storage';
import { createLogger } from '../logger';
import { listProjectIds, cloudRelForAbs } from './project-layout';

const log = createLogger('migrate-project-layout-v4');

const MIGRATION_VERSION = 4;
const STALE_LOCK_MS = 10 * 60 * 1000;

export interface ProjectLayoutMigrationStats {
  moved_conversations: number;
  moved_sessions: number;
  moved_attachments: number;
  moved_artifacts: number;
  moved_auto_tasks: number;
  moved_project_files: number;
  move_log_entries: number;
  warnings: string[];
}

export interface ProjectLayoutMigrationOptions {
  /** Ignore the completed marker. Used after sync pulls legacy top-level
   * project paths that could arrive long after the startup migration. */
  force?: boolean;
}

interface MoveLogEntry {
  from: string;
  to: string;
  sha256: string;
  size: number;
}

interface MoveLogFile {
  version: 1;
  migration: 'project-layout-v4';
  created_at: string;
  moves: MoveLogEntry[];
}

function emptyStats(): ProjectLayoutMigrationStats {
  return {
    moved_conversations: 0,
    moved_sessions: 0,
    moved_attachments: 0,
    moved_artifacts: 0,
    moved_auto_tasks: 0,
    moved_project_files: 0,
    move_log_entries: 0,
    warnings: [],
  };
}

function markerFile(uid: string): string {
  return path.join(userLocalRoot(uid), 'migrations', 'project-layout-v4.json');
}

function lockFile(uid: string): string {
  return path.join(userLocalRoot(uid), 'migrations', 'project-layout-v4.lock');
}

function journalFile(uid: string): string {
  return path.join(userLocalRoot(uid), 'migrations', 'project-layout-v4.journal.jsonl');
}

function alreadyApplied(uid: string): boolean {
  // A durable journal means a previous move was interrupted after the file
  // landed but before its sync move log was flushed. Always replay it even
  // when the completed marker exists.
  if (fs.existsSync(journalFile(uid))) return false;
  const marker: any = readJsonSync(markerFile(uid));
  return Number(marker?.version) === MIGRATION_VERSION;
}

function readJsonArray(file: string): any[] {
  const raw: any = readJsonSync(file);
  return Array.isArray(raw) ? raw : (raw && Array.isArray(raw.items) ? raw.items : []);
}

function writeJsonArray(file: string, items: any[]): void {
  writeJsonSync(file, items);
}

function actionMs(row: any): number {
  const candidates = [row?.deleted_at, row?.updated_at, row?.created_at];
  for (const value of candidates) {
    if (typeof value !== 'string' || !value) continue;
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return 0;
}

function mergeConversationRows(existing: any[], incoming: any[]): any[] {
  const byCid = new Map<string, any>();
  for (const row of existing) {
    const cid = typeof row?.conversation_id === 'string' ? row.conversation_id : '';
    if (safeId(cid)) byCid.set(cid, row);
  }
  for (const row of incoming) {
    const cid = typeof row?.conversation_id === 'string' ? row.conversation_id : '';
    if (!safeId(cid)) continue;
    const prev = byCid.get(cid);
    if (!prev || actionMs(row) >= actionMs(prev)) byCid.set(cid, row);
  }
  return Array.from(byCid.values()).sort((a, b) => String(b?.updated_at || '').localeCompare(String(a?.updated_at || '')));
}

function sha256File(file: string): { sha256: string; size: number } | null {
  try {
    const buf = fs.readFileSync(file);
    return { sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length };
  } catch {
    return null;
  }
}

function sameFileContent(a: string, b: string): boolean {
  const ha = sha256File(a);
  const hb = sha256File(b);
  return !!ha && !!hb && ha.size === hb.size && ha.sha256 === hb.sha256;
}

function conflictTarget(uid: string, toAbs: string, sourceHash: string): string {
  const rel = cloudRelForAbs(uid, toAbs).split('/').filter(Boolean);
  if (rel[0] !== 'cloud' || rel[1] !== 'projects' || !safeId(rel[2])) {
    return `${toAbs}.legacy-v4-${sourceHash.slice(0, 8)}`;
  }
  const tail = rel.slice(3);
  const filename = tail.pop() || 'data';
  const ext = path.extname(filename);
  const stem = ext ? filename.slice(0, -ext.length) : filename;
  const conflictName = `${stem}.legacy-v4-${sourceHash.slice(0, 8)}${ext}`;
  return path.join(userRoot(uid), 'cloud', 'projects', rel[2], 'migration_conflicts', ...tail, conflictName);
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return out; }
  for (const entry of entries) {
    const abs = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(abs));
    else if (entry.isFile()) out.push(abs);
  }
  return out;
}

function pruneEmptyDirs(dir: string, stopAt: string): void {
  let cur = dir;
  const stop = path.resolve(stopAt);
  while (path.resolve(cur).startsWith(stop)) {
    if (path.resolve(cur) === stop) break;
    try { fs.rmdirSync(cur); }
    catch { break; }
    cur = path.dirname(cur);
  }
}

function mergeMoveLog(uid: string, entries: MoveLogEntry[]): number {
  if (!entries.length) return 0;
  const file = userSyncProjectLayoutMovesFile(uid);
  const cur = readJsonSync<Partial<MoveLogFile>>(file);
  const byFrom = new Map<string, MoveLogEntry>();
  if (Array.isArray(cur?.moves)) {
    for (const row of cur.moves as MoveLogEntry[]) {
      if (typeof row?.from === 'string' && row.from) byFrom.set(row.from, row);
    }
  }
  for (const row of entries) byFrom.set(row.from, row);
  const next: MoveLogFile = {
    version: 1,
    migration: 'project-layout-v4',
    created_at: typeof cur?.created_at === 'string' && cur.created_at ? cur.created_at : new Date().toISOString(),
    moves: Array.from(byFrom.values()).sort((a, b) => a.from.localeCompare(b.from)),
  };
  writeJsonSync(file, next);
  return entries.length;
}

function moveEntry(uid: string, fromAbs: string, toAbs: string): MoveLogEntry | null {
  const h = sha256File(fromAbs);
  if (!h) return null;
  const from = cloudRelForAbs(uid, fromAbs);
  const to = cloudRelForAbs(uid, toAbs);
  if (!from.startsWith('cloud/') || !to.startsWith('cloud/')) return null;
  return { from, to, ...h };
}

function appendMoveJournal(uid: string, prepared: MoveLogEntry[]): void {
  if (!prepared.length) return;
  const file = journalFile(uid);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeSync(fd, prepared.map((entry) => JSON.stringify(entry)).join('\n') + '\n', null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function readMoveJournal(uid: string): MoveLogEntry[] {
  let raw = '';
  try { raw = fs.readFileSync(journalFile(uid), 'utf8'); }
  catch { return []; }
  const out: MoveLogEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (
        typeof row?.from === 'string'
        && typeof row?.to === 'string'
        && /^[a-f0-9]{64}$/i.test(String(row?.sha256 || ''))
        && Number.isFinite(Number(row?.size))
        && Number(row.size) >= 0
      ) {
        out.push({
          from: row.from,
          to: row.to,
          sha256: String(row.sha256),
          size: Number(row.size),
        });
      }
    } catch { /* ignore a torn final journal line */ }
  }
  return out;
}

function flushMoveJournal(uid: string): number {
  const entries = readMoveJournal(uid);
  if (!entries.length) return 0;
  const count = mergeMoveLog(uid, entries);
  fs.rmSync(journalFile(uid), { force: true });
  return count;
}

function prepareMove(uid: string, entries: MoveLogEntry[], fromAbs: string, toAbs: string): boolean {
  const entry = moveEntry(uid, fromAbs, toAbs);
  if (!entry) return false;
  appendMoveJournal(uid, [entry]);
  entries.push(entry);
  return true;
}

function prepareMoves(
  uid: string,
  entries: MoveLogEntry[],
  pairs: Array<{ fromAbs: string; toAbs: string }>,
): boolean {
  const prepared: MoveLogEntry[] = [];
  for (const pair of pairs) {
    const entry = moveEntry(uid, pair.fromAbs, pair.toAbs);
    if (!entry) return false;
    prepared.push(entry);
  }
  appendMoveJournal(uid, prepared);
  entries.push(...prepared);
  return true;
}

function moveFileTracked(uid: string, fromAbs: string, toAbs: string, entries: MoveLogEntry[], warnings: string[]): boolean {
  if (!fs.existsSync(fromAbs)) return false;
  try {
    const st = fs.statSync(fromAbs);
    if (!st.isFile()) return false;
  } catch {
    return false;
  }
  try {
    fs.mkdirSync(path.dirname(toAbs), { recursive: true });
    if (fs.existsSync(toAbs)) {
      if (sameFileContent(fromAbs, toAbs)) {
        if (!prepareMove(uid, entries, fromAbs, toAbs)) {
          warnings.push(`journal move failed ${cloudRelForAbs(uid, fromAbs)} -> ${cloudRelForAbs(uid, toAbs)}`);
          return false;
        }
        fs.unlinkSync(fromAbs);
        return true;
      }
      const source = sha256File(fromAbs);
      if (!source) return false;
      const preserved = conflictTarget(uid, toAbs, source.sha256);
      fs.mkdirSync(path.dirname(preserved), { recursive: true });
      if (fs.existsSync(preserved) && !sameFileContent(fromAbs, preserved)) {
        warnings.push(`migration conflict target collision ${cloudRelForAbs(uid, preserved)}`);
        return false;
      }
      if (!prepareMove(uid, entries, fromAbs, preserved)) {
        warnings.push(`journal conflict move failed ${cloudRelForAbs(uid, fromAbs)} -> ${cloudRelForAbs(uid, preserved)}`);
        return false;
      }
      if (fs.existsSync(preserved)) fs.unlinkSync(fromAbs);
      else {
        try { fs.renameSync(fromAbs, preserved); }
        catch {
          fs.copyFileSync(fromAbs, preserved);
          fs.unlinkSync(fromAbs);
        }
      }
      warnings.push(`target exists, preserved legacy file at ${cloudRelForAbs(uid, preserved)}`);
      return true;
    }
    if (!prepareMove(uid, entries, fromAbs, toAbs)) {
      warnings.push(`journal move failed ${cloudRelForAbs(uid, fromAbs)} -> ${cloudRelForAbs(uid, toAbs)}`);
      return false;
    }
    try { fs.renameSync(fromAbs, toAbs); }
    catch {
      fs.copyFileSync(fromAbs, toAbs);
      fs.unlinkSync(fromAbs);
    }
    return true;
  } catch (err) {
    warnings.push(`move file failed ${cloudRelForAbs(uid, fromAbs)}: ${(err as Error).message}`);
    return false;
  }
}

function moveDirTracked(uid: string, fromDir: string, toDir: string, entries: MoveLogEntry[], warnings: string[]): number {
  if (!fs.existsSync(fromDir)) return 0;
  let st: fs.Stats;
  try { st = fs.statSync(fromDir); }
  catch { return 0; }
  if (!st.isDirectory()) return 0;

  const files = walkFiles(fromDir);
  if (!files.length) {
    try { fs.mkdirSync(toDir, { recursive: true }); fs.rmdirSync(fromDir); } catch { /* best effort */ }
    return 0;
  }

  let moved = 0;
  if (!fs.existsSync(toDir)) {
    try {
      fs.mkdirSync(path.dirname(toDir), { recursive: true });
      const pairs = files.map((oldFile) => ({
        fromAbs: oldFile,
        toAbs: path.join(toDir, path.relative(fromDir, oldFile)),
      }));
      if (!prepareMoves(uid, entries, pairs)) {
        warnings.push(`journal directory move failed ${cloudRelForAbs(uid, fromDir)} -> ${cloudRelForAbs(uid, toDir)}`);
        return 0;
      }
      fs.renameSync(fromDir, toDir);
      return files.length;
    } catch {
      // Fall back to per-file merge below.
    }
  }

  for (const oldFile of files) {
    const rel = path.relative(fromDir, oldFile);
    const newFile = path.join(toDir, rel);
    if (moveFileTracked(uid, oldFile, newFile, entries, warnings)) moved += 1;
  }
  pruneEmptyDirs(fromDir, fromDir);
  try { fs.rmdirSync(fromDir); } catch { /* best effort */ }
  return moved;
}

function migrateConversation(uid: string, pid: string, cid: string, entries: MoveLogEntry[], stats: ProjectLayoutMigrationStats): void {
  const chatRoot = userChatsDir(uid);
  moveFileTracked(
    uid,
    path.join(chatRoot, `${cid}.jsonl`),
    projectChatJsonlFile(uid, pid, cid),
    entries,
    stats.warnings,
  );
  moveDirTracked(
    uid,
    path.join(chatRoot, cid),
    projectGroupChatDir(uid, pid, cid),
    entries,
    stats.warnings,
  );
  const sessionsRoot = userSessionsDir(uid);
  let sessionEntries: string[] = [];
  try { sessionEntries = fs.readdirSync(sessionsRoot); } catch { sessionEntries = []; }
  for (const name of sessionEntries) {
    const isCommander = name === `gconv-${cid}.jsonl`
      || name === `gconv-${cid}.jsonl.context.json`
      || name === `gconv-${cid}.tool-results`;
    const isMember = name.startsWith(`gmember-${cid}-`) && (
      name.endsWith('.jsonl') || name.endsWith('.jsonl.context.json') || name.endsWith('.tool-results')
    );
    if (!isCommander && !isMember) continue;
    const src = path.join(sessionsRoot, name);
    const sid = name.endsWith('.tool-results')
      ? name.slice(0, -'.tool-results'.length)
      : name.endsWith('.jsonl.context.json')
        ? name.slice(0, -'.jsonl.context.json'.length)
        : name.slice(0, -'.jsonl'.length);
    const dst = name.endsWith('.tool-results')
      ? projectSessionCloudToolResultsDir(uid, pid, sid)
      : name.endsWith('.jsonl.context.json')
        ? `${projectSessionFile(uid, pid, sid)}.context.json`
        : projectSessionFile(uid, pid, sid);
    const moved = fs.existsSync(src) && fs.statSync(src).isDirectory()
      ? moveDirTracked(uid, src, dst, entries, stats.warnings)
      : (moveFileTracked(uid, src, dst, entries, stats.warnings) ? 1 : 0);
    stats.moved_sessions += moved;
  }

  stats.moved_attachments += moveDirTracked(
    uid,
    path.join(userChatAttachmentsDir(uid), cid),
    projectChatAttachmentDir(uid, pid, cid),
    entries,
    stats.warnings,
  );
  stats.moved_artifacts += moveDirTracked(
    uid,
    path.join(userChatArtifactsDir(uid), cid),
    projectChatArtifactCidDir(uid, pid, cid),
    entries,
    stats.warnings,
  );
}

function migrateConversationIndexes(uid: string, entries: MoveLogEntry[], stats: ProjectLayoutMigrationStats): void {
  const globalIndex = path.join(userChatsDir(uid), '_index.json');
  const rows = readJsonArray(globalIndex);
  if (!rows.length) return;

  const byProject = new Map<string, any[]>();
  const globals: any[] = [];
  for (const row of rows) {
    const cid = typeof row?.conversation_id === 'string' ? row.conversation_id : '';
    const pid = typeof row?.project_id === 'string' ? row.project_id : '';
    if (safeId(cid) && safeId(pid) && fs.existsSync(projectMetaFile(uid, pid))) {
      if (!byProject.has(pid)) byProject.set(pid, []);
      byProject.get(pid)!.push(row);
    } else {
      globals.push(row);
    }
  }
  if (!byProject.size) return;

  for (const [pid, projectRows] of byProject) {
    const idx = projectChatIndexFile(uid, pid);
    writeJsonArray(idx, mergeConversationRows(readJsonArray(idx), projectRows));
    for (const row of projectRows) {
      migrateConversation(uid, pid, row.conversation_id, entries, stats);
    }
    stats.moved_conversations += projectRows.length;
  }
  writeJsonArray(globalIndex, globals);
}

function migrateAutoTasks(uid: string, entries: MoveLogEntry[], stats: ProjectLayoutMigrationStats): void {
  let taskDirs: fs.Dirent[] = [];
  try { taskDirs = fs.readdirSync(userAutoTasksDir(uid), { withFileTypes: true }); }
  catch { return; }
  for (const entry of taskDirs) {
    if (!entry.isDirectory()) continue;
    const taskId = entry.name;
    const cfg = path.join(userAutoTasksDir(uid), taskId, 'config.json');
    const raw: any = readJsonSync(cfg);
    const pid = typeof raw?.project_id === 'string' ? raw.project_id : '';
    if (!safeId(pid) || !fs.existsSync(projectMetaFile(uid, pid))) continue;
    const moved = moveDirTracked(
      uid,
      path.join(userAutoTasksDir(uid), taskId),
      projectAutoTaskDir(uid, pid, taskId),
      entries,
      stats.warnings,
    );
    if (moved) stats.moved_auto_tasks += 1;
    if (!fs.existsSync(projectAutoTaskConfigFile(uid, pid, taskId))) {
      stats.warnings.push(`project auto task config missing after move ${taskId}`);
    }
  }
}

function migrateProjectFiles(uid: string, entries: MoveLogEntry[], stats: ProjectLayoutMigrationStats): void {
  for (const pid of listProjectIds(uid)) {
    const moved = moveDirTracked(
      uid,
      projectLegacyFilesDir(uid, pid),
      projectContextsDir(uid, pid),
      entries,
      stats.warnings,
    );
    if (moved) stats.moved_project_files += moved;
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function lockIsActive(file: string): boolean {
  const raw: any = readJsonSync(file);
  const pid = Number(raw?.pid) || 0;
  if (pid && processIsAlive(pid)) return true;
  try {
    return Date.now() - fs.statSync(file).mtimeMs < STALE_LOCK_MS && !pid;
  } catch {
    return false;
  }
}

function acquireMigrationLock(uid: string): number | null {
  const file = lockFile(uid);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, started_at_ms: Date.now() }), null, 'utf8');
      fs.fsyncSync(fd);
      return fd;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      if (lockIsActive(file)) return null;
      try { fs.rmSync(file, { force: true }); }
      catch { return null; }
    }
  }
  return null;
}

export function migrateProjectLayoutV4(
  uid: string,
  opts: ProjectLayoutMigrationOptions = {},
): ProjectLayoutMigrationStats {
  const stats = emptyStats();
  if (!safeId(uid)) return stats;
  if (!opts.force && alreadyApplied(uid)) return stats;

  fs.mkdirSync(path.dirname(markerFile(uid)), { recursive: true });
  const fd = acquireMigrationLock(uid);
  if (fd === null) return stats;

  const moves: MoveLogEntry[] = [];
  try {
    stats.move_log_entries += flushMoveJournal(uid);
    migrateConversationIndexes(uid, moves, stats);
    migrateAutoTasks(uid, moves, stats);
    migrateProjectFiles(uid, moves, stats);
    stats.move_log_entries += flushMoveJournal(uid);
    writeJsonSync(markerFile(uid), {
      version: MIGRATION_VERSION,
      migrated_at: new Date().toISOString(),
      stats,
    });
    if (moves.length || stats.warnings.length) {
      log.info('project layout v4 migration complete', {
        uid,
        moved_conversations: stats.moved_conversations,
        moved_sessions: stats.moved_sessions,
        moved_attachments: stats.moved_attachments,
        moved_artifacts: stats.moved_artifacts,
        moved_auto_tasks: stats.moved_auto_tasks,
        moved_project_files: stats.moved_project_files,
        move_log_entries: stats.move_log_entries,
        warnings: stats.warnings.length,
      });
    }
  } catch (err) {
    stats.warnings.push((err as Error).message);
    log.warn('project layout v4 migration failed', { uid, error: (err as Error).message });
  } finally {
    try { stats.move_log_entries += flushMoveJournal(uid); }
    catch (err) { stats.warnings.push(`flush move journal failed: ${(err as Error).message}`); }
    try { fs.closeSync(fd); } catch { /* best effort */ }
    try { fs.unlinkSync(lockFile(uid)); } catch { /* best effort */ }
  }
  return stats;
}
