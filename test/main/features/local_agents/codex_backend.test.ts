import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { codexBackend } from '../../../../src/main/features/local_agents/backends/codex';

const describePosix = process.platform === 'win32' ? describe.skip : describe;

describePosix('local_agents/backends/codex process lifecycle', () => {
  let tempDir = '';
  let fakeCodexPath = '';

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-codex-backend-'));
    fakeCodexPath = path.join(tempDir, 'fake-codex');
    fs.writeFileSync(fakeCodexPath, `#!/usr/bin/env node
const fs = require('node:fs');
const scenario = process.argv.includes('--protocol-failure') ? 'protocol-failure' : 'resume-fallback';
const traceFlag = process.argv.indexOf('--trace');
const tracePath = traceFlag >= 0 ? process.argv[traceFlag + 1] : '';
const received = [];
let buffer = '';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const record = (message) => {
  received.push(message);
  if (tracePath) fs.writeFileSync(tracePath, JSON.stringify(received));
};
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    record(message);
    if (message.method === 'initialize') {
      if (scenario === 'protocol-failure') {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'unsupported protocol' } });
      } else {
        send({ jsonrpc: '2.0', id: message.id, result: { userAgent: 'fake-codex' } });
      }
    } else if (message.method === 'thread/resume') {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32001, message: 'thread expired' } });
    } else if (message.method === 'thread/start') {
      send({ jsonrpc: '2.0', id: message.id, result: { threadId: 'fresh-thread' } });
    } else if (message.method === 'turn/start') {
      send({ jsonrpc: '2.0', id: message.id, result: { turn: { id: 'turn-1' } } });
      send({ jsonrpc: '2.0', method: 'remoteControl/status/changed', params: {
        status: 'disabled',
        serverName: 'PRIVATE-HOST',
        installationId: '58f54cd1-0f34-44f3-b151-a2f4386fcf62',
        environmentId: null,
      } });
      send({ jsonrpc: '2.0', method: 'turn/started', params: {
        threadId: 'fresh-thread', turn: { id: 'turn-1' },
      } });
      send({ jsonrpc: '2.0', method: 'item/started', params: {
        threadId: 'fresh-thread',
        item: { id: 'answer-1', type: 'agentMessage', phase: 'final_answer' },
      } });
      send({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: {
        threadId: 'fresh-thread', itemId: 'answer-1', delta: 'Codex result',
      } });
      send({ jsonrpc: '2.0', method: 'thread/tokenUsage/updated', params: {
        threadId: 'fresh-thread', usage: { input_tokens: 12, output_tokens: 3 },
      } });
      send({ jsonrpc: '2.0', method: 'turn/completed', params: {
        threadId: 'fresh-thread', turn: { id: 'turn-1', status: 'completed' },
      } });
    }
  }
});
process.stdin.on('end', () => {
  if (scenario !== 'protocol-failure') process.exit(0);
});
if (scenario === 'protocol-failure') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
}
`);
    fs.chmodSync(fakeCodexPath, 0o755);
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('falls back from an expired resume, restores recovery context, and completes the turn', async () => {
    const tracePath = path.join(tempDir, 'resume-trace.json');
    const events: any[] = [];

    await codexBackend.run({
      binPath: fakeCodexPath,
      prompt: 'current turn',
      resumeSessionId: 'expired-thread',
      resumeFallbackPrompt: 'bounded recovery\n\ncurrent turn',
      systemPrompt: 'durable Orkas instructions',
      reuseSessionInstructions: true,
      customArgs: ['--trace', tracePath],
      cwd: process.cwd(),
      signal: new AbortController().signal,
      timeoutMs: 2_000,
      onEvent: event => events.push(event),
    });

    const requests = JSON.parse(fs.readFileSync(tracePath, 'utf8'));
    const resume = requests.find((entry: any) => entry.method === 'thread/resume');
    const start = requests.find((entry: any) => entry.method === 'thread/start');
    const turn = requests.find((entry: any) => entry.method === 'turn/start');

    expect(resume.params).not.toHaveProperty('developerInstructions');
    expect(start.params.developerInstructions).toBe('durable Orkas instructions');
    expect(turn.params.input).toEqual([{ type: 'text', text: 'bounded recovery\n\ncurrent turn' }]);
    expect(events).toContainEqual({
      type: 'text-delta',
      itemId: 'answer-1',
      phase: 'final_answer',
      text: 'Codex result',
    });
    expect(events).toContainEqual({
      type: 'status',
      status: 'usage',
      usage: { input: 12, output: 3 },
    });
    expect(events).not.toContainEqual(expect.objectContaining({
      type: 'log',
      message: expect.stringContaining('remoteControl/status/changed'),
    }));
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      status: 'completed',
      sessionId: 'fresh-thread',
      output: 'Codex result',
      usage: { input: 12, output: 3 },
    });
  });

  it('terminates the child process when protocol initialization fails', async () => {
    const events: any[] = [];
    let pid = -1;

    try {
      await codexBackend.run({
        binPath: fakeCodexPath,
        prompt: 'never starts',
        customArgs: ['--protocol-failure'],
        cwd: process.cwd(),
        signal: new AbortController().signal,
        timeoutMs: 2_000,
        onEvent: event => {
          events.push(event);
          if (event.type === 'process-info') pid = Number(event.pid);
        },
      });

      expect(events.at(-1)).toMatchObject({
        type: 'done',
        status: 'failed',
        error: expect.stringContaining('unsupported protocol'),
      });
      await expectProcessToExit(pid);
    } finally {
      if (pid > 0) {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* already exited */ }
      }
    }
  });
});

async function expectProcessToExit(pid: number): Promise<void> {
  expect(pid).toBeGreaterThan(0);
  const deadline = Date.now() + 750;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Codex child process ${pid} is still alive after protocol failure`);
}
