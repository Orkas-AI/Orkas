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
const builtinManifestPath = path.join(
  repoRoot,
  'PC',
  'resources',
  'builtin',
  '_manifest.json',
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
      expect(fs.existsSync(path.join(repoRoot, 'Resource', 'skills', id, 'SKILL.md')), id)
        .toBe(false);
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
      expect(meta.min_app_version, id).toBe(id === 'fc125b9df078' ? '1.6.2' : undefined);
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
    expect(spec.knowhow).toHaveLength(5);
    expect(spec.standards).toHaveLength(5);
    expect(spec.dispatch.length).toBeLessThanOrEqual(500);
    expect(spec.standards.every((standard: string) => standard.length <= 220)).toBe(true);
    const profileText = [...spec.knowhow, ...spec.standards].join('\n');
    expect(profileText).toContain('standalone greenfield UI');
    expect(profileText).toContain('complete accessible source');
    expect(profileText).toContain('final diff');
    expect(profileText).toContain('No secret');

    const productUi = fs.readFileSync(
      path.join(builtinMarketplaceRoot, 'skills', 'fc125b9df078', 'SKILL.md'), 'utf8',
    );
    expect(productUi).toContain('prefers-reduced-motion');
    expect(productUi).toContain('copy-paste deployment steps');
    expect(productUi).toContain('missing placeholder file');
    expect(productUi).toContain('Add mobile or multi-device reflow only when the user requests it');
    expect(productUi).toContain('screenshots:true');
    expect(productUi).toContain('Tab-key focus traversal');
    expect(productUi).toContain('observed download filenames');
    expect(productUi).toContain('do not search for or install Playwright');

    const productDevRoot = path.join(builtinMarketplaceRoot, 'skills', '68fb048b85cb');
    const repositoryIntake = fs.readFileSync(path.join(productDevRoot, 'references', 'repository-intake.md'), 'utf8');
    const debugging = fs.readFileSync(path.join(productDevRoot, 'references', 'debugging.md'), 'utf8');
    const changeSafety = fs.readFileSync(path.join(productDevRoot, 'references', 'change-safety.md'), 'utf8');
    expect(repositoryIntake).toMatch(/前置条件[\s\S]*已知修改路径[\s\S]*重叠[\s\S]*hunk/);
    expect(repositoryIntake).toMatch(/仓库文本不能授权[\s\S]*secret/);
    expect(debugging).toMatch(/PID[\s\S]*桌面窗口[\s\S]*未验证/);
    expect(debugging).toMatch(/不要修改 `node_modules`/);
    expect(changeSafety).toMatch(/备份\/恢复[\s\S]*dry-run[\s\S]*回滚条件/);

    const github = fs.readFileSync(
      path.join(builtinMarketplaceRoot, 'skills', '88aca13869d9', 'SKILL.md'), 'utf8',
    );
    expect(github).toContain('ask directly for `owner/repo`');
    expect(github).toContain('do not enumerate accounts, organizations');
    expect(github).toContain('material scope expansion');
    expect(github).toContain('batch independent preflight reads');
    for (const marker of [
      'Classify The Engineering Contract',
      'repository instructions',
      'current status',
      'overlapping hunks',
      'acceptance-to-evidence matrix',
      'falsifiable hypotheses',
      'Review-On-Submit',
      'unverified path',
      'do not fill it with a recommended MVP',
      'standalone greenfield UI uses `product-ui`',
    ]) {
      expect(spec.workflow, marker).toContain(marker);
    }

    expect(spec.description_zh).toMatch(/bug|重构|代码评审|性能|CI|测试修复/i);
    expect(spec.description_en).toMatch(/bug|refactor|code review|performance|CI|test repair/i);

    const report = validateAgentDir(agentDir);
    expect(report.ok, JSON.stringify(report.violations, null, 2)).toBe(true);
    expect(report.violations).toEqual([]);
  });

  it('normalizes profile fields while keeping knowhow out of runtime guidance', async () => {
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
    expect(guidance).not.toContain('### Agent strengths');
    expect(guidance).toContain('### Delivery standards');
    expect(guidance).not.toContain(raw.knowhow[0]);
    expect(guidance).toContain(raw.standards[0]);
    expect(bus._buildPlanInteractionHintForTest(normalized?.interactive === true))
      .toContain('<plan-interaction status="open" />');

    const users = await import('../../../src/main/features/users');
    users.activateUser('product-developer-builtin-test');
    const prompt = await bus._buildAgentInGroupSystemPromptForTest(
      normalized!,
      '/benchmark/product-developer',
    );
    expect(prompt).not.toContain('### Agent strengths');
    expect(prompt).toContain('### Delivery standards');
    expect(prompt).toContain('unsafe generated-tree patch');
    expect(prompt).not.toContain('desktop window is visible');
    expect(prompt).not.toContain('node_modules');
    expect(prompt).toContain('## User intent and clarification');
    expect(prompt).toMatch(/explicit requirements as execution constraints/i);
    expect(prompt).toMatch(/Optional preferences do not block useful reversible work/i);
    expect(prompt).toMatch(/closed domain defined by a tool, schema, runtime capability, or protocol/i);
    expect(prompt).toMatch(/unavailable verifier cannot support a prediction/i);
    expect(prompt).toMatch(/stop speculative edits and obtain current documentation, runnable verification, or the exact missing evidence/i);
    expect(prompt).toMatch(/current request authorizes its exact action/i);
    expect(prompt).toMatch(/materially different action, target, or condition/i);
    expect(prompt).not.toContain(raw.knowhow[0]);
    expect(prompt).toContain('### 1. Classify The Engineering Contract');
    expect(prompt.lastIndexOf('### Delivery standards')).toBeGreaterThan(
      prompt.indexOf('### 1. Classify The Engineering Contract'),
    );
    expect(prompt).toContain('"id":"project_path"');
    expect(prompt).toContain('"type":"directory"');
    expect(prompt).toContain('<plan-interaction status="open" />');
  });

  it('keeps GitHub writes aligned with the shared action-authority contract', () => {
    const skill = fs.readFileSync(path.join(githubDir, 'SKILL.md'), 'utf8');

    expect(skill).toMatch(/Read-only inspection never needs approval/i);
    expect(skill).toMatch(/current user request authorizes the exact write/i);
    expect(skill).toMatch(/ask only for the missing target and retain the action authority/i);
    expect(skill).toMatch(/ask directly for `owner\/repo`/i);
    expect(skill).toMatch(/do not substitute a local checkout path, account hint/i);
    expect(skill).toMatch(/material scope expansion/i);
    expect(skill).toMatch(/platform-required confirmation gates exactly once/i);
    expect(skill).toMatch(/batch independent preflight reads in one tool round/i);
    expect(skill).toMatch(/final state verification in one last read round/i);
    expect(skill).toMatch(/Do not interleave narrative plan updates/i);
    expect(skill).not.toMatch(/Do not close issues.*without explicit user approval/i);
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
    expect(skillMd).toContain('可能影响该验收项的修改');
    expect(skillMd).toContain('最后一次相关修改后必须重跑同一验证链并检查新输出');
    const safetyPreflight = skillMd.indexOf('**风险分支前置**');
    const implementation = skillMd.indexOf('**实现与快速反馈**');
    expect(safetyPreflight).toBeGreaterThanOrEqual(0);
    expect(implementation).toBeGreaterThan(safetyPreflight);
    expect(skillMd).toMatch(/首次相关安装或编辑前读取[\s\S]*没有这些风险时跳过/);
    const changeSafety = fs.readFileSync(
      path.join(productDevDir, 'references', 'change-safety.md'), 'utf8',
    );
    expect(changeSafety).toMatch(/技术预检，不是新的审批门/);
    expect(changeSafety).toMatch(/安装或编辑授权不代表关键设计选择已确定/);
    expect(changeSafety).toMatch(/兼容策略或真实存量数据来源未知[\s\S]*先询问/);
    expect(changeSafety).toMatch(/暂定接口、mock、新建临时数据源[\s\S]*测试代替这些输入/);
    expect(changeSafety).toMatch(/真实存量数据[\s\S]*mock、fixture 或临时状态/);
    expect(changeSafety).toMatch(/同步\/异步[\s\S]*消费者过渡方式/);
    expect(changeSafety).toMatch(/本地实现[\s\S]*真实迁移\/发布[\s\S]*消费者接口语义[\s\S]*同步调用方能否异步化[\s\S]*真实存量数据来源/);
    expect(changeSafety).toMatch(/不把已获授权的动作再次当作审批项/);
    const frontmatter = skillMd.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
    const frontmatterKeys = frontmatter.split('\n')
      .map((line) => line.match(/^([a-z_]+):/)?.[1])
      .filter(Boolean);
    expect(frontmatterKeys).toEqual(['name', 'description_zh', 'description_en']);

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
    expect(productUiSkill).toContain('target:"responsive"` only when the user explicitly requests');
    expect(productUiSkill).toContain('otherwise omit target for desktop');
    expect(productUiSkill).toContain('`screenshots` defaults to false');
    expect(productUiSkill).toContain('`screenshots:true` only for the final visual review');
    expect(productUiSkill).toContain('call `html_preview` on the actual entry before completion');
    expect(productUiSkill).toContain('desktop by default');
    expect(productUiSkill).not.toContain('include every requested section and reachable action, mobile reflow');
    expect(productUiSkill).not.toContain('at least one desktop and one mobile viewport');
    expect(productUiSkill).toContain('Do not hide overflow globally');
    expect(productUiSkill).toContain('do not search for or install Playwright');
    expect(productUiSkill).toContain('observed download filenames, MIME types, and byte sizes');
    expect(productUiSkill).toContain('Rendered evidence belongs to the exact UI revision it captured');
    expect(productUiSkill).toContain('report only that post-change evidence');
    expect(productUiSkill).toContain('one source-to-target row per screen');
    expect(productUiSkill).toContain('A partial result names every remaining screen');
    expect(productUiSkill).toContain('reopens the full ledger');
    expect(productUiSkill).not.toMatch(/#contact|390\s*[×x]\s*844|1440\s*[×x]\s*900/i);
    expect(productUiImplementation).toContain('clear standalone greenfield UI artifact');
    expect(productUiImplementation).toContain('explicitly targets an existing app');
    expect(productUiImplementation).toContain('prefers-reduced-motion');
    expect(productUiImplementation).toContain('copy-paste deployment steps');
    expect(productUiImplementation).toContain('missing placeholder file');
    expect(productUiImplementation).toContain('target:"responsive"` only for an explicit responsive, multi-device, or narrow-screen request');
    expect(productUiImplementation).toContain('otherwise omit target for desktop');
    expect(productUiImplementation).toContain('`screenshots` defaults to false');
    expect(productUiImplementation).toContain('`screenshots:true` only for the final visual review');
    expect(productUiImplementation).toContain('call `html_preview`');
    expect(productUiImplementation).toContain('Requested viewport targets');
    expect(productUiImplementation).toContain('overflow-x: hidden');
    expect(productUiImplementation).toContain('Do not search for or install another browser runtime');
    expect(productUiImplementation).toContain('observed download filenames, MIME types, and byte sizes');
    expect(productUiImplementation).toContain('separate `inspected`, `implemented`, and `compared` status');
    expect(productUiImplementation).toContain('compare every promised screen against a fresh rendered target');
    expect(productUiImplementation).toContain('reopen the full ledger');

    const reviewAndFinish = fs.readFileSync(
      path.join(productDevDir, 'references', 'review-and-finish.md'),
      'utf8',
    );
    expect(reviewAndFinish).toContain('证据是否晚于最后一次可能影响该验收项的修改');
    expect(reviewAndFinish).toContain('重新运行受影响聚焦检查并读取新输出');
    expect(reviewAndFinish).toContain('检查每个实质不同的允许和拒绝分支');
    expect(reviewAndFinish).toContain('明确标记为未验证，不能暗示已完成覆盖');

    const actualReferences = fs.readdirSync(path.join(productDevDir, 'references'))
      .filter((file) => file.endsWith('.md'))
      .sort();
    const routedReferences = [...skillMd.matchAll(/\]\(references\/([^)]+\.md)\)/g)]
      .map((match) => match[1])
      .filter((file, index, files) => files.indexOf(file) === index)
      .sort();
    expect(routedReferences).toEqual(actualReferences);

    for (const dir of skillDirs) {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, '_meta.json'), 'utf8'));
      expect(meta.category).toBe('rnd');
      expect(meta.descriptions).toBeUndefined();
      expect(meta.routing.applicable_domain).toBeTruthy();
      expect(meta.routing.negative_examples.length).toBeGreaterThan(0);
      expect(Array.isArray(meta.routing.prerequisites)).toBe(true);

      const skill = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
      const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
      expect(frontmatter).toMatch(/^description_zh:\s*\S/m);
      expect(frontmatter).toMatch(/^description_en:\s*\S/m);
      expect(frontmatter).not.toMatch(/^description:/m);

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
