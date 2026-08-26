import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

const VIDEO_STUDIO_ROOT = path.join(
  process.cwd(),
  'resources',
  'builtin',
  'marketplace',
  'agents',
  '79df9cc89f5f',
);

const read = (...segments: string[]) => fs.readFileSync(path.join(VIDEO_STUDIO_ROOT, ...segments), 'utf8');
const resolveGateTransition = (args: string[]) => JSON.parse(execFileSync(
  process.execPath,
  [
    path.join(VIDEO_STUDIO_ROOT, 'skills', 'gate-control', 'scripts', 'resolve-transition.mjs'),
    ...args,
  ],
  { encoding: 'utf8' },
)) as Record<string, any>;

describe('open-source VideoStudio resources', () => {
  it('preserves natural English casing and bounds all-caps accents', () => {
    const agent = JSON.parse(read('agent.json')) as { standards?: string[] };
    const frontendDesign = read('skills', 'frontend-design', 'SKILL.md');
    const stageCompose = [
      read('skills', 'stage-compose', 'SKILL.md'),
      read('skills', 'stage-compose', 'references', 'manifest-and-authoring.md'),
    ].join('\n');
    const compositionDesignReview = read('skills', 'composition-design-review', 'SKILL.md');
    const visualPrimitives = read('skills', 'frontend-design', 'references', 'visual-primitives.md');
    const standards = (agent.standards ?? []).join('\n');

    expect(visualPrimitives).not.toMatch(/text-transform\s*:\s*uppercase/i);
    expect(visualPrimitives).toMatch(/Preserve the authored case/i);
    expect(frontendDesign).toMatch(/Preserve the authored casing of approved English copy/i);
    expect(frontendDesign).toMatch(/two(?: or more)? English text roles.*all caps/i);
    expect(stageCompose).toMatch(/Preserve approved English casing/i);
    expect(compositionDesignReview).toMatch(/two or more English text roles.*all caps/i);
    expect(standards).not.toMatch(/two(?: or more)? English text roles.*all caps/i);
  });

  it('uses one canonical gate-control policy instead of line-specific confirmation patches', () => {
    const agent = JSON.parse(read('agent.json')) as { skill_list?: string[]; standards?: string[] };
    const stageCompose = read('skills', 'stage-compose', 'SKILL.md');
    const gateControl = [
      read('skills', 'gate-control', 'SKILL.md'),
      read('skills', 'gate-control', 'references', 'revision-and-recovery.md'),
    ].join('\n');
    const standards = (agent.standards ?? []).join('\n');

    expect(agent.skill_list).toContain('gate-control');
    expect(stageCompose).toMatch(/All COMPOSE stops and authorization transitions belong to `gate-control`/i);
    expect(gateControl).toMatch(/Authority is not recovery/);
    expect(gateControl).toMatch(/named change to visible artifact.*apply that bounded scope/is);
    expect(gateControl).toMatch(/E_VISUAL_REVISION_EXPLICIT_AUTHORIZATION_REQUIRED.*requires status.*never starts a cycle/is);
    expect(gateControl).toMatch(/One user decision creates at most one follow-up authorization request/i);
    expect(standards).toMatch(/approval.*claims match current durable state/i);
    expect(standards).toMatch(/changed or failed candidates never inherit stale approval/i);
    expect(standards).toMatch(/recovery or quality-boundary handoff names current findings/i);
  });

  it('resolves post-gate authorization traces without duplicate recovery forms', () => {
    const directGateDRevision = resolveGateTransition([
      '--line', 'compose', '--artifact', 'composition',
      '--gate', 'gate_d', '--decision', 'revise', '--scope', 'visual_only', '--recovery', 'not_available',
    ]);
    expect(directGateDRevision).toMatchObject({
      next_action: 'edit_current_cycle',
      authorities: ['edit_current_artifact'],
    });
    expect(directGateDRevision.prohibited_ops).toContain('stop_for_user');
    expect(directGateDRevision.prohibited_ops).toContain('restart_visual_qa_cycle');

    expect(resolveGateTransition([
      '--line', 'compose', '--artifact', 'composition',
      '--gate', 'gate_d', '--decision', 'revise', '--scope', 'gate_b_payload', '--recovery', 'not_available',
    ])).toMatchObject({
      next_action: 'open_gate_b_amendment',
      authorities: ['edit_current_artifact'],
    });

    const unknownRecovery = resolveGateTransition([
      '--line', 'compose', '--artifact', 'composition',
      '--gate', 'gate_d', '--decision', 'revise', '--scope', 'gate_b_payload', '--recovery', 'unknown',
    ]);
    expect(unknownRecovery).toMatchObject({
      next_action: 'open_gate_b_amendment',
      authorities: ['edit_current_artifact'],
    });

    expect(resolveGateTransition([
      '--line', 'compose', '--artifact', 'composition',
      '--gate', 'gate_d', '--decision', 'revise', '--scope', 'visual_only', '--recovery', 'unknown',
      '--error-code', 'E_VISUAL_REVISION_NOT_REQUIRED',
    ])).toMatchObject({ next_action: 'edit_current_cycle' });

    const misleadingAuthError = resolveGateTransition([
      '--line', 'compose', '--artifact', 'composition',
      '--gate', 'gate_d', '--decision', 'revise', '--scope', 'visual_only', '--recovery', 'unknown',
      '--error-code', 'E_VISUAL_REVISION_EXPLICIT_AUTHORIZATION_REQUIRED',
    ]);
    expect(misleadingAuthError).toMatchObject({ next_action: 'query_status' });
    expect(misleadingAuthError.prohibited_ops).toContain('stop_for_user');

    expect(resolveGateTransition([
      '--line', 'compose', '--artifact', 'composition',
      '--gate', 'none', '--decision', 'none', '--scope', 'none', '--recovery', 'available',
      '--recovery-decision', 'new_visual_revision',
    ])).toMatchObject({
      next_action: 'edit_current_cycle',
      authorities: ['edit_current_artifact'],
    });

    const existingApproval = resolveGateTransition([
      '--line', 'compose', '--artifact', 'composition',
      '--gate', 'gate_d', '--decision', 'none', '--scope', 'none', '--recovery', 'not_available',
      '--artifact-state', 'unchanged', '--approval-status', 'approved',
    ]);
    expect(existingApproval).toMatchObject({
      next_action: 'continue_from_existing_approval',
      authorities: ['consume_existing_approval'],
    });
    expect(existingApproval.prohibited_ops).toContain('stop_for_user');

    const editRevision = resolveGateTransition([
      '--line', 'edit', '--artifact', 'production',
      '--gate', 'gate_d', '--decision', 'revise', '--scope', 'visual_only', '--recovery', 'not_available',
    ]);
    expect(editRevision).toMatchObject({ next_action: 'edit_current_cycle' });
    expect(editRevision.allowed_ops).toContain('run_line_native_qa');

    expect(resolveGateTransition([
      '--line', 'edit', '--artifact', 'production',
      '--gate', 'gate_b', '--decision', 'approve', '--scope', 'none', '--recovery', 'not_available',
    ])).toMatchObject({
      next_action: 'approve_plan',
      allowed_ops: ['production.approve_plan'],
    });

    const autoChildStatus = resolveGateTransition([
      '--line', 'auto', '--artifact', 'composition',
      '--gate', 'gate_d', '--decision', 'revise', '--scope', 'visual_only', '--recovery', 'unknown',
      '--error-code', 'E_VISUAL_REVISION_EXPLICIT_AUTHORIZATION_REQUIRED',
    ]);
    expect(autoChildStatus).toMatchObject({ next_action: 'query_status' });
    expect(autoChildStatus.allowed_ops).toEqual(['composition.status']);
  });
});
