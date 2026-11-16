import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { editVideo } from '../../../resources/builtin/marketplace/agents/79df9cc89f5f/skills/_shared/scripts/src/video_edit';
import { bundledFfmpegPaths } from '../../../src/main/util/bundled-runtime';

const roots: string[] = [];
const bins = bundledFfmpegPaths();
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const hash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-picture-selection-')); roots.push(root);
  const video = path.join(root, 'source.mp4'), voice = path.join(root, 'voice.wav'), transcript = path.join(root, 'words.json');
  const audio = "aevalsrc='0.4*(sin(2*PI*440*t)*between(t,0.5,2)+sin(2*PI*660*t)*between(t,3,4.5)+sin(2*PI*880*t)*between(t,6,8))':s=48000:d=10";
  for (const args of [
    ['-f', 'lavfi', '-i', 'testsrc2=s=180x320:r=25:d=10', '-f', 'lavfi', '-i', audio, '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', video],
    ['-f', 'lavfi', '-i', 'sine=f=1000:r=48000:d=2', voice],
  ]) {
    const run = spawnSync(bins.ffmpeg!, ['-v', 'error', '-nostdin', '-y', ...args], { encoding: 'utf8', timeout: 30000 });
    expect(run.status, run.stderr).toBe(0); expect(run.stderr).toBe('');
  }
  fs.writeFileSync(transcript, JSON.stringify({ words: [
    { text: 'Opening', start: 0.5, end: 2 }, { text: 'False start', start: 3, end: 4.5 }, { text: 'Complete take', start: 6, end: 8 },
  ] }));
  return { root, video, voice, transcript };
}
function selection(f: ReturnType<typeof fixture>, args: string[] = []) {
  const pc = process.cwd();
  const run = spawnSync(process.env.ORKAS_TEST_NODE || process.execPath,
    [path.join(pc, 'bin/run-skill.cjs'), 'stage-edit', 'cut_selection', '--', '--input', f.video, '--transcript', f.transcript, ...args], {
      cwd: f.root, encoding: 'utf8', timeout: 60000, env: { ...process.env, ORKAS_PC_DIR: pc,
        ORKAS_RUN_SKILL_DIR: path.join(pc, 'resources/builtin/marketplace/agents/79df9cc89f5f/skills/stage-edit'), ORKAS_WORKSPACE_ROOT: f.root },
    });
  return { ...run, value: run.status === 0 ? JSON.parse(run.stdout) : null };
}
function duration(file: string) {
  return Number(spawnSync(bins.ffprobe!, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }).stdout);
}
function videoHash(file: string) {
  const r = spawnSync(bins.ffmpeg!, ['-v', 'error', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'hash', '-'], { encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0); return r.stdout;
}
function tonePower(file: string, frequency: number, start: number, length: number) {
  const r = spawnSync(bins.ffmpeg!, ['-v', 'error', '-ss', String(start), '-i', file, '-t', String(length), '-vn', '-ac', '1', '-ar', '8000', '-f', 'f32le', '-'], { maxBuffer: 1024 * 1024 });
  expect(r.status, String(r.stderr)).toBe(0);
  let re = 0, im = 0; const n = r.stdout.length / 4;
  for (let i = 0; i < n; i++) { const v = r.stdout.readFloatLE(i * 4), phase = 2 * Math.PI * frequency * i / 8000; re += v * Math.cos(phase); im += v * Math.sin(phase); }
  return (re * re + im * im) / (n * n);
}
describe.skipIf(!bins.ffmpeg || !bins.ffprobe)('picture timing and explicit phrase selection', () => {
  it.each(['start', 'start_sec', 'startSec'])('rejects a nonnumeric fixed-window %s without moving the voice to zero', (field) => {
    const f = fixture(), before = hash(f.video), voiceBefore = hash(f.voice), output = path.join(f.root, 'window.mp4');
    const pc = process.cwd();
    const mix = (start: unknown) => spawnSync(process.env.ORKAS_TEST_NODE || process.execPath,
      [path.join(pc, 'bin/run-skill.cjs'), 'stage-edit', 'edit_video', '--', '--op', 'mix', '--input', f.video,
        '--audio-segments', JSON.stringify([{ path: f.voice, [field]: start, end_sec: 7.1 }]),
        '--on-existing-audio', 'replace', '--output', output], {
        cwd: f.root, encoding: 'utf8', timeout: 30000, env: { ...process.env, ORKAS_PC_DIR: pc,
          ORKAS_RUN_SKILL_DIR: path.join(pc, 'resources/builtin/marketplace/agents/79df9cc89f5f/skills/stage-edit'), ORKAS_WORKSPACE_ROOT: f.root },
      });
    for (const invalid of ['5', null, false, {}]) {
      const rejected = mix(invalid);
      expect(rejected.status, rejected.stdout).toBe(1);
      expect(JSON.parse(rejected.stderr)).toMatchObject({ ok: false, code: 'E_ARGS' });
      expect(fs.existsSync(output)).toBe(false);
    }
    const accepted = mix(5);
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(duration(output)).toBeCloseTo(10, 1);
    expect(videoHash(output)).toBe(videoHash(f.video));
    expect(tonePower(output, 1000, 5.3, 1)).toBeGreaterThan(0.001);
    expect(tonePower(output, 1000, 0.3, 1)).toBeLessThan(0.00001);
    expect(hash(f.video)).toBe(before); expect(hash(f.voice)).toBe(voiceBefore);
  }, 60000);

  it('keeps separately placed audio at its declared picture times, with video and source assets unchanged', async () => {
    const f = fixture(), sourceHash = hash(f.video), voiceHash = hash(f.voice), output = path.join(f.root, 'placed.mp4');
    const mixed = await editVideo({ op: 'mix', inputAbsPath: f.video, outputAbsPath: output, onExistingAudio: 'replace',
      audioSegments: [{ audioAbsPath: f.voice, startSec: 1, endSec: 3.1 }, { audioAbsPath: f.voice, startSec: 6, endSec: 8.1 }] });
    expect(mixed.ok).toBe(true); expect(duration(output)).toBeCloseTo(10, 1);
    expect(videoHash(output)).toBe(videoHash(f.video));
    expect(tonePower(output, 1000, 1.3, 1)).toBeGreaterThan(0.001);
    expect(tonePower(output, 1000, 6.3, 1)).toBeGreaterThan(0.001);
    expect(tonePower(output, 1000, 4, 1)).toBeLessThan(0.00001);
    expect(hash(f.video)).toBe(sourceHash); expect(hash(f.voice)).toBe(voiceHash);
  }, 60000);

  it('rejects an overlong declared voice window before output and reuses a fitting voice without shortening picture', async () => {
    const f = fixture(), before = hash(f.video), voiceBefore = hash(f.voice), output = path.join(f.root, 'dub.mp4');
    const bad = await editVideo({ op: 'mix', inputAbsPath: f.video, outputAbsPath: output, onExistingAudio: 'replace',
      audioSegments: [{ audioAbsPath: f.voice, startSec: 1, endSec: 2 }] });
    expect(bad.ok).toBe(false); expect(fs.existsSync(output)).toBe(false);
    const pc = process.cwd();
    const authored = spawnSync(process.env.ORKAS_TEST_NODE || process.execPath,
      [path.join(pc, 'bin/run-skill.cjs'), 'stage-edit', 'edit_video', '--', '--op', 'mix', '--input', f.video,
        '--audio-segments', JSON.stringify([{ path: f.voice, start: 1, end: 3.1 }]), '--on-existing-audio', 'replace', '--output', output],
      { cwd: f.root, encoding: 'utf8', timeout: 30000, env: { ...process.env, ORKAS_PC_DIR: pc,
        ORKAS_RUN_SKILL_DIR: path.join(pc, 'resources/builtin/marketplace/agents/79df9cc89f5f/skills/stage-edit'), ORKAS_WORKSPACE_ROOT: f.root } });
    expect(authored.status, authored.stderr).toBe(0);
    const good = JSON.parse(authored.stdout);
    expect(good.ok).toBe(true); expect(duration(output)).toBeCloseTo(10, 1);
    if (good.ok) expect(JSON.stringify(good.coverage?.warnings)).not.toMatch(/trim the clip|trim the head|shorten.*scenes/);
    expect(hash(f.video)).toBe(before); expect(hash(f.voice)).toBe(voiceBefore);
    expect(videoHash(output)).toBe(videoHash(f.video));
    for (const segments of [
      [{ audioAbsPath: f.voice, startSec: -1, endSec: 3 }],
      [{ audioAbsPath: f.voice, startSec: 9, endSec: 12 }],
      [{ audioAbsPath: f.voice, startSec: 0, endSec: 3 }, { audioAbsPath: f.voice, startSec: 2, endSec: 5 }],
      [{ audioAbsPath: f.voice, startSec: 0, endSec: 3 }, { audioAbsPath: f.voice, startSec: 4 }],
    ]) {
      const rejected = path.join(f.root, 'rejected.mp4');
      expect((await editVideo({ op: 'mix', inputAbsPath: f.video, outputAbsPath: rejected,
        onExistingAudio: 'replace', audioSegments: segments })).ok).toBe(false);
      expect(fs.existsSync(rejected)).toBe(false);
    }
  }, 60000);

  it('executes selected phrase IDs, keeps adjacent pauses, and rejects stale, partial or reordered choices', () => {
    const f = fixture(), before = hash(f.video), listed = selection(f);
    expect(listed.status, listed.stderr).toBe(0);
    expect(listed.value.candidates).toHaveLength(3);
    const id = listed.value.selection_id, output = path.join(f.root, 'clean.mp4');
    for (const keep of ['[1,3,3]', '[3,1]', '[1,4]', '[1.5]', '[]']) {
      expect(selection(f, ['--keep', keep, '--selection-id', id, '--output', output]).status).not.toBe(0);
      expect(fs.existsSync(output)).toBe(false);
    }
    const cut = selection(f, ['--keep', '[1,3]', '--selection-id', id, '--output', output]);
    expect(cut.status, cut.stderr).toBe(0); expect(duration(output)).toBeCloseTo(6, 1);
    expect(cut.value.decision.kept_intervals).toHaveLength(2);
    expect(tonePower(output, 440, 0.7, 1)).toBeGreaterThan(0.005);
    expect(tonePower(output, 880, 2.2, 1)).toBeGreaterThan(0.005);
    expect(tonePower(output, 660, 0, 6)).toBeLessThan(0.00001);
    const all = selection(f, ['--keep', '[1,2,3]', '--selection-id', id, '--output', path.join(f.root, 'retained.mp4')]);
    expect(all.status, all.stderr).toBe(0); expect(hash(all.value.path)).toBe(before);
    fs.appendFileSync(f.transcript, '\n');
    expect(selection(f, ['--keep', '[1,3]', '--selection-id', id, '--output', path.join(f.root, 'stale.mp4')]).status).not.toBe(0);
    expect(fs.existsSync(path.join(f.root, 'stale.mp4'))).toBe(false);
    expect(hash(f.video)).toBe(before);
  }, 120000);
});
