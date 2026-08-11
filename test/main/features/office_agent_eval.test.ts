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
      workflow: string;
      standards: string[];
      skill_list: string[];
    };
    const excelSkill = fs.readFileSync(excelSkillPath, 'utf8');
    const standards = agent.standards.join('\n');

    expect(agent.skill_list).toContain('081c15ffbab4');
    expect(agent.workflow).toContain('Resolve existing inputs before asking for files');
    expect(agent.workflow).toContain('call `search_files` once with a narrow extension/name query');
    expect(agent.workflow).toContain('Never show a file-upload form or claim the source is missing before this lookup');
    expect(agent.workflow).toContain('do not call `publish_outputs`, including with an empty `paths` list');
    expect(standards).toContain('one literal extension-glob search');
    expect(standards).toContain('not semantic topic words such as contract or business data');
    expect(standards).toContain('`query: "*"` plus `include_glob`');
    expect(standards).toContain('calling the matching built-in create tool is mandatory');
    expect(standards).toContain('must not construct, rewrite, or patch the final Office package');
    expect(standards).toContain('Create one file per requested artifact');
    expect(standards).toContain('visible editable assumptions/parameters block');
    expect(standards).toContain('native editable chart objects');
    expect(standards).toContain('a source table or insertion instruction alone is not a chart');
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
  });
});
