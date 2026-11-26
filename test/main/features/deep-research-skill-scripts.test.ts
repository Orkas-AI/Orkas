import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { webFetchTool } from '../../../src/core-agent/src/tools/web-fetch';
import { captureDeepResearchWebFetchEvidence } from '../../../src/main/model/core-agent/deep-research-evidence';

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
  vi.unstubAllGlobals();
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
  it.each(['application/json', 'text/plain'])('verifies a quote from a successful %s fetch without changing its body', async (contentType) => {
    const quote = 'Offline use requires an initial model download.';
    const body = contentType === 'application/json' ? JSON.stringify({ fact: quote }) : quote;
    const url = 'https://example.test/official-guide';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, {
      headers: { 'content-type': contentType },
    })));
    const fetched = await webFetchTool.execute({ url }, { state: {} });
    expect(fetched.isError).not.toBe(true);
    expect(fetched.content).toBe(contentType === 'application/json'
      ? JSON.stringify({ fact: quote }, null, 2) : body);
    captureDeepResearchWebFetchEvidence(fetched, path.join(tmpDir, 'source-snapshots.jsonl'));
    fs.writeFileSync(path.join(tmpDir, 'evidence_ledger.jsonl'), JSON.stringify({
      id: 'E1', source_id: 'S1', candidate: 'Example app', field: 'local_offline',
      claim: quote, quote, canonical_url: url,
    }) + '\n');
    writeJson('citations_input.json', { compact_landscape: {
      title: 'Offline availability', boundary: 'Controlled official source.',
      analysis_markdown: 'Offline availability is conditional on the initial download [E1].',
      candidates: [{ candidate: 'Example app', best_for: 'Conditional offline use', ideal_user: 'Local user' }],
    } });
    const result = runScript('citations', [
      '--op', 'verify', '--input', 'citations_input.json', '--out', 'citations_output.json',
      '--report-out', 'RESEARCH-offline.md',
    ]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const output = JSON.parse(fs.readFileSync(path.join(tmpDir, 'citations_output.json'), 'utf8')).data;
    expect(output.summary).toMatchObject({ verified: 1, flagged: 0 });
    expect(output.comparison_coverage[0].fields_with_citations).toEqual(['local_offline']);
    const report = fs.readFileSync(path.join(tmpDir, 'RESEARCH-offline.md'), 'utf8');
    expect(report).toContain(quote);
    expect(report).toContain('E1');
  });

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
      caps_reason: 'The user asked for a quick check of at most six sources.',
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
    expect(output.data.caps_reason).toBe('The user asked for a quick check of at most six sources.');
  });

  it('refuses lowered fetch caps without a reason and writes no plan', () => {
    // The 2026-10-02 "detailed research" run chose 12/5 with no budget behind it.
    writeJson('caps_input.json', {
      depth: 1,
      subquestions: ['Name and demonstrations', 'Spatial optimization', 'Evaluation'],
      caps: { max_fetches: 12, max_fetches_per_subquestion: 5 },
    });

    const result = runScript('caps', [
      '--op', 'plan',
      '--input', 'caps_input.json',
      '--out', 'caps_plan.json',
    ]);

    expect(result.status).toBe(1);
    const error = JSON.parse(result.stderr.trim());
    expect(error.ok).toBe(false);
    expect(error.error).toContain('max_fetches 12, max_fetches_per_subquestion 5');
    expect(error.error).toContain('max_fetches 40, max_fetches_per_subquestion 8');
    expect(error.error).toContain('caps_reason');
    expect(fs.existsSync(path.join(tmpDir, 'caps_plan.json'))).toBe(false);
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
      verified: 1,
      flagged: 0,
    });
    expect(output.data.evidence_rows).toEqual([
      expect.objectContaining({
        evidence_id: 'E1',
        source_id: 'official',
        quote: exactQuote,
        quote_status: 'verified',
      }),
    ]);
    expect(output.data.evidence_markdown).toContain('E1');
    expect(output.data.evidence_markdown).toContain('Official deployment guide');
    expect(output.data.comparison_coverage).toEqual([
      expect.objectContaining({
        candidate: 'Example product',
        fields_with_citations: ['os'],
      }),
    ]);
    expect(output.data).not.toHaveProperty('recommendation_markdown');
    expect(output.data.claims[0]).not.toHaveProperty('supported');
    const stdout = JSON.parse(result.stdout);
    expect(stdout.comparison_coverage_details[0]).toMatchObject({
      candidate: 'Example product',
      fields_with_citations: ['os'],
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
    fs.appendFileSync(path.join(tmpDir, 'evidence_ledger.jsonl'), '{broken\nnull\n', 'utf8');
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
        analysis_markdown: '## Recommendations\n\nChoose local use only with sufficient memory [E6].',
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
      ledger_diagnostics: {
        nonempty_lines: 8,
        reason_counts: { invalid_json: 1, non_object: 1 },
        samples: [{ line: 7, reason: 'invalid_json' }, { line: 8, reason: 'non_object' }],
        omitted_samples: 0,
      },
    });
    expect(stdout.report).toMatchObject({ path: 'RESEARCH-REPORT.md' });
    expect(stdout).not.toHaveProperty('comparison_markdown');
    expect(stdout).not.toHaveProperty('evidence_markdown');

    // Python text output uses native newlines; the contract is Markdown content.
    const report = fs.readFileSync(path.join(tmpDir, 'RESEARCH-REPORT.md'), 'utf8').replace(/\r\n/g, '\n');
    expect(report).toContain('# Example desktop-app comparison');
    expect(report).toContain('## Recommendations\n\nChoose local use only with sufficient memory [E6].');
    expect(report).not.toContain('material limitation:');
    expect(report).toContain('| Candidate | Best for |');
    expect(report).toContain('## Evidence used');
    expect(report).not.toContain('invalid_json');
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

