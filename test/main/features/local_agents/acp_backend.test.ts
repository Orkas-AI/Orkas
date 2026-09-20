import { describe, expect, it, vi } from 'vitest';

import { makeAcpBackend } from '../../../../src/main/features/local_agents/backends/_acp';
import { killProcessTree } from '../../../../src/main/features/local_agents/backends/base';

const TEST_NODE = process.env.ORKAS_TEST_NODE || process.execPath;

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

describe('local_agents/backends/_acp process lifecycle', () => {
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
    let pid = 0;
    let descendantPid = 0;
    try {
      await makeAcpBackend({ logName: 'local-agents:test-acp', argv: ['-e', fixture], clientName: 'orkas-test' }).run({
        binPath: TEST_NODE, cwd: process.cwd(), prompt: 'Return a result',
        signal: controller.signal, requestPermission, permissionPolicy: 'ask',
        timeoutMs: 5_000, idleKillMs: 500, lastEventAt: () => lastActivity,
        onEvent: event => {
          events.push(event);
          lastActivity = Date.now();
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
            if (newModel !== 'provider/model-a' || setModel !== 'provider/model-a') {
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

  it('continues the prompt when an ACP server accepts set_model but never replies', async () => {
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
            // Deliberately omit the JSON-RPC response. Version-skewed ACP
            // servers have been observed to accept this request silently.
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
      timeoutMs: 2_000,
      onEvent: event => events.push(event),
    });

    expect(events.at(-1)).toMatchObject({
      type: 'done',
      status: 'completed',
      output: 'silent setter recovered',
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
