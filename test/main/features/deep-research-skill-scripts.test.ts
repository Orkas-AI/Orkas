import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
      ORKAS_DEEP_RESEARCH_EVIDENCE_FILE: path.join(tmpDir, 'source-snapshots.jsonl'),
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
        id: 'deployment',
        text: 'The product supports Windows and Linux with enterprise privacy controls.',
        citations: [{ source: 'official', quote: exactQuote }],
      }],
      comparison: [{
        candidate: 'Example product',
        best_for: 'Managed desktop deployment',
        os: 'The product supports Windows and Linux installations',
        setup_ease: 'Not verified',
        model_capabilities: 'Not verified',
        local_offline: 'Not verified',
        privacy_data_handling: 'Not verified',
        pricing_cost: 'Not verified',
        key_limitations: 'Not verified',
        ideal_user: 'Enterprise desktop user',
        evidence_sources: ['official'],
        field_claims: { os: ['deployment'] },
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
    expect(output.data.comparison_coverage).toEqual([
      expect.objectContaining({
        candidate: 'Example product',
        status: 'under_evidenced',
        recommendation_ready: false,
        missing_decision_groups: [
          'platform_and_setup',
          'model_capabilities',
          'privacy_or_offline',
          'pricing',
          'limitations',
        ],
      }),
    ]);
    expect(output.data.recommendation_markdown).toContain(
      'Conditional path — **Managed desktop deployment: Example product**',
    );
    expect(output.data.recommendation_markdown).toContain('verify before choosing:');
    for (const gap of [
      'platform and setup',
      'model capabilities',
      'privacy or offline',
      'pricing',
      'limitations',
    ]) {
      expect(output.data.recommendation_markdown).toContain(gap);
    }
    const stdout = JSON.parse(result.stdout);
    expect(stdout.comparison_coverage_details[0]).toMatchObject({
      candidate: 'Example product',
      status: 'under_evidenced',
    });
  });

  it('builds a compact landscape report directly from field-tagged evidence', () => {
    const claims = {
      os: 'The desktop app supports Windows and macOS.',
      setup_ease: 'The desktop app provides a signed installer.',
      model_capabilities: 'The desktop app supports local language models.',
      local_offline: 'The desktop app runs fully offline after setup.',
      pricing_cost: 'The desktop app is free for personal use.',
      key_limitations: 'The desktop app requires sixteen gigabytes of memory.',
    };
    fs.writeFileSync(
      path.join(tmpDir, 'evidence_ledger.jsonl'),
      Object.entries(claims).map(([field, claim], index) => JSON.stringify({
        id: `claim_${index + 1}`,
        candidate: 'Example desktop app',
        field,
        source_id: 'official',
        url: 'https://example.test/desktop-app',
        title: 'Official desktop app guide',
        source_date: '2026-08-20',
        accessed_at: '2026-08-20',
        quote: claim,
        claim,
        limitations: 'Official product source only.',
      })).join('\n') + '\n',
      'utf8',
    );
    const sourceText = Object.values(claims).join('\n');
    fs.writeFileSync(
      path.join(tmpDir, 'source-snapshots.jsonl'),
      `${JSON.stringify({
        schema_version: 1,
        canonical_url: 'https://example.test/desktop-app',
        captured_at: '2026-08-20T00:00:00.000Z',
        content_sha256: createHash('sha256').update(sourceText, 'utf8').digest('hex'),
        text: sourceText,
      })}\n`,
      'utf8',
    );
    writeJson('citations_input.json', {
      compact_landscape: {
        title: 'Example desktop-app comparison',
        boundary: 'Official evidence accessed on 2026-08-20.',
        candidates: [{
          candidate: 'Example desktop app',
          best_for: 'Everyday private use',
          ideal_user: 'Everyday desktop user',
        }],
      },
    });

    const result = runScript('citations', [
      '--op', 'verify',
      '--input', 'citations_input.json',
      '--out', 'citations_output.json',
      '--report-out', 'RESEARCH-REPORT.md',
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const stdout = JSON.parse(result.stdout);
    expect(stdout.compact_landscape_expansion).toMatchObject({
      enabled: true,
      selected_evidence_rows: 6,
      candidate_rows: 1,
    });
    expect(stdout.report).toMatchObject({ path: 'RESEARCH-REPORT.md' });
    expect(stdout).not.toHaveProperty('comparison_markdown');
    expect(stdout).not.toHaveProperty('evidence_markdown');

    const report = fs.readFileSync(path.join(tmpDir, 'RESEARCH-REPORT.md'), 'utf8');
    expect(report).toContain('# Example desktop-app comparison');
    expect(report).toContain('## Recommendations');
    expect(report).toContain('| Candidate | Best for |');
    expect(report).toContain('## Evidence used');
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
