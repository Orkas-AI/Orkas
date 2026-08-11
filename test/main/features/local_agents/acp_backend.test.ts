import { describe, expect, it } from 'vitest';

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
});
