import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The review panel is a read-only diagnostic surface: it must find exactly the
// conversation's productions (state files are keyed by uid+composition dir,
// not cid), tolerate corrupt and foreign state files, and carry the fields
// the renderer shows. It must never turn a bad state file into a failure.

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const WORKSPACE_BY_CID = new Map<string, string>();
vi.mock('../../../src/main/features/group_chat/conv_workspace', () => ({
  getConversationWorkspacePath: async (_uid: string, cid: string) => {
    const dir = WORKSPACE_BY_CID.get(cid);
    if (!dir) throw new Error('no workspace');
    return dir;
  },
}));

const UID = 'u-video-review';
let tmpDir: string;
let prevRoot: string | undefined;

function gatesDir(): string {
  return path.join(tmpDir, UID, 'local', 'video_studio', 'gates');
}

function writeState(name: string, state: Record<string, unknown>): void {
  fs.mkdirSync(gatesDir(), { recursive: true });
  fs.writeFileSync(path.join(gatesDir(), `${name}.json`), JSON.stringify(state), 'utf8');
}

function writeManifest(compositionDir: string, scenes: unknown[]): void {
  fs.mkdirSync(compositionDir, { recursive: true });
  fs.writeFileSync(path.join(compositionDir, 'composition-manifest.json'), JSON.stringify({
    schema_version: 1,
    composition: { id: 'main', width: 1920, height: 1080, duration: 5, fps: 30 },
    scenes,
    audio: { owner: 'none', tracks: [] },
  }), 'utf8');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-video-review-'));
  prevRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  WORKSPACE_BY_CID.clear();
  vi.resetModules();
});

