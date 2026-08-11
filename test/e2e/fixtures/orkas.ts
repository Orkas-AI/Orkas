import { createHash, randomInt, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import AdmZip from 'adm-zip';
import {
  _electron as electron,
  expect,
  test as base,
  type ElectronApplication,
  type Page,
  type TestInfo,
} from '@playwright/test';

const PC_ROOT = path.resolve(__dirname, '../../..');
const ACCOUNT_USER_ID = 'account-e2e';
const MAX_LOG_BYTES = 2 * 1024 * 1024;
/** Evidence files read per model round in the context-compaction scenario.
 *  Four ~11.2K-token results stay well under the per-round inline allowance,
 *  so the batch builds context instead of spilling to disk. */
const CONTEXT_SOURCE_READS_PER_ROUND = 4;
const E2E_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const E2E_MP4_BYTES = Buffer.from([
  0x00, 0x00, 0x00, 0x18,
  0x66, 0x74, 0x79, 0x70,
  0x69, 0x73, 0x6f, 0x6d,
  0x00, 0x00, 0x02, 0x00,
  0x69, 0x73, 0x6f, 0x6d,
  0x69, 0x73, 0x6f, 0x32,
]);

type OrkasOptions = {
  authenticated?: boolean;
  configuredModel?: boolean;
  setDefaultViewport?: boolean;
  modelStub?: boolean;
  marketplaceStub?: boolean;
  cliStub?: boolean;
  accountStub?: boolean;
  updateStub?: boolean;
  voiceStub?: boolean;
  metacognitionEnabled?: boolean;
};

export type CliStubInvocation = {
  cli: 'opencode' | 'hermes' | 'codex' | 'claude';
  args: string[];
  prompt: string;
  resumeSessionId: string | null;
  sessionId: string;
  model?: string;
  effort?: string;
  toolExecuted?: boolean;
  steers?: Array<{ id: string | null; text: string; localImages: string[] }>;
};

export type CliStubState = {
  nextSession: number;
  attempts: Record<string, number>;
  toolExecutions: number;
  invocations: CliStubInvocation[];
  modelListCalls: number;
  modelListResponses: number;
};

type ModelStubMode = 'success' | 'refusal' | 'http-error' | 'auth-error' | 'slow' | 'very-slow' | 'truncated';
type ShareStubMode = 'success' | 'failure';
type VoiceStubMode = 'success' | 'blocked-open';
type SystemIdleState = 'active' | 'idle' | 'locked' | 'unknown';
type AgentFanoutTarget = {
  agentId: string;
  task: string;
  finalText: string;
};
type ModelToolScenario =
  | { kind: 'connector'; connectorId: string }
  | { kind: 'bash-sequence'; commands: string[]; finalText: string }
  | {
    kind: 'produced-file-cleanup';
    filePath: string;
    content: string;
    deleteCommand: string;
    finalText: string;
    bashArgumentDelayMs: number;
  }
  | { kind: 'interactive-cli'; command: string; purpose: string }
  | {
    kind: 'write-file';
    filePath: string;
    content: string;
    finalText: string;
    toolArgumentDelayMs?: number;
  }
  | { kind: 'generate-speech'; text: string; outputPath: string; finalText: string }
  | { kind: 'generate-image'; prompt: string; outputPath: string; finalText: string }
  | {
    kind: 'generate-video';
    prompt: string;
    outputPath: string;
    finalText: string;
    referenceImagePath?: string;
  }
  | {
    kind: 'agent-handoff';
    agentId: string;
    task: string;
    finalText: string;
    commanderNarration?: string;
    holdAgentReply?: boolean;
  }
  | {
    kind: 'interactive-agent-resume';
    agentId: string;
    task: string;
    resume: string;
    formText: string;
    handbackText: string;
    commanderFinalText: string;
  }
  | {
    kind: 'agent-handoff-retry';
    agentId: string;
    task: string;
    recoveryText: string;
    recoveryEnabled: boolean;
  }
  | {
    kind: 'agent-fanout';
    targets: AgentFanoutTarget[];
    commanderFinalText: string;
  }
  | {
    kind: 'commander-segments';
    narration: string;
    agentId: string;
    task: string;
    agentFinalText: string;
    synthesis: string;
  }
  | {
    kind: 'project-history';
    query: string;
    sourceCid: string;
    finalText: string;
  }
  | {
    kind: 'project-instructions';
    instructions: string;
    finalText: string;
    toolDelayMs: number;
  }
  | {
    kind: 'knowledge-base';
    query: string;
    filePath: string;
    expectedFact: string;
    finalText: string;
  }
  | {
    kind: 'context-compaction';
    sources: Array<{ path: string; fact: string }>;
    nextSourceIndex: number;
    finalText: string;
    stallCompaction: boolean;
  };

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

const TEST_NODE = process.env.ORKAS_TEST_NODE || process.execPath;

function writeNodeExecutable(directory: string, name: string, source: string): string {
  mkdirSync(directory, { recursive: true });
  const scriptName = `${name}.js`;
  writeFileSync(path.join(directory, scriptName), source, 'utf8');
  if (process.platform === 'win32') {
    const launcher = path.join(directory, `${name}.cmd`);
    const powershellLauncher = path.join(directory, `${name}.ps1`);
    const safeNode = TEST_NODE.replace(/'/g, "''");
    writeFileSync(launcher, [
      '@echo off',
      `"${TEST_NODE}" "%~dp0${scriptName}" %*`,
      '',
    ].join('\r\n'), 'utf8');
    writeFileSync(powershellLauncher, [
      '$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent',
      `& '${safeNode}' "$basedir/${scriptName}" $args`,
      'exit $LASTEXITCODE',
      '',
    ].join('\r\n'), 'utf8');
    return launcher;
  }
  const launcher = path.join(directory, name);
  const safeNode = TEST_NODE.replace(/'/g, `'\\''`);
  writeFileSync(launcher, [
    '#!/bin/sh',
    'case "$1" in',
    "  --version|version) printf '%s\\n' '99.0.0'; exit 0 ;;",
    'esac',
    `exec '${safeNode}' "$(dirname "$0")/${scriptName}" "$@"`,
    '',
  ].join('\n'), 'utf8');
  chmodSync(launcher, 0o755);
  return launcher;
}

function fakeOpenCodeSource(): string {
  return String.raw`
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version') || args[0] === 'version') {
  process.stdout.write('99.0.0\n');
  process.exit(0);
}
const statePath = process.env.ORKAS_E2E_CLI_STATE;
const blank = () => ({ nextSession: 0, attempts: {}, toolExecutions: 0, invocations: [] });
const readState = () => {
  try { return { ...blank(), ...JSON.parse(fs.readFileSync(statePath, 'utf8')) }; }
  catch { return blank(); }
};
const state = readState();
const sessionIndex = args.indexOf('--session');
const resumeSessionId = sessionIndex >= 0 ? String(args[sessionIndex + 1] || '') : '';
const prompt = String(args[args.length - 1] || '');
let marker = 'default';
for (const candidate of [
  'E2E_CLI_ESTABLISH_SESSION',
  'E2E_CLI_RESUME_AFTER_RELAUNCH',
  'E2E_CLI_RESTART_STALE_BINDING',
  'E2E_CLI_SEND_NOW_ACTIVE',
  'E2E_CLI_SEND_NOW_FOLLOWUP',
]) {
  if (prompt.includes(candidate)) marker = candidate;
}
const attempt = Number(state.attempts[marker] || 0) + 1;
state.attempts[marker] = attempt;
let sessionId = resumeSessionId;
if (!sessionId) sessionId = 'opencode-e2e-' + String(++state.nextSession);
const invocation = {
  cli: 'opencode', args, prompt,
  resumeSessionId: resumeSessionId || null,
  sessionId,
};
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');

if (marker === 'E2E_CLI_SEND_NOW_ACTIVE') {
  state.invocations.push(invocation);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  setTimeout(() => {
    emit({ type: 'text', sessionID: sessionId, part: { text: 'E2E_CLI_SEND_NOW_ACTIVE_OK' } });
  }, 4000);
} else if (marker === 'E2E_CLI_RESUME_AFTER_RELAUNCH' && attempt === 1) {
  invocation.toolExecuted = true;
  state.toolExecutions += 1;
  state.invocations.push(invocation);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  emit({ type: 'tool_use', sessionID: sessionId, part: { tool: 'exec_command', callID: 'e2e-tool-1', state: { status: 'running', input: { command: 'e2e-side-effect' } } } });
  emit({ type: 'tool_use', sessionID: sessionId, part: { tool: 'exec_command', callID: 'e2e-tool-1', state: { status: 'completed', output: 'side-effect-complete' } } });
  process.stderr.write('deterministic failure after tool execution\n');
  process.exitCode = 7;
} else if (marker === 'E2E_CLI_RESTART_STALE_BINDING' && attempt === 1) {
  state.invocations.push(invocation);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  process.stderr.write('deterministic failure before a new session is observed\n');
  process.exitCode = 7;
} else {
  state.invocations.push(invocation);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  let text = 'E2E_CLI_DEFAULT_OK';
  if (marker === 'E2E_CLI_RESUME_AFTER_RELAUNCH') text = 'E2E_CLI_RESUMED_WITHOUT_DUPLICATE_TOOL';
  if (marker === 'E2E_CLI_RESTART_STALE_BINDING') text = 'E2E_CLI_FRESH_RESTART_OK';
  if (marker === 'E2E_CLI_ESTABLISH_SESSION') text = 'E2E_CLI_SESSION_ESTABLISHED';
  if (marker === 'E2E_CLI_SEND_NOW_FOLLOWUP') text = 'E2E_CLI_SEND_NOW_FOLLOWUP_OK';
  emit({ type: 'text', sessionID: sessionId, part: { text } });
}
`;
}

function fakeHermesSource(): string {
  return String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
const args = process.argv.slice(2);
if (args.includes('--version') || args[0] === 'version') {
  process.stdout.write('Hermes Agent v99.0.0\n');
  process.exit(0);
}

const statePath = process.env.ORKAS_E2E_CLI_STATE;
const blank = () => ({ nextSession: 0, attempts: {}, toolExecutions: 0, invocations: [] });
const readState = () => {
  try { return { ...blank(), ...JSON.parse(fs.readFileSync(statePath, 'utf8')) }; }
  catch { return blank(); }
};
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let sessionId = '';
const input = readline.createInterface({ input: process.stdin });
input.on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === 1) {
    send({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } });
    return;
  }
  if (message.id === 2) {
    const state = readState();
    sessionId = 'hermes-e2e-' + String(++state.nextSession);
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    send({ jsonrpc: '2.0', id: 2, result: { sessionId } });
    return;
  }
  if (message.id === 100) {
    const prompt = String(message.params?.prompt?.[0]?.text || '');
    const state = readState();
    state.invocations.push({
      cli: 'hermes', args, prompt, resumeSessionId: null, sessionId,
    });
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    let text = 'E2E_HERMES_FIRST_OK';
    if (prompt.includes('E2E_HERMES_CONTINUE') && prompt.includes('E2E_HERMES_PRIOR_FACT')) {
      text = 'E2E_HERMES_HISTORY_BRIDGED';
    } else if (prompt.includes('E2E_HERMES_CONTINUE')) {
      text = 'E2E_HERMES_HISTORY_MISSING';
    } else if (prompt.includes('E2E_HERMES_LIMITS_CURRENT_TASK')) {
      text = 'E2E_HERMES_LIMITS_OK';
    }
    send({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    } });
    send({ jsonrpc: '2.0', id: 100, result: { stopReason: 'end_turn' } });
  }
});
`;
}

function fakeClaudeSource(): string {
  return String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
const args = process.argv.slice(2);
if (args.includes('--version') || args[0] === 'version') {
  process.stdout.write('2.1.148 (Claude Code)\n');
  process.exit(0);
}
if (args.includes('--help')) {
  process.stdout.write('Usage: claude --model <model> --effort <level>\n');
  process.exit(0);
}
const statePath = process.env.ORKAS_E2E_CLI_STATE;
const blank = () => ({
  nextSession: 0, attempts: {}, toolExecutions: 0, invocations: [],
  modelListCalls: 0, modelListResponses: 0,
});
const readState = () => {
  try { return { ...blank(), ...JSON.parse(fs.readFileSync(statePath, 'utf8')) }; }
  catch { return blank(); }
};
const writeState = state => fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const argValue = name => {
  const index = args.indexOf(name);
  return index >= 0 ? String(args[index + 1] || '') : '';
};
const requestedModel = argValue('--model');
const effort = argValue('--effort');
const resumeSessionId = argValue('--resume');
const concreteModels = {
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-6',
  haiku: 'claude-haiku-4-5',
};
const concreteModel = concreteModels[requestedModel] || requestedModel || 'claude-sonnet-4-6';
const input = readline.createInterface({ input: process.stdin });
let handled = false;
input.on('line', line => {
  if (handled) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.type !== 'user') return;
  handled = true;
  const prompt = String(message.message?.content?.[0]?.text || '');
  const state = readState();
  const sessionId = resumeSessionId || 'claude-e2e-' + String(++state.nextSession);
  state.invocations.push({
    cli: 'claude', args, prompt,
    resumeSessionId: resumeSessionId || null,
    sessionId,
    model: requestedModel || undefined,
    effort: effort || undefined,
  });
  writeState(state);
  send({ type: 'system', subtype: 'init', session_id: sessionId });
  send({
    type: 'assistant', session_id: sessionId,
    message: {
      model: concreteModel,
      usage: { input_tokens: 12, output_tokens: 8 },
      content: [{ type: 'text', text: 'E2E_CLAUDE_MODEL_RESOLVED' }],
    },
  });
  send({
    type: 'result', subtype: 'success', session_id: sessionId,
    result: 'E2E_CLAUDE_MODEL_RESOLVED',
    usage: { input_tokens: 12, output_tokens: 8 },
    message: { model: concreteModel },
  });
});
`;
}

function fakeCodexSource(): string {
  return String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
const args = process.argv.slice(2);
if (args.includes('--version') || args[0] === 'version') {
  process.stdout.write('codex-cli 99.0.0\n');
  process.exit(0);
}
const statePath = process.env.ORKAS_E2E_CLI_STATE;
const blank = () => ({
  nextSession: 0, attempts: {}, toolExecutions: 0, invocations: [],
  modelListCalls: 0, modelListResponses: 0,
});
const readState = () => {
  try { return { ...blank(), ...JSON.parse(fs.readFileSync(statePath, 'utf8')) }; }
  catch { return blank(); }
};
const writeState = state => fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let threadId = '';
let turnId = '';
let invocationIndex = -1;
let resumedThreadId = '';
const finish = text => {
  send({ method: 'item/started', params: {
    threadId, turnId,
    item: { id: 'answer-steer', type: 'agentMessage', phase: 'final_answer' },
  } });
  send({ method: 'item/agentMessage/delta', params: {
    threadId, turnId, itemId: 'answer-steer', delta: text,
  } });
  send({ method: 'item/completed', params: {
    threadId, turnId,
    item: { id: 'answer-steer', type: 'agentMessage', phase: 'final_answer', text },
  } });
  send({ method: 'turn/completed', params: {
    threadId, turn: { id: turnId, status: 'completed' },
  } });
};
const input = readline.createInterface({ input: process.stdin });
input.on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: 'orkas-e2e-codex' } });
    return;
  }
  if (message.method === 'model/list') {
    const state = readState();
    state.modelListCalls += 1;
    writeState(state);
    const data = state.modelListCalls === 3 ? [] : [
        {
          id: 'gpt-e2e-default',
          model: 'gpt-e2e-default',
          displayName: 'GPT E2E Default',
          isDefault: true,
          defaultReasoningEffort: 'low',
          supportedReasoningEfforts: [
            { reasoningEffort: 'low', description: 'Fast' },
            { reasoningEffort: 'high', description: 'Deep' },
          ],
        },
        {
          id: 'gpt-e2e-deep',
          model: 'gpt-e2e-deep',
          displayName: 'GPT E2E Deep',
          isDefault: false,
          defaultReasoningEffort: 'high',
          supportedReasoningEfforts: [
            { reasoningEffort: 'low', description: 'Fast' },
            { reasoningEffort: 'high', description: 'Deep' },
          ],
        },
      ];
    if (state.modelListCalls >= 2 && state.modelListCalls !== 3) {
      data.push({
        id: 'gpt-e2e-fresh',
        model: 'gpt-e2e-fresh',
        displayName: 'GPT E2E Fresh',
        isDefault: false,
        defaultReasoningEffort: 'low',
        supportedReasoningEfforts: [
          { reasoningEffort: 'low', description: 'Fast' },
          { reasoningEffort: 'high', description: 'Deep' },
        ],
      });
    }
    const respond = () => {
      const latest = readState();
      latest.modelListResponses += 1;
      writeState(latest);
      send({ id: message.id, result: { data, nextCursor: null } });
    };
    if (state.modelListCalls === 2) setTimeout(respond, 5000);
    else respond();
    return;
  }
  if (message.method === 'thread/start' || message.method === 'thread/resume') {
    const state = readState();
    resumedThreadId = message.method === 'thread/resume'
      ? String(message.params?.threadId || '')
      : '';
    threadId = resumedThreadId || 'codex-e2e-' + String(++state.nextSession);
    writeState(state);
    send({ id: message.id, result: { threadId } });
    return;
  }
  if (message.method === 'turn/start') {
    turnId = 'turn-e2e-1';
    const prompt = String(message.params?.input?.find(part => part.type === 'text')?.text || '');
    const state = readState();
    invocationIndex = state.invocations.length;
    state.invocations.push({
      cli: 'codex', args, prompt,
      resumeSessionId: resumedThreadId || null,
      sessionId: threadId,
      model: message.params?.model,
      effort: message.params?.effort,
      steers: [],
    });
    writeState(state);
    send({ id: message.id, result: { turn: { id: turnId } } });
    send({ method: 'turn/started', params: {
      threadId, turn: { id: turnId, status: 'inProgress' },
    } });
    if (!prompt.includes('E2E_CODEX_SEND_NOW_ACTIVE')) finish('E2E_CODEX_DEFAULT_OK');
    return;
  }
  if (message.method === 'turn/steer') {
    const state = readState();
    const richInput = Array.isArray(message.params?.input) ? message.params.input : [];
    const text = richInput.filter(part => part.type === 'text').map(part => String(part.text || '')).join('\n');
    const localImages = richInput.filter(part => part.type === 'localImage').map(part => String(part.path || ''));
    const invocation = state.invocations[invocationIndex];
    if (invocation) {
      invocation.steers.push({
        id: message.params?.clientUserMessageId || null,
        text,
        localImages,
      });
    }
    writeState(state);
    send({ id: message.id, result: { turnId } });
    finish(text.includes('E2E_CODEX_SEND_NOW_UPDATE')
      ? 'E2E_CODEX_STEER_APPLIED'
      : 'E2E_CODEX_STEER_MISSING');
  }
});
`;
}

function seedUserWorkspace(
  workspaceRoot: string,
  userId: string,
  authenticated: boolean,
  profile: { nickname: string; email: string } = {
    nickname: 'E2E User',
    email: 'e2e@example.invalid',
  },
  subscription: Record<string, unknown> = {
    plan: 'free',
    status: 'active',
  },
): void {
  const now = '2026-01-01T00:00:00.000Z';

  writeJson(
    path.join(workspaceRoot, userId, 'cloud', 'config', 'preferences.json'),
    {
      language: 'en',
      task_notifications_enabled: true,
      metacognition_enabled: false,
      global_skill_roots_enabled: false,
    },
  );

  if (!authenticated) return;

  writeJson(
    path.join(workspaceRoot, userId, 'local', 'config', 'account.json'),
    {
      version: 2,
      device_id: `e2e-${randomUUID()}`,
      user_id: userId,
      session_id: `e2e-session-${randomUUID()}`,
      user_info: {
        id: userId,
        nickname: profile.nickname,
        email: profile.email,
      },
      subscription,
    },
  );
}

function seedWorkspace(
  workspaceRoot: string,
  authenticated: boolean,
  subscription?: Record<string, unknown>,
): void {
  const userId = authenticated ? ACCOUNT_USER_ID : 'anonymous';
  const now = '2026-01-01T00:00:00.000Z';
  writeJson(path.join(workspaceRoot, 'users.json'), {
    current_user_id: userId,
    dev_current_user_id: userId,
    users: [{ user_id: userId, created_at: now }],
  });
  seedUserWorkspace(workspaceRoot, userId, authenticated, undefined, subscription);
}

function collectLogFiles(root: string): string {
  const chunks: string[] = [];
  let totalBytes = 0;

  const visit = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (totalBytes >= MAX_LOG_BYTES) return;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.log')) continue;
      try {
        const body = readFileSync(fullPath, 'utf8');
        const available = MAX_LOG_BYTES - totalBytes;
        const slice = body.slice(0, available);
        chunks.push(`\n===== ${path.relative(root, fullPath)} =====\n${slice}`);
        totalBytes += Buffer.byteLength(slice);
      } catch {
        // A log may be rotated while Electron is shutting down.
      }
    }
  };

  visit(root);
  return chunks.join('');
}

