import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { validateImageStudioManifest } from '../../../src/main/features/image_studio';

const AGENT_ID = '814b61b027f0';
const agentDir = path.join(process.cwd(), 'resources', 'builtin', 'marketplace', 'agents', AGENT_ID);
const builtinManifestPath = path.join(process.cwd(), 'resources', 'builtin', '_manifest.json');

describe('ImageStudio built-in agent evaluation', () => {
  it('is an open built-in bundle with a minimal complete skill set', () => {
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
    const privateSurface = agent.skill_list
      .map((skill) => fs.readFileSync(path.join(agentDir, 'skills', skill, 'SKILL.md'), 'utf8'))
      .join('\n');
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
    expect(privateSurface).toContain('image_studio');
    expect(privateSurface).toContain('workflow.run');
    expect(privateSurface).toContain('generation.quote');
    expect(privateSurface).toContain('Never infer a price');
    expect(privateSurface).toContain('checks provider availability again');
    expect(privateSurface).toContain('pending_uncertain');
    expect(agent.workflow).toContain('load only the route-specific image Skills');
    expect(privateSurface).toContain('0-100 `score`');
    expect(privateSurface).toContain('Supplementary creative copy is allowed');
    expect(privateSurface).toMatch(/visible text outside the user's supplied copy as a blocker/i);
    const standards = agent.standards.join('\n');
    expect(agent.standards).toHaveLength(5);
    const router = fs.readFileSync(path.join(agentDir, 'skills', 'image-router', 'SKILL.md'), 'utf8');
    expect(router).toMatch(/clear zero-input poster or social graphic[\s\S]*low-risk defaults/i);
    expect(router).toMatch(/routine canvas and export choices are low-risk defaults/i);
    expect(router).toMatch(/choose them without asking and state the chosen defaults in the delivery/i);
    expect(privateSurface).toMatch(/multiple meaningful regions/i);
    expect(privateSurface).toMatch(/Skip it for a simple single-region image/i);
    expect(agent.workflow.indexOf('`image-craft`')).toBeLessThan(agent.workflow.indexOf('`image-canvas`'));
    expect(privateSurface).toContain('COMPOSE');
    expect(privateSurface).toContain('image-compose');
    expect(router).toMatch(/Add `image-canvas` only for multiple meaningful regions/i);
    const designReview = fs.readFileSync(
      path.join(agentDir, 'skills', 'image-design-review', 'SKILL.md'), 'utf8',
    );
    const compose = fs.readFileSync(path.join(agentDir, 'skills', 'image-compose', 'SKILL.md'), 'utf8');
    expect(designReview).toMatch(/project\.submit_design_review/);
    expect(compose).toMatch(/first `project\.export` call[\s\S]*workspace-relative `output_path` ending in `\.png`/i);
    expect(compose).toMatch(/instead of handing a completed direct request back to Commander/i);
    expect(compose).toMatch(/Show only exported final deliverables unless the user asks for review evidence/i);
    expect(compose).toMatch(/before the first preview/i);
    expect(compose).toMatch(/nothing after the last preview/i);
    expect(compose).toMatch(/host may add its own produced-file footer/i);
    // A completed poster delivery is the artifact, not an internal scorecard.
    expect(standards).toMatch(/final media, links, and specs/i);
    expect(standards).toMatch(/routes, call counts, scores, and passed checks stay internal unless requested/i);
    expect(compose).not.toMatch(/briefly name the concrete checks that passed/i);
    expect(standards).toMatch(/Blockers show the candidate, findings, and next option/i);
    expect(designReview).toMatch(/Preview every exported image in its intended order/i);
    expect(designReview).toMatch(/contact sheet is enough when the user asked for a summary/i);
    expect(designReview).toMatch(/never withhold or delay a passing export/i);

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
    expect(agent.workflow).toContain('Read `image-router` first');
    expect(agent.workflow).toContain('load only the route-specific image Skills');

    const router = fs.readFileSync(path.join(agentDir, 'skills', 'image-router', 'SKILL.md'), 'utf8');
    const craft = fs.readFileSync(path.join(agentDir, 'skills', 'image-craft', 'SKILL.md'), 'utf8');
    const canvas = fs.readFileSync(path.join(agentDir, 'skills', 'image-canvas', 'SKILL.md'), 'utf8');
    const compose = fs.readFileSync(path.join(agentDir, 'skills', 'image-compose', 'SKILL.md'), 'utf8');
    const generate = fs.readFileSync(path.join(agentDir, 'skills', 'image-generate', 'SKILL.md'), 'utf8');
    const review = fs.readFileSync(path.join(agentDir, 'skills', 'image-design-review', 'SKILL.md'), 'utf8');
    expect(router).toContain('first and alone');
    expect(router).toContain('phased `next_skills`');
    expect(router).toMatch(/After route lock, planning and production skills already selected for the task may be read together/);
    expect(router).toMatch(/establish art direction and canvas before authoring/);
    expect(router).toMatch(/read all required instructions before creating project files/);
    expect(router).not.toContain('Read each skill only when its phase begins');
    expect(canvas).toMatch(/establish it with `image-craft` before designing the canvas/);
    expect(canvas).not.toContain('read `image-craft` first');
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

  it('preserves craft exclusions through the canonical manifest consumer', () => {
    const read = (skill: string) => fs.readFileSync(path.join(agentDir, 'skills', skill, 'SKILL.md'), 'utf8');
    const template = JSON.parse(read('image-router').match(/```json\s*([\s\S]*?)\s*```/)![1]);
    const craft = read('image-craft');
    const directionFields = [...craft.matchAll(/^\d+\. `([^`]+)`:/gm)].map((match) => match[1]);
    // Follow the authored field placement, then check the real normalization
    // boundary; an unsupported eighth art-direction field must fail this case.
    expect(directionFields.sort()).toEqual(Object.keys(template.art_direction).sort());
    expect(craft).toMatch(/`brief\.must_avoid`/);
    const exclusions = ['watermark', 'unrequested logo'];
    template.brief.must_avoid = exclusions;
    const result = validateImageStudioManifest(template);
    expect(result.issues).toEqual([]);
    expect(result.manifest?.brief.must_avoid).toEqual(exclusions);
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

  it('keeps generated-raster visual review disabled and billable repair user-authorized', () => {
    const agent = JSON.parse(fs.readFileSync(path.join(agentDir, 'agent.json'), 'utf8')) as {
      workflow: string;
    };
    const router = fs.readFileSync(path.join(agentDir, 'skills', 'image-router', 'SKILL.md'), 'utf8');
    const generate = fs.readFileSync(path.join(agentDir, 'skills', 'image-generate', 'SKILL.md'), 'utf8');
    const review = fs.readFileSync(path.join(agentDir, 'skills', 'image-design-review', 'SKILL.md'), 'utf8');

    expect(agent.workflow).toMatch(/current artifact evidence/i);
    expect(router).toMatch(/normal budget per user turn is one call/i);
    expect(router).toMatch(/visual finding by itself is not authorization/i);
    expect(router).toMatch(/route labels do not establish a review exemption/i);
    expect(generate).toMatch(/derives `is_generation` from the exact production record/i);
    expect(generate).toMatch(/never requests quality scores/i);
    expect(generate).toMatch(/Do not load `image-design-review`/i);
    expect(generate).toMatch(/Never start another provider call based on an ImageStudio post-generation judgment/i);
    expect(review).toMatch(/Never use it for a host-verified `is_generation:true` artifact/i);
  });

  it('reviews composed sets while generated sets remain provider-owned', () => {
    const agent = JSON.parse(fs.readFileSync(path.join(agentDir, 'agent.json'), 'utf8')) as {
      standards: string[];
    };
    const craft = fs.readFileSync(path.join(agentDir, 'skills', 'image-craft', 'SKILL.md'), 'utf8');
    const compose = fs.readFileSync(path.join(agentDir, 'skills', 'image-compose', 'SKILL.md'), 'utf8');
    const review = fs.readFileSync(path.join(agentDir, 'skills', 'image-design-review', 'SKILL.md'), 'utf8');
    const standards = agent.standards.join('\n');

    expect(standards).toMatch(/set preserves the approved anchor identity/i);
    // The reference mechanics moved into image-design-review, which is read at
    // the point they apply. `review` is already loaded above.
    expect(review).toMatch(/reference_intent\.mode:\s*"guide"/i);
    expect(review).toMatch(/reference_intent\.minimum_score` to at least 85/i);
    expect(review).toMatch(/reference_intent\.minimum_score` to at least 85/i);
    expect(review).toContain('inspect all final images side by side');
    expect(review).toMatch(/individual scores are not evidence of set-level consistency/i);
    expect(craft).toContain('define this art direction once for the set');
    expect(craft).toMatch(/authored compositions follow the current artifact review handoff/i);
    expect(review).toMatch(/multiple non-generation images as one set/i);
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

    expect(agent.workflow).toContain('Apply recoverable corrections to that candidate');
    expect(agent.workflow).toContain('present the current candidate, concrete findings, preserved work, and next option');
    expect(compose).toMatch(/continue the native\s+chain without asking the user/);
    expect(generate).toContain('pre-dispatch failure is recorded but does not consume');
    expect(generate).toContain('deterministic zero-call repair');
    expect(generate).toContain('Never raise manifest `max_calls` or request a quota-increase form');
    expect(generate).toContain('using normal chat rather than a recovery form');
  });
});
