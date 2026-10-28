import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { makeAcpBackend } from '../../../../src/main/features/local_agents/backends/_acp';
import { killProcessTree } from '../../../../src/main/features/local_agents/backends/base';

const TEST_NODE = process.env.ORKAS_TEST_NODE || process.execPath;

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

describe('local_agents/backends/_acp process lifecycle', () => {
  it.skipIf(process.platform === 'win32').each(['abort', 'timeout'] as const)(
    'sends native ACP cancellation before reaping a detached foreground tool on %s', async mode => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-acp-native-cancel-'));
      const controller = new AbortController();
      // This case expires an executing foreground tool, not CLI startup. Keep
      // the original 500ms wall cap, advancing only after the real tool event.
      let wallNow = Date.now();
      const wallClock = mode === 'timeout' ? vi.spyOn(Date, 'now').mockImplementation(() => wallNow) : undefined;
      let foregroundStarted = false;
      const fixture = String.raw`
        const fs = require('node:fs');
        const { spawn } = require('node:child_process');
        const send = m => process.stdout.write(JSON.stringify(m) + '\n');
        let child, promptId;
        require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
          const m = JSON.parse(line);
          if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1 } });
          if (m.method === 'session/new') setTimeout(() => send({ id: m.id, result: { sessionId: 'fixture-session' } }), ${mode === 'timeout' ? 700 : 0});
          if (m.method === 'session/prompt') {
            promptId = m.id;
            child = spawn(process.execPath, ['-e', "setTimeout(() => require('node:fs').writeFileSync('late-effect', 'survived'), 1500)"], { detached: true, stdio: 'ignore' });
            fs.writeFileSync('child-pid', String(child.pid));
            send({ method: 'session/update', params: { update: { sessionUpdate: 'tool_call', title: 'terminal', toolCallId: 'foreground', rawInput: {} } } });
          }
          if (m.method === 'session/cancel') {
            fs.appendFileSync('native-cancel', JSON.stringify(m) + '\n');
            try { process.kill(-child.pid, 'SIGKILL'); } catch {}
            send({ id: promptId, result: { stopReason: 'cancelled' } });
          }
        });
      `;
      const events: any[] = [];
      let pid = 0;
      try {
        await makeAcpBackend({ logName: 'local-agents:test-acp', argv: ['-e', fixture], clientName: 'orkas-test' }).run({
          binPath: TEST_NODE, cwd: root, prompt: 'Run the foreground command', signal: controller.signal,
          timeoutMs: mode === 'timeout' ? 500 : 5000,
          onEvent: event => {
            events.push(event);
            if (event.type === 'process-info') pid = Number(event.pid);
            if (event.type === 'tool-event') {
              foregroundStarted = fs.existsSync(path.join(root, 'child-pid'));
              if (mode === 'abort') controller.abort();
              else if (foregroundStarted) wallNow += 500;
            }
          },
        });
        await new Promise(resolve => setTimeout(resolve, 1700));
        const cancellations = fs.existsSync(path.join(root, 'native-cancel'))
          ? fs.readFileSync(path.join(root, 'native-cancel'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
        expect(foregroundStarted, 'the native foreground tool must start before expiry').toBe(true);
        expect(cancellations).toEqual([{ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'fixture-session' } }]);
        expect(fs.existsSync(path.join(root, 'late-effect'))).toBe(false);
        expect(events.filter(e => e.type === 'done')).toHaveLength(1);
        expect(events.at(-1)).toMatchObject({ status: mode === 'abort' ? 'cancelled' : 'timeout' });
      } finally {
        wallClock?.mockRestore();
        const child = Number(fs.existsSync(path.join(root, 'child-pid')) && fs.readFileSync(path.join(root, 'child-pid'), 'utf8'));
        if (child && isAlive(child)) { try { process.kill(-child, 'SIGKILL'); } catch {} }
        if (pid && isAlive(pid)) killProcessTree({ pid, kill: signal => process.kill(pid, signal) }, 'SIGKILL');
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')('reaps a session-start timeout without a session or a native cancellation', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-acp-before-session-'));
    let wallNow = Date.now();
    const wallClock = vi.spyOn(Date, 'now').mockImplementation(() => wallNow);
    const events: any[] = [];
    let pid = 0;
    const fixture = String.raw`
      const fs = require('node:fs');
      const send = value => process.stdout.write(JSON.stringify(value) + '\n');
      require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
        const message = JSON.parse(line);
        if (message.method === 'initialize') send({ id: message.id, result: { protocolVersion: 1 } });
        if (message.method === 'session/new') fs.writeFileSync('session-requested', 'ready');
        if (message.method === 'session/prompt' || message.method === 'session/cancel') fs.writeFileSync('unexpected-session-call', 'called');
      });
    `;
    try {
      const running = makeAcpBackend({ logName: 'local-agents:test-acp', argv: ['-e', fixture], clientName: 'orkas-test' }).run({
        binPath: TEST_NODE, cwd: root, prompt: 'Wait for session readiness', signal: new AbortController().signal,
        timeoutMs: 500,
        onEvent: event => { events.push(event); if (event.type === 'process-info') pid = Number(event.pid); },
      });
      await vi.waitFor(() => expect(fs.existsSync(path.join(root, 'session-requested'))).toBe(true));
      wallNow += 500;
      await running;
      expect(events.some(event => event.type === 'tool-event')).toBe(false);
      expect(fs.existsSync(path.join(root, 'unexpected-session-call'))).toBe(false);
      expect(events.filter(event => event.type === 'done')).toEqual([expect.objectContaining({ status: 'timeout', timeoutKind: 'wall', sessionId: undefined })]);
      expect(isAlive(pid)).toBe(false);
    } finally {
      wallClock.mockRestore();
      if (pid && isAlive(pid)) killProcessTree({ pid, kill: signal => process.kill(pid, signal) }, 'SIGKILL');
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    { mode: 'success', status: 'completed', output: 'ACP result' },
    { mode: 'empty', status: 'completed', output: '' },
    { mode: 'rpc-error', status: 'failed', output: 'ACP result', error: 'Synthetic prompt failure' },
    { mode: 'stop-reason', status: 'failed', output: 'ACP result', error: 'max_tokens' },
    { mode: 'session-error', status: 'failed', output: '', error: 'Synthetic session failure' },
    { mode: 'cancel', status: 'cancelled', output: 'ACP result' },
    { mode: 'no-terminal', status: 'timeout', output: 'ACP result', timeoutKind: 'idle' },
    { mode: 'tool-stall', status: 'timeout', output: 'ACP result', timeoutKind: 'idle' },
    { mode: 'approval-stall', status: 'timeout', output: 'ACP result', timeoutKind: 'idle' },
  ])('settles $mode independently of a persistent ACP process and reaps its descendants', async ({ mode, ...expected }) => {
    // A valid terminal owns the turn outcome even while the CLI and an
    // inherited stdout pipe remain alive. Without a terminal, silence must
    // still time out; cancellation already requested by the user must win.
    const fixture = String.raw`
      const mode = ${JSON.stringify(mode)};
      const { spawn } = require('node:child_process');
      const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
      const send = m => process.stdout.write(JSON.stringify(m) + '\n');
      process.stdout.write('descendant:' + descendant.pid + '\n');
      setInterval(() => {}, 1000);
      require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
        const m = JSON.parse(line);
        if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1 } });
        if (m.method === 'session/new') {
          send(mode === 'session-error'
            ? { id: m.id, error: { code: -32603, message: 'Synthetic session failure' } }
            : { id: m.id, result: { sessionId: 'persistent-acp' } });
        }
        if (m.method === 'session/prompt') {
          if (mode !== 'empty') send({ method: 'session/update', params: { update: {
            sessionUpdate: 'agent_message_chunk', content: { text: 'ACP result' }
          } } });
          if (mode === 'no-terminal') return;
          if (mode === 'tool-stall' || mode === 'approval-stall') {
            send({ method: 'session/update', params: { update: {
              sessionUpdate: 'tool_call', toolCallId: 'private-tool', title: 'private-command', status: 'pending'
            } } });
            send({ method: 'session/update', params: { update: {
              sessionUpdate: 'tool_call_update', toolCallId: 'private-tool', status: 'in_progress'
            } } });
            if (mode === 'approval-stall') send({ id: 77, method: 'session/request_permission', params: { options: [] } });
            return;
          }
          const terminal = mode === 'rpc-error'
            ? { id: m.id, error: { code: -32603, message: 'Synthetic prompt failure' } }
            : { id: m.id, result: { stopReason: mode === 'stop-reason' ? 'max_tokens' : 'end_turn' } };
          // Coalesced late traffic must not mutate an already settled turn or
          // open a new permission dialog, including a repeated terminal.
          process.stdout.write([terminal, terminal,
            { method: 'session/update', params: { update: {
              sessionUpdate: 'agent_message_chunk', content: { text: 'late text' }
            } } },
            { id: 99, method: 'session/request_permission', params: { options: [] } }
          ].map(JSON.stringify).join('\n') + '\n');
        }
      });
    `;
    const events: any[] = [];
    const controller = new AbortController();
    const requestPermission = vi.fn(() => mode === 'approval-stall'
      ? new Promise<'deny'>(() => {}) : Promise.resolve('deny' as const));
    let lastActivity = Date.now();
    let executionStarted = false;
    let pid = 0;
    let descendantPid = 0;
    try {
      await makeAcpBackend({ logName: 'local-agents:test-acp', argv: ['-e', fixture], clientName: 'orkas-test' }).run({
        binPath: TEST_NODE, cwd: process.cwd(), prompt: 'Return a result',
        signal: controller.signal, requestPermission, permissionPolicy: 'ask',
        // These cases exercise silence after prompt execution, not host CPU
        // scheduling during cold child startup. The wall clock bounds setup.
        timeoutMs: 5_000, idleKillMs: 500, lastEventAt: () => executionStarted ? lastActivity : Date.now(),
        onEvent: event => {
          events.push(event);
          lastActivity = Date.now();
          if (event.type === 'text-delta' || event.type === 'tool-event') executionStarted = true;
          if (event.type === 'process-info') pid = Number(event.pid);
          if (event.type === 'raw-line') descendantPid = Number(String(event.line).split(':')[1]);
          if (mode === 'cancel' && event.type === 'text-delta') controller.abort();
        },
      });
      expect(events.filter(event => event.type === 'done')).toHaveLength(1);
      const summaries = events.filter(event => event.source === 'acp-diagnostics');
      expect(summaries).toHaveLength(1);
      const summary = JSON.parse(summaries[0].message.slice(4));
      expect(summary).toMatchObject({
        status: expected.status, stage: mode === 'session-error' ? 'session_new' : 'prompt',
        initAck: true,
        end: expected.status === 'timeout' ? 'close' : mode === 'cancel' ? expect.any(String) : 'protocol',
        pending: mode.endsWith('-stall') ? 1 : 0,
        permissions: mode === 'approval-stall' ? 1 : 0,
      });
      expect(summaries[0].synthetic).toBe(true);
      expect(summaries[0].message.length).toBeLessThanOrEqual(500);
      expect(summaries[0].message).not.toContain('ACP result');
      expect(summaries[0].message).not.toContain('persistent-acp');
      expect(summaries[0].message).not.toContain('private-');
      expect(events.at(-1)).toMatchObject({ type: 'done', ...expected });
      expect(events.filter(event => event.type === 'stderr-line')).toEqual([]);
      expect(events.some(event => event.text === 'late text')).toBe(false);
      expect(requestPermission).toHaveBeenCalledTimes(mode === 'approval-stall' ? 1 : 0);
      expect(pid).toBeGreaterThan(0);
      expect(descendantPid).toBeGreaterThan(0);
      const settledCount = events.length;
      await vi.waitFor(() => {
        expect(isAlive(pid)).toBe(false);
        expect(isAlive(descendantPid)).toBe(false);
      }, { timeout: 3_000, interval: 25 });
      expect(events).toHaveLength(settledCount);
    } finally {
      if (pid && isAlive(pid)) killProcessTree({ pid, kill: signal => process.kill(pid, signal) }, 'SIGKILL');
      if (descendantPid && isAlive(descendantPid)) process.kill(descendantPid, 'SIGKILL');
    }
  });

  it.each(['missing-terminal', 'upstream-error'] as const)('preserves failure evidence for %s', async mode => {
    const events: any[] = [];
    let diagnosticReceived!: () => void;
    const diagnostic = new Promise<void>(resolve => { diagnosticReceived = resolve; });
    const fixture = String.raw`
      const mode = ${JSON.stringify(mode)};
      const send = m => process.stdout.write(JSON.stringify(m) + '\n');
      let promptId;
      require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
        const m = JSON.parse(line);
        if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1 } });
        if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 'failure-acp' } });
        if (m.method === 'session/prompt') {
          if (mode === 'missing-terminal') return process.exit(0);
          promptId = m.id;
          process.stderr.write('HTTP 400: synthetic upstream failure\n');
          // The permission exchange provides a deterministic barrier across
          // stdout/stderr: the terminal follows collected diagnostic evidence.
          send({ id: 77, method: 'session/request_permission', params: { options: [] } });
        }
        if (m.id === 77) send({ id: promptId, result: { stopReason: 'end_turn' } });
      });
    `;
    await makeAcpBackend({ logName: 'local-agents:test-acp', argv: ['-e', fixture], clientName: 'orkas-test' }).run({
      binPath: TEST_NODE, cwd: process.cwd(), prompt: 'Return a result',
      signal: new AbortController().signal, permissionPolicy: 'ask', timeoutMs: 2_000,
      requestPermission: async () => { await diagnostic; return 'deny'; },
      onEvent: event => {
        events.push(event);
        if (event.type === 'stderr-line') diagnosticReceived();
      },
    });
    expect(events.at(-1)).toMatchObject({
      status: 'failed', output: '',
      error: mode === 'missing-terminal'
        ? 'cli closed without prompt result'
        : expect.stringContaining('HTTP 400: synthetic upstream failure'),
    });
    expect(events.filter(event => event.type === 'stderr-line').map(event => event.line)).toEqual(
      mode === 'upstream-error' ? ['HTTP 400: synthetic upstream failure'] : [],
    );
  });

  it.each([false, true])('passes only the current run MCP server on ACP session start (resume=%s)', async (resume) => {
    const server = { command: 'test-node', args: ['bridge.cjs'], env: { ORKAS_BRIDGE_ENV_FILE: 'run-local.json' } };
    const probe = `
      const assert = require('node:assert/strict');
      const lines = require('node:readline').createInterface({input: process.stdin});
      const send = m => process.stdout.write(JSON.stringify(m) + '\\n');
      lines.on('line', line => {
        const m = JSON.parse(line);
        if (m.method === 'initialize') send({id:m.id,result:{protocolVersion:1}});
        else if (m.method === 'session/new' || m.method === 'session/resume') {
          assert.equal(m.method, ${JSON.stringify(resume ? 'session/resume' : 'session/new')});
          assert.deepEqual(m.params.mcpServers, [{name:'orkas',command:'test-node',args:['bridge.cjs'],env:[{name:'ORKAS_BRIDGE_ENV_FILE',value:'run-local.json'}]}]);
          send({id:m.id,result:{sessionId:'test-session'}});
        } else if (m.method === 'session/prompt') {
          send({method:'session/update',params:{update:{sessionUpdate:'agent_message_chunk',content:{text:'Scoped MCP registered'}}}});
          send({id:m.id,result:{stopReason:'end_turn'}});
        }
      });
    `;
    const backend = makeAcpBackend({ logName: 'local-agents:test-acp', argv: ['-e', probe], clientName: 'orkas-test', resume });
    const events: any[] = [];
    await backend.run({ binPath: TEST_NODE, prompt: 'Use the current scope', cwd: process.cwd(),
      bridge: { server, mcpConfigPath: 'run-config.json' }, resumeSessionId: resume ? 'test-session' : undefined,
      signal: new AbortController().signal, timeoutMs: 2000, onEvent: event => events.push(event) });
    expect(events.filter(event => event.type === 'stderr-line')).toEqual([]);
    expect(events.at(-1)).toMatchObject({ status: 'completed', output: 'Scoped MCP registered' });
  });

  it('starts the ACP session immediately after initialize acknowledgement and completes one prompt', async () => {
    const fakeAcpServer = String.raw`
      let buffer = '';
      let sessionNewSeen = false;
      const failIfHandshakeStalls = setTimeout(() => {
        if (!sessionNewSeen) {
          process.stderr.write('session/new was not sent after initialize acknowledgement\n');
          process.exit(9);
        }
      }, 100);
      const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          const message = JSON.parse(line);
          if (message.method === 'initialize') {
            send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } });
          } else if (message.method === 'session/new') {
            if (Object.prototype.hasOwnProperty.call(message.params || {}, 'model')) {
              process.stderr.write('Orkas must not select an ACP model\n');
              process.exit(8);
            }
            sessionNewSeen = true;
            clearTimeout(failIfHandshakeStalls);
            send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'acp-session-1' } });
          } else if (message.method === 'session/set_model') {
            process.stderr.write('Orkas must not set an ACP model\n');
            process.exit(7);
          } else if (message.method === 'session/prompt') {
            send({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'acp-session-1',
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { text: 'ACP result' },
                },
              },
            });
            send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
          }
        }
      });
    `;
    const backend = makeAcpBackend({
      logName: 'local-agents:test-acp',
      argv: ['-e', fakeAcpServer],
      clientName: 'orkas-test',
    });
    const events: any[] = [];

    await backend.run({
      binPath: TEST_NODE,
      prompt: 'return a result',
      cwd: process.cwd(),
      signal: new AbortController().signal,
      timeoutMs: 2_000,
      onEvent: event => events.push(event),
    });

    expect(events).toContainEqual(expect.objectContaining({
      type: 'status',
      status: 'session_ready',
      sessionId: 'acp-session-1',
    }));
    expect(events).toContainEqual({ type: 'text-delta', text: 'ACP result' });
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      status: 'completed',
      output: 'ACP result',
      sessionId: 'acp-session-1',
    });
  });

  it('resumes the requested ACP session and still asks Orkas for the current task permission', async () => {
    const fakeAcpServer = String.raw`
      let buffer = '';
      let promptRequestId = null;
      const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          const message = JSON.parse(line);
          if (message.method === 'initialize') {
            send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } });
          } else if (message.method === 'session/new') {
            process.stderr.write('a resumable task must not create a fresh ACP session\n');
            process.exit(8);
          } else if (message.method === 'session/resume') {
            if (message.params?.sessionId !== 'existing-acp-session') {
              process.stderr.write('wrong ACP session resumed\n');
              process.exit(7);
            }
            send({ jsonrpc: '2.0', id: message.id, result: { configOptions: [] } });
          } else if (message.method === 'session/prompt') {
            promptRequestId = message.id;
            send({
              jsonrpc: '2.0', id: 91, method: 'session/request_permission',
              params: {
                sessionId: 'existing-acp-session',
                toolCall: {
                  kind: 'execute', title: 'Commit changes',
                  rawInput: { command: 'git commit -m test' },
                },
                options: [
                  { optionId: 'allow_once', kind: 'allow_once' },
                  { optionId: 'allow_always', kind: 'allow_always' },
                  { optionId: 'deny', kind: 'reject_once' },
                ],
              },
            });
          } else if (message.id === 91) {
            if (message.result?.outcome?.optionId !== 'allow_once') {
              process.stderr.write('Orkas task approval leaked into a native session grant\n');
              process.exit(6);
            }
            send({ jsonrpc: '2.0', method: 'session/update', params: {
              sessionId: 'existing-acp-session',
              update: { sessionUpdate: 'agent_message_chunk', content: { text: 'committed' } },
            } });
            send({ jsonrpc: '2.0', id: promptRequestId, result: { stopReason: 'end_turn' } });
          }
        }
      });
    `;
    const backend = makeAcpBackend({
      logName: 'local-agents:test-acp-resume-permission',
      argv: ['-e', fakeAcpServer],
      clientName: 'orkas-test',
      resume: true,
    });
    const events: any[] = [];
    const requestPermission = vi.fn(async () => 'allow_run' as const);

    await backend.run({
      binPath: TEST_NODE,
      prompt: 'commit the changes',
      resumeSessionId: 'existing-acp-session',
      permissionPolicy: 'ask',
      requestPermission,
      cwd: process.cwd(),
      signal: new AbortController().signal,
      timeoutMs: 2_000,
      onEvent: event => events.push(event),
    });

    expect(requestPermission).toHaveBeenCalledWith(expect.objectContaining({
      tool: 'execute',
      command: 'git commit -m test',
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'status',
      status: 'session_ready',
      sessionId: 'existing-acp-session',
    }));
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      status: 'completed',
      output: 'committed',
      sessionId: 'existing-acp-session',
    });
  });

  it('bridges Hermes ACP permission requests to a human decision', async () => {
    const fakeAcpServer = String.raw`
      let buffer = '';
      let promptRequestId = null;
      const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          const message = JSON.parse(line);
          if (message.method === 'initialize') {
            send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } });
          } else if (message.method === 'session/new') {
            send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'acp-permission-session' } });
          } else if (message.method === 'session/prompt') {
            promptRequestId = message.id;
            send({
              jsonrpc: '2.0', id: 77, method: 'session/request_permission',
              params: {
                sessionId: 'acp-permission-session',
                toolCall: {
                  kind: 'execute', title: 'Run tests',
                  rawInput: { command: 'npm test', description: 'Run tests' },
                },
                options: [
                  { optionId: 'allow_once', kind: 'allow_once' },
                  { optionId: 'session-grant', kind: 'allow_always' },
                  { optionId: 'deny', kind: 'reject_once' },
                ],
              },
            });
          } else if (message.id === 77) {
            if (message.result?.outcome?.optionId !== 'allow_once') {
              process.stderr.write('permission response was not bounded to one native operation\n');
              process.exit(7);
            }
            send({ jsonrpc: '2.0', method: 'session/update', params: {
              sessionId: 'acp-permission-session',
              update: { sessionUpdate: 'agent_message_chunk', content: { text: 'approved result' } },
            } });
            send({ jsonrpc: '2.0', id: promptRequestId, result: { stopReason: 'end_turn' } });
          }
        }
      });
    `;
    const backend = makeAcpBackend({
      logName: 'local-agents:test-acp-permission',
      argv: ['-e', fakeAcpServer],
      clientName: 'orkas-test',
    });
    const events: any[] = [];
    const requestPermission = vi.fn(async () => 'allow_run' as const);

    await backend.run({
      binPath: TEST_NODE,
      prompt: 'run tests',
      permissionPolicy: 'ask',
      requestPermission,
      cwd: process.cwd(),
      signal: new AbortController().signal,
      timeoutMs: 2_000,
      onEvent: event => events.push(event),
    });

    expect(requestPermission).toHaveBeenCalledWith(expect.objectContaining({
      tool: 'execute',
      command: 'npm test',
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'permission-request',
      reason: 'user',
      decision: 'allow',
    }));
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      status: 'completed',
      output: 'approved result',
    });
  });

  it('returns a cancelled ACP outcome when the user denies the tool call', async () => {
    const fakeAcpServer = String.raw`
      let buffer = '';
      let promptRequestId = null;
      const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          const message = JSON.parse(line);
          if (message.method === 'initialize') {
            send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } });
          } else if (message.method === 'session/new') {
            send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'acp-denied-session' } });
          } else if (message.method === 'session/prompt') {
            promptRequestId = message.id;
            send({
              jsonrpc: '2.0', id: 78, method: 'session/request_permission',
              params: {
                sessionId: 'acp-denied-session',
                toolCall: {
                  kind: 'execute', title: 'Delete protected file',
                  rawInput: { command: 'rm protected.txt' },
                },
                options: [
                  { optionId: 'allow_once', kind: 'allow_once' },
                  { optionId: 'deny', kind: 'reject_once' },
                ],
              },
            });
          } else if (message.id === 78) {
            if (message.result?.outcome?.outcome !== 'cancelled') {
              process.stderr.write('permission request was not cancelled\n');
              process.exit(7);
            }
            send({ jsonrpc: '2.0', method: 'session/update', params: {
              sessionId: 'acp-denied-session',
              update: { sessionUpdate: 'agent_message_chunk', content: { text: 'denied safely' } },
            } });
            send({ jsonrpc: '2.0', id: promptRequestId, result: { stopReason: 'end_turn' } });
          }
        }
      });
    `;
    const backend = makeAcpBackend({
      logName: 'local-agents:test-acp-denied',
      argv: ['-e', fakeAcpServer],
      clientName: 'orkas-test',
    });
    const events: any[] = [];
    const requestPermission = vi.fn(async () => 'deny' as const);

    await backend.run({
      binPath: TEST_NODE,
      prompt: 'delete the file',
      permissionPolicy: 'ask',
      requestPermission,
      cwd: process.cwd(),
      signal: new AbortController().signal,
      timeoutMs: 2_000,
      onEvent: event => events.push(event),
    });

    expect(requestPermission).toHaveBeenCalledWith(expect.objectContaining({
      tool: 'execute',
      command: 'rm protected.txt',
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'permission-request',
      decision: 'deny',
      reason: 'user',
    }));
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      status: 'completed',
      output: 'denied safely',
    });
  });

  it('sets an explicit model before prompting and still completes the task', async () => {
    const fakeAcpServer = String.raw`
      let buffer = '';
      let newModel = '';
      let setModel = '';
      const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          const message = JSON.parse(line);
          if (message.method === 'initialize') {
            send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } });
          } else if (message.method === 'session/new') {
            newModel = message.params && message.params.model;
            send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'acp-model-session' } });
          } else if (message.method === 'session/set_model') {
            setModel = message.params && message.params.modelId;
            send({ jsonrpc: '2.0', id: message.id, result: {} });
          } else if (message.method === 'session/prompt') {
            if (newModel !== undefined || setModel !== 'provider/model-a') {
              process.stderr.write('model override was not applied before prompt\n');
              process.exit(7);
            }
            send({ jsonrpc: '2.0', method: 'session/update', params: {
              sessionId: 'acp-model-session',
              update: { sessionUpdate: 'agent_message_chunk', content: { text: 'selected model result' } },
            } });
            send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
          }
        }
      });
    `;
    const backend = makeAcpBackend({
      logName: 'local-agents:test-acp-model',
      argv: ['-e', fakeAcpServer],
      clientName: 'orkas-test',
    });
    const events: any[] = [];

    await backend.run({
      binPath: TEST_NODE,
      prompt: 'return a result',
      modelOverride: 'provider/model-a',
      cwd: process.cwd(),
      signal: new AbortController().signal,
      timeoutMs: 2_000,
      onEvent: event => events.push(event),
    });

    expect(events.at(-1)).toMatchObject({
      type: 'done',
      status: 'completed',
      output: 'selected model result',
    });
  });

  it('does not prompt when an ACP model setter never acknowledges the selection', async () => {
    const fakeAcpServer = String.raw`
      let buffer = '';
      let selectedModel = '';
      const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          const message = JSON.parse(line);
          if (message.method === 'initialize') {
            send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } });
          } else if (message.method === 'session/new') {
            send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'acp-no-setter-reply' } });
          } else if (message.method === 'session/set_model') {
            selectedModel = message.params && message.params.modelId;
            // No acknowledgment establishes that the selected model was applied.
          } else if (message.method === 'session/prompt') {
            if (selectedModel !== 'provider/model-silent') {
              process.stderr.write('prompt overtook the model setter\n');
              process.exit(7);
            }
            send({ jsonrpc: '2.0', method: 'session/update', params: {
              sessionId: 'acp-no-setter-reply',
              update: { sessionUpdate: 'agent_message_chunk', content: { text: 'silent setter recovered' } },
            } });
            send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
          }
        }
      });
    `;
    const backend = makeAcpBackend({
      logName: 'local-agents:test-acp-silent-model',
      argv: ['-e', fakeAcpServer],
      clientName: 'orkas-test',
    });
    const events: any[] = [];

    await backend.run({
      binPath: TEST_NODE,
      prompt: 'return a result',
      modelOverride: 'provider/model-silent',
      cwd: process.cwd(),
      signal: new AbortController().signal,
      timeoutMs: 5_000,
      onEvent: event => events.push(event),
    });

    expect(events.filter(event => event.type === 'text-delta')).toEqual([]);
    expect(events.filter(event => event.type === 'done')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      status: 'failed',
      cliError: 'parameter_unsupported',
      retrySafe: false,
    });
  });

  it('does not infer a transport failure from successful ACP response text', async () => {
    const fakeAcpServer = String.raw`
      let buffer = '';
      const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          const message = JSON.parse(line);
          if (message.method === 'initialize') {
            send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } });
          } else if (message.method === 'session/new') {
            send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'acp-api-retry-failure' } });
          } else if (message.method === 'session/prompt') {
            send({ jsonrpc: '2.0', method: 'session/update', params: {
              sessionId: 'acp-api-retry-failure',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: {
                  text: 'API call failed after 3 retries: HTTP 404: 404 Not found. Check the docs for available routes.',
                },
              },
            } });
            send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
          }
        }
      });
    `;
    const backend = makeAcpBackend({
      logName: 'local-agents:test-acp',
      argv: ['-e', fakeAcpServer],
      clientName: 'orkas-test',
    });
    const events: any[] = [];

    await backend.run({
      binPath: TEST_NODE,
      prompt: 'answer the user',
      cwd: process.cwd(),
      signal: new AbortController().signal,
      timeoutMs: 2_000,
      onEvent: event => events.push(event),
    });

    expect(events).toContainEqual(expect.objectContaining({
      type: 'text-delta',
      text: expect.stringContaining('API call failed after 3 retries'),
    }));
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      status: 'completed',
      output: 'API call failed after 3 retries: HTTP 404: 404 Not found. Check the docs for available routes.',
    });
  });
});

