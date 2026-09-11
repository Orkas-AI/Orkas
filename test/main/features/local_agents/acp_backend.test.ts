import { describe, expect, it, vi } from 'vitest';

import { makeAcpBackend } from '../../../../src/main/features/local_agents/backends/_acp';

const TEST_NODE = process.env.ORKAS_TEST_NODE || process.execPath;

describe('local_agents/backends/_acp process lifecycle', () => {
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
