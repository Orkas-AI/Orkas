/**
 * User Workspace — manages the user-facing working directory(s).
 *
 * Each user can select a local directory as their "workspace" where agent
 * output, intermediate products, and final deliverables are stored. If no
 * directory has been chosen, the default `userWorkSpace/` folder (created at
 * startup by paths.ensureLayout) is used.
 *
 * **Scoped selection** (per CLAUDE.md §4 sync-domain split):
 *   - The default scope (no project) keeps using the existing
 *     `<uid>/local/workspace.json` config.
 *   - Each project optionally pins its own workspace; conversations under a
 *     project share that scope. Effective resolution:
 *       conv.project_id → projects[pid]?.selectedPath
 *                       ?? default.selectedPath
 *                       ?? DEFAULT_USER_WORKSPACE
 *
 * The on-disk file goes from a flat
 *   `{ selectedPath, recentPaths, updatedAt }`
 * to a scoped object
 *   `{ default: {selectedPath, recentPaths}, projects: {<pid>: {...}}, updatedAt }`
 * — `_normaliseConfig` migrates the legacy shape on first read (no
 * schema_version field; absence of `default` key is the migration signal).
 *
 * **Resolver shape**: `getWorkspacePath(uid, projectId?)` is **synchronous**.
 * Callers that have a cid (file-tools, group_chat bus, etc.) thread the
 * `project_id` through their opts pipeline rather than re-reading the conv
 * index per tool call — group_chat resolves the projectId once at the top
 * of `runTurn` and passes it down. IPC handlers that take `{cid?}` from the
 * renderer perform the cid → projectId lookup at the IPC boundary (async
 * there is fine — single hop) before calling the sync resolver.
 *
 * The Electron dialog for folder selection is triggered from IPC; this
 * module owns the config read/write + validation logic.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { dialog, BrowserWindow, shell } from 'electron';

import { DEFAULT_USER_WORKSPACE, userWorkspaceConfigFile } from '../paths';
import { createLogger } from '../logger';
import { t } from '../i18n';
import { macosTccWorkspaceBlockedPath } from '../util/macos-tcc';
import { logPathRef, logPathRefs } from '../util/log-redact';
import { pruneOrphans } from './file_indexer';

const log = createLogger('user-workspace');

// ── Config persistence ──────────────────────────────────────────────────

/** A single workspace selection entry — used for both the default scope and
 *  per-project scopes. `selectedPath` empty means "fall back to next level"
 *  (project → default → DEFAULT_USER_WORKSPACE). */
interface ScopeEntry {
  selectedPath: string;
  recentPaths: string[];
}

interface WorkspaceConfig {
  default: ScopeEntry;
  projects: Record<string, ScopeEntry>;
  updatedAt: string;
}

function configPath(userId: string): string {
  return userWorkspaceConfigFile(userId);
}

const MAX_RECENT = 5;
const EMPTY_ENTRY: ScopeEntry = { selectedPath: '', recentPaths: [] };

function _normaliseEntry(raw: any): ScopeEntry {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_ENTRY };
  return {
    selectedPath: typeof raw.selectedPath === 'string' ? raw.selectedPath : '',
    recentPaths: Array.isArray(raw.recentPaths)
      ? raw.recentPaths.filter((p: unknown) => typeof p === 'string')
      : [],
  };
}

/** Promote legacy flat `{selectedPath, recentPaths}` → scoped shape. */
function _normaliseConfig(raw: any): WorkspaceConfig {
  if (!raw || typeof raw !== 'object') {
    return { default: { ...EMPTY_ENTRY }, projects: {}, updatedAt: '' };
  }
  if (raw.default && typeof raw.default === 'object') {
    const projects: Record<string, ScopeEntry> = {};
    if (raw.projects && typeof raw.projects === 'object') {
      for (const [pid, entry] of Object.entries(raw.projects)) {
        if (typeof pid === 'string') projects[pid] = _normaliseEntry(entry);
      }
    }
    return {
      default: _normaliseEntry(raw.default),
      projects,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    };
  }
  // Legacy flat shape — promote into `default`.
  return {
    default: _normaliseEntry(raw),
    projects: {},
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
  };
}

function readConfig(userId: string): WorkspaceConfig {
  const p = configPath(userId);
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    return _normaliseConfig(JSON.parse(raw));
  } catch {
    return { default: { ...EMPTY_ENTRY }, projects: {}, updatedAt: '' };
  }
}

