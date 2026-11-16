import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const shippedAgent = JSON.parse(readFileSync(
  new URL('../../resources/builtin/marketplace/agents/bcfcb4921dce/agent.json', import.meta.url),
  'utf8',
)) as { agent_id: string; knowhow: string[]; standards: string[]; workflow: string };

const skillBody = (name: string): string => readFileSync(
  new URL(`../../resources/builtin/marketplace/agents/bcfcb4921dce/skills/${name}/SKILL.md`, import.meta.url),
  'utf8',
);

describe('UIDesigner shipped source-authority contracts', () => {
it('keeps repo source read-only until the user asks for code changes', () => {
    expect(shippedAgent.workflow).toMatch(
      /repo source is read-only unless the user explicitly asked for code changes/i,
    );
    expect(shippedAgent.workflow).toMatch(/deliver the design plus the exact files and edits you propose/i);
    expect(shippedAgent.standards.join('\n')).toMatch(
      /repo source is unchanged unless the user asked for code changes/i,
    );

    const executor = skillBody('ui-design-executor');
    expect(executor).toContain('## Repo Source Is Read-Only Until Asked');
    // A write gate that only names the write tools is not a gate: the shell
    // was the actual escape route in the incident above.
    expect(executor).toMatch(/No `bash` that writes there either/);
    expect(executor).toMatch(/`<name>-2\.<ext>`/);
    expect(executor).toMatch(/change proposal naming each file/i);

    // The workspace skill used to open with "edit the existing components,
    // tokens, and routes in place" as an unconditional mode.
    expect(skillBody('ui-artifact-workspace')).toMatch(
      /only when the user explicitly asked for changes to that repo's source/i,
    );
    // A review request is not a patch request.
    expect(skillBody('ui-design-review')).toMatch(/A review ends at the findings/i);
  });

it('keeps only UIDesigner routing boundaries resident and delegates source mechanics to routed skills', () => {
    const workflow = shippedAgent.workflow;
    expect(workflow).toContain('### 1. Own The Output');
    expect(workflow).toContain('### 2. Load Minimally');
    expect(workflow).toMatch(/Start with `ui-design-executor`/);
    expect(workflow).toMatch(/add `ui-artifact-workspace` for standalone\/revision work/i);
    expect(workflow).toMatch(/`ui-design-source` whenever existing UI or another inspectable source constrains fidelity/i);
    expect(workflow).toMatch(/existing UI code is readable, make it the primary reconstruction source whether or not the project can run/i);
    expect(workflow).toMatch(/reconstruct the unchanged shell, add only the requested change; preserve manual edits/i);
    expect(workflow).toMatch(/Run deterministic validation after the final edit/i);
    expect(workflow).toMatch(/no claim beyond evidence/i);

    // Detailed source procedures are conditional. Keeping their headings out
    // of the resident workflow prevents every UIDesigner turn from paying for
    // rules that only source-constrained work needs.
    expect(workflow).not.toContain('## Source Authority Map');
    expect(workflow).not.toContain('## Change Boundary');
    expect(workflow).not.toContain('## Code-First HTML Reconstruction');

    const executor = skillBody('ui-design-executor');
    expect(executor).toContain('## Existing-Product Extension Gate');
    expect(executor).toMatch(/A Source Authority Map covering every material source/i);
    expect(executor).toMatch(/`Preserve`, `Change`, and `Derive` boundaries/);
    expect(executor).toMatch(/route\/page-to-component dependency trace and code-to-HTML mapping/i);
    expect(executor).toMatch(/structurally translate JSX\/TSX, Vue, Svelte/i);
    expect(executor).toMatch(/Reserve pixel-exact or visual-match claims for fresh source\/result rendering/i);

    const source = skillBody('ui-design-source');
    expect(source).toContain('## Resolve Relationship And Source Authority');
    expect(source).toContain('## Source Authority Map');
    expect(source).toContain('## Change Boundary');
    expect(source).toContain('## Code-First HTML Reconstruction');
    expect(source).toMatch(/code-to-HTML mapping for the preserved shell and the changed region/i);
  });
  it('keeps the shipped resource privacy and evidence boundaries explicit', () => {
    const alwaysOnProfile = [shippedAgent.workflow, ...shippedAgent.standards].join('\n');
    expect(shippedAgent.knowhow).toHaveLength(5);
    expect(shippedAgent.standards).toHaveLength(5);
    expect(alwaysOnProfile).toMatch(/explicit final format/i);
    expect(alwaysOnProfile).toMatch(/Exact\/Adaptive/i);
    expect(alwaysOnProfile).toMatch(/claims cite only executed evidence/i);
    expect(alwaysOnProfile).toMatch(/no secret or raw credential is persisted/i);
    expect(alwaysOnProfile).not.toMatch(/revisions require desktop\/mobile previews/i);
    expect(alwaysOnProfile).not.toMatch(/target=responsive for responsive work/i);

  });

  it('normalizes the completion router into always-on production guidance', async () => {
    const agents = await import('../../src/main/features/agents');
    const bus = await import('../../src/main/features/group_chat/bus');
    const normalized = agents.normalizeAgent(shippedAgent, 'marketplace');

    expect(normalized?.profile?.knowhow?.[0]).toBe(shippedAgent.knowhow[0]);
    expect(normalized?.profile?.standards?.slice(0, 4)).toEqual(shippedAgent.standards.slice(0, 4));

    const guidance = bus._buildAgentRuntimeGuidanceForTest(normalized?.profile);
    expect(guidance).toContain('### Delivery standards');
    expect(guidance).not.toContain(shippedAgent.knowhow[0]);
    expect(guidance).toMatch(/inaccessible exact source remains a stated limitation/i);
    expect(guidance).toMatch(/requested workflow outcome is reachable/i);
    expect(guidance).toMatch(/claims cite only executed evidence/i);

  });

  /**
   * 2026-10-07: a home-page redesign took 17 revisions. The ordinary route
   * never loaded a skill that judged layout or polish, re-drew the product
   * instead of reusing it, patched copy into slots of the wrong level, and
   * added states and buttons nobody asked for. The rules that answer each of
   * those live in the always-loaded skills; html_preview's measured design
   * warnings are covered in html_preview.test.ts.
   */
  it('keeps visual craft and live-product authority in the always-loaded route', () => {
    const ordinary = [shippedAgent.workflow, skillBody('ui-design-executor'), skillBody('ui-artifact-workspace'), ...shippedAgent.standards].join('\n\n');
    expect(ordinary).toContain('## Visual Craft Baseline');
    expect(ordinary).not.toContain('## skill: ui-taste');
    expect(ordinary).not.toContain('## skill: ui-craft-checks');
    expect(ordinary).toMatch(/parallel[\s\S]{0,120}same component, heading level, size, weight, width, and alignment/i);
    expect(ordinary).toMatch(/9 → 3×3, not 5\+4/);
    expect(ordinary).toMatch(/each baseline item is either `ok` with what was compared, or names the element, the problem, and the fix/i);
    expect(ordinary).toMatch(/Fix every design warning or state why it stays/i);
    expect(ordinary).toMatch(/written visual review against the executor's Visual Craft Baseline/i);
    expect(shippedAgent.standards.join('\n')).toMatch(/standalone artifacts?[^.]*visual[- ]review (?:evidence|record)/i);

    // A layout redesign of an existing screen keeps the product's visual layer.
    expect(ordinary).toMatch(/does not license a new visual language/i);
    expect(skillBody('ui-design-source')).toMatch(/Redesign scope is per layer/);
    expect(ordinary).toMatch(/re-read the repo component, copy, and styles when the user refers to the live product/i);
    expect(ordinary).toMatch(/record the product source it points to/i);

    // Structural revisions replace the region instead of stacking overrides.
    expect(ordinary).toMatch(/never stack override blocks at the end of a stylesheet/i);
    expect(ordinary).toMatch(/rewrite its markup and style block together/i);

    // States and controls need a caller; checklists alone do not add them.
    expect(ordinary).toMatch(/populated and empty by default/i);
    expect(ordinary).toMatch(/do not add a demo state switcher/i);
    expect(ordinary).toMatch(/Do not invent buttons, chips, links, or prefill shortcuts/i);
    expect(ordinary).not.toMatch(/populated, loading, empty, error, and partial\/stale when the surface actually fetches/i);
    expect(skillBody('ui-craft-checks')).toMatch(/An unrequested demo state switcher is not required/);
  });

  /**
   * 2026-10-09: a project-detail layout redesign passed every baseline item
   * yet only removed borders. Its own review never compared against the
   * user's screenshot, never asked why rows left most of a wide pane empty,
   * and accepted native selects and letter avatars in place of product
   * controls. The review lists weak points without forcing a fix, and a single
   * repair round keeps it from looping.
   */
  it('diagnoses a redesign, fits space to content, and reviews against the source in one round', () => {
    const ordinary = [shippedAgent.workflow, skillBody('ui-design-executor'), skillBody('ui-artifact-workspace'), ...shippedAgent.standards].join('\n\n');
    expect(ordinary).toMatch(/a diagnosis: at most three concrete causes read from their screenshot/i);
    expect(ordinary).toMatch(/Every change answers one cause; the final review checks each/i);
    expect(ordinary).toMatch(/real text lengths and where they are truncated/i);
    expect(ordinary).toMatch(/the layout layer is in scope/i);
    expect(ordinary).toMatch(/Removing borders alone is not a layout redesign/i);
    expect(ordinary).toMatch(/\*\*Space fits content\.\*\*/);
    expect(ordinary).toMatch(/Prototype convenience does not swap product controls/i);
    expect(ordinary).toMatch(/side by side with the user's screenshot or the source rendering/i);
    expect(ordinary).toMatch(/up to three weakest remaining points, each marked `fix now` or `keep`/i);
    expect(ordinary).toMatch(/never invent a problem to fill it/i);
    expect(ordinary).toMatch(/That is the only repair round/i);
    expect(skillBody('ui-design-source')).toMatch(/A requested layout redesign puts widths, grouping, density/i);
  });

  it('retains shipped conditional completion, recovery and format contracts through actual runtime guidance', async () => {
    const agents = await import('../../src/main/features/agents');
    const bus = await import('../../src/main/features/group_chat/bus');
    const normalized = agents.normalizeAgent(shippedAgent, 'marketplace');
    const guidance = bus._buildAgentRuntimeGuidanceForTest(normalized?.profile);
    const promptWith = (...names: string[]) => [shippedAgent.workflow, guidance,
      ...names.map(name => `## skill: ${name}\n${skillBody(name)}`)].join('\n\n');
    const svgPrompt = promptWith('ui-design-executor', 'ui-artifact-workspace');
    expect(svgPrompt).toContain('Explicit final format wins immediately');
    expect(svgPrompt).toMatch(/missing product name or exact icon list is a low-risk/i);
    expect(svgPrompt).toMatch(/do not open a preference form/i);
    expect(svgPrompt).toContain('HTML intentionally absent');

    const runtimePrompt = promptWith('ui-design-executor', 'ui-artifact-workspace');
    expect(runtimePrompt).toContain('function safeInit()');
    expect(runtimePrompt).toContain('runtime-guarded-init');
    expect(runtimePrompt).toMatch(/html_preview` with `interactions:false` and `screenshots:true`/i);
    expect(runtimePrompt).not.toMatch(/preview interaction audit is authoritative/i);

    const figmaPrompt = promptWith('ui-design-executor', 'ui-artifact-workspace', 'ui-design-source');
    expect(figmaPrompt).toContain('Exact');
    expect(figmaPrompt).toContain('Adaptive (optional)');
    expect(figmaPrompt).toMatch(/adaptive.{0,40}provisional.{0,40}non-fidelity/i);
    expect(figmaPrompt).toMatch(/never call it 1:1/i);

    const rasterPrompt = promptWith('ui-design-executor', 'ui-artifact-workspace');
    expect(rasterPrompt).toContain('prewire the future relative raster path');
    expect(rasterPrompt).toMatch(/do not call a billable generation tool/i);
    expect(rasterPrompt).toContain('capability: "raster-image-generation"');
    expect(rasterPrompt).toContain('status: "pending"');
    expect(rasterPrompt).toContain('--expect raster-handoff');
    expect(rasterPrompt).toMatch(/narrow omission safeguard/i);
    expect(rasterPrompt).toMatch(/explicit vector intent only when it came from the user/i);

    const livePrompt = promptWith('ui-design-executor', 'ui-artifact-workspace', 'ui-live-artifact');
    expect(livePrompt).toContain('--expect live-ready');
    expect(livePrompt).toMatch(/make one focused repair and rerun once/i);
    expect(livePrompt).toMatch(/do not add an approval question or an open-ended QA loop/i);

    const revisionPrompt = promptWith('ui-design-executor', 'ui-artifact-workspace');
    expect(revisionPrompt).toMatch(/desktop plus mobile evidence only when the user explicitly requests/i);
    expect(revisionPrompt).toMatch(/otherwise omit target for desktop/i);
    expect(revisionPrompt).toMatch(/screenshots:true.*final visual review/i);
    expect(revisionPrompt).toMatch(/follow-up[\s\S]*baseline revision N[\s\S]*exactly once to N\+1/i);

    const newArtifactPrompt = promptWith('ui-design-executor', 'ui-artifact-workspace');
    expect(newArtifactPrompt).toMatch(/new artifact[\s\S]*revision 1[\s\S]*initial validation (?:and|or) preview[\s\S]*revision 1/i);
    expect(newArtifactPrompt).not.toMatch(/new artifact[\s\S]{0,160}revision 0/i);

    const defaultPrompt = promptWith('ui-design-executor', 'ui-artifact-workspace');
    expect(defaultPrompt).toMatch(/Tools-off does not turn a new artifact into a future brief/i);
    expect(defaultPrompt).toMatch(/Keep this default command unchanged for ordinary HTML/i);
    expect(defaultPrompt).toMatch(/expectation failure is a focused same-turn repair signal, not a new approval gate/i);

    const formPrompt = promptWith('ui-design-executor', 'ui-artifact-workspace', 'ui-controls-accessibility', 'ui-html-renderer');
    expect(formPrompt).toContain('### Delivery standards');
    expect(formPrompt).toMatch(/pristine, dirty\/touched invalid, submitted-pending/i);
    expect(formPrompt).toMatch(/JavaScript parser is unavailable, avoid backslash regex shorthands/i);
    expect(formPrompt).toMatch(/use `?\[0-9\]`?, direct string checks, or `?input\.validity`?/i);
    expect(formPrompt).toMatch(/no-backend prototype may use one explicit Success\/Server failure selector/i);
    expect(formPrompt).toMatch(/normal submit\/import action must read it before mutation/i);
    expect(formPrompt).toMatch(/validation errors, post-filter sentinels, or feedback overwritten by render do not prove/i);
    expect(shippedAgent.workflow).not.toMatch(/feedback overwritten by render never count/i);
  });
});
