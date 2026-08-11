import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const PC_ROOT = path.resolve(__dirname, '../../..');
const RUN_SKILL = path.join(PC_ROOT, 'bin', 'run-skill.cjs');
const SKILL_DIR = path.join(
  PC_ROOT,
  'resources',
  'builtin',
  'marketplace',
  'skills',
  'ee99fbb42964',
);

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-deep-research-scripts-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeJson(name: string, value: unknown): string {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, JSON.stringify(value), 'utf8');
  return file;
}

function runScript(script: string, args: string[]) {
  return spawnSync(process.execPath, [RUN_SKILL, 'deep-research', script, '--', ...args], {
    cwd: tmpDir,
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      ORKAS_PC_DIR: PC_ROOT,
      ORKAS_RUN_SKILL_DIR: SKILL_DIR,
      ORKAS_WORKSPACE_ROOT: tmpDir,
    },
  });
}

describe('DeepResearch bundled Skill scripts through run-skill.cjs', () => {
  it('plans caps from workspace-relative input and writes workspace-relative output', () => {
    writeJson('caps_input.json', {
      depth: 1,
      subquestions: [
        'What is the current policy?',
        'What is the current policy?',
        'How should teams implement it?',
        'What evidence is required?',
      ],
      caps: {
        max_subquestions: 2,
        max_fetches: 6,
        max_fetches_per_subquestion: 4,
        max_depth: 2,
      },
    });

    const result = runScript('caps', [
      '--op', 'plan',
      '--input', 'caps_input.json',
      '--out', 'caps_plan.json',
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const output = JSON.parse(fs.readFileSync(path.join(tmpDir, 'caps_plan.json'), 'utf8'));
    expect(output.ok).toBe(true);
    expect(output.data.subquestions).toEqual([
      'What is the current policy?',
      'How should teams implement it?',
    ]);
    expect(output.data.fetch_budget_per_subquestion).toBe(3);
    expect(output.data.dropped.duplicates).toEqual(['What is the current policy?']);
    expect(output.data.dropped.over_cap).toEqual(['What evidence is required?']);
  });

  it('compresses workspace evidence under the requested hard character budget', () => {
    writeJson('compress_input.json', {
      query: 'enterprise privacy controls',
      max_chars: 240,
      sources: [
        {
          id: 'official',
          text: 'Enterprise privacy controls include encryption, audit logging, data retention settings, and administrator policy enforcement. '.repeat(4),
        },
        {
          id: 'noise',
          text: 'Unrelated marketing copy about colors, slogans, events, and general announcements. '.repeat(4),
        },
      ],
    });

    const result = runScript('compress', [
      '--input', 'compress_input.json',
      '--out', 'compress_output.json',
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const output = JSON.parse(fs.readFileSync(path.join(tmpDir, 'compress_output.json'), 'utf8'));
    expect(output.ok).toBe(true);
    expect(output.data.stats.chars_out).toBeLessThanOrEqual(240);
    expect(output.data.kept.length).toBeGreaterThan(0);
    expect(JSON.stringify(output.data.kept)).toContain('privacy controls');
  });

  it('verifies exact fetched evidence and writes delivery-ready citation output', () => {
    const exactQuote = 'The product supports Windows and Linux installations with enterprise privacy controls.';
    writeJson('citations_input.json', {
      sources: [{
        id: 'official',
        title: 'Official deployment guide',
        url: 'https://example.test/deployment',
        date: '2026-08-01',
        accessed_at: '2026-08-08',
        text: exactQuote,
      }],
      claims: [{
        text: 'The product supports Windows and Linux with enterprise privacy controls.',
        citations: [{ source: 'official', quote: exactQuote }],
      }],
    });

    const result = runScript('citations', [
      '--op', 'verify',
      '--input', 'citations_input.json',
      '--out', 'citations_output.json',
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const output = JSON.parse(fs.readFileSync(path.join(tmpDir, 'citations_output.json'), 'utf8'));
    expect(output.ok).toBe(true);
    expect(output.data.summary).toMatchObject({
      claims: 1,
      supported: 1,
      verified: 1,
      flagged: 0,
    });
    expect(output.data.evidence_rows).toEqual([
      expect.objectContaining({
        evidence_id: 'E1',
        source_id: 'official',
        quote: exactQuote,
        verification: 'verified',
      }),
    ]);
    expect(output.data.evidence_markdown).toContain('E1');
    expect(output.data.evidence_markdown).toContain('Official deployment guide');
  });

  it('loads the academic entrypoint and reports an unknown provider without making a network call', () => {
    const result = runScript('academic', [
      '--op', 'search',
      '--query', 'offline entrypoint check',
      '--sources', 'not-a-provider',
      '--out', 'academic_output.json',
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const output = JSON.parse(fs.readFileSync(path.join(tmpDir, 'academic_output.json'), 'utf8'));
    expect(output).toEqual({
      ok: true,
      data: {
        query: 'offline entrypoint check',
        sources_queried: [],
        count: 0,
        results: [],
        errors: [{ source: 'not-a-provider', error: 'unknown source' }],
      },
    });
  });

  it('fails closed on malformed workspace input without writing an output file', () => {
    fs.writeFileSync(path.join(tmpDir, 'caps_input.json'), '{not-json', 'utf8');

    const result = runScript('caps', [
      '--op', 'plan',
      '--input', 'caps_input.json',
      '--out', 'caps_plan.json',
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr.trim())).toMatchObject({ ok: false });
    expect(fs.existsSync(path.join(tmpDir, 'caps_plan.json'))).toBe(false);
  });
});
