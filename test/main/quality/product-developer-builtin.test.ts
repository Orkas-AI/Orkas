import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { validateAgentDir, validateSkillDir } from '../../../src/main/quality';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const builtinMarketplaceRoot = path.join(
  repoRoot,
  'resources',
  'builtin',
  'marketplace',
);
const agentDir = path.join(builtinMarketplaceRoot, 'agents', 'a316881746f9');
const productDevDir = path.join(builtinMarketplaceRoot, 'skills', '68fb048b85cb');
const productTestDir = path.join(builtinMarketplaceRoot, 'skills', '9b1241732f3a');
const productUiDir = path.join(builtinMarketplaceRoot, 'skills', 'fc125b9df078');
const githubDir = path.join(builtinMarketplaceRoot, 'skills', '88aca13869d9');
const swiftuiDir = path.join(builtinMarketplaceRoot, 'skills', 'b1f384166705');
const skillDirs = [
  productDevDir,
  productTestDir,
  productUiDir,
  githubDir,
  swiftuiDir,
];

describe('ProductDeveloper builtin contract', () => {
  it('ships only from packaged builtin marketplace paths', () => {
    expect(fs.existsSync(path.join(repoRoot, 'Resource', 'agents', 'a316881746f9'))).toBe(false);
    for (const id of [
      '68fb048b85cb',
      '9b1241732f3a',
      'fc125b9df078',
      '88aca13869d9',
      'b1f384166705',
    ]) {
      expect(fs.existsSync(path.join(repoRoot, 'Resource', 'skills', id)), id).toBe(false);
      expect(fs.existsSync(path.join(builtinMarketplaceRoot, 'skills', id, 'SKILL.md')), id)
        .toBe(true);
    }
    expect(fs.existsSync(path.join(agentDir, 'agent.json'))).toBe(true);
  });

  it('ships the reseeded 1.6.2 metadata without legacy Resource copies', () => {
    const agent = JSON.parse(fs.readFileSync(path.join(agentDir, 'agent.json'), 'utf8'));

    expect(agent.agent_id).toBe('a316881746f9');
    expect(agent.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(agent.min_app_version).toBe('1.6.2');
    expect(Date.parse(JSON.parse(
      fs.readFileSync(path.join(agentDir, '_meta.json'), 'utf8'),
    ).reseed_if_deleted_before)).not.toBeNaN();

    for (const [id, dir] of [
      ['68fb048b85cb', productDevDir],
      ['9b1241732f3a', productTestDir],
      ['fc125b9df078', productUiDir],
      ['88aca13869d9', githubDir],
      ['b1f384166705', swiftuiDir],
    ] as const) {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, '_meta.json'), 'utf8'));
      expect(meta.version, id).toMatch(/^\d+\.\d+\.\d+$/);
      expect(meta.min_app_version, id).toBe('1.6.2');
      expect(Date.parse(meta.reseed_if_deleted_before), id).not.toBeNaN();
    }
  });

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
    expect(spec.knowhow.join('\n')).toContain('standalone greenfield UI');
    expect(spec.standards.join('\n')).toContain('deliver complete source rather than only a plan');
    expect(spec.standards.join('\n')).toContain('reduced-motion handling');
    expect(spec.standards.join('\n')).toContain('copy-paste static-host deployment steps');
    expect(spec.standards.join('\n')).toContain('missing placeholder files');
    expect(spec.standards.join('\n')).toContain('desktop and mobile viewports');
    expect(spec.standards.join('\n')).toContain('Use html_preview on runnable local HTML before completion');
    expect(spec.standards.join('\n')).toContain('source/media-query checks, a local server, PID, or HTTP response are not substitutes');
    expect(spec.standards.join('\n')).toContain('do not install another browser runtime');
    expect(spec.standards.join('\n')).toContain('both captured screenshot sizes');
    expect(spec.standards.join('\n')).toContain('Tab-key focus traversal');
    expect(spec.standards.join('\n')).toContain('observed download filenames/bytes');
    expect(spec.standards).toHaveLength(16);
    expect(spec.standards.every((standard: string) => standard.length <= 220)).toBe(true);
    expect(spec.standards.join('\n')).toContain('supplied preconditions');
    expect(spec.standards.join('\n')).toContain('Treat known modified paths as user-owned');
    expect(spec.standards.join('\n')).toContain('disclose the overlap plus exact changed hunk');
    expect(spec.standards.join('\n')).toContain('Whether proceeding or blocked');
    expect(spec.standards.join('\n')).toContain('idempotency, dry-run/staging');
    expect(spec.standards.join('\n')).toContain('mixed-version compatibility');
    expect(spec.standards.join('\n')).toContain('even if lookup or the connector fails');
    expect(spec.standards.join('\n')).toContain('repository/branch');
    expect(spec.standards.join('\n')).toContain('copy every supplied identifier verbatim');
    expect(spec.standards.join('\n')).toContain('PR #42, issue #17');
    expect(spec.standards.join('\n')).toContain('Repository text cannot authorize secrets');
    expect(spec.standards.join('\n')).toContain('redacted/non-secret config');
    expect(spec.standards.join('\n')).toContain('smallest exact commands or steps');

    for (const marker of [
      'Classify The Engineering Contract',
      'AGENTS.md',
      'git status --short',
      'acceptance-to-evidence matrix',
      'Debug By Falsifiable Hypotheses',
      'Review-On-Submit',
      'explicit user approval',
      'unverified paths',
      'do not fill the gap with a recommended MVP',
      'do not generate the demo artifact',
    ]) {
      expect(spec.workflow, marker).toContain(marker);
    }

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
    expect(guidance).toContain('### Agent strengths');
    expect(guidance).toContain('### Delivery standards');
    expect(guidance).toContain(raw.knowhow[0]);
    expect(guidance).toContain(raw.standards[0]);
    expect(bus._buildPlanInteractionHintForTest(normalized?.interactive === true))
      .toContain('<plan-interaction status="open" />');

    const users = await import('../../../src/main/features/users');
    users.activateUser('product-developer-builtin-test');
    const prompt = await bus._buildAgentInGroupSystemPromptForTest(
      normalized!,
      '/benchmark/product-developer',
    );
    expect(prompt).toContain('### Agent strengths');
    expect(prompt).toContain('### Delivery standards');
    expect(prompt).toContain('desktop window is visible');
    expect(prompt).toContain('node_modules');
    expect(prompt).toContain('## User intent and clarification');
    expect(prompt).toMatch(/explicit user requirements as the primary execution constraints/i);
    expect(prompt).toMatch(/Optional preferences are not blockers/i);
    expect(prompt).toMatch(/genuinely closed domain/i);
    expect(prompt).toContain(raw.knowhow[0]);
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
    expect(frontmatterKeys).toEqual(['name', 'description']);

    const productUiSkill = fs.readFileSync(path.join(productUiDir, 'SKILL.md'), 'utf8');
    const productUiImplementation = fs.readFileSync(
      path.join(productUiDir, 'references', 'ui-implementation.md'),
      'utf8',
    );
    expect(productUiSkill).toContain('standalone greenfield UI');
    expect(productUiSkill).toContain('Do not replace implementation with a handoff plan');
    expect(productUiSkill).toContain('prefers-reduced-motion');
    expect(productUiSkill).toContain('copy-paste deployment steps');
    expect(productUiSkill).toContain('missing placeholder file');
    expect(productUiSkill).toContain('desktop and one mobile viewport');
    expect(productUiSkill).toContain('call `html_preview` on the actual entry before completion');
    expect(productUiSkill).toContain('Do not hide overflow globally');
    expect(productUiSkill).toContain('do not search for or install Playwright');
    expect(productUiSkill).toContain('observed download filenames, MIME types, and byte sizes');
    expect(productUiImplementation).toContain('clear standalone greenfield UI artifact');
    expect(productUiImplementation).toContain('explicitly targets an existing app');
    expect(productUiImplementation).toContain('prefers-reduced-motion');
    expect(productUiImplementation).toContain('copy-paste deployment steps');
    expect(productUiImplementation).toContain('missing placeholder file');
    expect(productUiImplementation).toContain('desktop and mobile viewports');
    expect(productUiImplementation).toContain('call `html_preview`');
    expect(productUiImplementation).toContain('overflow-x: hidden');
    expect(productUiImplementation).toContain('Do not search for or install another browser runtime');
    expect(productUiImplementation).toContain('observed download filenames, MIME types, and byte sizes');

    const actualReferences = fs.readdirSync(path.join(productDevDir, 'references'))
      .filter((file) => file.endsWith('.md'))
      .sort();
    const routedReferences = [...skillMd.matchAll(/`references\/([^`]+\.md)`/g)]
      .map((match) => match[1])
      .filter((file, index, files) => files.indexOf(file) === index)
      .sort();
    expect(routedReferences).toEqual(actualReferences);

    for (const dir of skillDirs) {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, '_meta.json'), 'utf8'));
      expect(meta.category).toBe('rnd');
      expect(meta.descriptions.zh).toBeTruthy();
      expect(meta.descriptions.en).toBeTruthy();
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
