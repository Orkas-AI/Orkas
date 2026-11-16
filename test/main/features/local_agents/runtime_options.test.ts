import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as processBoundary from '../../../../src/main/features/local_agents/backends/base';

import {
  mapClaudeModelList,
  mapCodexModelList,
  mapOpenclawModels,
  parseBannerJson,
  parseHermesDefaultModel,
  parseOpenCodeModels,
  getLocalCliRuntimeOptions,
  getLocalCliSupportedFlags,
} from '../../../../src/main/features/local_agents/runtime_options';
import type { LocalCliEntry } from '../../../../src/main/features/local_agents/registry';

const TEST_NODE = process.env.ORKAS_TEST_NODE || process.execPath;
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-runtime-options-'));
  tempDirs.push(dir);
  return dir;
}

function writeFakeCli(directory: string, source: string): string {
  const scriptPath = path.join(directory, 'fake-cli.js');
  fs.writeFileSync(scriptPath, source, 'utf8');
  if (process.platform === 'win32') {
    const launcher = path.join(directory, 'fake-cli.cmd');
    fs.writeFileSync(launcher, `@echo off\r\n"${TEST_NODE}" "%~dp0fake-cli.js" %*\r\n`, 'utf8');
    return launcher;
  }
  const launcher = path.join(directory, 'fake-cli');
  fs.writeFileSync(launcher, `#!/usr/bin/env node\n${source}`, 'utf8');
  fs.chmodSync(launcher, 0o755);
  return launcher;
}

function entry(type: LocalCliEntry['type'], binPath: string): LocalCliEntry {
  return { type, path: binPath, version: '99.0.0', available: true };
}