export class OrkasTestApp {
  readonly root: string;
  readonly workspaceRoot: string;
  readonly userWorkspaceRoot: string;
  readonly userDataRoot: string;
  readonly authRoot: string;
  readonly authenticated: boolean;
  readonly configuredModel: boolean;
  readonly setDefaultViewport: boolean;
  readonly modelStub: boolean;
  readonly marketplaceStub: boolean;
  readonly cliStub: boolean;
  readonly accountStub: boolean;
  readonly updateStub: boolean;
  readonly voiceStub: boolean;
  readonly metacognitionEnabled: boolean;
  readonly cliStatePath: string;
  readonly fakeOpenCodePath: string | null;
  readonly fakeHermesPath: string | null;
  readonly fakeCodexPath: string | null;
  readonly fakeClaudePath: string | null;
  readonly modelRequests: Array<Record<string, unknown>> = [];
  readonly imageGenerationRequests: Array<Record<string, unknown>> = [];
  readonly videoEstimateRequests: Array<Record<string, unknown>> = [];
  readonly videoGenerationRequests: Array<Record<string, unknown>> = [];
  readonly generationReferenceUploads: Array<{
    bytes: number;
    contentType: string;
    contentMd5: string;
    acl: string;
    encryption: string;
    body: string;
  }> = [];
  readonly shareCreateRequests: Array<Record<string, unknown>> = [];
  readonly marketplaceRequests: Array<{ path: string; body: Record<string, unknown> }> = [];
  readonly creditTransactionRequests: string[] = [];
  readonly apiRequests: Array<{ method: string; path: string; channel: string }> = [];
  compactionRequestAborts = 0;
  imageTaskPolls = 0;
  videoTaskPolls = 0;

  electronApp: ElectronApplication | null = null;
  page: Page | null = null;
  lastLaunchReadyMs: number | null = null;

  private apiServer: Server | null = null;
  private apiBaseUrl = 'http://127.0.0.1:9/api';
  private modelStubMode: ModelStubMode = 'success';
  private clientConfigGeneration = 0;
  private clientConfigImmediate: Record<string, unknown> = {
    'feature.e2e_published': 'generation-a',
  };
  private shareStubMode: ShareStubMode = 'success';
  private voiceStubMode: VoiceStubMode = 'success';
  private readonly modelTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly voiceSockets = new Set<Duplex>();
  private readonly testInfo: TestInfo;
  private readonly diagnostics: string[] = [];
  private readonly rendererPageErrors: string[] = [];
  private readonly tracePaths: string[] = [];
  private traceNumber = 0;
  private activeUserId: string;
  private readonly configuredModelSeededUsers = new Set<string>();
  private modelToolScenario: ModelToolScenario | null = null;
  private modelToolScenarioRequestStart = 0;
  private pendingAgentHandoffReply: (() => void) | null = null;
  private modelTextReplies: string[] = [];
  private libraryImageDescriptionReplies: string[] = [];
  private readonly accountSubscription = {
    billing_enabled: true,
    tier: 'pro',
    status: 'active',
    current_period_end: 1_830_297_600,
    benefits: {
      credits: {
        monthly_used: 250,
        monthly_total: 1_000,
        monthly_remaining: 750,
        lifetime: 125,
        available: 875,
      },
      cloud_storage: {
        used_bytes: 1_048_576,
        total_bytes: 10_485_760,
      },
    },
  };

