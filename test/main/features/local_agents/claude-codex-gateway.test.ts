import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { anthropicContext, createClaudeCodexGateway } from '../../../../scripts/local-agent-claude-codex-gateway.mjs';
import { createClaudeCodexIsolation, runClaudeCodexLive } from '../../../../scripts/run-claude-codex-live.mjs';

// The opt-in native isolation route is POSIX-only; protocol translation above
// that boundary remains portable. Windows must reject it before authentication.
const itPosix = it.skipIf(process.platform === 'win32');

const request = { model: 'gateway-alias', stream: true, max_tokens: 100,
  system: [{ type: 'text', text: 'First instruction.' }, { type: 'text', text: 'Second instruction.' }],
  messages: [{ role: 'user', content: 'Read the note.' }],
  tools: [{ name: 'Read', description: 'Read a note', input_schema: { type: 'object', properties: { file: { type: 'string' } } } }] };
const post = (gateway: any, body: any, token = gateway.token, signal?: AbortSignal) => fetch(gateway.url + '/v1/messages?beta=true', {
  method: 'POST', headers: { 'x-api-key': token, 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
});

describe('isolated real Claude / Codex acceptance transport', () => {
  it('preserves instructions, tool schemas, call identity, ordering and failed tool results', () => {
    const body = { ...request, messages: [request.messages[0],
      { role: 'assistant', content: [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'call_1', name: 'Read', input: { file: 'note.txt' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', is_error: true, content: 'Permission denied' }, { type: 'text', text: 'Continue.' }] }] };
    const context = anthropicContext(body);
    expect(context.systemPrompt).toBe('First instruction.\nSecond instruction.');
    expect(context.tools[0]).toEqual({ name: 'Read', description: 'Read a note', parameters: request.tools[0].input_schema });
    expect(context.messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'toolResult', 'user']);
    expect(context.messages[1].content[1]).toMatchObject({ type: 'toolCall', id: 'call_1', name: 'Read', arguments: { file: 'note.txt' } });
    expect(context.messages[2]).toMatchObject({ toolCallId: 'call_1', toolName: 'Read', isError: true, content: [{ type: 'text', text: 'Permission denied' }] });
  });

  it.each([
    { messages: [{ role: 'user', content: [{ type: 'image', source: {} }] }] },
    { messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'unknown', content: 'False result' }] }] },
    { tools: [{ name: 'Search', type: 'tool_search_tool_regex' }] },
    { system: [{ type: 'image' }] },
  ])('rejects unsupported or orphaned content before inference: %j', delta => {
    expect(() => anthropicContext({ ...request, ...delta })).toThrow();
  });

  it('keeps native mid-conversation system messages in their original position', () => {
    const context = anthropicContext({ ...request, messages: [request.messages[0],
      { role: 'system', content: [{ type: 'text', text: 'Updated native runtime instruction.' }] },
      { role: 'user', content: 'Continue.' }] });
    expect(context.messages.map((m: any) => m.role)).toEqual(['user', 'system', 'user']);
    expect(context.messages[1].content).toEqual([{ type: 'text', text: 'Updated native runtime instruction.' }]);
  });

  it('delivers incremental text/tool JSON and a complete terminal sequence using only the fixed model', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const stream = vi.fn(async function* (_context, options) {
      expect(options).toMatchObject({ model: 'gpt-6.1-sol', maxTokens: 100 });
      yield { type: 'text_start', contentIndex: 0 };
      yield { type: 'text_delta', contentIndex: 0, delta: 'First ' };
      await gate;
      yield { type: 'text_delta', contentIndex: 0, delta: 'second.' };
      yield { type: 'text_end', contentIndex: 0 };
      yield { type: 'toolcall_start', contentIndex: 1, partial: { content: [null, { id: 'call_native|item_private', name: 'Read' }] } };
      yield { type: 'toolcall_delta', contentIndex: 1, delta: '{"file":"note.txt"}' };
      yield { type: 'toolcall_end', contentIndex: 1, toolCall: { arguments: { file: 'note.txt' } } };
      yield { type: 'done', reason: 'toolUse', message: { usage: { input: 10, output: 20 } } };
    });
    const gateway = await createClaudeCodexGateway({ stream, requestBudget: 1 });
    try {
      const response = await post(gateway, request);
      const reader = response.body!.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      expect(first).toContain('First '); expect(first).not.toContain('message_stop');
      release(); let rest = '';
      for (;;) { const next = await reader.read(); if (next.done) break; rest += new TextDecoder().decode(next.value); }
      expect(rest).toContain('second.'); expect(rest).toContain('input_json_delta');
      expect(rest).toContain('"stop_reason":"tool_use"'); expect(rest).toContain('event: message_stop');
      expect(rest).not.toContain('item_private');
      expect((await post(gateway, request)).status).toBe(429);
      expect(stream).toHaveBeenCalledTimes(1);
      expect(gateway.stats).toMatchObject({ requests: 1, completed: 1, rejected: 1, failed: 0, active: 0 });
    } finally { release(); await gateway.close(); }
  });

  it('does not forward unauthorized/nonstreaming requests and never converts upstream failure to success', async () => {
    const stream = vi.fn(async function* () { throw new Error('PRIVATE_PROVIDER_DETAIL'); });
    const gateway = await createClaudeCodexGateway({ stream });
    try {
      expect((await post(gateway, request, 'wrong')).status).toBe(401);
      expect((await post(gateway, { ...request, stream: false })).status).toBe(400);
      const response = await post(gateway, request); const text = await response.text();
      expect(text).toContain('event: error'); expect(text).not.toContain('PRIVATE_PROVIDER_DETAIL');
      expect(text).not.toContain('event: message_stop'); expect(stream).toHaveBeenCalledTimes(1);
      expect(gateway.stats.failed).toBe(1);
    } finally { await gateway.close(); }
  });

  it('aborts upstream on client disconnect and enforces its own deadline without a fallback request', async () => {
    const signals: AbortSignal[] = [];
    const stream = vi.fn(async function* (_context, { signal }) {
      signals.push(signal); yield { type: 'text_start', contentIndex: 0 };
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      throw new Error('aborted');
    });
    const gateway = await createClaudeCodexGateway({ stream, requestTimeoutMs: 100 });
    try {
      const response = await post(gateway, request); await response.text();
      expect(signals[0].aborted).toBe(true); expect(gateway.stats.failed).toBe(1);
      const controller = new AbortController(); const cancelled = await post(gateway, request, gateway.token, controller.signal);
      await cancelled.body!.getReader().read(); controller.abort();
      await vi.waitFor(() => expect(gateway.stats.cancelled).toBe(1));
      expect(signals[1].aborted).toBe(true); expect(stream).toHaveBeenCalledTimes(2);
    } finally { await gateway.close(); }
  });

  it('rejects oversized input and concurrent inference without spending another request', async () => {
    const stream = vi.fn(async function* (_context, { signal }) {
      yield { type: 'text_start', contentIndex: 0 };
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    });
    const gateway = await createClaudeCodexGateway({ stream });
    const controller = new AbortController();
    try {
      expect((await post(gateway, { ...request, messages: [{ role: 'user', content: 'x'.repeat(4 * 1024 * 1024) }] })).status).toBe(413);
      const first = await post(gateway, request, gateway.token, controller.signal);
      await first.body!.getReader().read();
      expect((await post(gateway, request)).status).toBe(409);
      expect(stream).toHaveBeenCalledTimes(1);
    } finally { controller.abort(); await gateway.close(); }
  });

  itPosix('uses private homes and a read-only native binary without inheriting normal credentials or settings', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-isolation-test-'));
    const original = { HOME: '/normal/home', PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/normal/claude',
      ANTHROPIC_AUTH_TOKEN: 'NORMAL_SECRET', OPENAI_API_KEY: 'OTHER_SECRET', NODE_OPTIONS: '--inspect',
      ORKAS_WORKSPACE_ROOT: '/normal/data', EVAL_CLAUDE_MODEL: 'other-model' };
    try {
      const isolated = createClaudeCodexIsolation({ root, cliPath: '/native/claude', gateway: { url: 'http://127.0.0.1:1234', token: 'fixture-only' }, env: original });
      expect(isolated.env).toMatchObject({ HOME: path.join(root, 'home'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
        CODEX_HOME: path.join(root, 'codex'), ANTHROPIC_AUTH_TOKEN: 'fixture-only', EVAL_CLAUDE_MODEL: 'gpt-6.1-sol', DISABLE_AUTOUPDATER: '1' });
      expect(isolated.env.OPENAI_API_KEY).toBeUndefined(); expect(isolated.env.NODE_OPTIONS).toBeUndefined();
      expect(isolated.env.ORKAS_WORKSPACE_ROOT).not.toBe(original.ORKAS_WORKSPACE_ROOT);
      const wrapper = fs.readFileSync(isolated.env.ORKAS_CLAUDE_PATH, 'utf8');
      expect(wrapper).toContain('--setting-sources'); expect(wrapper).toContain('--strict-mcp-config');
      expect(original.ANTHROPIC_AUTH_TOKEN).toBe('NORMAL_SECRET'); expect(original.HOME).toBe('/normal/home');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  itPosix('runs the scoped wrapper with literal arguments even when the installed path contains spaces and quotes', () => {
    const root = fs.mkdtempSync('/tmp/cc-wrapper-');
    const binary = path.join(root, "native cli's executable");
    fs.writeFileSync(binary, `#!${process.env.ORKAS_TEST_NODE}\nprocess.stdout.write(JSON.stringify({argv:process.argv.slice(2),home:process.env.HOME,key:process.env.OPENAI_API_KEY}));\n`, { mode: 0o700 });
    try {
      const { env } = createClaudeCodexIsolation({ root, cliPath: binary, gateway: { url: 'http://127.0.0.1:1', token: 'fixture' },
        env: { PATH: process.env.PATH, HOME: '/normal/home', OPENAI_API_KEY: 'PRIVATE_KEY' } });
      const result = spawnSync(env.ORKAS_CLAUDE_PATH, ['-p', 'literal ; $HOME " value'], { env, encoding: 'utf8', timeout: 5000 });
      expect(result.status).toBe(0); expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual({ argv: ['--setting-sources', '', '--strict-mcp-config', '-p', 'literal ; $HOME " value'], home: path.join(root, 'home') });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects installation, other CLIs and semantic cohorts before authentication', async () => {
    const credential = vi.fn(() => 'fixture-only'); const start = vi.fn();
    for (const argv of [['--agents', 'codex'], ['--benchmark'], ['--install-only']]) {
      await expect(runClaudeCodexLive(argv, { env: {}, loadCredential: credential, startGateway: start })).rejects.toThrow();
    }
    expect(credential).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform !== 'win32')('rejects POSIX isolation on Windows before reading credentials or creating isolated state', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-windows-rejection-'));
    const binary = path.join(root, 'native-claude');
    const source = 'Unexecuted native fixture';
    fs.writeFileSync(binary, source);
    const env = { HOME: root, ORKAS_CLAUDE_PATH: binary, OPENAI_API_KEY: 'PRIVATE_FIXTURE_KEY' };
    const loadCredential = vi.fn(() => 'fixture-only');
    const startGateway = vi.fn();
    const launchLive = vi.fn();
    const writeReport = vi.fn();
    try {
      expect(() => createClaudeCodexIsolation({ root, cliPath: binary,
        gateway: { url: 'http://127.0.0.1:1', token: 'fixture-only' }, env })).toThrow('absolute POSIX CLI path');
      await expect(runClaudeCodexLive([], { env, loadCredential, startGateway, launchLive, writeReport }))
        .rejects.toThrow('existing POSIX Claude executable');
      for (const dependency of [loadCredential, startGateway, launchLive, writeReport]) {
        expect(dependency).not.toHaveBeenCalled();
      }
      expect(fs.readdirSync(root)).toEqual(['native-claude']);
      expect(fs.readFileSync(binary, 'utf8')).toBe(source);
      expect(env).toEqual({ HOME: root, ORKAS_CLAUDE_PATH: binary, OPENAI_API_KEY: 'PRIVATE_FIXTURE_KEY' });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  itPosix('cleans up isolated homes and preserves the native binary after launcher failure', async () => {
    const credential = vi.fn(() => 'fixture-only');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-parent-test-')); const binary = path.join(root, 'claude');
    fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    let childHome = ''; const close = vi.fn(async () => {});
    try {
      await expect(runClaudeCodexLive([], { env: { HOME: root, ORKAS_CLAUDE_PATH: binary }, loadCredential: credential,
        startGateway: async () => ({ url: 'http://127.0.0.1:1234', token: 'fixture-only', stats: { requests: 0, failed: 0, rejected: 0, active: 0 }, close }),
        launchLive: async (argv, { env }) => { childHome = env.HOME; expect(argv).toEqual(['--agents', 'claude', '--no-install']); throw new Error('fixture failure'); },
        writeReport: () => {} })).rejects.toThrow('fixture failure');
      expect(close).toHaveBeenCalledOnce(); expect(fs.existsSync(childHome)).toBe(false);
      expect(fs.readFileSync(binary, 'utf8')).toBe('#!/bin/sh\nexit 0\n');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  itPosix('reuses only the existing single MCP execution case for the product-tools canary', async () => {
    const root = fs.mkdtempSync('/tmp/cc-mcp-entry-'); const binary = path.join(root, 'claude');
    fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const launch = vi.fn(async () => 0); const close = vi.fn(async () => {});
    try {
      expect(await runClaudeCodexLive(['--mcp'], { env: { HOME: root, ORKAS_CLAUDE_PATH: binary }, loadCredential: () => 'fixture-only',
        startGateway: async () => ({ url: 'http://127.0.0.1:1234', token: 'fixture-only', stats: { requests: 1, failed: 0, rejected: 0, active: 0 }, close }),
        launchLive: launch, writeReport: () => {} })).toBe(0);
      expect(launch).toHaveBeenCalledExactlyOnceWith(['--agents', 'claude', '--no-install', '--benchmark', '--scenario', 'local-agent-open-skill-read', '--k', '1'], expect.anything());
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  itPosix.each(['configuration', 'cleanup'])('does not report acceptance when %s isolation fails', async fault => {
    const root = fs.mkdtempSync('/tmp/cc-isolation-guard-'); const binary = path.join(root, 'claude');
    fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const reports: any[] = []; let sandbox = '';
    const remove = fault === 'cleanup' ? vi.spyOn(fs.promises, 'rm').mockRejectedValueOnce(new Error('PRIVATE_CLEANUP_PATH')) : undefined;
    try {
      expect(await runClaudeCodexLive([], { env: { HOME: root, ORKAS_CLAUDE_PATH: binary }, loadCredential: () => 'fixture-only',
        startGateway: async () => ({ url: 'http://127.0.0.1:1234', token: 'fixture-only', stats: { requests: 1, failed: 0, rejected: 0, active: 0 }, close: async () => {} }),
        launchLive: async (_argv, { env }) => {
          sandbox = path.dirname(env.HOME);
          if (fault === 'configuration') fs.writeFileSync(path.join(root, '.claude.json'), '{"unexpected":true}');
          return 0;
        }, writeReport: report => reports.push(report) })).toBe(1);
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({ passed: false, runnerExitCode: 0,
        protectedConfigurationUnchanged: fault !== 'configuration', cleanupComplete: fault !== 'cleanup' });
      expect(JSON.stringify(reports)).not.toContain('PRIVATE_CLEANUP_PATH');
    } finally {
      remove?.mockRestore();
      if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
