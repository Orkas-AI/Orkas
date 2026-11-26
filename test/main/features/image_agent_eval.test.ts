import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { validateImageStudioManifest } from '../../../src/main/features/image_studio';
import { createImageStudioTool } from '../../../src/main/model/core-agent/image-studio-tool';

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
    expect(privateSurface).not.toMatch(/workflow\.(?:run|capabilities)|ComfyUI|InvokeAI|AUTOMATIC1111|IOPaint|rembg|Real-ESRGAN/i);
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
    // The router selects canvas work from the composition's reading jobs
    // and other concrete layout constraints.
    const canvasSelection = router.split('\n').find(line => line.startsWith('- Add `image-canvas`'));
    expect(canvasSelection).toMatch(/distinct visual regions.*explicit reading order.*exact layout constraints.*region-bound references/i);
    expect(canvasSelection).toMatch(/main visual.*separate block of facts or supporting copy.*distinct regions.*one artboard/i);
    expect(router).toMatch(/establish art direction and canvas before authoring/i);
    expect(router).toMatch(/Add `image-compose` for `COMPOSE`/i);
    // The review-before-export sequence moved into the production skills, which
    // are read at the point it applies; standards keep the export contract only.
    const designReview = fs.readFileSync(
      path.join(agentDir, 'skills', 'image-design-review', 'SKILL.md'), 'utf8',
    );
    const compose = fs.readFileSync(path.join(agentDir, 'skills', 'image-compose', 'SKILL.md'), 'utf8');
    expect(designReview).toMatch(/project\.submit_design_review/);
    const vectorPdfExport = compose.split('\n').find(line => line.includes('`format:"pdf"`'));
    expect(vectorPdfExport).toMatch(/SVG[\s\S]*review[\s\S]*project\.export[\s\S]*workspace-relative `\.pdf`/i);
    expect(compose).toMatch(/PSD preparation[^\n]*workspace-relative `\.png`[^\n]*After PNG export succeeds[^\n]*PSD/i);
    expect(compose).not.toMatch(/first `project\.export` call[^\n]*`\.png`/i);
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
    expect(agent.workflow).toMatch(/Read `image-router` first[^\n]*add a vector PDF[^\n]*existing artwork/i);

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
    // Discovery must expose conversion before the production instructions load.
    const composeSelection = router.split('\n').find(line => line.startsWith('- Add `image-compose`'))!;
    const vectorPdfFollowUp = router.split('\n').find(line => line.startsWith('- For a vector PDF follow-up'));
    expect(vectorPdfFollowUp).toMatch(/retained (?:HTML or SVG|SVG or HTML).*load `image-compose`/i);
    for (const entry of [composeSelection, compose.split('\n').find(line => line.startsWith('description_en:'))!,
      compose.split('\n').find(line => line.startsWith('Read this skill'))!]) {
      expect(entry).toMatch(/SVG\/HTML conversion/);
      expect(entry).toMatch(/requested vector PDF delivery/);
    }
    expect(compose.split('\n').find(line => line.startsWith('description_zh:'))).toMatch(/SVG\/HTML.*矢量 PDF/);
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
    expect(review).toContain('`review_findings:[]`');
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
    const contract = fs.readFileSync(path.join(agentDir, 'skills', 'image-compose', 'references', 'multi-image-sets.md'), 'utf8');
    // The same requirements must be available before pixels exist and still
    // govern actual review; relocating them does not lower acceptance.
    expect(contract).toMatch(/reference_intent\.mode:\s*"guide"/i);
    expect(contract).toMatch(/reference_intent\.minimum_score` to at least 85/i);
    expect(contract).toContain('inspect all final images side by side');
    expect(contract).toMatch(/individual scores are not evidence of set-level consistency/i);
    expect(craft).toContain('define this art direction once for the set');
    expect(craft).toMatch(/authored compositions follow the current artifact review handoff/i);
    expect(contract).toMatch(/multiple non-generation images as one set/i);
    expect(contract).toContain('do not redesign the visual system per image');
    expect(contract).toContain('role:"style"');
    expect(contract).toContain('Use the existing `reference_fidelity` score as the style-consistency score');
    for (const body of [compose, review]) {
      expect(body).toContain('multi-image-sets.md)');
      expect(body).not.toContain('reference_intent.minimum_score` to at least 85');
    }
  });

  it('makes the authored-set contract reachable for planning while keeping review evidence-gated', () => {
    const skills = path.join(agentDir, 'skills');
    const owners = ['image-router', 'image-compose', 'image-design-review'];
    const targets = owners.map(owner => {
      const body = fs.readFileSync(path.join(skills, owner, 'SKILL.md'), 'utf8');
      const link = [...body.matchAll(/\]\(([^)]+multi-image-sets\.md)\)/g)];
      expect(link, `${owner} must route to the shared contract`).toHaveLength(1);
      const reference = link[0][1];
      // Cross-Skill links use the advertised logical namespace; local links
      // remain relative to their owning Skill.
      const target = reference.startsWith('@skill/')
        ? path.resolve(skills, reference.slice('@skill/'.length))
        : path.resolve(skills, owner, reference);
      expect(fs.statSync(target).isFile(), `${owner} contract must exist`).toBe(true);
      return target;
    });
    expect(new Set(targets).size).toBe(1);
    expect(targets[0]).toBe(path.resolve(skills, 'image-compose/references/multi-image-sets.md'));
    const router = fs.readFileSync(path.join(skills, 'image-router/SKILL.md'), 'utf8');
    expect(router).toMatch(/After route lock[^\n]*non-generation[^\n]*plan[^\n]*multi-image-sets\.md/i);
    expect(router).toMatch(/planning-only[^\n]*read-only/i);
    const review = fs.readFileSync(path.join(skills, 'image-design-review/SKILL.md'), 'utf8');
    expect(review).toMatch(/Read this skill only after[\s\S]*visual_evidence\.attached:true/);
    expect(review).toMatch(/Never use it for a host-verified `is_generation:true` artifact/);
  });

  it('grounds the set fidelity score in visible agreement and deviations rather than a percentage claim', () => {
    const shared = fs.readFileSync(path.join(agentDir, 'skills/image-compose/references/multi-image-sets.md'), 'utf8');
    expect(shared).toMatch(/review_scope[\s\S]*observed[\s\S]*preserved.*axes/i);
    expect(shared).toMatch(/review_findings[\s\S]*fix/i);
    expect(shared).toMatch(/85[\s\S]*not[\s\S]*similarity percentage/i);
    expect(shared).toMatch(/same.*palette[\s\S]*new content/i);
    expect(shared).toMatch(/changed.*stroke[\s\S]*fix/i);
    expect(shared).toContain('reference_intent.minimum_score` to at least 85');
  });

  it('keeps provider generation quoted, budgeted, and inspected', () => {
    const generate = fs.readFileSync(path.join(agentDir, 'skills', 'image-generate', 'SKILL.md'), 'utf8');
    expect(generate).toContain('pending_uncertain');
    expect(generate).toContain('durable generation transaction');
    expect(generate).toContain('Respect `generation_budget.max_calls` within the current user turn');
    expect(generate).toContain('fresh call scope');
    expect(generate).toContain('Provider availability and billing disclosure');
    expect(generate).toContain('generation.quote');
    expect(generate).toContain('Never infer a price');
    expect(generate).toContain('checks provider availability again');
    expect(generate).toContain('may bill through its own account');
    expect(generate).toContain('project call slots consumed');
    expect(generate).toMatch(/For `is_generation:true`.*returns `project\.export`.*do not load `image-design-review`/i);
    expect(fs.existsSync(path.join(agentDir, 'skills', 'image-compose', 'scripts', 'structured_visual.js'))).toBe(true);
    expect(fs.existsSync(path.join(agentDir, 'skills', 'image-compose', 'scripts', 'image_asset.js'))).toBe(true);
    expect(fs.existsSync(path.join(agentDir, 'skills', 'image-generate', 'references', 'external-workflows.md'))).toBe(false);
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

  // 2026-11-19: the review Skill told the model to send `findings`, while
  // project.submit_design_review reads `review_findings`. The tool schema is
  // the oracle: every review field it accepts is named exactly.
  it('names the design-review fields the image_studio tool actually reads', () => {
    const review = fs.readFileSync(path.join(agentDir, 'skills', 'image-design-review', 'SKILL.md'), 'utf8');
    const properties = Object.keys((createImageStudioTool({ userId: 'review-field-audit', agentId: AGENT_ID })
      .inputSchema as { properties: Record<string, unknown> }).properties);
    const reviewFields = properties.filter((name) => name.startsWith('review_'));
    expect(reviewFields).toEqual(expect.arrayContaining(['review_verdict', 'review_scope', 'review_findings']));
    for (const field of [...reviewFields, 'evidence_path', 'quality_scores', 'additional_dimensions']) {
      expect(properties).toContain(field);
      expect(review).toContain(`\`${field}\``);
    }
    expect(review).not.toMatch(/`findings[`:]/);
  });
});
