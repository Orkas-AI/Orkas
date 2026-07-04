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
 * Per-test isolation (`test.isolate: true` in `vitest.config.ts`) plus each
 * test's own `vi.resetModules()` + dynamic `await import()` still works on
 * top of this — those tests override env first, then re-import paths, and
 * get their own tmp. Tests that *don't* bother with env setup simply
 * inherit this global tmp, which is harmless (they write junk into a
 * throwaway dir) and — crucially — never write to the real `PC/data/`.
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

if (!process.env.ORKAS_WORKSPACE_ROOT) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-vitest-'));
  process.env.ORKAS_WORKSPACE_ROOT = tmp;
}
