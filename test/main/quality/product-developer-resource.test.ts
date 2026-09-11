import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { validateAgentDir, validateSkillDir } from '../../../src/main/quality';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const resourceRoot = path.join(repoRoot, 'resources', 'builtin', 'marketplace');
const agentDir = path.join(resourceRoot, 'agents', 'a316881746f9');
const productDevDir = path.join(resourceRoot, 'skills', '68fb048b85cb');
const productTestDir = path.join(resourceRoot, 'skills', '9b1241732f3a');
const swiftuiDir = path.join(resourceRoot, 'skills', 'b1f384166705');

describe('ProductDeveloper Resource contract', () => {
  it('keeps the agent repository-aware, interactive, and evidence-gated', () => {
    const spec = JSON.parse(fs.readFileSync(path.join(agentDir, 'agent.json'), 'utf8')) as any;

    expect(spec.agent_id).toBe('a316881746f9');
    expect(spec.interactive).toBe(true);
    expect(spec.inputs.find((input: any) => input.id === 'project_path')?.type).toBe('directory');
    expect(spec.skill_list).toEqual([
      '68fb048b85cb',
      '9b1241732f3a',
      'fc125b9df078',
      '88aca13869d9',
      'b1f384166705',
    ]);
    expect(spec.knowhow.length).toBeGreaterThanOrEqual(4);
    expect(spec.standards.length).toBeGreaterThanOrEqual(5);
    expect(spec.dispatch.length).toBeLessThanOrEqual(500);

    for (const marker of [
      'Classify The Engineering Contract',
      'Read repository instructions',
      'acceptance-to-evidence matrix',
      'Debug by falsifiable hypotheses',
      'Review-On-Submit',
      'unverified path',
      'do not fill it with a recommended MVP',
      'Do not patch generated trees',
    ]) {
      expect(spec.workflow, marker).toContain(marker);
    }
    expect(spec.dispatch).toContain('without inventing MVP');
    expect(spec.dispatch).toContain('Hand disposable validation demos');

    expect(spec.description_zh).toMatch(/bug|重构|代码评审|性能|CI|测试修复/i);
    expect(spec.description_en).toMatch(/bug|refactor|code review|performance|CI|test repair/i);

    const report = validateAgentDir(agentDir);
    expect(report.ok, JSON.stringify(report.violations, null, 2)).toBe(true);
    expect(report.violations).toEqual([]);
  });

  it('normalizes knowhow and standards into non-empty runtime guidance', async () => {
    const raw = JSON.parse(fs.readFileSync(path.join(agentDir, 'agent.json'), 'utf8'));
    const agents = await import('../../../src/main/features/agents');
    const bus = await import('../../../src/main/features/group_chat/bus');
    const normalized = agents.normalizeAgent(raw, 'marketplace');

    expect(normalized?.profile?.role).toBe(raw.role);
    expect(normalized?.profile?.dispatch).toBe(raw.dispatch);
    expect(normalized?.profile?.knowhow).toEqual(raw.knowhow);
    expect(normalized?.profile?.standards).toEqual(raw.standards);

    const guidance = bus._buildAgentRuntimeGuidanceForTest(normalized?.profile);
    expect(guidance).not.toBe('(none)');
    expect(guidance).toContain('### Agent role notes');
    expect(guidance).toContain('### Delivery standards');
    expect(guidance).not.toContain('### Agent strengths');
    expect(guidance).not.toContain(raw.knowhow[0]);
    expect(guidance).toContain(raw.standards[0]);
    expect(bus._buildPlanInteractionHintForTest(normalized?.interactive === true))
      .toContain('<plan-interaction status="open" />');

    const users = await import('../../../src/main/features/users');
    users.activateUser('product-developer-resource-test');
    const prompt = await bus._buildAgentInGroupSystemPromptForTest(
      normalized!,
      '/benchmark/product-developer',
    );
    expect(prompt).toContain('### Delivery standards');
    expect(prompt).not.toContain('### Agent strengths');
    expect(prompt).not.toContain(raw.knowhow[0]);
    expect(prompt).toContain('### 1. Classify The Engineering Contract');
    expect(prompt).toContain('"id":"project_path"');
    expect(prompt).toContain('"type":"directory"');
    expect(prompt).toContain('<plan-interaction status="open" />');
  });

  it('keeps product engineering references and routing metadata complete', () => {
    const requiredReferences = [
      'repository-intake.md',
      'architecture-decision.md',
      'technical-spike.md',
      'decision-review.md',
      'product-dev-template.md',
      'implementation.md',
      'debugging.md',
      'engineering-tests.md',
      'change-safety.md',
      'review-and-finish.md',
    ];
    for (const file of requiredReferences) {
      expect(fs.existsSync(path.join(productDevDir, 'references', file)), file).toBe(true);
    }

    const skillMd = fs.readFileSync(path.join(productDevDir, 'SKILL.md'), 'utf8');
    expect(skillMd).toContain('## 边界先行');
    expect(skillMd).toContain('不编造推荐 MVP、PRD、功能范围、架构或代码');
    expect(skillMd).toContain('不生成实现工件');
    const frontmatter = skillMd.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
    const frontmatterKeys = frontmatter.split('\n')
      .map((line) => line.match(/^([a-z_]+):/)?.[1])
      .filter(Boolean);
    expect(frontmatterKeys).toEqual(['name', 'description_zh', 'description_en']);

    const actualReferences = fs.readdirSync(path.join(productDevDir, 'references'))
      .filter((file) => file.endsWith('.md'))
      .sort();
    const routedReferences = [...skillMd.matchAll(/\]\(references\/([^)]+\.md)\)/g)]
      .map((match) => match[1])
      .filter((file, index, files) => files.indexOf(file) === index)
      .sort();
    expect(routedReferences).toEqual(actualReferences);

    for (const dir of [productDevDir, productTestDir, swiftuiDir]) {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, '_meta.json'), 'utf8'));
      expect(meta.category).toBe('rnd');
      expect(meta.routing.applicable_domain).toBeTruthy();
      expect(meta.routing.negative_examples.length).toBeGreaterThan(0);
      expect(Array.isArray(meta.routing.prerequisites)).toBe(true);

      const report = validateSkillDir(dir);
      expect(report.ok, `${dir}\n${JSON.stringify(report.violations, null, 2)}`).toBe(true);
      expect(report.violations, dir).toEqual([]);
    }
  });

  it('invokes every native trace script through the standard Orkas runner', () => {
    const nativeTrace = fs.readFileSync(
      path.join(swiftuiDir, 'references', 'native-trace.md'),
      'utf8',
    );
    const runner = /"\$ORKAS_NODE"\s+"\$ORKAS_PC_DIR\/bin\/run-skill\.cjs"\s+swiftui-dev\s+(record_time_profiler|extract_time_samples|top_hotspots)\s+--/g;
    const scripts = [...nativeTrace.matchAll(runner)].map((match) => match[1]);

    expect(new Set(scripts)).toEqual(new Set([
      'record_time_profiler',
      'extract_time_samples',
      'top_hotspots',
    ]));
    expect(nativeTrace).not.toMatch(/python3\s+scripts\//);
    expect(nativeTrace).not.toMatch(/^scripts\/(record|extract|top)_/m);
  });

  it('executes every native trace CLI entry through the standard runner', () => {
    const runner = path.join(repoRoot, 'bin', 'run-skill.cjs');
    for (const script of ['record_time_profiler', 'extract_time_samples', 'top_hotspots']) {
      const result = spawnSync(
        process.execPath,
        [runner, 'swiftui-dev', script, '--', '--help'],
        {
          cwd: repoRoot,
          env: { ...process.env, ORKAS_RUN_SKILL_DIR: swiftuiDir },
          encoding: 'utf8',
        },
      );
      expect(result.status, `${script}\nstdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
      expect(result.stdout, script).toMatch(/usage:/i);
    }
  });
});