describe('ACP model selection preserves the fresh-session tool surface', () => {
  it.each(['supported', 'missing-capability', 'rejected-reload'])('preserves MCP tools or fails before model execution: %s', async mode => {
    const fixture = String.raw`
const send = value => process.stdout.write(JSON.stringify(value)+'\n');let attached=false,selected=false;const mode=process.argv[1];
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{protocolVersion:1,agentCapabilities:{loadSession:mode!=='missing-capability'}}});
 if(m.method==='session/new'){attached=m.params.mcpServers.length===1;send({id:m.id,result:{sessionId:'model-tools'}});}
 if(m.method==='session/set_model'){selected=true;attached=false;send({id:m.id,result:{}});}
 if(m.method==='session/load'){attached=m.params.sessionId==='model-tools'&&m.params.mcpServers[0]?.name==='orkas';send(mode==='rejected-reload'?{id:m.id,error:{code:-32000,message:'Reload unavailable'}}:{id:m.id,result:{}});}
 if(m.method==='session/prompt'){process.stderr.write('PROMPT_SUBMITTED\n');send({id:m.id,...(selected&&attached?{result:{stopReason:'end_turn'}}:{error:{code:-32000,message:'Native model switch lost the MCP surface'}})});}
});`;
    const events:any[]=[];
    await makeAcpBackend({logName:'local-agents:test-model-tools',argv:['-e',fixture,mode],clientName:'fixture',refreshMcpAfterModelSelection:true}).run({
      binPath:TEST_NODE,cwd:process.cwd(),prompt:'Use the configured tools',modelOverride:'selected-model',
      bridge:{mcpConfigPath:'unused',server:{command:TEST_NODE,args:[],env:{}}},signal:new AbortController().signal,
      timeoutMs:5000,onEvent:event=>events.push(event),
    });
    expect(events.at(-1)).toMatchObject({type:'done',status:mode==='supported'?'completed':'failed'});
    expect(events.filter(event=>event.type==='stderr-line'&&event.line==='PROMPT_SUBMITTED')).toHaveLength(mode==='supported'?1:0);
    expect(events.filter(event=>event.type==='done')).toHaveLength(1);
  });

  it('does not submit a model prompt after cancellation at session readiness', async () => {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'orkas-acp-preprompt-cancel-'));
    const controller=new AbortController();const events:any[]=[];
    const fixture=String.raw`
const fs=require('node:fs');const send=m=>process.stdout.write(JSON.stringify(m)+'\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{protocolVersion:1}});
 if(m.method==='session/new')send({id:m.id,result:{sessionId:'cancel-before-model'}});
 if(m.method==='session/prompt')fs.writeFileSync('unexpected-model-request','submitted');
});`;
    try{
      await makeAcpBackend({logName:'local-agents:test-preprompt',argv:['-e',fixture],clientName:'fixture'}).run({
        binPath:TEST_NODE,cwd:root,prompt:'Do not start after cancellation',signal:controller.signal,timeoutMs:5000,
        onEvent:event=>{events.push(event);if(event.type==='status'&&event.status==='session_ready')controller.abort();},
      });
      expect(fs.existsSync(path.join(root,'unexpected-model-request'))).toBe(false);
      expect(events.at(-1)).toMatchObject({type:'done',status:'cancelled'});
    }finally{fs.rmSync(root,{recursive:true,force:true});}
  });
});

