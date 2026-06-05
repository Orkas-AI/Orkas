/**
 * Global local recycle bin.
 *
 * Destructive changes to the cloud/ tree are archived here before unlink:
 *   - cloud-sync tombstones pulled from another device
 *   - in-app deletes triggered by the local UI
 *
 * The archive is machine-private (`<uid>/local/recycle/`) and never syncs or
 * expires automatically; the user decides when to restore or delete a batch.
 * Batches store both files and relationship metadata so restores can
 * rehydrate index rows such as conversation → project membership.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { createLogger } from '../logger';
import { projectMetaFile, userCloudRoot, userRecycleDir, userSyncRecycleDir } from '../paths';
import { safeId, writeJson } from '../storage';
import { t } from '../i18n';
import {
  CLAUSE_RE, EN_FILLER_RE, TITLE_MAX, ZH_FILLER_RE,
} from '../util/auto-title';
import {
  logErrorRef,
  logPathRef,
  logPathRefs,
  maskId,
} from '../util/log-redact';

const log = createLogger('recycle');
const META_FILE = 'batch.json';
const FILES_DIR = 'files';
const PREVIEW_LIMIT = 5;
const MAX_CLOUD_REL_PATH = 1024;
const MAX_DISPLAY_TEXT_BYTES = 512 * 1024;
const BATCH_ID_RE = /^[A-Za-z0-9_.-]+$/;

export type RecycleSource = 'cloud_sync' | 'app';
export type RecycleReason = 'remote_tombstone' | 'app_delete';
export type RecycleKind =
  | 'conversation'
  | 'conversations'
  | 'project'
  | 'auto_task'
  | 'attachment'
  | 'context'
  | 'project_file'
  | 'saved_app'
  | 'agent'
  | 'skill'
  | 'workspace'
  | 'other';
export type RecycleDisplayCategory =
  | 'conversation'
  | 'edit_conversation'
  | 'auto_task'
  | 'project'
  | 'project_file'
  | 'attachment'
  | 'artifact'
  | 'context'
  | 'saved_app'
  | 'agent'
  | 'skill'
  | 'memory'
  | 'settings'
  | 'marketplace'
  | 'file'
  | 'other';

export interface RecycleItem {
  path: string;
  size: number;
}

export interface RecycleDisplayItem {
  category: RecycleDisplayCategory;
  title: string;
  detail?: string;
  id?: string;
  path?: string;
}

export interface RecycleMetadata {
  chat_index_rows?: Record<string, any>[];
  project_rows?: Record<string, any>[];
}

export interface RecycleBatch {
  id: string;
  reason: RecycleReason;
  source: RecycleSource;
  kind?: RecycleKind;
  label?: string;
  created_at_ms: number;
  /** Legacy metadata from the old time-based cleanup model. New batches set 0. */
  expires_at_ms: number;
  items: RecycleItem[];
  total_bytes: number;
  paths_preview: string[];
  display_items?: RecycleDisplayItem[];
  display_title?: string;
  metadata?: RecycleMetadata;
}

export type SyncRecycleItem = RecycleItem;
export type SyncRecycleMetadata = RecycleMetadata;
export type SyncRecycleBatch = RecycleBatch;

function hashForRecycleLog(value: unknown): string {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12);
}

function isSafeRecycleBatchId(value: unknown): value is string {
  return typeof value === 'string' && BATCH_ID_RE.test(value);
}

function logBatchId(batchId: unknown): string {
  if (isSafeRecycleBatchId(batchId)) return batchId;
  return `<invalid:${hashForRecycleLog(batchId)}>`;
}

function logRecycleErrorRef(err: unknown): Record<string, unknown> {
  const ref = logErrorRef(err);
  const message = typeof ref.message === 'string' ? ref.message : '';
  return {
    name: ref.name,
    code: ref.code,
    status: ref.status,
    message_hash: message ? hashForRecycleLog(message) : undefined,
  };
}

function logMetadataCounts(metadata: SyncRecycleMetadata | undefined): Record<string, number> {
  return {
    chat_index_rows: metadata?.chat_index_rows?.length || 0,
    project_rows: metadata?.project_rows?.length || 0,
  };
}

function logDisplayCategoryCounts(displayItems: RecycleDisplayItem[] | undefined): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of displayItems || []) {
    counts[item.category] = (counts[item.category] || 0) + 1;
  }
  return counts;
}

function logRecycleBatchRef(batch: SyncRecycleBatch): Record<string, unknown> {
  return {
    batch_id: logBatchId(batch.id),
    source: batch.source,
    reason: batch.reason,
    kind: batch.kind,
    item_count: batch.items.length,
    total_bytes: batch.total_bytes,
    paths: logPathRefs(batch.items.map((it) => it.path)),
    metadata: logMetadataCounts(batch.metadata),
    display_categories: logDisplayCategoryCounts(batch.display_items),
  };
}

export function isSafeCloudRelPath(relPath: unknown): relPath is string {
  if (typeof relPath !== 'string' || !relPath) return false;
  if (relPath.length > MAX_CLOUD_REL_PATH) return false;
  if (!relPath.startsWith('cloud/')) return false;
  if (relPath.includes('\\') || relPath.includes('\0')) return false;
  const parts = relPath.split('/');
  if (parts.length < 2) return false;
  for (const part of parts) {
    if (!part || part === '.' || part === '..') return false;
    if (/^[A-Za-z]:/.test(part)) return false;
  }
  return true;
}

export function assertSafeCloudRelPath(relPath: string): string {
  if (!isSafeCloudRelPath(relPath)) {
    throw new Error('unsafe recycle path');
  }
  return relPath;
}

export function resolveCloudRelPath(root: string, relPath: string): string {
  assertSafeCloudRelPath(relPath);
  const base = path.resolve(root);
  const child = relPath.slice('cloud/'.length).split('/').join(path.sep);
  const abs = path.resolve(base, child);
  const rel = path.relative(base, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('unsafe recycle path');
  }
  return abs;
}

function batchDir(uid: string, batchId: string): string {
  if (!isSafeRecycleBatchId(batchId)) throw new Error('invalid recycle batch id');
  return path.join(userRecycleDir(uid), batchId);
}

function batchMetaFile(uid: string, batchId: string): string {
  return path.join(batchDir(uid, batchId), META_FILE);
}

function recycleFileAbs(uid: string, batchId: string, relPath: string): string {
  return resolveCloudRelPath(path.join(batchDir(uid, batchId), FILES_DIR), relPath);
}

async function migrateLegacySyncRecycle(uid: string): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(userSyncRecycleDir(uid), { withFileTypes: true });
  } catch {
    return;
  }
  if (!entries.length) return;
  log.info('legacy sync recycle migration started', {
    user_id: maskId(uid),
    candidates: entries.filter((entry) => entry.isDirectory()).length,
  });
  await fsp.mkdir(userRecycleDir(uid), { recursive: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!isSafeRecycleBatchId(entry.name)) continue;
    const src = path.join(userSyncRecycleDir(uid), entry.name);
    let dest = path.join(userRecycleDir(uid), entry.name);
    if (fs.existsSync(dest)) {
      dest = path.join(userRecycleDir(uid), `${entry.name}-sync`);
      if (fs.existsSync(dest)) {
        log.warn('legacy sync recycle migration skipped duplicate batch', {
          user_id: maskId(uid),
          batch_id: logBatchId(entry.name),
        });
        continue;
      }
    }
    try {
      await fsp.rename(src, dest);
      const metaFile = path.join(dest, META_FILE);
      try {
        const raw = JSON.parse(await fsp.readFile(metaFile, 'utf-8'));
        if (raw && typeof raw === 'object') {
          raw.source = 'cloud_sync';
          raw.reason = 'remote_tombstone';
          await fsp.writeFile(metaFile, JSON.stringify(raw, null, 2));
        }
      } catch { /* malformed legacy metadata can still be ignored by list */ }
      log.info('legacy sync recycle batch migrated', {
        user_id: maskId(uid),
        batch_id: logBatchId(entry.name),
      });
    } catch (err: any) {
      log.warn('legacy sync recycle migrate failed', {
        user_id: maskId(uid),
        batch_id: logBatchId(entry.name),
        error: logRecycleErrorRef(err),
      });
    }
  }
}

