import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateAgentDir } from '../../../src/main/quality';

const repoRoot = path.resolve(__dirname, '../../..');
const agentDir = path.join(repoRoot, 'resources/builtin/marketplace/agents/78900d8758bc');
const readAgent = () => JSON.parse(fs.readFileSync(path.join(agentDir, 'agent.json'), 'utf8'));

describe('DeepResearcher domain consolidation', () => {
  it('advertises evidence synthesis and social analysis rather than ordinary search', () => {
    const agent = readAgent();
    expect(agent.description_zh).toMatch(/多源取证.*样本分析.*综合判断/);
    expect(agent.description_zh).toMatch(/社媒.*口碑.*活动分析/);
    expect(agent.description_zh).toMatch(/不用于普通事实查询或找链接/);
    expect(agent.description_en).toMatch(/multi-source evidence.*sample analysis.*synthesis/i);
    expect(agent.description_en).toMatch(/social reputation.*campaign analysis/i);
    expect(agent.description_en).toMatch(/not for ordinary fact lookups or link finding/i);
    expect(agent.workflow).toMatch(/not ordinary fact lookup or link finding/i);
  });

  it('owns bounded social work without forcing a deep-report lifecycle or fresh public collection', () => {
    const agent = readAgent();
    expect(agent.workflow).toMatch(/social-data` for reputation or supplied campaign analysis/i);
    expect(agent.workflow).toMatch(/social work.*freezes platforms, keywords, period and sample plan/i);
    expect(agent.workflow).toMatch(/never expand after failure\/zero results/i);
    expect(agent.workflow).toMatch(/brand context only if decision-changing/i);
    expect(agent.workflow).toMatch(/do not fetch for sufficient supplied data/i);
    expect(agent.workflow).toMatch(/social work returns planned\/completed scope.*themes or metrics.*evidence.*next experiments/i);
    expect(agent.standards.join('\n')).toMatch(/social findings retain scope, denominators and confidence/i);
    expect(agent.inputs.find((field: any) => field.id === 'task').placeholder).toMatch(/social.*campaign/i);
  });

  it('advertises both focused Brand DNA and existing complex research without a new launch requirement', () => {
    const agent = readAgent();
    expect(agent.agent_id).toBe('78900d8758bc');
    expect(agent.name).toBe('DeepResearcher');
    expect(agent.interactive).toBe(true);
    expect(agent.inputs.map((field: any) => field.id)).toEqual(['task', 'materials']);
    expect(agent.inputs.filter((field: any) => field.required).map((field: any) => field.id)).toEqual(['task']);
    for (const term of ['Brand DNA', '定位', '受众', '竞品', '语气', '文献', '核验']) expect(agent.description_zh).toContain(term);
    for (const term of ['Brand DNA', 'positioning', 'audience', 'competitors', 'voice', 'literature', 'verif']) expect(agent.description_en).toContain(term);
    expect(agent.description_en).toMatch(/not.*copywriting.*publishing/i);
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'resources/builtin/_manifest.json'), 'utf8'));
    expect(manifest.inventory.marketplace_agents.find((row: any) => row.id === agent.agent_id)?.version).toBe(agent.version);
    expect(agent.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Date.parse(agent.updated_at)).not.toBeNaN();
    const validated = validateAgentDir(agentDir);
    expect(validated.ok, JSON.stringify(validated.violations)).toBe(true);
  });

  it('uses existing domain capabilities while preserving narrow tools and the deep-research evidence contract', () => {
    const agent = readAgent();
    expect(agent.skill_list).toEqual(['ee99fbb42964', '9be6fda271a5', 'e7f5c0e6f1be', '6743aa0797a2']);
    expect(agent.tool_list).toEqual(['workspace.read', 'workspace.write.output', 'workspace.execute.command', 'web']);
    const workflow = agent.workflow;
    expect(workflow).toMatch(/brand-research` for focused.*Brand DNA/);
    expect(workflow).toMatch(/broader or complex.*deep-research` as the governing Skill/);
    expect(workflow).toMatch(/freeze sources and competitors/i);
    expect(workflow).toMatch(/not widen.*optional.*fields/);
    expect(workflow).toMatch(/social-data` for reputation or supplied campaign analysis/);
    expect(workflow).toContain('`material-organizer`');
    expect(workflow).toMatch(/resume only unfinished subquestions.*honor recorded limits/);
    expect(workflow).toMatch(/exact quotes.*contradictions.*failed-source gaps/);
    expect(workflow).toMatch(/verify each factual part and its conditions/i);
    expect(workflow).toMatch(/canonical citation-checked report.*publish(?:es)? once/);
    expect(workflow.length).toBeLessThanOrEqual(1800);
    expect(workflow).not.toMatch(/run-skill|scripts\//);
  });

  it('keeps focused briefs in chat by default without weakening deep-investigation ledgers or report delivery', async () => {
    const agent = readAgent();
    expect(agent.workflow).toMatch(/brand briefs.*brand-research`'s chat\/file output contract/i);
    const brand = fs.readFileSync(path.resolve(agentDir, '../../skills/6743aa0797a2/SKILL.md'), 'utf8');
    expect(brand).toMatch(/By default, return the Brand DNA in the conversation/);
    expect(brand).toMatch(/Save.*only when the user asks for a file or confirms saving/);
    const standards = agent.standards.join('\n');
    expect(standards).toMatch(/deep-research paths.*ledgers/i);
    expect(standards).toMatch(/deep-research handoff.*RESEARCH-<topic>\.md/i);
    expect(standards).toMatch(/brand briefs?.*(?:distinguishes|separate|separating) company statements, third-party evidence and interpretation/i);
    expect(standards).toMatch(/caveats.*(?:gaps|missing fields) and next uses/i);
    expect(standards).toMatch(/unresolved choice-changing gaps.*partial, never complete/i);
    const { normalizeAgent } = await import('../../../src/main/features/agents');
    const { _buildAgentInGroupSystemPromptForTest } = await import('../../../src/main/features/group_chat/bus');
    const normalized = normalizeAgent(agent, 'builtin')!;
    const prompt = await _buildAgentInGroupSystemPromptForTest(normalized, '/test/brand-research', 'en');
    expect(prompt).toContain(agent.workflow);
    for (const standard of agent.standards) expect(prompt.split(standard)).toHaveLength(2);
    expect(prompt.split('<handback reason="capability_boundary" />')).toHaveLength(2);
    expect([agent.workflow, ...agent.standards].join('\n')).not.toMatch(/<handback|@commander|BrandResearcher/);
  });
});
