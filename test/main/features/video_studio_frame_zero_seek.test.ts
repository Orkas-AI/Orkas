import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildTimelineAdapterScript } from '../../../src/main/features/video_studio';
import type { CompositionMeta } from '../../../src/main/features/video_studio_qa';

// Why this file exists: for three days every composed opening captured blank
// (EMPTY_HOOK_FRAME + EXPECTED_SCENE_NOT_VISIBLE + HOOK_PROMISE_NOT_VISIBLE)
// while later frames rendered correctly, and each run was diagnosed as the
// model animating in from opacity 0. It was not. The scaffold hides every
// scene (`.clip { opacity:0; visibility:hidden }`) and the authored timeline
// reveals scene 1 with a zero-duration set at position 0 — exactly what the
// skill asks for — but GSAP skips rendering when the playhead already sits at
// the requested time, and a fresh paused timeline sits at 0. So position 0
// was never rendered and frame 0 was structurally doomed.

const GSAP_PATH = path.join(
  __dirname, '../../../resources/builtin/marketplace/agents/79df9cc89f5f',
  'skills/stage-compose/scripts/vendor/gsap.min.js',
);

type Style = { opacity: string; visibility: string };

/** Load the bundled GSAP against a minimal DOM so its real scheduling
 *  behavior — not a reimplementation of it — is what the test observes. */
function loadBundledGsap(): { gsap: any; el: { style: Style }; reset: () => void } {
  const style: Style = { opacity: '', visibility: '' };
  const el: any = {
    style,
    nodeType: 1,
    tagName: 'DIV',
    getAttribute: () => null,
    setAttribute: () => {},
    getBoundingClientRect: () => ({ width: 100, height: 100, top: 0, left: 0 }),
    parentNode: null,
  };
  const doc: any = {
    querySelectorAll: () => [el],
    querySelector: () => el,
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, getAttribute: () => null }),
    createElementNS: () => ({ style: {}, setAttribute() {}, appendChild() {}, getAttribute: () => null }),
    documentElement: { style: {} },
    body: { style: {}, appendChild() {} },
    addEventListener() {},
    removeEventListener() {},
  };
  el.ownerDocument = doc;
  const computed = () => ({ getPropertyValue: () => '', opacity: '1', visibility: 'visible', display: 'block' });
  const win: any = {
    document: doc,
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(16), 16),
    cancelAnimationFrame: (id: any) => clearTimeout(id),
    getComputedStyle: computed,
    navigator: { userAgent: 'node' },
    innerWidth: 1920,
    innerHeight: 1080,
    matchMedia: () => ({ matches: false, addListener() {}, removeListener() {} }),
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const factory = new Function(
    'window', 'document', 'navigator', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle',
    `${fs.readFileSync(GSAP_PATH, 'utf8')}; return (typeof gsap !== 'undefined') ? gsap : window.gsap;`,
  );
  const gsap = factory(
    win, doc, win.navigator, win.requestAnimationFrame, win.cancelAnimationFrame, computed,
  );
  return {
    gsap,
    el,
    reset: () => {
      style.opacity = '';
      style.visibility = '';
      delete el._gsap;
    },
  };
}

/** The composition shape the scaffold produces: hidden by CSS, revealed by a
 *  zero-duration set at the scene's start. */
function sceneRevealTimeline(gsap: any, el: unknown) {
  const tl = gsap.timeline({ paused: true });
  tl.set(el, { autoAlpha: 1 }, 0);
  tl.set(el, { autoAlpha: 0 }, 5.875);
  tl.pause();
  return tl;
}

describe('frame-zero seek against the bundled GSAP', () => {
  it('reproduces the skipped render at position 0, with later frames as the control', () => {
    const { gsap, el, reset } = loadBundledGsap();

    reset();
    const atZero = sceneRevealTimeline(gsap, el);
    atZero.seek(0, false);
    // The defect: nothing was written, so the scaffold's hidden state stands.
    expect(el.style.opacity).toBe('');
    expect(el.style.visibility).toBe('');

    // Control: the identical timeline seeked anywhere else DOES apply the
    // set, which proves the write path works and isolates the cause to the
    // playhead-already-there short circuit.
    for (const t of [0.5, 3]) {
      reset();
      const later = sceneRevealTimeline(gsap, el);
      later.seek(t, false);
      expect(el.style.opacity, `seek(${t})`).toBe(1);
      expect(el.style.visibility, `seek(${t})`).toBe('inherit');
    }
  });

  it('applies position 0 when the render is forced, which is the shipped fix', () => {
    const { gsap, el, reset } = loadBundledGsap();
    reset();
    const tl = sceneRevealTimeline(gsap, el);
    const before = Number(tl.time());
    tl.seek(0, false);
    // The guard the adapter applies: force only when the seek was a no-op.
    expect(Math.abs(before - 0) < 1e-6).toBe(true);
    tl.render(0, false, true);
    expect(el.style.opacity).toBe(1);
    expect(el.style.visibility).toBe('inherit');
  });

  it('ships that guard in the timeline adapter the renderer injects', () => {
    const meta = {
      htmlPath: '/ws/index.html',
      html: '',
      rootAttrs: {},
      id: 'main',
      width: 1920,
      height: 1080,
      durationSec: 50.875,
      audioTracks: [],
    } as CompositionMeta;
    const script = buildTimelineAdapterScript(meta);
    expect(script).toContain('tl.render(t, false, true)');
    expect(script).toMatch(/Math\.abs\(before - t\) < 1e-6/);
    // The forced render must not replace the ordinary seek path.
    expect(script).toContain('tl.seek(t, false)');
  });
});
