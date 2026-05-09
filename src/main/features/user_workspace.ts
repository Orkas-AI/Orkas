/**
 * User Workspace — manages the user-facing working directory.
 *
 * Each user can select a local directory as their "workspace" where agent
 * output, intermediate products, and final deliverables are stored. If no
 * directory has been chosen, the default `userWorkSpace/` folder (created at
 * startup by paths.ensureLayout) is used.
 *
 * The per-user selection is persisted in a JSON file under
 * `data/user_workspaces/<user_id>.json` so it survives restarts. The
 * Electron dialog for folder selection is triggered from IPC; this module
 * owns the config read/write + validation logic.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { dialog, BrowserWindow, shell } from 'electron';

import { DEFAULT_USER_WORKSPACE, userWorkspaceConfigFile } from '../paths';
import { createLogger } from '../logger';
import { t } from '../i18n';
import { pruneOrphans } from './file_indexer';

const log = createLogger('user-workspace');

// ── Config persistence ──────────────────────────────────────────────────

/** Shape of the per-user workspace config file. */
interface WorkspaceConfig {
  /** Absolute path to the chosen directory (or empty → use default). */
  selectedPath: string;
  /** ISO timestamp of last change. */
  updatedAt: string;
  /** Recently used workspace paths (most recent first, excludes current & default). */
  recentPaths?: string[];
}

// "Which folder did you pick" — stored in the user's local (non-synced) domain
// at `<uid>/local/workspace.json`. Absolute paths are host-specific so this
// must never leave the machine.
function configPath(userId: string): string {
  return userWorkspaceConfigFile(userId);
}

const MAX_RECENT = 5;

function readConfig(userId: string): WorkspaceConfig {
  const p = configPath(userId);
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    const obj = JSON.parse(raw);
    return {
      selectedPath: typeof obj.selectedPath === 'string' ? obj.selectedPath : '',
      updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : '',
      recentPaths: Array.isArray(obj.recentPaths) ? obj.recentPaths.filter((p: unknown) => typeof p === 'string') : [],
    };
  } catch {
    return { selectedPath: '', updatedAt: '', recentPaths: [] };
  }
}

function writeConfig(userId: string, cfg: WorkspaceConfig): void {
  const p = configPath(userId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf-8');
  fs.renameSync(tmp, p);
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Return the effective workspace path for a user. Falls back to the
 * default directory if nothing was selected or the selected path no longer
 * exists.
 */
export function getWorkspacePath(userId: string): string {
  const cfg = readConfig(userId);
  if (cfg.selectedPath) {
    try {
      const stat = fs.statSync(cfg.selectedPath);
      if (stat.isDirectory()) return cfg.selectedPath;
    } catch {
      // selected path is gone — fall through to default
      log.warn('selected workspace path no longer exists, falling back to default', {
        userId,
        path: cfg.selectedPath,
      });
    }
  }
  return DEFAULT_USER_WORKSPACE;
}

/**
 * Persist a user-chosen workspace path. The directory must exist.
 * Returns `{ ok: true, path }` or `{ ok: false, error }`.
 */
export function setWorkspacePath(
  userId: string,
  dirPath: string,
): { ok: true; path: string } | { ok: false; error: string } {
  const resolved = path.resolve(dirPath);
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      return { ok: false, error: t('errors.path_not_dir') };
    }
  } catch {
    return { ok: false, error: t('errors.dir_not_exists') };
  }

  // Track the old path in recents (if it's not the default)
  const oldCfg = readConfig(userId);
  const recents = (oldCfg.recentPaths || []).slice();
  if (oldCfg.selectedPath && oldCfg.selectedPath !== resolved) {
    // Remove if already in recents, then prepend
    const idx = recents.indexOf(oldCfg.selectedPath);
    if (idx !== -1) recents.splice(idx, 1);
    recents.unshift(oldCfg.selectedPath);
  }
  // Also remove the new path from recents if present
  const newIdx = recents.indexOf(resolved);
  if (newIdx !== -1) recents.splice(newIdx, 1);

  writeConfig(userId, {
    selectedPath: resolved,
    updatedAt: new Date().toISOString(),
    recentPaths: recents.slice(0, MAX_RECENT),
  });
  log.info('workspace path updated', { userId, path: resolved });
  _sweepFileCacheForWorkspace(userId, resolved);
  return { ok: true, path: resolved };
}

