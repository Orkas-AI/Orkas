/**
 * Vitest setup: force `ORKAS_WORKSPACE_ROOT` to a per-run tmp dir before
 * any test module (and therefore `src/main/paths.ts`) is imported.
 *
 * Why this is a hard requirement, not a "nice to have":
 * `paths.ts` resolves `WS_ROOT` as a *top-level module constant* from
 * `process.env.ORKAS_WORKSPACE_ROOT` at import time, and dozens of derived
 * paths (`USERS_FILE`, `userRoot(uid)`, ...) close over it. Whichever test
 * imports `paths` (or anything that transitively loads it) *first* freezes
 * `WS_ROOT`. If that first import happens before the test's own
 * `beforeEach` sets the env, `WS_ROOT` freezes to the dev default
 * `PC/data/` — every subsequent `features/users.initActiveUser()` call
 * then clobbers the developer's real `users.json` and spawns a new uid
 * skeleton under `PC/data/`.
 *
 * The same applies to an `ORKAS_WORKSPACE_ROOT` inherited from the parent
 * shell, which is why the assignment below is unconditional rather than a
 * fallback — see the comment there.
 *
 * Per-test isolation (`test.isolate: true` in `vitest.config.ts`) plus each
 * test's own `vi.resetModules()` + dynamic `await import()` still works on
 * top of this — those tests override env first, then re-import paths, and
 * get their own tmp. Tests that *don't* bother with env setup simply
 * inherit this global tmp, which is harmless (they write junk into a
 * throwaway dir) and — crucially — never write to the real data root.
 *
 * We intentionally do NOT clean the tmp dir on exit: vitest shells aren't
 * guaranteed to reach a finalizer on crashes, and the OS tmp reaper will
 * handle it. Each run gets a unique `mkdtemp` dir so stale data never
 * mingles across runs.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Register tsx/cjs so that any `require('./group_chat/bus')`-style CJS lookups
// (used inside features/chats.ts to break the bus ↔ chats import cycle without
// triggering the ESM dual-load bug described in 0268bce7) resolve `.ts` files
// under vitest. Without this hook vitest's plain-node CJS resolver fails the
// require with `Cannot find module './group_chat/bus'` and chats.deleteConversation
// silently skips purgeGroupDir, breaking the delete-cascade tests.
import 'tsx/cjs';

// Unconditional. An inherited value is exactly the case that must not win:
// `index.ts` exports `ORKAS_WORKSPACE_ROOT` into the app's own environment, so
// every process Orkas spawns — including a coding agent asked to work on this
// repo — inherits the live data root. Honouring it here froze `WS_ROOT` to
// `~/.orkas/data` and let the suite write signals, uid skeletons, and a
// rewritten `current_user_id` straight into the user's real profile.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-vitest-'));
process.env.ORKAS_WORKSPACE_ROOT = tmpRoot;

// Same inheritance, sharper edge: `users.activateUser()` pins
// `CORE_AGENT_AUTH_DIR` to the active user's `<uid>/local/config/`, and the
// app exports it to children. `src/core-agent/test/auth.test.ts` deletes the
// auth store it resolves to and restores it afterwards — so an inherited
// value has the suite round-tripping the user's real encrypted credentials,
// which a crash mid-test would take with it. Tests that need the real
// resolution order unset this themselves.
process.env.CORE_AGENT_AUTH_DIR = path.join(tmpRoot, 'core-agent-auth');
