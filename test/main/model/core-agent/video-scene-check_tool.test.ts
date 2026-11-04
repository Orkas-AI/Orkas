import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Unit hosts run Electron as Node: there is no BrowserWindow, so a valid
// request reaches the capture step and must fail cleanly there.
vi.mock('electron', () => ({}));

const UID = 'scene-check';
let root: string;
let previousRoot: string | undefined;
let workspace: string;
let compositionDir: string;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-scene-check-'));
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules();
  (await import('../../../../src/main/features/users')).activateUser(UID);
  workspace = path.join(root, 'workspace');
  compositionDir = path.join(workspace, 'project', 'composition');
  fs.mkdirSync(compositionDir, { recursive: true });
  (await import('../../../../src/main/features/user_workspace')).setWorkspacePath(UID, workspace);
  fs.writeFileSync(path.join(compositionDir, 'index.html'), [
    '<!doctype html><html><body>',
    '<main data-composition-id="main" data-width="1920" data-height="1080" data-duration="8">',
    '<section class="clip" data-scene-id="hook" data-start="0" data-duration="3"><h1 data-role="title">Hook</h1></section>',
    '<section class="clip" data-scene-id="goal" data-start="3" data-duration="5"><h1 data-role="title">Goal</h1></section>',
    '</main></body></html>',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(compositionDir, 'composition-manifest.json'), JSON.stringify({
    schema_version: 2,
    composition: { id: 'main', width: 1920, height: 1080, duration: 8, fps: 30 },
    scenes: [{ id: 'hook', start: 0, duration: 3 }, { id: 'goal', start: 3, duration: 5 }],
  }), 'utf8');
});
afterEach(() => {
  if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

async function tool() {
  return (await import('../../../../src/main/model/core-agent/video-studio-tool')).createVideoStudioTool({
    userId: UID, cid: 'current-chat',
  } as any);
}
const ctx = () => ({ workingDir: workspace, state: {} } as any);
const body = (result: any) => JSON.parse(result.content);

describe('composition.scene_check', () => {
  it('plans start, middle and end frames per named scene in the order asked', async () => {
    const { sceneCheckSamplePlan } = await import('../../../../src/main/features/video_studio');
    const scenes = [{ id: 'hook', start: 0, duration: 3 }, { id: 'goal', start: 3, duration: 5 }];
    expect(sceneCheckSamplePlan(scenes, ['goal', 'hook'])).toEqual([
      { sceneId: 'goal', label: 'goal start', timeSec: 3.3 },
      { sceneId: 'goal', label: 'goal mid', timeSec: 5.5 },
      { sceneId: 'goal', label: 'goal end', timeSec: 7.8 },
      { sceneId: 'hook', label: 'hook start', timeSec: 0.3 },
      { sceneId: 'hook', label: 'hook mid', timeSec: 1.5 },
      { sceneId: 'hook', label: 'hook end', timeSec: 2.8 },
    ]);
    expect(sceneCheckSamplePlan(scenes, ['nope'])).toEqual({ unknown: ['nope'] });
  });

  it('rejects bad ids, unknown scenes and foreign directories before capturing', async () => {
    const t = await tool();
    for (const scene_ids of [undefined, [], ['a', 'b', 'c', 'd', 'e'], ['hook', 'hook'], [3]]) {
      const result: any = await t.execute({ op: 'composition.scene_check', scene_ids }, ctx());
      expect(result.isError).toBe(true);
      expect(body(result).errorCode).toBe('E_SCENE_CHECK_INPUT');
    }
    const unknown: any = await t.execute({ op: 'composition.scene_check', scene_ids: ['nope'] }, ctx());
    expect(body(unknown)).toMatchObject({ errorCode: 'E_SCENE_CHECK_SCENE', known_scene_ids: ['hook', 'goal'] });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-scene-check-outside-'));
    try {
      const foreign: any = await t.execute({ op: 'composition.scene_check', scene_ids: ['hook'], composition_dir: outside }, ctx());
      expect(foreign.isError).toBe(true);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('fails without a renderer window and leaves no evidence or production state behind', async () => {
    const t = await tool();
    const result: any = await t.execute({ op: 'composition.scene_check', scene_ids: ['goal'] }, ctx());
    expect(result.isError).toBe(true);
    expect(body(result)).toMatchObject({ ok: false, op: 'composition.scene_check' });
    expect(result.images).toBeUndefined();
    const checks = path.join(compositionDir, 'preview', 'scene-check');
    expect(fs.existsSync(checks) ? fs.readdirSync(checks) : []).toEqual([]);
    expect(fs.existsSync(path.join(compositionDir, 'qa'))).toBe(false);
  });
});
