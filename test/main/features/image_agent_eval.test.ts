import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { validateImageStudioManifest } from '../../../src/main/features/image_studio';

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
      standards: string[];
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
    expect(agent.workflow).toContain('Supplementary creative copy is allowed');
    expect(agent.workflow).toContain('limit all visible text to user-provided copy');
    expect(agent.standards.join('\n')).toContain('Default to 4:5 at 1080×1350 and PNG');
    expect(agent.standards.join('\n')).toContain('do not ask about routine canvas or export preferences');
    expect(agent.standards.join('\n')).toContain('headline plus event details, highlights, or a CTA');
    expect(agent.standards.join('\n')).toContain('read image-canvas before image-compose');
    expect(agent.standards.join('\n')).toContain('project.submit_design_review');
    expect(agent.standards.join('\n')).toContain('workspace-relative output_path ending in .png');
    expect(agent.standards.join('\n')).toContain('never hand back a completed direct image request to Commander');
    const deliveryStandard = agent.standards.find((standard) => (
      standard.includes('User-facing previews include only exported final deliverables')
    ));
    expect(deliveryStandard).toContain('never inspection snapshots, review evidence, style anchors, masks');
    expect(deliveryStandard).toContain('normally render every exported final image in its intended order');
    expect(deliveryStandard).toContain('representative final image or final contact sheet is allowed');
    expect(deliveryStandard).toContain('presentation guidance, not an export or completion gate');
    expect(deliveryStandard).toContain('before the first preview');
    expect(deliveryStandard).toContain('after the last preview');

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
    expect(agent.workflow).toContain('Complete routing and conditional planning before creating project files');
    expect(agent.workflow).toContain('After the selected production skill is read');
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
    expect(router).toContain('do not create or edit project files during routing');
    expect(craft).toContain('Skip it for crop, resize');
    expect(canvas).toContain('Skip it for a simple single-region image');
    expect(compose).toContain('Do not preload it during routing');
    expect(generate).toContain('Do not load it for `COMPOSE`');
    expect(review).toContain('Never load it at task start');
  });

  it('keeps one shipped manifest template aligned with native validation', () => {
    const router = fs.readFileSync(path.join(agentDir, 'skills', 'image-router', 'SKILL.md'), 'utf8');
    const craft = fs.readFileSync(path.join(agentDir, 'skills', 'image-craft', 'SKILL.md'), 'utf8');
    const canvas = fs.readFileSync(path.join(agentDir, 'skills', 'image-canvas', 'SKILL.md'), 'utf8');
    const compose = fs.readFileSync(path.join(agentDir, 'skills', 'image-compose', 'SKILL.md'), 'utf8');
    const generate = fs.readFileSync(path.join(agentDir, 'skills', 'image-generate', 'SKILL.md'), 'utf8');
    const match = router.match(/## Canonical image-manifest v1[\s\S]*?```json\s*([\s\S]*?)\s*```/);

    expect(match?.[1]).toBeTruthy();
    const canonicalManifest = JSON.parse(match![1]) as Record<string, unknown>;
    expect(validateImageStudioManifest(canonicalManifest).issues).toEqual([]);

    const regions = (canonicalManifest.visual_plan as { regions: Array<Record<string, unknown>> }).regions;
    expect(regions.every((region) => region.bounds !== undefined)).toBe(true);
    expect(regions.every((region) => !('x' in region) && !('y' in region))).toBe(true);
    expect(craft).toContain("template's `art_direction` object");
    expect(canvas).toContain('`regions[].bounds`');
    expect(compose).toContain('single structural source');
    expect(generate).toContain('single structural source');
    expect((compose.match(/"schema_version"/g) ?? [])).toHaveLength(0);
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
    expect(review).toContain('mandatory dimensions are the comparable baseline, not a closed list');
    expect(review).toContain('`additional_dimensions`');
    expect(review).toContain('Additional scores never raise the mandatory overall');
    expect(review).toContain('every one must meet the native dimension floor');
    expect(router).toContain('complete visible-copy allowlist');
    expect(review).toContain('any visible text outside the user\'s supplied copy as a blocker');
  });

  it('checks multi-image style consistency through the existing reference review gate', () => {
    const agent = JSON.parse(fs.readFileSync(path.join(agentDir, 'agent.json'), 'utf8')) as {
      standards: string[];
    };
    const craft = fs.readFileSync(path.join(agentDir, 'skills', 'image-craft', 'SKILL.md'), 'utf8');
    const compose = fs.readFileSync(path.join(agentDir, 'skills', 'image-compose', 'SKILL.md'), 'utf8');
    const review = fs.readFileSync(path.join(agentDir, 'skills', 'image-design-review', 'SKILL.md'), 'utf8');
    const standards = agent.standards.join('\n');

    expect(standards).toContain('first passing image as the style anchor');
    expect(standards).toContain('reference_intent.mode=guide');
    expect(standards).toContain('reference_intent.minimum_score >=85');
    expect(standards).toContain('inspect all final images side by side');
    expect(standards).toContain('Individual quality scores alone do not prove set-level style consistency');
    expect(craft).toContain('define this art direction once for the set');
    expect(compose).toContain('do not redesign the visual system per image');
    expect(review).toContain('role:"style"');
    expect(review).toContain('reference_intent.mode:"guide"');
    expect(review).toContain('Use the existing `reference_fidelity` score as the style-consistency score');
    expect(review).toContain('Separate high individual scores are not evidence of set-level consistency');
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
    expect(generate).toContain('scoped to the current user turn');
    expect(generate).toContain('fresh call scope');
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
    expect(agent.workflow).toContain('A new user turn receives a fresh generation-call scope');
    expect(agent.workflow).toContain('show the current candidate image');
    expect(compose).toMatch(/continue the native\s+chain without asking the user/);
    expect(generate).toContain('pre-dispatch failure is recorded but does not consume');
    expect(generate).toContain('deterministic zero-call repair');
    expect(generate).toContain('Never raise manifest `max_calls` or request a quota-increase form');
    expect(generate).toContain('using normal chat rather than a recovery form');
  });
});