function writeConfig(userId: string, cfg: WorkspaceConfig): void {
  const p = configPath(userId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf-8');
  fs.renameSync(tmp, p);
}

// ── Scope helpers ────────────────────────────────────────────────────────

function _readEntry(cfg: WorkspaceConfig, projectId?: string): ScopeEntry {
  if (projectId) {
    return cfg.projects[projectId] || { ...EMPTY_ENTRY };
  }
  return cfg.default;
}

function _writeEntry(cfg: WorkspaceConfig, projectId: string | undefined, entry: ScopeEntry): WorkspaceConfig {
  if (projectId) {
    return {
      ...cfg,
      projects: { ...cfg.projects, [projectId]: entry },
      updatedAt: new Date().toISOString(),
    };
  }
  return { ...cfg, default: entry, updatedAt: new Date().toISOString() };
}

function _isWorkspaceSelectionBlocked(dirPath: string): ReturnType<typeof macosTccWorkspaceBlockedPath> {
  return macosTccWorkspaceBlockedPath(path.resolve(dirPath));
}

/** Effective path for a given scope: project's selection (if any) → default's
 *  selection (if any) → DEFAULT_USER_WORKSPACE. Privacy-protected legacy
 *  selections are never probed and never returned as execution roots. */
function _effectivePath(cfg: WorkspaceConfig, projectId?: string): string {
  if (projectId) {
    const entry = cfg.projects[projectId];
    if (entry?.selectedPath) {
      const blocked = _isWorkspaceSelectionBlocked(entry.selectedPath);
      if (blocked) {
        log.warn('project workspace path is privacy-protected — falling back without stat', {
          projectId, path: logPathRef(entry.selectedPath), reason: blocked.reason,
        });
      } else {
        try {
          if (fs.statSync(entry.selectedPath).isDirectory()) return entry.selectedPath;
        } catch {
          log.warn('project workspace path missing — falling back to default', {
            projectId, path: logPathRef(entry.selectedPath),
          });
        }
      }
    }
  }
  if (cfg.default.selectedPath) {
    const blocked = _isWorkspaceSelectionBlocked(cfg.default.selectedPath);
    if (blocked) {
      log.warn('default workspace path is privacy-protected — using DEFAULT_USER_WORKSPACE without stat', {
        path: logPathRef(cfg.default.selectedPath), reason: blocked.reason,
      });
    } else {
      try {
        if (fs.statSync(cfg.default.selectedPath).isDirectory()) return cfg.default.selectedPath;
      } catch {
        log.warn('default workspace path missing — using DEFAULT_USER_WORKSPACE', {
          path: logPathRef(cfg.default.selectedPath),
        });
      }
    }
  }
  return DEFAULT_USER_WORKSPACE;
}

function _configuredDisplayPath(cfg: WorkspaceConfig, projectId?: string): string {
  if (projectId) {
    const projectSelected = cfg.projects[projectId]?.selectedPath;
    if (projectSelected && !_isWorkspaceSelectionBlocked(projectSelected)) return projectSelected;
  }
  const selected = cfg.default.selectedPath;
  if (selected && !_isWorkspaceSelectionBlocked(selected)) return selected;
  return DEFAULT_USER_WORKSPACE;
}

function _isManagedWorkspaceRoot(dirPath: string): boolean {
  const root = path.resolve(DEFAULT_USER_WORKSPACE);
  const target = path.resolve(dirPath || '');
  return target === root || target.startsWith(root + path.sep);
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Synchronous resolver. `projectId` is optional — when omitted the default
 * scope is used. Callers with a cid in scope should resolve cid → project_id
 * once via `chats.getConversation` (async) and pass `projectId` through
 * their downstream opts (group_chat does this at the top of runTurn,
 * threading through ChatOptions / LocalToolsOpts / FileToolsOpts).
 */
export function getWorkspacePath(userId: string, projectId?: string): string {
  const cfg = readConfig(userId);
  return _effectivePath(cfg, projectId);
}

/**
 * Native file pickers should always be seeded with a safe Orkas-owned default
 * path. The historical marker file is ignored now; keeping the function name
 * avoids churn in IPC call sites while preventing macOS from restoring a
 * process-wide last-used Photos/Desktop/Library location.
 */
export function consumePickerFirstOpenDefault(userId: string): string | undefined {
  if (!userId) return undefined;
  try { return getWorkspacePath(userId); }
  catch { return undefined; }
}

/**
 * Async helper that does the cid → project_id lookup before calling the
 * sync resolver. IPC handlers that take `{cid?}` from the renderer use
 * this; main-side feature code that already knows the projectId should
 * call `getWorkspacePath` directly.
 */
export async function resolveProjectIdForCid(userId: string, cid?: string): Promise<string | undefined> {
  if (!cid) return undefined;
  try {
    const { getConversation } = await import('./chats');
    const conv = await getConversation(userId, cid);
    const pid = (conv as any)?.project_id;
    return typeof pid === 'string' && pid ? pid : undefined;
  } catch (err) {
    log.warn(`resolveProjectIdForCid cid=${cid}: ${(err as Error).message}`);
    return undefined;
  }
}

/**
 * Persist a user-chosen workspace path for a given scope. The directory
 * must exist. Returns `{ ok: true, path }` or `{ ok: false, error }`.
 */
export function setWorkspacePath(
  userId: string,
  dirPath: string,
  projectId?: string,
): { ok: true; path: string } | { ok: false; error: string } {
  const resolved = path.resolve(dirPath);
  const protectedSelection = _isWorkspaceSelectionBlocked(resolved);
  if (protectedSelection) {
    log.warn('refused privacy-protected workspace selection', {
      userId, projectId: projectId || '(default)', path: logPathRef(resolved), reason: protectedSelection.reason,
    });
    return { ok: false, error: t('errors.workspace_privacy_protected') };
  }
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) return { ok: false, error: t('errors.path_not_dir') };
  } catch {
    return { ok: false, error: t('errors.dir_not_exists') };
  }

  const cfg = readConfig(userId);
  const oldEntry = _readEntry(cfg, projectId);

  const recents = (oldEntry.recentPaths || []).slice();
  if (oldEntry.selectedPath && oldEntry.selectedPath !== resolved) {
    const idx = recents.indexOf(oldEntry.selectedPath);
    if (idx !== -1) recents.splice(idx, 1);
    recents.unshift(oldEntry.selectedPath);
  }
  const newIdx = recents.indexOf(resolved);
  if (newIdx !== -1) recents.splice(newIdx, 1);

  const next = _writeEntry(cfg, projectId, {
    selectedPath: resolved,
    recentPaths: recents.slice(0, MAX_RECENT),
  });
  writeConfig(userId, next);
  log.info('workspace path updated', { userId, projectId: projectId || '(default)', path: logPathRef(resolved) });
  _sweepFileCacheForWorkspace(userId, resolved);
  return { ok: true, path: resolved };
}