  constructor(testInfo: TestInfo, options: OrkasOptions = {}) {
    this.testInfo = testInfo;
    this.authenticated = options.authenticated !== false;
    this.configuredModel = options.configuredModel !== false;
    this.setDefaultViewport = options.setDefaultViewport !== false;
    this.modelStub = options.modelStub === true;
    this.marketplaceStub = options.marketplaceStub === true;
    this.cliStub = options.cliStub === true;
    this.accountStub = options.accountStub === true;
    this.updateStub = options.updateStub === true;
    this.voiceStub = options.voiceStub === true;
    this.metacognitionEnabled = options.metacognitionEnabled === true;
    this.root = mkdtempSync(path.join(tmpdir(), 'orkas-e2e-'));
    this.workspaceRoot = path.join(this.root, 'workspace');
    this.userWorkspaceRoot = path.join(this.root, 'userWorkSpace');
    this.userDataRoot = path.join(this.root, 'electron-user-data');
    this.authRoot = path.join(this.root, 'core-agent-auth');
    this.activeUserId = this.authenticated ? ACCOUNT_USER_ID : 'anonymous';
    this.cliStatePath = path.join(this.root, 'cli-stub-state.json');
    // Match the layout of npm-installed Windows CLI shims. The production
    // launcher deliberately applies a second metacharacter-escaping pass for
    // node_modules/.bin/*.cmd because those shims forward argv through `%*`.
    const cliBinRoot = path.join(this.root, 'cli-bin', 'node_modules', '.bin');
    this.fakeOpenCodePath = this.cliStub
      ? writeNodeExecutable(cliBinRoot, 'opencode-e2e', fakeOpenCodeSource())
      : null;
    this.fakeHermesPath = this.cliStub
      ? writeNodeExecutable(cliBinRoot, 'hermes-e2e', fakeHermesSource())
      : null;
    this.fakeCodexPath = this.cliStub
      ? writeNodeExecutable(cliBinRoot, 'codex-e2e', fakeCodexSource())
      : null;
    this.fakeClaudePath = this.cliStub
      ? writeNodeExecutable(cliBinRoot, 'claude-e2e', fakeClaudeSource())
      : null;
    if (this.cliStub) {
      writeJson(this.cliStatePath, {
        nextSession: 0,
        attempts: {},
        toolExecutions: 0,
        invocations: [],
        modelListCalls: 0,
        modelListResponses: 0,
      } satisfies CliStubState);
    }
    seedWorkspace(
      this.workspaceRoot,
      this.authenticated,
      this.accountStub ? this.accountSubscription : undefined,
    );
    if (this.updateStub && this.authenticated) {
      writeJson(
        path.join(this.workspaceRoot, this.activeUserId, 'local', 'config', 'remote-config.json'),
        {
          version: 1,
          etag: `"sha256:e2e-client-config-generation"`,
          config_hash: 'sha256:e2e-client-config-generation',
          last_request_at_ms: Date.now(),
          active: {
            immediate: { 'feature.e2e_published': 'generation-a' },
            restart: {},
          },
          fetched_at_ms: Date.now(),
        },
      );
    }
    mkdirSync(this.userDataRoot, { recursive: true });
    mkdirSync(this.authRoot, { recursive: true });
    mkdirSync(this.userWorkspaceRoot, { recursive: true });
  }

  async launch(): Promise<void> {
    if (this.electronApp) throw new Error('Orkas Electron app is already running');
    this.lastLaunchReadyMs = null;
    if (
      this.modelStub
      || this.marketplaceStub
      || this.accountStub
      || this.updateStub
      || this.voiceStub
    ) {
      await this.ensureStubServer();
    }
    const launchStartedAt = Date.now();

    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      ORKAS_WORKSPACE_ROOT: this.workspaceRoot,
      ORKAS_E2E_USER_DATA_DIR: this.userDataRoot,
      ORKAS_E2E_HIDE_WINDOW: process.env.PWDEBUG === '1' || process.env.ORKAS_E2E_SHOW_WINDOW === '1' ? '0' : '1',
      CORE_AGENT_AUTH_DIR: this.authRoot,
      ORKAS_API_BASE_URL: this.apiBaseUrl,
      ORKAS_ACCOUNT_API_BASE: this.apiBaseUrl,
      ORKAS_E2E_MARKETPLACE_API_BASE: this.marketplaceStub ? this.apiBaseUrl : '',
      ORKAS_METACOGNITION: this.metacognitionEnabled ? '1' : '0',
      ORKAS_NO_AUTO_PROXY: '1',
      ORKAS_PROFILE: 'global',
      NO_PROXY: 'localhost,127.0.0.1,::1',
      no_proxy: 'localhost,127.0.0.1,::1',
      TZ: 'UTC',
    };
    // Automation shells can use Electron as their Node runtime and leak this
    // switch into child processes. Playwright must launch Electron in app mode.
    delete environment.ELECTRON_RUN_AS_NODE;
    if (this.cliStub) {
      environment.ORKAS_E2E_CLI_STATE = this.cliStatePath;
      environment.ORKAS_OPENCODE_PATH = this.fakeOpenCodePath || '';
      environment.ORKAS_HERMES_PATH = this.fakeHermesPath || '';
      environment.ORKAS_CODEX_PATH = this.fakeCodexPath || '';
      environment.ORKAS_CLAUDE_PATH = this.fakeClaudePath || '';
      environment.ORKAS_TEST_NODE = TEST_NODE;
    }
    for (const proxyName of [
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'http_proxy',
      'https_proxy',
      'all_proxy',
    ]) {
      delete environment[proxyName];
    }
    // Source E2E must exercise Electron's own dev-channel resolution. A parent
    // release shell may carry either override and would otherwise make the
    // observed request metadata depend on the developer's terminal.
    delete environment.ORKAS_CLIENT_CHANNEL;
    delete environment.ORKAS_CHANNEL;

    const app = await electron.launch({
      args: ['.'],
      cwd: PC_ROOT,
      env: environment,
      timeout: 30_000,
    });
    this.electronApp = app;

    app.process().stdout?.on('data', (data) => {
      this.diagnostics.push(`[main:stdout] ${String(data).trimEnd()}`);
    });
    app.process().stderr?.on('data', (data) => {
      this.diagnostics.push(`[main:stderr] ${String(data).trimEnd()}`);
    });

    await app.context().tracing.start({
      screenshots: true,
      snapshots: true,
      sources: true,
    });

    const page = await app.firstWindow();
    this.page = page;
    page.on('console', (message) => {
      this.diagnostics.push(`[renderer:${message.type()}] ${message.text()}`);
    });
    page.on('pageerror', (error) => {
      const detail = error.stack || error.message;
      this.rendererPageErrors.push(detail);
      this.diagnostics.push(`[renderer:pageerror] ${detail}`);
    });
    if (this.setDefaultViewport) {
      await page.setViewportSize({ width: 1280, height: 800 });
    }
    await page.waitForLoadState('domcontentloaded');

