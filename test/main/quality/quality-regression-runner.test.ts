import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  discoverUserDirectories,
  parseQualityRegressionArgs,
  qualityModuleUrl,
  runQualityRegression,
} from '../../../scripts/quality-regression.mjs';

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-quality-regression-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function makeSpec(relativePath: string): string {
  const directory = path.join(root, 'data', relativePath);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

describe('Agent and Skill quality regression runner', () => {
  it('parses an explicit data root and rejects ambiguous CLI input', () => {
    expect(parseQualityRegressionArgs([], { homeDirectory: root })).toEqual({
      dataRoot: path.join(root, '.orkas', 'data'),
    });
    expect(parseQualityRegressionArgs(
      ['--orkas-data', './relative-data'],
      { homeDirectory: root },
    )).toEqual({ dataRoot: path.resolve('./relative-data') });
    expect(() => parseQualityRegressionArgs(['--orkas-data'], { homeDirectory: root }))
      .toThrow('--orkas-data requires a path');
    expect(() => parseQualityRegressionArgs(['--unknown'], { homeDirectory: root }))
      .toThrow('unknown argument');
  });

  it('decodes a script URL before resolving the TypeScript validator path', () => {
    const script = pathToFileURL(
      path.join(root, 'workspace with spaces', 'PC', 'scripts', 'quality-regression.mjs'),
    ).href;

    expect(fileURLToPath(qualityModuleUrl(script))).toBe(path.join(
      root,
      'workspace with spaces',
      'PC',
      'src',
      'main',
      'quality',
      'index.ts',
    ));
  });

  it('discovers only user roots in stable order', () => {
    const dataRoot = path.join(root, 'data');
    for (const name of ['user-z', 'logs', '.cache', 'user-a', 'user_workspaces']) {
      fs.mkdirSync(path.join(dataRoot, name), { recursive: true });
    }

    expect(discoverUserDirectories(dataRoot)).toEqual([
      path.join(dataRoot, 'user-a'),
      path.join(dataRoot, 'user-z'),
    ]);
  });

  it('scans every source with the right runner policy and continues after one validator fault', () => {
    const dataRoot = path.join(root, 'data');
    makeSpec('user-a/cloud/skills/b-medium');
    makeSpec('user-a/cloud/skills/z-throws');
    makeSpec('user-a/local/marketplace/skills/m-clean');
    makeSpec('user-a/cloud/agents/a-extreme');
    makeSpec('user-a/local/marketplace/agents/x-clean');
    const print = vi.fn();
    const validateSkillDir = vi.fn((directory: string) => {
      if (directory.endsWith('z-throws')) throw new Error('injected local path');
      if (directory.endsWith('b-medium')) {
        return { violations: [{ level: 'MEDIUM', rule: 'cleanup' }] };
      }
      return { violations: [] };
    });
    const validateAgentDir = vi.fn((directory: string) => (
      directory.endsWith('a-extreme')
        ? {
            violations: [{
              level: 'EXTREME',
              rule: 'unsafe',
              field: 'agent.json',
              snippet: 'unsafe snippet',
            }],
          }
        : { violations: [] }
    ));

    const result = runQualityRegression({
      dataRoot,
      print,
      printError: vi.fn(),
      validateAgentDir,
      validateSkillDir,
    });

    expect(result).toEqual({
      code: 1,
      failed: 2,
      totalAgents: 2,
      totalSkills: 3,
    });
    expect(validateSkillDir.mock.calls.map(([directory, options]) => [
      path.basename(directory),
      options.enforceSkillRunner,
    ])).toEqual([
      ['b-medium', true],
      ['z-throws', true],
      ['m-clean', false],
    ]);
    expect(validateAgentDir.mock.calls.map(([directory, options]) => [
      path.basename(directory),
      options.enforceSkillRunner,
    ])).toEqual([
      ['a-extreme', true],
      ['x-clean', false],
    ]);
    expect(print).toHaveBeenCalledWith('✗ [custom-skill] z-throws — validator_error');
    expect(print).toHaveBeenCalledWith('✓ [marketplace-agent] x-clean');
    expect(JSON.stringify(print.mock.calls)).not.toContain('injected local path');
  });

  it('returns an infrastructure exit code for a missing or unreadable data root', () => {
    const printError = vi.fn();
    expect(runQualityRegression({
      dataRoot: path.join(root, 'missing'),
      print: vi.fn(),
      printError,
      validateAgentDir: vi.fn(),
      validateSkillDir: vi.fn(),
    })).toEqual({
      code: 2,
      failed: 0,
      totalAgents: 0,
      totalSkills: 0,
    });
    expect(printError).toHaveBeenCalledWith(expect.stringContaining('Data root not found'));
  });

  it('treats a malformed validator result as a failed spec without skipping the next one', () => {
    const dataRoot = path.join(root, 'data');
    makeSpec('user-a/cloud/skills/a-malformed');
    makeSpec('user-a/cloud/skills/b-clean');
    const print = vi.fn();
    const validateSkillDir = vi.fn((directory: string) => (
      directory.endsWith('a-malformed') ? {} : { violations: [] }
    ));

    expect(runQualityRegression({
      dataRoot,
      print,
      printError: vi.fn(),
      validateAgentDir: vi.fn(),
      validateSkillDir,
    })).toMatchObject({
      code: 1,
      failed: 1,
      totalSkills: 2,
    });
    expect(print).toHaveBeenCalledWith('✗ [custom-skill] a-malformed — validator_error');
    expect(print).toHaveBeenCalledWith('✓ [custom-skill] b-clean');
  });
});
