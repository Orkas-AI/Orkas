import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { WS_ROOT } from '../src/main/paths';

// `setup-env.ts` is the only thing standing between the suite and the user's
// real profile. `paths.ts` freezes `WS_ROOT` at import time, and `users.ts`
// happily rewrites `users.json` under whatever root it froze to — so if the
// setup ever honours an inherited `ORKAS_WORKSPACE_ROOT` again, tests start
// clobbering live data instead of a throwaway dir.
//
// This canary bites hardest exactly where the bug bit: a process spawned by
// Orkas, which exports `ORKAS_WORKSPACE_ROOT=~/.orkas/data` to its children.
describe('vitest workspace-root isolation', () => {
  it('freezes WS_ROOT inside the OS tmp dir, never a real data root', () => {
    const realTmp = fs.realpathSync(os.tmpdir());
    expect(fs.realpathSync(WS_ROOT).startsWith(realTmp)).toBe(true);
    expect(path.basename(WS_ROOT)).toMatch(/^orkas-vitest-/);
  });

  it('overrides an inherited env value rather than falling back to it', () => {
    // The setup rewrote the variable, so the process no longer points at
    // whatever it inherited (`~/.orkas/data` when launched from the app).
    expect(process.env.ORKAS_WORKSPACE_ROOT).toBe(WS_ROOT);
    expect(WS_ROOT).not.toMatch(/\.orkas[/\\]data$/);
  });

  it('points the auth store at tmp, not the live credential dir', () => {
    // `auth.test.ts` deletes and restores whatever store this resolves to.
    // Inheriting the app's value aimed that at the user's real encrypted
    // `auth-profiles.json`.
    const authDir = process.env.CORE_AGENT_AUTH_DIR || '';
    expect(fs.realpathSync(path.dirname(authDir)).startsWith(fs.realpathSync(os.tmpdir()))).toBe(true);
    expect(authDir).not.toMatch(/\.orkas[/\\]data[/\\]/);
  });
});