/**
 * Reset the given scope's selection. After reset, the effective path falls
 * through to the parent scope (project → default → DEFAULT_USER_WORKSPACE).
 */
export function resetWorkspacePath(userId: string, projectId?: string): { ok: true; path: string } {
  const cfg = readConfig(userId);
  const oldEntry = _readEntry(cfg, projectId);

  const recents = (oldEntry.recentPaths || []).slice();
  if (oldEntry.selectedPath) {
    const idx = recents.indexOf(oldEntry.selectedPath);
    if (idx !== -1) recents.splice(idx, 1);
    recents.unshift(oldEntry.selectedPath);
  }

  const next = _writeEntry(cfg, projectId, {
    selectedPath: '',
    recentPaths: recents.slice(0, MAX_RECENT),
  });
  writeConfig(userId, next);

  const effective = _effectivePath(next, projectId);
  log.info('workspace path reset', { userId, projectId: projectId || '(default)', effective: logPathRef(effective) });
  _sweepFileCacheForWorkspace(userId, effective);
  return { ok: true, path: effective };
}

function _sweepFileCacheForWorkspace(userId: string, workspacePath: string): void {
  pruneOrphans(userId, { workspacePath })
    .then((r) => {
      if (r.deleted > 0) {
        log.info(`file_cache sweep on workspace switch deleted=${r.deleted}`, { userId, workspacePath: logPathRef(workspacePath) });
      }
    })
    .catch((err) => {
      log.warn(`file_cache sweep on workspace switch failed: ${(err as Error).message}`, { userId, workspacePath: logPathRef(workspacePath) });
    });
}

/**
 * Return full workspace info for rendering the dropdown. `scope` tells the
 * UI which bucket the chip is acting on so the chip tooltip can show
 * context.
 */
export function getWorkspaceInfo(userId: string, projectId?: string): {
  currentPath: string;
  defaultPath: string;
  isDefault: boolean;
  recentPaths: string[];
  scope: 'default' | 'project';
  projectId?: string;
} {
  const cfg = readConfig(userId);
  const entry = _readEntry(cfg, projectId);
  // This runs on renderer boot to paint the workspace chip. Do not touch
  // protected external directories here: macOS will surface TCC prompts for
  // paths like ~/Downloads even for a simple stat. Actual selection/use still
  // validates through setWorkspacePath/getWorkspacePath.
  const currentPath = _configuredDisplayPath(cfg, projectId);
  const selectedBlocked = entry.selectedPath ? _isWorkspaceSelectionBlocked(entry.selectedPath) : null;
  const isDefault = !entry.selectedPath || !!selectedBlocked;
  const recentPaths = (entry.recentPaths || [])
    .filter((p) => p !== currentPath && p !== DEFAULT_USER_WORKSPACE)
    .filter((p) => !_isWorkspaceSelectionBlocked(p))
    .slice(0, MAX_RECENT);
  return {
    currentPath,
    defaultPath: DEFAULT_USER_WORKSPACE,
    isDefault,
    recentPaths,
    scope: projectId ? 'project' : 'default',
    ...(projectId ? { projectId } : {}),
  };
}

