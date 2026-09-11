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
    const alwaysOnProfile = [...shippedAgent.knowhow, ...shippedAgent.standards].join('\n');
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
});
