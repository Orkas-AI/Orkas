/**
 * OpenClaw has no mid-run output channel: `openclaw agent --help` (2026.2.3-1)
 * offers no stream/NDJSON/progress flag, `--verbose` only sets the reply's
 * verbosity, and the backend's own header records that the reply arrives all at
 * once when the run ends. The only thing that reaches the host before that is
 * the startup `[skills]`/`[tools]` chatter on stderr.
 *
 * That matters because the shared execution budget (2026-09-08) briefly applied
 * the common "30 minutes without progress" rule here too, and the backend passes
 * the wall on to openclaw's own `--timeout`, so nothing else bounds the turn.
 * These two cases are why the runner stopped handing this backend an idle clock
 * (2026-09-12, review P3-1): the watchdog does work when it is armed, and for a
 * CLI that only speaks at the end that means killing a healthy turn and
 * discarding its answer. `runner.resolveIdleKillMs` owns who gets armed.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { openclawBackend } from '../../../../src/main/features/local_agents/backends/openclaw';

const isWindows = process.platform === 'win32';
const itPosix = isWindows ? it.skip : it;
const TEST_NODE = process.env.ORKAS_TEST_NODE || process.execPath;

function writeNodeExecutable(dir: string, name: string, source: string): string {
  const scriptName = `${name}.js`;
  fs.writeFileSync(path.join(dir, scriptName), source);
  const launcher = path.join(dir, name);
  const safeNode = TEST_NODE.replace(/'/g, `'\\''`);
  fs.writeFileSync(launcher, `#!/bin/sh\nexec '${safeNode}' "$(dirname "$0")/${scriptName}" "$@"\n`);
  fs.chmodSync(launcher, 0o755);
  return launcher;
}

/** Exercise post-startup activity; the wall watchdog separately bounds startup. */
function activityClock() {
  let last = Date.now();
  let ready = false;
  return {
    // Cold executable startup can exceed this fixture's 300ms idle window.
    // The case is about stderr progress, not the host's launch latency.
    lastEventAt: () => ready ? last : Date.now(),
    note: (event: { type: string; synthetic?: boolean }) => {
      if (event.type === 'stderr-line' || event.type === 'text-delta') ready = true;
      if (event.type !== 'idle' && event.synthetic !== true) last = Date.now();
    },
  };
}

describe('local_agents/backends/openclaw › idle clock with a fake CLI', () => {
  let tmpDir: string;
  const tmpDirs: string[] = [];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-openclaw-e2e-'));
    tmpDirs.push(tmpDir);
  });
  afterAll(async () => {
    for (const dir of tmpDirs) await fs.promises.rm(dir, { recursive: true, force: true });
  });

  itPosix('would kill a run that only speaks at startup, if it were given an idle clock', async () => {
    // The shape of a real long openclaw turn: skill/tool chatter, then nothing
    // at all until the trailing JSON. Arming the idle clock here — as the
    // unified budget briefly did — kills the run at the cap and loses the reply,
    // which is what `resolveIdleKillMs` now prevents for this backend.
    const fake = writeNodeExecutable(tmpDir, 'openclaw', `
process.stderr.write('[skills] loaded 12 skills\\n');
setTimeout(() => {
  process.stderr.write(JSON.stringify({ payloads: [{ text: 'late reply' }], meta: {} }) + '\\n');
  process.exit(0);
}, 4000);
`);
    const events: any[] = [];
    const clock = activityClock();
    await openclawBackend.run({
      binPath: fake,
      prompt: 'long task',
      cwd: tmpDir,
      signal: new AbortController().signal,
      onEvent: (event: any) => { clock.note(event); events.push(event); },
      timeoutMs: 5_000,
      idleKillMs: 300,
      lastEventAt: clock.lastEventAt,
    } as any);
    const done = events[events.length - 1];
    expect(done).toMatchObject({ type: 'done', status: 'timeout', timeoutKind: 'idle' });
    expect(events.some((event) => event.type === 'stderr-line')).toBe(true);
    expect(events.some((event) => event.type === 'text-delta')).toBe(false);
  }, 20_000);

  itPosix('keeps a run alive for as long as it writes to stderr', async () => {
    // Startup chatter alone is not enough; only a backend that keeps emitting
    // survives the same window. openclaw has no way to do this mid-run.
    const fake = writeNodeExecutable(tmpDir, 'openclaw', `
let ticks = 0;
const timer = setInterval(() => {
  ticks += 1;
  process.stderr.write('[tools] step ' + ticks + '\\n');
  if (ticks === 12) {
    clearInterval(timer);
    process.stderr.write(JSON.stringify({
      payloads: [{ text: 'done reply' }],
      meta: { agentMeta: { sessionId: 'sess-openclaw' } },
    }) + '\\n');
    process.exit(0);
  }
}, 100);
`);
    const events: any[] = [];
    const clock = activityClock();
    await openclawBackend.run({
      binPath: fake,
      prompt: 'chatty task',
      cwd: tmpDir,
      signal: new AbortController().signal,
      onEvent: (event: any) => { clock.note(event); events.push(event); },
      timeoutMs: 5_000,
      idleKillMs: 300,
      lastEventAt: clock.lastEventAt,
    } as any);
    const done = events[events.length - 1];
    expect(done, JSON.stringify(events)).toMatchObject({ type: 'done', status: 'completed', sessionId: 'sess-openclaw' });
    expect(done.output).toContain('done reply');
  }, 20_000);
});