function _safeDirectoryPickerDefault(): string | undefined {
  const abs = path.resolve(DEFAULT_USER_WORKSPACE);
  if (macosTccWorkspaceBlockedPath(abs)) return undefined;
  try { fs.mkdirSync(abs, { recursive: true }); } catch { /* best-effort; stat below decides */ }
  try { return fs.statSync(abs).isDirectory() ? abs : undefined; }
  catch { return undefined; }
}

/**
 * Open a native folder picker dialog and return the selected path, or
 * `null` if the user cancelled. Must be called from the main process.
 */
export async function selectDirectory(): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow();
  const result = await dialog.showOpenDialog(win ? win : undefined as any, {
    title: t('workspace.picker_title'),
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: _safeDirectoryPickerDefault(),
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
}

/**
 * Sweep every workspace root the user has selected (default + each
 * per-project), removing any empty top-level subdirectory. Existing empty
 * per-conversation slug dirs (legacy from before bash's cold-path
 * rmdir-if-empty was added in `local-tools.ts`, or any future tool that
 * mkdir'd then produced nothing) get cleaned up on every boot. Best-effort:
 * any rmdir failure (non-empty / EACCES / concurrent in-flight bash) is
 * silently swallowed.
 *
 * Only the immediate top level of each workspace is scanned; deeper empty
 * subdirs are the user's own scaffolding and out of scope.
 */
export function sweepEmptyConvDirs(userId: string): { swept: number } {
  const cfg = readConfig(userId);
  const roots = new Set<string>();
  const addManagedRoot = (root: string | undefined) => {
    if (root && _isManagedWorkspaceRoot(root)) roots.add(path.resolve(root));
  };
  roots.add(path.resolve(DEFAULT_USER_WORKSPACE));
  addManagedRoot(cfg.default.selectedPath);
  for (const entry of Object.values(cfg.projects)) {
    addManagedRoot(entry?.selectedPath);
  }
  let swept = 0;
  for (const root of roots) {
    let entries: string[];
    try { entries = fs.readdirSync(root); }
    catch { continue; }
    for (const name of entries) {
      if (name.startsWith('.')) continue;  // .DS_Store, .git, etc.
      const sub = path.join(root, name);
      try {
        const st = fs.statSync(sub);
        if (!st.isDirectory()) continue;
        if (fs.readdirSync(sub).length !== 0) continue;
        fs.rmdirSync(sub);
        swept++;
      } catch { /* best-effort */ }
    }
  }
  if (swept > 0) log.info('swept empty workspace subdirs', { userId, swept, roots: logPathRefs(Array.from(roots)) });
  return { swept };
}

/**
 * Reveal a user's current workspace directory in the OS file manager
 * (Finder / Explorer / Nautilus). Falls back to the default directory if the
 * selection is gone.
 */
export async function openWorkspaceInFileManager(
  userId: string,
  projectId?: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const target = getWorkspacePath(userId, projectId);
  try {
    const stat = fs.statSync(target);
    if (!stat.isDirectory()) return { ok: false, error: t('errors.target_not_dir') };
  } catch {
    return { ok: false, error: t('errors.dir_not_exists') };
  }
  const err = await shell.openPath(target);
  if (err) {
    log.warn('failed to open workspace path', { userId, path: logPathRef(target), err });
    return { ok: false, error: err };
  }
  return { ok: true, path: target };
}

/** Drop a project's per-project workspace entry from this user's
 *  workspace.json. Called by `projects.deleteProject` cascade so deleting a
 *  project doesn't leave a dangling pid → path entry on disk. */
export function purgeProjectWorkspace(userId: string, projectId: string): void {
  const cfg = readConfig(userId);
  if (!cfg.projects[projectId]) return;
  const next: WorkspaceConfig = { ...cfg, projects: { ...cfg.projects }, updatedAt: new Date().toISOString() };
  delete next.projects[projectId];
  try { writeConfig(userId, next); }
  catch (err) { log.warn(`purge project ws user=${userId} pid=${projectId}: ${(err as Error).message}`); }
}
