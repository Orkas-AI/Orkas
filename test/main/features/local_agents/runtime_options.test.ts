import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
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
    expect(first.models.map(model => model.id)).toEqual(['sonnet', 'opus', 'haiku']);
    expect(first.models).toEqual([
      { id: 'sonnet', label: 'Sonnet', is_alias: true },
      { id: 'opus', label: 'Opus', is_alias: true },
      { id: 'haiku', label: 'Haiku', is_alias: true },
    ]);
    expect(second).toBe(first);
    expect(refreshed).not.toBe(first);
    expect(fs.readFileSync(counter, 'utf8')).toBe('11');
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
