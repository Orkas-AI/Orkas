import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { estimateNarrationDuration, measureNarrationUnits } from '../../../src/main/util/narration-timing';
import * as legacy from '../../../src/main/features/tts';

const requireCjs = createRequire(import.meta.url);
const pc = path.resolve(__dirname, '../../..');
const skill = path.resolve(pc, 'resources/builtin/marketplace/skills/59d186285161');
const bundled = requireCjs(path.join(skill, 'scripts/lib/narration-timing.cjs'));
const runAdapter = requireCjs(path.join(skill, 'scripts/storyboard_timing.js'));
const hash = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

async function withInput(input: unknown, check: (filename: string, dir: string) => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-storyboard-test-'));
  const filename = path.join(dir, 'input.json');
  const text = JSON.stringify(input);
  fs.writeFileSync(filename, text);
  try {
    await check(filename, dir);
    expect(fs.readFileSync(filename, 'utf8')).toBe(text);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const brief = (text = 'A fresh start.') => ({
  duration_sec: 15,
  segments: [{ id: 'opening', text, start_sec: 0, target_sec: 3 }],
});

describe('shared narration estimate for script-only work', () => {
  it('keeps legacy exports on the same implementation and preserves packaged calculations', () => {
    expect(legacy.estimateNarrationDuration).toBe(estimateNarrationDuration);
    expect(legacy.measureNarrationUnits).toBe(measureNarrationUnits);
    for (const text of ['', 'A fresh start.', '350 mL 陶瓷杯，适合咖啡和茶。', 'GPT-5.5: version 2.0!\nNext — now…']) {
      for (const speed of [0, 0.5, 1, 1.5, 2, Number.NaN]) {
        expect(bundled.estimateNarrationDuration(text, speed)).toEqual(estimateNarrationDuration(text, speed));
      }
    }
  });

  it('reports local overflow even when the total narration estimate fits the video', async () => {
    const text = 'White ceramic, a blue wave, and room for 350 mL of coffee or tea.';
    const input = brief(text);
    input.segments.push({ id: 'visual', text: '', start_sec: 3, target_sec: 12 });
    await withInput(input, async filename => {
      const result = await runAdapter({ args: ['--input', filename] });
      expect(result.ok).toBe(true);
      expect(result.kind).toBe('estimate');
      expect(result.sum_estimated_speech_sec).toBeLessThan(15);
      expect(result.remaining_timeline_sec).toBe(0);
      expect(result.segments[0]).toMatchObject({ text_sha256: hash(text), estimated_sec: 6.26, remaining_sec: -3.26 });
      expect(result.segments[1]).toMatchObject({ estimated_sec: 0, remaining_sec: 12 });
      expect(result).not.toHaveProperty('status'); // No VideoStudio acceptance band or approval state.
    });
  });

  it('updates the exact-text receipt and estimate after a revision, without rewriting files', async () => {
    await withInput(brief('First longer sentence about the quiet morning.'), async (filename, dir) => {
      const original = await runAdapter({ args: ['--input', filename] });
      const revisedFile = path.join(dir, 'revised.json');
      fs.writeFileSync(revisedFile, JSON.stringify(brief('Morning pause?')));
      const revised = await runAdapter({ args: ['--input', revisedFile] });
      expect(revised.segments[0].estimated_sec).toBe(1.08);
      expect(revised.segments[0].text_sha256).toBe(hash('Morning pause?'));
      expect(revised.segments[0].text_sha256).not.toBe(original.segments[0].text_sha256);
      expect(revised.segments[0].remaining_sec).toBeGreaterThan(0);
      expect(fs.readdirSync(dir).sort()).toEqual(['input.json', 'revised.json']);
    });
  });

  it('executes the installed self-contained package through the existing bound Skill runner', async () => {
    await withInput(brief(), async (filename, dir) => {
      const installed = path.join(dir, 'installed');
      fs.cpSync(skill, installed, { recursive: true });
      const result = spawnSync(process.env.ORKAS_TEST_NODE || process.execPath, [
        path.join(pc, 'bin/run-skill.cjs'), 'ecommerce-creative', 'storyboard_timing', '--', '--input', filename,
      ], {
        cwd: dir, encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, ORKAS_PC_DIR: pc, ORKAS_RUN_SKILL_DIR: installed,
          ORKAS_WORKSPACE_ROOT: dir, ORKAS_UID: 'isolated', ORKAS_GLOBAL_SKILL_ROOTS_ENABLED: '0' },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, kind: 'estimate' });
      expect(fs.readdirSync(dir).sort()).toEqual(['input.json', 'installed']);
    });
  });

  it.each([
    { ...brief(), speed: 0 },
    { ...brief(), speed: 3 },
    { ...brief(), speed: '1' },
    { ...brief(), duration_sec: -1 },
    { ...brief(), unsupported: true },
    { duration_sec: 15, segments: [] },
    { duration_sec: 15, segments: [{ id: 'x', text: 'hello', start_sec: 0, target_sec: -3 }] },
    { duration_sec: 15, segments: [{ id: 'x', text: 42, start_sec: 0, target_sec: 3 }] },
    { duration_sec: 15, segments: [brief().segments[0], brief().segments[0]] },
    { duration_sec: 15, segments: [brief().segments[0], { id: 'overlap', text: '', start_sec: 2, target_sec: 2 }] },
  ])('rejects invalid draft structure without treating it as an estimate: %j', async input => {
    await withInput(input, async filename => {
      const result = await runAdapter({ args: ['--input', filename] });
      expect(result).toMatchObject({ ok: false, errorCode: 'E_STORYBOARD_TIMING_INPUT' });
      expect(result.message).not.toContain(filename);
    });
  });

  it('reports malformed, missing and oversized inputs without exposing their contents', async () => {
    await withInput(brief(), async (filename, dir) => {
      for (const contents of ['PRIVATE_INVALID_JSON', ' '.repeat(1024 * 1024 + 1)]) {
        const bad = path.join(dir, 'private.json');
        fs.writeFileSync(bad, contents);
        const result = await runAdapter({ args: ['--input', bad] });
        expect(result.ok).toBe(false);
        expect(result.message).not.toContain('PRIVATE_INVALID_JSON');
        expect(result.message).not.toContain(dir);
      }
      expect((await runAdapter({ args: ['--input', path.join(dir, 'missing')] })).ok).toBe(false);
      expect((await runAdapter({ args: [filename] })).ok).toBe(false);
    });
  });
});