describe('ACP optional configuration compatibility', () => {
  it.each(['supported', 'rejected', 'missing-effort', 'missing-id', 'malformed-ack', 'null-ack-option'])('selects the advertised config-option interface: %s', async mode => {
    const server = String.raw`
const rl = require('node:readline').createInterface({ input: process.stdin });
const mode = process.argv[1]; const methods = []; const selected = {};
const options = () => [
  { id: mode === 'missing-id' ? undefined : 'provider-model', category: 'model', type: 'select', currentValue: selected['provider-model'] || 'default',
    options: [{ group: 'provider', options: [{ value: 'chosen' }] }] },
  ...(mode === 'missing-effort' ? [] : [{ id: 'reasoning', category: 'thought_level', type: 'select',
    currentValue: selected.reasoning || 'low', options: [{ value: 'high' }, { value: 'low' }] }]),
];
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
rl.on('line', line => {
  const m = JSON.parse(line); methods.push(m.method);
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1 } });
  else if (m.method === 'session/new') {
    if ('model' in m.params) process.exit(8);
    send({ id: m.id, result: { sessionId: 'config-session', configOptions: options() } });
  } else if (m.method === 'session/set_config_option') {
    if (mode === 'rejected') send({ id: m.id, error: { code: -32602, message: 'unavailable' } });
    else if (mode === 'malformed-ack') send({ id: m.id, result: { configOptions: {} } });
    else if (mode === 'null-ack-option') send({ id: m.id, result: { configOptions: [null] } });
    else { selected[m.params.configId] = m.params.value; send({ id: m.id, result: { configOptions: options() } }); }
  } else if (m.method === 'session/set_model') process.exit(9);
  else if (m.method === 'session/prompt') {
    if (selected['provider-model'] !== 'chosen' || (mode !== 'missing-effort' && selected.reasoning !== 'high')) process.exit(10);
    send({ method: 'session/update', params: { sessionId: 'config-session', update: {
      sessionUpdate: 'agent_message_chunk', content: { text: JSON.stringify(methods) },
    } } });
    send({ id: m.id, result: { stopReason: 'end_turn' } });
  }
});`;
    const backend = makeAcpBackend({ logName: 'local-agents:test-config-options', argv: ['-e', server, mode], clientName: 'test' });
    const events: any[] = [];
    await backend.run({ binPath: TEST_NODE, prompt: 'controlled fixture', modelOverride: 'chosen', thinkingLevel: 'high',
      cwd: process.cwd(), signal: new AbortController().signal, timeoutMs: 5000, onEvent: event => events.push(event) });
    const done = events.filter(event => event.type === 'done'); expect(done).toHaveLength(1);
    if (mode === 'supported' || mode === 'missing-effort') {
      expect(done[0].status).toBe('completed');
      expect(JSON.parse(done[0].output)).toEqual(['initialize', 'session/new', 'session/set_config_option',
        ...(mode === 'supported' ? ['session/set_config_option'] : []), 'session/prompt']);
    } else {
      expect(done[0]).toMatchObject({ status: 'failed', cliError: 'parameter_unsupported', retrySafe: false });
      expect(events.filter(event => event.type === 'text-delta')).toEqual([]);
    }
  });
});