function chatJsonlCid(relPath: string): string | null {
  const m = /^cloud\/chats\/([^/]+)\.jsonl$/.exec(relPath);
  const cid = m?.[1] || '';
  return safeId(cid) ? cid : null;
}

function editConversationRootFromRelPath(relPath: string): { kind: 'agent' | 'skill'; id: string } | null {
  const chat = /^cloud\/chats\/(agent|skill)\/([^/]+)\//.exec(relPath);
  if (chat && safeId(chat[2])) return { kind: chat[1] as 'agent' | 'skill', id: chat[2] };
  const session = /^cloud\/sessions\/(agent|skill)-(.+)\.jsonl$/.exec(relPath);
  if (session && safeId(session[2])) return { kind: session[1] as 'agent' | 'skill', id: session[2] };
  return null;
}

function projectRootDeletedId(relPath: string): string | null {
  const m = /^cloud\/projects\/([^/]+)\/project\.json$/.exec(relPath);
  const pid = m?.[1] || '';
  return safeId(pid) ? pid : null;
}

function autoTaskRootDeletedId(relPath: string): string | null {
  const m = /^cloud\/auto_tasks\/([^/]+)\/config\.json$/.exec(relPath);
  const taskId = m?.[1] || '';
  return safeId(taskId) ? taskId : null;
}

function chatCidFromRelPath(relPath: string): string | null {
  const jsonlCid = chatJsonlCid(relPath);
  if (jsonlCid) return jsonlCid;
  const m = /^cloud\/chats\/([^/]+)\//.exec(relPath);
  const cid = m?.[1] || '';
  return safeId(cid) && cid !== 'agent' && cid !== 'skill' ? cid : null;
}

function projectIdFromRelPath(relPath: string): string | null {
  const m = /^cloud\/projects\/([^/]+)\//.exec(relPath);
  const pid = m?.[1] || '';
  return safeId(pid) ? pid : null;
}

function autoTaskIdFromRelPath(relPath: string): string | null {
  const m = /^cloud\/auto_tasks\/([^/]+)\//.exec(relPath);
  const taskId = m?.[1] || '';
  return safeId(taskId) ? taskId : null;
}

