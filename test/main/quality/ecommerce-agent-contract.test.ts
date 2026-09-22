import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeAgent } from '../../../src/main/features/agents';
import { _buildAgentInGroupSystemPromptForTest } from '../../../src/main/features/group_chat/bus';
import { toolNamesForAgentGroups } from '../../../src/main/model/core-agent/tool-catalog';

const marketplaceRoot = path.resolve(__dirname, '../../..', 'resources/builtin/marketplace');
const agentsRoot = path.join(marketplaceRoot, 'agents');
const skillsRoot = path.join(marketplaceRoot, 'skills');
const agents = fs.readdirSync(agentsRoot)
  .map(id => path.join(agentsRoot, id, 'agent.json'))
  .filter(file => fs.existsSync(file))
  .map(file => JSON.parse(fs.readFileSync(file, 'utf8')))
  .filter(agent => agent.category === 'ecommerce');

describe('ecommerce identity and effective Agent handoff', () => {
  it('keeps detailed Researcher evidence and commitment methods in the owning Skill', () => {
    const researcher = agents.find(agent => agent.name === 'ECommerceResearcher');
    const skill = fs.readFileSync(path.join(skillsRoot, '272355bc883d', 'SKILL.md'), 'utf8');
    const evidence = fs.readFileSync(path.join(skillsRoot, '272355bc883d', 'references', 'data-provenance-and-confidence.md'), 'utf8');
    const selection = fs.readFileSync(path.join(skillsRoot, '272355bc883d', 'references', 'product-selection-method.md'), 'utf8');
    const output = fs.readFileSync(path.join(skillsRoot, '272355bc883d', 'references', 'product-research-output.md'), 'utf8');
    // Detailed methods belong to the declared Skill; do not force copies into
    // the resident workflow. Output quality is checked by the model cases.
    expect(researcher.skill_list).toContain('272355bc883d');
    expect(researcher.standards.join(' ')).toMatch(/Decision-changing external facts appear in a compact evidence map with direct opened URLs/);
    expect(researcher.standards.join(' ')).toMatch(/unsourced demand, competition, compliance, conversion and return-risk rationales are grouped and labeled as hypotheses/);
    expect(researcher.standards.join(' ')).toMatch(/reversible validation with bounded commitment/);
    expect(researcher.standards.join(' ')).toMatch(/chooses a bounded first-country\/platform scope when the user says unrestricted/);
    expect(skill).toMatch(/build its compact claim ledger from sources actually observed in this task/);
    expect(skill).toMatch(/prefer explicit hypotheses over broad market statistics/);
    expect(skill).toMatch(/Build allocations and total-spend recommendations only from a supplied commitment ceiling/);
    expect(skill).toMatch(/Propose inventory quantity only when both a commitment ceiling and a compatible landed-cost basis are supplied/);
    expect(skill).toMatch(/Treat an unrestricted dimension as permission to propose a bounded test scope/);
    expect(skill).toMatch(/do not treat a remembered report title as observed evidence/);
    expect(skill).toMatch(/Research only a decision-changing external claim, and include its direct source in the answer/);
    expect(skill).toMatch(/prefer one executable base allocation with its explicit arithmetic total/);
    expect(skill).toMatch(/Choose one current validation stage/);
    expect(skill).toMatch(/Keep the executable actions within that stage/);
    expect(skill).toMatch(/reversible validation with bounded commitment/);
    expect(skill).toMatch(/Do not call it cheapest or lowest-cost unless compared costs support that ranking/);
    expect(evidence).toMatch(/Bind each supplied number to its stated meaning and basis before using it/);
    expect(evidence).toMatch(/Decompose a bundled intake field into only the claims its value actually expresses/);
    expect(evidence).toMatch(/category or sourcing direction alone does not establish supplier access/);
    expect(evidence).toMatch(/Assign observed \/ calculated \/ estimated \/ hypothesis \/ unavailable per claim/);
    expect(evidence).toMatch(/One observed platform or macro claim does not upgrade unrelated category demand/);
    expect(evidence).toMatch(/reconcile every external, current, numeric or comparative factual claim with evidence actually read in this task/);
    expect(evidence).toMatch(/report name, direct link or fact recalled without an observed source record is not evidence/);
    expect(evidence).toMatch(/omit report names, links, rankings and current statistics/);
    expect(evidence).toMatch(/proposed trial allocations, thresholds and target prices labeled as plans/);
    expect(selection).toMatch(/add every mutually required allocation before recommending the plan/);
    expect(selection).toMatch(/one amount per required line item and show the arithmetic total/);
    expect(selection).toMatch(/show the minimum and maximum totals and keep both within the stated ceiling/);
    expect(selection).toMatch(/earliest validation stage supported by the available inputs/);
    expect(selection).toMatch(/inventory demand trial becomes actionable only after the merchant's commitment ceiling/);
    expect(selection).toMatch(/do not propose unit ranges, spend ranges or allocation percentages/);
    expect(output).toMatch(/State evidence status at the claim or evidence-lane level/);
    expect(output).toMatch(/Start with a compact scope line: proposed first country \| first platform \| candidate set \| current validation stage/);
    expect(output).toMatch(/a region such as Southeast Asia is context, not a first-country choice/);
    expect(output).toMatch(/response may combine source-backed facts with explicit hypotheses/);
    expect(output).toMatch(/Use two clear lanes in the delivered answer/);
    expect(output).toMatch(/Do not leave an unsourced demand, competition, compliance, conversion or return-risk rationale in an unqualified reason column/);
    expect(output).toMatch(/For a hypothesis with no observed source, omit report names, direct links, rankings, current statistics/);
    expect(output).toMatch(/include a compact evidence map/);
    expect(output).toMatch(/cite the exact prior source again when using it for a new factual claim/);
    expect(output).toMatch(/Treat category demand, popularity and competition rationales as hypotheses/);
    expect(output).toMatch(/If no total commitment ceiling was supplied, do not turn an illustrative amount into the recommended plan/);
    expect(output).toMatch(/Make the current stage executable from observations/);
    expect(output).toMatch(/Describe the locked inventory stage only as an advancement gate/);
    expect(output).toMatch(/Do not include a proposed inventory quantity or range/);
    expect(output).toMatch(/maximum order quantity is `floor\(\(C - R\) \/ L\)`/);
    expect(output).toMatch(/return this formula as the advancement rule rather than substituting illustrative numbers/);
  });

  it('lets Writer execute and continue its local copy constructor without interactive CLI or merchant access', () => {
    const writer = agents.find(agent => agent.name === 'ECommerceWriter');
    const tools = toolNamesForAgentGroups(writer.tool_list);
    expect(tools).toContain('bash');
    expect(tools).toContain('write_file');
    expect(tools).toContain('publish_outputs');
    expect(tools).toContain('process_session');
    expect(tools).not.toContain('interactive_cli');
    expect(tools).not.toContain('call_connector_tool');
    expect(toolNamesForAgentGroups(writer.tool_list.filter((id: string) => id !== 'workspace.execute.command'))).not.toContain('bash');
    expect(toolNamesForAgentGroups(writer.tool_list.filter((id: string) => id !== 'workspace.execute.command'))).not.toContain('process_session');
  });
  it('keeps dependency IDs and standards through production normalization and prompt assembly', async () => {
    expect(agents).toHaveLength(5);
    for (const raw of agents) {
      const normalized = normalizeAgent(raw, 'marketplace');
      expect(normalized?.agent_id).toBe(raw.agent_id);
      expect(normalized?.name).toBe(raw.name);
      expect(normalized?.skill_list).toEqual(raw.skill_list);
      const prompt = await _buildAgentInGroupSystemPromptForTest(normalized!, '/test/ecommerce', 'en');
      expect(prompt).toContain(`Name: ${raw.name}`);
      expect(prompt).toContain(raw.workflow);
      expect(normalized!.inputs!.filter(input => input.required).map(input => input.id)).toEqual(['request']);
      expect(prompt).toMatch(/execute the supported portion with explicit limits/);
      expect(prompt).toMatch(/recheck only remaining blockers to the current step/);
      expect(prompt).toMatch(/Do not invent user facts, evidence, action targets, or authority/);
      expect(prompt).not.toMatch(/would materially change the result, do not fill/);
      for (const standard of raw.standards) {
        expect(prompt.split(standard)).toHaveLength(2);
      }
      for (const displayOnly of raw.knowhow) {
        expect(prompt).not.toContain(displayOnly);
      }
      expect(prompt).not.toMatch(/MerchResearcher|MerchReviewer|MerchPageOptimizer/);
    }
  });
});