describe('local_agents/runtime_options discovery parsing', () => {
  it('distinguishes the configured Codex default from the catalog recommendation', () => {
    const catalog = { data: [
      { id: 'gpt-recommended', isDefault: true },
      { id: 'gpt-configured', isDefault: false },
    ] };
    const result = mapCodexModelList(catalog, { config: {
      model: 'gpt-configured', model_reasoning_effort: 'high', secret: 'PRIVATE',
    } });
    expect(result.default_model).toBe('gpt-configured');
    expect(result.default_thinking_level).toBe('high');
    expect(result.models.filter(model => model.is_default).map(model => model.id)).toEqual(['gpt-configured']);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    // Custom provider/default configuration is not erased just because it is
    // absent from an account catalog. No new selectable catalog row is invented.
    const custom = mapCodexModelList(catalog, { config: { model: 'custom/default' } });
    expect(custom.default_model).toBe('custom/default');
    expect(custom.models.some(model => model.is_default)).toBe(false);
    expect(custom.models.map(model => model.id)).toEqual(['gpt-recommended', 'gpt-configured']);
  });
  it('maps Codex defaults and model-specific effort levels', () => {
    const result = mapCodexModelList({
      data: [
        {
          id: 'gpt-default',
          displayName: 'GPT Default',
          isDefault: true,
          defaultReasoningEffort: 'medium',
          supportedReasoningEfforts: [
            { reasoningEffort: 'low', description: 'fast' },
            { reasoningEffort: 'high', description: 'deep' },
          ],
        },
        { id: 'gpt-fast', displayName: 'GPT Fast', isDefault: false },
      ],
    });

    expect(result.default_model).toBe('gpt-default');
    expect(result.default_thinking_level).toBe('medium');
    expect(result.models[0]).toMatchObject({
      id: 'gpt-default',
      label: 'GPT Default',
      is_default: true,
      default_thinking_level: 'medium',
      thinking_levels: [{ id: 'low' }, { id: 'high' }],
    });
    expect(result.thinking_levels).toEqual([{ id: 'low' }, { id: 'high' }]);
  });

  it('collapses same-label Codex aliases and keeps the canonical model id', () => {
    const result = mapCodexModelList({
      data: [
        { id: 'gpt-default', displayName: 'GPT Default', isDefault: true },
        { id: 'codex-auto-review', displayName: 'GPT-5.6-Luna' },
        { id: 'gpt-5.6-luna', displayName: 'GPT-5.6-Luna' },
      ],
    });

    expect(result.default_model).toBe('gpt-default');
    expect(result.models).toEqual([
      { id: 'gpt-default', label: 'GPT Default', is_default: true },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' },
    ]);
  });

  it('bounds adversarially large model and effort catalogs before IPC', () => {
    const result = mapCodexModelList({
      data: Array.from({ length: 250 }, (_, modelIndex) => ({
        id: `model-${modelIndex}`,
        supportedReasoningEfforts: Array.from({ length: 100 }, (_, levelIndex) => ({
          reasoningEffort: `level-${levelIndex}`,
        })),
      })),
    });
    expect(result.models).toHaveLength(200);
    expect(result.models[0].thinking_levels).toHaveLength(32);
    expect(result.thinking_levels).toHaveLength(32);
  });

  // Captured from `claude --print --input-format stream-json --output-format
  // stream-json --verbose --bare` (Claude Code 2.1.234) answering list_models.
  const CLAUDE_LIST_MODELS = {
    models: [
      {
        value: 'default',
        resolvedModel: 'claude-opus-5[1m]',
        displayName: 'Default (recommended)',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
      {
        value: 'opus[1m]',
        resolvedModel: 'claude-opus-5[1m]',
        displayName: 'Opus (1M context)',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
      {
        value: 'claude-fable-5[1m]',
        resolvedModel: 'claude-fable-5',
        displayName: 'Fable',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
      {
        value: 'sonnet',
        resolvedModel: 'claude-sonnet-5',
        displayName: 'Sonnet',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
      {
        value: 'haiku',
        resolvedModel: 'claude-haiku-4-5-20251001',
        displayName: 'Haiku',
      },
    ],
  };

  it('offers every model Claude Code advertises and marks only the family aliases', () => {
    const result = mapClaudeModelList(CLAUDE_LIST_MODELS);

    // A model added by a future Claude Code release reaches the picker without
    // a PC change; `default` is dropped because an empty override means it.
    expect(result.models.map(model => model.id)).toEqual([
      'opus[1m]', 'claude-fable-5[1m]', 'sonnet', 'haiku',
    ]);
    // Every alias names the concrete version it runs today, so the picker can
    // state a model instead of an unactionable "latest".
    expect(result.models[0]).toEqual({
      id: 'opus[1m]',
      label: 'Opus (1M context)',
      is_alias: true,
      resolved_model: 'claude-opus-5[1m]',
      thinking_levels: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }, { id: 'xhigh' }, { id: 'max' }],
    });
    // A pinned model id keeps its version, so it is not an alias; the context
    // variant suffix alone must not make it look like one. Its display name
    // still carries no version, so the model behind it is published too.
    expect(result.models[1]).toMatchObject({
      id: 'claude-fable-5[1m]',
      label: 'Fable',
      resolved_model: 'claude-fable-5',
    });
    expect(result.models[1].is_alias).toBeUndefined();
    // Haiku advertises no effort support, so it takes no thinking level at all
    // rather than inheriting the levels its siblings advertise.
    expect(result.models[3]).toEqual({
      id: 'haiku',
      label: 'Haiku',
      is_alias: true,
      resolved_model: 'claude-haiku-4-5-20251001',
      supports_thinking: false,
    });
    expect(result.thinking_levels.map(level => level.id))
      .toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    // The dropped `default` row still names the model that choice runs today.
    expect(result.default_model_resolved).toBe('claude-opus-5[1m]');
  });

  it('rejects list_models look-alikes instead of publishing unusable rows', () => {
    const empty = { models: [], thinking_levels: [], default_model_resolved: null };
    expect(mapClaudeModelList(null)).toEqual(empty);
    expect(mapClaudeModelList('{"models":[]}')).toEqual(empty);
    expect(mapClaudeModelList({ data: [{ value: 'sonnet' }] })).toEqual(empty);
    expect(mapClaudeModelList({
      models: [
        { resolvedModel: 'claude-sonnet-5', displayName: 'No value' },
        { value: 'bad\u0000value', displayName: 'Control chars' },
        { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet' },
        { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Duplicate' },
        { value: 'plain', supportedEffortLevels: 'high' },
      ],
    })).toEqual({
      // A payload that never mentions effort support says nothing about it, so
      // no model is marked unsupported and the global levels still apply.
      models: [
        { id: 'sonnet', label: 'Sonnet', is_alias: true, resolved_model: 'claude-sonnet-5' },
        // A row that names no resolution publishes none; the picker must not
        // invent a version for it.
        { id: 'plain', label: 'plain' },
      ],
      thinking_levels: [],
      default_model_resolved: null,
    });
  });

  it('accepts OpenClaw banner-prefixed JSON and adds a missing resolved default', () => {
    const mapped = mapOpenclawModels(
      '[startup] ready\n{"resolvedDefault":"openai/gpt-default"}',
      '[models]\n{"models":[{"id":"openai/gpt-fast","name":"Fast"}]}',
    );
    expect(mapped).toEqual({
      default_model: 'openai/gpt-default',
      models: [
        { id: 'openai/gpt-default', label: 'openai/gpt-default', is_default: true },
        { id: 'openai/gpt-fast', label: 'Fast' },
      ],
    });
    expect(parseBannerJson('noise only')).toBeNull();
  });

  it('recovers from malformed banner candidates and preserves braces inside JSON strings', () => {
    expect(parseBannerJson('[not-json]\n{"value":"{nested} and \\"quoted\\""}')).toEqual({
      value: '{nested} and "quoted"',
    });
    expect(parseBannerJson('{broken]\n{"ok":true}')).toEqual({ ok: true });
  });

  it('filters OpenCode logs and secret-looking status text instead of exposing raw output', () => {
    const models = parseOpenCodeModels([
      'openai/gpt-5.4',
      'Authorization: Bearer private-token',
      'plugin startup complete',
      'anthropic/claude-sonnet-4-6',
    ].join('\n'));
    expect(models).toEqual([
      { id: 'openai/gpt-5.4', label: 'openai/gpt-5.4' },
      { id: 'anthropic/claude-sonnet-4-6', label: 'anthropic/claude-sonnet-4-6' },
    ]);
  });

  it('extracts only the exact Hermes model line and rejects control-text values', () => {
    expect(parseHermesDefaultModel('Provider: OpenAI\nModel: openai/gpt-5.4\nAPI key: private')).toBe('openai/gpt-5.4');
    expect(parseHermesDefaultModel('Model status: openai/gpt-5.4')).toBeNull();
    expect(parseHermesDefaultModel('Model: bad\u0000value')).toBeNull();
  });
});

describe('local_agents/runtime_options process boundary', () => {
  it.each(['2.0.0', '2.1.80', '2.1.81'])('does not run user hooks to discover models on Claude %s without bare support', async version => {
    const dir = makeTempDir();
    const taskProof = path.join(dir, 'unwanted-start');
    const fake = writeFakeCli(dir, `
if (process.argv.includes('--help')) {
  process.stdout.write('Options:\\n  --model <id>\\n');
  process.exit(0);
}
require('node:fs').writeFileSync(${JSON.stringify(taskProof)}, 'hooks started');
process.exit(2);
`);
    const options = await getLocalCliRuntimeOptions({ ...entry('claude', fake), version }, dir);
    expect(options.models.map(model => model.id)).toEqual(['sonnet', 'opus', 'haiku']);
    expect(options.can_select_thinking).toBe(false);
    expect(fs.existsSync(taskProof)).toBe(false);
  });

  it('requires both the bare version boundary and advertised support for a safe catalog probe', async () => {
    const dir = makeTempDir();
    const proof = path.join(dir, 'catalog-start');
    const fake = writeFakeCli(dir, `
if (process.argv.includes('--help')) {
  process.stdout.write('Options:\\n  --model <id>\\n  --bare\\n');
  process.exit(0);
}
require('node:fs').writeFileSync(${JSON.stringify(proof)}, 'catalog started');
process.exit(2);
`);
    await getLocalCliRuntimeOptions({ ...entry('claude', fake), version: '2.1.80' }, dir);
    expect(fs.existsSync(proof)).toBe(false);
    await getLocalCliRuntimeOptions({ ...entry('claude', fake), version: '2.1.81' }, dir);
    expect(fs.existsSync(proof)).toBe(true);
  });

  it('shares help discovery and refreshes capabilities after a binary version change', async () => {
    const dir = makeTempDir();
    const counter = path.join(dir, 'help-count');
    const fake = writeFakeCli(dir, `
require('node:fs').appendFileSync(${JSON.stringify(counter)}, '1');
process.stdout.write('Options:\\n  --model <id>\\n  --effort <level>\\n  --include-hook-events\\n');
`);
    const old = { ...entry('claude', fake), version: '2.1.72' };
    const results = await Promise.all([
      getLocalCliSupportedFlags(old, dir), getLocalCliSupportedFlags(old, dir),
    ]);
    expect(results).toEqual([
      ['--model', '--effort', '--include-hook-events'],
      ['--model', '--effort', '--include-hook-events'],
    ]);
    expect(fs.readFileSync(counter, 'utf8')).toBe('1');
    // Downgrade in place: retaining the same path must not retain new flags.
    writeFakeCli(dir, `require('node:fs').appendFileSync(${JSON.stringify(counter)}, '1'); process.stdout.write('Options:\\n  --model <id>\\n');`);
    const downgraded = { ...old, version: '2.0.0' };
    expect(await getLocalCliSupportedFlags(downgraded, dir)).toEqual(['--model']);
    expect(fs.readFileSync(counter, 'utf8')).toBe('11');
  });

  // The flag set changes only with the binary: every dispatch used to spawn
  // `--help` again once 30 s passed or the workspace changed, and one failed
  // probe was replayed to every dispatch for 30 s.
  it('keeps help discovery per binary across workspaces and time, and retries a failed probe', async () => {
    const dir = makeTempDir();
    const otherWorkspace = makeTempDir();
    const counter = path.join(dir, 'help-count');
    const failedOnce = path.join(dir, 'failed-once');
    const fake = writeFakeCli(dir, `
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(counter)}, '1');
if (!fs.existsSync(${JSON.stringify(failedOnce)})) {
  fs.writeFileSync(${JSON.stringify(failedOnce)}, '1');
  process.exit(1);
}
process.stdout.write('Options:\\n  --model <id>\\n');
`);
    const cli = { ...entry('opencode', fake), version: '1.2.3' };
    const spawns = () => fs.readFileSync(counter, 'utf8').length;

    await expect(getLocalCliSupportedFlags(cli, dir, ['run', '--help'])).rejects.toThrow('OpenCode');
    expect(await getLocalCliSupportedFlags(cli, dir, ['run', '--help'])).toEqual(['--model']);
    expect(spawns()).toBe(2);
    expect(await getLocalCliSupportedFlags(cli, otherWorkspace, ['run', '--help'])).toEqual(['--model']);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 10 * 60_000);
      expect(await getLocalCliSupportedFlags(cli, dir, ['run', '--help'])).toEqual(['--model']);
    } finally {
      vi.useRealTimers();
    }
    expect(spawns()).toBe(2);
  });

  it.each([false, true])('reads effective Codex defaults through native RPC, config rejection=%s', async rejected => {
    const dir = makeTempDir();
    const trace = path.join(dir, 'rpc.jsonl');
    const argvTrace = path.join(dir, 'argv.json');
    const customArgs = ['-c', 'model="configured-default"'];
    const fake = writeFakeCli(dir, `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(argvTrace)}, JSON.stringify(process.argv.slice(2)));
let buffer = '';
process.stdin.on('data', chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const message = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
    fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify(message) + '\\n');
    const reply = result => process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n');
    if (message.method === 'initialize') reply({});
    else if (message.method === 'model/list') reply({ data: [{ id: 'catalog-default', isDefault: true }] });
    else if (message.method === 'config/read') {
      if (${rejected}) process.stdout.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'unavailable' } }) + '\\n');
      else reply({ config: { model: 'configured-default', model_reasoning_effort: 'high', secrets: 'PRIVATE_CONFIGURATION' } });
    } else if (message.method !== 'initialized') {
      fs.writeFileSync(${JSON.stringify(path.join(dir, 'task-started'))}, 'unexpected task'); process.exit(3);
    }
  }
});
`);
    const options = await getLocalCliRuntimeOptions(entry('codex', fake), dir, { customArgs });
    // A rejected config/read cannot establish the inherited model. Preserve
    // the catalog, but do not label its recommendation as the active default.
    expect(options.default_model).toBe(rejected ? null : 'configured-default');
    expect(options.status).toBe(rejected ? 'partial' : 'ready');
    expect(JSON.parse(fs.readFileSync(argvTrace, 'utf8'))).toEqual(['app-server', '--listen', 'stdio://', ...customArgs]);
    expect(JSON.stringify(options)).not.toContain('PRIVATE_CONFIGURATION');
    const requests = fs.readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(requests.find(row => row.method === 'config/read').params).toEqual({ cwd: dir, includeLayers: false });
    expect(requests.map(row => row.method).sort()).toEqual(['config/read', 'initialize', 'initialized', 'model/list']);
    expect(fs.existsSync(path.join(dir, 'task-started'))).toBe(false);
  });
  it.each(['chatgpt', 'apiKey', 'custom'])('lists version-compatible defaults without restricting the %s provider', async account => {
    const dir = makeTempDir();
    const trace = path.join(dir, 'catalog-probe.jsonl');
    const fake = writeFakeCli(dir, `
const fs = require('node:fs');
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(trace)}, m.method + '\\n');
  const result = m.method === 'config/read' ? { config: { model: 'gpt-6.1-sol', model_provider: '${account === 'custom' ? 'custom' : 'openai'}' } }
    : m.method === 'account/read' ? { account: { type: '${account}' } }
    : m.method === 'model/list' ? { data: [{ id: 'gpt-6.1-sol', isDefault: true }, { id: 'gpt-6-sol', defaultReasoningEffort: 'low' }] }
    : {};
  if (m.id !== undefined) process.stdout.write(JSON.stringify({ id: m.id, result }) + '\\n');
});`);
    const options = await getLocalCliRuntimeOptions({ ...entry('codex', fake), version: '0.156.1' }, dir);
    expect(options.default_model).toBe(account === 'chatgpt' ? 'gpt-6-sol' : 'gpt-6.1-sol');
    expect(options.models.map(model => model.id)).toEqual(account === 'chatgpt' ? ['gpt-6-sol'] : ['gpt-6.1-sol', 'gpt-6-sol']);
    expect(options.models.find(model => model.is_default)?.id).toBe(options.default_model);
    const methods = fs.readFileSync(trace, 'utf8').trim().split('\n');
    expect(methods.includes('account/read')).toBe(account !== 'custom');
    expect(methods.filter(method => ['thread/start', 'thread/resume', 'turn/start'].includes(method))).toEqual([]);
  });
  it.each(['claude', 'codex'] as const)('accepts an unsupported %s model probe closing without killing its stale PID', async cli => {
    const dir = makeTempDir();
    const fake = writeFakeCli(dir, 'process.exit(2);');
    const kill = vi.spyOn(processBoundary, 'killProcessTree');
    try {
      const result = await getLocalCliRuntimeOptions(entry(cli, fake), dir, { force: true });
      expect(result.status).toBe('partial');
      if (cli === 'claude') expect(result.models.length).toBeGreaterThan(0);
      else expect(result.models).toEqual([]);
      expect(kill).not.toHaveBeenCalled();
    } finally { kill.mockRestore(); }
  });
  it.each(['claude', 'codex', 'hermes', 'opencode', 'openclaw'] as const)(
    'publishes the adapter-supported $cli permission levels even when discovery is unavailable',
    async (cli) => {
    const result = await getLocalCliRuntimeOptions({
      type: cli,
      path: null,
      version: null,
      available: false,
      error: 'not_found',
    }, process.cwd(), { force: true });

    const expected = cli === 'openclaw'
      ? ['inherit']
      : (cli === 'opencode' ? ['full_access'] : ['inherit', 'ask', 'full_access']);
    expect(result.permission_policies).toEqual(expected);
    expect(result.can_select_permission).toBe(expected.length > 1);
    expect(result.fixed_permission_policy).toBe(cli === 'opencode' ? 'full_access' : null);
    expect(result.status).toBe('unavailable');
  });

  it('reuses the bounded cache unless the caller explicitly refreshes it', async () => {
    const dir = makeTempDir();
    const counter = path.join(dir, 'counter.txt');
    const binPath = writeFakeCli(dir, `
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(counter)}, '1');
if (process.argv.includes('--help')) {
  process.stdout.write('Usage: fake --model <id> --effort <level> --bare\\n');
  process.exit(0);
}
process.exit(2);
`);

    const first = await getLocalCliRuntimeOptions(entry('claude', binPath), dir);
    const second = await getLocalCliRuntimeOptions(entry('claude', binPath), dir);
    const refreshed = await getLocalCliRuntimeOptions(
      entry('claude', binPath),
      dir,
      { force: true },
    );

    expect(first).toMatchObject({
      status: 'ready',
      can_select_model: true,
      can_select_thinking: true,
      thinking_kind: 'effort',
      permission_policies: ['inherit', 'ask', 'full_access'],
      can_select_permission: true,
      fixed_permission_policy: null,
    });
    // This build answers no model list, so the documented aliases stand in.
    expect(first.models).toEqual([
      { id: 'sonnet', label: 'Sonnet', is_alias: true },
      { id: 'opus', label: 'Opus', is_alias: true },
      { id: 'haiku', label: 'Haiku', is_alias: true },
    ]);
    expect(first.thinking_levels.map(level => level.id))
      .toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(second).toBe(first);
    expect(refreshed).not.toBe(first);
    // Two spawns per discovery (flag probe + model list), and the middle call
    // is served from cache.
    expect(fs.readFileSync(counter, 'utf8')).toBe('1111');
  });

  it('publishes the models Claude Code advertises over the control protocol', async () => {
    const dir = makeTempDir();
    const binPath = writeFakeCli(dir, `
const args = process.argv.slice(2);
if (args.includes('--help')) {
  process.stdout.write('Usage: fake --model <id> --effort <level> --bare\\n');
  process.exit(0);
}
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  let index;
  while ((index = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, index);
    buf = buf.slice(index + 1);
    let message;
    try { message = JSON.parse(line); } catch (_) { continue; }
    if (message && message.request && message.request.subtype === 'list_models') {
      process.stdout.write(JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: message.request_id,
          response: {
            models: [
              { value: 'default', resolvedModel: 'claude-newest-9', displayName: 'Default' },
              {
                value: 'newest',
                resolvedModel: 'claude-newest-9',
                displayName: 'Newest',
                supportsEffort: true,
                supportedEffortLevels: ['low', 'max'],
              },
            ],
          },
        },
      }) + '\\n');
    }
  }
});
`);

    const options = await getLocalCliRuntimeOptions(entry('claude', binPath), dir);

    // A model this build never heard of reaches the picker, and `default` stays
    // out because the empty override already means it. The version the alias
    // resolves to survives the spawn/parse boundary, so the picker can name it.
    expect(options.models).toEqual([
      {
        id: 'newest',
        label: 'Newest',
        is_alias: true,
        resolved_model: 'claude-newest-9',
        thinking_levels: [{ id: 'low' }, { id: 'max' }],
      },
    ]);
    expect(options.thinking_levels).toEqual([{ id: 'low' }, { id: 'max' }]);
    expect(options).toMatchObject({
      status: 'ready',
      can_select_model: true,
      default_model_resolved: 'claude-newest-9',
    });
  });

  it.each([
    ['2.x', '  --standalone    Run with a private server instead of the background service', ['models', '--standalone']],
    ['1.x', '      --dir          directory to run in', ['models']],
  ] as const)('lists OpenCode %s models without starting a shared background service', async (_line, helpLine, expected) => {
    const dir = makeTempDir();
    const trace = path.join(dir, 'models-argv.json');
    const binPath = writeFakeCli(dir, `
const args = process.argv.slice(2);
if (args[0] === 'run' && args.includes('--help')) {
  process.stdout.write('  --model, -m string    Model to use\\n' + ${JSON.stringify(helpLine)} + '\\n');
} else if (args[0] === 'models') {
  require('node:fs').writeFileSync(${JSON.stringify(trace)}, JSON.stringify(args));
  process.stdout.write('opencode/big-pickle\\n');
} else {
  process.exitCode = 2;
}
`);

    const options = await getLocalCliRuntimeOptions(entry('opencode', binPath), dir, { force: true });

    expect(JSON.parse(fs.readFileSync(trace, 'utf8'))).toEqual(expected);
    expect(options).toMatchObject({ status: 'ready', models: [{ id: 'opencode/big-pickle' }], can_select_model: true });
  }, 10_000);

  it.each([
    ['1.x', ['  --model <id>    Model', '  --dir <path>    Directory'].join('\n'), ['models']],
    ['2.x', ['  --model string    Model', '  --standalone    Private server'].join('\n'), ['models', '--standalone']],
  ] as const)('stops OpenCode %s catalog discovery on failed help and retries without caching the failure', async (_line, helpLine, expected) => {
    const dir = makeTempDir();
    const failed = path.join(dir, 'fail-help');
    const trace = path.join(dir, 'models.json');
    fs.writeFileSync(failed, 'fail');
    const binPath = writeFakeCli(dir, `
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'run' && args.includes('--help')) {
  if (fs.existsSync(${JSON.stringify(failed)})) {
    process.stderr.write('PRIVATE_PROBE_OUTPUT');
    process.exit(1);
  }
  process.stdout.write(${JSON.stringify(helpLine)});
} else if (args[0] === 'models') {
  fs.writeFileSync(${JSON.stringify(trace)}, JSON.stringify(args));
  process.stdout.write('opencode/fixture\\n');
}
`);
    const cli = entry('opencode', binPath);
    await expect(getLocalCliRuntimeOptions(cli, dir)).rejects.toThrow('OpenCode');
    expect(fs.existsSync(trace)).toBe(false);
    // Recover without force or a binary identity change: no failed option TTL.
    fs.unlinkSync(failed);
    const recovered = await getLocalCliRuntimeOptions(cli, dir);
    expect(recovered).toMatchObject({ status: 'ready', models: [{ id: 'opencode/fixture' }] });
    expect(JSON.parse(fs.readFileSync(trace, 'utf8'))).toEqual(expected);
    // A failed forced refresh must also evict an older successful catalog.
    fs.unlinkSync(trace);
    fs.writeFileSync(failed, 'fail');
    await expect(getLocalCliRuntimeOptions(cli, dir, { force: true })).rejects.toThrow('OpenCode');
    expect(fs.existsSync(trace)).toBe(false);
    fs.unlinkSync(failed);
    await getLocalCliRuntimeOptions(cli, dir);
    expect(JSON.parse(fs.readFileSync(trace, 'utf8'))).toEqual(expected);
  });

  it('kills an oversized catalog and returns only sanitized partial metadata', async () => {
    const dir = makeTempDir();
    const binPath = writeFakeCli(dir, `
const args = process.argv.slice(2);
if (args[0] === 'models') {
  process.stdout.write('PRIVATE_TOKEN_SHOULD_NOT_ESCAPE\\n' + 'A'.repeat(1024 * 1024 + 4096));
} else if (args[0] === 'run' && args.includes('--help')) {
  process.stdout.write('Usage: fake run --model <id> --variant <name>\\n');
} else {
  process.exitCode = 2;
}
`);

    const options = await getLocalCliRuntimeOptions(entry('opencode', binPath), dir);

    expect(options).toMatchObject({
      status: 'partial',
      models: [],
      can_select_model: true,
      can_select_thinking: true,
      allow_custom_model: true,
      allow_custom_thinking: true,
    });
    const serialized = JSON.stringify(options);
    expect(serialized).not.toContain('PRIVATE_TOKEN_SHOULD_NOT_ESCAPE');
    expect(serialized).not.toMatch(/stdout|stderr|path/i);
  }, 10_000);
});


describe('task-command help capabilities', () => {
  it('accepts documented option syntax and excludes prose/other-option descriptions', async () => {
    const { parseCliHelpFlags } = await import('../../../../src/main/features/local_agents/runtime_options');
    expect(parseCliHelpFlags([
      'Usage: cli run --format <format>',
      '  -m, --model <id>  Select a model; deprecated --old-model is not supported.',
      '  --effort=<level>  Reasoning level',
      'This release does not support --variant.',
      '  See --thinking in the other command.',
    ].join('\n'))).toEqual(['--format', '--model', '--effort']);
  });
});
