import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { declaredCompositionFps, qualityFps } from '../../../src/main/features/video_studio';

// The manifest's `fps` reached the design contract's canvas and stopped there:
// nothing on the render path ever read it, so every non-draft render came out
// at the house default of 30 whatever the composition asked for. A 2026-08-09
// run declared 30 and the draft rendered 15, which is correct for a draft — but
// a composition declaring 24 or 60 was being silently re-rated on export, and
// the plan summary the user approves reads its fps from the same manifest.

const tmpRoots: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-render-fps-'));
  tmpRoots.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true });
});

function withManifest(fps: unknown): string {
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, 'composition-manifest.json'),
    JSON.stringify({ composition: { width: 1920, height: 1080, duration: 30, fps } }),
  );
  return dir;
}

describe('render frame rate resolution', () => {
  it('honours what the composition declared instead of the house default', () => {
    expect(qualityFps(undefined, undefined, 60)).toBe(60);
    expect(qualityFps('high', undefined, 24)).toBe(24);
    expect(qualityFps('standard', undefined, 24)).toBe(24);
    // No declaration, no request: the default stands.
    expect(qualityFps('high', undefined, undefined)).toBe(30);
  });

  it('keeps an explicit request above the declaration, and draft below it', () => {
    // The caller asked for a rate: that is the answer, declaration or not.
    expect(qualityFps('high', 48, 24)).toBe(48);
    // A draft is deliberately cheap and is labelled as one.
    expect(qualityFps('draft', undefined, 60)).toBe(15);
    // Nothing escapes the ceiling.
    expect(qualityFps('high', 240, undefined)).toBe(60);
    expect(qualityFps('high', undefined, 240)).toBe(60);
  });

  it('reads the declaration from the manifest, and survives its absence', async () => {
    expect(await declaredCompositionFps(withManifest(24))).toBe(24);
    expect(await declaredCompositionFps(withManifest(90))).toBe(60);
    // A composition with no manifest, or a manifest with no usable fps, must
    // not fail the render — it simply has nothing to declare.
    expect(await declaredCompositionFps(withManifest(0))).toBeUndefined();
    expect(await declaredCompositionFps(withManifest('30'))).toBeUndefined();
    expect(await declaredCompositionFps(tmpDir())).toBeUndefined();
  });
});
