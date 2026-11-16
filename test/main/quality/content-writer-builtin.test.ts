import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { validateAgentDir, validateSkillDir } from '../../../src/main/quality';
import { SkillLoader } from '../../../src/core-agent/src/skills/loader';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const builtinMarketplaceRoot = path.join(repoRoot, 'resources', 'builtin', 'marketplace');
const agentDir = path.join(builtinMarketplaceRoot, 'agents', '173d4235a431');
const skillDir = path.join(builtinMarketplaceRoot, 'skills', '9dfbd4e00c0d');

describe('ContentWriter builtin contract', () => {
  it('accepts requested planning artifacts while rejecting execution-status substitutes in the real handoff', async () => {
    const spec = JSON.parse(fs.readFileSync(path.join(agentDir, 'agent.json'), 'utf8'));
    const boundary = spec.standards[4];
    expect(boundary).toMatch(/execution plans or status updates.*cannot substitute/i);
    expect(boundary).toMatch(/requested outlines, content plans and calendars.*valid artifacts/i);
    expect(boundary).toMatch(/completion summary.*not an artifact/i);
    const { normalizeAgent } = await import('../../../src/main/features/agents');
    const { _buildAgentInGroupSystemPromptForTest } = await import('../../../src/main/features/group_chat/bus');
    const prompt = await _buildAgentInGroupSystemPromptForTest(normalizeAgent(spec, 'builtin')!, '/test/content-plan', 'en');
    expect(prompt.split(boundary)).toHaveLength(2);
    expect(prompt).not.toContain('A plan or status update is not an artifact');
    expect(prompt).toContain('A content calendar is a writing artifact');
  });

  it('ships every former social capability with the editorial owner for offline use', () => {
    const spec = JSON.parse(fs.readFileSync(path.join(agentDir, 'agent.json'), 'utf8'));
    const expected = new Map([
      ['9dfbd4e00c0d', 'content-writer'],
      ['de1fe2e2c26a', 'social-publish'],
    ]);
    const loaded = new SkillLoader({ dirs: [path.join(builtinMarketplaceRoot, 'skills')] }).list();
    for (const [id, name] of expected) {
      expect(spec.skill_list).toContain(id);
      const dir = path.join(builtinMarketplaceRoot, 'skills', id);
      const entry = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
      expect(entry).toMatch(new RegExp(`^name: ${name}$`, 'm'));
      expect(spec.workflow).toContain(`\`${name}\``);
      expect(loaded.find(skill => skill.id === id)?.name).toBe(name);
      expect(validateSkillDir(dir).ok).toBe(true);
      const meta = JSON.parse(fs.readFileSync(path.join(dir, '_meta.json'), 'utf8'));
      expect(meta.version).toMatch(/^\d+\.\d+\.\d+$/);
    }
    expect(spec.skill_list).not.toContain('fb79ebe322c7');
    expect(spec.workflow).not.toContain('`social-writer`');
    const publish = fs.readFileSync(path.join(builtinMarketplaceRoot, 'skills/de1fe2e2c26a/SKILL.md'), 'utf8');
    expect(publish).toContain('The final publish action must be performed manually by the user.');
    expect(publish).toContain('preserve original content; do not silently rewrite.');
    expect(spec.workflow).toMatch(/Only for explicitly requested platform preparation/);
    expect(spec.inputs.find((input: any) => input.id === 'files').accept).toContain('image/*,video/*');
  });

  it('ships from the packaged builtin marketplace paths', () => {
    expect(fs.existsSync(path.join(agentDir, 'agent.json'))).toBe(true);
    expect(fs.existsSync(path.join(skillDir, 'SKILL.md'))).toBe(true);
  });

  it('uses one writing pipeline with platform craft and calendar/reply extensions', () => {
    const skill = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
    const modes = [...skill.matchAll(/^\| `([^`]+)` \|/gm)].map(match => match[1]);
    expect(modes).toEqual(['plan', 'research', 'draft', 'revise', 'humanize', 'audit', 'adapt', 'calendar', 'respond']);
    const formats = fs.readFileSync(path.join(skillDir, 'references/content-formats.md'), 'utf8');
    const programs = fs.readFileSync(path.join(skillDir, 'references/content-programs.md'), 'utf8');
    expect(skill).toMatch(/calendar.*respond[\s\S]*references\/content-programs\.md/);
    expect(skill).not.toMatch(/Do not use it for social calendars/);
    expect(skill).toMatch(/same brief, evidence policy/);
    for (const platform of ['Xiaohongshu', 'WeChat', 'Zhihu', 'Douyin', 'Kuaishou', 'Bilibili', 'Weibo', 'LinkedIn', 'Instagram', 'TikTok']) {
      expect(formats).toContain(platform);
    }
    expect(formats).toContain('complete revised draft');
    expect(formats).toContain('plain text');
    expect(programs).toContain('a table of topics is not a substitute');
    expect(programs).toContain('low, medium, high, critical');
    expect(programs).toContain('coordinated attack');
    expect(programs).toContain('do not promise refunds');
    expect(programs).toContain('does not authorize scheduling');
  });

  it('keeps the packaged agent and skill identities aligned', () => {
    const agent = JSON.parse(fs.readFileSync(path.join(agentDir, 'agent.json'), 'utf8'));
    const skillMeta = JSON.parse(fs.readFileSync(path.join(skillDir, '_meta.json'), 'utf8'));

    expect(agent.agent_id).toBe('173d4235a431');
    expect(agent.name).toBe('ContentWriter');
    expect(agent.skill_list).toEqual(['9dfbd4e00c0d', 'de1fe2e2c26a', 'de52c67d49dd']);
    expect(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8')).toContain('name: content-writer');
    expect(agent.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(skillMeta.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('keeps the agent brief-led, evidence-gated, and publication-honest', () => {
    const spec = JSON.parse(fs.readFileSync(path.join(agentDir, 'agent.json'), 'utf8')) as any;

    expect(spec.agent_id).toBe('173d4235a431');
    expect(spec.name).toBe('ContentWriter');
    expect(spec.min_app_version).toBeUndefined();
    expect(spec.skill_list).toEqual(['9dfbd4e00c0d', 'de1fe2e2c26a', 'de52c67d49dd']);
    expect(spec).not.toHaveProperty('delivery_checks');
    expect(spec.interactive).toBe(false);
    expect(spec.inputs.find((input: any) => input.id === 'task')?.required).toBe(true);
    expect(spec.inputs.find((input: any) => input.id === 'files')?.multiple).toBe(true);
    expect(spec.inputs.map((input: any) => input.id)).toEqual(['task', 'files']);
    expect(spec.description_zh).toMatch(/文案/);
    expect(spec.description_zh).toMatch(/社媒/);
    expect(spec.description_en).toContain('social');
    const standards = spec.standards.join('\n');
    expect(standards).toMatch(/audience|reader/i);
    expect(standards).toMatch(/language.*tone.*length/i);
    expect(standards).toMatch(/claims.*supported|supported.*claims/i);
    expect(standards).toMatch(/revisions preserve.*scope.*certainty.*citations.*disclosures/i);
    expect(standards).toMatch(/voice/i);
    expect(standards).not.toMatch(/manage_execution_plan|population, exposure or intervention/i);
    expect(spec.standards.join('\n')).toContain('completion summary is not an artifact');
    expect(spec.standards.join('\n')).not.toMatch(/20\s*[-–]\s*100|SaaS|remote collaboration/i);
    expect(spec.workflow).toMatch(/intended use[\s\S]*editorial.*social[\s\S]*product-commerce/i);

    expect(spec.workflow).not.toContain('instead of persisting or publishing');
    expect(spec.workflow.length).toBeLessThanOrEqual(1_800);
    for (const marker of [
      'Read `content-writer` as the governing Skill',
      'smallest applicable mode sequence',
      'Return the requested artifact in the current turn',
      'Audit material claims, citations, disclosures, and the requested format',
    ]) {
      expect(spec.workflow, marker).toContain(marker);
    }

    const report = validateAgentDir(agentDir);
    expect(report.ok, JSON.stringify(report.violations, null, 2)).toBe(true);
    expect(report.violations).toEqual([]);

    const meta = JSON.parse(fs.readFileSync(path.join(agentDir, '_meta.json'), 'utf8'));
    expect(Date.parse(meta.reseed_if_deleted_before)).not.toBeNaN();
  });

  it('keeps the official Skill bilingual with one description source and routes every progressive reference', () => {
    const skill = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
    const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
    const frontmatterKeys = frontmatter.split('\n')
      .map((line) => line.match(/^([a-z_]+):/)?.[1])
      .filter(Boolean);
    expect(frontmatterKeys).toEqual(['name', 'description_zh', 'description_en']);
    expect(skill.length).toBeLessThan(15_000);

    const actualReferences = fs.readdirSync(path.join(skillDir, 'references'))
      .filter((file) => file.endsWith('.md'))
      .sort();
    const routedReferences = [...skill.matchAll(/\(references\/([^)]+\.md)\)/g)]
      .map((match) => match[1])
      .filter((file, index, files) => files.indexOf(file) === index)
      .sort();
    expect(routedReferences).toEqual(actualReferences);

    const meta = JSON.parse(fs.readFileSync(path.join(skillDir, '_meta.json'), 'utf8'));
    expect(meta.min_app_version).toBeUndefined();
    expect(Date.parse(meta.reseed_if_deleted_before)).not.toBeNaN();
    expect(meta.category).toBe('creation');
    expect(meta.descriptions).toBeUndefined();
    expect(meta.routing.applicable_domain.length).toBeGreaterThan(0);
    expect(meta.routing.negative_examples.length).toBeGreaterThan(0);
    expect(Array.isArray(meta.routing.prerequisites)).toBe(true);

    const report = validateSkillDir(skillDir);
    expect(report.ok, JSON.stringify(report.violations, null, 2)).toBe(true);
    expect(report.violations).toEqual([]);
  });

  it('keeps the editorial modes and evidence/edit/publication contracts across formats', () => {
    const skill = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
    const formats = fs.readFileSync(path.join(skillDir, 'references', 'content-formats.md'), 'utf8');
    const research = fs.readFileSync(
      path.join(skillDir, 'references', 'research-and-evidence.md'),
      'utf8',
    );
    const editorial = fs.readFileSync(
      path.join(skillDir, 'references', 'editorial-quality.md'),
      'utf8',
    );
    const audit = fs.readFileSync(
      path.join(skillDir, 'references', 'audit-and-delivery.md'),
      'utf8',
    );
    const bundle = [skill, research, editorial, formats, audit].join('\n');
    for (const mode of ['plan', 'research', 'draft', 'revise', 'humanize', 'audit', 'adapt']) {
      expect(skill).toContain(`\`${mode}\``);
    }
    for (const policy of ['supplied-only', 'source-grounded', 'current-research', 'prose-only']) {
      expect(skill).toContain(`\`${policy}\``);
    }
    expect(skill).toContain("Match evidence work to the user's citation request and claim risk");
    expect(skill).toContain('require a matrix only for research-backed');
    expect(skill).toContain('without forced source gaps');
    expect(skill).toContain('In plan, label Reader');
    expect(skill).toContain('Format/type, Tone, Working assumptions');
    expect(skill).toContain('unsupplied premises or none');
    expect(skill).toMatch(/ordinary social.*editorial.*platform is optional/i);
    expect(skill).toContain('never ask for it or offer choices');
    expect(skill).toContain('Before returning a plan, audit titles, headings, assumptions, examples, and bullets');
    expect(skill).toContain('Input ranges define scope only');
    expect(skill).toContain('Delete each unsourced stage split, threshold, scale-behavior, causal, or maturity claim');
    expect(skill).toContain('a disclaimer or assumptions block cannot preserve it');
    expect(skill).toContain('mark that occurrence `Hypothesis` or `Proposed`');
    expect(skill).toContain('give each major section its job or question');
    expect(skill).not.toMatch(/engineering organization|5\s*[-–]\s*10\s*people/i);
    expect(skill).not.toContain('Populate every row; a generic evidence note after the outline');
    for (const pass of ['developmental edit', 'evidence edit', 'line edit', 'copy edit']) {
      expect(bundle).toContain(pass);
    }
    for (const status of ['BLOCK', 'FIX', 'REVIEW', 'PASS']) {
      expect(bundle).toContain(`\`${status}\``);
    }
    for (const decision of ['READY', 'READY AFTER FIXES', 'HOLD']) {
      expect(skill).toContain(decision);
    }
    expect(skill).toContain('generic bridge claims');
    expect(skill).toContain('individual social posts');
    expect(bundle).toContain('first non-empty line a distinct headline');
    expect(bundle).toContain('explicit low-friction action or decision prompt');
    expect(bundle).toContain('skip `manage_execution_plan`');
    expect(bundle).toContain('artifact-first `draft`, `revise`, `humanize`, or `adapt`');
    expect(bundle).toContain('not a plan/status update or completion summary');
    expect(bundle).toContain('before/after durations');
    expect(bundle).toContain('quantified performance or outcome claims');
    expect(bundle).toContain('Replaceable options');
    expect(bundle).toContain('alternate CTA');
    expect(bundle).toContain('end the main post with an explicit interaction CTA');
    expect(bundle).toContain('`可替换选项` in Chinese');
    expect(bundle).toContain('at least two qualitative input-to-output mini-examples');
    expect(bundle).toContain('Never invent time saved or outcome metrics');
    expect(bundle).toContain('Add one copy-ready prompt using `[输入材料]`');
    expect(bundle).toContain('`[输出格式]`, `[读者]`, and `[待核验项]`');
    expect(bundle).toContain('a per-scenario placeholder');
    expect(bundle).toContain('not fixed meeting fields');
    expect(skill).toContain('add no interpretation, implication, bridge claim');
    expect(skill).toContain('A headline is also a claim');
    expect(skill).toContain('make the first line `主题：...`');
    expect(skill).toContain('make the only CTA `[阅读全文](/report)`');
    expect(skill).toMatch(/Derive short evidence-family labels from the request's material current\s+claims/);
    expect(skill).toContain('Do not target an arbitrary source count');
    expect(skill).toMatch(/A source may cover several families only when its body directly\s+supports each one/);
    expect(skill).toContain('Use the fewest targeted searches');
    expect(skill).toMatch(/meaningfully\s+different query or source target/);
    expect(skill).toMatch(/latest\s+such attempt adds no usable support/);
    expect(skill).toMatch(/deterministic coverage check, not the owner of the research\s+decision/);
    expect(skill).toMatch(/publication date or measurement period[\s\S]*visible/);
    expect(skill).toMatch(/link alone is not a visible freshness signal/);
    expect(skill).toMatch(/Draft only from retrieved, traceable evidence/);
    expect(skill).toMatch(/research ledger is the\s+coverage checkpoint, not a citation whitelist/);
    expect(skill).toMatch(/later retrieval changes\s+family coverage[\s\S]*update the ledger and rerun the gate/);
    expect(skill).toMatch(/Run the gate once after the final collection ledger[\s\S]*rerun it only if a `CONTINUE_RESEARCH` result leads to a changed[\s\S]*ledger/);
    expect(skill).not.toMatch(/deep-research|DeepResearcher/);
    expect(skill).toContain('native search content with citations qualifies');
    expect(skill).toContain('rather than ad-hoc shell HTTP commands');
    expect(skill).toMatch(/never guess\s+or rewrite a URL/);
    expect(skill).not.toContain('`fetch_attempts`');
    expect(skill).not.toMatch(/exact labels `salary`|fetch exactly 3|batches of 2 then 1/i);
    expect(skill).not.toContain('before any fourth fetch, prose, or extra analysis');
    // HOLD is a publication decision; it must not disable the preflight file/runner route.
    expect(skill).toContain('Require qualified review for high-stakes');
    expect(bundle).not.toMatch(/do not persist the blocked\s+input|Skip that runner input|input file would itself be an unsafe/);
    expect(bundle).toContain('vague rhetorical question');
    expect(skill).toMatch(/unlisted copy format within the caller's scope/i);
    expect(skill).toContain('unfamiliar channel');
    expect(skill).toContain('bounded `current-research`, do not load it');
    expect(formats).toContain('roughly 450–700 Chinese characters');
    expect(formats).toContain('Never ask which publishing platform to use');
    expect(formats).toContain('only when they materially change the artifact');
    expect(formats).toContain('skip `manage_execution_plan`');
    expect(formats).toContain('status/completion summary');
    expect(formats).toMatch(/copy format within the caller's scope that is not listed/i);
    expect(bundle).toContain('Judge the delivered artifact after applied edits');
    expect(bundle).toContain('Evidence required for the stronger claim');
    expect(bundle).toContain('may not drop a limitation');
    expect(bundle).toContain('MANUAL PREFLIGHT — SCRIPT NOT RUN');
    expect(bundle).toContain('--source SOURCE.md');
    for (const marker of [
      'developmental edit',
      'voice fingerprint',
      'audit_content',
      'research_gate',
      'RESEARCH_LEDGER.json',
      'READY_TO_DRAFT',
      'CONTINUE_RESEARCH',
      'freeze every source clause',
      'verification action',
      'paired boundary',
      'deletion blacklist',
      'return the complete artifact',
      'count the literal destination',
      'distinct subject as the first non-empty line',
      'rejected value → accepted value',
    ]) {
      expect(bundle.toLowerCase(), marker).toContain(marker.toLowerCase());
    }
  });

  it('uses only the standard Orkas runner for bundled deterministic checks', () => {
    const skill = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
    const audit = fs.readFileSync(
      path.join(skillDir, 'references', 'audit-and-delivery.md'),
      'utf8',
    );
    const bundle = `${skill}\n${audit}`;
    expect(audit).toMatch(
      /"\$ORKAS_NODE"\s+"\$ORKAS_PC_DIR\/bin\/run-skill\.cjs"\s+content-writer\s+audit_content\s+--/,
    );
    expect(skill).toMatch(
      /"\$ORKAS_NODE"\s+"\$ORKAS_PC_DIR\/bin\/run-skill\.cjs"\s+content-writer\s+research_gate\s+--\s+RESEARCH_LEDGER\.json\s+--format\s+json/,
    );
    expect(audit).toMatch(/audit_content\s+--\s+REWRITE\.md\s+--source\s+SOURCE\.md/);
    expect(bundle).not.toMatch(/python3\s+scripts\/audit_content\.py/);
    expect(bundle).not.toMatch(/python3\s+scripts\/research_gate\.py/);
  });

  it('executes JSON and Markdown audit output through the real Skill Runner', () => {
    const runner = path.join(repoRoot, 'bin', 'run-skill.cjs');
    for (const format of ['json', 'markdown']) {
      const result = spawnSync(
        process.execPath,
        [runner, 'content-writer', 'audit_content', '--', '-', '--format', format],
        {
          cwd: repoRoot,
          env: { ...process.env, ORKAS_RUN_SKILL_DIR: skillDir },
          encoding: 'utf8',
          input: '研究表明，该指标在2026年增长了30%。[待补]',
        },
      );
      expect(result.status, `${format}\nstdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
      expect(result.stderr).toBe('');
      if (format === 'json') {
        const report = JSON.parse(result.stdout);
        expect(report.summary.by_severity.error).toBe(1);
        expect(report.summary.by_code.numeric_or_date_claim).toBe(1);
        expect(report.summary.by_code.vague_attribution).toBe(1);
      } else {
        expect(result.stdout).toContain('# Deterministic content audit');
        expect(result.stdout).toContain('`unresolved_placeholder`');
      }
    }
  });

  it('keeps coverage and freshness decisions separate for undated sources', () => {
    const runner = path.join(repoRoot, 'bin', 'run-skill.cjs');
    const gate = (sources: unknown[]) => {
      const result = spawnSync(
        process.execPath,
        [runner, 'content-writer', 'research_gate', '--', '-', '--format', 'json'],
        {
          cwd: repoRoot,
          env: { ...process.env, ORKAS_RUN_SKILL_DIR: skillDir },
          encoding: 'utf8',
          input: JSON.stringify({
            required_families: ['market-size', 'buyer-needs'],
            sources,
          }),
        },
      );
      expect(result.status, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
      return JSON.parse(result.stdout);
    };

    const undatedCoverage = gate([
      { url: 'https://authority.example/reports/market', families: ['market-size'], status: 'usable', published: '2026-07-30' },
      { url: 'https://research.example/buyer-needs', families: ['buyer-needs'], status: 'usable' },
    ]);
    expect(undatedCoverage.decision).toBe('READY_TO_DRAFT');
    expect(undatedCoverage.missing_families).toEqual([]);
    expect(undatedCoverage.usable_source_count).toBe(2);
    expect(undatedCoverage.undated_families).toEqual(['buyer-needs']);
    expect(undatedCoverage.reasons).toEqual([]);
    expect(undatedCoverage.advisories.join(' ')).toContain(
      'assess whether each retained claim needs a dated source',
    );

    const withDatedCoverage = gate([
      { url: 'https://authority.example/reports/market', families: ['market-size'], status: 'usable', published: '2026-07-30' },
      { url: 'https://research.example/buyer-needs', families: ['buyer-needs'], status: 'usable', published: '2026-07-22' },
    ]);
    expect(withDatedCoverage.decision).toBe('READY_TO_DRAFT');
    expect(withDatedCoverage.undated_families).toEqual([]);

    // A date the row cannot actually have is not a date. Invented precision is
    // already forbidden; this makes an impossible one fail closed rather than
    // silently unlock a family.
    const impossibleDate = gate([
      { url: 'https://authority.example/reports/market', families: ['market-size'], status: 'usable', published: '2026-02-31' },
      { url: 'https://research.example/buyer-needs', families: ['buyer-needs'], status: 'usable', published: '2026/06/18' },
    ]);
    expect(impossibleDate.decision).toBe('READY_TO_DRAFT');
    expect(impossibleDate.undated_families).toEqual(['market-size', 'buyer-needs']);
    expect(impossibleDate.advisories).toHaveLength(1);

    const missingCoverage = gate([
      { url: 'https://authority.example/reports/market', families: ['market-size'], status: 'usable', published: '2026-07-30' },
    ]);
    expect(missingCoverage.decision).toBe('CONTINUE_RESEARCH');
    expect(missingCoverage.missing_families).toEqual(['buyer-needs']);
    expect(missingCoverage.reasons.join(' ')).toContain('missing evidence families');
  });

  it('allows one comprehensive source to cover multiple task-derived evidence families', () => {
    const runner = path.join(repoRoot, 'bin', 'run-skill.cjs');
    const result = spawnSync(
      process.execPath,
      [runner, 'content-writer', 'research_gate', '--', '-', '--format', 'json'],
      {
        cwd: repoRoot,
        env: { ...process.env, ORKAS_RUN_SKILL_DIR: skillDir },
        encoding: 'utf8',
        input: JSON.stringify({
          required_families: ['feature-availability', 'pricing'],
          sources: [
            { url: 'https://vendor.example/product-update', families: ['feature-availability', 'pricing'], status: 'usable', published: '2026-07-01' },
          ],
        }),
      },
    );
    expect(result.status, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      ready: true,
      decision: 'READY_TO_DRAFT',
      usable_source_count: 1,
      minimum_distinct_sources: 1,
      missing_families: [],
    });
  });
});
