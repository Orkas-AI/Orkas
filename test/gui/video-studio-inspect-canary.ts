/**
 * Composition inspect/capture canary — checks that need a real window.
 *
 * `composition.inspect` seeks a hidden BrowserWindow to frame 0 and reads the
 * DOM to decide whether the video opens on a visible promise. The unit suite
 * runs Electron as plain Node (`ELECTRON_RUN_AS_NODE`), so `BrowserWindow` is
 * unavailable there and every `inspectComposition` case in it stops at
 * preflight: the runtime probe, and every verdict that depends on measuring
 * the page, had no automated coverage at all. That gap is what let a waiver
 * the host had accepted and stored stay inert inside inspect — the user picked
 * "skip this check", was told it could not be skipped, and nothing failed
 * (2026-09-01).
 *
 * So this runs the same production entry points under a GUI Electron main
 * process (`test/gui/electron-main.mjs` provides the host). It is
 * deterministic and offline: no model, no network, no account. Fixtures come
 * from the product's own scaffold generator, so a cover the product emits and
 * then rejects fails here rather than in a user's conversation.
 * Capture cases also exercise native viewport faults and verify the resulting
 * PNG geometry and edge content independently of the DOM inspection.
 *
 * Exit codes are distinct on purpose: 0 pass, 1 a case failed, 2 the host
 * could not give us a window at all (an environment fault, not a defect).
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { app, nativeImage, type BrowserWindow } from 'electron';

type Issue = { code?: string; severity?: string; disposition?: string; message?: string; waived_by_user?: boolean };
type InspectResult = Record<string, unknown> & { findings?: unknown };
type CompositionOptions = {
  compositionDirAbs: string;
  waivedQaFindings?: string[];
  snapshotAbsPath?: string;
};
type VideoStudio = {
  inspectComposition: (p: CompositionOptions) => Promise<InspectResult>;
  prepareComposition: (p: CompositionOptions) => Promise<InspectResult>;
  snapshotComposition: (p: CompositionOptions) => Promise<InspectResult>;
};

// The production feature modules are CommonJS; this runner is ESM because the
// GUI host imports it. Load them the way the other Electron-hosted runners do.
let videoStudio: VideoStudio;

const CANARY_EXIT_PASS = 0;
const CANARY_EXIT_FAILED = 1;
const CANARY_EXIT_NO_WINDOW = 2;

/** Codes the probe emits when it could not measure the page at all. Seeing one
 *  means this host has no usable window, which is an environment fault: the
 *  canary reports it separately instead of blaming the composition. */
const PROBE_UNAVAILABLE_CODES = new Set(['INSPECT_RENDERER_FAILED', 'INSPECT_RENDERER_TIMEOUT']);

function issuesOf(result: InspectResult): Issue[] {
  try {
    const parsed = JSON.parse(String(result.findings || '{}')) as { issues?: Issue[] };
    return Array.isArray(parsed.issues) ? parsed.issues : [];
  } catch {
    return [];
  }
}

function errorCodesOf(result: InspectResult): string[] {
  return issuesOf(result).filter((issue) => issue.severity === 'error').map((issue) => String(issue.code || ''));
}

class ProbeUnavailable extends Error {}

function assertProbeRan(result: InspectResult): void {
  const unavailable = errorCodesOf(result).find((code) => PROBE_UNAVAILABLE_CODES.has(code));
  if (!unavailable) return;
  const detail = issuesOf(result).find((issue) => issue.code === unavailable)?.message || '';
  throw new ProbeUnavailable(`${unavailable}: ${detail}`);
}

