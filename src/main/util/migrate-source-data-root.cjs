/**
 * One-shot migration: move pre-unification source-run `<repoRoot>/data`
 * and `<repoRoot>/userWorkSpace` into the unified install container
 * (`<container>/data` + `<container>/userWorkSpace`).
 *
 * Before the data-root unification, source-run (`./run.sh`) wrote into
 * `OpenSource/OrkasOpen/data/`, while packaged builds wrote into
 * `~/.orkas/data/`. This migration runs once at boot to fold the
 * source-run tree into the container, so dev and packaged share data
 * going forward.
 *
 * Runs at boot, BEFORE `paths.ts` is loaded — paths.ts reads
 * `ORKAS_WORKSPACE_ROOT` at module-load time, so the env var must be set
 * and the data must be in place before any feature module loads.
 *
 * Strategy: overlay merge. Per-file conflicts resolve to src
 * (`<repoRoot>/data` wins); target-only paths are preserved (e.g. a uid
 * subtree from an existing packaged run survives). The single special
 * case is the top-level `users.json` — a strict src-wins overwrite would
 * orphan target uids (their `<uid>/` subtree survives but they vanish
 * from the registry). So `users.json` is unioned: `users[]` = de-duped
 * union of both sides, `current_user_id` = src's (the dev side is the
 * active side); if src's pointer is dangling, fall back to dst's, then
 * to any uid in the union.
 *
 * Idempotent via stamp file `<container>/data/.migrated-from-source`.
 *
 * Cannot import from `paths.ts` (paths.ts loads later in the boot sequence
 * and depends on the env var this util's caller will set). Repo root is
 * resolved from `__dirname` directly.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const STAMP_FILENAME = '.migrated-from-source';

function migrateSourceDataRoot(targetContainer, repoRootOverride) {
  // __dirname = OrkasOpen/src/main/util → up three for OrkasOpen/.
  const repoRoot = repoRootOverride || path.resolve(__dirname, '..', '..', '..');
  const srcData = path.join(repoRoot, 'data');
  const srcWs = path.join(repoRoot, 'userWorkSpace');
  const tgtData = path.join(targetContainer, 'data');
  const tgtWs = path.join(targetContainer, 'userWorkSpace');
  const stamp = path.join(tgtData, STAMP_FILENAME);

  if (existsAndStampPresent(stamp)) return;

  // ── data ──
  if (existsAndNonEmpty(srcData)) {
    fs.mkdirSync(tgtData, { recursive: true });
    overlayCopyData(srcData, tgtData);
    safeRm(srcData);
  }

  // ── userWorkSpace ──
  if (existsAndNonEmpty(srcWs)) {
    fs.mkdirSync(tgtWs, { recursive: true });
    fs.cpSync(srcWs, tgtWs, { recursive: true, force: true });
    safeRm(srcWs);
  }

  // Defensive cleanup: if a source dir exists but is empty (so the branch
  // above didn't fire), still remove it so the repo root stays clean.
  rmDirIfExists(srcData);
  rmDirIfExists(srcWs);

  // Stamp the target so subsequent boots short-circuit.
  fs.mkdirSync(path.dirname(stamp), { recursive: true });
  fs.writeFileSync(
    stamp,
    JSON.stringify({ at: new Date().toISOString() }, null, 2),
    'utf8',
  );
}

function existsAndStampPresent(stamp) {
  try {
    return fs.statSync(stamp).isFile();
  } catch {
    return false;
  }
}

function existsAndNonEmpty(dir) {
  try {
    const st = fs.statSync(dir);
    if (!st.isDirectory()) return false;
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

function rmDirIfExists(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

function safeRm(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    process.stderr.write(
      `[migrate-source-data-root] failed to remove ${dir}: ${err.message}\n`,
    );
  }
}

/**
 * Overlay-copy `src` onto `dst` with `users.json` unioned at the top level.
 *
 * Sequence matters: `fs.cpSync(force:true)` would overwrite `<dst>/users.json`
 * with src's plain users.json, undoing any union we computed beforehand. So:
 *   1. cpSync EXCLUDING the top-level users.json (filter callback).
 *   2. Compute the union and write it explicitly.
 *
 * Both target-only and src-only files survive after this — that's the
 * default cpSync behaviour (no `--delete` flag).
 */
function overlayCopyData(src, dst) {
  const srcUsers = path.join(src, 'users.json');

  fs.cpSync(src, dst, {
    recursive: true,
    force: true,
    filter: (s) => s !== srcUsers,
  });

  unionUsersJson(srcUsers, path.join(dst, 'users.json'));
}

function unionUsersJson(srcFile, dstFile) {
  const srcDoc = readUsersJsonOrNull(srcFile);
  const dstDoc = readUsersJsonOrNull(dstFile);

  if (!srcDoc) return; // Nothing to merge (no src users.json).
  if (!dstDoc) {
    // Target had no users.json → just write src's verbatim.
    fs.writeFileSync(dstFile, JSON.stringify(srcDoc, null, 2), 'utf8');
    return;
  }

  // Union by user_id. Target first (preserves target-only uids),
  // src wins on per-uid metadata if duplicates ever occur.
  const byId = new Map();
  for (const u of dstDoc.users) byId.set(u.user_id, u);
  for (const u of srcDoc.users) byId.set(u.user_id, u);

  // current_user_id: src wins by default (dev side is the active side).
  // Fall back to dst's, then to any uid in the union, if src's points at
  // a uid missing from users[] — e.g. a mid-creation crash on the dev
  // side left a dangling current_user_id. Without this guard
  // `initActiveUser` would silently create a third uid via the
  // not-found fallback path, hiding both real uids from the user.
  let chosen = srcDoc.current_user_id;
  if (!byId.has(chosen)) {
    if (dstDoc.current_user_id && byId.has(dstDoc.current_user_id)) {
      chosen = dstDoc.current_user_id;
    } else {
      chosen = byId.size > 0 ? Array.from(byId.values())[0].user_id : '';
    }
  }

  const merged = {
    current_user_id: chosen,
    users: Array.from(byId.values()).sort((a, b) =>
      String(a.created_at).localeCompare(String(b.created_at)),
    ),
  };
  fs.writeFileSync(dstFile, JSON.stringify(merged, null, 2), 'utf8');
}

function readUsersJsonOrNull(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return null;
    const cur = typeof obj.current_user_id === 'string' ? obj.current_user_id : '';
    const users = Array.isArray(obj.users)
      ? obj.users.filter(
          (r) =>
            !!r &&
            typeof r === 'object' &&
            typeof r.user_id === 'string' &&
            typeof r.created_at === 'string',
        )
      : [];
    return { current_user_id: cur, users };
  } catch {
    return null;
  }
}

module.exports = { migrateSourceDataRoot, unionUsersJson };
