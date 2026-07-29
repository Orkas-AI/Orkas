import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

const AGENT_ID = '814b61b027f0';
const agentDir = path.join(process.cwd(), 'resources', 'builtin', 'marketplace', 'agents', AGENT_ID);
const builtinManifestPath = path.join(process.cwd(), 'resources', 'builtin', '_manifest.json');

describe('ImageStudio built-in agent evaluation', () => {
  it('is a bundled agent with a minimal complete skill set', () => {
    const agent = JSON.parse(fs.readFileSync(path.join(agentDir, 'agent.json'), 'utf8')) as {
      agent_id: string;
      name: string;
      skill_list: string[];
      workflow: string;
      version: string;
    };
    const builtinManifest = JSON.parse(fs.readFileSync(builtinManifestPath, 'utf8')) as {
      inventory: {
        marketplace_agents: Array<{ id: string; version: string }>;
      };
    };
    const manifestAgent = builtinManifest.inventory.marketplace_agents
      .find((entry) => entry.id === AGENT_ID);
    expect(agent.agent_id).toBe(AGENT_ID);
    expect(agent.name).toBe('ImageStudio');
    expect(agent.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifestAgent?.version).toBe(agent.version);
    expect(agent.skill_list).toEqual([
      'image-router',
      'image-craft',
      'image-canvas',
      'image-compose',
      'image-generate',
      'image-design-review',
    ]);
    expect(agent.workflow).toContain('COMPOSE');
    expect(agent.workflow).toContain('HYBRID');
    expect(agent.workflow).toContain('GENERATE');
    expect(agent.workflow).toContain('EDIT');
    expect(agent.workflow).toContain('image_studio');
    expect(agent.workflow).toContain('workflow.run');
    expect(agent.workflow).toContain('generation.quote');
    expect(agent.workflow).toContain('Never calculate or hard-code provider prices locally');
    expect(agent.workflow).toContain('rechecks provider availability immediately');
    expect(agent.workflow).toContain('pending_uncertain');
    expect(agent.workflow).toContain('Private skill scripts own evolving authoring');
    expect(agent.workflow).toContain('0-100 quality scores');

    for (const skill of agent.skill_list) {
      const source = fs.readFileSync(path.join(agentDir, 'skills', skill, 'SKILL.md'), 'utf8');
      expect(source).toContain(`ownerAgent: ${AGENT_ID}`);
      expect(source).not.toContain('TODO');
    }
  });

  it('loads private skills progressively instead of preloading the full bundle', () => {
    const agent = JSON.parse(fs.readFileSync(path.join(agentDir, 'agent.json'), 'utf8')) as {
      workflow: string;
    };
    expect(agent.workflow).toContain('Read image-router first and alone');
    expect(agent.workflow).toContain('same parallel tool batch');
    expect(agent.workflow).toContain('Do not preload or prefetch all private skills');
    expect(agent.workflow).toContain('Read image-craft only');
    expect(agent.workflow).toContain('Read image-canvas only');
    expect(agent.workflow).toContain('Read image-design-review only after');
    expect(agent.workflow).toContain('Do not read it at task start');

    const router = fs.readFileSync(path.join(agentDir, 'skills', 'image-router', 'SKILL.md'), 'utf8');
    const craft = fs.readFileSync(path.join(agentDir, 'skills', 'image-craft', 'SKILL.md'), 'utf8');
    const canvas = fs.readFileSync(path.join(agentDir, 'skills', 'image-canvas', 'SKILL.md'), 'utf8');
    const compose = fs.readFileSync(path.join(agentDir, 'skills', 'image-compose', 'SKILL.md'), 'utf8');
    const generate = fs.readFileSync(path.join(agentDir, 'skills', 'image-generate', 'SKILL.md'), 'utf8');
    const review = fs.readFileSync(path.join(agentDir, 'skills', 'image-design-review', 'SKILL.md'), 'utf8');
    expect(router).toContain('first and alone');
    expect(router).toContain('phased `next_skills`');
    expect(craft).toContain('Skip it for crop, resize');
    expect(canvas).toContain('Skip it for a simple single-region image');
    expect(compose).toContain('Do not preload it during routing');
    expect(generate).toContain('Do not load it for `COMPOSE`');
    expect(review).toContain('Never load it at task start');
  });

  it('makes the zero-call route and review gate explicit', () => {
    const router = fs.readFileSync(path.join(agentDir, 'skills', 'image-router', 'SKILL.md'), 'utf8');
    const canvas = fs.readFileSync(path.join(agentDir, 'skills', 'image-canvas', 'SKILL.md'), 'utf8');
    const compose = fs.readFileSync(path.join(agentDir, 'skills', 'image-compose', 'SKILL.md'), 'utf8');
    const review = fs.readFileSync(path.join(agentDir, 'skills', 'image-design-review', 'SKILL.md'), 'utf8');
    expect(router).toContain('zero image-generation calls');
    expect(router).toContain('numeric `schema_version:1`');
    expect(canvas).toContain('`hero`, `support`, `copy`, `decoration`, or `background`');
    expect(canvas).toContain('`detail_prompts` as a string array');
    expect(canvas).toContain('`reference_ids` as a string array');
    expect(compose).toContain('Do not use scripts, CDNs');
    expect(compose).toContain('structured_visual');
    expect(compose).toContain('image_asset');
    expect(compose).toContain('project.export');
    expect(compose).toContain('No-runtime production contract');
    expect(compose).toContain('one distinctive signature device tied to the subject');
    expect(compose).toContain('geometry/material and placement');
    expect(compose).toContain('copy/date/time/place accuracy');
    expect(compose).toContain('safe margins');
    expect(compose).toContain('thumbnail legibility');
    expect(compose).toContain('reference rights or provenance');
    expect(compose).toContain('Every item needs a concrete pass criterion');
    expect(compose).toContain('not only a pending label');
    expect(review).toContain('exact evidence path');
    expect(review).toContain('`quality_scores` as one object');
    expect(review).toContain('`findings:[]`');
    expect(review).toContain('intent_alignment');
    expect(review).toContain('overall >= 80');
  });

  it('keeps external workflow execution private, host-bound, and budgeted', () => {
    const generate = fs.readFileSync(path.join(agentDir, 'skills', 'image-generate', 'SKILL.md'), 'utf8');
    expect(generate).toContain('workflow.capabilities');
    expect(generate).toContain('AUTOMATIC1111');
    expect(generate).toContain('IOPaint');
    expect(generate).toContain('Real-ESRGAN');
    expect(generate).toContain('SAM/SAM2');
    expect(generate).toContain('Never accept, construct, print, or persist');
    expect(generate).toContain('pending_uncertain');
    expect(generate).toContain('durable generation budget');
    expect(generate).toContain('Provider availability and billing disclosure');
    expect(generate).toContain('generation.quote');
    expect(generate).toContain('Never infer a price');
    expect(generate).toContain('checks provider availability again');
    expect(generate).toContain('does not use in-app billing');
    expect(generate).toContain('project call slots consumed');
    expect(generate).toContain('request.sd_keep_unmasked_area:true');
    expect(generate).toContain('concrete, executable fields');
    expect(generate).toContain('project.submit_design_review');
    expect(fs.existsSync(path.join(agentDir, 'skills', 'image-compose', 'scripts', 'structured_visual.js'))).toBe(true);
    expect(fs.existsSync(path.join(agentDir, 'skills', 'image-compose', 'scripts', 'image_asset.js'))).toBe(true);
    expect(fs.existsSync(path.join(agentDir, 'skills', 'image-generate', 'references', 'external-workflows.md'))).toBe(true);
  });

  it('continues technical recovery without forms and surfaces the current candidate before stopping', () => {
    const agent = JSON.parse(fs.readFileSync(path.join(agentDir, 'agent.json'), 'utf8')) as {
      workflow: string;
    };
    const compose = fs.readFileSync(path.join(agentDir, 'skills', 'image-compose', 'SKILL.md'), 'utf8');
    const generate = fs.readFileSync(path.join(agentDir, 'skills', 'image-generate', 'SKILL.md'), 'utf8');

    expect(agent.workflow).toContain('call project.status once');
    expect(agent.workflow).toContain('current_candidate and recovery_context');
    expect(agent.workflow).toContain('Never ask the user to approve technical recovery or require a form');
    expect(agent.workflow).toContain('A direct user message is authoritative');
    expect(agent.workflow).toContain('exceeding the planned paid-generation budget');
    expect(agent.workflow).toContain('show the current candidate image');
    expect(compose).toMatch(/continue the native\s+chain without asking the user/);
    expect(generate).toContain('pre-dispatch failure is recorded but does not consume');
    expect(generate).toContain('deterministic zero-call repair');
    expect(generate).toContain('no recovery form is required');
  });
});