async function collectCloudFilesUnder(uid: string, relDir: string): Promise<string[]> {
  const safeRelDir = relDir.replace(/\/+$/, '');
  if (!isSafeCloudRelPath(`${safeRelDir}/__probe__`)) return [];
  const root = userCloudRoot(uid);
  const out: string[] = [];
  async function walk(absDir: string, relPrefix: string): Promise<void> {
    let entries: fs.Dirent[] = [];
    try { entries = await fsp.readdir(absDir, { withFileTypes: true }); }
    catch { return; }
    await Promise.all(entries.map(async (entry) => {
      const childAbs = path.join(absDir, entry.name);
      const childRel = `${relPrefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(childAbs, childRel);
      } else if (entry.isFile() && isSafeCloudRelPath(childRel)) {
        out.push(childRel);
      }
    }));
  }
  try {
    const abs = resolveCloudRelPath(root, relDir);
    const st = await fsp.stat(abs);
    if (!st.isDirectory()) return [];
    await walk(abs, safeRelDir);
  } catch {
    return [];
  }
  return out;
}

async function collectCloudFilesMatching(uid: string, relDir: string, predicate: (name: string) => boolean): Promise<string[]> {
  const safeRelDir = relDir.replace(/\/+$/, '');
  if (!isSafeCloudRelPath(`${safeRelDir}/__probe__`)) return [];
  let entries: fs.Dirent[] = [];
  try {
    const abs = resolveCloudRelPath(userCloudRoot(uid), safeRelDir);
    entries = await fsp.readdir(abs, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && predicate(entry.name))
    .map((entry) => `${safeRelDir}/${entry.name}`)
    .filter(isSafeCloudRelPath);
}

export async function collectCloudEntryFiles(uid: string, relPath: string): Promise<string[]> {
  if (!isSafeCloudRelPath(relPath)) return [];
  try {
    const abs = resolveCloudRelPath(userCloudRoot(uid), relPath);
    const st = await fsp.stat(abs);
    if (st.isFile()) return [relPath];
    if (st.isDirectory()) return collectCloudFilesUnder(uid, relPath);
  } catch {
    return [];
  }
  return [];
}

async function expandRecycleRelPaths(uid: string, relPaths: string[]): Promise<string[]> {
  const out = new Set(relPaths.filter(isSafeCloudRelPath));
  const cids = new Set<string>();
  const projectIds = new Set<string>();
  const autoTaskIds = new Set<string>();
  for (const relPath of out) {
    const cid = chatJsonlCid(relPath);
    if (cid) cids.add(cid);
    const pid = projectRootDeletedId(relPath);
    if (pid) projectIds.add(pid);
    const taskId = autoTaskRootDeletedId(relPath);
    if (taskId) autoTaskIds.add(taskId);
  }

  for (const cid of cids) {
    for (const relDir of [
      `cloud/chats/${cid}`,
      `cloud/chat_attachments/${cid}`,
      `cloud/chat_artifacts/${cid}`,
    ]) {
      for (const relPath of await collectCloudFilesUnder(uid, relDir)) out.add(relPath);
    }
    const commanderSession = `cloud/sessions/gconv-${cid}.jsonl`;
    if ((await collectCloudEntryFiles(uid, commanderSession)).length) out.add(commanderSession);
    for (const relPath of await collectCloudFilesMatching(
      uid,
      'cloud/sessions',
      (name) => name.startsWith(`gmember-${cid}-`) && name.endsWith('.jsonl'),
    )) out.add(relPath);
  }
  for (const pid of projectIds) {
    for (const relPath of await collectCloudFilesUnder(uid, `cloud/projects/${pid}`)) out.add(relPath);
  }
  for (const taskId of autoTaskIds) {
    for (const relPath of await collectCloudFilesUnder(uid, `cloud/auto_tasks/${taskId}`)) out.add(relPath);
  }
  return Array.from(out);
}

function normalizeMetadata(raw: any): SyncRecycleMetadata | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const chatIndexRows = Array.isArray(raw.chat_index_rows)
    ? raw.chat_index_rows
      .filter((row: any) => row && typeof row === 'object' && safeId(row.conversation_id))
      .map((row: any) => {
        const copy = { ...row };
        delete copy.deleted_at;
        return copy;
      })
    : [];
  const projectRows = Array.isArray(raw.project_rows)
    ? raw.project_rows.filter((row: any) => row && typeof row === 'object' && safeId(row.project_id))
    : [];
  if (!chatIndexRows.length && !projectRows.length) return undefined;
  return {
    ...(chatIndexRows.length ? { chat_index_rows: chatIndexRows } : {}),
    ...(projectRows.length ? { project_rows: projectRows } : {}),
  };
}

async function readJsonObject(file: string): Promise<Record<string, any> | null> {
  try {
    const raw = JSON.parse(await fsp.readFile(file, 'utf-8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  } catch {
    return null;
  }
}

function cleanTitle(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function titleFromJson(obj: unknown, keys: string[]): string {
  if (!obj || typeof obj !== 'object') return '';
  for (const key of keys) {
    const title = cleanTitle((obj as Record<string, unknown>)[key]);
    if (title) return title;
  }
  return '';
}

function basenameFromRelPath(relPath: string): string {
  const clean = String(relPath || '').replace(/\\/g, '/').replace(/^cloud\//, '');
  return path.basename(clean) || clean || 'file';
}

function compactDetail(parts: Array<string | undefined | null>): string | undefined {
  const text = parts.map(cleanTitle).filter(Boolean).join(' · ');
  return text || undefined;
}

async function readTextIfSmall(file: string): Promise<string | null> {
  try {
    const st = await fsp.stat(file);
    if (!st.isFile() || st.size > MAX_DISPLAY_TEXT_BYTES) return null;
    return await fsp.readFile(file, 'utf-8');
  } catch {
    return null;
  }
}

function parseJsonText(text: string | null): Record<string, any> | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function readRecycleText(uid: string, batchId: string | undefined, relPath: string): Promise<string | null> {
  if (!batchId || !isSafeCloudRelPath(relPath)) return null;
  try {
    return await readTextIfSmall(recycleFileAbs(uid, batchId, relPath));
  } catch {
    return null;
  }
}

async function readCloudText(uid: string, relPath: string): Promise<string | null> {
  if (!isSafeCloudRelPath(relPath)) return null;
  try {
    return await readTextIfSmall(resolveCloudRelPath(userCloudRoot(uid), relPath));
  } catch {
    return null;
  }
}

async function readDisplayText(uid: string, batchId: string | undefined, relPath: string): Promise<string | null> {
  return await readRecycleText(uid, batchId, relPath)
    ?? await readCloudText(uid, relPath);
}

async function readDisplayJson(uid: string, batchId: string | undefined, relPath: string): Promise<Record<string, any> | null> {
  return parseJsonText(await readDisplayText(uid, batchId, relPath));
}

function parseSkillName(text: string | null, fallback: string): string {
  if (!text || !text.startsWith('---')) return fallback;
  const end = text.indexOf('---', 3);
  if (end === -1) return fallback;
  for (const line of text.slice(3, end).split('\n')) {
    const m = /^name\s*:\s*(.+)$/.exec(line.trim());
    if (!m) continue;
    let value = m[1].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return cleanTitle(value.replace(/\\"/g, '"').replace(/''/g, "'")) || fallback;
  }
  return fallback;
}

function metadataChatTitle(metadata: SyncRecycleMetadata | undefined, cid: string): string {
  const row = (metadata?.chat_index_rows || [])
    .find((item) => item && item.conversation_id === cid);
  return titleFromJson(row, ['title']);
}

function metadataProjectTitle(metadata: SyncRecycleMetadata | undefined, pid: string): string {
  const row = (metadata?.project_rows || [])
    .find((item) => item && item.project_id === pid);
  return titleFromJson(row, ['name', 'title']);
}

async function chatJsonlTitle(uid: string, batchId: string | undefined, cid: string): Promise<string> {
  const text = await readDisplayText(uid, batchId, `cloud/chats/${cid}.jsonl`);
  if (!text) return '';
  let firstUserText = '';
  let firstText = '';
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg: any;
    try { msg = JSON.parse(trimmed); } catch { continue; }
    const msgText = textFromMessage(msg).trim();
    if (!firstText && msgText) firstText = msgText;
    const from = typeof msg?.from === 'string' ? msg.from : (typeof msg?.role === 'string' ? msg.role : '');
    if (!firstUserText && from === 'user' && msgText) firstUserText = msgText;
    if (firstUserText) break;
  }
  return firstUserText || firstText ? titleFromText(firstUserText || firstText) : '';
}

async function conversationTitle(
  uid: string,
  batchId: string | undefined,
  metadata: SyncRecycleMetadata | undefined,
  cid: string,
): Promise<string> {
  if (!cid) return '';
  const fromMetadata = metadataChatTitle(metadata, cid);
  if (fromMetadata) return fromMetadata;
  const meta = await readDisplayJson(uid, batchId, `cloud/chats/${cid}/meta.json`);
  return titleFromJson(meta, ['title'])
    || await chatJsonlTitle(uid, batchId, cid)
    || cid;
}

async function projectTitle(
  uid: string,
  batchId: string | undefined,
  metadata: SyncRecycleMetadata | undefined,
  pid: string,
): Promise<string> {
  if (!pid) return '';
  return metadataProjectTitle(metadata, pid)
    || titleFromJson(await readDisplayJson(uid, batchId, `cloud/projects/${pid}/project.json`), ['name', 'title'])
    || pid;
}

async function autoTaskTitle(uid: string, batchId: string | undefined, taskId: string): Promise<string> {
  if (!taskId) return '';
  const cfg = await readDisplayJson(uid, batchId, `cloud/auto_tasks/${taskId}/config.json`);
  return titleFromJson(cfg, ['title'])
    || cleanTitle(typeof cfg?.content === 'string' ? cfg.content.split(/\r?\n/, 1)[0] : '')
    || taskId;
}

async function agentTitle(uid: string, batchId: string | undefined, agentId: string): Promise<string> {
  if (!agentId) return '';
  const obj = await readDisplayJson(uid, batchId, `cloud/agents/${agentId}/agent.json`);
  return titleFromJson(obj, ['name']) || agentId;
}

async function skillTitle(uid: string, batchId: string | undefined, skillId: string): Promise<string> {
  if (!skillId) return '';
  const md = await readDisplayText(uid, batchId, `cloud/skills/${skillId}/SKILL.md`);
  return parseSkillName(md, skillId);
}

async function savedAppTitle(uid: string, batchId: string | undefined, appId: string): Promise<string> {
  if (!appId) return '';
  const obj = await readDisplayJson(uid, batchId, `cloud/saved_apps/${appId}/__orkas-meta.json`);
  return titleFromJson(obj, ['title']) || appId;
}

async function artifactTitle(uid: string, batchId: string | undefined, cid: string, artifactId: string): Promise<string> {
  if (!cid || !artifactId) return '';
  const obj = await readDisplayJson(uid, batchId, `cloud/chat_artifacts/${cid}/${artifactId}/__orkas-meta.json`);
  return titleFromJson(obj, ['title']) || artifactId;
}

function normalizeDisplayItems(raw: any): RecycleDisplayItem[] {
  if (!Array.isArray(raw)) return [];
  const categories = new Set<RecycleDisplayCategory>([
    'conversation', 'edit_conversation', 'auto_task', 'project',
    'project_file', 'attachment', 'artifact', 'context', 'saved_app',
    'agent', 'skill', 'memory', 'settings', 'marketplace', 'file', 'other',
  ]);
  const out: RecycleDisplayItem[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const category = categories.has(item.category) ? item.category as RecycleDisplayCategory : 'other';
    const title = cleanTitle(item.title);
    if (!title) continue;
    const detail = cleanTitle(item.detail);
    const id = cleanTitle(item.id);
    const relPath = isSafeCloudRelPath(item.path) ? item.path : undefined;
    const key = `${category}\0${id || relPath || title}\0${detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      category,
      title,
      ...(detail ? { detail } : {}),
      ...(id ? { id } : {}),
      ...(relPath ? { path: relPath } : {}),
    });
  }
  return out;
}

function displayItemObjectId(item: RecycleDisplayItem, category: 'agent' | 'skill'): string {
  if (item.category !== category) return '';
  const fromId = cleanTitle(item.id);
  if (safeId(fromId)) return fromId;
  const m = new RegExp(`^cloud/${category}s/([^/]+)/`).exec(item.path || '');
  if (m?.[1] && safeId(m[1])) return m[1];
  const fromTitle = cleanTitle(item.title);
  return safeId(fromTitle) ? fromTitle : '';
}

function associatedEditTarget(item: RecycleDisplayItem): { kind: 'agent' | 'skill'; id: string } | null {
  if (item.category === 'edit_conversation') {
    const m = /^(agent|skill):(.+)$/.exec(item.id || '');
    if (m?.[2] && safeId(m[2])) return { kind: m[1] as 'agent' | 'skill', id: m[2] };
  }
  if (item.category === 'conversation') {
    const raw = cleanTitle(item.id) || cleanTitle(item.title) || basenameFromRelPath(item.path || '');
    const m = /^(agent|skill)-(.+)\.jsonl$/.exec(raw);
    if (m?.[2] && safeId(m[2])) return { kind: m[1] as 'agent' | 'skill', id: m[2] };
  }
  return null;
}

function collapseAssociatedDisplayItems(items: RecycleDisplayItem[]): RecycleDisplayItem[] {
  const agentIds = new Set<string>();
  const skillIds = new Set<string>();
  for (const item of items) {
    const agentId = displayItemObjectId(item, 'agent');
    if (agentId) agentIds.add(agentId);
    const skillId = displayItemObjectId(item, 'skill');
    if (skillId) skillIds.add(skillId);
  }
  return items.filter((item) => {
    const target = associatedEditTarget(item);
    if (!target) return true;
    return target.kind === 'skill' ? !skillIds.has(target.id) : !agentIds.has(target.id);
  });
}

function collapseSupplementalDisplayItems(items: RecycleDisplayItem[]): RecycleDisplayItem[] {
  const supplemental = new Set<RecycleDisplayCategory>(['file', 'settings', 'marketplace', 'other']);
  const hasCore = items.some((item) => !supplemental.has(item.category));
  if (!hasCore) return items;
  return items.filter((item) => !supplemental.has(item.category));
}

function collapseDisplayItems(items: RecycleDisplayItem[]): RecycleDisplayItem[] {
  return collapseSupplementalDisplayItems(collapseAssociatedDisplayItems(items));
}

async function buildRecycleDisplayItems(
  uid: string,
  batchId: string | undefined,
  items: SyncRecycleItem[],
  metadata: SyncRecycleMetadata | undefined,
  kind?: RecycleKind,
  label?: string,
): Promise<RecycleDisplayItem[]> {
  const paths = items.map((item) => item.path).filter(isSafeCloudRelPath);
  const chatRoots = new Set<string>();
  const editConversationRoots = new Map<string, { kind: 'agent' | 'skill'; id: string }>();
  const projectRoots = new Set<string>();
  const taskRoots = new Set<string>();
  const agentRoots = new Set<string>();
  const skillRoots = new Set<string>();
  const appRoots = new Set<string>();
  const out: RecycleDisplayItem[] = [];
  const seen = new Set<string>();

  function add(item: RecycleDisplayItem): void {
    const title = cleanTitle(item.title);
    if (!title) return;
    const detail = cleanTitle(item.detail);
    const key = `${item.category}\0${item.id || item.path || title}\0${detail}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      category: item.category,
      title,
      ...(detail ? { detail } : {}),
      ...(item.id ? { id: item.id } : {}),
      ...(item.path && isSafeCloudRelPath(item.path) ? { path: item.path } : {}),
    });
  }

  for (const relPath of paths) {
    const editRoot = editConversationRootFromRelPath(relPath);
    if (editRoot) editConversationRoots.set(`${editRoot.kind}:${editRoot.id}`, editRoot);
    const cid = chatJsonlCid(relPath);
    if (cid) chatRoots.add(cid);
    const pid = projectRootDeletedId(relPath);
    if (pid) projectRoots.add(pid);
    const taskId = autoTaskRootDeletedId(relPath);
    if (taskId) taskRoots.add(taskId);
    const agentId = /^cloud\/agents\/([^/]+)\/agent\.json$/.exec(relPath)?.[1] || '';
    if (safeId(agentId)) agentRoots.add(agentId);
    const skillId = /^cloud\/skills\/([^/]+)\/SKILL\.md$/.exec(relPath)?.[1] || '';
    if (safeId(skillId)) skillRoots.add(skillId);
    const appId = /^cloud\/saved_apps\/([^/]+)\/__orkas-meta\.json$/.exec(relPath)?.[1] || '';
    if (safeId(appId)) appRoots.add(appId);
  }

  if (kind === 'project') {
    for (const pid of projectRoots) {
      add({
        category: 'project',
        id: pid,
        path: `cloud/projects/${pid}/project.json`,
        title: await projectTitle(uid, batchId, metadata, pid),
      });
    }
    if (!out.length) {
      for (const row of metadata?.project_rows || []) {
        const pid = typeof row.project_id === 'string' ? row.project_id : '';
        if (!safeId(pid)) continue;
        add({
          category: 'project',
          id: pid,
          path: `cloud/projects/${pid}/project.json`,
          title: titleFromJson(row, ['name', 'title']) || pid,
        });
      }
    }
    if (out.length) return out;
  }

  for (const cid of chatRoots) {
    add({
      category: 'conversation',
      id: cid,
      path: `cloud/chats/${cid}.jsonl`,
      title: await conversationTitle(uid, batchId, metadata, cid),
    });
  }
  for (const root of editConversationRoots.values()) {
    if (root.kind === 'skill' && skillRoots.has(root.id)) continue;
    if (root.kind === 'agent' && agentRoots.has(root.id)) continue;
    add({
      category: 'edit_conversation',
      id: `${root.kind}:${root.id}`,
      path: `cloud/chats/${root.kind}/${root.id}/chat.jsonl`,
      title: root.kind === 'skill'
        ? await skillTitle(uid, batchId, root.id)
        : await agentTitle(uid, batchId, root.id),
    });
  }
  for (const pid of projectRoots) {
    add({
      category: 'project',
      id: pid,
      path: `cloud/projects/${pid}/project.json`,
      title: await projectTitle(uid, batchId, metadata, pid),
    });
  }
  for (const taskId of taskRoots) {
    add({
      category: 'auto_task',
      id: taskId,
      path: `cloud/auto_tasks/${taskId}/config.json`,
      title: await autoTaskTitle(uid, batchId, taskId),
    });
  }
  for (const agentId of agentRoots) {
    add({
      category: 'agent',
      id: agentId,
      path: `cloud/agents/${agentId}/agent.json`,
      title: await agentTitle(uid, batchId, agentId),
    });
  }
  for (const skillId of skillRoots) {
    add({
      category: 'skill',
      id: skillId,
      path: `cloud/skills/${skillId}/SKILL.md`,
      title: await skillTitle(uid, batchId, skillId),
    });
  }
  for (const appId of appRoots) {
    add({
      category: 'saved_app',
      id: appId,
      path: `cloud/saved_apps/${appId}/__orkas-meta.json`,
      title: await savedAppTitle(uid, batchId, appId),
    });
  }

  for (const relPath of paths) {
    if (editConversationRootFromRelPath(relPath)) continue;
    const parts = relPath.replace(/^cloud\//, '').split('/').filter(Boolean);
    const fallback = basenameFromRelPath(relPath);

    if (parts[0] === 'chats') {
      const cid = parts[1]?.replace(/\.jsonl$/, '') || '';
      if (chatRoots.has(cid)) continue;
      if (safeId(cid) && cid !== 'agent' && cid !== 'skill') {
        add({
          category: 'conversation',
          id: cid,
          path: relPath,
          title: await conversationTitle(uid, batchId, metadata, cid),
        });
      }
      continue;
    }

    if (parts[0] === 'sessions') {
      const file = parts[1] || fallback;
      const cid = /^gconv-([A-Za-z0-9_-]+)\.jsonl$/.exec(file)?.[1]
        || /^gmember-([A-Za-z0-9]+)-/.exec(file)?.[1]
        || '';
      if (chatRoots.has(cid)) continue;
      add({
        category: 'conversation',
        id: safeId(cid) ? cid : file,
        path: relPath,
        title: safeId(cid) ? await conversationTitle(uid, batchId, metadata, cid) : file,
        detail: fallback,
      });
      continue;
    }

    if (parts[0] === 'chat_attachments') {
      const cid = parts[1] || '';
      if (chatRoots.has(cid)) continue;
      add({
        category: 'attachment',
        id: relPath,
        path: relPath,
        title: parts.slice(2).join('/') || fallback,
        detail: safeId(cid) ? await conversationTitle(uid, batchId, metadata, cid) : undefined,
      });
      continue;
    }

    if (parts[0] === 'chat_artifacts') {
      const cid = parts[1] || '';
      const artifactId = parts[2] || '';
      if (chatRoots.has(cid)) continue;
      add({
        category: 'artifact',
        id: artifactId || relPath,
        path: relPath,
        title: await artifactTitle(uid, batchId, cid, artifactId) || artifactId || fallback,
        detail: compactDetail([
          safeId(cid) ? await conversationTitle(uid, batchId, metadata, cid) : '',
          parts.slice(3).filter((p) => p !== '__orkas-meta.json').join('/'),
        ]),
      });
      continue;
    }

    if (parts[0] === 'projects') {
      const pid = parts[1] || '';
      if (projectRoots.has(pid)) continue;
      const project = safeId(pid) ? await projectTitle(uid, batchId, metadata, pid) : '';
      if (parts[2] === 'files') {
        add({
          category: 'project_file',
          id: relPath,
          path: relPath,
          title: parts.slice(3).join('/') || fallback,
          detail: project || undefined,
        });
      } else {
        add({
          category: 'project',
          id: pid || relPath,
          path: relPath,
          title: project || fallback,
          detail: parts.slice(2).join('/') || undefined,
        });
      }
      continue;
    }

    if (parts[0] === 'auto_tasks') {
      const taskId = parts[1] || '';
      if (taskRoots.has(taskId)) continue;
      add({
        category: parts[2] === 'attachments' ? 'attachment' : 'auto_task',
        id: relPath,
        path: relPath,
        title: parts[2] === 'attachments' ? (parts.slice(3).join('/') || fallback) : await autoTaskTitle(uid, batchId, taskId),
        detail: safeId(taskId) ? await autoTaskTitle(uid, batchId, taskId) : undefined,
      });
      continue;
    }

    if (parts[0] === 'agents') {
      const agentId = parts[1] || '';
      if (agentRoots.has(agentId)) continue;
      add({
        category: 'agent',
        id: agentId || relPath,
        path: relPath,
        title: safeId(agentId) ? await agentTitle(uid, batchId, agentId) : fallback,
        detail: parts.slice(2).join('/') || undefined,
      });
      continue;
    }

    if (parts[0] === 'skills') {
      const skillId = parts[1] || '';
      if (skillRoots.has(skillId)) continue;
      add({
        category: 'skill',
        id: skillId || relPath,
        path: relPath,
        title: safeId(skillId) ? await skillTitle(uid, batchId, skillId) : fallback,
        detail: parts.slice(2).filter((p) => p !== 'SKILL.md').join('/') || undefined,
      });
      continue;
    }

    if (parts[0] === 'saved_apps') {
      const appId = parts[1] || '';
      if (!appRoots.has(appId) && safeId(appId)) {
        add({
          category: 'saved_app',
          id: appId,
          path: relPath,
          title: await savedAppTitle(uid, batchId, appId),
          detail: parts.slice(2).filter((p) => p !== '__orkas-meta.json').join('/') || undefined,
        });
      }
      continue;
    }

    if (parts[0] === 'contexts') {
      add({
        category: 'context',
        id: relPath,
        path: relPath,
        title: parts.slice(1).join('/') || fallback,
      });
      continue;
    }

    if (parts[0] === 'memory') add({ category: 'memory', id: relPath, path: relPath, title: fallback });
    else if (parts[0] === 'config') add({ category: 'settings', id: relPath, path: relPath, title: fallback });
    else if (parts[0] === 'marketplace') add({ category: 'marketplace', id: relPath, path: relPath, title: fallback });
    else add({ category: 'file', id: relPath, path: relPath, title: fallback });
  }

  if (!out.length && cleanTitle(label)) {
    add({
      category: kind === 'auto_task' ? 'auto_task'
        : kind === 'conversation' || kind === 'conversations' ? 'conversation'
        : kind === 'project_file' ? 'project_file'
        : kind === 'saved_app' ? 'saved_app'
        : kind === 'context' ? 'context'
        : kind === 'attachment' ? 'attachment'
        : kind === 'agent' ? 'agent'
        : kind === 'skill' ? 'skill'
        : kind === 'project' ? 'project'
        : 'other',
      title: label || '',
    });
  }

  return collapseDisplayItems(out);
}

export async function buildRecycleDisplayPreview(
  uid: string,
  relPaths: string[],
  metadata?: SyncRecycleMetadata,
): Promise<RecycleDisplayItem[]> {
  const items = relPaths
    .filter(isSafeCloudRelPath)
    .map((relPath) => ({ path: relPath, size: 0 }));
  return buildRecycleDisplayItems(uid, undefined, items, metadata);
}

export async function snapshotRecycleMetadata(uid: string, relPaths: string[]): Promise<SyncRecycleMetadata | undefined> {
  const cids = new Set<string>();
  const projectIds = new Set<string>();
  const autoTaskIds = new Set<string>();
  for (const relPath of relPaths) {
    const cid = chatCidFromRelPath(relPath);
    if (cid) cids.add(cid);
    const pid = projectIdFromRelPath(relPath);
    if (pid) projectIds.add(pid);
    const taskId = autoTaskIdFromRelPath(relPath);
    if (taskId) autoTaskIds.add(taskId);
  }

  const chatIndexRows: Record<string, any>[] = [];
  const chatRowsByCid = new Map<string, Record<string, any>>();
  if (cids.size > 0) {
    try {
      const indexFile = resolveCloudRelPath(userCloudRoot(uid), 'cloud/chats/_index.json');
      const rows = JSON.parse(await fsp.readFile(indexFile, 'utf-8'));
      if (Array.isArray(rows)) {
        for (const row of rows) {
          if (!row || typeof row !== 'object') continue;
          const cid = typeof row.conversation_id === 'string' ? row.conversation_id : '';
          if (!cids.has(cid)) continue;
          chatRowsByCid.set(cid, { ...row });
          const pid = typeof row.project_id === 'string' ? row.project_id : '';
          if (safeId(pid)) projectIds.add(pid);
        }
      }
    } catch {
      // Missing or malformed _index.json should not block file protection.
    }
    for (const cid of cids) {
      const metaFile = resolveCloudRelPath(userCloudRoot(uid), `cloud/chats/${cid}/meta.json`);
      const row = await readJsonObject(metaFile);
      if (!row) continue;
      chatRowsByCid.set(cid, { ...chatRowsByCid.get(cid), ...row, conversation_id: cid });
      const pid = typeof row.project_id === 'string' ? row.project_id : '';
      if (safeId(pid)) projectIds.add(pid);
    }
  }
  chatIndexRows.push(...chatRowsByCid.values());

  for (const taskId of autoTaskIds) {
    const cfg = await readJsonObject(resolveCloudRelPath(userCloudRoot(uid), `cloud/auto_tasks/${taskId}/config.json`));
    const pid = typeof cfg?.project_id === 'string' ? cfg.project_id : '';
    if (safeId(pid)) projectIds.add(pid);
  }

  const projectRows: Record<string, any>[] = [];
  for (const pid of projectIds) {
    const row = await readJsonObject(projectMetaFile(uid, pid));
    if (row && safeId(row.project_id)) projectRows.push({ ...row });
  }

  return normalizeMetadata({
    chat_index_rows: chatIndexRows,
    project_rows: projectRows,
  });
}

function textFromMessage(raw: any): string {
  if (!raw || typeof raw !== 'object') return '';
  if (typeof raw.text === 'string') return raw.text;
  if (typeof raw.content === 'string') return raw.content;
  if (Array.isArray(raw.content)) {
    return raw.content
      .map((part: any) => (typeof part === 'string'
        ? part
        : (part && typeof part.text === 'string' ? part.text : '')))
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

function normaliseMessageTs(raw: any): string | null {
  const ts = typeof raw?.ts === 'string' ? raw.ts : (typeof raw?.created_at === 'string' ? raw.created_at : '');
  if (!ts) return null;
  const ms = new Date(ts).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function titleFromText(value: string): string {
  const raw = (value || '').trim().replace(/\s+/g, ' ');
  if (!raw) return t('chat.default_title');
  let text = raw;
  for (let i = 0; i < 5; i++) {
    const before = text;
    text = text.replace(ZH_FILLER_RE, '').replace(EN_FILLER_RE, '');
    if (text === before) break;
  }
  text = text.trim();
  const clauseIdx = text.search(CLAUSE_RE);
  if (clauseIdx >= 4) text = text.slice(0, clauseIdx);
  text = text.trim() || raw;
  if (text.length > TITLE_MAX) text = text.slice(0, TITLE_MAX) + '…';
  return text || t('chat.default_title');
}

async function deriveChatIndexRowFromArchive(
  uid: string,
  batchId: string,
  cid: string,
  relPath: string,
  restoredIso: string,
): Promise<Record<string, any> | null> {
  let firstUserText = '';
  let firstText = '';
  let createdMs = 0;
  let updatedMs = 0;
  try {
    const file = recycleFileAbs(uid, batchId, relPath);
    const text = await fsp.readFile(file, 'utf-8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg: any;
      try { msg = JSON.parse(trimmed); } catch { continue; }
      const iso = normaliseMessageTs(msg);
      if (iso) {
        const ms = new Date(iso).getTime();
        if (!createdMs || ms < createdMs) createdMs = ms;
        if (ms > updatedMs) updatedMs = ms;
      }
      const msgText = textFromMessage(msg).trim();
      if (!firstText && msgText) firstText = msgText;
      const from = typeof msg?.from === 'string' ? msg.from : (typeof msg?.role === 'string' ? msg.role : '');
      if (!firstUserText && from === 'user' && msgText) firstUserText = msgText;
    }
  } catch {
    return null;
  }
  const createdAt = createdMs ? new Date(createdMs).toISOString() : restoredIso;
  const updatedAt = updatedMs ? new Date(updatedMs).toISOString() : createdAt;
  return {
    conversation_id: cid,
    title: titleFromText(firstUserText || firstText),
    kind: 'normal',
    agent_id: '',
    skill_id: '',
    session_id: `gconv-${cid}`,
    created_at: createdAt,
    updated_at: restoredIso || updatedAt,
  };
}

async function reactivateChatIndexRows(
  uid: string,
  batch: SyncRecycleBatch,
  relPaths: string[],
  restoredAt: Date,
): Promise<string[]> {
  const cidToRelPath = new Map<string, string>();
  for (const relPath of relPaths) {
    const cid = chatJsonlCid(relPath);
    if (cid) cidToRelPath.set(cid, relPath);
  }
  if (cidToRelPath.size === 0) return [];

  const metadataRows = new Map<string, Record<string, any>>();
  for (const row of batch.metadata?.chat_index_rows || []) {
    const cid = typeof row.conversation_id === 'string' ? row.conversation_id : '';
    if (safeId(cid)) metadataRows.set(cid, row);
  }
  const legacyProjectIds = new Set<string>();
  for (const item of batch.items) {
    const pid = projectIdFromRelPath(item.path);
    if (pid) legacyProjectIds.add(pid);
  }
  const legacyProjectId = legacyProjectIds.size === 1 ? Array.from(legacyProjectIds)[0] : '';

  const indexFile = resolveCloudRelPath(userCloudRoot(uid), 'cloud/chats/_index.json');
  let rows: any[];
  try {
    const raw = JSON.parse(await fsp.readFile(indexFile, 'utf-8'));
    if (!Array.isArray(raw)) return [];
    rows = raw;
  } catch {
    rows = [];
  }

  const reactivated = new Set<string>();
  const restoredIso = restoredAt.toISOString();
  const rowsByCid = new Map<string, any>();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const cid = typeof row.conversation_id === 'string' ? row.conversation_id : '';
    if (safeId(cid)) rowsByCid.set(cid, row);
  }
  let changed = false;

  for (const [cid, relPath] of cidToRelPath) {
    const row = rowsByCid.get(cid);
    const metadataRow = metadataRows.get(cid);
    if (!row && !metadataRow) {
      const restoredRow = await deriveChatIndexRowFromArchive(uid, batch.id, cid, relPath, restoredIso);
      if (!restoredRow) continue;
      rows.unshift(restoredRow);
      rowsByCid.set(cid, restoredRow);
      reactivated.add(relPath);
      changed = true;
      continue;
    }

    if (!row) {
      const restoredRow: Record<string, any> = { ...metadataRow, conversation_id: cid };
      delete restoredRow.deleted_at;
      rows.unshift(restoredRow);
      rowsByCid.set(cid, restoredRow);
      reactivated.add(relPath);
      changed = true;
      continue;
    }

    const rowDeleted = typeof row.deleted_at === 'string' && row.deleted_at;
    const metadataProjectId = typeof metadataRow?.project_id === 'string' && metadataRow.project_id ? metadataRow.project_id : '';
    const canRepairMetadataProject = !row.project_id && metadataProjectId;
    const canRepairLegacyProject = !row.project_id && legacyProjectId && fs.existsSync(projectMetaFile(uid, legacyProjectId));
    if (!rowDeleted && !canRepairMetadataProject && !canRepairLegacyProject) continue;

    if (rowDeleted && metadataRow) {
      Object.assign(row, metadataRow);
    } else if (canRepairMetadataProject) {
      row.project_id = metadataProjectId;
    } else if (canRepairLegacyProject) {
      row.project_id = legacyProjectId;
    }
    delete row.deleted_at;
    if (rowDeleted && !metadataRow) row.updated_at = restoredIso;
    reactivated.add(relPath);
    changed = true;
  }

  if (changed) {
    await writeJson(indexFile, rows);
  }
  return Array.from(reactivated);
}

async function restoreProjectMetadata(uid: string, metadata: SyncRecycleMetadata | undefined): Promise<string[]> {
  const restored: string[] = [];
  for (const row of metadata?.project_rows || []) {
    const pid = typeof row.project_id === 'string' ? row.project_id : '';
    if (!safeId(pid)) continue;
    const file = projectMetaFile(uid, pid);
    if (fs.existsSync(file)) continue;
    try {
      await writeJson(file, row);
      restored.push(`cloud/projects/${pid}/project.json`);
    } catch (err: any) {
      log.warn('restore project metadata failed', {
        project_id: maskId(pid),
        path: logPathRef(`cloud/projects/${pid}/project.json`),
        error: logRecycleErrorRef(err),
      });
    }
  }
  return restored;
}

function normalizeBatch(raw: any): SyncRecycleBatch | null {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id : '';
  if (!/^[A-Za-z0-9_.-]+$/.test(id)) return null;
  const source: RecycleSource = raw.source === 'app' ? 'app' : 'cloud_sync';
  const reason: RecycleReason = raw.reason === 'app_delete' || source === 'app'
    ? 'app_delete'
    : 'remote_tombstone';
  const kind = typeof raw.kind === 'string' ? raw.kind as RecycleKind : undefined;
  const label = typeof raw.label === 'string' && raw.label ? raw.label : undefined;
  const items = Array.isArray(raw.items)
    ? raw.items.filter((it: any) => it && isSafeCloudRelPath(it.path)).map((it: any) => ({
        path: it.path,
        size: Math.max(0, Number(it.size) || 0),
      }))
    : [];
  const totalBytes = items.reduce((sum, it) => sum + it.size, 0);
  const metadata = normalizeMetadata(raw.metadata);
  const displayItems = collapseDisplayItems(normalizeDisplayItems(raw.display_items));
  const displayTitle = cleanTitle(raw.display_title);
  return {
    id,
    reason,
    source,
    ...(kind ? { kind } : {}),
    ...(label ? { label } : {}),
    created_at_ms: Number(raw.created_at_ms) || 0,
    expires_at_ms: Number(raw.expires_at_ms) || 0,
    items,
    total_bytes: totalBytes,
    paths_preview: items.slice(0, PREVIEW_LIMIT).map((it) => it.path),
    ...(displayItems.length ? { display_items: displayItems } : {}),
    ...(displayTitle ? { display_title: displayTitle } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

async function readBatch(uid: string, batchId: string): Promise<SyncRecycleBatch | null> {
  try {
    const raw = JSON.parse(await fsp.readFile(batchMetaFile(uid, batchId), 'utf-8'));
    const batch = normalizeBatch(raw);
    if (!batch) {
      log.warn('read recycle batch rejected', {
        user_id: maskId(uid),
        batch_id: logBatchId(batchId),
        reason: 'invalid_metadata',
      });
      return null;
    }
    if (batch.kind === 'project' || !batch.display_items?.length) {
      const displayItems = await buildRecycleDisplayItems(
        uid,
        batch.id,
        batch.items,
        batch.metadata,
        batch.kind,
        batch.label,
      );
      if (displayItems.length) batch.display_items = displayItems;
    }
    return batch;
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      log.debug('read recycle batch missing metadata', {
        user_id: maskId(uid),
        batch_id: logBatchId(batchId),
      });
      return null;
    }
    log.warn('read recycle batch failed', {
      user_id: maskId(uid),
      batch_id: logBatchId(batchId),
      error: logRecycleErrorRef(err),
    });
    return null;
  }
}

export async function createRecycleBatch(
  uid: string,
  relPaths: string[],
  nowMs = Date.now(),
  restoreMetadata?: SyncRecycleMetadata,
  opts: { source?: RecycleSource; kind?: RecycleKind; label?: string; strict?: boolean } = {},
): Promise<SyncRecycleBatch | null> {
  const source: RecycleSource = opts.source === 'app' ? 'app' : 'cloud_sync';
  const uniquePaths = await expandRecycleRelPaths(uid, relPaths);
  if (uniquePaths.length === 0) {
    log.info('recycle batch create skipped: no archiveable paths', {
      user_id: maskId(uid),
      source,
      kind: opts.kind,
      strict: !!opts.strict,
      requested_path_count: relPaths.length,
      requested_paths: logPathRefs(relPaths),
    });
    return null;
  }

  const id = `${new Date(nowMs).toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`;
  const dir = batchDir(uid, id);
  const items: SyncRecycleItem[] = [];
  const failedArchivePaths: string[] = [];
  log.info('recycle batch archive started', {
    user_id: maskId(uid),
    batch_id: logBatchId(id),
    source,
    kind: opts.kind,
    strict: !!opts.strict,
    requested_path_count: relPaths.length,
    expanded_paths: logPathRefs(uniquePaths),
  });
  await fsp.mkdir(path.join(dir, FILES_DIR), { recursive: true });

  for (const relPath of uniquePaths) {
    try {
      const src = resolveCloudRelPath(userCloudRoot(uid), relPath);
      const st = await fsp.stat(src);
      if (!st.isFile()) continue;
      const dest = recycleFileAbs(uid, id, relPath);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.copyFile(src, dest);
      items.push({ path: relPath, size: st.size });
    } catch (err: any) {
      failedArchivePaths.push(relPath);
      if (err?.code !== 'ENOENT') {
        log.warn('archive recycle file failed', {
          user_id: maskId(uid),
          batch_id: logBatchId(id),
          source,
          kind: opts.kind,
          path: logPathRef(relPath),
          error: logRecycleErrorRef(err),
        });
      }
    }
  }

  if (opts.strict && failedArchivePaths.length > 0) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    log.warn('recycle batch archive aborted: strict snapshot incomplete', {
      user_id: maskId(uid),
      batch_id: logBatchId(id),
      source,
      kind: opts.kind,
      archived_item_count: items.length,
      failed_paths: logPathRefs(failedArchivePaths),
    });
    const err: Error & { code?: string; failed_paths?: string[] } = new Error('recycle_archive_failed');
    err.code = 'recycle_archive_failed';
    err.failed_paths = failedArchivePaths;
    throw err;
  }

  if (items.length === 0) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    log.info('recycle batch create skipped: archive empty', {
      user_id: maskId(uid),
      batch_id: logBatchId(id),
      source,
      kind: opts.kind,
      requested_path_count: relPaths.length,
      expanded_paths: logPathRefs(uniquePaths),
      failed_paths: logPathRefs(failedArchivePaths),
    });
    return null;
  }

  const metadata = normalizeMetadata(restoreMetadata)
    || await snapshotRecycleMetadata(uid, uniquePaths);
  const displayItems = await buildRecycleDisplayItems(uid, id, items, metadata, opts.kind, opts.label);
  const batch: SyncRecycleBatch = {
    id,
    reason: source === 'app' ? 'app_delete' : 'remote_tombstone',
    source,
    ...(opts.kind ? { kind: opts.kind } : {}),
    ...(opts.label ? { label: opts.label } : {}),
    created_at_ms: nowMs,
    expires_at_ms: 0,
    items,
    total_bytes: items.reduce((sum, it) => sum + it.size, 0),
    paths_preview: items.slice(0, PREVIEW_LIMIT).map((it) => it.path),
    ...(displayItems.length ? { display_items: displayItems } : {}),
    ...(metadata ? { metadata } : {}),
  };
  await fsp.writeFile(batchMetaFile(uid, id), JSON.stringify(batch, null, 2));
  log.info('recycle batch created', {
    user_id: maskId(uid),
    ...logRecycleBatchRef(batch),
    requested_path_count: relPaths.length,
    archived_item_count: items.length,
    failed_path_count: failedArchivePaths.length,
  });
  return batch;
}

export async function createAppRecycleBatch(
  uid: string,
  relPaths: string[],
  opts: { kind?: RecycleKind; label?: string; strict?: boolean } = {},
): Promise<SyncRecycleBatch | null> {
  const expanded = new Set<string>();
  let invalidPathCount = 0;
  for (const relPath of relPaths) {
    if (!isSafeCloudRelPath(relPath)) {
      invalidPathCount += 1;
      continue;
    }
    const files = await collectCloudEntryFiles(uid, relPath);
    if (files.length) {
      for (const f of files) expanded.add(f);
    } else {
      expanded.add(relPath);
    }
  }
  log.info('app recycle request expanded', {
    user_id: maskId(uid),
    kind: opts.kind,
    strict: !!opts.strict,
    requested_path_count: relPaths.length,
    invalid_path_count: invalidPathCount,
    expanded_paths: logPathRefs(Array.from(expanded)),
  });
  return createRecycleBatch(uid, Array.from(expanded), Date.now(), undefined, {
    source: 'app',
    kind: opts.kind,
    label: opts.label,
    strict: opts.strict,
  });
}

export async function createAppRecycleBatchForConversation(
  uid: string,
  cid: string,
): Promise<SyncRecycleBatch | null> {
  if (!safeId(cid)) return null;
  return createAppRecycleBatch(uid, [`cloud/chats/${cid}.jsonl`], { kind: 'conversation' });
}

export async function createAppRecycleBatchForConversations(
  uid: string,
  cids: string[],
): Promise<SyncRecycleBatch | null> {
  const rels = Array.from(new Set(cids.filter(safeId).map((cid) => `cloud/chats/${cid}.jsonl`)));
  return createAppRecycleBatch(uid, rels, { kind: 'conversations' });
}

export async function createAppRecycleBatchForAutoTask(
  uid: string,
  taskId: string,
): Promise<SyncRecycleBatch | null> {
  if (!safeId(taskId)) return null;
  return createAppRecycleBatch(uid, [`cloud/auto_tasks/${taskId}/config.json`], { kind: 'auto_task' });
}

async function conversationIdsForProject(uid: string, projectId: string): Promise<string[]> {
  try {
    const indexFile = resolveCloudRelPath(userCloudRoot(uid), 'cloud/chats/_index.json');
    const rows = JSON.parse(await fsp.readFile(indexFile, 'utf-8'));
    if (!Array.isArray(rows)) return [];
    return rows
      .filter((row: any) => row && row.project_id === projectId && safeId(row.conversation_id) && !row.deleted_at)
      .map((row: any) => row.conversation_id);
  } catch {
    return [];
  }
}

async function autoTaskIdsForProject(uid: string, projectId: string): Promise<string[]> {
  const out: string[] = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = await fsp.readdir(resolveCloudRelPath(userCloudRoot(uid), 'cloud/auto_tasks'), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !safeId(entry.name)) continue;
    const cfg = await readJsonObject(resolveCloudRelPath(userCloudRoot(uid), `cloud/auto_tasks/${entry.name}/config.json`));
    if (cfg?.project_id === projectId) out.push(entry.name);
  }
  return out;
}

export async function createAppRecycleBatchForProject(
  uid: string,
  projectId: string,
): Promise<SyncRecycleBatch | null> {
  if (!safeId(projectId)) return null;
  const rels = new Set<string>([`cloud/projects/${projectId}`]);
  const conversationIds = await conversationIdsForProject(uid, projectId);
  const autoTaskIds = await autoTaskIdsForProject(uid, projectId);
  for (const cid of conversationIds) rels.add(`cloud/chats/${cid}.jsonl`);
  for (const taskId of autoTaskIds) rels.add(`cloud/auto_tasks/${taskId}/config.json`);
  log.info('project recycle cascade prepared', {
    user_id: maskId(uid),
    project_id: maskId(projectId),
    conversation_count: conversationIds.length,
    auto_task_count: autoTaskIds.length,
    root_paths: logPathRefs(Array.from(rels)),
  });
  return createAppRecycleBatch(uid, Array.from(rels), { kind: 'project', strict: true });
}

export async function createAppRecycleBatchForCloudEntry(
  uid: string,
  relPath: string,
  kind: RecycleKind = 'other',
): Promise<SyncRecycleBatch | null> {
  return createAppRecycleBatch(uid, [relPath], { kind });
}

export async function createAppRecycleBatchForAgent(
  uid: string,
  agentId: string,
): Promise<SyncRecycleBatch | null> {
  if (!safeId(agentId)) return null;
  const rels = new Set<string>([
    `cloud/agents/${agentId}`,
    `cloud/chats/agent/${agentId}`,
    `cloud/sessions/agent-${agentId}.jsonl`,
  ]);
  return createAppRecycleBatch(uid, Array.from(rels), { kind: 'agent' });
}

export async function createAppRecycleBatchForSkill(
  uid: string,
  skillId: string,
): Promise<SyncRecycleBatch | null> {
  if (!safeId(skillId)) return null;
  return createAppRecycleBatch(uid, [
    `cloud/skills/${skillId}`,
    `cloud/chats/skill/${skillId}`,
    `cloud/sessions/skill-${skillId}.jsonl`,
  ], { kind: 'skill' });
}

export async function listRecycleBatches(uid: string): Promise<SyncRecycleBatch[]> {
  await migrateLegacySyncRecycle(uid);
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(userRecycleDir(uid), { withFileTypes: true });
  } catch {
    return [];
  }
  const batches: SyncRecycleBatch[] = [];
  let rejected = 0;
  let directoryCount = 0;
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    directoryCount += 1;
    if (!isSafeRecycleBatchId(ent.name)) {
      rejected += 1;
      log.warn('list recycle skipped invalid batch directory', {
        user_id: maskId(uid),
        batch_id: logBatchId(ent.name),
      });
      continue;
    }
    const batch = await readBatch(uid, ent.name);
    if (batch && batch.items.length > 0) {
      batches.push(batch);
    } else {
      rejected += 1;
    }
  }
  batches.sort((a, b) => b.created_at_ms - a.created_at_ms);
  log.debug('listed recycle batches', {
    user_id: maskId(uid),
    directory_count: directoryCount,
    batch_count: batches.length,
    rejected_count: rejected,
  });
  return batches;
}

export async function deleteRecycleBatch(uid: string, batchId: string): Promise<{ deleted: boolean }> {
  await migrateLegacySyncRecycle(uid);
  const batch = await readBatch(uid, batchId);
  if (!batch) {
    log.info('delete recycle batch skipped: not found', {
      user_id: maskId(uid),
      batch_id: logBatchId(batchId),
    });
    return { deleted: false };
  }
  try {
    await fsp.rm(batchDir(uid, batchId), { recursive: true, force: true });
    log.info('deleted recycle batch', {
      user_id: maskId(uid),
      ...logRecycleBatchRef(batch),
    });
    return { deleted: true };
  } catch (err) {
    log.warn('delete recycle batch failed', {
      user_id: maskId(uid),
      batch_id: logBatchId(batchId),
      error: logRecycleErrorRef(err),
    });
    throw err;
  }
}

export async function restoreRecycleBatch(
  uid: string,
  batchId: string,
): Promise<{
  restored_paths: string[];
  skipped_paths: string[];
  failed_paths: string[];
  reactivated_paths: string[];
  batch: SyncRecycleBatch | null;
}> {
  await migrateLegacySyncRecycle(uid);
  const batch = await readBatch(uid, batchId);
  if (!batch) {
    log.warn('restore recycle batch skipped: not found', {
      user_id: maskId(uid),
      batch_id: logBatchId(batchId),
    });
    return { restored_paths: [], skipped_paths: [], failed_paths: [], reactivated_paths: [], batch: null };
  }
  log.info('restore recycle batch started', {
    user_id: maskId(uid),
    ...logRecycleBatchRef(batch),
  });

  const restored: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  const now = new Date();
  for (const item of batch.items) {
    try {
      const src = recycleFileAbs(uid, batchId, item.path);
      const dest = resolveCloudRelPath(userCloudRoot(uid), item.path);
      try {
        await fsp.stat(dest);
        skipped.push(item.path);
        continue;
      } catch (err: any) {
        if (err?.code !== 'ENOENT') throw err;
      }
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.copyFile(src, dest, fs.constants.COPYFILE_EXCL);
      await fsp.utimes(dest, now, now);
      restored.push(item.path);
    } catch (err: any) {
      failed.push(item.path);
      log.warn('restore recycle file failed', {
        user_id: maskId(uid),
        batch_id: logBatchId(batchId),
        path: logPathRef(item.path),
        error: logRecycleErrorRef(err),
      });
    }
  }

  const restoredMetadataPaths = await restoreProjectMetadata(uid, batch.metadata);
  let reactivated: string[] = [];
  const indexCandidates = Array.from(new Set([...restored, ...skipped, ...restoredMetadataPaths]));
  try {
    reactivated = await reactivateChatIndexRows(uid, batch, indexCandidates, now);
  } catch (err: any) {
    log.warn('reactivate chat index after recycle restore failed', {
      user_id: maskId(uid),
      batch_id: logBatchId(batchId),
      candidates: logPathRefs(indexCandidates),
      error: logRecycleErrorRef(err),
    });
  }
  reactivated = Array.from(new Set([...reactivated, ...restoredMetadataPaths]));

  if (failed.length > 0 || (restored.length > 0 && skipped.length > 0)) {
    log.warn('restore recycle batch partially completed; keeping batch for retry', {
      user_id: maskId(uid),
      batch_id: logBatchId(batchId),
      restored: restored.length,
      skipped: skipped.length,
      failed: failed.length,
      total: batch.items.length,
      restored_paths: logPathRefs(restored),
      skipped_paths: logPathRefs(skipped),
      failed_paths: logPathRefs(failed),
    });
  }
  log.info('restored recycle batch without consuming it', {
    user_id: maskId(uid),
    batch_id: logBatchId(batchId),
    restored: restored.length,
    skipped: skipped.length,
    failed: failed.length,
    reactivated: reactivated.length,
    batch_retained: fs.existsSync(batchDir(uid, batchId)),
    restored_paths: logPathRefs(restored),
    skipped_paths: logPathRefs(skipped),
    failed_paths: logPathRefs(failed),
    reactivated_paths: logPathRefs(reactivated),
  });
  return { restored_paths: restored, skipped_paths: skipped, failed_paths: failed, reactivated_paths: reactivated, batch };
}
