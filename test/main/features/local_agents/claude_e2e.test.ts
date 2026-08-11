/**
 * End-to-end-ish smoke test for the claude backend without requiring
 * the real `claude` CLI installed. We synthesize a tiny Node-backed CLI
 * that emits valid stream-json on stdout and then exits, then exercise
 * `claudeBackend.run` against it. On Windows the fixture is launched via
 * a .cmd shim, matching the npm-global CLI mechanism used in production.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { claudeBackend } from '../../../../src/main/features/local_agents/backends/claude';

const isWindows = process.platform === 'win32';
const itPosix = isWindows ? it.skip : it;
const TEST_NODE = process.env.ORKAS_TEST_NODE || process.execPath;

function writeNodeExecutable(dir: string, name: string, source: string): string {
  const scriptName = `${name}.js`;
  fs.writeFileSync(path.join(dir, scriptName), source);
  if (isWindows) {
    const launcher = path.join(dir, `${name}.cmd`);
    fs.writeFileSync(launcher, `@echo off\r\n"${TEST_NODE}" "%~dp0${scriptName}" %*\r\n`);
    return launcher;
  }
  const launcher = path.join(dir, name);
  const safeNode = TEST_NODE.replace(/'/g, `'\\''`);
  fs.writeFileSync(launcher, `#!/bin/sh\nexec '${safeNode}' "$(dirname "$0")/${scriptName}" "$@"\n`);
  fs.chmodSync(launcher, 0o755);
  return launcher;
}

function emitAfterPrompt(lines: string[]): string {
  return `process.stdin.once('data', () => {\n  process.stdout.write(${JSON.stringify(`${lines.join('\n')}\n`)});\n});\n`;
}

describe('local_agents/backends/claude › end-to-end with fake CLI', () => {
  let tmpDir: string;
  const tmpDirs: string[] = [];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-claude-e2e-'));
    tmpDirs.push(tmpDir);
  });
  afterAll(async () => {
    for (const dir of tmpDirs) {
      // Async retries yield to the child-process close callbacks that release
      // Windows .cmd and working-directory handles. A synchronous retry loop
      // can keep those callbacks starved for its entire retry window.
      await fs.promises.rm(dir, {
        recursive: true,
        force: true,
        maxRetries: isWindows ? 50 : 0,
        retryDelay: isWindows ? 100 : 0,
      });
    }
  });

  it('parses a minimal completed conversation', async () => {
    // fake CLI reads one stdin line (the user message JSON) and then
    // emits its stream-json output. We can't EOF-wait the way a real
    // pipeline would (`cat > /dev/null`) because the backend now keeps
    // stdin open for the whole turn to handle control_request — same
    // contract real claude code has.
    const fake = writeNodeExecutable(tmpDir, 'claude', emitAfterPrompt([
      '{"type":"system","subtype":"init","session_id":"sess-fake","cwd":"/x"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Hello "}]}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"world."}]}}',
      '{"type":"result","subtype":"success","result":"Hello world.","total_cost_usd":0,"duration_ms":1}',
    ]));
    const events: any[] = [];
    const ac = new AbortController();
    await claudeBackend.run({
      binPath: fake,
      prompt: 'hi',
      cwd: tmpDir,
      signal: ac.signal,
      onEvent: e => events.push(e),
      timeoutMs: 5000,
    });
    const types = events.map(e => e.type);
    expect(types).toContain('process-info');
    expect(types).toContain('text-delta');
    expect(types[types.length - 1]).toBe('done');
    const done = events[events.length - 1];
    expect(done.status).toBe('completed');
    expect(done.output).toBe('Hello world.');
    expect(done.sessionId).toBe('sess-fake');
  });

  it('classifies non-JSON stdout before and after session initialization', async () => {
    const fake = writeNodeExecutable(tmpDir, 'claude', `
process.stdin.once('data', () => {
  process.stdout.write('startup banner\\n');
  process.stdout.write('{"type":"system","subtype":"init","session_id":"sess-diagnostics","cwd":"/x"}\\n');
  process.stdout.write('post-init diagnostic\\n');
  process.stdout.write('{"type":"result","subtype":"success","result":"done"}\\n');
});
`);
    const events: any[] = [];

    await claudeBackend.run({
      binPath: fake,
      prompt: 'diagnose',
      cwd: tmpDir,
      signal: new AbortController().signal,
      onEvent: event => events.push(event),
      timeoutMs: 3_000,
    });

    expect(events).toContainEqual({
      type: 'text-delta',
      text: 'startup banner\n',
    });
    expect(events).toContainEqual({
      type: 'raw-line',
      line: 'post-init diagnostic',
    });
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      status: 'completed',
      output: 'done',
    });
  });

  itPosix('settles on the result record even when background work keeps the CLI alive', async () => {
    const fake = writeNodeExecutable(tmpDir, 'claude', `
process.stdin.once('data', () => {
  process.stdout.write('{"type":"system","subtype":"init","session_id":"sess-linger","cwd":"/x"}\\n');
  process.stdout.write('{"type":"system","subtype":"api_retry","attempt":2,"max_retries":4,"retry_delay_ms":100,"error_status":503,"error":"temporary outage"}\\n');
  process.stdout.write('{"type":"system","subtype":"task_started","task_id":"bg-1","task_type":"shell","description":"watching files"}\\n');
  process.stdout.write('{"type":"system","subtype":"task_progress","task_id":"bg-1","subagent_type":"shell","summary":"still watching"}\\n');
  process.stdout.write('{"type":"tool_progress","tool_use_id":"tool-1","tool_name":"Bash","task_id":"bg-1","elapsed_time_seconds":1.5}\\n');
  process.stdout.write('{"type":"assistant","message":{"content":[{"type":"tool_use","id":"read-1","name":"Read","input":{"file":"a.md"}},{"type":"tool_use","id":"bash-1","name":"Bash","input":{"command":"npm test"}}]}}\\n');
  process.stdout.write('{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"read-1","content":"read ok"},{"type":"tool_result","tool_use_id":"bash-1","content":"tests ok"}]}}\\n');
  process.stdout.write('{"type":"system","subtype":"hook_started","hook_id":"hook-1","hook_name":"lint","hook_event":"PostToolUse"}\\n');
  process.stdout.write('{"type":"system","subtype":"hook_response","hook_id":"hook-1","hook_name":"lint","stdout":"ok"}\\n');
  process.stdout.write('{"type":"system","subtype":"task_notification","task_id":"bg-1","status":"completed","summary":"watch complete"}\\n');
  process.stdout.write('{"type":"result","subtype":"success","result":"finished"}\\n');
  setInterval(() => {}, 1_000);
});
`);
    const events: any[] = [];
    let pid = -1;
    const startedAt = Date.now();

    try {
      await claudeBackend.run({
        binPath: fake,
        prompt: 'start background work',
        cwd: tmpDir,
        signal: new AbortController().signal,
        onEvent: event => {
          events.push(event);
          if (event.type === 'process-info') pid = Number(event.pid);
        },
        timeoutMs: 5_000,
      });

      // Process startup is noisy under the parallel Electron test runner.
      // The old close-driven behavior waits for the 5s watchdog; resolving
      // comfortably below that still proves the protocol terminal settled it.
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      expect(events).toContainEqual(expect.objectContaining({
        type: 'status',
        status: 'background-started',
        taskId: 'bg-1',
      }));
      expect(events).toContainEqual(expect.objectContaining({
        type: 'status',
        status: 'retrying',
        attempt: 2,
        errorStatus: 503,
      }));
      expect(events).toContainEqual(expect.objectContaining({
        type: 'status',
        status: 'background-running',
        message: 'still watching',
      }));
      expect(events).toContainEqual(expect.objectContaining({
        type: 'status',
        status: 'tool-progress',
        tool: 'Bash',
        elapsedSeconds: 1.5,
      }));
      expect(events.filter(event => (
        event.type === 'tool-event'
        && event.phase === 'use'
        && (event.callId === 'read-1' || event.callId === 'bash-1')
      ))).toHaveLength(2);
      expect(events.filter(event => (
        event.type === 'tool-event'
        && event.phase === 'result'
        && (event.callId === 'read-1' || event.callId === 'bash-1')
      ))).toHaveLength(2);
      expect(events).toContainEqual(expect.objectContaining({
        type: 'tool-event',
        tool: 'hook:lint',
        phase: 'use',
      }));
      expect(events).toContainEqual(expect.objectContaining({
        type: 'tool-event',
        tool: 'hook:lint',
        phase: 'result',
        output: 'ok',
      }));
      expect(events).toContainEqual(expect.objectContaining({
        type: 'status',
        status: 'background-completed',
        message: 'watch complete',
      }));
      expect(events.at(-1)).toMatchObject({
        type: 'done',
        status: 'completed',
        output: 'finished',
      });
      expect(events.filter(event => event.type === 'done')).toHaveLength(1);
      await expectProcessToExit(pid, 2_000);
    } finally {
      if (pid > 0) {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* already exited */ }
      }
    }
  });

  itPosix('settles a failed result before a lingering CLI process exits', async () => {
    const fake = writeNodeExecutable(tmpDir, 'claude', `
process.stdin.once('data', () => {
  process.stdout.write('{"type":"system","subtype":"init","session_id":"sess-failed","cwd":"/x"}\\n');
  process.stdout.write('{"type":"result","subtype":"error_during_execution","errors":["network failed","retry limit reached"]}\\n');
  setInterval(() => {}, 1_000);
});
`);
    const events: any[] = [];
    let pid = -1;
    const startedAt = Date.now();

    try {
      await claudeBackend.run({
        binPath: fake,
        prompt: 'fail after retrying',
        cwd: tmpDir,
        signal: new AbortController().signal,
        onEvent: event => {
          events.push(event);
          if (event.type === 'process-info') pid = Number(event.pid);
        },
        timeoutMs: 5_000,
      });

      expect(Date.now() - startedAt).toBeLessThan(3_000);
      expect(events.at(-1)).toMatchObject({
        type: 'done',
        status: 'failed',
        error: 'network failed\nretry limit reached',
      });
      expect(events.filter(event => event.type === 'done')).toHaveLength(1);
      await expectProcessToExit(pid, 2_000);
    } finally {
      if (pid > 0) {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* already exited */ }
      }
    }
  });

  it('captures a session id carried only by the terminal result record', async () => {
    const fake = writeNodeExecutable(tmpDir, 'claude', emitAfterPrompt([
      '{"type":"result","subtype":"success","session_id":"sess-result-only","result":"done"}',
    ]));
    const events: any[] = [];

    await claudeBackend.run({
      binPath: fake,
      prompt: 'finish',
      cwd: tmpDir,
      signal: new AbortController().signal,
      onEvent: event => events.push(event),
      timeoutMs: 3_000,
    });

    expect(events.at(-1)).toMatchObject({
      type: 'done',
      status: 'completed',
      sessionId: 'sess-result-only',
      output: 'done',
    });
  });

  it('reports failed status when the CLI exits non-zero', async () => {
    const fake = writeNodeExecutable(tmpDir, 'claude', `
process.stderr.write('boom: model unavailable\\n');
process.exit(7);
`);
    const events: any[] = [];
    await claudeBackend.run({
      binPath: fake,
      prompt: 'hi', cwd: tmpDir,
      signal: new AbortController().signal,
      onEvent: e => events.push(e),
      timeoutMs: 5000,
    });
    const done = events[events.length - 1];
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/exited with code 7|reported error/);
  });

  it('reports a spawn failure as one terminal event', async () => {
    const events: any[] = [];

    await claudeBackend.run({
      binPath: path.join(tmpDir, 'missing-claude-binary'),
      prompt: 'hi',
      cwd: tmpDir,
      signal: new AbortController().signal,
      onEvent: event => events.push(event),
      timeoutMs: 3_000,
    });

    expect(events.at(-1)).toMatchObject({
      type: 'done',
      status: 'failed',
      error: expect.stringMatching(/ENOENT|not found/i),
    });
    expect(events.filter(event => event.type === 'done')).toHaveLength(1);
  });

  it('cancels mid-run via AbortSignal (SIGTERM)', async () => {
    const fake = writeNodeExecutable(tmpDir, 'claude', `setInterval(() => {}, 1_000);\n`);
    const events: any[] = [];
    const ac = new AbortController();
    const promise = claudeBackend.run({
      binPath: fake,
      prompt: 'hi', cwd: tmpDir,
      signal: ac.signal,
      onEvent: e => events.push(e),
      timeoutMs: 30_000,
    });
    setTimeout(() => ac.abort(), 100);
    await promise;
    const done = events[events.length - 1];
    expect(done.status).toBe('cancelled');
  });

  it('reports timeout when Claude never emits a terminal result', async () => {
    const fake = writeNodeExecutable(tmpDir, 'claude', `setInterval(() => {}, 1_000);\n`);
    const events: any[] = [];

    await claudeBackend.run({
      binPath: fake,
      prompt: 'hi',
      cwd: tmpDir,
      signal: new AbortController().signal,
      onEvent: event => events.push(event),
      timeoutMs: 100,
    });

    expect(events.at(-1)).toMatchObject({
      type: 'done',
      status: 'timeout',
    });
    expect(events.filter(event => event.type === 'done')).toHaveLength(1);
  });

  it('accumulates assistant.message.usage and emits running status:usage events', async () => {
    // Two assistant blocks in sequence, each with its own usage
    // snapshot. We expect TWO status:usage events with cumulative
    // running totals (mirrors multica's per-model usage map but
    // collapsed to a single flat record).
    const fake = writeNodeExecutable(tmpDir, 'claude', emitAfterPrompt([
      '{"type":"system","subtype":"init","session_id":"s-acc","cwd":"/x"}',
      '{"type":"assistant","message":{"model":"claude-opus-4-7","content":[{"type":"text","text":"part 1"}],"usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":1000,"cache_creation_input_tokens":20}}}',
      '{"type":"assistant","message":{"model":"claude-opus-4-7","content":[{"type":"text","text":"part 2"}],"usage":{"input_tokens":10,"output_tokens":40,"cache_read_input_tokens":1100,"cache_creation_input_tokens":0}}}',
      '{"type":"result","subtype":"success","result":"done","usage":{"input_tokens":110,"output_tokens":90,"cache_read_input_tokens":2100,"cache_creation_input_tokens":20},"total_cost_usd":0.0234,"message":{"model":"claude-opus-4-7"}}',
    ]));
    const events: any[] = [];
    await claudeBackend.run({
      binPath: fake,
      prompt: 'go',
      cwd: tmpDir,
      signal: new AbortController().signal,
      onEvent: e => events.push(e),
      timeoutMs: 10_000,
    });
    const usageEvents = events.filter(e => e.type === 'status' && e.status === 'usage');
    expect(usageEvents).toHaveLength(2);
    expect(usageEvents[0].usage).toMatchObject({
      input: 100, output: 50, cacheRead: 1000, cacheCreate: 20, model: 'claude-opus-4-7',
    });
    // Second one should be the cumulative running total.
    expect(usageEvents[1].usage).toMatchObject({
      input: 110, output: 90, cacheRead: 2100, cacheCreate: 20,
    });
    // The terminal status:result still carries claude's authoritative
    // (already-summed) usage from the result record + the cost field.
    const resultStatus = events.find(e => e.type === 'status' && e.status === 'result');
    expect(resultStatus?.usage).toMatchObject({
      input: 110, output: 90, cacheRead: 2100, cacheCreate: 20, cost: 0.0234,
    });
    const done = events[events.length - 1];
    expect(done.status).toBe('completed');
  }, 15_000);

  it('auto-responds to control_request and surfaces a permission-request event', async () => {
    // fake CLI: reads the prompt, emits init + a control_request, then
    // reads ONE more line from stdin (our control_response) and only
    // then emits the terminal result. If the backend doesn't write the
    // response, the script blocks on its second `read` until the
    // 3-second test timeout fires — that's the silent-hang symptom
    // we're fixing.
    //
    // We tee the response we received to stderr so the test can assert
    // exactly what got written back to the CLI.
    const fake = writeNodeExecutable(tmpDir, 'claude', `
const readline = require('node:readline');
const input = readline.createInterface({ input: process.stdin });
let lineCount = 0;
input.on('line', (line) => {
  lineCount += 1;
  if (lineCount === 1) {
    process.stdout.write('{"type":"system","subtype":"init","session_id":"sess-perm","cwd":"/x"}\\n');
    process.stdout.write('{"type":"control_request","request_id":"req-42","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"ls"}}}\\n');
  } else if (lineCount === 2) {
    process.stderr.write('GOT_RESPONSE: ' + line + '\\n');
    process.stdout.write('{"type":"result","subtype":"success","result":"ok"}\\n');
    input.close();
  }
});
`);
    const events: any[] = [];
    await claudeBackend.run({
      binPath: fake,
      prompt: 'run ls',
      cwd: tmpDir,
      signal: new AbortController().signal,
      onEvent: e => events.push(e),
      timeoutMs: 3000,
    });
    const types = events.map(e => e.type);
    expect(types).toContain('permission-request');
    const perm = events.find(e => e.type === 'permission-request');
    expect(perm).toMatchObject({ id: 'req-42', tool: 'Bash', autoDecided: 'allow', reason: 'bypass' });
    // Verify the response we wrote back is a valid control_response
    // referencing the same request_id (the fake CLI tees it to stderr).
    const stderrLines = events
      .filter(e => e.type === 'stderr-line')
      .map(e => (e as any).line as string);
    const responseEcho = stderrLines.find(l => l.startsWith('GOT_RESPONSE:'));
    expect(responseEcho).toBeDefined();
    expect(responseEcho).toMatch(/"control_response"/);
    expect(responseEcho).toMatch(/"req-42"/);
    expect(responseEcho).toMatch(/"behavior":"allow"/);
    const done = events[events.length - 1];
    expect(done.status).toBe('completed');
  });

  itPosix('steers a second rich user record through the live ordered stream-json writer', async () => {
    const tracePath = path.join(tmpDir, 'stdin-records.json');
    const fake = writeNodeExecutable(tmpDir, 'claude-steer', `
const fs = require('node:fs');
const readline = require('node:readline');
const tracePath = ${JSON.stringify(tracePath)};
const records = [];
const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  const record = JSON.parse(line);
  records.push(record);
  fs.writeFileSync(tracePath, JSON.stringify(records, null, 2));
  if (records.length === 1) {
    process.stdout.write('{"type":"system","subtype":"init","session_id":"sess-steer","cwd":"/x"}\\n');
    process.stdout.write('{"type":"control_request","request_id":"req-steer","request":{"subtype":"can_use_tool","tool_name":"Read","input":{"file_path":"/tmp/a"}}}\\n');
  } else if (records.length === 3) {
    process.stdout.write('{"type":"assistant","message":{"content":[{"type":"text","text":"updated"}]}}\\n');
    process.stdout.write('{"type":"result","subtype":"success","result":"updated"}\\n');
    input.close();
  }
});
`);
    const ingressStates: any[] = [];
    let resolveIngress!: (value: any) => void;
    const ingressReady = new Promise<any>((resolve) => { resolveIngress = resolve; });
    const run = claudeBackend.run({
      binPath: fake,
      prompt: 'initial task',
      cwd: tmpDir,
      signal: new AbortController().signal,
      onEvent: () => {},
      timeoutMs: 3_000,
      onActiveRunIngress: (ingress) => {
        ingressStates.push(ingress);
        if (ingress) resolveIngress(ingress);
      },
    });

    const ingress = await ingressReady;
    const result = await ingress.submit({
      id: 'queue-claude-1',
      text: 'Use /verified/brief.pdf and the selected Skill now.',
      localImages: [{ path: '/verified/chart.png', mediaType: 'image/png' }],
    });
    await run;

    expect(result).toEqual({ mode: 'steered', acceptedId: 'queue-claude-1' });
    const records = JSON.parse(fs.readFileSync(tracePath, 'utf8'));
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({
      type: 'user',
      message: { content: [{ type: 'text', text: 'initial task' }] },
    });
    const controlRecord = records.slice(1).find((record: any) => record.type === 'control_response');
    const steerRecord = records.slice(1).find((record: any) => record.type === 'user');
    expect(controlRecord).toMatchObject({
      type: 'control_response',
      response: { request_id: 'req-steer' },
    });
    expect(steerRecord).toEqual({
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'text',
          text: 'Use /verified/brief.pdf and the selected Skill now.',
        }],
      },
    });
    expect(ingressStates[0]).toBeTruthy();
    expect(ingressStates.at(-1)).toBeNull();
  });
});

async function expectProcessToExit(pid: number, timeoutMs: number): Promise<void> {
  expect(pid).toBeGreaterThan(0);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Claude child process ${pid} is still alive after protocol completion`);
}