const BASE_MANIFEST = {
  schema_version: 1,
  composition: { id: 'main', width: 1920, height: 1080, duration: 6, fps: 30, language: 'en' },
  scenes: [{
    id: 'cover',
    start: 0,
    duration: 6,
    approved_copy: ['Launch day is here'],
    narration_refs: [],
    source_shots: [],
    roles: ['title', 'visual'],
  }],
  audio: { owner: 'none', tracks: [] },
  art_direction: {
    aesthetic: {
      subject_world: 'editorial launch surface with measured signal marks',
      one_job: 'make the launch promise readable at video scale',
      signature_device: 'a measured signal path that anchors each frame',
      aesthetic_risk: 'avoid generic cards by using one strong visual axis',
      anti_template_check: 'reject centered cards and decorative blobs; use a measured signal path and editorial scale',
    },
    visual_direction: {
      visual_tradition: 'Swiss Pulse precision grid',
      lazy_defaults_rejected: 'reject centered cards and decorative blobs; replace with editorial scale and a measured signal path',
      video_scale: { hero_title_min_px: 88, label_min_px: 28, safe_zone_px: { left: 120, right: 120, top: 90, bottom: 90 } },
      depth_layer_rule: 'quiet field, dominant signal/title layer, foreground measurement accents',
      motion_verb_rule: ['draw', 'align', 'resolve'],
      rhythm_pattern: 'quick hook, measured hold, clear payoff',
    },
    cover: {
      scene_id: 'cover',
      headline: 'Launch day is here',
      content_signals: ['launch subject', 'measured signal path'],
      hero_visual: 'the launch subject locked to a measured signal path',
      composition_strategy: 'large approved promise plus topic-specific hero in one readable thumbnail frame',
      frame_time_sec: 0,
    },
    scenes: [{
      id: 'cover',
      start: 0,
      duration: 6,
      scene_world: 'editorial signal field',
      depth_layers: ['quiet field', 'signal/title layer', 'measurement accents'],
      motion_verbs: ['draw', 'align'],
      focal_change: 'the signal path resolves under the promise',
    }],
    motion_budget: { scene_motion_seconds: 6, hold_seconds: 2 },
    scene_variation: { rule: 'each scene changes framing and depth emphasis' },
  },
};

/** One composition scaffolded by the product itself, so the passing case is
 *  the HTML the product actually emits rather than a hand-written stand-in. */
async function scaffoldComposition(root: string, label: string): Promise<string> {
  const dir = path.join(root, label, 'project', 'composition');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'composition-manifest.json'),
    JSON.stringify(BASE_MANIFEST, null, 2),
    'utf8',
  );
  const prepared = await videoStudio.prepareComposition({ compositionDirAbs: dir });
  if (prepared.ok !== true) {
    throw new Error(`scaffold failed for ${label}: ${prepared.errorCode || ''} ${prepared.message || ''}`);
  }
  return dir;
}

/** The dominant real-world cause of a blank cover: an enter animation that
 *  zeroes the title at t=0. `gsap.from` leaves opacity 0 at timeline position
 *  0, which is exactly the state the frame-0 probe measures. */
async function fadeTitleInFromTransparent(compositionDirAbs: string): Promise<void> {
  const htmlPath = path.join(compositionDirAbs, 'index.html');
  const html = await fs.readFile(htmlPath, 'utf8');
  const marker = '      // ORKAS-SCENE-MOTION-BEGIN:cover';
  if (!html.includes(marker)) throw new Error('scaffold no longer exposes the cover scene-motion block');
  await fs.writeFile(
    htmlPath,
    html.replace(
      marker,
      `${marker}\n      tl.from('[data-scene-id="cover"] [data-role="title"]', { opacity: 0, duration: 1 }, S("cover"));`,
    ),
    'utf8',
  );
}

type Case = { name: string; run: () => Promise<string[]> };

