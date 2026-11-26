import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  imageStudioSkillTracePassed,
  type ImageStudioSkillTraceEvent,
  validateImageStudioSkillTrace,
} from '../../../eval/benchmark/image-studio-skill-trace';

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const USER_ID = 'u-image-studio-trace';
const AGENT_ID = '814b61b027f0';
let temporaryRoot = '';
let previousWorkspaceRoot: string | undefined;

beforeEach(async () => {
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-image-skill-trace-'));
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = temporaryRoot;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(USER_ID);
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

async function runtimeTrace(skillIds: string[]): Promise<ImageStudioSkillTraceEvent[]> {
  const paths = await import('../../../src/main/paths');
  const workspace = await import('../../../src/main/features/user_workspace');
  const { createFileTools } = await import('../../../src/main/model/core-agent/file-tools');
  const workspaceDir = path.join(temporaryRoot, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  const selected = workspace.setWorkspacePath(USER_ID, workspaceDir);
  if (!selected.ok) throw new Error(selected.error);

  const installedAgentDir = path.join(paths.userAgentsDir(USER_ID), AGENT_ID);
  const shippedSkillsDir = path.resolve(process.cwd(), 'resources', 'builtin', 'marketplace', 'agents', AGENT_ID, 'skills');
  for (const skillId of skillIds) {
    const destination = path.join(installedAgentDir, 'skills', skillId, 'SKILL.md');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(shippedSkillsDir, skillId, 'SKILL.md'), destination);
  }

  const events: ImageStudioSkillTraceEvent[] = [];
  const tools = createFileTools({
    userId: USER_ID,
    agentId: AGENT_ID,
    readOnlyExtraRoots: [installedAgentDir],
    onSkillInvoked: (skillId) => events.push({ kind: 'skill-read', skillId, batch: events.length }),
  });
  const readFiles = tools.find((tool) => tool.name === 'read_files');
  if (!readFiles) throw new Error('read_files unavailable');
  const read = async (skillId: string) => {
    const result = await readFiles.execute(
      { paths: [{ path: path.join(installedAgentDir, 'skills', skillId, 'SKILL.md') }] },
      { workingDir: workspaceDir } as any,
    );
    if (result.isError) throw new Error(result.content);
    if (skillId === 'image-router') {
      expect(result.content).toMatch(/explicit match\/recreate\/restore request takes precedence[\s\S]*reproduce[\s\S]*limited edit[\s\S]*may_change/i);
      expect(result.content).toMatch(/Otherwise, a requested source edit implies edit/i);
      expect(result.content).not.toMatch(/combine editing with strong preservation, keep mode edit/i);
      expect(result.content).toMatch(/localized copy revision[\s\S]*visible geometry[\s\S]*load .image-compose./i);
      expect(result.content).toMatch(/clarify only if[\s\S]*explicitly required[\s\S]*change area cannot be isolated/i);
      const handoff = result.content.split('## Progressive-disclosure handoff')[1] || '';
      expect(handoff).toMatch(/Return[^\n]*`route`[^\n]*`reference_intent`/i);
      expect(handoff).toMatch(/source_dimensions[^\n]*preview_dimensions/i);
      const routing = result.content.split('## Route selection')[1]?.split('## Lock output')[0] || '';
      expect(routing).toMatch(/Choose `EDIT` for `edit` intent/i);
      expect(routing).toMatch(/`reproduce`[^\n]*deterministic[^\n]*`COMPOSE`/i);
    }
    if (skillId === 'image-craft') {
      expect(result.content).not.toContain('Never request a protected artist imitation');
      expect(result.content).toContain("preserve the user's core request verbatim");
      expect(result.content).toContain('Do not add random quality tags, conflicting styles, named-artist mimicry');
      expect(result.content).toContain('first obey explicit user requirements');
      expect(result.content).toContain('generate_image.reference_bindings');
    }
    if (skillId === 'image-compose') {
      expect(result.content).toMatch(/unchanged source[^\n]*`masked_composite`[^\n]*final raster/i);
      expect(result.content).toMatch(/supplied raster[^\n]*text box[^\n]*wrap the replacement naturally within the original title area[^\n]*masked_composite/i);
      const bootstrap = result.content.split('## Safe project bootstrap')[1]?.split('## Authoring contract')[0] || '';
      expect(bootstrap).toMatch(/HTML final source[^\n]*entry file/i);
      expect(result.content).toMatch(/masked_composite[^\n]*raster_source[^\n]*project\.inspect/i);
      expect(result.content).toMatch(/on every route[^\n]*`reference_intent`[^\n]*`required:true` for reproduction/i);
      const reviewStep = result.content.split('## Native workflow')[1]?.split('\n').find(line => /\b4\./.test(line)) || '';
      expect(reviewStep).toMatch(/non-generation[\s\S]*current visual evidence[\s\S]*read `image-design-review`[\s\S]*already loaded[\s\S]*project\.submit_design_review/i);
    }
  };

  await read('image-router');
  events.push({ kind: 'route-locked', route: 'COMPOSE' });
  await read('image-craft');
  await read('image-canvas');
  await read('image-compose');
  events.push({ kind: 'evidence-ready', evidencePath: path.join(workspaceDir, 'snapshot.png') });
  await read('image-design-review');
  return events;
}

describe('ImageStudio observable skill-read trace', () => {
  it('reads the shipped set contract from the router handoff without artifacts or a review-skill load', async () => {
    const paths = await import('../../../src/main/paths');
    const workspace = await import('../../../src/main/features/user_workspace');
    const { createFileTools } = await import('../../../src/main/model/core-agent/file-tools');
    const workspaceDir = path.join(temporaryRoot, 'plan-only');
    fs.mkdirSync(workspaceDir);
    expect(workspace.setWorkspacePath(USER_ID, workspaceDir).ok).toBe(true);
    const source = path.resolve(process.cwd(), 'resources/builtin/marketplace/agents', AGENT_ID, 'skills');
    const installed = path.join(paths.userAgentsDir(USER_ID), AGENT_ID, 'skills');
    const resources = ['image-router/SKILL.md', 'image-compose/SKILL.md', 'image-compose/references/multi-image-sets.md'];
    for (const relative of resources) {
      fs.mkdirSync(path.dirname(path.join(installed, relative)), { recursive: true });
      fs.copyFileSync(path.join(source, relative), path.join(installed, relative));
    }
    const invoked: string[] = [];
    const tools = createFileTools({ userId: USER_ID, agentId: AGENT_ID,
      skillRuntimeBindings: new Map(['image-router', 'image-compose'].map(id => [id, {
        id, name: id, root: path.join(installed, id), entry: path.join(installed, id, 'SKILL.md'), source: 'platform',
      }])),
      onSkillInvoked: id => invoked.push(id),
    });
    const read = tools.find(tool => tool.name === 'read_files')!;
    const router = await read.execute({ paths: [{ path: '@skill/image-router' }] }, { workingDir: workspaceDir } as any);
    expect(router.isError).not.toBe(true);
    const target = router.content.match(/\]\(([^)]+multi-image-sets\.md)\)/)?.[1];
    expect(target).toBeDefined();
    // Follow the actual shipped handoff using the normal bound logical path;
    // do not insert the contract body or a review-ready event into the fixture.
    const logical = target!.startsWith('@skill/')
      ? target!
      : '@skill/' + path.posix.normalize('image-router/' + target);
    const contract = await read.execute({ paths: [{ path: logical }] }, { workingDir: workspaceDir } as any);
    expect(contract.isError).not.toBe(true);
    expect(contract.content).toContain('reference_intent.minimum_score` to at least 85');
    expect(contract.content).toContain('repair and re-review any visual outlier');
    expect(contract.content).toContain('A planning-only request permits reading instructions');
    expect(invoked).not.toContain('image-design-review');
    expect(fs.readdirSync(workspaceDir)).toEqual([]);
    for (const relative of resources) {
      expect(fs.readFileSync(path.join(installed, relative))).toEqual(fs.readFileSync(path.join(source, relative)));
    }
  });

  it('accepts a progressive COMPOSE trace emitted by the production read_files callback', async () => {
    const trace = await runtimeTrace([
      'image-router',
      'image-craft',
      'image-canvas',
      'image-compose',
      'image-design-review',
    ]);
    const checks = validateImageStudioSkillTrace(trace, {
      route: 'COMPOSE',
      needsCraft: true,
      needsCanvas: true,
    });
    expect(trace.filter((event) => event.kind === 'skill-read').map((event) => event.kind === 'skill-read' && event.skillId)).toEqual([
      'image-router',
      'image-craft',
      'image-canvas',
      'image-compose',
      'image-design-review',
    ]);
    expect(imageStudioSkillTracePassed(checks), checks).toBe(true);
  });

  it('rejects the previous eager preload shape and review-before-evidence', () => {
    const trace: ImageStudioSkillTraceEvent[] = [
      { kind: 'skill-read', skillId: 'image-router', batch: 0 },
      { kind: 'skill-read', skillId: 'image-craft', batch: 0 },
      { kind: 'skill-read', skillId: 'image-canvas', batch: 0 },
      { kind: 'skill-read', skillId: 'image-compose', batch: 0 },
      { kind: 'skill-read', skillId: 'image-design-review', batch: 0 },
      { kind: 'route-locked', route: 'COMPOSE' },
      { kind: 'evidence-ready', evidencePath: '/tmp/snapshot.png' },
    ];
    const checks = validateImageStudioSkillTrace(trace, { route: 'COMPOSE', needsCraft: true, needsCanvas: true });
    expect(imageStudioSkillTracePassed(checks)).toBe(false);
    expect(checks.find((check) => check.id === 'router-first-alone')?.pass).toBe(false);
    expect(checks.find((check) => check.id === 'route-locked-before-dependent-skills')?.pass).toBe(false);
    expect(checks.find((check) => check.id === 'review-after-evidence')?.pass).toBe(false);
  });

  it('rejects omitted review instructions and reuses a loaded reviewer after fresh revision evidence', () => {
    const trace: ImageStudioSkillTraceEvent[] = [
      { kind: 'skill-read', skillId: 'image-router', batch: 0 },
      { kind: 'route-locked', route: 'COMPOSE' },
      { kind: 'skill-read', skillId: 'image-compose', batch: 1 },
      { kind: 'evidence-ready', evidencePath: '/project/first-revision.png' },
      { kind: 'skill-read', skillId: 'image-design-review', batch: 2 },
      { kind: 'evidence-ready', evidencePath: '/project/second-revision.png' },
    ];
    const expectation = { route: 'COMPOSE' as const, needsCraft: false, needsCanvas: false };
    expect(imageStudioSkillTracePassed(validateImageStudioSkillTrace(trace, expectation))).toBe(true);
    const omitted = trace.filter(event => event.kind !== 'skill-read' || event.skillId !== 'image-design-review');
    expect(validateImageStudioSkillTrace(omitted, expectation).find(check => check.id === 'review-after-evidence')?.pass).toBe(false);
    const repeated: ImageStudioSkillTraceEvent[] = [...trace, { kind: 'skill-read', skillId: 'image-design-review', batch: 3 }];
    expect(validateImageStudioSkillTrace(repeated, expectation).find(check => check.id === 'no-duplicate-skill-reads')?.pass).toBe(false);
  });

  it('rejects a production trace that captures evidence but skips the review Skill', async () => {
    const complete = await runtimeTrace(['image-router', 'image-craft', 'image-canvas', 'image-compose', 'image-design-review']);
    const bypassed = complete.filter(event => !(event.kind === 'skill-read' && event.skillId === 'image-design-review'));
    const checks = validateImageStudioSkillTrace(bypassed, { route: 'COMPOSE', needsCraft: true, needsCanvas: true });
    expect(checks.find(check => check.id === 'review-after-evidence')?.pass).toBe(false);
    expect(imageStudioSkillTracePassed(checks)).toBe(false);
  });
});
