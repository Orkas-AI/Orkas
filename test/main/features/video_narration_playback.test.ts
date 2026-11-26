import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { narrationPlaybackIssues } from '../../../src/main/features/video_narration_playback';
import { bundledFfmpegPaths } from '../../../src/main/util/bundled-runtime';

const { ffmpeg } = bundledFfmpegPaths();
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function run(args: string[]): void {
  const result = spawnSync(ffmpeg!, ['-v', 'error', '-nostdin', '-y', ...args], { encoding: 'utf8', timeout: 60_000 });
  expect(result.status, result.stderr).toBe(0);
}

/** A production with two narration lines and an earlier draft of the first that shares its
 *  opening. Lines are distinct noise, so each can only be found where it was placed. */
function production(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-narration-playback-')));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'voice'), { recursive: true });
  const noise = (seed: number, seconds: number, file: string) =>
    run(['-f', 'lavfi', '-i', `anoisesrc=d=${seconds}:c=pink:r=16000:a=0.3:seed=${seed}`, '-ac', '1', path.join(root, file)]);
  noise(1, 3, 'voice/hook.wav');
  noise(2, 2.5, 'voice/close.wav');
  noise(3, 1.5, 'tail.wav');
  // The draft: the hook's first 1.5 s, then a different ending.
  run(['-i', path.join(root, 'voice/hook.wav'), '-i', path.join(root, 'tail.wav'), '-filter_complex',
    '[0:a]atrim=0:1.5,asetpts=N/SR/TB[a];[a][1:a]concat=n=2:v=0:a=1', path.join(root, 'voice/hook-draft.wav')]);
  fs.writeFileSync(path.join(root, 'assets.json'), JSON.stringify({ assets: [
    { id: 'hook', kind: 'audio', path: 'voice/hook.wav', origin: 'generated', prompt: '合同从三十天变成九十天，谁动了手脚？' },
    { id: 'close', kind: 'audio', path: 'voice/close.wav', origin: 'generated', prompt: '关键录音，竟然被删了。' },
    { id: 'hook-draft', kind: 'audio', path: 'voice/hook-draft.wav', origin: 'generated', prompt: '合同从三十天变成九十天。' },
  ] }));
  return root;
}

/** Each placement is [file, start s, length s or whole], over a quiet audio bed. */
function delivery(root: string, name: string, placements: Array<[string, number, number?]>, seconds = 12): string {
  const inputs = placements.flatMap(([file]) => ['-i', path.join(root, file)]);
  const chains = placements.map(([, start, length], index) =>
    `[${index + 1}:a]${length ? `atrim=0:${length},` : ''}asetpts=N/SR/TB,adelay=${Math.round(start * 1000)}:all=1[p${index}]`);
  const mix = `[0:a]${placements.map((_p, index) => `[p${index}]`).join('')}amix=inputs=${placements.length + 1}:normalize=0:duration=first[out]`;
  const out = path.join(root, `${name}.m4a`);
  run(['-f', 'lavfi', '-i', `sine=frequency=220:sample_rate=16000:duration=${seconds}`, ...inputs, '-filter_complex',
    `[0:a]volume=0.05[bed];${chains.join(';')};${mix.replace('[0:a]', '[bed]')}`, '-map', '[out]', '-c:a', 'aac', out]);
  return out;
}

const VOICES = [{ path: 'voice/hook-draft.wav' }, { path: 'voice/hook.wav' }, { path: 'voice/close.wav' }];