/** Each case returns the reasons it failed; an empty list is a pass. */
function buildCases(root: string): Case[] {
  return [
    {
      name: 'a display-clamped window still previews the full approved video canvas',
      run: async () => {
        const dir = await scaffoldComposition(root, 'display-clamped-preview');
        const entry = path.join(dir, 'index.html');
        const html = await fs.readFile(entry, 'utf8');
        // Fixed canvas coordinates, not viewport-relative positions: stretching
        // a cropped capture cannot manufacture the missing bottom-right mark.
        await fs.writeFile(entry, html
          .replace('</style>', 'html, body { background: #234567; }</style>')
          .replace('</body>', '<div style="position:absolute;left:1880px;top:1040px;width:40px;height:40px;background:#ff0000;z-index:9999"></div></body>'));
        let clamped = 0;
        const clampCreatedWindow = (_event: unknown, win: BrowserWindow) => {
          // Electron's Windows/Linux constructor centers and clamps the outer
          // window to the display work area, even with useContentSize. Inject
          // the observed 1920x1080 -> 1904x993 content size on every GUI host.
          win.setContentSize(1904, 993);
          clamped += 1;
        };
        app.on('browser-window-created', clampCreatedWindow);
        const snapshotAbsPath = path.join(dir, 'preview', 'frame.png');
        let result: InspectResult;
        try {
          result = await videoStudio.snapshotComposition({
            compositionDirAbs: dir,
            snapshotAbsPath,
          });
        } finally {
          app.removeListener('browser-window-created', clampCreatedWindow);
        }
        const failures: string[] = [];
        if (clamped === 0) failures.push('the native-window fault was not exercised');
        if (result.ok !== true) {
          const qa = result.preview_qa as { issues?: Issue[] } | undefined;
          const codes = qa?.issues?.map((issue) => issue.code) || errorCodesOf(result);
          return [...failures, `preview failed: ${String(result.errorCode)} ${String(result.message)}; findings: ${codes.join(', ')}`];
        }
        const image = nativeImage.createFromPath(snapshotAbsPath);
        const size = image.getSize();
        if (size.width !== 1920 || size.height !== 1080) failures.push(`expected 1920x1080 PNG, got ${size.width}x${size.height}`);
        const pixel = image.crop({ x: 1900, y: 1060, width: 1, height: 1 }).toBitmap();
        // NativeImage stores BGRA. Display color management may remap pure
        // red, but the mark must remain opaque and red-dominant, unlike the
        // blue canvas background or a missing/black capture edge.
        if (pixel[2] < 128 || pixel[2] <= 2 * pixel[0] || pixel[2] <= 2 * pixel[1] || pixel[3] < 240) {
          failures.push('the bottom-right canvas mark was cropped or distorted');
        }
        return failures;
      },
    },
    {
      name: 'the product scaffold opens on a cover its own inspect accepts',
      run: async () => {
        const dir = await scaffoldComposition(root, 'scaffold-visible-cover');
        const result = await videoStudio.inspectComposition({ compositionDirAbs: dir }) as InspectResult;
        assertProbeRan(result);
        const failures: string[] = [];
        if (result.ok !== true) failures.push(`expected ok, got ${String(result.errorCode || result.status)}`);
        if (result.stage !== 'runtime_probe') failures.push(`expected the probe to run, stage=${String(result.stage)}`);
        const codes = errorCodesOf(result);
        if (codes.length) failures.push(`expected no blocking findings, got ${codes.join(', ')}`);
        return failures;
      },
    },
    {
      name: 'a cover that fades in from transparent is blocked before rendering',
      run: async () => {
        const dir = await scaffoldComposition(root, 'cover-fades-in');
        await fadeTitleInFromTransparent(dir);
        const result = await videoStudio.inspectComposition({ compositionDirAbs: dir }) as InspectResult;
        assertProbeRan(result);
        const failures: string[] = [];
        if (result.ok !== false) failures.push('expected the cover check to block');
        if (result.errorCode !== 'E_INSPECT_BLOCKED') failures.push(`expected E_INSPECT_BLOCKED, got ${String(result.errorCode)}`);
        if (result.fatal_error_count !== 1) failures.push(`expected one fatal finding, got ${String(result.fatal_error_count)}`);
        const cover = issuesOf(result).find((issue) => issue.code === 'HOOK_PROMISE_NOT_VISIBLE');
        if (!cover) failures.push('expected HOOK_PROMISE_NOT_VISIBLE');
        // The measured reason is the half that turns a report into a repair.
        else if (!/Measured at this frame/.test(String(cover.message))) {
          failures.push(`expected the measured reason in the finding, got: ${String(cover.message).slice(0, 120)}`);
        }
        return failures;
      },
    },
    {
      name: 'the user can skip the cover check they were offered',
      run: async () => {
        const dir = await scaffoldComposition(root, 'cover-waived');
        await fadeTitleInFromTransparent(dir);
        const blocked = await videoStudio.inspectComposition({ compositionDirAbs: dir }) as InspectResult;
        assertProbeRan(blocked);
        const failures: string[] = [];
        if (blocked.ok !== false) failures.push('setup: expected the cover check to block first');

        const waived = await videoStudio.inspectComposition({
          compositionDirAbs: dir,
          waivedQaFindings: ['HOOK_PROMISE_NOT_VISIBLE'],
        }) as InspectResult;
        assertProbeRan(waived);
        if (waived.ok !== true) failures.push(`expected the waiver to clear inspect, got ${String(waived.errorCode)}`);
        if (waived.fatal_error_count !== 0) failures.push(`expected no fatal findings, got ${String(waived.fatal_error_count)}`);
        // Accepted, not unseen: the finding stays in the report as their call.
        const kept = issuesOf(waived).find((issue) => issue.code === 'HOOK_PROMISE_NOT_VISIBLE');
        if (!kept) failures.push('expected the waived finding to stay in the report');
        else if (kept.waived_by_user !== true || kept.disposition !== 'advisory') {
          failures.push(`expected the finding recorded as the user's decision, got ${JSON.stringify(kept.disposition)}/${JSON.stringify(kept.waived_by_user)}`);
        }
        return failures;
      },
    },
    {
      name: 'a waiver names one finding and is not a blanket pass',
      run: async () => {
        const dir = await scaffoldComposition(root, 'cover-waived-unrelated');
        await fadeTitleInFromTransparent(dir);
        const result = await videoStudio.inspectComposition({
          compositionDirAbs: dir,
          waivedQaFindings: ['TEXT_OVERFLOW'],
        }) as InspectResult;
        assertProbeRan(result);
        const failures: string[] = [];
        if (result.ok !== false) failures.push('an unrelated waiver must leave the cover block in place');
        if (result.fatal_error_count !== 1) failures.push(`expected one fatal finding, got ${String(result.fatal_error_count)}`);
        return failures;
      },
    },
  ];
}

export async function main(): Promise<number> {
  videoStudio = await import('../../src/main/features/video_studio') as unknown as VideoStudio;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orkas-vs-inspect-canary-'));
  let failed = 0;
  try {
    for (const testCase of buildCases(root)) {
      let failures: string[];
      try {
        failures = await testCase.run();
      } catch (err) {
        if (err instanceof ProbeUnavailable) {
          process.stderr.write(
            `[inspect-canary] no usable window on this host: ${err.message}\n`
            + '[inspect-canary] this canary needs a GUI Electron session (macOS/Windows desktop); it cannot run headless.\n',
          );
          return CANARY_EXIT_NO_WINDOW;
        }
        failures = [`threw: ${(err as Error).message}`];
      }
      if (failures.length) {
        failed += 1;
        process.stdout.write(`FAIL ${testCase.name}\n`);
        for (const reason of failures) process.stdout.write(`     ${reason}\n`);
      } else {
        process.stdout.write(`ok   ${testCase.name}\n`);
      }
    }
    process.stdout.write(`[inspect-canary] ${failed ? `${failed} failed` : 'all cases passed'}\n`);
    return failed ? CANARY_EXIT_FAILED : CANARY_EXIT_PASS;
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => { /* temp root */ });
  }
}
