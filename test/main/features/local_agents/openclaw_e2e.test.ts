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

  itPosix.each(['stdout', 'stderr'])('delivers one decoded native reply from %s without exposing its envelope as text or diagnostics', async stream => {
    const fake = writeNodeExecutable(tmpDir, 'native-output', `
const out = process[${JSON.stringify(stream)}];
const bytes = Buffer.from(JSON.stringify({payloads:[{text:'Native reply: 中文 🌍'}],meta:{agentMeta:{sessionId:'native-reply'}}}) + '\\n');
process.stderr.write('diagnostic-before-reply\\n');
let offset=0;
const timer=setInterval(()=>{if(offset>=bytes.length){clearInterval(timer);process.exit(0);return;}out.write(bytes.subarray(offset,offset+1));offset++;},1);
`);
    const events: any[] = [];
    await openclawBackend.run({ binPath: fake, prompt: 'Return the native answer', cwd: tmpDir,
      signal: new AbortController().signal, timeoutMs: 5000, onEvent: event => events.push(event) });
    expect(events.filter(event => event.type === 'text-delta').map(event => event.text)).toEqual(['Native reply: 中文 🌍']);
    expect(events.filter(event => event.type === 'stderr-line').map(event => event.line)).toEqual(['diagnostic-before-reply']);
    expect(events.filter(event => event.type === 'done')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({type:'done',status:'completed',sessionId:'native-reply'});
  });

  itPosix('rejects a structured native failure even when stdout contains payload text and exit code is zero', async () => {
    const fake = writeNodeExecutable(tmpDir, 'native-error', `
process.stdout.write(JSON.stringify({ok:false,error:{type:'model_unavailable',message:'Fixture unavailable'},payloads:[{text:'Incomplete reply'}]}));
`);
    const events: any[] = [];
    await openclawBackend.run({binPath:fake,prompt:'Do work',cwd:tmpDir,signal:new AbortController().signal,
      timeoutMs:5000,onEvent:event=>events.push(event)});
    expect(events.at(-1)).toMatchObject({type:'done',status:'failed'});
    expect(events.filter(event=>event.type==='text-delta').map(event=>event.text)).toEqual(['Incomplete reply']);
    expect(events.filter(event=>event.type==='stderr-line')).toEqual([]);
  });

  itPosix('bounds runaway native output and fails without exposing a partial protocol envelope', async () => {
    const fake = writeNodeExecutable(tmpDir, 'native-overflow', `
const child=require('node:child_process').spawn(process.execPath,['-e',"process.send('ready');setTimeout(()=>require('node:fs').writeFileSync('overflow-late-effect','survived'),1500)"],{detached:true,stdio:['ignore','ignore','ignore','ipc']});
child.once('message',()=>process.stdout.write(JSON.stringify({payloads:[{text:'x'.repeat(10*1024*1024)}],meta:{}})));
`);
    const events: any[] = [];
    await openclawBackend.run({binPath:fake,prompt:'Return bounded output',cwd:tmpDir,
      signal:new AbortController().signal,timeoutMs:5000,onEvent:event=>events.push(event)});
    await new Promise(resolve=>setTimeout(resolve,1800));
    expect(fs.existsSync(path.join(tmpDir,'overflow-late-effect'))).toBe(false);
    expect(events.at(-1)).toMatchObject({type:'done',status:'failed',error:'OpenClaw output exceeded the supported size.'});
    expect(events.some(event=>event.type==='text-delta')).toBe(false);
    expect(events.filter(event=>event.type==='done')).toHaveLength(1);
  });

  itPosix('reports the native data-directory lease refusal without retrying and recovers after release', async () => {
    const fake=writeNodeExecutable(tmpDir,'native-busy',`
const fs=require('node:fs');
if(!fs.existsSync('lease-released')){process.stdout.write(JSON.stringify({ok:false,error:{type:'cli_error',message:'Another OpenClaw process is using your data. Wait for it to finish before trying again.'}}));process.exitCode=1;}
else{fs.appendFileSync('completed-effect','once');process.stdout.write(JSON.stringify({payloads:[{text:'Ready after release'}],meta:{agentMeta:{sessionId:'released-session'}}}));}
`);
    const dispatch=async()=>{const events:any[]=[];await openclawBackend.run({binPath:fake,prompt:'Run once',cwd:tmpDir,
      signal:new AbortController().signal,timeoutMs:5000,onEvent:event=>events.push(event)});return events;};
    const busy=await dispatch();
    expect(busy.at(-1)).toMatchObject({type:'done',status:'failed',error:expect.stringContaining('Wait for it to finish')});
    expect(busy.filter(event=>event.type==='process-info')).toHaveLength(1);
    expect(busy.some(event=>event.type==='text-delta')).toBe(false);
    expect(fs.existsSync(path.join(tmpDir,'completed-effect'))).toBe(false);
    fs.writeFileSync(path.join(tmpDir,'lease-released'),'ready');
    const recovered=await dispatch();
    expect(recovered.at(-1)).toMatchObject({type:'done',status:'completed',sessionId:'released-session'});
    expect(fs.readFileSync(path.join(tmpDir,'completed-effect'),'utf8')).toBe('once');
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
