/**
 * Per-conversation workspace subdirectory resolver.
 *
 * Background: every main conversation used to share one root `userWorkSpace/`,
 * which meant repeated agent runs writing the same basename (`requirements.md`)
 * piled up `requirements-2.md / -3.md / ...` via `util/uniquify-path`. The
 * uniquify itself is correct (don't silently overwrite the prior run's
 * artifact), but the workspace clutter is bad UX. Scoping the cwd to a
 * conversation-specific subdir keeps the lineage grouped and the root tidy.
 *
 * Semantics:
 *   - Lazy: subdir is resolved + mkdir'd on the first call from `bus.ts`,
 *     which only fires when there's actual conversation activity. Old convs
 *     that never call this stay at the root workspace (= legacy behaviour).
 *   - Frozen: once chosen and persisted to `state.json::workspace_dir`, the
 *     subdir basename is never re-derived. Renaming the conv title later
 *     does NOT move the directory.
 *   - No sandbox change: the existing path-sandbox (`util/path-sandbox`)
 *     still allows the entire user workspace tree, so cross-conv reads via
 *     absolute path remain possible.
 *
 * Slug rules — see `slugifyConvTitle()` body. Goal: human-readable Finder
 * navigation (CJK preserved, English lowercased, no opaque cid hex).
 *
 * Placeholder fallback: when the title is missing / equals the i18n
 * placeholder (English "New conversation" or its localized form
 * "新对话") / slug-ifies to empty / hits
 * a Windows reserved name, we fall back to `chat-{YYYY-MM-DD}-{N}`. The
 * fallback is also frozen on first use, so a write that fired before the
 * conv got its real auto-generated title locks in the date-based name —
 * that's the accepted cost of lazy resolution.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { getWorkspacePath } from '../user_workspace';
import { getConversation } from '../chats';
import { readState, setWorkspaceDirOnce } from './state';
import { PLACEHOLDER_TITLES } from './conv_title';
import { createLogger } from '../../logger';
import { logErrorSummary, maskId } from '../../util/log-redact';

const log = createLogger('group_chat.conv_workspace');

const MAX_SLUG_LEN = 32;

// Windows reserved device names (case-insensitive). A directory bearing
// any of these names cannot be created on Windows — fall back rather than
// fight the OS.
const WINDOWS_RESERVED: ReadonlySet<string> = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

const ILLEGAL_CHARS_RE = /[\\/:*?"<>|]/g;

/** Resolve the persisted workspace basename under its owning root. Synced
 * state is untrusted at this boundary: only one portable path component is
 * accepted, and the resolved path must remain a direct child of the root. */
