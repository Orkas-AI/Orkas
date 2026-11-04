import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const skillRoot = path.resolve(process.cwd(), 'resources/builtin/system/skills');
const guideRoot = path.join(skillRoot, 'orkas-guide');
const read = (file: string) => fs.readFileSync(path.join(guideRoot, file), 'utf8');

describe('shared Orkas guide editions', () => {
  it('ships one registered guide whose references remain readable in either build', () => {
    const rows = JSON.parse(fs.readFileSync(path.join(skillRoot, '_system.json'), 'utf8'));
    expect(rows.filter((row: { id: string }) => row.id === 'orkas-guide')).toEqual([
      { id: 'orkas-guide', update_at: expect.any(Number) },
    ]);
    const root = read('SKILL.md');
    expect(root).toContain('name: orkas-guide');
    expect(root).toMatch(/commercial and open-source editions/i);
    expect(root).toMatch(/commercial edition only[^\n]*paid membership/i);
    for (const [, reference] of root.matchAll(/\]\((references\/[^)#]+)(?:#[^)]*)?\)/g)) {
      expect(reference).not.toContain('..');
      expect(read(reference).trim(), reference).not.toBe('');
    }
    expect(root).toContain('(references/editions.md)');
  });

  it('separates commercial account features from local and user-owned provider access', () => {
    const editions = read('references/editions.md');
    for (const fact of ['cloud sync', 'collaboration', 'public share links', 'publication', 'automatic updates', 'iOS']) {
      expect(editions.toLowerCase(), fact).toContain(fact.toLowerCase());
    }
    expect(editions).toContain('provider OAuth');
    expect(editions).toContain('Orkas API Key');
    expect(editions).toMatch(/local[^\n]*Projects[^\n]*To-do[^\n]*Automation/i);
    expect(editions).toMatch(/no Account\/Plan\/credits page/);
    expect(editions).toContain('Settings > Models');
    expect(editions).toContain('Settings > Data');
    expect(editions).toContain('Settings > General');
  });

  it('labels hosted workflows at their owning sections', () => {
    for (const [file, section] of [
      ['projects-and-automation.md', 'Share a Project with members'],
      ['tasks-and-conversations.md', 'Share messages and results'],
      ['library-search-and-apps.md', 'Publish an app'],
      ['settings-data-and-safety.md', 'Credits'],
      ['settings-data-and-safety.md', 'Membership'],
      ['settings-data-and-safety.md', 'Sync and cloud data'],
    ]) expect(read(`references/${file}`)).toMatch(new RegExp(`## ${section}[^\\n]*commercial edition only`, 'i'));
  });
});

it('routes feature selection to the overview and distinguishes work tracking from scheduled execution', () => {
    const skill = read('SKILL.md');
    const overviewRoute = skill.split('\n').find((line) => line.startsWith('|') && line.includes('(references/getting-started.md)'));
    expect(overviewRoute).toMatch(/choose features for ongoing work/i);
    const overview = read('references/getting-started.md');
    for (const feature of ['Task / conversation', 'Project', 'Goals & rules', 'To-do', 'Auto', 'Agent', 'Skill', 'Connector', 'Library', 'Memory', 'App', 'Model', 'Workspace']) {
      expect(overview.includes(`| **${feature}** |`), feature).toBe(true);
    }
    const projectGuide = read('references/projects-and-automation.md');
    expect(projectGuide.includes('does not calculate business-metric progress')).toBe(true);
    expect(projectGuide.includes('Completing to-dos measures work progress')).toBe(true);
    expect(projectGuide.includes('auto-advance is separate from scheduled Automation')).toBe(true);
    expect(projectGuide.includes('does not start work merely because it exists')).toBe(true);
    expect(projectGuide).toContain('**Auto** on **To-do**');
    expect(projectGuide).toContain('off by default');
    expect(projectGuide).toContain('due date is a deadline');
    const resources = read('references/agents-skills-and-connectors.md');
    expect(resources.includes("caller's available connections and permissions")).toBe(true);
  });
it('retains explicit-request and accepted-offer authority without requiring a second confirmation', () => {
 const projectGuide=read('references/projects-and-automation.md');
 expect(projectGuide).toContain('when the user asks for one or accepts its offer');
 expect(projectGuide).toContain('does not require a second confirmation');
 expect(projectGuide).not.toContain('without asking first');
 const guidance=fs.readFileSync(path.resolve(process.cwd(),'src/main/prompts/followup_offer_guidance.md'),'utf8');
 expect(guidance).toContain('Create one only when the');
 const root=read('SKILL.md');
 expect(root.match(/^---\n([\s\S]*?)\n---/)?.[1].split('\n').map(l=>l.match(/^([a-z_]+):/)?.[1]).filter(Boolean)).toEqual(['name','description']);
 expect(root).toMatch(/\*\*Execute:\*\* supply the relevant product facts, prerequisites, visible results, and recovery/);
 const removal=fs.readFileSync(path.join(skillRoot,'skill-creator/references/file-deletion.md'),'utf8').replace(/\s+/g,' ');
 expect(removal.split('## Files inside a Skill')[0]).toContain('has no protocol here. The user does it:');
 expect(removal).toContain('Do not call the tool again in that turn');
});
