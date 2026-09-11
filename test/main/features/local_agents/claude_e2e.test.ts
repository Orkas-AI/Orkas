/**
 * End-to-end-ish smoke test for the claude backend without requiring
 * the real `claude` CLI installed. We synthesize a tiny Node-backed CLI
 * that emits valid stream-json on stdout and then exits, then exercise
 * `claudeBackend.run` against it. On Windows the fixture is launched via
 * a .cmd shim, matching the npm-global CLI mechanism used in production.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  CLAUDE_BACKGROUND_TIMEOUT_MS,
  claudeBackend,
} from '../../../../src/main/features/local_agents/backends/claude';
import * as userInput from '../../../../src/main/features/local_agents/cli_user_input';

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

  it('uses an exact 24-hour production background cap', () => {
    expect(CLAUDE_BACKGROUND_TIMEOUT_MS).toBe(24 * 60 * 60_000);
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
      '{"type":"result","subtype":"success","result":"  Hello world.  ","total_cost_usd":0,"duration_ms":1}',
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
    expect(done.output).toBe('  Hello world.  ');
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
      failureKind: 'cli_spawn',
      retrySafe: true,
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

  it.each([
    { outcome: 'answered', policy: 'inherit' },
    { outcome: 'answered', policy: 'ask' },
    { outcome: 'answered', policy: 'full_access' },
    { outcome: 'cancelled', policy: 'full_access' },
    { outcome: 'unavailable', policy: 'full_access' },
  ] as const)('handles AskUserQuestion as user input: $outcome with $policy', async ({ outcome, policy }) => {
    const tracePath = path.join(tmpDir, 'question-response.json');
    const fake = writeNodeExecutable(tmpDir, 'claude-question', `
const fs = require('node:fs');
const promptFlag = process.argv.indexOf('--permission-prompt-tool');
if (promptFlag === -1 || process.argv[promptFlag + 1] !== 'stdio') process.exit(2);
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const record = JSON.parse(line);
  if (record.type === 'user') {
    process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'test-question' }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'control_request', request_id: 'ask-1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [
      { question: 'Which scope?', header: 'Scope', options: [{ label: 'Current', description: 'This folder' }], multiSelect: false },
      { question: 'Which checks?', header: 'Checks', options: [{ label: 'Unit' }, { label: 'Integration' }], multiSelect: true }
    ] } } }) + '\\n');
  } else if (record.type === 'control_response') {
    fs.writeFileSync(${JSON.stringify(tracePath)}, JSON.stringify(record));
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'Continued after input.' }) + '\\n');
  }
});
`);
    const requestPermission = vi.fn();
    const requestUserInput = vi.fn(async (_request: unknown) => ({ cancelled: outcome === 'cancelled', answers: { 'question-0': ['Custom scope'], 'question-1': ['Unit', 'Integration'] } }));
    const events: any[] = [];
    await claudeBackend.run({
      binPath: fake, prompt: 'inspect files', cwd: tmpDir, signal: new AbortController().signal,
      timeoutMs: 3000, permissionPolicy: policy, requestPermission,
      ...(outcome !== 'unavailable' ? { requestUserInput } : {}), onEvent: event => events.push(event),
    });
    const response = JSON.parse(fs.readFileSync(tracePath, 'utf8')).response.response;
    expect(requestPermission).not.toHaveBeenCalled();
    if (outcome === 'answered') {
      expect(requestUserInput.mock.calls[0][0]).toMatchObject({ isBlocking: true, questions: [
        { id: 'question-0', isOther: true, multiSelect: false }, { id: 'question-1', isOther: true, multiSelect: true },
      ] });
      expect(response).toMatchObject({ behavior: 'allow', updatedInput: { answers: { 'Which scope?': 'Custom scope', 'Which checks?': 'Unit, Integration' } } });
    } else {
      expect(response.behavior).toBe('deny');
      expect(response.updatedInput).toBeUndefined();
    }
    expect(events.some(event => event.type === 'permission-request')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'completed' });
  });

  it.each(['cancel', 'terminal'])('closes Claude input on native %s and never answers a withdrawn question', async boundary => {
    const trace = path.join(tmpDir, 'cancelled-input.json');
    const fake = writeNodeExecutable(tmpDir, 'claude-cancel-input', `
const fs = require('node:fs');
const responses = [];
const send = msg => process.stdout.write(JSON.stringify(msg) + '\\n');
const finish = () => send({ type: 'result', subtype: 'success', result: 'CLI continued.' });
let users = 0;
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  fs.writeFileSync(${JSON.stringify(trace)}, JSON.stringify(responses));
  if (msg.type === 'user' && ++users === 1) {
    send({ type: 'system', subtype: 'init', session_id: 'test-input-cancel' });
    for (const id of ['ask-1', 'ask-2', 'ask-3']) send({ type: 'control_request', request_id: id, request: {
      subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: id, options: [{ label: 'Current' }] }] },
    } });
  } else if (msg.type === 'user') {
    if (${JSON.stringify(boundary)} === 'terminal') finish();
    else {
      send({ type: 'control_cancel_request', request_id: 'unknown-request' });
      send({ type: 'control_cancel_request', request_id: 'ask-2' });
      send({ type: 'control_cancel_request', request_id: 'ask-1' });
    }
  } else if (msg.type === 'control_response') {
    responses.push(msg);
    fs.writeFileSync(${JSON.stringify(trace)}, JSON.stringify(responses));
    if (msg.response.request_id === 'ask-3') finish();
  }
});
`);
    const deliveries: Array<{ channel: string; payload: any }> = [];
    const requests: string[] = [];
    const events: any[] = [];
    let ingress: any;
    userInput._setBroadcastForTest((channel, payload) => { deliveries.push({ channel, payload }); });
    const run = claudeBackend.run({
      binPath: fake, prompt: 'inspect', cwd: tmpDir, signal: new AbortController().signal,
      timeoutMs: 5000, onEvent: event => events.push(event), onActiveRunIngress: value => { ingress = value; },
      requestUserInput: request => {
        requests.push(request.id!);
        return userInput.requestUserInput({ uid: 'u-input', cid: 'c-input', runId: 'claude-input', agentId: 'claude', agentName: 'Claude', cli: 'claude', request });
      },
    });
    try {
      // Startup shares the fixture's run budget; it is not an answer timeout.
      await vi.waitFor(() => expect(deliveries.filter(row => row.channel === 'local-agent:user-input')).toHaveLength(1), { timeout: 5000 });
      const firstId = deliveries[0].payload.request_id;
      await ingress.submit({ id: 'test-control', text: 'continue' });
      await vi.waitFor(() => expect(deliveries.some(row => row.channel === 'local-agent:user-input_cancelled' && row.payload.request_ids.includes(firstId))).toBe(true));
      expect(userInput.respond(firstId, 'u-input', { 'question-0': ['Late'] })).toEqual({ handled: false });
      if (boundary === 'cancel') {
        await vi.waitFor(() => expect(requests).toEqual(['ask-1', 'ask-3']));
        const lastId = deliveries.filter(row => row.channel === 'local-agent:user-input').at(-1)!.payload.request_id;
        expect(userInput.respond(lastId, 'u-input', { 'question-0': ['Current'] })).toEqual({ handled: true, cancelled: false });
      }
      await run;
      const replies = JSON.parse(fs.readFileSync(trace, 'utf8'));
      expect(replies.map((row: any) => row.response.request_id)).toEqual(boundary === 'cancel' ? ['ask-3'] : []);
      if (boundary === 'cancel') expect(replies[0].response.response.updatedInput.answers).toEqual({ 'ask-3': 'Current' });
      else expect(requests).toEqual(['ask-1']);
      expect(events.at(-1)).toMatchObject({ type: 'done', status: 'completed' });
    } finally {
      await run;
      userInput._resetForTest();
    }
  });

  it.each(['confirmed', 'late', 'host-closed'])('claude decline is sent once across %s completion', async boundary => {
    const trace = path.join(tmpDir, 'declined-input.json');
    const fake = writeNodeExecutable(tmpDir, 'claude-decline-input', `
const fs = require('node:fs');
const replies = [];
const send = msg => process.stdout.write(JSON.stringify(msg) + '\\n');
let users = 0;
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.type === 'user' && ++users === 1) {
    send({ type: 'system', subtype: 'init', session_id: 'test-input-decline' });
    send({ type: 'control_request', request_id: 'ask-1', request: {
      subtype: 'can_use_tool', tool_name: 'AskUserQuestion', tool_use_id: 'question-tool',
      input: { questions: [{ question: 'Choose scope', options: [{ label: 'Current' }] }] },
    } });
  } else if (msg.type === 'user') {
    send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'question-tool', is_error: true, content: 'Declined' }] } });
    send({ type: 'result', subtype: 'success', result: 'CLI continued.' });
  } else if (msg.type === 'control_response') {
    replies.push(msg);
    send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'unrelated-tool', is_error: true, content: 'Declined' }] } });
    send({ type: 'assistant', message: { content: [{ type: 'text', text: 'Unrelated receipt delivered.' }] } });
    fs.writeFileSync(${JSON.stringify(trace)}, JSON.stringify(replies));
  }
});
`);
    let requestId = '';
    let ingress: any;
    const events: any[] = [];
    userInput._setBroadcastForTest((channel, payload: any) => {
      if (channel === 'local-agent:user-input') requestId = payload.request_id;
    });
    const run = claudeBackend.run({
      binPath: fake, prompt: 'inspect', cwd: tmpDir, signal: new AbortController().signal,
      timeoutMs: 15000, onEvent: event => events.push(event), onActiveRunIngress: value => { ingress = value; },
      requestUserInput: request => userInput.requestUserInput({ uid: 'u-input', cid: 'c-input', runId: 'claude-input', agentId: 'claude', agentName: 'Claude', cli: 'claude', request }),
    });
    try {
      await vi.waitFor(() => expect(requestId).not.toBe(''), { timeout: 5000 });
      let finished = false;
      const cancel = userInput.cancelRequest(requestId, 'u-input').then(result => { finished = true; return result; });
      await vi.waitFor(() => expect(events).toContainEqual({ type: 'text-delta', text: 'Unrelated receipt delivered.' }));
      expect(finished).toBe(false);
      if (boundary !== 'confirmed') {
        // The real child has consumed our reply. Withhold its receipt through
        // the host's receipt timeout; a second reply must never reach stdin.
        if (boundary === 'host-closed') userInput.cancelForRun('claude-input');
        await expect(cancel).resolves.toEqual({ handled: false, unknown: true });
        await expect(userInput.cancelRequest(requestId, 'u-input')).resolves.toEqual(
          boundary === 'host-closed' ? { handled: false, closed: true } : { handled: false, unknown: true },
        );
        expect(userInput.respond(requestId, 'u-input', { scope: ['Late answer'] })).toEqual({ handled: false });
      }
      await ingress.submit({ id: 'test-control', text: 'continue' });
      if (boundary === 'confirmed') await expect(cancel).resolves.toEqual({ handled: true, cancelled: true });
      await run;
      await expect(userInput.cancelRequest(requestId, 'u-input')).resolves.toEqual({ handled: false, closed: true });
      expect(JSON.parse(fs.readFileSync(trace, 'utf8'))).toEqual([{
        type: 'control_response', response: { subtype: 'success', request_id: 'ask-1',
          response: { behavior: 'deny', message: 'The user did not answer this question.' } },
      }]);
      expect(events.at(-1)).toMatchObject({ type: 'done', status: 'completed' });
    } finally {
      await run;
      userInput._resetForTest();
    }
  });

  it('bridges a control_request to the host and returns the user decision', async () => {
    // fake CLI: reads the prompt, emits init + a control_request, then
    // reads ONE more line from stdin (our control_response) and only
    // then emits the terminal result. If the backend doesn't write the
    // response, the script blocks on its second `read` until the
    // 3-second test timeout fires — that's the silent-hang symptom
    // we're fixing.
    //
    // Persist the response before publishing the result so the test can assert
    // the exact record without depending on ordering between stdout/stderr.
    // Those are independent OS pipes, so an stderr echo may be delivered after
    // the authoritative stdout result has already settled the backend.
    const responseTrace = path.join(tmpDir, 'permission-response.json');
    const fake = writeNodeExecutable(tmpDir, 'claude', `
const fs = require('node:fs');
const readline = require('node:readline');
const input = readline.createInterface({ input: process.stdin });
let lineCount = 0;
input.on('line', (line) => {
  lineCount += 1;
  if (lineCount === 1) {
    process.stdout.write('{"type":"system","subtype":"init","session_id":"sess-perm","cwd":"/x"}\\n');
    process.stdout.write('{"type":"control_request","request_id":"req-42","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"ls"}}}\\n');
  } else if (lineCount === 2) {
    fs.writeFileSync(${JSON.stringify(responseTrace)}, line);
    process.stderr.write('GOT_RESPONSE: ' + line + '\\n');
    process.stdout.write('{"type":"result","subtype":"success","result":"ok"}\\n');
    input.close();
  }
});
`);
    const events: any[] = [];
    const requestPermission = vi.fn(async () => 'allow_once' as const);
    await claudeBackend.run({
      binPath: fake,
      prompt: 'run ls',
      permissionPolicy: 'ask',
      requestPermission,
      cwd: tmpDir,
      signal: new AbortController().signal,
      onEvent: e => events.push(e),
      timeoutMs: 3000,
    });
    const types = events.map(e => e.type);
    expect(types).toContain('permission-request');
    const perm = events.find(e => e.type === 'permission-request');
    expect(requestPermission).toHaveBeenCalledWith(expect.objectContaining({
      id: 'req-42',
      tool: 'Bash',
      command: 'ls',
    }));
    expect(perm).toMatchObject({ id: 'req-42', tool: 'Bash', decision: 'allow', reason: 'user' });
    // Verify the response we wrote back is a valid control_response
    // referencing the same request_id.
    const response = JSON.parse(fs.readFileSync(responseTrace, 'utf8'));
    expect(response).toMatchObject({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req-42',
        response: { behavior: 'allow', updatedInput: { command: 'ls' } },
      },
    });
    const done = events[events.length - 1];
    expect(done.status).toBe('completed');
  });

  it.each([
    {
      label: 'the user denies it',
      key: 'user-deny',
      decide: async () => 'deny' as const,
    },
    {
      label: 'the host approval bridge fails',
      key: 'bridge-failure',
      decide: async () => { throw new Error('approval bridge unavailable'); },
    },
  ])('fails closed and lets Claude continue when $label', async ({ key, decide }) => {
    const fake = writeNodeExecutable(tmpDir, `claude-${key}`, `
const readline = require('node:readline');
const input = readline.createInterface({ input: process.stdin });
let lineCount = 0;
input.on('line', (line) => {
  lineCount += 1;
  if (lineCount === 1) {
    process.stdout.write('{"type":"system","subtype":"init","session_id":"sess-deny","cwd":"/x"}\\n');
    process.stdout.write('{"type":"control_request","request_id":"req-deny","request":{"subtype":"can_use_tool","tool_name":"Write","input":{"file_path":"/protected/report.txt"}}}\\n');
  } else if (lineCount === 2) {
    const response = JSON.parse(line);
    if (response.response?.response?.behavior !== 'deny') {
      process.stderr.write('permission was not denied\\n');
      process.exit(7);
    }
    process.stderr.write('GOT_DENIAL: ' + line + '\\n');
    process.stdout.write('{"type":"result","subtype":"success","result":"denied safely"}\\n');
    input.close();
  }
});
`);
    const events: any[] = [];
    const requestPermission = vi.fn(decide);

    await claudeBackend.run({
      binPath: fake,
      prompt: 'write the report',
      permissionPolicy: 'ask',
      requestPermission,
      cwd: tmpDir,
      signal: new AbortController().signal,
      onEvent: event => events.push(event),
      timeoutMs: 3_000,
    });

    expect(requestPermission).toHaveBeenCalledOnce();
    expect(events).toContainEqual(expect.objectContaining({
      type: 'permission-request',
      id: 'req-deny',
      tool: 'Write',
      decision: 'deny',
      reason: 'user',
    }));
    expect(events.filter(event => event.type === 'stderr-line'))
      .toContainEqual(expect.objectContaining({ line: expect.stringContaining('"behavior":"deny"') }));
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      status: 'completed',
      output: 'denied safely',
    });
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

  /** The 2026-08-11 incident: closing the CLI at its first result destroyed
   *  background work. A later partial fix kept the process but ended the Orkas
   *  turn, which removed loading/Stop and split the final answer. This case
   *  protects the user outcome with the background file as an independent
   *  oracle and the absence of an early `done` as the turn-lifetime oracle. */
  itPosix('keeps one pending turn through background work and its resumed answer', async () => {
    // The oracle is the background task's side effect, not the event stream:
    // that file is what the user loses when the host reaps too early. The fake
    // exits the moment stdin closes, reproducing the measured CLI behaviour
    // (exit 0 within 183–569ms of `stdin.end()`), so closing stdin destroys the
    // pending work exactly as it did in production.
    const workProof = path.join(tmpDir, 'background-work-completed.txt');
    const fake = writeNodeExecutable(tmpDir, 'claude', `
const fs = require('node:fs');
let started = false;
const w = (line) => process.stdout.write(line + '\\n');
process.stdin.on('end', () => process.exit(0));
process.stdin.on('data', (buf) => {
  if (String(buf).includes('"interrupt"')) process.exit(0);
  if (started) return;
  started = true;
  w('{"type":"system","subtype":"init","session_id":"sess-linger","cwd":"/x"}');
  w('{"type":"system","subtype":"task_started","task_id":"bg-1","task_type":"local_bash","description":"long build"}');
  w('{"type":"assistant","message":{"content":[{"type":"text","text":"main answer"}]}}');
  w('{"type":"result","subtype":"success","result":"main answer","total_cost_usd":0,"duration_ms":1}');
  setTimeout(() => {
    fs.writeFileSync(${JSON.stringify(workProof)}, 'done');
    w('{"type":"system","subtype":"task_updated","task_id":"bg-1","patch":{"status":"completed"}}');
    w('{"type":"system","subtype":"task_notification","task_id":"bg-1","status":"completed","summary":"build finished"}');
    w('{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Write","input":{"file_path":"build/report.txt"}}]}}');
    w('{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}');
    w('{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t2","name":"MultiEdit","input":{"files":["build/summary.md",{"filePath":"build/details.txt"}]}}]}}');
    w('{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t2","content":"ok"}]}}');
    w('{"type":"assistant","message":{"content":[{"type":"text","text":"the build passed"}]}}');
    w('{"type":"result","subtype":"success","result":"the build passed","usage":{"output_tokens":7},"total_cost_usd":0,"duration_ms":1}');
  }, 250);
});
`);
    const events: any[] = [];
    const backgroundHandles: any[] = [];
    let pid = 0;
    let sawFirstResult = false;
    let resolveBackground!: () => void;
    const enteredBackground = new Promise<void>(resolve => { resolveBackground = resolve; });
    let runSettled = false;

    try {
      const run = claudeBackend.run({
        binPath: fake,
        prompt: 'start the build in the background',
        cwd: tmpDir,
        signal: new AbortController().signal,
        onEvent: event => {
          events.push(event);
          if (event.type === 'process-info') pid = Number(event.pid);
          if (event.type === 'status' && event.status === 'result') sawFirstResult = true;
          if (sawFirstResult && event.type === 'status' && event.status === 'background-running') {
            resolveBackground();
          }
        },
        onBackgroundRun: handle => backgroundHandles.push(handle),
        timeoutMs: 10_000,
      });
      void run.then(() => { runSettled = true; });

      await enteredBackground;
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(runSettled).toBe(false);
      expect(events.filter(event => event.type === 'done')).toHaveLength(0);
      expect(events).toContainEqual(expect.objectContaining({
        type: 'status',
        status: 'background-running',
        taskId: 'bg-1',
        taskType: 'local_bash',
        message: 'long build',
      }));
      expect(() => process.kill(pid, 0)).not.toThrow();
      expect(backgroundHandles).toHaveLength(1);

      await run;
      expect(fs.existsSync(workProof)).toBe(true);
      expect(events.filter(event => event.type === 'done')).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({
        type: 'done',
        status: 'completed',
        output: 'main answer\n\nthe build passed',
        sessionId: 'sess-linger',
      });
      expect(events.some(event => (
        event.type === 'tool-event' && event.tool === 'Write'
      ))).toBe(true);
      await expectProcessToExit(pid, 2_000);
    } finally {
      if (pid > 0) {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* already exited */ }
      }
    }
  });

  /** A resumed foreground turn that fails must terminate the still-pending
   *  host turn with one honest failure, not append an out-of-band message. */
  itPosix('keeps a resumed foreground failure on the original turn', async () => {
    const fake = writeNodeExecutable(tmpDir, 'claude', `
let started = false;
const w = (line) => process.stdout.write(line + '\\n');
process.stdin.on('end', () => process.exit(0));
process.stdin.on('data', (buf) => {
  if (String(buf).includes('"interrupt"')) process.exit(0);
  if (started) return;
  started = true;
  w('{"type":"system","subtype":"init","session_id":"sess-fail","cwd":"/x"}');
  w('{"type":"system","subtype":"task_started","task_id":"bg-1","task_type":"local_bash","description":"long job"}');
  w('{"type":"result","subtype":"success","result":"kicked off","total_cost_usd":0,"duration_ms":1}');
  setTimeout(() => {
    w('{"type":"system","subtype":"task_notification","task_id":"bg-1","status":"completed","summary":"job finished"}');
    w('{"type":"result","subtype":"error_during_execution","error":"boom","duration_ms":1}');
  }, 250);
});
`);
    const events: any[] = [];
    let pid = 0;
    try {
      await claudeBackend.run({
        binPath: fake,
        prompt: 'start the long job',
        cwd: tmpDir,
        signal: new AbortController().signal,
        onEvent: event => {
          events.push(event);
          if (event.type === 'process-info') pid = Number(event.pid);
        },
        onBackgroundRun: () => {},
        timeoutMs: 10_000,
      });
      await expectProcessToExit(pid, 8_000);
      expect(events.filter(event => event.type === 'done')).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({
        type: 'done',
        status: 'failed',
        error: 'boom',
        output: 'kicked off',
      });
    } finally {
      if (pid > 0) {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* already exited */ }
      }
    }
  });

  /** Background progress must not slide the 24-hour hard cap. The small test
   *  override proves a busy-but-never-finishing task still ends with a
   *  structured background timeout for localized recovery copy. */
  itPosix('enforces a non-sliding background hard cap', async () => {
    const fake = writeNodeExecutable(tmpDir, 'claude', `
let started = false;
const w = (line) => process.stdout.write(line + '\\n');
process.stdin.on('data', (buf) => {
  if (String(buf).includes('"interrupt"')) process.exit(0);
  if (started) return;
  started = true;
  w('{"type":"system","subtype":"init","session_id":"sess-cap","cwd":"/x"}');
  w('{"type":"system","subtype":"task_started","task_id":"bg-1","task_type":"local_bash","description":"endless job"}');
  w('{"type":"result","subtype":"success","result":"running it","total_cost_usd":0,"duration_ms":1}');
  setInterval(() => w('{"type":"system","subtype":"task_progress","task_id":"bg-1","summary":"still running"}'), 40);
});
`);
    const events: any[] = [];
    let pid = 0;
    process.env.ORKAS_LOCAL_AGENT_BACKGROUND_TIMEOUT_MS = '250';
    try {
      await claudeBackend.run({
        binPath: fake,
        prompt: 'start the endless job',
        cwd: tmpDir,
        signal: new AbortController().signal,
        onEvent: event => {
          events.push(event);
          if (event.type === 'process-info') pid = Number(event.pid);
        },
        onBackgroundRun: () => {},
        timeoutMs: 20_000,
      });
      await expectProcessToExit(pid, 8_000);
      expect(events.filter(event => (
        event.type === 'status' && event.status === 'background-running'
      )).length).toBeGreaterThan(2);
      expect(events.at(-1)).toMatchObject({
        type: 'done',
        status: 'timeout',
        timeoutPhase: 'background',
      });
    } finally {
      delete process.env.ORKAS_LOCAL_AGENT_BACKGROUND_TIMEOUT_MS;
      if (pid > 0) {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* already exited */ }
      }
    }
  });

  /** A self-woken foreground turn may launch another background task. Each
   *  transition must remain inside the same host turn and give the new
   *  continuous background phase its own cap. */
  itPosix('supports repeated foreground and background phases in one turn', async () => {
    const workProof = path.join(tmpDir, 'second-generation-work.txt');
    const fake = writeNodeExecutable(tmpDir, 'claude', `
const fs = require('node:fs');
let started = false;
const w = (line) => process.stdout.write(line + '\\n');
process.stdin.on('data', (buf) => {
  if (String(buf).includes('"interrupt"')) process.exit(0);
  if (started) return;
  started = true;
  w('{"type":"system","subtype":"init","session_id":"sess-drain","cwd":"/x"}');
  w('{"type":"system","subtype":"task_started","task_id":"bg-1","task_type":"local_bash","description":"first job"}');
  w('{"type":"result","subtype":"success","result":"kicked off","total_cost_usd":0,"duration_ms":1}');
  setTimeout(() => {
    // The first task retires, then real assistant activity resumes foreground.
    w('{"type":"system","subtype":"task_notification","task_id":"bg-1","status":"completed","summary":"first done"}');
    w('{"type":"assistant","message":{"content":[{"type":"text","text":"starting the next stage"}]}}');
    // That resumed foreground turn starts a second background phase.
    w('{"type":"system","subtype":"task_started","task_id":"bg-2","task_type":"local_bash","description":"second job"}');
    w('{"type":"result","subtype":"success","result":"second stage running","duration_ms":1}');
  }, 100);
  setTimeout(() => {
    // The second phase stays alive until its own task and resumed result finish.
    fs.writeFileSync(${JSON.stringify(workProof)}, 'done');
    w('{"type":"system","subtype":"task_notification","task_id":"bg-2","status":"completed","summary":"second done"}');
    w('{"type":"result","subtype":"success","result":"second task done","duration_ms":1}');
  }, 800);
});
`);
    const events: any[] = [];
    let pid = 0;
    try {
      await claudeBackend.run({
        binPath: fake,
        prompt: 'start the first job',
        cwd: tmpDir,
        signal: new AbortController().signal,
        onEvent: event => {
          events.push(event);
          if (event.type === 'process-info') pid = Number(event.pid);
        },
        onBackgroundRun: () => {},
        timeoutMs: 20_000,
      });
      await expectProcessToExit(pid, 8_000);
      expect(fs.existsSync(workProof)).toBe(true);
      expect(events.filter(event => (
        event.type === 'status' && event.status === 'background-running'
      )).length).toBeGreaterThanOrEqual(2);
      expect(events.filter(event => event.type === 'done')).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({
        type: 'done',
        status: 'completed',
        output: 'kicked off\n\nsecond stage running\n\nsecond task done',
      });
    } finally {
      if (pid > 0) {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* already exited */ }
      }
    }
  });

  /** User-confirmed shared budget: background work cannot renew a dispatch. */
  itPosix('stops background work at the original dispatch deadline without resuming side effects', async () => {
    // Leave enough headroom for the fake CLI process to receive its first CPU
    // slice under the full parallel suite. The background delay still exceeds
    // the cap plus one watchdog polling quantum, so resetting or suspending
    // the watchdog would incorrectly allow the later foreground work.
    const foregroundTimeoutMs = 2_000;
    const backgroundDelayMs = foregroundTimeoutMs + Math.floor(foregroundTimeoutMs / 4) + 200;
    const fake = writeNodeExecutable(tmpDir, 'claude', `
let started = false;
const w = (line) => process.stdout.write(line + '\\n');
process.stdin.on('data', (buf) => {
  if (started) return;
  started = true;
  w('{"type":"system","subtype":"init","session_id":"sess-watchdog","cwd":"/x"}');
  w('{"type":"system","subtype":"task_started","task_id":"bg-1","task_type":"local_bash","description":"slow job"}');
  w('{"type":"result","subtype":"success","result":"kicked off","total_cost_usd":0,"duration_ms":1}');
  setTimeout(() => {
    w('{"type":"system","subtype":"task_notification","task_id":"bg-1","status":"completed","summary":"slow job done"}');
    w('{"type":"assistant","message":{"content":[{"type":"text","text":"foreground resumed"}]}}');
    // This continuation must never run after the original dispatch deadline.
  }, ${backgroundDelayMs});
});
`);
    const events: any[] = [];
    let pid = 0;
    try {
      await claudeBackend.run({
        binPath: fake,
        prompt: 'start the slow job',
        cwd: tmpDir,
        signal: new AbortController().signal,
        onEvent: event => {
          events.push(event);
          if (event.type === 'process-info') pid = Number(event.pid);
        },
        onBackgroundRun: () => {},
        timeoutMs: foregroundTimeoutMs,
      });
      expect(events).not.toContainEqual(expect.objectContaining({
        type: 'text-delta',
        text: 'foreground resumed',
      }));
      expect(events.at(-1)).toMatchObject({
        type: 'done',
        status: 'timeout',
        timeoutPhase: 'background',
        timeoutKind: 'wall',
      });
      await expectProcessToExit(pid, 2_000);
    } finally {
      if (pid > 0) {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* already exited */ }
      }
    }
  });

  /** Stop must cancel the live host turn and the CLI-owned background process
   *  tree. A terminal `cancelled` event alone is not sufficient: the delayed
   *  child side effect is the independent prohibited-effect oracle. */
  itPosix('cancels the CLI and its background child process when the user stops', async () => {
    const lateProof = path.join(tmpDir, 'must-not-exist.txt');
    const fake = writeNodeExecutable(tmpDir, 'claude', `
const { spawn } = require('node:child_process');
let started = false;
const w = (line) => process.stdout.write(line + '\\n');
process.stdin.on('data', (buf) => {
  if (String(buf).includes('"interrupt"')) return;
  if (started) return;
  started = true;
  const childSource = "setTimeout(() => require('node:fs').writeFileSync("
    + ${JSON.stringify(JSON.stringify(lateProof))}
    + ", 'late'), 700)";
  spawn(process.execPath, ['-e', childSource], { stdio: 'ignore' });
  w('{"type":"system","subtype":"init","session_id":"sess-user-stop","cwd":"/x"}');
  w('{"type":"system","subtype":"task_started","task_id":"bg-stop","task_type":"local_bash","description":"delayed write"}');
  w('{"type":"result","subtype":"success","result":"running it","duration_ms":1}');
});
setInterval(() => {}, 1_000);
`);
    const events: any[] = [];
    const controller = new AbortController();
    let resolveBackground!: () => void;
    const enteredBackground = new Promise<void>(resolve => { resolveBackground = resolve; });
    let pid = 0;

    try {
      const run = claudeBackend.run({
        binPath: fake,
        prompt: 'start the delayed write',
        cwd: tmpDir,
        signal: controller.signal,
        onEvent: event => {
          events.push(event);
          if (event.type === 'process-info') pid = Number(event.pid);
          if (event.type === 'status' && event.status === 'background-running') {
            resolveBackground();
          }
        },
        onBackgroundRun: () => {},
        timeoutMs: 10_000,
      });

      await enteredBackground;
      controller.abort();
      await run;
      await new Promise(resolve => setTimeout(resolve, 900));

      expect(events.at(-1)).toMatchObject({ type: 'done', status: 'cancelled' });
      expect(fs.existsSync(lateProof)).toBe(false);
      await expectProcessToExit(pid, 2_000);
    } finally {
      if (pid > 0) {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* already exited */ }
      }
    }
  });

  /** Quitting the app must not leave the CLI running. Its process is our child
   *  but its own process-group leader, so nothing else would end it — it would
   *  keep holding the workspace and spending the user's budget with nobody left
   *  to report to. The fake exits only on the interrupt the stop path sends. */
  itPosix('ends a background run on demand so quitting cannot orphan it', async () => {
    const fake = writeNodeExecutable(tmpDir, 'claude', `
let started = false;
const w = (line) => process.stdout.write(line + '\\n');
process.stdin.on('data', (buf) => {
  if (String(buf).includes('"interrupt"')) process.exit(0);
  if (started) return;
  started = true;
  w('{"type":"system","subtype":"init","session_id":"sess-quit","cwd":"/x"}');
  w('{"type":"system","subtype":"task_started","task_id":"long","task_type":"local_bash","description":"long job"}');
  w('{"type":"result","subtype":"success","result":"running it","total_cost_usd":0,"duration_ms":1}');
  setInterval(() => {}, 1_000);
});
`);
    let pid = 0;
    let stop: ((reason: string) => void) | null = null;
    let exited: Promise<void> | null = null;
    let resolveRegistered!: () => void;
    const registered = new Promise<void>(resolve => { resolveRegistered = resolve; });

    try {
      const run = claudeBackend.run({
        binPath: fake,
        prompt: 'start the long job',
        cwd: tmpDir,
        signal: new AbortController().signal,
        onEvent: event => { if (event.type === 'process-info') pid = Number(event.pid); },
        onBackgroundRun: handle => {
          stop = handle.stop;
          exited = handle.untilProcessExit;
          resolveRegistered();
        },
        timeoutMs: 20_000,
      });

      await registered;
      // The task never finishes, so nothing else will end this process.
      expect(() => process.kill(pid, 0)).not.toThrow();
      expect(typeof stop).toBe('function');

      stop!('the app is quitting');
      // Bounded: a stop that does nothing must fail here with a verdict, not
      // hang the suite waiting for a process that will never go.
      const settled = await Promise.race([
        exited!.then(() => 'exited'),
        new Promise(resolve => setTimeout(() => resolve('still running'), 8_000)),
      ]);
      expect(settled).toBe('exited');
      await run;
      await expectProcessToExit(pid, 2_000);
    } finally {
      if (pid > 0) {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* already exited */ }
      }
    }
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