describe.skipIf(!ffmpeg)('narration played twice or cut off in a delivery', () => {
  it('says nothing when each line plays once and whole, and a draft sharing a line\'s opening never played', async () => {
    const root = production();
    const videoAbs = delivery(root, 'clean', [['voice/hook.wav', 1], ['voice/close.wav', 6]]);
    expect(await narrationPlaybackIssues({ ffmpeg: ffmpeg!, videoAbs, productionDirAbs: root, voices: VOICES })).toEqual([]);
  }, 60_000);

  // 2026-11-20 benchmark: a drama recap played one line from 11.9 s, cut it before its last
  // words, and played it again in full from 23.0 s; delivery passed it.
  it('names a line played twice, with where each playback starts', async () => {
    const root = production();
    const videoAbs = delivery(root, 'twice', [['voice/hook.wav', 0.5, 2], ['voice/close.wav', 3.5], ['voice/hook.wav', 7]]);
    const issues = await narrationPlaybackIssues({ ffmpeg: ffmpeg!, videoAbs, productionDirAbs: root, voices: VOICES });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: 'DELIVERY_NARRATION_REPEATED', severity: 'error' });
    expect(issues[0].message).toMatch(/^The narration line "合同从三十天变成九十天，谁动了手脚？" plays twice, from 0\.[45] s and from 7\.0 s\. Keep it once, then deliver again\.$/);
  }, 60_000);

  it('names a line that stops before its end, with where it stops and how much is not heard', async () => {
    const root = production();
    const videoAbs = delivery(root, 'cut', [['voice/hook.wav', 1, 1.8], ['voice/close.wav', 6]]);
    const issues = await narrationPlaybackIssues({ ffmpeg: ffmpeg!, videoAbs, productionDirAbs: root, voices: VOICES });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: 'DELIVERY_NARRATION_CUT_OFF', severity: 'error' });
    expect(issues[0].message).toMatch(/^The narration line "合同从三十天变成九十天，谁动了手脚？" stops at 2\.[78] s before its end; about 1\.[12] s of it is not heard\. Let it finish or shorten the line, then deliver again\.$/);
  }, 60_000);

  it('does not reject a long delivery based on its truncated audio prefix', async () => {
    const root = production();
    const videoAbs = delivery(root, 'too-long', [['voice/hook.wav', 1], ['voice/hook.wav', 7]], 182);
    expect(await narrationPlaybackIssues({
      ffmpeg: ffmpeg!, videoAbs, productionDirAbs: root, voices: [{ path: 'voice/hook.wav' }],
    })).toEqual([]);
  }, 60_000);

  it('checks nothing when no narration was made, and stops nothing when the sound cannot be read', async () => {
    const root = production();
    const videoAbs = delivery(root, 'clean', [['voice/hook.wav', 1], ['voice/close.wav', 6]]);
    expect(await narrationPlaybackIssues({ ffmpeg: ffmpeg!, videoAbs, productionDirAbs: root, voices: [] })).toEqual([]);
    fs.writeFileSync(path.join(root, 'broken.mp4'), 'not a video');
    expect(await narrationPlaybackIssues({ ffmpeg: ffmpeg!, videoAbs: path.join(root, 'broken.mp4'), productionDirAbs: root, voices: VOICES })).toEqual([]);
    // A voice outside the production is not read.
    expect(await narrationPlaybackIssues({ ffmpeg: ffmpeg!, videoAbs, productionDirAbs: root, voices: [{ path: '../elsewhere.wav' }] })).toEqual([]);
  }, 60_000);

  it('checks a complete 180-second soundtrack without judging the same prefix of a longer delivery', async () => {
    const root = production();
    const repeated = delivery(root, 'repeated', [['voice/hook.wav', 1], ['voice/hook.wav', 6]]);
    const check = async (duration: number) => {
      const videoAbs = path.join(root, `delivery-${duration}.wav`);
      run(['-i', repeated, '-af', `apad,atrim=duration=${duration}`, '-ar', '8000', videoAbs]);
      return narrationPlaybackIssues({
        ffmpeg: ffmpeg!, videoAbs, productionDirAbs: root, voices: [{ path: 'voice/hook.wav' }],
      });
    };

    expect(await check(180)).toEqual([expect.objectContaining({ code: 'DELIVERY_NARRATION_REPEATED' })]);
    expect(await check(182)).toEqual([]);
  }, 60_000);
});
