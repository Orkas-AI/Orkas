import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CodexActivityHeartbeat,
  codexBackend,
} from '../../../../src/main/features/local_agents/backends/codex';

const describePosix = process.platform === 'win32' ? describe.skip : describe;

describePosix('local_agents/backends/codex process lifecycle', () => {
  let tempDir = '';
  let fakeCodexPath = '';

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-codex-backend-'));
    fakeCodexPath = path.join(tempDir, 'fake-codex');
    fs.writeFileSync(fakeCodexPath, `#!/usr/bin/env node
const fs = require('node:fs');
const specialScenarios = [
  'protocol-failure',
  'fatal-lingers',
  'success-lingers',
  'interrupted-lingers',
  'idle-lingers',
  'system-error-lingers',
  'thread-closed',
  'legacy-complete',
  'legacy-abort',
  'steer',
  'steer-rejected',
  'hang',
];
const scenario = specialScenarios.find((name) => process.argv.includes('--' + name))
  || 'resume-fallback';
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
      if (scenario !== 'resume-fallback') {
        if (scenario === 'legacy-complete' || scenario === 'legacy-abort') {
          send({ jsonrpc: '2.0', method: 'codex/event', params: {
            type: 'task_started',
          } });
          send({ jsonrpc: '2.0', method: 'codex/event/exec', params: {
            msg: {
              type: 'exec_command_begin',
              call_id: 'legacy-exec',
              command: 'legacy command',
            },
          } });
          send({ jsonrpc: '2.0', method: 'codex/event', params: {
            type: 'exec_command_end',
            call_id: 'legacy-exec',
            output: 'legacy output',
          } });
          send({ jsonrpc: '2.0', method: 'codex/event', params: {
            type: 'patch_apply_begin',
            call_id: 'legacy-patch',
          } });
          send({ jsonrpc: '2.0', method: 'codex/event', params: {
            type: 'patch_apply_end',
            call_id: 'legacy-patch',
          } });
          if (scenario === 'legacy-complete') {
            send({ jsonrpc: '2.0', method: 'codex/event', params: {
              type: 'agent_message_delta',
              delta: 'legacy result',
            } });
            send({ jsonrpc: '2.0', method: 'codex/event', params: {
              type: 'task_complete',
            } });
          } else {
            send({ jsonrpc: '2.0', method: 'codex/event', params: {
              type: 'turn_aborted',
            } });
          }
          continue;
        }
        send({ jsonrpc: '2.0', method: 'turn/started', params: {
          threadId: 'fresh-thread', turn: { id: 'turn-1' },
        } });
        if (scenario === 'fatal-lingers') {
          send({ jsonrpc: '2.0', method: 'error', params: {
            threadId: 'fresh-thread',
            turnId: 'turn-1',
            willRetry: false,
            error: { message: 'network retry limit reached' },
          } });
        } else if (scenario === 'success-lingers' || scenario === 'idle-lingers') {
          send({ jsonrpc: '2.0', method: 'item/started', params: {
            threadId: 'fresh-thread',
            item: { id: 'answer-linger', type: 'agentMessage', phase: 'final_answer' },
          } });
          send({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: {
            threadId: 'fresh-thread', itemId: 'answer-linger', delta: 'terminal result',
          } });
          if (scenario === 'success-lingers') {
            send({ jsonrpc: '2.0', method: 'turn/completed', params: {
              threadId: 'fresh-thread', turn: { id: 'turn-1', status: 'completed' },
            } });
          } else {
            send({ jsonrpc: '2.0', method: 'thread/status/changed', params: {
              threadId: 'fresh-thread', status: { type: 'idle' },
            } });
          }
        } else if (scenario === 'interrupted-lingers') {
          send({ jsonrpc: '2.0', method: 'turn/completed', params: {
            threadId: 'fresh-thread', turn: { id: 'turn-1', status: 'interrupted' },
          } });
        } else if (scenario === 'system-error-lingers') {
          send({ jsonrpc: '2.0', method: 'thread/status/changed', params: {
            threadId: 'fresh-thread', status: { type: 'systemError' },
          } });
        } else if (scenario === 'thread-closed') {
          send({ jsonrpc: '2.0', method: 'thread/closed', params: {
            threadId: 'fresh-thread',
          } });
        }
        continue;
      }
      send({ jsonrpc: '2.0', method: 'remoteControl/status/changed', params: {
        status: 'disabled',
        serverName: 'PRIVATE-HOST',
        installationId: '58f54cd1-0f34-44f3-b151-a2f4386fcf62',
        environmentId: null,
      } });
      send({ jsonrpc: '2.0', method: 'turn/started', params: {
        threadId: 'fresh-thread', turn: { id: 'turn-1' },
      } });
      send({ jsonrpc: '2.0', method: 'error', params: {
        threadId: 'fresh-thread',
        turnId: 'turn-1',
        willRetry: true,
        error: { message: 'temporary network error' },
      } });
      send({ jsonrpc: '2.0', method: 'turn/plan/updated', params: {
        threadId: 'fresh-thread',
        turnId: 'turn-1',
        explanation: 'checking the fix',
        plan: [
          { step: 'inspect', status: 'completed' },
          { step: 'test', status: 'inProgress' },
        ],
      } });
      send({ jsonrpc: '2.0', method: 'thread/status/changed', params: {
        threadId: 'fresh-thread',
        status: { type: 'active', activeFlags: ['waitingOnApproval'] },
      } });
      send({ jsonrpc: '2.0', method: 'thread/status/changed', params: {
        threadId: 'fresh-thread',
        status: { type: 'active', activeFlags: ['waitingOnUserInput'] },
      } });
      send({ jsonrpc: '2.0', method: 'hook/started', params: {
        threadId: 'fresh-thread',
        turnId: 'turn-1',
        run: {
          id: 'hook-1',
          eventName: 'afterTool',
          status: 'running',
        },
      } });
      send({ jsonrpc: '2.0', method: 'hook/completed', params: {
        threadId: 'fresh-thread',
        turnId: 'turn-1',
        run: {
          id: 'hook-1',
          eventName: 'afterTool',
          status: 'completed',
          entries: [{ text: 'hook line 1' }, { text: 'hook line 2' }],
        },
      } });
      send({ jsonrpc: '2.0', method: 'thread/compacted', params: {
        threadId: 'fresh-thread',
      } });
      send({ jsonrpc: '2.0', method: 'model/rerouted', params: {
        threadId: 'fresh-thread',
        fromModel: 'gpt-old',
        toModel: 'gpt-new',
        reason: 'capacity',
      } });
      send({ jsonrpc: '2.0', method: 'warning', params: {
        threadId: 'fresh-thread',
        message: 'temporary degraded mode',
      } });
      send({ jsonrpc: '2.0', method: 'warning', params: {
        threadId: 'another-thread',
        message: 'wrong thread warning',
      } });
      send({ jsonrpc: '2.0', method: 'account/rateLimits/updated', params: {
        threadId: 'fresh-thread',
        remaining: 42,
      } });
      send({ jsonrpc: '2.0', method: 'future/progress', params: {
        threadId: 'fresh-thread',
        stage: 'warming cache',
      } });
      send({ jsonrpc: '2.0', method: 'turn/diff/updated', params: {
        threadId: 'fresh-thread',
        diff: [
          'diff --git a/src/old.ts b/src/new.ts',
          '--- a/src/old.ts',
          '+++ b/src/new.ts',
        ].join('\\n'),
      } });
      send({ jsonrpc: '2.0', method: 'item/started', params: {
        threadId: 'fresh-thread', turnId: 'turn-1',
        item: {
          id: 'reasoning-1',
          type: 'reasoning',
          summary: ['checking protocol', 'checking renderer'],
        },
      } });
      send({ jsonrpc: '2.0', method: 'item/started', params: {
        threadId: 'fresh-thread', turnId: 'turn-1',
        item: { id: 'patch-1', type: 'fileChange' },
      } });
      send({ jsonrpc: '2.0', method: 'item/completed', params: {
        threadId: 'fresh-thread', turnId: 'turn-1',
        item: { id: 'patch-1', type: 'fileChange' },
      } });
      send({ jsonrpc: '2.0', method: 'item/started', params: {
        threadId: 'fresh-thread', turnId: 'turn-1',
        item: {
          id: 'mcp-1',
          type: 'mcpToolCall',
          server: 'browser',
          tool: 'navigate',
          arguments: { url: 'https://example.com' },
        },
      } });
      send({ jsonrpc: '2.0', method: 'item/mcpToolCall/progress', params: {
        threadId: 'fresh-thread', turnId: 'turn-1',
        itemId: 'mcp-1', message: 'loading page',
      } });
      send({ jsonrpc: '2.0', method: 'item/completed', params: {
        threadId: 'fresh-thread', turnId: 'turn-1',
        item: {
          id: 'mcp-1',
          type: 'mcpToolCall',
          server: 'browser',
          tool: 'navigate',
          result: { content: 'ok' },
        },
      } });
      send({ jsonrpc: '2.0', method: 'item/started', params: {
        threadId: 'fresh-thread', turnId: 'turn-1',
        item: { id: 'exec-1', type: 'commandExecution', command: 'run tests' },
      } });
      for (let i = 0; i < 25; i += 1) {
        send({ jsonrpc: '2.0', method: 'item/commandExecution/outputDelta', params: {
          threadId: 'fresh-thread', turnId: 'turn-1', itemId: 'exec-1',
          delta: i === 0 ? 'PRIVATE_COMMAND_DELTA' : '.',
        } });
      }
      send({ jsonrpc: '2.0', method: 'item/reasoning/summaryTextDelta', params: {
        threadId: 'fresh-thread', turnId: 'turn-1', itemId: 'reasoning-1', delta: 'checking model output',
      } });
      send({ jsonrpc: '2.0', method: 'item/completed', params: {
        threadId: 'fresh-thread', turnId: 'turn-1',
        item: {
          id: 'reasoning-1',
          type: 'reasoning',
          summary: ['checking protocol', 'checking renderer'],
        },
      } });
      send({ jsonrpc: '2.0', method: 'item/reasoning/summaryTextDelta', params: {
        threadId: 'fresh-thread', turnId: 'turn-1',
        itemId: 'reasoning-delta-first', delta: 'reviewing streamed reasoning event',
      } });
      send({ jsonrpc: '2.0', method: 'item/reasoning/summaryPartAdded', params: {
        threadId: 'fresh-thread', turnId: 'turn-1',
        itemId: 'reasoning-delta-first', part: 'fallback public summary part',
      } });
      send({ jsonrpc: '2.0', method: 'item/reasoning/textDelta', params: {
        threadId: 'fresh-thread', turnId: 'turn-1',
        itemId: 'reasoning-delta-first', delta: 'PRIVATE_REASONING_TEXT',
      } });
      send({ jsonrpc: '2.0', method: 'item/started', params: {
        threadId: 'fresh-thread', turnId: 'turn-1',
        item: {
          id: 'reasoning-delta-first',
          type: 'reasoning',
          summary: ['reviewing late reasoning summary'],
        },
      } });
      send({ jsonrpc: '2.0', method: 'item/completed', params: {
        threadId: 'fresh-thread', turnId: 'turn-1',
        item: { id: 'reasoning-delta-first', type: 'reasoning' },
      } });
      send({ jsonrpc: '2.0', method: 'item/started', params: {
        threadId: 'fresh-thread', turnId: 'turn-1',
        item: { id: 'reasoning-streamed', type: 'reasoning' },
      } });
      send({ jsonrpc: '2.0', method: 'item/reasoning/summaryTextDelta', params: {
        threadId: 'fresh-thread', turnId: 'turn-1', itemId: 'reasoning-streamed', delta: 'reviewing streamed protocol events',
      } });
      send({ jsonrpc: '2.0', method: 'item/completed', params: {
        threadId: 'fresh-thread', turnId: 'turn-1',
        item: { id: 'reasoning-streamed', type: 'reasoning' },
      } });
      send({ jsonrpc: '2.0', method: 'item/reasoning/summaryPartAdded', params: {
        threadId: 'fresh-thread', turnId: 'turn-1',
        itemId: 'reasoning-part-only', part: 'reviewing fallback summary part',
      } });
      send({ jsonrpc: '2.0', method: 'item/completed', params: {
        threadId: 'fresh-thread', turnId: 'turn-1',
        item: { id: 'reasoning-part-only', type: 'reasoning' },
      } });
      send({ jsonrpc: '2.0', method: 'item/started', params: {
        threadId: 'fresh-thread', turnId: 'turn-1',
        item: {
          id: 'reasoning-raw-only',
          type: 'reasoning',
          text: 'PRIVATE_ITEM_REASONING_TEXT',
        },
      } });
      send({ jsonrpc: '2.0', method: 'item/completed', params: {
        threadId: 'fresh-thread', turnId: 'turn-1',
        item: {
          id: 'reasoning-raw-only',
          type: 'reasoning',
          text: 'PRIVATE_ITEM_REASONING_TEXT',
        },
      } });
      send({ jsonrpc: '2.0', method: 'item/commandExecution/outputDelta', params: {
        threadId: 'fresh-thread', turnId: 'turn-1',
        itemId: 'exec-delta-first', delta: 'PRIVATE_DELTA_FIRST_COMMAND_OUTPUT',
      } });
      send({ jsonrpc: '2.0', method: 'item/completed', params: {
        threadId: 'fresh-thread', turnId: 'turn-1',
        item: {
          id: 'exec-delta-first',
          type: 'commandExecution',
          aggregatedOutput: 'delta-first command complete',
        },
      } });
      send({ jsonrpc: '2.0', method: 'item/reasoning/summaryTextDelta', params: {
        threadId: 'another-thread', turnId: 'turn-other',
        itemId: 'wrong-thread-reasoning', delta: 'PRIVATE_WRONG_THREAD_REASONING',
      } });
      send({ jsonrpc: '2.0', method: 'item/commandExecution/outputDelta', params: {
        threadId: 'another-thread', turnId: 'turn-other',
        itemId: 'wrong-thread-command', delta: 'PRIVATE_WRONG_THREAD_COMMAND',
      } });
      send({ jsonrpc: '2.0', method: 'item/completed', params: {
        threadId: 'fresh-thread', turnId: 'turn-1',
        item: {
          id: 'exec-1',
          type: 'commandExecution',
          command: 'run tests',
          aggregatedOutput: '.........................',
        },
      } });
      send({ jsonrpc: '2.0', method: 'item/started', params: {
        threadId: 'fresh-thread',
        item: { id: 'answer-1', type: 'agentMessage', phase: 'final_answer' },
      } });
      send({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: {
        threadId: 'fresh-thread', itemId: 'answer-1', delta: 'Codex result',
      } });
      send({ jsonrpc: '2.0', method: 'item/completed', params: {
        threadId: 'fresh-thread',
        item: {
          id: 'answer-1',
          type: 'agentMessage',
          phase: 'final_answer',
          text: 'Codex result!',
        },
      } });
      process.stdout.write('codex diagnostic banner\\n');
      process.stderr.write('\\u001b[33mtemporary stderr progress\\u001b[0m\\n');
      send({ jsonrpc: '2.0', method: 'thread/tokenUsage/updated', params: {
        threadId: 'fresh-thread', usage: { input_tokens: 12, output_tokens: 3 },
      } });
      setTimeout(() => {
        send({ jsonrpc: '2.0', method: 'turn/completed', params: {
          threadId: 'fresh-thread', turn: { id: 'turn-1', status: 'completed' },
        } });
      }, 20);
    } else if (message.method === 'turn/steer') {
      if (scenario === 'steer-rejected') {
        send({ jsonrpc: '2.0', id: message.id, error: {
          code: -32602,
          message: 'active turn is no longer steerable',
        } });
      } else {
        send({ jsonrpc: '2.0', id: message.id, result: { turnId: 'turn-1' } });
        send({ jsonrpc: '2.0', method: 'item/started', params: {
          threadId: 'fresh-thread', turnId: 'turn-1',
          item: { id: 'steer-answer', type: 'agentMessage', phase: 'final_answer' },
        } });
        send({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: {
          threadId: 'fresh-thread', turnId: 'turn-1',
          itemId: 'steer-answer', delta: 'steered result',
        } });
      }
      send({ jsonrpc: '2.0', method: 'turn/completed', params: {
        threadId: 'fresh-thread', turn: { id: 'turn-1', status: 'completed' },
      } });
    }
  }
});
process.stdin.on('end', () => {
  if (scenario === 'resume-fallback' || scenario.startsWith('legacy-') || scenario === 'thread-closed') {
    process.exit(0);
  }
});
if (scenario === 'protocol-failure') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
}
if (scenario.endsWith('-lingers') || scenario === 'hang') setInterval(() => {}, 1000);
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

    expect(resume.params).not.toHaveProperty('model');
    expect(resume.params).not.toHaveProperty('developerInstructions');
    expect(start.params).not.toHaveProperty('model');
    expect(start.params.developerInstructions).toBe('durable Orkas instructions');
    expect(turn.params.input).toEqual([{ type: 'text', text: 'bounded recovery\n\ncurrent turn' }]);
    expect(events).toContainEqual({
      type: 'text-delta',
      itemId: 'answer-1',
      phase: 'final_answer',
      text: 'Codex result',
    });
    expect(events).toContainEqual({
      type: 'text-delta',
      itemId: 'answer-1',
      phase: 'final_answer',
      text: '!',
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
    expect(events).not.toContainEqual(expect.objectContaining({
      type: 'log',
      message: expect.stringContaining('item/commandExecution/outputDelta'),
    }));
    expect(events).not.toContainEqual(expect.objectContaining({
      type: 'log',
      message: expect.stringContaining('item/reasoning/summaryTextDelta'),
    }));
    expect(events).toContainEqual({
      type: 'status',
      status: 'retrying',
      attempt: 1,
      message: 'temporary network error',
    });
    expect(events).toContainEqual({
      type: 'status',
      status: 'plan-updated',
      steps: [
        { step: 'inspect', status: 'completed' },
        { step: 'test', status: 'inProgress' },
      ],
      message: 'checking the fix',
    });
    expect(events).toContainEqual({
      type: 'status',
      status: 'waiting-approval',
    });
    expect(events).toContainEqual({
      type: 'status',
      status: 'waiting-input',
    });
    expect(events).toContainEqual({
      type: 'tool-event',
      tool: 'hook:afterTool',
      callId: 'hook-1',
      phase: 'use',
      input: { status: 'running' },
    });
    expect(events).toContainEqual({
      type: 'tool-event',
      tool: 'hook:afterTool',
      callId: 'hook-1',
      phase: 'result',
      output: 'hook line 1\nhook line 2',
    });
    expect(events).toContainEqual({
      type: 'status',
      status: 'compacted',
    });
    expect(events).toContainEqual({
      type: 'status',
      status: 'model-rerouted',
      fromModel: 'gpt-old',
      toModel: 'gpt-new',
      reason: 'capacity',
    });
    expect(events).toContainEqual({
      type: 'log',
      level: 'warn',
      message: 'temporary degraded mode',
      source: 'codex',
    });
    expect(events).not.toContainEqual(expect.objectContaining({
      type: 'log',
      message: expect.stringContaining('wrong thread warning'),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'log',
      level: 'debug',
      message: expect.stringContaining('account/rateLimits/updated'),
      source: 'codex',
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'log',
      level: 'info',
      message: expect.stringContaining('future/progress'),
      source: 'codex',
    }));
    expect(events).toContainEqual({
      type: 'file-change',
      paths: ['src/new.ts'],
    });
    expect(events).toContainEqual({
      type: 'thinking',
      chars: 'checking protocol\nchecking renderer'.length,
      summary: 'checking protocol\nchecking renderer',
      itemId: 'reasoning-1',
    });
    expect(events).toContainEqual({
      type: 'thinking',
      chars: 'reviewing streamed protocol events'.length,
      summary: 'reviewing streamed protocol events',
      itemId: 'reasoning-streamed',
    });
    expect(events).toContainEqual({
      type: 'thinking',
      chars: 'reviewing fallback summary part'.length,
      summary: 'reviewing fallback summary part',
      itemId: 'reasoning-part-only',
    });
    expect(events).toContainEqual({
      type: 'thinking',
      chars: 'PRIVATE_ITEM_REASONING_TEXT'.length,
      itemId: 'reasoning-raw-only',
    });
    expect(events.filter(event => (
      event.type === 'thinking'
      && event.itemId === 'reasoning-delta-first'
      && event.heartbeat !== true
    ))).toEqual([{
      type: 'thinking',
      chars: 'reviewing late reasoning summary'.length,
      summary: 'reviewing late reasoning summary',
      itemId: 'reasoning-delta-first',
    }]);
    expect(events).toContainEqual({
      type: 'thinking',
      chars: 'reviewing streamed reasoning event'.length,
      summary: 'reviewing streamed reasoning event',
      itemId: 'reasoning-delta-first',
      heartbeat: true,
    });
    expect(events.filter(event => (
      event.type === 'status'
      && event.status === 'tool-progress'
      && event.callId === 'exec-1'
    ))).toHaveLength(0);
    expect(events.filter(event => (
      event.type === 'status'
      && event.status === 'tool-progress'
      && event.callId === 'exec-delta-first'
    ))).toEqual([
      {
        type: 'status',
        status: 'tool-progress',
        tool: 'exec_command',
        callId: 'exec-delta-first',
        heartbeat: true,
      },
    ]);
    const serializedEvents = JSON.stringify(events);
    for (const privateValue of [
      'PRIVATE_COMMAND_DELTA',
      'PRIVATE_REASONING_TEXT',
      'PRIVATE_ITEM_REASONING_TEXT',
      'PRIVATE_DELTA_FIRST_COMMAND_OUTPUT',
      'PRIVATE_WRONG_THREAD_REASONING',
      'PRIVATE_WRONG_THREAD_COMMAND',
      'wrong-thread-reasoning',
      'wrong-thread-command',
    ]) {
      expect(serializedEvents).not.toContain(privateValue);
    }
    expect(events.filter(event => (
      event.type === 'tool-event'
      && event.tool === 'patch_apply'
      && event.callId === 'patch-1'
    ))).toEqual([
      {
        type: 'tool-event',
        tool: 'patch_apply',
        callId: 'patch-1',
        phase: 'use',
      },
      {
        type: 'tool-event',
        tool: 'patch_apply',
        callId: 'patch-1',
        phase: 'result',
      },
    ]);
    expect(events).toContainEqual({
      type: 'raw-line',
      line: 'codex diagnostic banner',
    });
    expect(events).toContainEqual({
      type: 'stderr-line',
      line: 'temporary stderr progress',
    });
    expect(events).toContainEqual({
      type: 'status',
      status: 'tool-progress',
      callId: 'mcp-1',
      message: 'loading page',
    });
    expect(events).toContainEqual({
      type: 'tool-event',
      tool: 'browser.navigate',
      callId: 'mcp-1',
      phase: 'use',
      input: { url: 'https://example.com' },
    });
    expect(events).toContainEqual({
      type: 'tool-event',
      tool: 'browser.navigate',
      callId: 'mcp-1',
      phase: 'result',
      output: { content: 'ok' },
    });
    expect(events.filter(event => (
      event.type === 'tool-event'
      && event.tool === 'exec_command'
      && event.callId === 'exec-1'
    ))).toEqual([
      {
        type: 'tool-event',
        tool: 'exec_command',
        callId: 'exec-1',
        phase: 'use',
        input: { command: 'run tests' },
      },
      {
        type: 'tool-event',
        tool: 'exec_command',
        callId: 'exec-1',
        phase: 'result',
        output: '.........................',
      },
    ]);
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      status: 'completed',
      sessionId: 'fresh-thread',
      output: 'Codex result!',
      usage: { input: 12, output: 3 },
    });
  });

  it('steers rich input into the exact active Codex turn and clears ingress at completion', async () => {
    const tracePath = path.join(tempDir, 'steer-trace.json');
    const ingressStates: any[] = [];
    let resolveIngress!: (value: any) => void;
    const ingressReady = new Promise<any>((resolve) => { resolveIngress = resolve; });
    const run = codexBackend.run({
      binPath: fakeCodexPath,
      prompt: 'long-running task',
      customArgs: ['--steer', '--trace', tracePath],
      cwd: process.cwd(),
      signal: new AbortController().signal,
      timeoutMs: 2_000,
      onEvent: () => {},
      onActiveRunIngress: (ingress) => {
        ingressStates.push(ingress);
        if (ingress) resolveIngress(ingress);
      },
    });

    const ingress = await ingressReady;
    const accepted = await ingress.submit({
      id: 'queue-msg-1',
      text: 'Use the new constraint.',
      localImages: [{ path: '/verified/chart.png', mediaType: 'image/png' }],
    });
    await run;

    expect(accepted).toEqual({ mode: 'steered', acceptedId: 'queue-msg-1' });
    const requests = JSON.parse(fs.readFileSync(tracePath, 'utf8'));
    const steer = requests.find((entry: any) => entry.method === 'turn/steer');
    expect(steer.params).toEqual({
      threadId: 'fresh-thread',
      expectedTurnId: 'turn-1',
      clientUserMessageId: 'queue-msg-1',
      input: [
        { type: 'text', text: 'Use the new constraint.' },
        { type: 'localImage', path: '/verified/chart.png' },
      ],
    });
    expect(ingressStates[0]).toBeTruthy();
    expect(ingressStates.at(-1)).toBeNull();
  });

  it('retains a Codex steer as a follow-up when the native turn rejects it', async () => {
    let resolveIngress!: (value: any) => void;
    const ingressReady = new Promise<any>((resolve) => { resolveIngress = resolve; });
    const run = codexBackend.run({
      binPath: fakeCodexPath,
      prompt: 'non-steerable task',
      customArgs: ['--steer-rejected'],
      cwd: process.cwd(),
      signal: new AbortController().signal,
      timeoutMs: 2_000,
      onEvent: () => {},
      onActiveRunIngress: (ingress) => { if (ingress) resolveIngress(ingress); },
    });

    const ingress = await ingressReady;
    const result = await ingress.submit({ id: 'queue-msg-rejected', text: 'try now' });
    await run;

    expect(result).toMatchObject({
      mode: 'queued_followup',
      reason: expect.stringContaining('no longer steerable'),
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

  it('reports a spawn failure as one terminal event', async () => {
    const events: any[] = [];

    await codexBackend.run({
      binPath: path.join(tempDir, 'missing-codex-binary'),
      prompt: 'never starts',
      cwd: process.cwd(),
      signal: new AbortController().signal,
      timeoutMs: 2_000,
      onEvent: event => events.push(event),
    });

    expect(events.at(-1)).toMatchObject({
      type: 'done',
      status: 'failed',
      error: expect.stringMatching(/ENOENT|not found/i),
    });
    expect(events.filter(event => event.type === 'done')).toHaveLength(1);
  });

  it('settles a fatal protocol error before a lingering CLI process exits', async () => {
    const events: any[] = [];
    let pid = -1;
    const startedAt = Date.now();

    try {
      await codexBackend.run({
        binPath: fakeCodexPath,
        prompt: 'fails after starting',
        customArgs: ['--fatal-lingers'],
        cwd: process.cwd(),
        signal: new AbortController().signal,
        timeoutMs: 5_000,
        onEvent: event => {
          events.push(event);
          if (event.type === 'process-info') pid = Number(event.pid);
        },
      });

      expect(Date.now() - startedAt).toBeLessThan(750);
      expect(events.at(-1)).toMatchObject({
        type: 'done',
        status: 'failed',
        error: 'network retry limit reached',
      });
      await expectProcessToExit(pid, 2_000);
    } finally {
      if (pid > 0) {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* already exited */ }
      }
    }
  });

  it.each([
    {
      scenario: 'success-lingers',
      expected: { status: 'completed', output: 'terminal result' },
    },
    {
      scenario: 'idle-lingers',
      expected: { status: 'completed', output: 'terminal result' },
    },
    {
      scenario: 'interrupted-lingers',
      expected: { status: 'cancelled' },
    },
    {
      scenario: 'system-error-lingers',
      expected: { status: 'failed', error: 'codex thread entered a system error state' },
    },
    {
      scenario: 'thread-closed',
      expected: { status: 'completed', output: '' },
    },
  ])('settles $scenario from its authoritative terminal event', async ({ scenario, expected }) => {
    const events: any[] = [];
    let pid = -1;
    const startedAt = Date.now();

    try {
      await codexBackend.run({
        binPath: fakeCodexPath,
        prompt: 'terminal matrix',
        customArgs: [`--${scenario}`],
        cwd: process.cwd(),
        signal: new AbortController().signal,
        timeoutMs: 5_000,
        onEvent: event => {
          events.push(event);
          if (event.type === 'process-info') pid = Number(event.pid);
        },
      });

      expect(Date.now() - startedAt).toBeLessThan(750);
      expect(events.at(-1)).toMatchObject({ type: 'done', ...expected });
      expect(events.filter(event => event.type === 'done')).toHaveLength(1);
      await expectProcessToExit(pid, 2_000);
    } finally {
      if (pid > 0) {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* already exited */ }
      }
    }
  });

  it.each([
    {
      scenario: 'legacy-complete',
      expected: { status: 'completed', output: 'legacy result' },
    },
    {
      scenario: 'legacy-abort',
      expected: { status: 'cancelled', output: '' },
    },
  ])('supports the $scenario compatibility protocol', async ({ scenario, expected }) => {
    const events: any[] = [];

    await codexBackend.run({
      binPath: fakeCodexPath,
      prompt: 'legacy protocol',
      customArgs: [`--${scenario}`],
      cwd: process.cwd(),
      signal: new AbortController().signal,
      timeoutMs: 2_000,
      onEvent: event => events.push(event),
    });

    expect(events).toContainEqual({
      type: 'status',
      status: 'running',
    });
    expect(events.filter(event => (
      event.type === 'tool-event' && event.callId === 'legacy-exec'
    ))).toEqual([
      {
        type: 'tool-event',
        tool: 'exec_command',
        callId: 'legacy-exec',
        phase: 'use',
        input: { command: 'legacy command' },
      },
      {
        type: 'tool-event',
        tool: 'exec_command',
        callId: 'legacy-exec',
        phase: 'result',
        output: 'legacy output',
      },
    ]);
    expect(events.filter(event => (
      event.type === 'tool-event' && event.callId === 'legacy-patch'
    ))).toEqual([
      {
        type: 'tool-event',
        tool: 'patch_apply',
        callId: 'legacy-patch',
        phase: 'use',
      },
      {
        type: 'tool-event',
        tool: 'patch_apply',
        callId: 'legacy-patch',
        phase: 'result',
      },
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'done', ...expected });
    expect(events.filter(event => event.type === 'done')).toHaveLength(1);
  });

  it('reports cancellation when an in-flight Codex process is aborted', async () => {
    const events: any[] = [];
    let pid = -1;
    const controller = new AbortController();

    try {
      const run = codexBackend.run({
        binPath: fakeCodexPath,
        prompt: 'wait forever',
        customArgs: ['--hang'],
        cwd: process.cwd(),
        signal: controller.signal,
        timeoutMs: 5_000,
        onEvent: event => {
          events.push(event);
          if (event.type === 'process-info') pid = Number(event.pid);
        },
      });
      setTimeout(() => controller.abort(), 50);
      await run;

      expect(events.at(-1)).toMatchObject({ type: 'done', status: 'cancelled' });
      expect(events.filter(event => event.type === 'done')).toHaveLength(1);
      await expectProcessToExit(pid);
    } finally {
      if (pid > 0) {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* already exited */ }
      }
    }
  });

  it('reports timeout when Codex never emits a terminal event', async () => {
    const events: any[] = [];
    let pid = -1;

    try {
      await codexBackend.run({
        binPath: fakeCodexPath,
        prompt: 'wait forever',
        customArgs: ['--hang'],
        cwd: process.cwd(),
        signal: new AbortController().signal,
        timeoutMs: 100,
        onEvent: event => {
          events.push(event);
          if (event.type === 'process-info') pid = Number(event.pid);
        },
      });

      expect(events.at(-1)).toMatchObject({ type: 'done', status: 'timeout' });
      expect(events.filter(event => event.type === 'done')).toHaveLength(1);
      await expectProcessToExit(pid);
    } finally {
      if (pid > 0) {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* already exited */ }
      }
    }
  });
});

describe('CodexActivityHeartbeat', () => {
  it('emits content-free pulses only for active reasoning and command items', () => {
    const activity = new CodexActivityHeartbeat();

    expect(activity.startReasoning('reasoning-1')).toBe(true);
    expect(activity.startReasoning('reasoning-1')).toBe(false);
    expect(activity.startCommand('command-1')).toBe(true);
    expect(activity.pulseEvents()).toEqual([
      { type: 'thinking', chars: 0, itemId: 'reasoning-1', heartbeat: true, synthetic: true },
      {
        type: 'status',
        status: 'tool-progress',
        tool: 'exec_command',
        callId: 'command-1',
        heartbeat: true,
        synthetic: true,
      },
    ]);

    activity.complete('reasoning-1');
    activity.complete('command-1');
    expect(activity.pulseEvents()).toEqual([]);
  });

  it('ignores empty/duplicate ids and removes active item kinds independently', () => {
    const activity = new CodexActivityHeartbeat();

    expect(activity.startReasoning('')).toBe(false);
    expect(activity.startCommand('')).toBe(false);
    expect(activity.startReasoning('reasoning-1')).toBe(true);
    expect(activity.startCommand('command-1')).toBe(true);
    expect(activity.startCommand('command-1')).toBe(false);
    activity.complete('unknown-id');
    expect(activity.pulseEvents()).toHaveLength(2);

    activity.complete('reasoning-1');
    expect(activity.pulseEvents()).toEqual([
      {
        type: 'status',
        status: 'tool-progress',
        tool: 'exec_command',
        callId: 'command-1',
        heartbeat: true,
        synthetic: true,
      },
    ]);
    activity.complete('command-1');
    expect(activity.pulseEvents()).toEqual([]);
  });

  it('never puts reasoning or command content into heartbeat payloads', () => {
    const activity = new CodexActivityHeartbeat();
    activity.startReasoning('reasoning-private');
    activity.startCommand('command-private');

    for (const event of activity.pulseEvents()) {
      expect(event).not.toHaveProperty('text');
      expect(event).not.toHaveProperty('delta');
      expect(event).not.toHaveProperty('output');
      expect(event.heartbeat).toBe(true);
      expect(event.synthetic).toBe(true);
    }
  });
});

async function expectProcessToExit(pid: number, timeoutMs = 750): Promise<void> {
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
  throw new Error(`Codex child process ${pid} is still alive after protocol failure`);
}