it('executes the packaged research script through a freshly seeded native read binding', async () => {
  const previousRoot = process.env.ORKAS_WORKSPACE_ROOT, previousBuiltin = process.env.ORKAS_BUILTIN_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = path.join(tmpDir, 'runtime');
  process.env.ORKAS_BUILTIN_ROOT = path.join(PC_ROOT, 'resources/builtin');
  vi.resetModules();
  try {
    const uid = 'research-script-binding-fixture';
    (await import('../../../src/main/features/users')).activateUser(uid);
    await (await import('../../../src/main/features/builtin_marketplace')).seedBuiltinMarketplaceForUser(uid);
    (await import('../../../src/main/features/permissions')).setLocalExecMode('all_files_auto');
    const bindings = new Map();
    await (await import('../../../src/main/model/core-agent/skill-registry')).getSystemPromptBlock({
      agentId: '78900d8758bc', allowlist: ['ee99fbb42964'], runtimeBindings: bindings,
    });
    const [ref, binding] = [...bindings.entries()].find(([, value]) => value.id === 'ee99fbb42964')!;
    expect(binding).toBeTruthy();
    const script = path.join(binding.root, 'scripts/caps.py');
    expect(fs.readFileSync(script)).toEqual(fs.readFileSync(path.join(SKILL_DIR, 'scripts/caps.py')));
    const context = { workingDir: tmpDir, state: { sandboxEnv: {
      ORKAS_NODE: process.env.ORKAS_TEST_NODE!, ORKAS_PC_DIR: PC_ROOT, ORKAS_UID: uid,
      ORKAS_WORKSPACE_ROOT: process.env.ORKAS_WORKSPACE_ROOT!, ORKAS_PYTHON: process.env.ORKAS_TEST_PYTHON || path.resolve(PC_ROOT, '../venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    } } } as any;
    const reader = (await import('../../../src/main/model/core-agent/file-tools')).createFileTools({userId:uid, skillRuntimeBindings:bindings})
      .find(tool => tool.name === 'read_files')!;
    const read = await reader.execute({paths:[{path:'@skill/'+ref}]},context);
    expect(read.isError).toBeFalsy();
    const template = read.content.match(/```(?:sh|powershell)\n([^\n]+)\n```/)?.[1];
    expect(template).toBeTruthy();
    const bash = (await import('../../../src/main/model/core-agent/local-tools')).createLocalTools({userId:uid, skillRuntimeBindings:bindings})
      .find(tool => tool.name === 'bash')!;
    const result = await bash.execute({command:template!.replace('<script-basename> -- <args...>','caps -- --help'),timeoutMs:10000},context);
    expect(result.isError, result.content).toBeFalsy();
    expect(result.content).toContain('deep-research/caps');
    const originalScript = fs.readFileSync(script);
    expect(originalScript).toEqual(fs.readFileSync(path.join(SKILL_DIR, 'scripts/caps.py')));
    fs.unlinkSync(script);
    const missing = await bash.execute({command:template!.replace('<script-basename> -- <args...>','caps -- --help'),timeoutMs:10000},context);
    expect(missing.isError).toBe(true);
    expect(missing.content).toContain('skill script not found');
    expect(fs.readFileSync(path.join(SKILL_DIR, 'scripts/caps.py'))).toEqual(originalScript);
    fs.writeFileSync(script, originalScript);
  } finally {
    if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT; else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
    if (previousBuiltin === undefined) delete process.env.ORKAS_BUILTIN_ROOT; else process.env.ORKAS_BUILTIN_ROOT = previousBuiltin;
    vi.resetModules();
  }
}, 30000);
