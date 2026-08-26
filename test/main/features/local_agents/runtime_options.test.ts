import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  mapClaudeModelList,
  mapCodexModelList,
  mapOpenclawModels,
  parseBannerJson,
  parseHermesDefaultModel,
  parseOpenCodeModels,
  getLocalCliRuntimeOptions,
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
    expect(result.models[0]).toEqual({
      id: 'opus[1m]',
      label: 'Opus (1M context)',
      is_alias: true,
      thinking_levels: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }, { id: 'xhigh' }, { id: 'max' }],
    });
    // A pinned model id keeps its version, so it is not an alias; the context
    // variant suffix alone must not make it look like one.
    expect(result.models[1]).toMatchObject({ id: 'claude-fable-5[1m]', label: 'Fable' });
    expect(result.models[1].is_alias).toBeUndefined();
    // Haiku advertises no effort support, so it takes no thinking level at all
    // rather than inheriting the levels its siblings advertise.
    expect(result.models[3]).toEqual({
      id: 'haiku', label: 'Haiku', is_alias: true, supports_thinking: false,
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
        { id: 'sonnet', label: 'Sonnet', is_alias: true },
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
  it('reuses the bounded cache unless the caller explicitly refreshes it', async () => {
    const dir = makeTempDir();
    const counter = path.join(dir, 'counter.txt');
    const binPath = writeFakeCli(dir, `
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(counter)}, '1');
if (process.argv.includes('--help')) {
  process.stdout.write('Usage: fake --model <id> --effort <level>\\n');
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
  process.stdout.write('Usage: fake --model <id> --effort <level>\\n');
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
    // out because the empty override already means it.
    expect(options.models).toEqual([
      {
        id: 'newest',
        label: 'Newest',
        is_alias: true,
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
