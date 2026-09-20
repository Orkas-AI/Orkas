import * as fs from 'node:fs';
import * as path from 'node:path';
import { readJsonlPage } from '../../storage';
import { conversationMessageReadFile } from '../../util/project-layout';
import { resolveAttachmentAbsPath } from '../chat_attachments';
import type { GroupMessage } from './visibility';

type Authorization = 'authorized' | 'missing' | 'ambiguous' | 'changed';

// Parse literal path syntax only. Do not infer an import request or resolve
// relative paths, parent directories, URLs, or model-authored references.
export function literalImportPaths(text: string): string[] {
  const paths = new Set<string>();
  const add = (value: string) => {
    if (/^(?:\/(?!\/)|[A-Za-z]:[\\/])/.test(value)
      && !/[\u0000-\u001f\u007f]/.test(value)) paths.add(value);
  };
  const rest = text.replace(/`([^`\r\n]+)`|"([^"\r\n]+)"|'([^'\r\n]+)'|<([^<>\r\n]+)>/g,
    (_match, code, double, single, angle) => {
      add(code ?? double ?? single ?? angle);
      return ' ';
    });
  for (const match of rest.matchAll(/(?:^|[\s(（【「『])((?:\/(?!\/)|[A-Za-z]:[\\/])[^\s<>"'`，。；：！？、）】」』)\]]+)/g)) {
    add(match[1].replace(/[.,;!?]+$/, ''));
  }
  return [...paths];
}

// Filesystem change times provide conservative freshness evidence without
// persisting cross-device file capabilities. Unreadable/oversized trees or
// changes after the user's message require a fresh explicit source selection.
export function importSourceUnchangedSince(source: string, providedAt: number): boolean {
  if (!Number.isFinite(providedAt)) return false;
  const unchanged = (st: fs.Stats) => Math.floor(Math.max(st.mtimeMs, st.ctimeMs, st.birthtimeMs)) <= providedAt;
  let remaining = 1024;
  try {
    // A replaced symlink in an ancestor can redirect an otherwise old file.
    for (let part = path.resolve(source);;) {
      const st = fs.lstatSync(part);
      if (st.isSymbolicLink() && !unchanged(st)) return false;
      const parent = path.dirname(part);
      if (parent === part) break;
      part = parent;
    }
    const visit = (entry: string): boolean => {
      if (--remaining < 0) return false;
      const st = fs.lstatSync(entry);
      if (!unchanged(st)) return false;
      if (st.isSymbolicLink()) return false;
      if (st.isFile()) return true;
      if (!st.isDirectory()) return false;
      return fs.readdirSync(entry).every((name) => visit(path.join(entry, name)));
    };
    return visit(fs.realpathSync(source));
  } catch { return false; }
}

export async function historicalSkillImportAuthorization(
  userId: string, cid: string, currentMessageId: string, sourcePath: string,
): Promise<Authorization> {
  // Read raw, account/conversation-bound records rather than rendered history
  // or the model's context. An incomplete history cannot prove uniqueness.
  let records: GroupMessage[] = [];
  let before: number | null | undefined;
  let bytes = 0;
  for (;;) {
    const page = await readJsonlPage<GroupMessage>(conversationMessageReadFile(userId, cid), 128, before);
    records = page.records.concat(records);
    bytes += Buffer.byteLength(JSON.stringify(page.records), 'utf8');
    if (records.length > 1024 || bytes > 2 * 1024 * 1024) return 'missing';
    if (page.nextCursor === null) break;
    before = page.nextCursor;
  }
  const currentIndex = records.findIndex((message) => message.id === currentMessageId);
  if (currentIndex < 0) return 'missing';
  const sources = new Map<string, number>();
  for (const message of records.slice(0, currentIndex)) {
    if (message.from !== 'user' || message.deleted_at) continue;
    // Legacy seconds-only timestamps remain conservative: never round up
    // and accidentally authorize a change within that second.
    const providedAt = message.received_at_ms ?? Date.parse(message.ts);
    if (!Number.isFinite(providedAt)) return 'missing';
    const candidates = literalImportPaths(message.text || '');
    for (const name of message.attachments || []) {
      // Other attachment kinds cannot be native package sources.
      if (path.extname(name).toLowerCase() !== '.zip') continue;
      const resolved = resolveAttachmentAbsPath(userId, cid, name);
      if (!resolved.ok) return 'missing';
      candidates.push(resolved.absPath);
    }
    for (const candidate of candidates) {
      if (!path.isAbsolute(candidate)) continue;
      let st: fs.Stats;
      try { st = fs.statSync(candidate); } catch { return 'missing'; }
      if (!st.isDirectory() && !(st.isFile() && path.extname(candidate).toLowerCase() === '.zip')) continue;
      const key = path.resolve(candidate);
      sources.set(key, Math.max(sources.get(key) ?? 0, providedAt));
    }
  }
  const target = path.resolve(sourcePath);
  if (!sources.has(target)) return 'missing';
  if (sources.size !== 1) return 'ambiguous';
  return importSourceUnchangedSince(target, sources.get(target)!) ? 'authorized' : 'changed';
}