/**
 * Reset to the default workspace directory.
 */
export function resetWorkspacePath(userId: string): { ok: true; path: string } {
  const oldCfg = readConfig(userId);
  const recents = (oldCfg.recentPaths || []).slice();
  // Track old selection in recents if non-default
  if (oldCfg.selectedPath) {
    const idx = recents.indexOf(oldCfg.selectedPath);
    if (idx !== -1) recents.splice(idx, 1);
    recents.unshift(oldCfg.selectedPath);
  }
  writeConfig(userId, {
    selectedPath: '',
    updatedAt: new Date().toISOString(),
    recentPaths: recents.slice(0, MAX_RECENT),
  });
  log.info('workspace path reset to default', { userId });
  _sweepFileCacheForWorkspace(userId, DEFAULT_USER_WORKSPACE);
  return { ok: true, path: DEFAULT_USER_WORKSPACE };
}

/** Workspace switched — drop file_cache entries whose source lives outside
 *  the new workspace. Fire-and-forget; cache pruning failure must not
 *  fail the user-visible "switch workspace" action. */
function _sweepFileCacheForWorkspace(userId: string, workspacePath: string): void {
  pruneOrphans(userId, { workspacePath })
    .then((r) => {
      if (r.deleted > 0) {
        log.info(`file_cache sweep on workspace switch deleted=${r.deleted}`, { userId, workspacePath });
      }
    })
    .catch((err) => {
      log.warn(`file_cache sweep on workspace switch failed: ${(err as Error).message}`, { userId, workspacePath });
    });
}

/**
 * Return full workspace info for rendering the dropdown:
 * current effective path, default path, and recent paths (validated).
 */
export function getWorkspaceInfo(userId: string): {
  currentPath: string;
  defaultPath: string;
  isDefault: boolean;
  recentPaths: string[];
} {
  const cfg = readConfig(userId);
  const currentPath = getWorkspacePath(userId);
  const isDefault = !cfg.selectedPath || currentPath === DEFAULT_USER_WORKSPACE;
  // Filter recents: only keep directories that still exist and aren't current/default
  const recentPaths = (cfg.recentPaths || []).filter(p => {
    if (p === currentPath || p === DEFAULT_USER_WORKSPACE) return false;
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
  });
  return { currentPath, defaultPath: DEFAULT_USER_WORKSPACE, isDefault, recentPaths };
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
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
}

/**
 * Sweep the active workspace root, removing any empty top-level
 * subdirectory. Existing empty per-conversation slug dirs (legacy from
 * before bash's cold-path rmdir-if-empty was added in `local-tools.ts`,
 * or any future tool that mkdir'd then produced nothing) get cleaned up
 * on every boot. Best-effort: any rmdir failure (non-empty / EACCES /
 * concurrent in-flight bash) is silently swallowed.
 *
 * Only the immediate top level of the workspace is scanned; deeper
 * empty subdirs are the user's own scaffolding and out of scope.
 */
export function sweepEmptyConvDirs(userId: string): { swept: number } {
  const root = getWorkspacePath(userId);
  let swept = 0;
  let entries: string[];
  try { entries = fs.readdirSync(root); }
  catch { return { swept: 0 }; }
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
  if (swept > 0) log.info('swept empty workspace subdirs', { userId, swept, root });
  return { swept };
}

/**
 * Reveal a user's current workspace directory in the OS file manager
 * (Finder / Explorer / Nautilus). Falls back to the default directory if the
 * selection is gone.
 */
export async function openWorkspaceInFileManager(
  userId: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const target = getWorkspacePath(userId);
  try {
    const stat = fs.statSync(target);
    if (!stat.isDirectory()) return { ok: false, error: t('errors.target_not_dir') };
  } catch {
    return { ok: false, error: t('errors.dir_not_exists') };
  }
  const err = await shell.openPath(target);
  if (err) {
    log.warn('failed to open workspace path', { userId, path: target, err });
    return { ok: false, error: err };
  }
  return { ok: true, path: target };
}
