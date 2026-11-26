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
// Speech at 0.5–2, 3–4.5 and 6–8 s; the default pauses are long enough to separate any take.
const SPACED = { audio: "aevalsrc='0.4*(sin(2*PI*440*t)*between(t,0.5,2)+sin(2*PI*660*t)*between(t,3,4.5)+sin(2*PI*880*t)*between(t,6,8))':s=48000:d=10",
  words: [{ text: 'Opening', start: 0.5, end: 2 }, { text: 'False start', start: 3, end: 4.5 }, { text: 'Complete take', start: 6, end: 8 }] };
function fixture(take = SPACED) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-picture-selection-')); roots.push(root);
  const video = path.join(root, 'source.mp4'), voice = path.join(root, 'voice.wav'), transcript = path.join(root, 'words.json');
  const audio = take.audio;
  for (const args of [
    ['-f', 'lavfi', '-i', 'testsrc2=s=180x320:r=25:d=10', '-f', 'lavfi', '-i', audio, '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', video],
    ['-f', 'lavfi', '-i', 'sine=f=1000:r=48000:d=2', voice],
  ]) {
    const run = spawnSync(bins.ffmpeg!, ['-v', 'error', '-nostdin', '-y', ...args], { encoding: 'utf8', timeout: 30000 });
    expect(run.status, run.stderr).toBe(0); expect(run.stderr).toBe('');
  }
  fs.writeFileSync(transcript, JSON.stringify({ words: take.words }));
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
function dub(f: ReturnType<typeof fixture>, segments: unknown[], output: string, cover = '0.70,1', options: string[] = []) {
  const pc = process.cwd();
  return spawnSync(process.env.ORKAS_TEST_NODE || process.execPath,
    [path.join(pc, 'bin/run-skill.cjs'), 'stage-edit', 'edit_video', '--', '--op', 'mix', '--input', f.video,
      '--audio-segments', JSON.stringify(segments), '--on-existing-audio', 'replace', '--cover', cover, '--output', output, ...options],
    { cwd: f.root, encoding: 'utf8', timeout: 30000, env: { ...process.env, ORKAS_PC_DIR: pc,
      ORKAS_RUN_SKILL_DIR: path.join(pc, 'resources/builtin/marketplace/agents/79df9cc89f5f/skills/stage-edit'), ORKAS_WORKSPACE_ROOT: f.root } });
}
function subtitleBand(file: string, at: number) {
  const r = spawnSync(bins.ffmpeg!, ['-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1',
    '-vf', 'crop=iw:ih*0.29:0:ih*0.71,format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1024 * 1024 });
  expect(r.status, String(r.stderr)).toBe(0);
  return r.stdout;
}
describe.skipIf(!bins.ffmpeg || !bins.ffprobe)('picture timing and explicit phrase selection', () => {
  it('reuses two slices of a recording and burns their captions at the actual placements', () => {
    const f = fixture(), inputHash = hash(f.video), output = path.join(f.root, 'dub.mp4');
    const mixed = dub(f, [
      { path: f.video, source_start: 6, source_end: 7.3, start: 1, end: 3, caption: 'Second take' },
      { path: f.video, source_start: 0.5, source_end: 1.6, start: 6, end: 8, caption: 'First take' },
    ], output);
    expect(mixed.status, mixed.stderr).toBe(0);
    const result = JSON.parse(mixed.stdout);
    expect(result.text).toContain('Contains 2 burned captions');
    expect(result.caption_cues).toEqual([
      { start_sec: 1, end_sec: 2.3, text: 'Second take' },
      { start_sec: 6, end_sec: 7.1, text: 'First take' },
    ]);
    expect(duration(output)).toBeCloseTo(10, 1);
    expect(tonePower(output, 880, 1.2, 0.5)).toBeGreaterThan(0.001);
    expect(tonePower(output, 440, 6.2, 0.5)).toBeGreaterThan(0.001);
    expect(tonePower(output, 660, 3.3, 0.5)).toBeLessThan(0.00001);
    expect(subtitleBand(output, 1.5).some(pixel => pixel > 180)).toBe(true);
    expect(subtitleBand(output, 6.5).some(pixel => pixel > 180)).toBe(true);
    expect(subtitleBand(output, 3.5).every(pixel => pixel < 20)).toBe(true);
    expect(hash(f.video)).toBe(inputHash);
    expect(fs.readdirSync(f.root).sort()).toEqual(['dub.mp4', 'source.mp4', 'voice.wav', 'words.json']);
  }, 60000);

  it('names the failing dub line and leaves the existing delivery intact', () => {
    const f = fixture(), before = hash(f.video);
    const first = { path: f.voice, start: 1, end: 4, caption: 'Opening' };
    const second = { path: f.voice, start: 6, end: 7, caption: 'Closing' };
    const output = path.join(f.root, 'new-dub.mp4');
    fs.copyFileSync(f.video, output);
    const tooLong = dub(f, [first, second], output);
    expect(tooLong.status).toBe(1);
    expect(JSON.parse(tooLong.stderr.split('\n').filter(line => line.startsWith('{')).at(-1)!))
      .toMatchObject({ code: 'E_EDIT_VOICE_WINDOW', message: expect.stringMatching(/segment 2/i) });
    for (const bad of [
      { ...second, source_start: 0.3 },
      { ...second, source_start: 0.3, source_end: 3 },
      { ...second, caption: '' },
    ]) expect(dub(f, [first, bad], output).status).toBe(1);
    expect(hash(output)).toBe(before);
    expect(hash(f.video)).toBe(before);
    expect(fs.readdirSync(f.root).sort()).toEqual(['new-dub.mp4', 'source.mp4', 'voice.wav', 'words.json']);
  }, 60000);

  it('fits existing speech into a measured source pause and keeps the quiet tail', () => {
    const f = fixture(), output = path.join(f.root, 'refitted.mp4');
    const before = [hash(f.video), hash(f.voice)];
    const rows = [
      { path: f.video, source_start: 0.5, source_end: 2, start: 0.5, end: 2, caption: 'Opening' },
      { path: f.voice, start: 3, end: 4.5, caption: 'Middle' },
      { path: f.video, source_start: 6, source_end: 7, start: 6, end: 9, caption: 'Closing' },
    ];
    const mixed = dub(f, rows, output, '0.70,1', ['--fit-dub']);
    expect(mixed.status, mixed.stderr).toBe(0);
    const result = JSON.parse(mixed.stdout);
    expect(result.caption_cues.map((cue: { text: string }) => cue.text)).toEqual(['Opening', 'Middle', 'Closing']);
    expect(result.caption_cues[1].end_sec).toBeGreaterThan(4.5);
    expect(result.caption_cues[2].end_sec).toBeCloseTo(8, 1);
    expect(result.coverage.overlapCount).toBe(0);
    expect(duration(output)).toBeCloseTo(10, 1);
    expect(tonePower(output, 1000, 3.3, 0.6)).toBeGreaterThan(0.001);
    expect(tonePower(output, 880, 7.2, 0.5)).toBeGreaterThan(0.001);
    expect(tonePower(output, 880, 8.4, 0.5)).toBeLessThan(0.00001);
    expect(subtitleBand(output, 7.4).some(pixel => pixel > 180)).toBe(true);
    expect(subtitleBand(output, 8.5).every(pixel => pixel < 20)).toBe(true);
    expect([hash(f.video), hash(f.voice)]).toEqual(before);
  }, 60000);

  it('reports only the reused line that would cross source speech and writes no replacement', () => {
    const f = fixture(), output = path.join(f.root, 'old.mp4');
    fs.copyFileSync(f.video, output);
    const result = dub(f, [
      { path: f.video, source_start: 0.5, source_end: 1.6, start: 0.5, end: 2, caption: 'Opening' },
      { path: f.voice, start: 3.25, end: 4, caption: 'Middle' },
      { path: f.video, source_start: 6, source_end: 7, start: 6, end: 8, caption: 'Closing' },
    ], output, '0.70,1', ['--fit-dub']);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr.split('\n').filter(line => line.startsWith('{')).at(-1)!))
      .toMatchObject({ code: 'E_EDIT_VOICE_WINDOW',
        dub_fit_issues: [{ segment: 2, reason: 'too_long', required_sec: 2, available_sec: 0.75 }] });
    expect(hash(output)).toBe(hash(f.video));
    expect(fs.readdirSync(f.root).sort()).toEqual(['old.mp4', 'source.mp4', 'voice.wav', 'words.json']);
  }, 60000);

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

  // On 2026-11-17 an id copied one character short was answered "the measured source or
  // transcript changed", and the Agent stopped, sure its files did not match.
  it('answers an id copied short with the id of this listing, and cuts nothing', () => {
    const f = fixture(), listed = selection(f), output = path.join(f.root, 'short-id.mp4');
    expect(listed.status, listed.stderr).toBe(0);
    const id = listed.value.selection_id;
    const run = selection(f, ['--keep', '[1,3]', '--selection-id', id.slice(0, -1), '--output', output]);
    expect(run.status).not.toBe(0);
    expect(`${run.stdout}${run.stderr}`).toContain(`--selection-id is not the id of this listing, so no cut was written. This listing's id is ${id}: copy all 64 characters. If the source or transcript changed since you listed it, choose the IDs from this listing again.`);
    expect(fs.existsSync(output)).toBe(false);
  }, 60000);

  // 2026-11-17 benchmark: a false start and its retake 0.4 s apart were one candidate, because
  // candidates split only at pauses of half a second, so the false start could not be dropped
  // and the Agent cut by hand on word times and clipped the takes it kept.
  it('lists a false start a short pause before its retake as its own candidate and drops only it', () => {
    const close = { audio: "aevalsrc='0.4*(sin(2*PI*440*t)*between(t,0.5,2)+sin(2*PI*660*t)*between(t,2.3,3.3)+sin(2*PI*880*t)*between(t,3.6,5.6))':s=48000:d=10",
      words: [{ text: 'Opening', start: 0.5, end: 2 }, { text: 'False start', start: 2.3, end: 3.3 }, { text: 'Complete take', start: 3.6, end: 5.6 }] };
    const f = fixture(close), before = hash(f.video), listed = selection(f);
    expect(listed.status, listed.stderr).toBe(0);
    expect(listed.value.candidates.map((c: any) => c.text)).toEqual(['Opening', 'False start', 'Complete take']);
    const output = path.join(f.root, 'clean.mp4');
    const cut = selection(f, ['--keep', '[1,3]', '--selection-id', listed.value.selection_id, '--output', output]);
    expect(cut.status, cut.stderr).toBe(0);
    // 0–2 s, then 3.6 s to the end: both kept takes whole, the false start gone.
    expect(duration(output)).toBeCloseTo(8.4, 1);
    expect(tonePower(output, 440, 0.6, 1.3)).toBeGreaterThan(0.005);
    expect(tonePower(output, 880, 2.1, 1.9)).toBeGreaterThan(0.005);
    expect(tonePower(output, 660, 0, 8.4)).toBeLessThan(0.00001);
    expect(hash(f.video)).toBe(before);
  }, 120000);

  it('surfaces speech without word timing as a separate candidate and keeps both neighbouring takes', () => {
    const audio = "aevalsrc='0.4*(sin(2*PI*440*t)*between(t,0.5,2)+sin(2*PI*660*t)*between(t,3,3.2)+sin(2*PI*880*t)*between(t,4,6))':s=48000:d=10";
    const words = [{ text: '开场。', start: 0.5, end: 2 }, { text: '嗯，', start: 4, end: 4.2 },
      { text: '这是正句。', start: 4.2, end: 6 }];
    const f = fixture({ audio, words }), before = hash(f.video);
    const original = selection(f);
    expect(original.status, original.stderr).toBe(0);
    const [opening, unmatched, complete] = original.value.candidates;
    expect(original.value.candidates).toHaveLength(3);
    expect(unmatched).toMatchObject({ text: '', review: { startSec: expect.any(Number), endSec: expect.any(Number) } });
    expect(unmatched.startSec).toBeCloseTo(3, 1);
    expect(unmatched.endSec).toBeCloseTo(3.2, 1);
    expect(unmatched.review.startSec).toBeGreaterThan(2);
    expect(unmatched.review.endSec).toBeLessThan(4);
    expect(complete.startSec).toBeCloseTo(4, 1);
    const select = (ids: number[], name: string) => selection(f,
      ['--keep', JSON.stringify(ids), '--selection-id', original.value.selection_id, '--output', path.join(f.root, name)]);
    const kept = select([opening.id, unmatched.id, complete.id], 'kept.mp4');
    expect(kept.status, kept.stderr).toBe(0);
    expect(hash(kept.value.path)).toBe(before);
    const cut = select([opening.id, complete.id], 'clean.mp4');
    expect(cut.status, cut.stderr).toBe(0);
    expect(cut.value.decision.kept_intervals[0].endSec).toBeGreaterThan(2);
    expect(cut.value.decision.kept_intervals[1].startSec).toBeLessThan(4);
    expect(tonePower(cut.value.path, 440, 0.6, 1.2)).toBeGreaterThan(0.005);
    expect(tonePower(cut.value.path, 880, 2.1, 1.8)).toBeGreaterThan(0.005);
    expect(tonePower(cut.value.path, 660, 0, 8.0)).toBeLessThan(0.00001);
    expect(hash(f.video)).toBe(before);

    const meaningful = fixture({ audio, words: [
      words[0], { text: '对。', start: 3.01, end: 3.19 }, words[2],
    ] });
    const recognized = selection(meaningful);
    expect(recognized.status, recognized.stderr).toBe(0);
    expect(recognized.value.candidates.map((candidate: { text: string }) => candidate.text))
      .toEqual(['开场。', '对。', '这是正句。']);
    expect(recognized.value.candidates[1]).not.toHaveProperty('review');
  }, 120000);
});
