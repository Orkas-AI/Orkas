import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

const AGENT_ID = '7e91cb9ec9e9';
const agentDir = path.join(
  process.cwd(),
  'resources',
  'builtin',
  'marketplace',
  'agents',
  AGENT_ID,
);
const builtinManifestPath = path.join(
  process.cwd(),
  'resources',
  'builtin',
  '_manifest.json',
);
const resourceAgentPath = path.resolve(
  process.cwd(),
  '..',
  'Resource',
  'agents',
  AGENT_ID,
  'agent.json',
);

function readSkill(name: string): string {
  return fs.readFileSync(path.join(agentDir, 'skills', name, 'SKILL.md'), 'utf8');
}

describe('PptMaker built-in agent evaluation', () => {
  it('ships one offline-complete canonical agent with four owner-private skills', () => {
    const agent = JSON.parse(fs.readFileSync(path.join(agentDir, 'agent.json'), 'utf8')) as {
      agent_id: string;
      name: string;
      version: string;
      min_app_version: string;
      skill_list: string[];
    };
    const builtinManifest = JSON.parse(fs.readFileSync(builtinManifestPath, 'utf8')) as {
      inventory: {
        marketplace_agents: Array<{ id: string; version: string }>;
      };
    };
    const manifestAgent = builtinManifest.inventory.marketplace_agents
      .find((entry) => entry.id === AGENT_ID);

    expect(agent).toMatchObject({
      agent_id: AGENT_ID,
      name: 'PptMaker',
      min_app_version: '1.6.1',
    });
    // `version` carries no behavior — every content change bumps it by policy,
    // so pinning an exact value only breaks this test on legitimate edits (it
    // was pinned at 1.2.5 while the agent shipped 1.2.7). What this test owns
    // is the inventory below; the version must merely exist and be well
    // formed. `min_app_version` stays pinned: it gates install compatibility
    // and is registered in the min-app-version dependency doc.
    expect(agent.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifestAgent?.version).toBe(agent.version);
    expect(agent.skill_list).toEqual([
      'ppt-router',
      'ppt-planner',
      'ppt-craft',
      'ppt-review',
      'f283632103ba',
    ]);
    expect(agent.skill_list).not.toContain('28c89fbddc27');
    expect(agent.skill_list).not.toContain('24f3757db278');
    expect(fs.existsSync(resourceAgentPath)).toBe(false);

    for (const skill of ['ppt-router', 'ppt-planner', 'ppt-craft', 'ppt-review']) {
      const source = readSkill(skill);
      expect(source).toContain(`ownerAgent: ${AGENT_ID}`);
      expect(source).not.toContain('TODO');
    }
  });

  it('locks one route before progressively loading planning, craft, and review', () => {
    const agent = JSON.parse(fs.readFileSync(path.join(agentDir, 'agent.json'), 'utf8')) as {
      workflow: string;
      standards: string[];
    };
    const router = readSkill('ppt-router');
    const planner = readSkill('ppt-planner');

    expect(agent.workflow).toContain('Read `ppt-router` first and alone');
    expect(agent.workflow).toContain('`CREATE`, `EDIT`, `REVIEW`, or `OUTLINE`');
    expect(agent.workflow).toContain('`QUICK` or `STANDARD`');
    expect(agent.workflow).toContain('Honor an explicit user review gate; otherwise continue');
    expect(agent.workflow).toContain('do not create a separate runtime execution plan');
    expect(router).toContain('next_skills');
    expect(router).toContain('execution order, not permission to preload');
    expect(planner).toContain('Presentation brief');
    expect(planner).toContain('Content boundary');
    expect(planner).toContain('Narrative outline');
    expect(planner).toContain('Slide storyboard');
    expect(planner).toContain('Adaptive design lock');
    expect(agent.standards.join('\n')).toContain('QUICK may keep them compact but may not skip them');
  });

  it('keeps internal routing private and uses plain-language progress updates', () => {
    const agent = JSON.parse(fs.readFileSync(path.join(agentDir, 'agent.json'), 'utf8')) as {
      standards: string[];
    };
    const router = readSkill('ppt-router');
    const review = readSkill('ppt-review');
    const combined = [agent.standards.join('\n'), router, review].join('\n');

    expect(combined).toContain('Never expose route/depth codes');
    expect(router).toContain('Keep them in working context only');
    expect(router).toContain('never print the route contract');
    expect(router).toContain('Never show raw codes such as `CREATE / STANDARD`');
    expect(router).toContain('正在梳理内容结构');
    expect(router).toContain('正在制作幻灯片');
    expect(router).toContain('正在逐页检查内容和版式');
    expect(review).toContain('plain-language content/design/flow result');
    expect(review).toContain('Do not expose the internal route or depth codes');
  });

  it('creates one editable native deck and protects existing sources', () => {
    const agent = JSON.parse(fs.readFileSync(path.join(agentDir, 'agent.json'), 'utf8')) as {
      workflow: string;
      standards: string[];
    };
    const craft = readSkill('ppt-craft');
    const combined = [agent.workflow, agent.standards.join('\n'), craft].join('\n');

    for (const tool of [
      'create_pptx',
      'office_read',
      'edit_office',
      'office_check',
      'office_render',
      'publish_outputs',
    ]) {
      expect(combined).toContain(`\`${tool}\``);
    }
    expect(combined).toContain('call `create_pptx` exactly once');
    expect(combined).toContain('do not call `create_pptx` again');
    expect(craft).toContain('complete slide array and `preview:false`');
    expect(craft.indexOf('Run `office_check` on that exact path'))
      .toBeLessThan(craft.indexOf('request every required initial `office_render` call'));
    expect(craft).toContain('every required initial `office_render` call together in one assistant tool-call batch');
    expect(craft).toContain('`analysis_mode:"quality_review"` on every output-deck render');
    expect(craft).toContain('default `analysis_mode:"understand"`');
    expect(craft).toContain('no model round between pages');
    expect(craft).toContain('Do not infer a construction failure from equal strings alone');
    expect(craft).toContain('accidental overlap or redundant visual hierarchy');
    expect(craft).toContain('any numeral, percentage, duration, rank, benchmark');
    expect(craft).toContain('must map to supplied or explicitly approved evidence');
    expect(craft).not.toContain('complete slide array and `preview:true`');
    expect(combined).toContain('separate validated working copy');
    expect(combined).toContain('Do not install Office libraries');
    expect(combined).toContain('patch OpenXML directly');
    expect(combined).toContain('never substitute a full-slide screenshot');
    expect(craft).toContain('supports native text, shapes, pictures, charts, tables');
    expect(craft).toContain('speaker notes');
  });

  it('supports reference-led and autonomous visual design without rigid aesthetic quotas', () => {
    const router = readSkill('ppt-router');
    const planner = readSkill('ppt-planner');
    const craft = readSkill('ppt-craft');
    const review = readSkill('ppt-review');
    const combined = `${router}\n${planner}\n${craft}\n${review}`;

    expect(router).toContain('## Visual source');
    expect(router).toContain('first-class creation path');
    expect(router).toContain('visual_source: autonomous|text-direction|reference-image|reference-deck|existing-deck');
    expect(router).toContain('reference_mode: none|inspiration|brand-source|template-source|editable-source');
    expect(router).toContain('A named reference file plus an explicit role');
    expect(router).toContain('generic client/product/content');
    expect(router).toContain('unexecuted inspection, visual-extraction');
    expect(planner).toContain('Visual source and references');
    expect(planner).toContain('visual_dna');
    expect(planner).toContain('Reference material is production input, not a routine clarification trigger');
    expect(planner).toContain('neutral titles and visibly labeled\nplaceholders or assumptions');
    expect(planner).toContain('distinguish observed evidence from planned evidence');
    expect(planner).toContain('Do not fill an uninspected reference-image record');
    expect(planner).toContain('provisional autonomous fallback');
    expect(planner).toContain('ceremonial inspection');
    expect(planner).toContain('A reference image is not a reusable slide asset');
    expect(planner).toContain('render and inspect every source slide');
    expect(planner).toContain('a missing visual reference is not a blocker');
    expect(planner).toContain('Do not force every unbranded enterprise deck');
    expect(planner).toContain('visual_focus');
    expect(planner).toContain('background_intent');
    expect(planner).toContain('reference_anchor');
    expect(planner).toContain('asset_plan');
    expect(planner).toContain('layout_mode: recipe|adapted|custom');
    expect(planner).toContain('content_budget');
    expect(planner).toContain('Swiss editorial');
    expect(planner).toContain('data journalism');
    expect(planner).toContain('13.333in × 7.5in');
    expect(planner).toContain('cover `32–44pt`');
    expect(planner).toContain('There is no numeric layout-family minimum');
    expect(planner).toContain('Build-readiness gate');
    expect(planner).toContain('Do not reject a build merely because');
    expect(planner).toContain('Planning-only visible output contract');
    expect(planner).toContain('Content boundary');
    expect(planner).toContain('does not independently verify business truth');
    expect(planner).toContain('信息与图表映射');
    expect(planner).toContain('category/series mapping');
    expect(planner).toContain('status labels such as actual, target, forecast');
    expect(planner).toContain('presentation-fidelity boundary');
    expect(planner).toContain('Do not add a filler slide merely to reach the requested count');
    expect(planner).toContain('baseline decision\nexplicitly in the visible plan');
    expect(planner).toContain('Do not silently replace a\nrequested use-case page');
    expect(planner).toContain('unsupported claim or contradict the body');
    expect(planner).toContain('actor–task–result examples');
    expect(planner).toContain('信息较少 / 信息适中 / 信息较多');
    expect(planner).toContain('not a quality gate');
    expect(planner).toContain('distinct communication job');
    expect(planner).toContain('do not\ncreate or update a separate runtime execution plan');
    expect(combined).toContain('native chart');
    expect(craft).toContain('## Execute the visual source');
    expect(craft).toContain('No reference file is required');
    expect(craft).toContain('reference_asset_reuse: allowed');
    expect(craft).toContain('with `template-source`');
    expect(craft).toContain('structurally inspect every source slide');
    expect(craft).toContain('opening, section, data, close');
    expect(craft).toContain('structurally inspect and render every source slide');
    expect(craft).toContain('required evidence steps, not optional review detail');
    expect(craft).toContain('Keep source-reference renders distinct from');
    expect(craft).toContain('exact requested output slide count');
    expect(craft).toContain('Do not keep unused template slides');
    expect(craft).toContain('missing factual copy a construction blocker');
    expect(craft).toContain('Block only mechanical or presentation-integrity failures');
    expect(craft).toContain('not a validation threshold');
    expect(craft).toContain('Recipes define relationships and content capacity, not fixed templates');
    expect(review).toContain('Never invent a numeric aesthetic score or average');
    expect(review).toContain('there is no numeric family minimum or repetition ceiling');

    expect(combined).not.toContain('Use at most three prominent colors');
    expect(combined).not.toContain('at least four families in a typical eight-slide deck');
    expect(combined).not.toContain('Never use one family more than twice in succession');
    expect(combined).not.toContain('deck-wide visual average must be at least `4.0`');
  });

  it('requires current structural and visual evidence across content, design, and coherence', () => {
    const agent = JSON.parse(fs.readFileSync(path.join(agentDir, 'agent.json'), 'utf8')) as {
      workflow: string;
      standards: string[];
    };
    const review = readSkill('ppt-review');
    const combined = [agent.workflow, agent.standards.join('\n'), review].join('\n');

    expect(review).toContain('only after current `office_check` output');
    expect(review).toContain('For a new deck, render every slide');
    expect(review).toContain('After a repair affects multiple pages');
    expect(review).toContain('together in one assistant tool-call batch');
    expect(review).toContain('Every render intended as current visual-defect evidence');
    expect(review).toContain('each with `analysis_mode:"quality_review"`');
    expect(review).toContain('default `understand` mode');
    expect(review).toContain('Do not insert a model round between page renders');
    expect(review).toContain('retry only that page');
    expect(review).toContain('Rendered image blocks are transient after the next assistant response');
    expect(review).toContain('write one concise plain-language evidence sentence before any follow-up tool calls');
    expect(review).toContain('do not rerender an unchanged `artifact_revision`');
    expect(review).toContain('keeps the same `image_revision`, do not claim a visual repair');
    expect(review).toContain('### Content');
    expect(review).toContain('### Design');
    expect(review).toContain('### Coherence');
    expect(review).toContain('### Per-slide review checklist');
    expect(review).toContain('### Whole-deck review');
    expect(review).toContain('recurs across multiple slides or a shared component');
    expect(review).toContain('call `edit_office` with `preview:false`');
    expect(review).toContain('automatic first-page preview must not run ahead of structural validation');
    expect(review).toContain('`BLOCKER`');
    expect(review).toContain('Consolidate all known defects into one edit batch where possible');
    expect(review).toContain('rerender only affected slides at a new `artifact_revision`');
    expect(review).toContain('Stop when only non-blocking warnings remain');
    expect(review).not.toContain('at most two targeted `office_render` calls total');
    expect(review).not.toContain('hard render-call budget');
    expect(review).toContain('do not publish the deck as complete');
    expect(review).toContain('Do not call `publish_outputs` until the last current-render review');
    expect(review).toContain('目标动作是');
    expect(review).toContain('[P2 实际标题] / [P5 实际标题]');
    expect(review).toContain('visual source, art direction, palette behavior, type hierarchy');
    expect(review).toContain('reference_fit');
    expect(review).toContain('Checklist results are diagnostic evidence');
    expect(review).toContain('Do not include numeric aesthetic scores');
    expect(review).toContain('Design\nPASS/WARNING/BLOCKER');
    expect(combined).toContain('invalid OpenXML');
    expect(combined).toContain('Do not publish an empty or invalid output set');
    expect(combined).toContain('target-viewer review');
  });
});