    if (this.authenticated) {
      // The app restores its last active view. Use persistent shell chrome as
      // the readiness signal instead of assuming every relaunch lands on the
      // new-chat composer.
      await expect(page.locator('#sidebar-search-btn')).toBeVisible({ timeout: 20_000 });
      await expect(page.locator('#account-login-overlay')).toHaveCount(0);
      await expect(page.locator('html')).toHaveAttribute(
        'data-orkas-boot-ready',
        'true',
        { timeout: 20_000 },
      );
      this.lastLaunchReadyMs = Date.now() - launchStartedAt;
      // The open build has no managed models. Seed one deterministic custom
      // entry per local test account so every model-backed scenario exercises
      // the same BYO path that open-build users configure in Settings.
      if (this.configuredModel && !this.configuredModelSeededUsers.has(this.activeUserId)) {
        this.configuredModelSeededUsers.add(this.activeUserId);
        await this.invoke('auth.addCustomModelEntry', {
          label: 'E2E Local Model',
          baseUrl: `${this.apiBaseUrl}/v1`,
          model: 'e2e-chat-model',
          apiKey: 'sk-e2e-local-model-xxxxxxxx',
          contextWindow: 64_000,
          maxTokens: 8_192,
        });
        await page.evaluate(async () => {
          if (typeof (window as any).refreshModelGuard === 'function') {
            await (window as any).refreshModelGuard();
          }
        });
        await expect(page.locator('#model-guard-banner')).toBeHidden();
      }
      // Builtin Marketplace installation is intentionally deferred from the
      // renderer-ready signal. Open-build E2E cases exercise shipped agents
      // immediately, so wait for one stable builtin sentinel instead of
      // racing the background seed and misclassifying the agent as unknown.
      await expect.poll(async () => {
        const result = await this.invoke<{
          agents: Array<{ agent_id: string }>;
        }>('agents.list');
        return result.agents.some((agent) => agent.agent_id === '173d4235a431');
      }, { timeout: 20_000 }).toBe(true);
    } else {
      await expect(page.locator('#account-login-overlay')).toBeVisible({ timeout: 20_000 });
      this.lastLaunchReadyMs = Date.now() - launchStartedAt;
    }
  }

  async relaunch(): Promise<Page> {
    await this.closeCurrentApp();
    await this.launch();
    if (!this.page) throw new Error('Orkas renderer did not open after relaunch');
    return this.page;
  }

  async switchAccount(
    userId: string,
    profile: { nickname: string; email: string },
  ): Promise<Page> {
    if (!/^[A-Za-z0-9_-]+$/.test(userId)) throw new Error(`Invalid E2E account id: ${userId}`);
    await this.closeCurrentApp();
    seedUserWorkspace(this.workspaceRoot, userId, true, profile);

    const registryPath = path.join(this.workspaceRoot, 'users.json');
    const registry = JSON.parse(readFileSync(registryPath, 'utf8')) as {
      current_user_id: string;
      dev_current_user_id: string;
      users: Array<{ user_id: string; created_at: string }>;
    };
    registry.current_user_id = userId;
    registry.dev_current_user_id = userId;
    if (!registry.users.some((item) => item.user_id === userId)) {
      registry.users.push({ user_id: userId, created_at: '2026-01-01T00:00:00.000Z' });
    }
    writeJson(registryPath, registry);
    this.activeUserId = userId;
    await this.launch();
    if (!this.page) throw new Error('Orkas renderer did not open after switching accounts');
    return this.page;
  }

  async activateUserInProcessForTest(
    userId: string,
    profile: { nickname: string; email: string },
  ): Promise<void> {
    if (!this.electronApp) throw new Error('Orkas Electron app is unavailable');
    if (!/^[A-Za-z0-9_-]+$/.test(userId)) throw new Error(`Invalid E2E account id: ${userId}`);
    seedUserWorkspace(this.workspaceRoot, userId, true, profile);
    const usersModulePath = path.join(PC_ROOT, 'src', 'main', 'features', 'users.ts');
    await this.electronApp.evaluate(async (_electron, input) => {
      const mainModule = (process as NodeJS.Process & {
        mainModule?: { require: (id: string) => unknown };
      }).mainModule;
      if (!mainModule || typeof mainModule.require !== 'function') {
        throw new Error('Electron main module require is unavailable');
      }
      const users = mainModule.require(input.usersModulePath) as {
        activateUser: (uid: string) => void;
        getActiveUserId: () => string;
      };
      users.activateUser(input.userId);
      if (users.getActiveUserId() !== input.userId) {
        throw new Error('in-process E2E account activation did not stick');
      }
    }, { usersModulePath, userId });
    this.activeUserId = userId;
  }

  createFixtureFile(name: string, content: string | Buffer): string {
    if (!name || path.basename(name) !== name) {
      throw new Error(`Fixture file name must be a basename: ${name}`);
    }
    const filePath = path.join(this.root, 'fixtures', name);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
    return filePath;
  }

  createWorkspaceFile(relativePath: string, content: string | Buffer): string {
    const resolved = path.resolve(this.userWorkspaceRoot, relativePath);
    const rootWithSeparator = `${path.resolve(this.userWorkspaceRoot)}${path.sep}`;
    if (!resolved.startsWith(rootWithSeparator)) {
      throw new Error(`Workspace fixture must stay under the user workspace: ${relativePath}`);
    }
    mkdirSync(path.dirname(resolved), { recursive: true });
    writeFileSync(resolved, content);
    return resolved;
  }

  readCliState(): CliStubState {
    if (!this.cliStub) throw new Error('The deterministic CLI stubs are not enabled for this fixture');
    return JSON.parse(readFileSync(this.cliStatePath, 'utf8')) as CliStubState;
  }

  async invoke<T = unknown>(channel: string, payload: Record<string, unknown> = {}): Promise<T> {
    if (!this.page) throw new Error('Orkas renderer is unavailable');
    return this.page.evaluate(
      async ({ ipcChannel, ipcPayload }) => (window as any).orkas.invoke(ipcChannel, ipcPayload),
      { ipcChannel: channel, ipcPayload: payload },
    ) as Promise<T>;
  }

  async setSystemIdleStateForTest(state: SystemIdleState): Promise<void> {
    if (!this.electronApp) throw new Error('Orkas Electron app is unavailable');
    await this.electronApp.evaluate(({ powerMonitor }, idleState) => {
      (powerMonitor as any).getSystemIdleState = () => idleState;
    }, state);
    const observed = await this.electronApp.evaluate(
      ({ powerMonitor }) => powerMonitor.getSystemIdleState(1),
    );
    if (observed !== state) {
      throw new Error(`Failed to set E2E system idle state: expected ${state}, observed ${observed}`);
    }
  }

  setModelMode(mode: ModelStubMode): void {
    if (!this.modelStub) throw new Error('The local model stub is not enabled for this fixture');
    this.modelStubMode = mode;
  }

  setClientConfigImmediate(immediate: Record<string, unknown>): string {
    if (!this.updateStub) throw new Error('The local client-config stub is not enabled for this fixture');
    this.clientConfigGeneration += 1;
    this.clientConfigImmediate = {
      'feature.e2e_published': 'generation-a',
      ...immediate,
    };
    return `sha256:e2e-client-config-generation-${this.clientConfigGeneration}`;
  }

  setAccountTier(tier: 'free' | 'lite' | 'pro' | 'max'): void {
    if (!this.accountStub) throw new Error('The local account stub is not enabled for this fixture');
    this.accountSubscription.tier = tier;
  }

  setShareMode(mode: ShareStubMode): void {
    if (!this.modelStub) throw new Error('The local API stub is not enabled for this fixture');
    this.shareStubMode = mode;
  }

  setVoiceMode(mode: VoiceStubMode): void {
    if (!this.voiceStub) throw new Error('The local voice stub is not enabled for this fixture');
    this.voiceStubMode = mode;
  }

  async installVoiceCaptureStub(): Promise<void> {
    if (!this.voiceStub || !this.electronApp || !this.page) {
      throw new Error('The local voice fixture is unavailable');
    }
    await this.electronApp.evaluate(({ systemPreferences }) => {
      const preferences = systemPreferences as any;
      preferences.getMediaAccessStatus = () => 'granted';
      preferences.askForMediaAccess = async () => true;
    });
    await this.page.evaluate(() => {
      const noopNode = () => ({
        connect() {},
        disconnect() {},
        onaudioprocess: null,
      });
      class FakeAudioContext {
        state = 'running';
        sampleRate = 16_000;
        destination = {};
        createMediaStreamSource() { return noopNode(); }
        createScriptProcessor() { return noopNode(); }
        createGain() {
          return {
            ...noopNode(),
            gain: { value: 1 },
          };
        }
        async resume() {}
        async close() {}
      }
      Object.defineProperty(window, 'AudioContext', {
        configurable: true,
        value: FakeAudioContext,
      });
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {
          getUserMedia: async () => ({
            getTracks: () => [{
              stop() {
                (window as any).__e2eVoiceTrackStops =
                  Number((window as any).__e2eVoiceTrackStops || 0) + 1;
              },
            }],
          }),
        },
      });
    });
  }

  setModelTextReplies(replies: string[]): void {
    if (!this.modelStub) throw new Error('The local model stub is not enabled for this fixture');
    if (!replies.length || replies.some((reply) => !reply.trim())) {
      throw new Error('The model reply queue requires at least one non-empty reply');
    }
    this.modelTextReplies = replies.slice();
  }

  setLibraryImageDescriptionReplies(replies: string[]): void {
    if (!this.modelStub) throw new Error('The local model stub is not enabled for this fixture');
    if (!replies.length || replies.some((reply) => !reply.trim())) {
      throw new Error('The Library image-description reply queue requires at least one non-empty reply');
    }
    this.libraryImageDescriptionReplies = replies.slice();
  }

  setConnectorToolScenario(connectorId: string): void {
    if (!this.modelStub) throw new Error('The local model stub is not enabled for this fixture');
    this.modelToolScenarioRequestStart = this.modelRequests.length;
    this.modelToolScenario = { kind: 'connector', connectorId };
  }

  clearModelToolScenario(): void {
    if (!this.modelStub) throw new Error('The local model stub is not enabled for this fixture');
    this.modelToolScenarioRequestStart = this.modelRequests.length;
    this.modelToolScenario = null;
  }

  setBashDenyScenario(command: string): void {
    if (!this.modelStub) throw new Error('The local model stub is not enabled for this fixture');
    this.modelToolScenarioRequestStart = this.modelRequests.length;
    this.modelToolScenario = {
      kind: 'bash-sequence',
      commands: [command],
      finalText: 'E2E dangerous command remained denied.',
    };
  }

  setBashSequenceScenario(commands: string[], finalText: string): void {
    if (!this.modelStub) throw new Error('The local model stub is not enabled for this fixture');
    if (!commands.length || commands.some((command) => !command.trim())) {
      throw new Error('The bash sequence requires at least one non-empty command');
    }
    this.modelToolScenarioRequestStart = this.modelRequests.length;
    this.modelToolScenario = {
      kind: 'bash-sequence',
      commands: commands.slice(),
      finalText,
    };
  }

  setProducedFileCleanupScenario(
    filePath: string,
    content: string,
    deleteCommand: string,
    finalText: string,
    bashArgumentDelayMs = 3_000,
  ): void {
    if (!this.modelStub) throw new Error('The local model stub is not enabled for this fixture');
    if (
      !path.isAbsolute(filePath)
      || !content
      || !deleteCommand.trim()
      || !finalText.trim()
      || !Number.isFinite(bashArgumentDelayMs)
      || bashArgumentDelayMs <= 0
    ) {
      throw new Error('The produced-file cleanup scenario requires an absolute path, content, delete command, final response, and positive bash delay');
    }
    this.modelToolScenarioRequestStart = this.modelRequests.length;
    this.modelToolScenario = {
      kind: 'produced-file-cleanup',
      filePath,
      content,
      deleteCommand,
      finalText,
      bashArgumentDelayMs: Math.round(bashArgumentDelayMs),
    };
  }

  setInteractiveCliScenario(command: string, purpose: string): void {
    if (!this.modelStub) throw new Error('The local model stub is not enabled for this fixture');
    if (!command.trim() || !purpose.trim()) {
      throw new Error('The interactive CLI scenario requires a command and purpose');
    }
    this.modelToolScenarioRequestStart = this.modelRequests.length;
    this.modelToolScenario = {
      kind: 'interactive-cli',
      command,
      purpose,
    };
  }

  setWriteFileScenario(filePath: string, content: string, finalText: string): void {
    if (!this.modelStub) throw new Error('The local model stub is not enabled for this fixture');
    if (!path.isAbsolute(filePath) || !content || !finalText.trim()) {
      throw new Error('The write-file scenario requires an absolute path, content, and final response');
    }
    this.modelToolScenarioRequestStart = this.modelRequests.length;
    this.modelToolScenario = {
      kind: 'write-file',
      filePath,
      content,
      finalText,
    };
  }

  setDelayedWriteFileScenario(
    filePath: string,
    content: string,
    finalText: string,
    toolArgumentDelayMs: number,
  ): void {
    if (!this.modelStub) throw new Error('The local model stub is not enabled for this fixture');
    if (
      !path.isAbsolute(filePath)
      || !content
      || !finalText.trim()
      || !Number.isFinite(toolArgumentDelayMs)
      || toolArgumentDelayMs <= 0
    ) {
      throw new Error('The delayed write-file scenario requires an absolute path, content, final response, and positive delay');
    }
    this.modelToolScenarioRequestStart = this.modelRequests.length;
    this.modelToolScenario = {
      kind: 'write-file',
      filePath,
      content,
      finalText,
      toolArgumentDelayMs: Math.round(toolArgumentDelayMs),
    };
  }

  setGenerateSpeechScenario(text: string, outputPath: string, finalText: string): void {
    if (!this.modelStub) throw new Error('The local model stub is not enabled for this fixture');
    if (!text.trim() || !path.isAbsolute(outputPath) || !finalText.trim()) {
      throw new Error('The speech scenario requires text, an absolute output path, and a final reply');
    }
    this.modelToolScenarioRequestStart = this.modelRequests.length;
    this.modelToolScenario = {
      kind: 'generate-speech',
      text,
      outputPath,
      finalText,
    };
  }

  setGenerateImageScenario(prompt: string, outputPath: string, finalText: string): void {
    if (!this.modelStub) throw new Error('The local model stub is not enabled for this fixture');
    if (!prompt.trim() || !path.isAbsolute(outputPath) || !finalText.trim()) {
      throw new Error('The image scenario requires a prompt, an absolute output path, and a final reply');
    }
    this.modelToolScenarioRequestStart = this.modelRequests.length;
    this.modelToolScenario = {
      kind: 'generate-image',
      prompt,
      outputPath,
      finalText,
    };
  }

  setGenerateVideoScenario(
    prompt: string,
    outputPath: string,
    finalText: string,
    referenceImagePath?: string,
  ): void {
    if (!this.modelStub) throw new Error('The local model stub is not enabled for this fixture');
    if (
      !prompt.trim()
      || !path.isAbsolute(outputPath)
      || !finalText.trim()
      || (referenceImagePath !== undefined && !path.isAbsolute(referenceImagePath))
    ) {
      throw new Error('The video scenario requires a prompt, absolute media paths, and a final reply');
    }
    this.modelToolScenarioRequestStart = this.modelRequests.length;
    this.modelToolScenario = {
      kind: 'generate-video',
      prompt,
      outputPath,
      finalText,
      ...(referenceImagePath ? { referenceImagePath } : {}),
    };
  }

  setAgentHandoffScenario(
    agentId: string,
    task: string,
    finalText: string,
    options: {
      commanderNarration?: string;
      holdAgentReply?: boolean;
    } = {},
  ): void {
    if (!this.modelStub) throw new Error('The local model stub is not enabled for this fixture');
    if (!agentId.trim() || !task.trim() || !finalText.trim()) {
      throw new Error('The agent hand-off scenario requires an agent id, task, and final reply');
    }
    this.pendingAgentHandoffReply = null;
    this.modelToolScenarioRequestStart = this.modelRequests.length;
    this.modelToolScenario = {
      kind: 'agent-handoff',
      agentId,
      task,
      finalText,
      ...(options.commanderNarration?.trim()
        ? { commanderNarration: options.commanderNarration.trim() }
        : {}),
      ...(options.holdAgentReply ? { holdAgentReply: true } : {}),
    };
  }

  releaseAgentHandoffReply(): void {
    const release = this.pendingAgentHandoffReply;
    if (!release) throw new Error('No held agent hand-off reply is pending');
    this.pendingAgentHandoffReply = null;
    release();
  }

  hasPendingAgentHandoffReply(): boolean {
    return this.pendingAgentHandoffReply !== null;
  }

  setInteractiveAgentResumeScenario(input: {
    agentId: string;
    task: string;
    resume: string;
    formText: string;
    handbackText: string;
    commanderFinalText: string;
  }): void {
    if (!this.modelStub) throw new Error('The local model stub is not enabled for this fixture');
    if (Object.values(input).some((value) => !value.trim())) {
      throw new Error('The interactive agent scenario requires non-empty routing and reply values');
    }
    this.modelToolScenarioRequestStart = this.modelRequests.length;
    this.modelToolScenario = {
      kind: 'interactive-agent-resume',
      ...input,
    };
  }

  setAgentHandoffRetryScenario(agentId: string, task: string, recoveryText: string): void {
    if (!this.modelStub) throw new Error('The local model stub is not enabled for this fixture');
    if (!agentId.trim() || !task.trim() || !recoveryText.trim()) {
      throw new Error('The retry scenario requires an agent id, task, and recovery reply');
    }
    this.modelToolScenarioRequestStart = this.modelRequests.length;
    this.modelToolScenario = {
      kind: 'agent-handoff-retry',
      agentId,
      task,
      recoveryText,
      recoveryEnabled: false,
    };
  }

  allowAgentHandoffRetryRecovery(): void {
    if (this.modelToolScenario?.kind !== 'agent-handoff-retry') {
      throw new Error('No agent retry scenario is active');
    }
    this.modelToolScenario.recoveryEnabled = true;
  }

  setAgentFanoutScenario(targets: AgentFanoutTarget[], commanderFinalText: string): void {
    if (!this.modelStub) throw new Error('The local model stub is not enabled for this fixture');
    const uniqueAgentIds = new Set(targets.map((target) => target.agentId));
    if (
      targets.length < 2
      || uniqueAgentIds.size !== targets.length
      || targets.some((target) => Object.values(target).some((value) => !value.trim()))
      || !commanderFinalText.trim()
    ) {
      throw new Error('The fan-out scenario requires two or more unique, complete agent targets');
    }
    this.modelToolScenarioRequestStart = this.modelRequests.length;
    this.modelToolScenario = {
      kind: 'agent-fanout',
      targets: targets.map((target) => ({ ...target })),
      commanderFinalText,
    };
  }

  /** Commander narrates BEFORE dispatching a visible agent, in one turn. The
   * bus flushes that narration as its own `seg` bubble so the agent's reply
   * lands under it, then the post-handback synthesis becomes the next segment.
   * This is the shape that produced duplicate Commander bubbles: the narration
   * streams into a live row and is persisted moments later, so the renderer has
   * to recognise both as the same row. */
  setCommanderSegmentScenario(input: {
    narration: string;
    agentId: string;
    task: string;
    agentFinalText: string;
    synthesis: string;
  }): void {
    if (!this.modelStub) throw new Error('The local model stub is not enabled for this fixture');
    if (Object.values(input).some((value) => !value.trim())) {
      throw new Error('The commander-segment scenario requires narration, target, task, reply, and synthesis');
    }
    this.modelToolScenarioRequestStart = this.modelRequests.length;
    this.modelToolScenario = { kind: 'commander-segments', ...input };
  }

  setProjectHistoryScenario(query: string, sourceCid: string, finalText: string): void {
    if (!this.modelStub) throw new Error('The local model stub is not enabled for this fixture');
    if (!query.trim() || !sourceCid.trim() || !finalText.trim()) {
      throw new Error('The project-history scenario requires a query, source cid, and final reply');
    }
    this.modelToolScenarioRequestStart = this.modelRequests.length;
    this.modelToolScenario = {
      kind: 'project-history',
      query,
      sourceCid,
      finalText,
    };
  }

  setProjectInstructionsScenario(
    instructions: string,
    finalText: string,
    options: { toolDelayMs?: number } = {},
  ): void {
    if (!this.modelStub) throw new Error('The local model stub is not enabled for this fixture');
    const toolDelayMs = options.toolDelayMs ?? 0;
    if (!instructions.trim() || !finalText.trim() || toolDelayMs < 0) {
      throw new Error('The project-instructions scenario requires full replacement text and a final reply');
    }
    this.modelToolScenarioRequestStart = this.modelRequests.length;
    this.modelToolScenario = {
      kind: 'project-instructions',
      instructions,
      finalText,
      toolDelayMs,
    };
  }

  setKnowledgeBaseScenario(
    query: string,
    filePath: string,
    expectedFact: string,
    finalText: string,
  ): void {
    if (!this.modelStub) throw new Error('The local model stub is not enabled for this fixture');
    if ([query, filePath, expectedFact, finalText].some((value) => !value.trim())) {
      throw new Error('The knowledge-base scenario requires a query, file path, fact, and final reply');
    }
    this.modelToolScenarioRequestStart = this.modelRequests.length;
    this.modelToolScenario = {
      kind: 'knowledge-base',
      query,
      filePath,
      expectedFact,
      finalText,
    };
  }

  setContextCompactionScenario(
    sources: Array<{ path: string; fact: string }>,
    finalText: string,
    options: { stallCompaction?: boolean } = {},
  ): void {
    if (!this.modelStub) throw new Error('The local model stub is not enabled for this fixture');
    if (
      sources.length < 3
      || sources.some((source) => !source.path.trim() || !source.fact.trim())
      || new Set(sources.map((source) => source.path)).size !== sources.length
      || !finalText.trim()
    ) {
      throw new Error('The context-compaction scenario requires at least three unique sources, exact facts, and a final reply');
    }
    this.compactionRequestAborts = 0;
    this.modelToolScenarioRequestStart = this.modelRequests.length;
    this.modelToolScenario = {
      kind: 'context-compaction',
      sources: sources.map((source) => ({ ...source })),
      nextSourceIndex: 0,
      finalText,
      stallCompaction: options.stallCompaction === true,
    };
  }

  async selectFilesOnNextDialog(filePaths: string[]): Promise<void> {
    if (!this.electronApp) throw new Error('Orkas Electron app is unavailable');
    const selected = filePaths.map((filePath) => path.resolve(filePath));
    await this.electronApp.evaluate(({ dialog }, pathsForDialog) => {
      const mutableDialog = dialog as any;
      const original = mutableDialog.showOpenDialog.bind(dialog);
      mutableDialog.showOpenDialog = async () => {
        mutableDialog.showOpenDialog = original;
        return { canceled: false, filePaths: pathsForDialog };
      };
    }, selected);
  }

  async cancelNextFileDialog(): Promise<void> {
    if (!this.electronApp) throw new Error('Orkas Electron app is unavailable');
    await this.electronApp.evaluate(({ dialog }) => {
      const mutableDialog = dialog as any;
      const original = mutableDialog.showOpenDialog.bind(dialog);
      mutableDialog.showOpenDialog = async () => {
        mutableDialog.showOpenDialog = original;
        return { canceled: true, filePaths: [] };
      };
    });
  }

  async dispose(): Promise<void> {
    const rendererFailed = this.rendererPageErrors.length > 0;
    const failed = this.testInfo.status !== this.testInfo.expectedStatus || rendererFailed;
    if (failed && this.page && !this.page.isClosed()) {
      const screenshotPath = this.testInfo.outputPath('failure.png');
      await this.page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
      await this.testInfo.attach('failure-screenshot', {
        path: screenshotPath,
        contentType: 'image/png',
      }).catch(() => undefined);
    }

    await this.closeCurrentApp();
    await this.closeStubServer();

    if (failed) {
      for (const [index, tracePath] of this.tracePaths.entries()) {
        await this.testInfo.attach(`trace-${index + 1}`, {
          path: tracePath,
          contentType: 'application/zip',
        }).catch(() => undefined);
      }
      if (this.cliStub) {
        await this.testInfo.attach('cli-stub-state', {
          path: this.cliStatePath,
          contentType: 'application/json',
        }).catch(() => undefined);
      }
      const appLogs = collectLogFiles(this.root);
      const diagnosticText = [this.diagnostics.join('\n'), appLogs].filter(Boolean).join('\n');
      if (diagnosticText) {
        // Written to the failure's output directory, not only attached: line/list
        // reporters truncate an inline attachment to a couple of lines, which is
        // exactly the main-process history a failed run needs. `attach({ path })`
        // keeps the full file in the artifacts tree.
        const logPath = path.join(this.testInfo.outputDir, 'electron-main.log');
        try {
          mkdirSync(this.testInfo.outputDir, { recursive: true });
          writeFileSync(logPath, diagnosticText, 'utf8');
          await this.testInfo.attach('electron-logs', {
            path: logPath,
            contentType: 'text/plain',
          }).catch(() => undefined);
        } catch {
          await this.testInfo.attach('electron-logs', {
            body: Buffer.from(diagnosticText),
            contentType: 'text/plain',
          }).catch(() => undefined);
        }
      }
    } else {
      for (const tracePath of this.tracePaths) {
        try {
          unlinkSync(tracePath);
        } catch {
          // Reporter cleanup may already have removed a successful trace.
        }
      }
    }

    rmSync(this.root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });

    if (rendererFailed && this.testInfo.status === this.testInfo.expectedStatus) {
      throw new Error(
        `Renderer page error detected (${this.rendererPageErrors.length}); see attached Electron diagnostics`,
      );
    }
  }

  private async closeCurrentApp(): Promise<void> {
    const app = this.electronApp;
    if (!app) return;

    const tracePath = this.testInfo.outputPath(`trace-${++this.traceNumber}.zip`);
    await app.context().tracing.stop({ path: tracePath }).catch(() => undefined);
    this.tracePaths.push(tracePath);
    await app.close().catch(() => undefined);
    this.electronApp = null;
    this.page = null;
  }

  private async ensureStubServer(): Promise<void> {
    if (this.apiServer) return;
    const marketplaceSkillZip = new AdmZip();
    marketplaceSkillZip.addFile('SKILL.md', Buffer.from([
      '---',
      'name: marketplace-e2e-skill',
      'description: Deterministic Marketplace lifecycle skill for end-to-end coverage.',
      '---',
      '',
      '# Marketplace E2E Skill',
      '',
      'Use this fixture skill to verify install and uninstall behavior.',
      '',
    ].join('\n'), 'utf8'));
    const marketplaceSkillBundle = marketplaceSkillZip.toBuffer();
    const marketplaceUnsafeSkillZip = new AdmZip();
    marketplaceUnsafeSkillZip.addFile('SKILL.md', Buffer.from([
      '---',
      'name: marketplace-e2e-unsafe-skill',
      'description: Deterministic unsafe fixture for the quality rejection recovery flow.',
      'category: general',
      '---',
      '',
      '# Marketplace Unsafe E2E Skill',
      '',
      'This package is intentionally rejected until the user explicitly overrides the report.',
      '',
    ].join('\n'), 'utf8'));
    marketplaceUnsafeSkillZip.addFile('scripts/self-modify.sh', Buffer.from(
      'echo "name: replaced" > SKILL.md\n',
      'utf8',
    ));
    const marketplaceUnsafeSkillBundle = marketplaceUnsafeSkillZip.toBuffer();
    const server = createServer((request, response) => {
      const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
      this.apiRequests.push({
        method: request.method || '',
        path: requestUrl.pathname,
        channel: String(request.headers['orkas-channel'] || ''),
      });
      const isChat = requestUrl.pathname === '/api/v1/chat/completions';
      const isClientConfig = requestUrl.pathname === '/api/config/client';
      const isShareCreate = requestUrl.pathname === '/api/share/create';
      const isAccountMe = requestUrl.pathname === '/api/account/me';
      const isCreditTransactions = requestUrl.pathname === '/api/account/credits/transactions';
      const isImageCreate = requestUrl.pathname === '/api/e2e-image/generations';
      const isImageTask = requestUrl.pathname === '/api/e2e-image/generations/e2e-image-task';
      const isImageOutput = requestUrl.pathname === '/generated/e2e-managed-image.png';
      const isGenerationReferenceAuth = requestUrl.pathname === '/api/file/auth';
      const isGenerationReferenceUpload = requestUrl.pathname === '/cos-upload/e2e-reference';
      const isGenerationReferenceComplete = requestUrl.pathname === '/api/file/upload/complete';
      const isVideoEstimate = requestUrl.pathname === '/api/e2e-video/estimate';
      const isVideoCreate = requestUrl.pathname === '/api/e2e-video/generations';
      const isVideoTask = requestUrl.pathname === '/api/e2e-video/generations/e2e-video-task';
      const isVideoOutput = requestUrl.pathname === '/generated/e2e-managed-video.mp4';
      const isModelStubRoute = this.modelStub
        && (
          isChat
          || isShareCreate
          || isImageCreate
          || isGenerationReferenceAuth
          || isGenerationReferenceUpload
          || isGenerationReferenceComplete
          || isVideoEstimate
          || isVideoCreate
        );
      const marketplacePath = requestUrl.pathname.startsWith('/api/marketplace/')
        ? requestUrl.pathname.slice('/api'.length)
        : '';
      if (request.method === 'GET' && isClientConfig) {
        const configHash = this.clientConfigGeneration === 0
          ? 'sha256:e2e-client-config-generation'
          : `sha256:e2e-client-config-generation-${this.clientConfigGeneration}`;
        const etag = `"${configHash}"`;
        const ifNoneMatch = String(request.headers['if-none-match'] || '');
        if (ifNoneMatch.split(',').map((item) => item.trim()).includes(etag)) {
          response.writeHead(304, { ETag: etag });
          response.end();
          return;
        }
        response.writeHead(200, {
          'Content-Type': 'application/json',
          ETag: etag,
          'Cache-Control': 'no-cache',
        });
        response.end(JSON.stringify({
          code: 0,
          schema: 1,
          immediate: this.clientConfigImmediate,
          restart: {},
          config_hash: configHash,
        }));
        return;
      }
      if (request.method === 'GET' && requestUrl.pathname === '/marketplace-e2e-skill.zip' && this.marketplaceStub) {
        response.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Length': String(marketplaceSkillBundle.length),
        });
        response.end(marketplaceSkillBundle);
        return;
      }
      if (
        request.method === 'GET'
        && requestUrl.pathname === '/marketplace-e2e-unsafe-skill.zip'
        && this.marketplaceStub
      ) {
        response.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Length': String(marketplaceUnsafeSkillBundle.length),
        });
        response.end(marketplaceUnsafeSkillBundle);
        return;
      }
      if (request.method === 'GET' && isAccountMe && this.accountStub) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          code: 0,
          user_info: {
            id: this.activeUserId,
            nickname: 'E2E Member',
            email: 'member@example.invalid',
          },
          subscription: this.accountSubscription,
        }));
        return;
      }
      if (request.method === 'GET' && isCreditTransactions && this.accountStub) {
        const direction = requestUrl.searchParams.get('direction') === 'earn' ? 'earn' : 'consume';
        this.creditTransactionRequests.push(requestUrl.search);
        const records = direction === 'earn'
          ? [{
              id: 2,
              direction: 'earn',
              scene: 'initial_gift',
              amount_milli: 10_000,
              created_at: 1_767_225_600,
            }]
          : [{
              id: 1,
              direction: 'consume',
              scene: 'llm',
              amount_milli: 1_500,
              created_at: 1_767_225_600,
              quantity: 1,
            }];
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          code: 0,
          direction,
          records,
          next_cursor: '',
          retention_days: direction === 'consume' ? 30 : null,
          summary: direction === 'consume' ? {
            window_days: 30,
            used_milli: 250_000,
            total_milli: 1_000_000,
            remaining_milli: 750_000,
            lifetime_milli: 125_000,
            top: records[0],
          } : null,
        }));
        return;
      }
      if (request.method === 'GET' && isImageTask && this.modelStub) {
        this.imageTaskPolls += 1;
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          code: 0,
          task_id: 'e2e-image-task',
          status: 'succeeded',
          url: `${this.apiBaseUrl.replace(/\/api$/, '')}/generated/e2e-managed-image.png`,
        }));
        return;
      }
      if (request.method === 'GET' && isImageOutput && this.modelStub) {
        const image = Buffer.from(E2E_PNG_B64, 'base64');
        response.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': String(image.length),
        });
        response.end(image);
        return;
      }
      if (request.method === 'GET' && isVideoTask && this.modelStub) {
        this.videoTaskPolls += 1;
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          code: 0,
          task_id: 'e2e-video-task',
          status: 'succeeded',
          model: 'doubao-seedance-2-0-fast-260128',
          ratio: '16:9',
          duration: 5,
          resolution: '720p',
          video_url: `${this.apiBaseUrl.replace(/\/api$/, '')}/generated/e2e-managed-video.mp4`,
        }));
        return;
      }
      if (request.method === 'GET' && isVideoOutput && this.modelStub) {
        response.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Content-Length': String(E2E_MP4_BYTES.length),
        });
        response.end(E2E_MP4_BYTES);
        return;
      }
      const validGenerationUpload = this.modelStub
        && request.method === 'PUT'
        && isGenerationReferenceUpload;
      if (!validGenerationUpload && (
        request.method !== 'POST'
        || (!isModelStubRoute && !(this.marketplaceStub && marketplacePath))
      )) {
        response.writeHead(404, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ ok: false, error: 'e2e_stub_route_not_found' }));
        return;
      }

      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        if (isGenerationReferenceAuth) {
          const authRequest = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            content_length: number;
            content_type: string;
            content_md5: string;
          };
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({
            code: 0,
            auth: {
              method: 'PUT',
              upload_url: `${this.apiBaseUrl.replace(/\/api$/, '')}/cos-upload/e2e-reference?q-signature=opaque`,
              file_url: 'https://cos.example/temp/e2e/image/reference.png',
              content_length: authRequest.content_length,
              headers: {
                'Content-Type': authRequest.content_type,
                'Content-Length': String(authRequest.content_length),
                'Content-MD5': authRequest.content_md5,
                'Content-Disposition': 'attachment; filename="reference.png"',
                'x-cos-acl': 'private',
                'x-cos-server-side-encryption': 'AES256',
              },
            },
          }));
          return;
        }
        if (isGenerationReferenceUpload) {
          const body = Buffer.concat(chunks);
          this.generationReferenceUploads.push({
            bytes: body.length,
            contentType: String(request.headers['content-type'] || ''),
            contentMd5: String(request.headers['content-md5'] || ''),
            acl: String(request.headers['x-cos-acl'] || ''),
            encryption: String(request.headers['x-cos-server-side-encryption'] || ''),
            body: body.toString('latin1'),
          });
          response.writeHead(200);
          response.end();
          return;
        }
        if (isGenerationReferenceComplete) {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({
            code: 0,
            signed_url: 'https://cdn.example/e2e-uploaded-reference.png',
          }));
          return;
        }
        let requestBody: Record<string, unknown>;
        try {
          requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        } catch {
          requestBody = { malformed: true };
        }
        if (this.marketplaceStub && marketplacePath) {
          this.marketplaceRequests.push({ path: marketplacePath, body: requestBody });
          const requestedSkillId = String(requestBody.id || '');
          const isUnsafeSkill = requestedSkillId === 'marketplace-e2e-unsafe-skill';
          const bundleUrl = `${this.apiBaseUrl.replace(/\/api$/, '')}/${isUnsafeSkill
            ? 'marketplace-e2e-unsafe-skill.zip'
            : 'marketplace-e2e-skill.zip'}`;
          const skill = {
            id: 'marketplace-e2e-skill',
            name: 'Marketplace E2E Skill',
            description_zh: '用于端到端验证市场安装生命周期。',
            description_en: 'Verifies the Marketplace install lifecycle end to end.',
            category: 'general',
            version: '1.0.0',
            create_uid: '0',
            download_count: 7,
            published_at: 1_767_225_600_000,
            updated_at: 1_767_225_600_000,
            status: 'approved',
          };
          const unsafeSkill = {
            ...skill,
            id: 'marketplace-e2e-unsafe-skill',
            name: 'Unsafe Marketplace E2E Skill',
            description_zh: '用于端到端验证质量拒绝与显式恢复。',
            description_en: 'Verifies quality rejection and explicit recovery end to end.',
          };
          let payload: Record<string, unknown>;
          if (marketplacePath === '/marketplace/agents/list') {
            payload = { code: 0, list: [], total: 0 };
          } else if (marketplacePath === '/marketplace/skills/list') {
            payload = { code: 0, list: [skill, unsafeSkill], total: 2 };
          } else if (marketplacePath === '/marketplace/skills/bundle') {
            payload = {
              code: 0,
              ...(isUnsafeSkill ? unsafeSkill : skill),
              bundle_url: bundleUrl,
              default_install: false,
              is_open_source: true,
            };
          } else if (marketplacePath === '/marketplace/categories') {
            payload = {
              code: 0,
              list: [{
                code: 'general',
                name_zh: '通用',
                name_en: 'General',
                name_ja: '汎用',
                name_pt: 'Geral',
                sort_order: 10,
              }],
            };
          } else if (marketplacePath === '/marketplace/defaults') {
            payload = { code: 0, agents: [], skills: [] };
          } else {
            payload = { code: 404, msg: 'e2e_marketplace_route_not_found' };
          }
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify(payload));
          return;
        }
        if (isImageCreate) {
          this.imageGenerationRequests.push(requestBody);
          response.writeHead(202, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({
            code: 0,
            task_id: 'e2e-image-task',
            status: 'processing',
          }));
          return;
        }
        if (isVideoEstimate) {
          this.videoEstimateRequests.push(requestBody);
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({
            code: 0,
            model: 'doubao-seedance-2-0-fast-260128',
            model_tier: 'balanced',
            duration: Number(requestBody.duration || 5),
            resolution: String(requestBody.resolution || '720p'),
            usage: {
              credits_milli_per_second: 80_000,
              credits_milli: 400_000,
            },
          }));
          return;
        }
        if (isVideoCreate) {
          this.videoGenerationRequests.push(requestBody);
          response.writeHead(202, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({
            code: 0,
            task_id: 'e2e-video-task',
            status: 'processing',
          }));
          return;
        }
        if (isShareCreate) {
          this.shareCreateRequests.push(requestBody);
          if (this.shareStubMode === 'failure') {
            response.writeHead(503, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({
              code: 1,
              msg: 'COS secret bucket upload failed at /private/e2e-account',
              reason: 'internal_bucket_name',
            }));
            return;
          }
          const createdAtMs = Date.now();
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({
            code: 0,
            url: `http://localhost:9000/share/${'A'.repeat(43)}`,
            format: requestBody.format,
            created_at_ms: createdAtMs,
            expires_at_ms: createdAtMs + 30 * 24 * 60 * 60 * 1000,
          }));
          return;
        }
        this.modelRequests.push(requestBody);

        const mode = this.modelStubMode;
        const scenario = this.modelToolScenario;
        const requestNumber = this.modelRequests.length - this.modelToolScenarioRequestStart;
        const shouldFailAgentAttempt = scenario?.kind === 'agent-handoff-retry'
          && requestNumber >= 2
          && !scenario.recoveryEnabled;
        if (mode === 'auth-error') {
          response.writeHead(401, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({
            error: {
              type: 'authentication_error',
              code: 'invalid_api_key',
              message: 'The supplied API key sk-e2e-private-secret is invalid. Request id: req_e2e_auth_failure',
            },
          }));
          return;
        }
        if (mode === 'http-error' || shouldFailAgentAttempt) {
          response.writeHead(500, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({
            error: { type: 'server_error', code: 'e2e_model_failure', message: 'deterministic E2E failure' },
          }));
          return;
        }

        const created = Math.floor(Date.now() / 1000);
        const base = {
          id: `chatcmpl-e2e-${this.modelRequests.length}`,
          object: 'chat.completion.chunk',
          created,
          // Deliberately not the configured model id. A compatible endpoint
          // may echo the concrete model it ran, so keep that divergence
          // covered end to end without relying on a managed catalog alias.
          model: 'e2e-endpoint-model',
        };
        const events = [
          { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
          {
            ...base,
            choices: [{
              index: 0,
              delta: {
                content: mode === 'refusal'
                  ? 'I cannot help with that request because it conflicts with the provider safety policy.'
                  : 'Hello from ',
              },
              finish_reason: null,
            }],
          },
          ...(mode === 'refusal'
            ? []
            : [{ ...base, choices: [{ index: 0, delta: { content: 'the local E2E model.' }, finish_reason: null }] }]),
          { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
          {
            ...base,
            choices: [],
            usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
          },
        ];
        response.writeHead(200, {
          'Cache-Control': 'no-cache',
          'Content-Type': 'text/event-stream; charset=utf-8',
          Connection: 'keep-alive',
        });
        const writeEvent = (event: Record<string, unknown>): void => {
          if (!response.destroyed) response.write(`data: ${JSON.stringify(event)}\n\n`);
        };
        const finishImmediately = (streamEvents: Array<Record<string, unknown>>): void => {
          response.end(
            `${streamEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`,
          );
        };
        const toolCallsEvents = (
          calls: Array<{
            callId: string;
            name: string;
            args: Record<string, unknown>;
          }>,
        ): Array<Record<string, unknown>> => [
          {
            ...base,
            choices: [{
              index: 0,
              delta: {
                role: 'assistant',
                content: null,
                tool_calls: calls.map((call, index) => ({
                  index,
                  id: call.callId,
                  type: 'function',
                  function: {
                    name: call.name,
                    arguments: JSON.stringify(call.args),
                  },
                })),
              },
              finish_reason: null,
            }],
          },
          { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
          {
            ...base,
            choices: [],
            usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
          },
        ];
        const toolCallEvents = (
          callId: string,
          name: string,
          args: Record<string, unknown>,
        ): Array<Record<string, unknown>> => toolCallsEvents([{ callId, name, args }]);
        const streamToolCallWithDelayedArguments = (
          callId: string,
          name: string,
          args: Record<string, unknown>,
          delayMs: number,
        ): void => {
          writeEvent({
            ...base,
            choices: [{
              index: 0,
              delta: {
                role: 'assistant',
                content: null,
                tool_calls: [{
                  index: 0,
                  id: callId,
                  type: 'function',
                  function: { name, arguments: '' },
                }],
              },
              finish_reason: null,
            }],
          });
          setTimeout(() => finishImmediately([
            {
              ...base,
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: 0,
                    function: { arguments: JSON.stringify(args) },
                  }],
                },
                finish_reason: null,
              }],
            },
            { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
            {
              ...base,
              choices: [],
              usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
            },
          ]), delayMs);
        };
        const finalTextEvents = (text: string): Array<Record<string, unknown>> => [
          { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] },
          { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
          {
            ...base,
            choices: [],
            usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
          },
        ];

        const requestText = JSON.stringify(requestBody);
        if (requestText.includes('Library image-understanding assistant')) {
          const imageDescription = this.libraryImageDescriptionReplies.shift();
          if (imageDescription !== undefined) {
            finishImmediately(finalTextEvents(imageDescription));
            return;
          }
        }

        if (scenario?.kind === 'connector') {
          if (requestNumber === 1) {
            finishImmediately(toolCallEvents(
              'call-e2e-list-connector',
              'list_connector_tools',
              { connector_id: scenario.connectorId },
            ));
          } else if (requestNumber === 2) {
            finishImmediately(toolCallEvents(
              'call-e2e-run-connector',
              'call_connector_tool',
              {
                connector_id: scenario.connectorId,
                tool_name: 'e2e_echo',
                args: { text: 'roundtrip' },
              },
            ));
          } else {
            finishImmediately(finalTextEvents('E2E connector tool round trip completed.'));
          }
          return;
        }
        if (scenario?.kind === 'bash-sequence') {
          if (requestNumber <= scenario.commands.length) {
            finishImmediately(toolCallEvents(
              `call-e2e-bash-${requestNumber}`,
              'bash',
              { command: scenario.commands[requestNumber - 1] },
            ));
          } else {
            finishImmediately(finalTextEvents(scenario.finalText));
          }
          return;
        }
        if (scenario?.kind === 'produced-file-cleanup') {
          if (requestNumber === 1) {
            finishImmediately(toolCallEvents(
              'call-e2e-produce-cleanup-file',
              'write_file',
              { path: scenario.filePath, content: scenario.content },
            ));
          } else if (requestNumber === 2) {
            streamToolCallWithDelayedArguments(
              'call-e2e-cleanup-produced-file',
              'bash',
              { command: scenario.deleteCommand },
              scenario.bashArgumentDelayMs,
            );
          } else {
            finishImmediately(finalTextEvents(scenario.finalText));
          }
          return;
        }
        if (scenario?.kind === 'interactive-cli') {
          if (requestNumber === 1) {
            finishImmediately(toolCallEvents(
              'call-e2e-interactive-cli',
              'interactive_cli_start',
              {
                command: scenario.command,
                purpose: scenario.purpose,
                max_lifetime_ms: 600_000,
              },
            ));
          } else {
            finishImmediately(finalTextEvents('E2E interactive CLI session finished.'));
          }
          return;
        }
        if (scenario?.kind === 'write-file') {
          if (requestNumber === 1) {
            if (scenario.toolArgumentDelayMs) {
              streamToolCallWithDelayedArguments(
                'call-e2e-write-conflict-file',
                'write_file',
                { path: scenario.filePath, content: scenario.content },
                scenario.toolArgumentDelayMs,
              );
              return;
            }
            finishImmediately(toolCallEvents(
              'call-e2e-write-conflict-file',
              'write_file',
              { path: scenario.filePath, content: scenario.content },
            ));
          } else {
            finishImmediately(finalTextEvents(scenario.finalText));
          }
          return;
        }
        if (scenario?.kind === 'generate-speech') {
          if (requestNumber === 1) {
            finishImmediately(toolCallEvents(
              'call-e2e-generate-speech',
              'generate_speech',
              { text: scenario.text, output_path: scenario.outputPath },
            ));
          } else {
            finishImmediately(finalTextEvents(scenario.finalText));
          }
          return;
        }
        if (scenario?.kind === 'generate-image') {
          if (requestNumber === 1) {
            finishImmediately(toolCallEvents(
              'call-e2e-generate-image',
              'generate_image',
              {
                prompt: scenario.prompt,
                output_path: scenario.outputPath,
                size: '1024x1024',
              },
            ));
          } else {
            finishImmediately(finalTextEvents(scenario.finalText));
          }
          return;
        }
        if (scenario?.kind === 'agent-handoff') {
          if (requestNumber === 1) {
            const events = toolCallEvents(
              'call-e2e-agent-handoff',
              'hand_off_to',
              { to: scenario.agentId, message: scenario.task },
            );
            if (scenario.commanderNarration) {
              events.unshift({
                ...base,
                choices: [{
                  index: 0,
                  delta: { role: 'assistant', content: scenario.commanderNarration },
                  finish_reason: null,
                }],
              });
            }
            finishImmediately(events);
          } else {
            const finishAgentReply = () => finishImmediately(finalTextEvents(scenario.finalText));
            if (scenario.holdAgentReply) this.pendingAgentHandoffReply = finishAgentReply;
            else finishAgentReply();
          }
          return;
        }
        if (scenario?.kind === 'interactive-agent-resume') {
          if (requestNumber === 1) {
            finishImmediately(toolCallEvents(
              'call-e2e-interactive-agent',
              'hand_off_to',
              {
                to: scenario.agentId,
                message: scenario.task,
                resume: scenario.resume,
              },
            ));
          } else if (requestNumber === 2) {
            finishImmediately(finalTextEvents(scenario.formText));
          } else if (requestNumber === 3) {
            finishImmediately(finalTextEvents(scenario.handbackText));
          } else {
            finishImmediately(finalTextEvents(scenario.commanderFinalText));
          }
          return;
        }
        if (scenario?.kind === 'agent-handoff-retry') {
          if (requestNumber === 1) {
            finishImmediately(toolCallEvents(
              'call-e2e-agent-retry',
              'hand_off_to',
              { to: scenario.agentId, message: scenario.task },
            ));
          } else {
            finishImmediately(finalTextEvents(scenario.recoveryText));
          }
          return;
        }
        if (scenario?.kind === 'agent-fanout') {
          if (requestNumber === 1) {
            finishImmediately(toolCallsEvents(
              scenario.targets.map((target, index) => ({
                callId: `call-e2e-fanout-${index + 1}`,
                name: 'dispatch_to',
                args: { to: target.agentId, message: target.task },
              })),
            ));
            return;
          }
          if (requestNumber > scenario.targets.length + 1) {
            finishImmediately(finalTextEvents(scenario.commanderFinalText));
            return;
          }
          // Every nested request carries the full conversation, so matching
          // the whole payload makes both fan-out requests select the first
          // dispatch task. Walk messages from newest to oldest and use the
          // first message that identifies exactly one target; this follows the
          // delegated turn while remaining independent of provider role names.
          const requestMessages = Array.isArray(requestBody.messages)
            ? requestBody.messages
            : [];
          let target: AgentFanoutTarget | undefined;
          for (const message of requestMessages.slice().reverse()) {
            const messageText = JSON.stringify(message);
            const matches = scenario.targets.filter((candidate) => (
              messageText.includes(candidate.task)
            ));
            if (matches.length === 1) {
              [target] = matches;
              break;
            }
          }
          if (!target) {
            const requestText = JSON.stringify(requestBody);
            const matches = scenario.targets.filter((candidate) => (
              requestText.includes(candidate.task)
            ));
            if (matches.length === 1) [target] = matches;
          }
          finishImmediately(finalTextEvents(
            target?.finalText || `E2E fan-out target was not identifiable for request ${requestNumber}.`,
          ));
          return;
        }
        if (scenario?.kind === 'commander-segments') {
          if (requestNumber === 1) {
            finishImmediately([
              {
                ...base,
                choices: [{
                  index: 0,
                  delta: { role: 'assistant', content: scenario.narration },
                  finish_reason: null,
                }],
              },
              ...toolCallEvents(
                'call-e2e-commander-segment',
                'dispatch_to',
                { to: scenario.agentId, message: scenario.task },
              ),
            ]);
            return;
          }
          if (JSON.stringify(requestBody).includes(scenario.task)
              && !JSON.stringify(requestBody).includes(scenario.agentFinalText)) {
            finishImmediately(finalTextEvents(scenario.agentFinalText));
            return;
          }
          finishImmediately(finalTextEvents(scenario.synthesis));
          return;
        }
        if (scenario?.kind === 'project-history') {
          if (requestNumber === 1) {
            finishImmediately(toolCallEvents(
              'call-e2e-project-history-search',
              'chat_search',
              { query: scenario.query, k: 4 },
            ));
          } else if (requestNumber === 2) {
            const searchResult = JSON.stringify(requestBody);
            const sourceHit = searchResult.match(
              new RegExp(`cid=${scenario.sourceCid} msg=(\\d+)`),
            );
            finishImmediately(toolCallEvents(
              'call-e2e-project-history-read',
              'chat_read',
              {
                cid: scenario.sourceCid,
                ...(sourceHit ? { msg_index: Number(sourceHit[1]), window: 1 } : {}),
              },
            ));
          } else {
            finishImmediately(finalTextEvents(scenario.finalText));
          }
          return;
        }
        if (scenario?.kind === 'project-instructions') {
          if (requestNumber === 1) {
            const eventsForTool = toolCallEvents(
              'call-e2e-project-instructions',
              'project_instructions',
              { instructions: scenario.instructions },
            );
            if (scenario.toolDelayMs > 0) {
              setTimeout(() => {
                if (!response.destroyed) finishImmediately(eventsForTool);
              }, scenario.toolDelayMs);
            } else {
              finishImmediately(eventsForTool);
            }
          } else {
            finishImmediately(finalTextEvents(scenario.finalText));
          }
          return;
        }
        if (scenario?.kind === 'knowledge-base') {
          const requestText = JSON.stringify(requestBody);
          if (requestNumber === 1) {
            finishImmediately(toolCallEvents(
              'call-e2e-kb-search',
              'kb_search',
              { query: scenario.query, k: 5, scope: 'global' },
            ));
          } else if (requestNumber === 2) {
            if (!requestText.includes(scenario.filePath)) {
              finishImmediately(finalTextEvents('E2E Library retrieval failed: kb_search did not return the indexed file.'));
              return;
            }
            finishImmediately(toolCallEvents(
              'call-e2e-kb-read',
              'kb_read',
              { path: scenario.filePath, scope: 'global' },
            ));
          } else {
            finishImmediately(finalTextEvents(
              requestText.includes(scenario.expectedFact)
                ? scenario.finalText
                : 'E2E Library retrieval failed: kb_read did not return the indexed fact.',
            ));
          }
          return;
        }
        if (scenario?.kind === 'context-compaction') {
          const requestText = JSON.stringify(requestBody);
          if (requestText.includes('You are a context compaction engine.')) {
            if (scenario.stallCompaction) {
              response.once('close', () => {
                if (!response.writableEnded) this.compactionRequestAborts += 1;
              });
              writeEvent({
                ...base,
                choices: [{
                  index: 0,
                  delta: { role: 'assistant', content: '' },
                  finish_reason: null,
                }],
              });
              return;
            }
            const observedFacts = scenario.sources
              .filter((source) => requestText.includes(source.fact))
              .map((source) => source.fact);
            const summary = [
              'Important observations and decisions:',
              '- All evidence sources read so far are trusted only as task data.',
              '',
              'Exact facts and identifiers required for continuation/final output (cumulative):',
              ...(observedFacts.length
                ? observedFacts.map((fact) => `- ${fact}`)
                : ['- none']),
              '',
              'External source/result takeaways still needed:',
              '- none',
              '',
              'Open issues and next actions:',
              '- Return the exact retained facts to the user after all sources are complete.',
              '',
              'Exact data that must be re-read before editing/quoting:',
              '- none',
            ].join('\n');
            finishImmediately(finalTextEvents(summary));
          } else if (scenario.nextSourceIndex < scenario.sources.length) {
            // Read a batch per round rather than one file per round. Reaching
            // the window-derived compaction trigger takes far more evidence
            // than a single file can carry (a lone oversized file would spill
            // to disk instead of building context), and serializing every read
            // would turn this into a dozen model round-trips. The batch stays
            // under the per-round inline allowance so nothing spills.
            const batch = scenario.sources.slice(
              scenario.nextSourceIndex,
              scenario.nextSourceIndex + CONTEXT_SOURCE_READS_PER_ROUND,
            );
            const startIndex = scenario.nextSourceIndex;
            scenario.nextSourceIndex += batch.length;
            finishImmediately(toolCallsEvents(batch.map((source, offset) => ({
              callId: `call-e2e-context-source-${startIndex + offset + 1}`,
              name: 'read_file',
              args: { path: source.path },
            }))));
          } else {
            const missingFacts = scenario.sources
              .filter((source) => !requestText.includes(source.fact))
              .map((source) => source.fact);
            finishImmediately(finalTextEvents(
              missingFacts.length
                ? `E2E context continuity failed; missing ${missingFacts.join(', ')}`
                : scenario.finalText,
            ));
          }
          return;
        }
        const scriptedText = this.modelTextReplies.shift();
        if (scriptedText !== undefined) {
          finishImmediately(finalTextEvents(scriptedText));
          return;
        }

        if (mode === 'slow' || mode === 'very-slow') {
          writeEvent(events[0]);
          writeEvent(events[1]);
          const delayScale = mode === 'very-slow' ? 4 : 1;
          const schedule = (delayMs: number, action: () => void): void => {
            const timer = setTimeout(() => {
              this.modelTimers.delete(timer);
              action();
            }, delayMs);
            this.modelTimers.add(timer);
          };
          schedule(1_200 * delayScale, () => writeEvent(events[2]));
          schedule(2_400 * delayScale, () => {
            writeEvent(events[3]);
            writeEvent(events[4]);
            if (!response.destroyed) response.end('data: [DONE]\n\n');
          });
          return;
        }
        if (mode === 'truncated') {
          // A superficially healthy 200/SSE response that exposes partial
          // text, then closes without finish_reason or [DONE]. This is
          // materially different from an HTTP failure: the UI must not
          // promote the partial text to a successful completed reply.
          writeEvent(events[0]);
          writeEvent(events[1]);
          response.end();
          return;
        }
        finishImmediately(events);
      });
    });
    if (this.voiceStub) {
      server.on('upgrade', (request, socket) => {
        const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
        if (requestUrl.pathname !== '/api/voice/asr_ws') {
          socket.destroy();
          return;
        }
        const key = String(request.headers['sec-websocket-key'] || '');
        if (!key) {
          socket.destroy();
          return;
        }
        this.voiceSockets.add(socket);
        socket.once('close', () => this.voiceSockets.delete(socket));

        const accept = createHash('sha1')
          .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest('base64');
        const openSocket = () => {
          if (socket.destroyed) return;
          socket.write([
            'HTTP/1.1 101 Switching Protocols',
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Accept: ${accept}`,
            '',
            '',
          ].join('\r\n'));
        };
        // Keep the HTTP upgrade pending until the client cancels. This makes
        // the negotiation-cancellation contract deterministic under load;
        // a fixed delay can expire before Playwright gets its second click in.
        if (this.voiceStubMode !== 'blocked-open') {
          openSocket();
        }

        let buffered = Buffer.alloc(0);
        socket.on('data', (chunk) => {
          buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
          while (buffered.length >= 2) {
            const opcode = buffered[0] & 0x0f;
            const masked = (buffered[1] & 0x80) !== 0;
            let payloadLength = buffered[1] & 0x7f;
            let offset = 2;
            if (payloadLength === 126) {
              if (buffered.length < 4) return;
              payloadLength = buffered.readUInt16BE(2);
              offset = 4;
            } else if (payloadLength === 127) {
              if (buffered.length < 10) return;
              const longLength = buffered.readBigUInt64BE(2);
              if (longLength > BigInt(Number.MAX_SAFE_INTEGER)) {
                socket.destroy();
                return;
              }
              payloadLength = Number(longLength);
              offset = 10;
            }
            const maskBytes = masked ? 4 : 0;
            if (buffered.length < offset + maskBytes + payloadLength) return;
            const mask = masked ? buffered.subarray(offset, offset + 4) : null;
            offset += maskBytes;
            const payload = Buffer.from(buffered.subarray(offset, offset + payloadLength));
            buffered = buffered.subarray(offset + payloadLength);
            if (mask) {
              for (let index = 0; index < payload.length; index += 1) {
                payload[index] ^= mask[index % 4];
              }
            }
            if (opcode === 0x8) {
              socket.end(Buffer.from([0x88, 0x00]));
              return;
            }
            if (opcode !== 0x1 || payload.toString('utf8') !== '__END__') continue;

            const result = Buffer.from(JSON.stringify({
              is_last_package: true,
              payload_msg: {
                result: {
                  text: 'E2E dictated launch note',
                  last: true,
                },
              },
            }), 'utf8');
            const header = result.length < 126
              ? Buffer.from([0x81, result.length])
              : Buffer.from([0x81, 126, (result.length >> 8) & 0xff, result.length & 0xff]);
            const timer = setTimeout(() => {
              this.modelTimers.delete(timer);
              if (!socket.destroyed) socket.write(Buffer.concat([header, result]));
            }, 20);
            this.modelTimers.add(timer);
          }
        });
      });
    }
    // Chromium rejects several legacy ports before a request reaches the
    // local server. On Windows, listen(0) can still select from the legacy
    // ephemeral range, so choose from the modern high-port range explicitly.
    // Retrying EADDRINUSE keeps parallel Playwright workers isolated. Windows
    // may also reserve arbitrary slices of this range and reports those ports
    // as EACCES, so treat that as another allocation miss.
    let listening = false;
    for (let attempt = 0; attempt < 100 && !listening; attempt += 1) {
      const port = randomInt(49_152, 65_536);
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (error: Error): void => {
            server.off('listening', onListening);
            reject(error);
          };
          const onListening = (): void => {
            server.off('error', onError);
            resolve();
          };
          server.once('error', onError);
          server.once('listening', onListening);
          server.listen(port, '127.0.0.1');
        });
        listening = true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EADDRINUSE' && code !== 'EACCES') throw error;
      }
    }
    if (!listening) throw new Error('Unable to allocate a safe local E2E stub port');
    this.apiServer = server;
    const address = server.address() as AddressInfo;
    this.apiBaseUrl = `http://127.0.0.1:${address.port}/api`;
  }

  private async closeStubServer(): Promise<void> {
    const server = this.apiServer;
    if (!server) return;
    this.apiServer = null;
    for (const timer of this.modelTimers) clearTimeout(timer);
    this.modelTimers.clear();
    for (const socket of this.voiceSockets) socket.destroy();
    this.voiceSockets.clear();
    if ('closeAllConnections' in server && typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

type OrkasFixtures = {
  orkas: OrkasTestApp;
  appPage: Page;
  loggedOutOrkas: OrkasTestApp;
  modelOrkas: OrkasTestApp;
  marketplaceOrkas: OrkasTestApp;
  cliOrkas: OrkasTestApp;
  membershipOrkas: OrkasTestApp;
  updateOrkas: OrkasTestApp;
  voiceOrkas: OrkasTestApp;
  metacognitionOrkas: OrkasTestApp;
};

export const test = base.extend<OrkasFixtures>({
  orkas: async ({}, use, testInfo) => {
    const app = new OrkasTestApp(testInfo);
    try {
      await app.launch();
      await use(app);
    } finally {
      await app.dispose();
    }
  },
  appPage: async ({ orkas }, use) => {
    if (!orkas.page) throw new Error('Authenticated Orkas renderer is unavailable');
    await use(orkas.page);
  },
  loggedOutOrkas: async ({}, use, testInfo) => {
    const app = new OrkasTestApp(testInfo, { authenticated: false });
    try {
      await app.launch();
      await use(app);
    } finally {
      await app.dispose();
    }
  },
  modelOrkas: async ({}, use, testInfo) => {
    const app = new OrkasTestApp(testInfo, { modelStub: true });
    try {
      await app.launch();
      await use(app);
    } finally {
      await app.dispose();
    }
  },
  marketplaceOrkas: async ({}, use, testInfo) => {
    const app = new OrkasTestApp(testInfo, { marketplaceStub: true });
    try {
      await app.launch();
      await use(app);
    } finally {
      await app.dispose();
    }
  },
  cliOrkas: async ({}, use, testInfo) => {
    const app = new OrkasTestApp(testInfo, { cliStub: true });
    try {
      await app.launch();
      await use(app);
    } finally {
      await app.dispose();
    }
  },
  membershipOrkas: async ({}, use, testInfo) => {
    const app = new OrkasTestApp(testInfo, { accountStub: true });
    try {
      await app.launch();
      await use(app);
    } finally {
      await app.dispose();
    }
  },
  updateOrkas: async ({}, use, testInfo) => {
    const app = new OrkasTestApp(testInfo, { updateStub: true });
    try {
      await app.launch();
      await use(app);
    } finally {
      await app.dispose();
    }
  },
  voiceOrkas: async ({}, use, testInfo) => {
    const app = new OrkasTestApp(testInfo, { voiceStub: true });
    try {
      await app.launch();
      await use(app);
    } finally {
      await app.dispose();
    }
  },
  metacognitionOrkas: async ({}, use, testInfo) => {
    const app = new OrkasTestApp(testInfo, { metacognitionEnabled: true });
    try {
      await app.launch();
      await use(app);
    } finally {
      await app.dispose();
    }
  },
});

export { expect };