afterEach(() => {
  if (prevRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = prevRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('video studio review panel', () => {
  it('returns the conversation productions with scenes, evidence, and takes', async () => {
    const workspace = path.join(tmpDir, 'ws-a');
    WORKSPACE_BY_CID.set('cid-a', workspace);
    const compositionDir = path.join(workspace, 'project', 'composition');
    writeManifest(compositionDir, [
      { id: 'cover', approved_copy: ['Hello', 'World'], narration_text: 'Speak once.' },
      { id: 'payoff', approved_copy: [] },
      { not_a_scene: true },
    ]);
    writeState('state-a', {
      schema_version: 1,
      composition_dir: compositionDir,
      stage: 'preview_approved',
      plan_approval: { gate: 'B', signature: 'sig' },
      preview: {
        signature: 'full',
        status: 'approved',
        path: path.join(compositionDir, 'preview', 'contact-sheet.png'),
        frame_paths: [
          path.join(compositionDir, 'preview', '01-first-frame.png'),
          path.join(compositionDir, 'preview', '02-cover-mid.png'),
          path.join(compositionDir, 'preview', '04-payoff-frame.png'),
        ],
        validation_version: 5,
        turn_id: 't',
        created_at: 'now',
      },
      narration: {
        status: 'materialized',
        path: path.join(compositionDir, 'assets', 'narration.mp3'),
        measured_duration_sec: 6.8,
        language: 'zh-CN',
        speed: 1,
      },
      draft: { signature: 'full', status: 'ready', validation_version: 5, turn_id: 't', created_at: 'now' },
      current_candidate: {
        revision_id: 'candidate-current',
        content_hash: 'hash-current',
        artifacts: {},
        locators: { preview_path: '/abs/current-sheet.png' },
        runtime_fingerprint: 'fp',
        created_at: '2026-08-03T01:00:00Z',
        last_observed_at: '2026-08-03T02:00:00Z',
        last_observed_op: 'composition.snapshot',
        last_quality_result: { ok: true, observed_at: '2026-08-03T02:00:00Z' },
      },
      candidate_history: [
        {
          revision_id: 'candidate-old-1',
          content_hash: 'hash-old-1',
          artifacts: {},
          locators: {},
          snapshot: { locators: { preview_path: '/abs/frozen-1.png' } },
          runtime_fingerprint: 'fp',
          created_at: '2026-08-03T00:00:00Z',
          last_observed_at: '2026-08-03T00:30:00Z',
          last_observed_op: 'composition.snapshot',
          last_quality_result: { ok: false, error_code: 'E_PREVIEW_QA_BLOCKED', observed_at: '2026-08-03T00:30:00Z' },
        },
        {
          revision_id: 'candidate-old-2',
          content_hash: 'hash-old-2',
          artifacts: {},
          locators: {},
          runtime_fingerprint: 'fp',
          created_at: '2026-08-03T00:40:00Z',
          last_observed_at: '2026-08-03T00:50:00Z',
          last_observed_op: 'composition.snapshot',
        },
      ],
    });

    const mod = await import('../../../src/main/features/video_studio_review');
    const panel = await mod.buildVideoStudioReviewPanel(UID, 'cid-a');

    expect(panel.compositions).toHaveLength(1);
    const comp = panel.compositions[0];
    expect(comp).toMatchObject({
      composition_dir: compositionDir,
      display_name: 'project/composition',
      stage: 'preview_approved',
      plan_approved: true,
      preview: {
        status: 'approved',
        contact_sheet_path: path.join(compositionDir, 'preview', 'contact-sheet.png'),
        frame_paths: [
          path.join(compositionDir, 'preview', '01-first-frame.png'),
          path.join(compositionDir, 'preview', '02-cover-mid.png'),
          path.join(compositionDir, 'preview', '04-payoff-frame.png'),
        ],
      },
      narration: { status: 'materialized', duration_sec: 6.8, language: 'zh-CN' },
      draft: { status: 'ready' },
    });
    // Malformed scene entries are dropped; well-formed ones keep order. The
    // cover scene matches its `NN-<sceneId>-mid.png` frame; the payoff scene
    // has no midpoint frame recorded (the payoff-frame sample is a global
    // boundary, not a scene midpoint) and must not mis-match it.
    expect(comp.scenes).toEqual([
      {
        id: 'cover',
        narration_text: 'Speak once.',
        approved_copy: ['Hello', 'World'],
        frame_path: path.join(compositionDir, 'preview', '02-cover-mid.png'),
      },
      { id: 'payoff', approved_copy: [] },
    ]);
    // The panel reviews the CURRENT production only. Candidate history is
    // recorded in production state for approval inheritance, but it is not a
    // user-facing surface: no version list and no restore entry point.
    expect('takes' in (comp as Record<string, unknown>)).toBe(false);
    expect(JSON.stringify(panel)).not.toContain('candidate-old-1');
  });

  it('carries the recorded task title and omits blank or missing ones', async () => {
    // The panel titles a production with what the user asked for. A state
    // written before that field existed — or by a skill that does not send
    // it — must leave the key absent so the renderer can fall back, rather
    // than surface an empty title.
    const workspace = path.join(tmpDir, 'ws-a');
    WORKSPACE_BY_CID.set('cid-a', workspace);
    const titled = path.join(workspace, 'launch', 'project', 'composition');
    const blank = path.join(workspace, 'blank', 'project', 'composition');
    const legacy = path.join(workspace, 'legacy', 'project', 'composition');
    for (const dir of [titled, blank, legacy]) writeManifest(dir, []);
    writeState('state-titled', {
      schema_version: 1,
      composition_dir: titled,
      stage: 'manifest_ready',
      task_title: '  做一条 60 秒的 Orkas 产品宣传片  ',
    });
    writeState('state-blank', {
      schema_version: 1,
      composition_dir: blank,
      stage: 'manifest_ready',
      task_title: '   ',
    });
    writeState('state-legacy', {
      schema_version: 1,
      composition_dir: legacy,
      stage: 'manifest_ready',
    });

    const mod = await import('../../../src/main/features/video_studio_review');
    const panel = await mod.buildVideoStudioReviewPanel(UID, 'cid-a');
    const byDir = new Map(panel.compositions.map((comp) => [comp.composition_dir, comp]));
    expect(byDir.get(titled)?.task_title).toBe('做一条 60 秒的 Orkas 产品宣传片');
    expect('task_title' in (byDir.get(blank) as Record<string, unknown>)).toBe(false);
    expect('task_title' in (byDir.get(legacy) as Record<string, unknown>)).toBe(false);
  });

  it('filters by conversation workspace and skips corrupt state files', async () => {
    const workspaceA = path.join(tmpDir, 'ws-a');
    const workspaceB = path.join(tmpDir, 'ws-b');
    WORKSPACE_BY_CID.set('cid-a', workspaceA);
    const inside = path.join(workspaceA, 'project', 'composition');
    const outside = path.join(workspaceB, 'project', 'composition');
    writeManifest(inside, []);
    writeManifest(outside, []);
    writeState('state-inside', { composition_dir: inside, stage: 'manifest_ready' });
    writeState('state-outside', { composition_dir: outside, stage: 'manifest_ready' });
    writeState('state-no-dir', { stage: 'manifest_ready' });
    fs.writeFileSync(path.join(gatesDir(), 'corrupt.json'), '{not json', 'utf8');
    // A traversal-shaped composition_dir must not escape the workspace
    // filter. Built by string concatenation so the `..` survives into the
    // state file instead of being normalized away by path.join.
    writeState('state-traversal', {
      composition_dir: `${workspaceA}${path.sep}..${path.sep}ws-b${path.sep}project${path.sep}composition`,
      stage: 'manifest_ready',
    });

    const mod = await import('../../../src/main/features/video_studio_review');
    const panel = await mod.buildVideoStudioReviewPanel(UID, 'cid-a');
    expect(panel.compositions.map((comp) => comp.composition_dir)).toEqual([inside]);
  });

  // 2026-08-06: a run began as one composition per segment, never got the
  // parent plan approved (the approve_plan bugs fixed the same day), then
  // switched to a single whole-video composition. Six manifest-only shells
  // stayed behind and the drawer listed each as its own production —
  // repeating the live composition's scenes six times, every row badged
  // 方案待确认 for a stop the user was never actually asked for.
  function writeShell(name: string, compositionDir: string, sceneId: string): void {
    writeManifest(compositionDir, [{ id: sceneId, approved_copy: [`copy ${sceneId}`] }]);
    writeState(name, {
      schema_version: 1,
      composition_dir: compositionDir,
      stage: 'manifest_ready',
      // The real shells recorded a candidate whose only locator is the
      // manifest: an input was written, nothing came out.
      current_candidate: {
        revision_id: `candidate-${sceneId}`,
        content_hash: `hash-${sceneId}`,
        artifacts: {},
        locators: { manifest_path: path.join(compositionDir, 'composition-manifest.json') },
        runtime_fingerprint: 'fp',
        created_at: 'now',
        last_observed_at: 'now',
        last_observed_op: 'composition.reconcile',
      },
    });
  }

  it('hides abandoned shells that a live sibling composition superseded', async () => {
    const workspace = path.join(tmpDir, 'ws-shells');
    WORKSPACE_BY_CID.set('cid-shells', workspace);
    const compositions = path.join(workspace, 'project', 'compositions');
    const liveDir = path.join(compositions, 'main');
    writeManifest(liveDir, [
      { id: 's1_hook', approved_copy: ['hook'] },
      { id: 's2_body', approved_copy: ['body'] },
    ]);
    writeState('state-live', {
      schema_version: 1,
      composition_dir: liveDir,
      stage: 'scaffold_ready',
      plan_approval: { gate: 'B', signature: 'sig-live' },
      current_candidate: {
        revision_id: 'candidate-live',
        content_hash: 'hash-live',
        artifacts: {},
        locators: {
          html_path: path.join(liveDir, 'index.html'),
          frame_paths: [path.join(liveDir, 'snapshot-frames', '02-s1-hook-mid.png')],
        },
        runtime_fingerprint: 'fp',
        created_at: 'now',
        last_observed_at: 'now',
        last_observed_op: 'composition.snapshot',
        last_quality_result: { ok: false, error_code: 'E_PREVIEW_QA_BLOCKED', observed_at: 'now' },
      },
    });
    for (const sceneId of ['s1_hook', 's2_body']) {
      writeShell(`state-shell-${sceneId}`, path.join(compositions, sceneId), sceneId);
    }

    const mod = await import('../../../src/main/features/video_studio_review');
    const panel = await mod.buildVideoStudioReviewPanel(UID, 'cid-shells');
    expect(panel.compositions.map((comp) => comp.composition_dir)).toEqual([liveDir]);
    // The scenes appear exactly once — the duplication the user reported.
    expect(panel.compositions[0].scenes.map((scene) => scene.id)).toEqual(['s1_hook', 's2_body']);
  });

  it('keeps a lone shell, and never lets one video hide another video\'s', async () => {
    // Negative controls for the rule above. A production that just wrote its
    // manifest is the whole story its drawer has, so hiding it would claim
    // the conversation started no work at all; and "superseded" is scoped to
    // one video, never across videos in the same conversation.
    const workspace = path.join(tmpDir, 'ws-lone');
    WORKSPACE_BY_CID.set('cid-lone', workspace);
    const startingDir = path.join(workspace, 'videos', 'starting', 'project', 'composition');
    writeShell('state-starting', startingDir, 'cover');

    const mod = await import('../../../src/main/features/video_studio_review');
    expect((await mod.buildVideoStudioReviewPanel(UID, 'cid-lone'))
      .compositions.map((comp) => comp.composition_dir)).toEqual([startingDir]);

    // A different video in the same conversation reaching an approval must
    // not retire the one that only just started.
    const otherDir = path.join(workspace, 'videos', 'other', 'project', 'composition');
    writeManifest(otherDir, [{ id: 'cover', approved_copy: [] }]);
    writeState('state-other-live', {
      schema_version: 1,
      composition_dir: otherDir,
      stage: 'preview_ready',
      plan_approval: { gate: 'B', signature: 'sig-other' },
      preview: { status: 'ready', frame_paths: [] },
    });
    const both = await mod.buildVideoStudioReviewPanel(UID, 'cid-lone');
    expect(both.compositions.map((comp) => comp.composition_dir).sort())
      .toEqual([otherDir, startingDir].sort());
  });

  it('treats produced evidence, not approval, as proof a composition is real work', async () => {
    // Negative control on the shell test itself: a segment blocked in QA has
    // no approval of its own, but its candidate carries frames the user can
    // look at. That is work, so a live sibling must not retire it.
    const workspace = path.join(tmpDir, 'ws-evidence');
    WORKSPACE_BY_CID.set('cid-evidence', workspace);
    const compositions = path.join(workspace, 'project', 'compositions');
    const liveDir = path.join(compositions, 'main');
    writeManifest(liveDir, [{ id: 'main_scene', approved_copy: [] }]);
    writeState('state-evidence-live', {
      schema_version: 1,
      composition_dir: liveDir,
      stage: 'preview_ready',
      plan_approval: { gate: 'B', signature: 'sig' },
      preview: { status: 'ready', frame_paths: [] },
    });
    const blockedDir = path.join(compositions, 's2_body');
    writeManifest(blockedDir, [{ id: 's2_body', approved_copy: [] }]);
    writeState('state-evidence-blocked', {
      schema_version: 1,
      composition_dir: blockedDir,
      stage: 'scaffold_ready',
      current_candidate: {
        revision_id: 'candidate-blocked',
        content_hash: 'hash',
        artifacts: {},
        locators: {
          manifest_path: path.join(blockedDir, 'composition-manifest.json'),
          frame_paths: [path.join(blockedDir, 'snapshot-frames', '01-first-frame.png')],
        },
        runtime_fingerprint: 'fp',
        created_at: 'now',
        last_observed_at: 'now',
        last_observed_op: 'composition.snapshot',
        last_quality_result: { ok: false, error_code: 'E_PREVIEW_QA_BLOCKED', observed_at: 'now' },
      },
    });

    const mod = await import('../../../src/main/features/video_studio_review');
    const panel = await mod.buildVideoStudioReviewPanel(UID, 'cid-evidence');
    expect(panel.compositions.map((comp) => comp.composition_dir).sort())
      .toEqual([blockedDir, liveDir].sort());
  });

  it('returns an empty panel for conversations without workspace or state', async () => {
    const mod = await import('../../../src/main/features/video_studio_review');
    // No workspace resolvable at all.
    expect(await mod.buildVideoStudioReviewPanel(UID, 'cid-unknown')).toEqual({ compositions: [] });
    // Workspace exists but no production state was ever written.
    WORKSPACE_BY_CID.set('cid-b', path.join(tmpDir, 'ws-b'));
    expect(await mod.buildVideoStudioReviewPanel(UID, 'cid-b')).toEqual({ compositions: [] });
  });
});

// An AUTO production authors each segment as its own composition with its own
// production state. Listing states one-per-row turned one video the user asked
// for into seven "video productions" in the drawer. These cases pin the
// regrouping, and — more importantly — that the regrouped gates never claim
// more progress than every segment actually has.
describe('video studio review panel › assembled productions', () => {
  const SEGMENTS = ['s1_hook', 's2_body', 's3_cta'];

  function writeAssembly(
    workspace: string,
    planPath: string,
    perSegment: (id: string, index: number) => Record<string, unknown>,
    cutProducedPath?: string,
  ): void {
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, JSON.stringify({
      // Plan order is deliberately not the order the state files are written
      // in, and leads with a cut: a segment the assembler produced rather than
      // authored, which has no composition and therefore no gate state.
      segments: [
        { id: 'src_clip', source: 'edit', ...(cutProducedPath ? { produced_path: cutProducedPath } : {}) },
        ...SEGMENTS.map((id) => ({ id, source: 'compose' })),
      ],
    }), 'utf8');
    [...SEGMENTS].reverse().forEach((id, reverseIndex) => {
      const index = SEGMENTS.length - 1 - reverseIndex;
      const dir = path.join(workspace, 'videos', 'promo', 'project', 'compositions', id);
      writeManifest(dir, [{ id, approved_copy: [`copy ${id}`] }]);
      writeState(`state-${id}`, {
        schema_version: 1,
        composition_dir: dir,
        stage: 'preview_ready',
        plan_approval: {
          gate: 'B',
          signature: `sig-${id}`,
          inheritance_reason: 'parent_edl_segment',
          parent_plan_path: planPath,
          parent_segment_id: id,
        },
        ...perSegment(id, index),
      });
    });
  }

  it('groups the segments into one production, in plan order', async () => {
    const workspace = path.join(tmpDir, 'ws-auto');
    WORKSPACE_BY_CID.set('cid-auto', workspace);
    const planPath = path.join(workspace, 'videos', 'promo', 'project', 'plan.json');
    writeAssembly(workspace, planPath, (id) => ({
      task_title: id === 's2_body' ? '做一支产品宣传片' : '',
      preview: { status: 'approved', frame_paths: [`/f/${id}.png`] },
      narration: { status: 'materialized', path: `/a/${id}.mp3`, measured_duration_sec: 2 },
    }));

    const mod = await import('../../../src/main/features/video_studio_review');
    const panel = await mod.buildVideoStudioReviewPanel(UID, 'cid-auto');

    expect(panel.compositions).toHaveLength(1);
    const [production] = panel.compositions;
    // A cut with nothing produced behind it has nothing to show, so it stays
    // out rather than becoming an empty row in the timeline.
    expect(production.segments?.map((segment) => segment.segment_id)).toEqual(SEGMENTS);
    expect(production.scenes.map((scene) => scene.id)).toEqual(SEGMENTS);
    expect(production.scenes.map((scene) => scene.segment_id)).toEqual(SEGMENTS);
    // Titled by what the user asked for, and pathed at the video rather than
    // at any one segment — both are what prefilled instructions quote.
    expect(production.task_title).toBe('做一支产品宣传片');
    expect(production.display_name).toBe('videos/promo/project');
    // Frames aggregate by presence — segments never record an approval, so
    // there is no other value this could truthfully take.
    expect(production.preview?.status).toBe('ready');
    expect(production.preview?.frame_paths).toHaveLength(SEGMENTS.length);
    // No whole-production contact sheet or narration track exists; reporting
    // one segment's as the production's would misname the artifact.
    expect(production.preview?.contact_sheet_path).toBeUndefined();
    expect(production.narration?.audio_path).toBeUndefined();
    expect(production.narration?.duration_sec).toBe(SEGMENTS.length * 2);
  });

  it('reports narration from the parent that owns it, not from the silent children', async () => {
    // 2026-08-06: a finished 60s promo with five spoken lines showed
    // "narration: not started". The assembled route's narration is parent-owned
    // — a child that carries narration text must declare audio.owner:"assembler"
    // and render silent, or composition.approve_plan rejects it — and the panel
    // aggregated narration from those same children, so an assembled production
    // could never report narration at all. It reads the owner now, and counts
    // per line: a record is this plan's narration only while the current plan
    // still holds that line's identity (text + signed synthesis selection).
    const workspace = path.join(tmpDir, 'ws-parent-narration');
    WORKSPACE_BY_CID.set('cid-parent-narration', workspace);
    const planPath = path.join(workspace, 'videos', 'promo', 'project', 'plan.json');
    writeAssembly(workspace, planPath, () => ({
      preview: { status: 'approved', frame_paths: ['/f/x.png'] },
    }));
    const synthesis = {
      route_ref: 'managed:orkas-voice',
      voice_ref: 'managed:orkas-voice:voice:vivi',
      language: 'zh-CN',
      speed: 1,
    };
    const writeNarrationTracks = (texts: string[]) => {
      const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
      plan.tracks = {
        narration: { synthesis, segments: texts.map((text) => ({ text })) },
      };
      fs.writeFileSync(planPath, JSON.stringify(plan), 'utf8');
    };
    writeNarrationTracks(['one', 'two']);
    const control = await import('../../../src/main/features/video_production_control');
    const statePath = control.videoProductionControlStatePath({ userId: UID, planPath });
    const recordLine = (index: number, seconds: number, text: string) => control.recordVideoProductionNarrationLine({
      statePath,
      planPath,
      planSignature: 'sig-plan',
      line: {
        segment_index: index,
        path: `/a/narration-0${index}.mp3`,
        measured_duration_sec: seconds,
        backend: 'orkas-voice',
        language: 'zh-CN',
        speed: 1,
      },
      identity: {
        text,
        routeRef: synthesis.route_ref,
        voiceRef: synthesis.voice_ref,
        language: synthesis.language,
        speed: synthesis.speed,
      },
    });

    const mod = await import('../../../src/main/features/video_studio_review');
    // Half the planned lines: an interrupted assembly reads as partial — with
    // its counts, so the drawer can say 1/2 instead of pretending nothing
    // happened — never as finished narration, and never as nothing.
    await recordLine(0, 3.5, 'one');
    let [production] = (await mod.buildVideoStudioReviewPanel(UID, 'cid-parent-narration')).compositions;
    expect(production.narration).toMatchObject({
      status: 'partial', produced_lines: 1, planned_lines: 2, duration_sec: 3.5, language: 'zh-CN',
    });

    await recordLine(1, 4.5, 'two');
    [production] = (await mod.buildVideoStudioReviewPanel(UID, 'cid-parent-narration')).compositions;
    expect(production.narration).toMatchObject({
      status: 'materialized', produced_lines: 2, planned_lines: 2, duration_sec: 8, speed: 1,
    });
    // Per-line files, so there is no single production narration track to play.
    expect(production.narration?.audio_path).toBeUndefined();
    // No child materialized narration — that is the point: the record the panel
    // reads cannot come from them.
    expect(production.segments?.every((segment) => !segment.narration)).toBe(true);

    // Re-voicing one line supersedes it rather than counting twice.
    await recordLine(1, 5, 'two');
    [production] = (await mod.buildVideoStudioReviewPanel(UID, 'cid-parent-narration')).compositions;
    expect(production.narration?.duration_sec).toBe(8.5);

    // A user-approved edit to ONE line invalidates exactly that line. The
    // first version keyed validity on the whole plan signature, and the very
    // first amendment wiped four untouched, paid, still-mixed lines with it.
    writeNarrationTracks(['one, revised', 'two']);
    [production] = (await mod.buildVideoStudioReviewPanel(UID, 'cid-parent-narration')).compositions;
    expect(production.narration).toMatchObject({
      status: 'partial', produced_lines: 1, planned_lines: 2, duration_sec: 5,
    });

    // Records written before line_identity existed (2026-08-08 run) count
    // while the plan they name is still the currently approved one.
    const rawState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    delete rawState.narration_lines['1'].line_identity;
    rawState.narration_lines['1'].plan_signature = 'sig-current';
    rawState.plan_signature = 'sig-current';
    fs.writeFileSync(statePath, JSON.stringify(rawState), 'utf8');
    [production] = (await mod.buildVideoStudioReviewPanel(UID, 'cid-parent-narration')).compositions;
    expect(production.narration).toMatchObject({ produced_lines: 1, planned_lines: 2 });
    // ...and stop counting once the approved plan moves past them.
    rawState.plan_signature = 'sig-after-another-amendment';
    fs.writeFileSync(statePath, JSON.stringify(rawState), 'utf8');
    [production] = (await mod.buildVideoStudioReviewPanel(UID, 'cid-parent-narration')).compositions;
    expect(production.narration).toBeUndefined();
  });

  it('aggregates evidence by presence and narration only when every segment has it', async () => {
    const workspace = path.join(tmpDir, 'ws-partial');
    WORKSPACE_BY_CID.set('cid-partial', workspace);
    const planPath = path.join(workspace, 'videos', 'promo', 'project', 'plan.json');
    writeAssembly(workspace, planPath, (id) => ({
      preview: { status: 'ready', frame_paths: [] },
      // Only two of three segments are narrated.
      ...(id === 's3_cta' ? {} : { narration: { status: 'materialized', path: `/a/${id}.mp3` } }),
    }));

    const mod = await import('../../../src/main/features/video_studio_review');
    const [production] = (await mod.buildVideoStudioReviewPanel(UID, 'cid-partial')).compositions;

    // Frames are evidence: some segments captured -> the production has frames
    // to show, and no approval state exists for the aggregate to wait on.
    expect(production.preview?.status).toBe('ready');
    // A partially narrated production is not a narrated one.
    expect(production.narration).toBeUndefined();
    expect(production.segments?.map((segment) => segment.preview?.status))
      .toEqual(['ready', 'ready', 'ready']);
  });

  it('does not report a whole-production draft when planned children are still missing', async () => {
    // An AUTO run can be interrupted after producing its first child. The
    // signed plan remains the independent source of truth for how many
    // composition segments exist; aggregating only the state files currently
    // on disk turns this partial run into an apparently complete one.
    const workspace = path.join(tmpDir, 'ws-interrupted');
    WORKSPACE_BY_CID.set('cid-interrupted', workspace);
    const planPath = path.join(workspace, 'videos', 'promo', 'project', 'plan.json');
    writeAssembly(workspace, planPath, (id) => ({
      preview: { status: 'ready', frame_paths: ['/f/s1.png'] },
      ...(id === 's1_hook' ? { draft: { status: 'ready', path: '/d/s1.mp4' } } : {}),
    }));

    const mod = await import('../../../src/main/features/video_studio_review');
    let [production] = (await mod.buildVideoStudioReviewPanel(UID, 'cid-interrupted')).compositions;

    // Do not prescribe placeholders, counters, or another response shape. The
    // observable claim is simply that one child draft is not evidence that the
    // three-child production has a ready draft.
    expect(production.draft?.status).not.toBe('ready');

    // Missing state files are the interrupted-run variant of the same
    // scenario; the plan remains the independent list of required children.
    fs.rmSync(path.join(gatesDir(), 'state-s2_body.json'));
    fs.rmSync(path.join(gatesDir(), 'state-s3_cta.json'));
    [production] = (await mod.buildVideoStudioReviewPanel(UID, 'cid-interrupted')).compositions;
    expect(production.draft?.status).not.toBe('ready');
  });

  it('leaves a standalone composition ungrouped alongside an assembly', async () => {
    const workspace = path.join(tmpDir, 'ws-mixed');
    WORKSPACE_BY_CID.set('cid-mixed', workspace);
    const planPath = path.join(workspace, 'videos', 'promo', 'project', 'plan.json');
    writeAssembly(workspace, planPath, () => ({ preview: { status: 'ready', frame_paths: [] } }));
    const soloDir = path.join(workspace, 'videos', 'explainer', 'project', 'composition');
    writeManifest(soloDir, [{ id: 'cover', approved_copy: [] }]);
    writeState('state-solo', {
      schema_version: 1,
      composition_dir: soloDir,
      stage: 'preview_ready',
      plan_approval: { gate: 'B', signature: 'sig-solo' },
    });

    const mod = await import('../../../src/main/features/video_studio_review');
    const panel = await mod.buildVideoStudioReviewPanel(UID, 'cid-mixed');

    expect(panel.compositions).toHaveLength(2);
    const solo = panel.compositions.find((comp) => comp.composition_dir === soloDir);
    expect(solo?.segments).toBeUndefined();
    expect(panel.compositions.find((comp) => comp.segments)?.segments).toHaveLength(3);
  });

  it('does not group under a parent plan outside this workspace', async () => {
    // The panel could neither title nor resolve that plan, so its segments
    // stay listed on their own rather than under a path it cannot show.
    const workspace = path.join(tmpDir, 'ws-foreign');
    WORKSPACE_BY_CID.set('cid-foreign', workspace);
    const foreignPlan = path.join(tmpDir, 'elsewhere', 'project', 'plan.json');
    const dir = path.join(workspace, 'videos', 'promo', 'project', 'compositions', 's1_hook');
    writeManifest(dir, [{ id: 's1_hook', approved_copy: [] }]);
    writeState('state-foreign', {
      schema_version: 1,
      composition_dir: dir,
      stage: 'preview_ready',
      plan_approval: {
        gate: 'B',
        signature: 'sig',
        inheritance_reason: 'parent_edl_segment',
        parent_plan_path: foreignPlan,
        parent_segment_id: 's1_hook',
      },
    });

    const mod = await import('../../../src/main/features/video_studio_review');
    const panel = await mod.buildVideoStudioReviewPanel(UID, 'cid-foreign');
    expect(panel.compositions).toHaveLength(1);
    expect(panel.compositions[0].segments).toBeUndefined();
    expect(panel.compositions[0].composition_dir).toBe(dir);
  });

  it('shows a produced cut in timeline order without holding the gates on it', async () => {
    // 2026-08-05: the opening shot of a nine-segment video was `source:"edit"`,
    // so it had no gate state and vanished from the review it was part of. It
    // belongs in the timeline — but a cut has no plan, preview, or draft gate
    // to reach, so counting it would hold every mixed production at "waiting".
    const workspace = path.join(tmpDir, 'ws-cut');
    WORKSPACE_BY_CID.set('cid-cut', workspace);
    const planPath = path.join(workspace, 'videos', 'promo', 'project', 'plan.json');
    const cutPath = path.join(workspace, 'videos', 'promo', 'project', 'cuts', 'src_clip.mp4');
    fs.mkdirSync(path.dirname(cutPath), { recursive: true });
    fs.writeFileSync(cutPath, 'cut bytes');
    writeAssembly(workspace, planPath, () => ({
      preview: { status: 'ready', frame_paths: [] },
      draft: { status: 'ready', path: '/d/part.mp4' },
    }), cutPath);

    const mod = await import('../../../src/main/features/video_studio_review');
    const [production] = (await mod.buildVideoStudioReviewPanel(UID, 'cid-cut')).compositions;

    expect(production.segments?.map((segment) => segment.segment_id))
      .toEqual(['src_clip', ...SEGMENTS]);
    expect(production.segments?.map((segment) => segment.kind))
      .toEqual(['media', 'composition', 'composition', 'composition']);
    // One scene, and it is the clip itself — the panel plays it where a
    // composition would show a sampled frame.
    const cutScene = production.scenes.find((scene) => scene.segment_id === 'src_clip');
    expect(cutScene).toMatchObject({ id: 'src_clip', media_path: cutPath, approved_copy: [] });
    expect(cutScene?.frame_path).toBeUndefined();
    expect(production.scenes.map((scene) => scene.id)).toEqual(['src_clip', ...SEGMENTS]);
    // Presence still describes how far the authored work got, and the media
    // segment does not dilute it.
    expect(production.preview?.status).toBe('ready');
    expect(production.draft?.status).toBe('ready');
    expect(production.plan_approved).toBe(true);
    expect(production.stage).toBe('preview_ready');
  });

  it('leaves out produced media the panel could not display', async () => {
    // Same fail-closed rule the host applies to `captured`: a row the panel
    // cannot render is worse than no row, because the production review would
    // claim to have shown it.
    const workspace = path.join(tmpDir, 'ws-cut-bad');
    WORKSPACE_BY_CID.set('cid-cut-bad', workspace);
    const planPath = path.join(workspace, 'videos', 'promo', 'project', 'plan.json');
    const outside = path.join(tmpDir, 'outside-workspace.mp4');
    fs.writeFileSync(outside, 'bytes');

    const mod = await import('../../../src/main/features/video_studio_review');
    const segmentIdsFor = async (cutPath: string) => {
      writeAssembly(workspace, planPath, () => ({}), cutPath);
      return (await mod.buildVideoStudioReviewPanel(UID, 'cid-cut-bad'))
        .compositions[0].segments?.map((segment) => segment.segment_id);
    };

    expect(await segmentIdsFor(path.join(workspace, 'videos', 'promo', 'project', 'cuts', 'gone.mp4')),
      'a produced_path with no file behind it').toEqual(SEGMENTS);
    expect(await segmentIdsFor(outside), 'a path outside this conversation workspace').toEqual(SEGMENTS);
  });

  it('falls back to segment-id order when the plan cannot be read', async () => {
    const workspace = path.join(tmpDir, 'ws-noplan');
    WORKSPACE_BY_CID.set('cid-noplan', workspace);
    const planPath = path.join(workspace, 'videos', 'promo', 'project', 'plan.json');
    writeAssembly(workspace, planPath, () => ({}));
    fs.writeFileSync(planPath, '{ broken', 'utf8');

    const mod = await import('../../../src/main/features/video_studio_review');
    const [production] = (await mod.buildVideoStudioReviewPanel(UID, 'cid-noplan')).compositions;
    expect(production.segments?.map((segment) => segment.segment_id)).toEqual(SEGMENTS);
  });

  it('deduplicates shared evidence files in the whole-production frame strip', async () => {
    // Candidate-tier locators may all name the same shared evidence file
    // (draft QA writes render/draft-evidence/* per run); the drawer's
    // whole-production overview must not repeat one file per segment.
    const workspace = path.join(tmpDir, 'ws-dedupe');
    WORKSPACE_BY_CID.set('cid-dedupe', workspace);
    const planPath = path.join(workspace, 'videos', 'promo', 'project', 'plan.json');
    const shared = path.join(workspace, 'videos', 'promo', 'project', 'render', 'draft-evidence', '01-first-frame.png');
    writeAssembly(workspace, planPath, (id) => ({
      preview: { status: 'ready', frame_paths: [shared, `/own/${id}.png`] },
    }));

    const mod = await import('../../../src/main/features/video_studio_review');
    const [production] = (await mod.buildVideoStudioReviewPanel(UID, 'cid-dedupe')).compositions;
    expect(production.preview?.frame_paths).toEqual([
      shared, '/own/s1_hook.png', '/own/s2_body.png', '/own/s3_cta.png',
    ]);
  });

  it('recovers the parent link from approval history when a re-sign dropped it', async () => {
    // 2026-08-06: a mid-run Gate B re-sign rewrote four of six child approvals
    // without the parent linkage, and the drawer scattered one video into
    // five rows. Being a segment of a plan is structural — the newest history
    // entry that still carries the link keeps the production whole.
    const workspace = path.join(tmpDir, 'ws-history');
    WORKSPACE_BY_CID.set('cid-history', workspace);
    const planPath = path.join(workspace, 'videos', 'promo', 'project', 'plan.json');
    writeAssembly(workspace, planPath, () => ({}));
    for (const id of ['s1_hook', 's3_cta']) {
      const statePath = path.join(gatesDir(), `state-${id}.json`);
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, unknown>;
      const linked = state.plan_approval as Record<string, unknown>;
      state.plan_approval_history = [linked];
      state.plan_approval = {
        gate: 'B',
        signature: `resigned-${id}`,
        turn_id: 't-resign',
      };
      fs.writeFileSync(statePath, JSON.stringify(state), 'utf8');
    }

    const mod = await import('../../../src/main/features/video_studio_review');
    const panel = await mod.buildVideoStudioReviewPanel(UID, 'cid-history');
    expect(panel.compositions).toHaveLength(1);
    expect(panel.compositions[0].segments?.map((segment) => segment.segment_id)).toEqual(SEGMENTS);
  });

  it('shows candidate frame and render evidence without reading it as progress', async () => {
    // A QA-blocked snapshot/draft persists its locators on the candidate but
    // never becomes state.preview/state.draft. The 2026-08-06 drawer showed
    // 暂无预览帧 beside a delivered video whose frames were all on disk.
    const workspace = path.join(tmpDir, 'ws-candidate');
    WORKSPACE_BY_CID.set('cid-candidate', workspace);
    const compositionDir = path.join(workspace, 'project', 'compositions', 's2_pain');
    writeManifest(compositionDir, [{ id: 's2_pain', approved_copy: ['copy'] }]);
    const midFrame = path.join(compositionDir, 'snapshot-frames', 'r1', '02-s2-pain-mid.png');
    writeState('state-candidate', {
      schema_version: 1,
      composition_dir: compositionDir,
      stage: 'scaffold_ready',
      plan_approval: { gate: 'B', signature: 'sig' },
      current_candidate: {
        revision_id: 'candidate-r1',
        content_hash: 'hash',
        artifacts: {},
        locators: {
          preview_path: path.join(workspace, 'project', 'render', 'draft-evidence', 'contact-sheet.png'),
          frame_paths: [midFrame],
          draft_path: path.join(workspace, 'project', 'render', 's2_pain.mp4'),
        },
        runtime_fingerprint: 'fp',
        created_at: 'now',
        last_observed_at: 'now',
        last_observed_op: 'composition.draft',
        last_quality_result: { ok: false, error_code: 'E_VIDEO_QA_BLOCKED', observed_at: 'now' },
      },
    });

    const mod = await import('../../../src/main/features/video_studio_review');
    const [production] = (await mod.buildVideoStudioReviewPanel(UID, 'cid-candidate')).compositions;
    expect(production.preview?.status).toBe('candidate');
    expect(production.preview?.frame_paths).toEqual([midFrame]);
    expect(production.scenes[0]?.frame_path).toBe(midFrame);
    expect(production.draft).toEqual({
      status: 'qa_blocked',
      path: path.join(workspace, 'project', 'render', 's2_pain.mp4'),
    });
  });

  it('does not resurrect a superseded draft path whose quality result passed', async () => {
    // state.draft deleted by a plan change with quality ok means the artifact
    // is history, not the current unapproved version.
    const workspace = path.join(tmpDir, 'ws-superseded');
    WORKSPACE_BY_CID.set('cid-superseded', workspace);
    const compositionDir = path.join(workspace, 'project', 'composition');
    writeManifest(compositionDir, [{ id: 'cover', approved_copy: [] }]);
    writeState('state-superseded', {
      schema_version: 1,
      composition_dir: compositionDir,
      stage: 'manifest_ready',
      plan_approval: { gate: 'B', signature: 'sig' },
      current_candidate: {
        revision_id: 'candidate-r2',
        content_hash: 'hash',
        artifacts: {},
        locators: { draft_path: path.join(workspace, 'project', 'render', 'old.mp4') },
        runtime_fingerprint: 'fp',
        created_at: 'now',
        last_observed_at: 'now',
        last_observed_op: 'composition.draft',
        last_quality_result: { ok: true, observed_at: 'now' },
      },
    });

    const mod = await import('../../../src/main/features/video_studio_review');
    const [production] = (await mod.buildVideoStudioReviewPanel(UID, 'cid-superseded')).compositions;
    expect(production.draft).toBeUndefined();
    expect(production.preview).toBeUndefined();
  });

  it('shows an unregistered cut from the assembler contract location', async () => {
    // The assembler writes an edit segment to project/cuts/<id>.mp4 and is
    // supposed to record it as produced_path. 2026-08-06: the write-back was
    // skipped and the user's own footage vanished from the review of the
    // video it opens. The contract location is probed — and only it.
    const workspace = path.join(tmpDir, 'ws-cut-fallback');
    WORKSPACE_BY_CID.set('cid-cut-fallback', workspace);
    const planPath = path.join(workspace, 'videos', 'promo', 'project', 'plan.json');
    const cutPath = path.join(workspace, 'videos', 'promo', 'project', 'cuts', 'src_clip.mp4');
    fs.mkdirSync(path.dirname(cutPath), { recursive: true });
    fs.writeFileSync(cutPath, 'cut bytes');
    // No produced_path recorded on src_clip.
    writeAssembly(workspace, planPath, () => ({}));

    const mod = await import('../../../src/main/features/video_studio_review');
    const [production] = (await mod.buildVideoStudioReviewPanel(UID, 'cid-cut-fallback')).compositions;
    expect(production.segments?.map((segment) => segment.segment_id))
      .toEqual(['src_clip', ...SEGMENTS]);
    expect(production.segments?.[0]?.media_path).toBe(cutPath);

    // Negative control: no file at the contract location -> no invented row.
    fs.rmSync(cutPath);
    const [rerun] = (await mod.buildVideoStudioReviewPanel(UID, 'cid-cut-fallback')).compositions;
    expect(rerun.segments?.map((segment) => segment.segment_id)).toEqual(SEGMENTS);
  });

  it('reports the delivered final from the plan runtime record', async () => {
    // Assembly runs through generic edit ops that write no per-segment gate
    // state, so the finished video must not depend on composition drafts to
    // be reported. `_runtime.render.final_path` is that record.
    const workspace = path.join(tmpDir, 'ws-final');
    WORKSPACE_BY_CID.set('cid-final', workspace);
    const planPath = path.join(workspace, 'videos', 'promo', 'project', 'plan.json');
    writeAssembly(workspace, planPath, () => ({}));
    const finalPath = path.join(workspace, 'videos', 'promo', 'project', 'render', 'video.mp4');
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    fs.writeFileSync(finalPath, 'final bytes');
    const planRaw = JSON.parse(fs.readFileSync(planPath, 'utf8')) as Record<string, unknown>;
    planRaw._runtime = { render: { final_path: 'project/render/video.mp4' } };
    fs.writeFileSync(planPath, JSON.stringify(planRaw), 'utf8');

    const mod = await import('../../../src/main/features/video_studio_review');
    const [production] = (await mod.buildVideoStudioReviewPanel(UID, 'cid-final')).compositions;
    expect(production.final?.path).toBe(finalPath);
    // Delivery is draft-step evidence on its own.
    expect(production.draft?.status).toBe('ready');

    // Negative control: a recorded final with no file behind it claims nothing.
    fs.rmSync(finalPath);
    const [rerun] = (await mod.buildVideoStudioReviewPanel(UID, 'cid-final')).compositions;
    expect(rerun.final).toBeUndefined();
    expect(rerun.draft).toBeUndefined();
  });
});
