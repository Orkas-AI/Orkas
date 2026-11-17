import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { bundledRuntimeEnv } from '../../../src/main/util/bundled-runtime';
import { buildFrameEncoderArgs, buildVideoTrackRemuxArgs } from '../../../src/main/features/video_studio';
import { buildMixFilter } from '../../../resources/builtin/marketplace/agents/79df9cc89f5f/skills/_shared/scripts/src/video_edit';

const require = createRequire(import.meta.url);
const packaged = require('../../../resources/builtin/marketplace/agents/79df9cc89f5f/skills/stage-edit/scripts/lib/video_edit_core.cjs');
let root: string, prior: NodeJS.ProcessEnv;
function ff(args: string[]) {
  const run = spawnSync(process.env.ORKAS_BUNDLED_FFMPEG!, ['-v','error','-nostdin',...args], { timeout:30000,maxBuffer:8*1024*1024 });
  expect(run.status, String(run.stderr)).toBe(0); expect(run.stderr.length).toBe(0); return run.stdout;
}
beforeEach(async () => {
  prior = { ...process.env }; Object.assign(process.env,bundledRuntimeEnv());
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'video-duck-frames-')));
  ff(['-f','lavfi','-i',"aevalsrc='if(between(t,1,3),0.3*sin(2*PI*660*t),0)':s=48000:d=4",'-c:a','pcm_s16le',path.join(root,'speech.wav')]);
  ff(['-f','lavfi','-i','sine=frequency=220:sample_rate=48000:duration=4','-c:a','pcm_s16le',path.join(root,'music.wav')]);
});
afterEach(async () => { process.env=prior;await fs.rm(root,{recursive:true,force:true}); });
function windows(file: string) {
  // Decode the whole deliverable: seek accuracy and codec frame boundaries must
  // not choose which late music samples enter the independent frequency oracle.
  const pcm = ff(['-i',file,'-ac','1','-ar','48000','-f','f32le','-']);
  return [.2,1.8,3.7].map(start => {
    let re=0,im=0;const first=Math.round(start*48000),count=14400;
    expect(pcm.length/4).toBeGreaterThanOrEqual(first+count);
    for(let i=0;i<count;i++){const sample=pcm.readFloatLE((first+i)*4);re+=sample*Math.cos(i*2*Math.PI*220/48000);im+=sample*Math.sin(i*2*Math.PI*220/48000);}
    return Math.hypot(re,im)/count;
  });
}
it.each(['packaged edit','native render/remux'])('retains background music after the sidechain release in %s', async surface => {
  const sourceMusic=await fs.readFile(path.join(root,'music.wav')),sourceVoice=await fs.readFile(path.join(root,'speech.wav'));
  const outputs: string[]=[];
  if(surface==='native render/remux') ff(['-f','lavfi','-i','color=size=32x32:duration=4:rate=10','-c:v','libx264','-preset','veryfast','-pix_fmt','yuv420p',path.join(root,'base.mp4')]);
  for(const duck of [false,true]) {
    const output=path.join(root,duck?'ducked'+(surface==='packaged edit'?'.wav':'.mp4'):'plain'+(surface==='packaged edit'?'.wav':'.mp4'));
    if(surface==='packaged edit') {
      const options={sr:48000,segmentStartSec:[0],baseHasAudio:true,mode:'mix' as const,padWholeDurSec:4,loudnorm:'anull',duck};
      const graph=packaged.buildMixFilter(options); expect(graph).toBe(buildMixFilter(options));
      ff(['-i',path.join(root,'music.wav'),'-i',path.join(root,'speech.wav'),'-filter_complex',graph,'-map','[aout]','-c:a','pcm_s16le',output]);
    } else {
      const audioTracks=[{absPath:path.join(root,'music.wav'),startSec:0,volume:1,duck},{absPath:path.join(root,'speech.wav'),startSec:0,volume:1,voice:true}];
      const args=buildVideoTrackRemuxArgs({priorVideoAbsPath:path.join(root,'base.mp4'),outputAbsPath:output,durationSec:4,audioTracks});
      const encoder=buildFrameEncoderArgs({width:32,height:32,fps:10,durationSec:4,format:'mp4',quality:'draft',outputAbsPath:output,audioTracks});
      expect(args[args.indexOf('-filter_complex')+1]).toBe(encoder[encoder.indexOf('-filter_complex')+1]);
      ff(args);
    }
    outputs.push(output);
  }
  const plain=windows(outputs[0]),ducked=windows(outputs[1]);
  expect(plain.every(amplitude=>amplitude>.03)).toBe(true);
  expect(ducked[0]/plain[0]).toBeGreaterThan(.95);
  expect(ducked[1]/plain[1]).toBeLessThan(.4);
  expect(ducked[2]/plain[2]).toBeGreaterThan(.8);
  expect(await fs.readFile(path.join(root,'music.wav'))).toEqual(sourceMusic);
  expect(await fs.readFile(path.join(root,'speech.wav'))).toEqual(sourceVoice);
},30000);