export function resolveConversationWorkspaceChild(workspaceRoot: string, rawDir: unknown): string {
  if (typeof rawDir !== 'string' || !rawDir || rawDir !== rawDir.trim()) return '';
  if (Buffer.byteLength(rawDir, 'utf8') > 256) return '';
  if (rawDir === '.' || rawDir === '..') return '';
  if (path.posix.isAbsolute(rawDir) || path.win32.isAbsolute(rawDir)) return '';
  if (/[\\/\u0000-\u001f<>:"|?*]/.test(rawDir) || /[. ]$/.test(rawDir)) return '';

  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(root, rawDir);
  const relative = path.relative(root, resolved);
  if (!relative || path.isAbsolute(relative) || relative === '..'
      || relative.startsWith(`..${path.sep}`) || path.dirname(relative) !== '.') return '';
  return resolved;
}

/** Pure slug derivation. Returns empty string on placeholder / unusable input;
 *  callers fall back to the date-based name. Exported for unit testing. */
export function slugifyConvTitle(rawTitle: string | undefined | null): string {
  if (!rawTitle) return '';
  let s = rawTitle.trim();
  if (!s) return '';
  if (PLACEHOLDER_TITLES.has(s)) return '';

  // 1. Replace Windows-illegal punctuation with '-' so it shows up as a
  //    separator instead of disappearing.
  s = s.replace(ILLEGAL_CHARS_RE, '-');

  // 2. Collapse any whitespace (incl. newlines / tabs) to single '-'.
  s = s.replace(/\s+/g, '-');

  // 3. Drop control + ASCII punctuation we don't want to keep. Allowlist:
  //      [a-zA-Z0-9_-]  ASCII alnum + underscore + hyphen
  //      \p{L}          any-language Unicode letter (covers CJK, Cyrillic, Arabic, …)
  //      \p{N}          any-language Unicode number
  s = s.replace(/[^\p{L}\p{N}_\-]/gu, '');

  // 4. ASCII letters → lowercase (FS portability). Non-ASCII letters have
  //    no case to lose.
  s = s.replace(/[A-Z]/g, (c) => c.toLowerCase());

  // 5. Collapse runs of '-' and trim leading/trailing '-' or '.'.
  s = s.replace(/-+/g, '-');
  s = s.replace(/^[-.]+|[-.]+$/g, '');

  // 6. Length cap.
  if (s.length > MAX_SLUG_LEN) s = s.slice(0, MAX_SLUG_LEN).replace(/-+$/, '');

  if (!s) return '';
  if (WINDOWS_RESERVED.has(s.toLowerCase())) return '';
  return s;
}

/** Pick a date-based fallback slug, scanning sibling dirs to find the next
 *  unused suffix (`chat-YYYY-MM-DD-1` → `-2` → ...). Stable across calls
 *  within the same day (next call gets the next free N). */
function pickFallbackSlug(workspaceRoot: string): string {
  const today = new Date();
  const yyyy = today.getFullYear().toString().padStart(4, '0');
  const mm = (today.getMonth() + 1).toString().padStart(2, '0');
  const dd = today.getDate().toString().padStart(2, '0');
  const base = `chat-${yyyy}-${mm}-${dd}`;
  for (let n = 1; n < 10000; n++) {
    const candidate = `${base}-${n}`;
    if (!fs.existsSync(path.join(workspaceRoot, candidate))) return candidate;
  }
  // 10000 chats produced on a single day is well past pathological — caller
  // sees a unique-but-suffixed name rather than an exception.
  return `${base}-${Date.now()}`;
}

/** Return a slug with collisions resolved by `-2` / `-3` / ... suffixing.
 *  Treats an existing dir of the same name as a collision (likely produced
 *  by a different conv with the same title). */
function uniquifySlug(workspaceRoot: string, slug: string): string {
  if (!fs.existsSync(path.join(workspaceRoot, slug))) return slug;
  for (let n = 2; n < 10000; n++) {
    const candidate = `${slug}-${n}`;
    if (!fs.existsSync(path.join(workspaceRoot, candidate))) return candidate;
  }
  return `${slug}-${Date.now()}`;
}

/**
 * Resolve the absolute working directory for `(uid, cid)`. Lazy + frozen:
 * - if `state.json::workspace_dir` is already set → return `<workspace>/<dir>`
 * - else if the conv has no entry yet (genuinely a legacy conv without a
 *   conversation record, or `state.json` not yet written) → return the
 *   user-level workspace verbatim, do NOT persist anything (legacy behaviour)
 * - else → derive slug from current title, fall back to date-based name on
 *   placeholder, uniquify against sibling dirs, persist the slug choice to
 *   `state.json::workspace_dir`, return the absolute path
 *
 * **Does NOT mkdir** — the directory is materialised lazily by the producing
 * tool (write_file mkdirs parent before write; create_pdf / image gen
 * follow the same pattern). For tools that need cwd-as-existing-directory
 * (bash via child_process.spawn), the wrapped `bash` tool mkdirs `cwd`
 * defensively before delegating. Skipping the eager mkdir here means a
 * commander turn that only chats (no file output, no bash) leaves zero
 * footprint on disk — which is what users expect when the conversation
 * never produced anything.
 */
export async function getConversationWorkspacePath(uid: string, cid: string): Promise<string> {
  // Resolve the conv's project membership ONCE so workspace resolution
  // picks up the project-scoped selection (per CLAUDE.md projects feature).
  // For convs without a project this is a no-op (projectId stays undefined).
  let projectId: string | undefined;
  let title = '';
  try {
    const conv = await getConversation(uid, cid);
    if (conv) {
      title = conv.title || '';
      const pid = (conv as any).project_id;
      if (typeof pid === 'string' && pid) projectId = pid;
    } else {
      // Legacy convs (created before this feature shipped) keep using the root
      // workspace verbatim — we detect them by absence of a conversation record:
      // if the conv index has nothing for cid, the bus is operating on a phantom
      // and we don't want to spawn a directory off it. In practice every active
      // bus path runs after `chats.createConversation`, so this branch is rare.
      log.warn('conversation workspace fallback: conversation record missing', {
        cid: maskId(cid),
      });
      return getWorkspacePath(uid);
    }
  } catch (err) {
    log.warn('conversation workspace fallback: conversation lookup failed', {
      cid: maskId(cid),
      error: logErrorSummary(err),
    });
    return getWorkspacePath(uid);
  }

  const root = getWorkspacePath(uid, projectId);

  // Fast path: state already has a workspace_dir baked in.
  const cur = await readState(uid, cid);
  if (cur.workspace_dir) {
    const persistedPath = resolveConversationWorkspaceChild(root, cur.workspace_dir);
    if (persistedPath) return persistedPath;
    log.warn('conversation workspace fallback: invalid persisted directory', {
      cid: maskId(cid),
    });
    return root;
  }

  let slug = slugifyConvTitle(title);
  if (!slug) slug = pickFallbackSlug(root);
  else slug = uniquifySlug(root, slug);

  // Persist the choice. setWorkspaceDirOnce is idempotent: if a concurrent
  // call beat us to it, our slug is dropped and we re-read the winner. The
  // directory is NOT created here — see the function-level comment above.
  const persisted = await setWorkspaceDirOnce(uid, cid, slug);
  const finalSlug = persisted.workspace_dir || slug;
  // The slug is derived from the user-authored title and is itself a local
  // filename, so retain only bounded diagnostics at the logging boundary.
  log.info('conversation workspace selected', {
    cid: maskId(cid),
    title_len: title.length,
    lazy_mkdir: true,
  });
  const selectedPath = resolveConversationWorkspaceChild(root, finalSlug);
  if (selectedPath) return selectedPath;
  log.warn('conversation workspace fallback: invalid selected directory', {
    cid: maskId(cid),
  });
  return root;
}

/** The directory this conversation's agents actually ran in, or '' when it
 * cannot be named yet. A coding agent's frozen `coding_project_dir` wins,
 * matching how `bus.ts` picks a CLI cwd; everything else uses the frozen
 * per-conversation workspace subdir.
 *
 * Read-only counterpart of `getConversationWorkspacePath`: it never derives,
 * uniquifies, or persists a slug, so a caller that merely wants to interpret a
 * path an agent already wrote cannot give a chat a workspace it never had. */
export async function readConversationAuthoringDir(uid: string, cid: string): Promise<string> {
  const state = await readState(uid, cid).catch(() => null);
  if (!state) return '';
  const codingDir = String(state.coding_project_dir || '');
  if (codingDir && path.isAbsolute(codingDir)) return codingDir;
  if (!state.workspace_dir) return '';
  let projectId: string | undefined;
  try {
    const conv = await getConversation(uid, cid);
    const pid = (conv as { project_id?: unknown } | null)?.project_id;
    if (typeof pid === 'string' && pid) projectId = pid;
  } catch (err) {
    log.warn('read authoring dir: getConversation failed', {
      cid: maskId(cid),
      error: logErrorSummary(err),
    });
    return '';
  }
  return resolveConversationWorkspaceChild(
    getWorkspacePath(uid, projectId),
    state.workspace_dir,
  );
}
