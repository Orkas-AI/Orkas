import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

const AGENT_ID = 'a19101ba698a';
const agentDir = path.join(process.cwd(), 'resources', 'builtin', 'marketplace', 'agents', AGENT_ID);
const excelSkillPath = path.join(
  process.cwd(),
  'resources',
  'builtin',
  'marketplace',
  'skills',
  '081c15ffbab4',
  'SKILL.md',
);

describe('OfficeWorker built-in agent evaluation', () => {
  it('requires one built-in creation route with native charts for a new workbook', () => {
    const agent = JSON.parse(fs.readFileSync(path.join(agentDir, 'agent.json'), 'utf8')) as {
      description_zh: string;
      description_en: string;
      workflow: string;
      standards: string[];
      skill_list: string[];
    };
    const excelSkill = fs.readFileSync(excelSkillPath, 'utf8');
    const standards = agent.standards.join('\n');
    const surface = [agent.workflow, standards, excelSkill].join('\n');

    expect(agent.skill_list).toContain('081c15ffbab4');
    expect(agent.workflow).toContain('Resolve attachments before asking for files');
    expect(agent.workflow).toContain('call `search_files` once');
    expect(agent.workflow).toContain('narrow literal extension `include_glob`');
    expect(agent.workflow).toContain('never search by semantic topic');
    expect(agent.workflow).toContain('publish an empty output set');
    expect(surface).toContain('literal extension');
    // a9ab42a49 dropped the examples and kept the prohibition, so bind the rule:
    // an unknown source is found by extension, never by what it is about.
    expect(surface).toMatch(/never search by semantic topic/i);
    expect(surface).toContain('`query:*` and a narrow literal extension `include_glob`');
    expect(surface).toContain('Calling `create_xlsx` is mandatory');
    expect(surface).toContain('must not construct, rewrite, or patch the final `.xlsx` package');
    expect(standards).toContain('one current final file per requested artifact');
    expect(surface).toContain('visible editable `假设与参数` block');
    expect(surface).toContain('native editable chart objects');
    expect(surface).toContain('does not satisfy a chart request');
    expect(excelSkill).toContain('Calling `create_xlsx` is mandatory');
    expect(excelSkill).toContain('must not construct, rewrite, or patch the final `.xlsx` package');
    expect(excelSkill).toContain('Call `create_xlsx` exactly once');
    expect(excelSkill).toContain('Do not restart with a second `create_xlsx`');
    expect(excelSkill).toContain('visible editable `假设与参数` block or sheet');
    expect(excelSkill).toContain('never leave assumptions only in the chat handoff');
    expect(excelSkill).toContain('native editable chart objects');
    expect(excelSkill).toContain('does not satisfy a chart request');
    expect(excelSkill).toContain('Never plot measures with different units');
    expect(excelSkill).toContain('category/value source ranges');
    expect(excelSkill).toContain('`artifact_path` in the latest create/edit `<office-artifact>` receipt');
    expect(excelSkill).toContain('Do not repeat `office_review` for an unchanged `artifact_revision`');
    expect(excelSkill).toContain('concrete blocking defect and a targeted repair');
    expect(excelSkill).toContain('Pass `preview:false` when the required `office_review` will provide the visual evidence');
    expect(excelSkill).toContain('with one `targets` array to batch-check representative formulas');
    expect(excelSkill).toContain('`mode:"text"` exposes displayed values, not formula definitions');
    expect(excelSkill).toContain('For a new workbook, reuse the sheet order supplied to `create_xlsx`');
    expect(excelSkill).toContain('Retry publication once with an exact `eligible_current_turn_paths` entry');
    expect(excelSkill).toContain('do not edit, review, or regenerate the workbook');
  });

  it('owns both single Word and single Excel deliverables after specialist retirement', () => {
    const agent = JSON.parse(fs.readFileSync(path.join(agentDir, 'agent.json'), 'utf8')) as {
      description_zh: string;
      description_en: string;
      workflow: string;
      skill_list: string[];
    };

    expect(agent.description_zh).toContain('单个或多个');
    expect(agent.description_en).toContain('one or more');
    expect(agent.description_en).not.toContain('specialist agent for a single Word, Excel');
    expect(agent.workflow).toContain('Single or multiple supported Office files stay here');
    expect(agent.workflow).toContain('`office-word`');
    expect(agent.workflow).toContain('`office-excel`');
    expect(agent.workflow).not.toContain('`office-formatting`');
    expect(agent.skill_list).toEqual(expect.arrayContaining(['c72c656eca12', '081c15ffbab4']));
  });
});
