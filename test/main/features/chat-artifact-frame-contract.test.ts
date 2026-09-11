import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { ARTIFACT_FRAME } from '../../../src/main/features/chat_artifacts';

/**
 * The renderer owns the iframe; `create_artifact`'s smoke owns the gate that
 * decides whether an artifact may be shown at all. They only agree because two
 * files happen to contain the same numbers.
 *
 * 2026-08-26: the smoke validated at 1280x800 while the frame gave the artifact
 * roughly 480x420, and three consecutive artifacts shipped clipped with a
 * passing smoke behind them. A gate measured against the wrong box is worse
 * than no gate — it produces evidence for a claim it never tested. If the
 * renderer's clamp moves, this fails until the validator moves with it.
 */
const RENDERER = readFileSync(
  path.join(__dirname, '..', '..', '..', 'src', 'renderer', 'modules', 'chat-artifact.js'),
  'utf8',
);

function rendererConstant(name: string): number {
  const match = new RegExp(`const ${name} = (\\d+);`).exec(RENDERER);
  if (!match) throw new Error(`renderer no longer declares ${name}`);
  return Number(match[1]);
}

describe('chat artifact frame contract', () => {
  it('validates against the same frame the renderer hands the artifact', () => {
    expect(rendererConstant('DEFAULT_FRAME_HEIGHT')).toBe(ARTIFACT_FRAME.defaultHeight);
    expect(rendererConstant('MAX_FRAME_HEIGHT')).toBe(ARTIFACT_FRAME.maxHeight);
    expect(rendererConstant('MIN_FRAME_HEIGHT')).toBe(ARTIFACT_FRAME.minHeight);
  });

  it('keeps the frame small enough that validating at a desktop window is not the same test', () => {
    // Guards the assumption the smoke rests on. If the frame ever grew to
    // desktop proportions the embed viewport would stop being a distinct
    // measurement and this file should be revisited rather than silently kept.
    expect(ARTIFACT_FRAME.maxHeight).toBeLessThan(800);
    expect(ARTIFACT_FRAME.smokeWidth).toBeLessThan(1280);
    expect(ARTIFACT_FRAME.defaultHeight).toBeLessThanOrEqual(ARTIFACT_FRAME.maxHeight);
    expect(ARTIFACT_FRAME.minHeight).toBeLessThanOrEqual(ARTIFACT_FRAME.defaultHeight);
  });
});
