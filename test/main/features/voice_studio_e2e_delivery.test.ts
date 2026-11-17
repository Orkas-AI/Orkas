import {afterEach,beforeEach,expect,it} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
import {bundledRuntimeEnv} from '../../../src/main/util/bundled-runtime';

const require=createRequire(import.meta.url);
const audio=require('../../../resources/builtin/marketplace/agents/5f890bd72ac4/skills/voice-project/scripts/audio.js');
let root:string,project:string,prior:NodeJS.ProcessEnv;
function ff(args:string[]) {
  const r=spawnSync(process.env.ORKAS_BUNDLED_FFMPEG!,['-v','error','-nostdin',...args],{timeout:30000,maxBuffer:8*1024*1024});
  expect(r.status,String(r.stderr)).toBe(0);return r.stdout;
}
function probe(file:string) {
  const r=spawnSync(process.env.ORKAS_BUNDLED_FFPROBE!,['-v','error','-show_streams','-show_format','-of','json',file],{encoding:'utf8',timeout:30000});
  expect(r.status,r.stderr).toBe(0);return JSON.parse(r.stdout);
}
const pcm=(file:string)=>ff(['-i',file,'-map','0:a:0','-f','s16le','-c:a','pcm_s16le','-']);
const save=(extra={})=>fs.writeFile(project,JSON.stringify({schema_version:1,roles:{},segments:[],...extra}));
const call=(op:string,fields={})=>audio.execute(op,{project,...fields});
const output=(r:any)=>path.join(root,r.files[0]);
beforeEach(async()=>{
  prior={...process.env};Object.assign(process.env,bundledRuntimeEnv());
  root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'voice-delivery-')));project=path.join(root,'voice-project.json');
  ff(['-f','lavfi','-i','sine=frequency=660:sample_rate=44100:duration=2','-af','volume=0.2','-c:a','pcm_s16le',path.join(root,'source.wav')]);
  await save();
});
afterEach(async()=>{process.env=prior;await fs.rm(root,{recursive:true,force:true});});
it('converts quietly recorded audio losslessly without changing samples, rate, channels or old files',async()=>{
  const source=await fs.readFile(path.join(root,'source.wav'));
  const result=await call('convert',{input_path:'source.wav',format:'flac'});
  expect(probe(output(result)).streams[0]).toMatchObject({codec_name:'flac',sample_rate:'44100',channels:1});
  expect(pcm(output(result))).toEqual(pcm(path.join(root,'source.wav')));
  const old=await fs.readFile(output(result));
  expect((await call('convert',{input_path:'source.wav',format:'wav'})).ok).toBe(true);
  expect(await fs.readFile(output(result))).toEqual(old);expect(await fs.readFile(path.join(root,'source.wav'))).toEqual(source);
});
it('extracts a video audio stream without re-encoding and rejects a video without audio',async()=>{
  ff(['-f','lavfi','-i','color=size=32x32:duration=2:rate=10','-i',path.join(root,'source.wav'),'-c:v','mpeg4','-c:a','aac','-shortest',path.join(root,'video.mp4')]);
  const original=await fs.readFile(path.join(root,'video.mp4'));
  const result=await call('extract',{input_path:'video.mp4',export:{normalize_loudness:false}});
  expect(probe(output(result)).streams.map((s:any)=>s.codec_type)).toEqual(['audio']);
  expect(probe(output(result)).streams[0].codec_name).toBe('aac');
  expect(pcm(output(result))).toEqual(pcm(path.join(root,'video.mp4')));
  expect(await fs.readFile(path.join(root,'video.mp4'))).toEqual(original);
  ff(['-f','lavfi','-i','color=size=32x32:duration=1:rate=10','-c:v','mpeg4',path.join(root,'silent.mp4')]);
  await expect(call('extract',{input_path:'silent.mp4'})).rejects.toMatchObject({code:'E_NO_AUDIO'});
  expect(await fs.readFile(path.join(root,'video.mp4'))).toEqual(original);
});
it.each(['mp3','m4a','aac','ogg','opus'])('converts to %s with one audio stream and preserves audible length',async format=>{
  const result=await call('convert',{input_path:'source.wav',format});
  const meta=probe(output(result));expect(meta.streams).toHaveLength(1);
  expect(meta.streams[0].codec_type).toBe('audio');expect(Number(meta.format.duration)).toBeCloseTo(2,0);
});
it.each(['flac','m4a','aac','ogg','opus'])('renders a project with normal loudness processing into %s',async format=>{
  await save({segments:[{id:'source',path:'source.wav'}],export:{format}});
  const result=await call('render'),meta=probe(output(result));
  expect(meta.streams).toHaveLength(1);expect(meta.streams[0].sample_rate).toBe('48000');
  expect(meta.streams[0].channels).toBe(2);expect(Number(meta.format.duration)).toBeCloseTo(2,0);
});
it('honors explicit export specifications while retaining legacy defaults',async()=>{
  await save({segments:[{id:'source',path:'source.wav'}],export:{format:'wav',sample_rate:24000,channels:1,bit_depth:24,normalize_loudness:false}});
  const result=await call('render');
  expect(probe(output(result)).streams[0]).toMatchObject({sample_rate:'24000',channels:1,codec_name:'pcm_s24le'});
  await save({segments:[{id:'source',path:'source.wav'}]});
  const legacy=await call('render');expect(probe(output(legacy)).streams[0]).toMatchObject({codec_name:'mp3',sample_rate:'48000',channels:2,bit_rate:'192000'});
});
it.each(['legacy','timeline'])('attenuates music during speech and restores it during a pause in the %s mixer',async mixer=>{
  ff(['-f','lavfi','-i',"aevalsrc='if(between(t,1,3),0.3*sin(2*PI*660*t),0)':s=48000:d=4",'-c:a','pcm_s16le',path.join(root,'speech.wav')]);
  ff(['-f','lavfi','-i','sine=frequency=220:sample_rate=48000:duration=4','-c:a','pcm_s16le',path.join(root,'music.wav')]);
  const plan={segments:[{id:'speech',path:'speech.wav'}],music:{path:'music.wav',volume:1,duck:false},export:{format:'wav',normalize_loudness:false}};
  const saved = mixer === 'legacy' ? plan : { ...plan, schema_version:3, music:undefined, tracks:[{ id:'bg',kind:'music',...plan.music }] };
  await save(saved);const plain=output(await call('render'));
  if(mixer === 'legacy') plan.music.duck=true; else (saved as any).tracks[0].duck=true;
  await save(saved);const ducked=output(await call('render'));
  const amplitude=(file:string,start:number)=>{
    const b=ff(['-ss',String(start),'-i',file,'-t','0.3','-ac','1','-ar','48000','-f','s16le','-']);let a=0,c=0,n=b.length/2;
    for(let i=0;i<n;i++){const s=b.readInt16LE(i*2);a+=s*Math.cos(i*2*Math.PI*220/48000);c+=s*Math.sin(i*2*Math.PI*220/48000);}
    return Math.hypot(a,c)/n;
  };
  expect(amplitude(ducked,1.8)/amplitude(plain,1.8)).toBeLessThan(.4);
  expect(amplitude(ducked,3.7)/amplitude(plain,3.7)).toBeGreaterThan(.8);
  expect(amplitude(ducked,.2)/amplitude(plain,.2)).toBeGreaterThan(.95);
});
it.each([
  {format:'wav',export:{bitrate_kbps:128}},
  {format:'mp3',export:{bit_depth:24}},
  {format:'wav',export:{sample_rate:0}},
  {format:'opus',export:{sample_rate:44100}},
  {format:'copy',export:{channels:2}},
  {format:'flac',export:{normalize_loudness:true}},
  {format:'mp3',export:{channels:'1,volume=4'}},
  {format:'mp3',export:{bitrate_kbps:123}},
  {format:'mp3',export:{bitrate_kbps:320,sample_rate:16000}},
])('rejects contradictory or malformed conversion options without publishing: %j',async fields=>{
  await expect(call('convert',{input_path:'source.wav',...fields})).rejects.toMatchObject({code:'E_FORMAT'});
  expect((await fs.readdir(root)).sort()).toEqual(['source.wav','voice-project.json']);
});
it('preserves the source on cancellation and recovers without a leftover lock or candidate',async()=>{
  const controller=new AbortController();controller.abort();
  await expect(audio.execute('convert',{project,input_path:'source.wav',format:'flac'},controller.signal)).rejects.toMatchObject({code:'E_CANCELLED'});
  expect((await fs.readdir(root)).sort()).toEqual(['source.wav','voice-project.json']);
  expect((await call('convert',{input_path:'source.wav',format:'flac'})).ok).toBe(true);
});
it('selects an explicitly requested audio track and never silently chooses among multiple tracks',async()=>{
  ff(['-f','lavfi','-i','sine=frequency=220:sample_rate=44100:duration=2','-c:a','pcm_s16le',path.join(root,'second.wav')]);
  ff(['-i',path.join(root,'source.wav'),'-i',path.join(root,'second.wav'),'-map','0:a','-map','1:a','-c:a','copy',path.join(root,'multi.mkv')]);
  expect((await call('probe',{input_path:'multi.mkv'})).audio_streams).toEqual([
    expect.objectContaining({audio_stream:0,codec:'pcm_s16le',channels:1}),
    expect.objectContaining({audio_stream:1,codec:'pcm_s16le',channels:1}),
  ]);
  await expect(call('extract',{input_path:'multi.mkv'})).rejects.toMatchObject({code:'E_AUDIO_TRACK'});
  const result=await call('extract',{input_path:'multi.mkv',audio_stream:1});
  expect(pcm(output(result))).toEqual(pcm(path.join(root,'second.wav')));
});
it('applies requested sample rate, channels and lossy bitrate on conversion',async()=>{
  const result=await call('convert',{input_path:'source.wav',export:{format:'mp3',sample_rate:32000,channels:2,bitrate_kbps:128}});
  expect(probe(output(result)).streams[0]).toMatchObject({sample_rate:'32000',channels:2,bit_rate:'128000'});
});
it.each(['wav','flac'])('retains 24-bit audio precision by default when converting to %s',async format=>{
  ff(['-f','lavfi','-i','sine=frequency=440:sample_rate=44100:duration=1','-c:a','pcm_s24le',path.join(root,'depth.wav')]);
  const result=await call('convert',{input_path:'depth.wav',format});
  expect(probe(output(result)).streams[0].bits_per_raw_sample).toBe('24');
  const decode=(f:string)=>ff(['-i',f,'-f','f32le','-']);
  expect(decode(output(result))).toEqual(decode(path.join(root,'depth.wav')));
});
it('preserves floating-point WAV samples without clipping peaks above integer full scale',async()=>{
  ff(['-f','lavfi','-i',"aevalsrc='1.2*sin(2*PI*440*t)':s=44100:d=1",'-c:a','pcm_f32le',path.join(root,'float.wav')]);
  const result=await call('convert',{input_path:'float.wav',format:'wav'});
  expect(probe(output(result)).streams[0].codec_name).toBe('pcm_f32le');
  const decode=(f:string)=>ff(['-i',f,'-f','f32le','-']);
  expect(decode(output(result))).toEqual(decode(path.join(root,'float.wav')));
});
it('rejects corrupt media and escaped paths, then recovers without deleting completed work',async()=>{
  const first=await call('convert',{input_path:'source.wav',format:'flac'}),before=await fs.readFile(output(first));
  await fs.writeFile(path.join(root,'bad.wav'),'not audio');
  await expect(call('convert',{input_path:'bad.wav',format:'wav'})).rejects.toMatchObject({code:'E_PROCESS'});
  const outside=await fs.mkdtemp(path.join(os.tmpdir(),'voice-escape-'));
  try{
    await fs.copyFile(path.join(root,'source.wav'),path.join(outside,'outside.wav'));
    await fs.symlink(outside,path.join(root,'escape'),process.platform==='win32'?'junction':'dir');
    for(const input_path of ['escape/outside.wav',path.join(outside,'outside.wav')])await expect(call('convert',{input_path,format:'wav'})).rejects.toMatchObject({code:'E_PATH'});
  }finally{await fs.rm(outside,{recursive:true,force:true});}
  expect(await fs.readFile(output(first))).toEqual(before);
  expect((await fs.readdir(root)).some(f=>f==='.voice-lock'||f.startsWith('.voice-transfer-'))).toBe(false);
});
it('rejects a busy project and releases an actively cancelled conversion for a later retry',async()=>{
  await fs.writeFile(path.join(root,'.voice-lock'),'active');
  await expect(call('convert',{input_path:'source.wav',format:'wav'})).rejects.toMatchObject({code:'E_BUSY'});
  expect(await fs.readFile(path.join(root,'.voice-lock'),'utf8')).toBe('active');await fs.rm(path.join(root,'.voice-lock'));
  const controller=new AbortController();
  const operation=audio.execute('convert',{project,input_path:'source.wav',format:'flac'},controller.signal);
  const result=operation.then(()=>null,(e:any)=>e);
  for(let i=0;i<100;i++){
    if((await fs.readdir(root)).some(f=>f.startsWith('.voice-transfer-')))break;
    await new Promise(resolve=>setTimeout(resolve,2));
  }
  controller.abort();expect(await result).toMatchObject({code:'E_CANCELLED'});
  expect((await fs.readdir(root)).some(f=>f==='.voice-lock'||f.startsWith('.voice-transfer-')||f.startsWith('export-'))).toBe(false);
  expect((await call('convert',{input_path:'source.wav',format:'flac'})).ok).toBe(true);
});
it.each([null,'yes',{ratio:0},{release_ms:9001},{threshold_db:'-34;volume=9'},{extra:true}])('rejects invalid music ducking settings before processing: %j',async duck=>{
  await save({segments:[{id:'s',path:'source.wav'}],music:{path:'source.wav',duck}});
  await expect(call('render')).rejects.toMatchObject({code:'E_PLAN'});
  expect((await fs.readdir(root)).sort()).toEqual(['source.wav','voice-project.json']);
});
it('converts independently of an unreadable prior synthesis ledger and preserves that ledger',async()=>{
  await fs.writeFile(path.join(root,'.voice-state.json'),'damaged previous ledger');
  expect((await call('convert',{input_path:'source.wav',format:'flac'})).ok).toBe(true);
  expect(await fs.readFile(path.join(root,'.voice-state.json'),'utf8')).toBe('damaged previous ledger');
});
it('does not follow network references embedded in a supplied playlist',async()=>{
  let requests=0;const server=createServer((_req,res)=>{requests++;res.end('fixture');});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const port=(server.address() as {port:number}).port;
    await fs.writeFile(path.join(root,'remote.m3u'),`#EXTM3U\n#EXTINF:2,fixture\nhttp://127.0.0.1:${port}/source.wav\n`);
    await expect(call('extract',{input_path:'remote.m3u'})).rejects.toMatchObject({code:'E_PROCESS'});
    expect(requests).toBe(0);expect((await fs.readdir(root)).some(f=>f.startsWith('export-')||f.startsWith('.voice-transfer-')||f==='.voice-lock')).toBe(false);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

it('converts a supplied recording without inheriting saved edits, music or export defaults',async()=>{
  await save({schema_version:2,segments:[{id:'s',path:'source.wav',start_sec:.5,end_sec:1.5,speed:2,volume:3}],
    processing:[{type:'highpass',frequency_hz:300}],music:{path:'missing-old-music.wav',duck:true},
    export:{format:'mp3',sample_rate:24000,channels:2,normalize_loudness:true}});
  const plan=await fs.readFile(project),source=await fs.readFile(path.join(root,'source.wav'));
  const result=await call('convert',{input_path:'source.wav',format:'flac'});
  expect(probe(output(result)).streams[0]).toMatchObject({codec_name:'flac',sample_rate:'44100',channels:1});
  expect(pcm(output(result))).toEqual(pcm(path.join(root,'source.wav')));
  expect(await fs.readFile(project)).toEqual(plan);expect(await fs.readFile(path.join(root,'source.wav'))).toEqual(source);
});
it('retains distinct stereo channels and silence when converting a supplied recording losslessly',async()=>{
  ff(['-f','lavfi','-i',"aevalsrc='if(between(t,0.5,1.5),0.01*sin(2*PI*330*t),0)|if(between(t,0.5,1.5),0.03*sin(2*PI*880*t),0)':s=48000:d=2",'-c:a','pcm_s24le',path.join(root,'stereo.wav')]);
  const result=await call('convert',{input_path:'stereo.wav',format:'flac'});
  expect(probe(output(result)).streams[0]).toMatchObject({sample_rate:'48000',channels:2,bits_per_raw_sample:'24'});
  const decoded=(file:string)=>ff(['-i',file,'-f','s32le','-']);
  const actual=decoded(output(result));expect(actual).toEqual(decoded(path.join(root,'stereo.wav')));
  expect(actual.subarray(0,48000/2*2*4).every(b=>b===0)).toBe(true);
  expect(actual.subarray(48000/2*2*4,48000*2*4).some(b=>b!==0)).toBe(true);
});
it('rejects unsupported copy codecs honestly and recovers with an explicit conversion',async()=>{
  ff(['-i',path.join(root,'source.wav'),'-c:a','pcm_alaw',path.join(root,'legacy.mkv')]);
  const source=await fs.readFile(path.join(root,'legacy.mkv'));
  await expect(call('extract',{input_path:'legacy.mkv'})).rejects.toMatchObject({code:'E_FORMAT'});
  expect((await fs.readdir(root)).some(f=>f.startsWith('export-')||f.startsWith('.voice-transfer-')||f==='.voice-lock')).toBe(false);
  const result=await call('extract',{input_path:'legacy.mkv',format:'wav'});
  expect(probe(output(result)).streams[0].codec_name).toBe('pcm_s16le');
  expect(pcm(output(result))).toEqual(pcm(path.join(root,'legacy.mkv')));
  expect(await fs.readFile(path.join(root,'legacy.mkv'))).toEqual(source);
});
it('allows one-off export overrides without rewriting the saved export profile',async()=>{
  await save({segments:[{id:'s',path:'source.wav'}],export:{format:'wav',sample_rate:24000,channels:1,bit_depth:24,normalize_loudness:false}});
  const plan=await fs.readFile(project);
  const overridden=await call('render',{format:'flac',export:{sample_rate:32000,bit_depth:16}});
  expect(probe(output(overridden)).streams[0]).toMatchObject({codec_name:'flac',sample_rate:'32000',channels:1,bits_per_raw_sample:'16'});
  const reopened=await call('render');expect(probe(output(reopened)).streams[0]).toMatchObject({codec_name:'pcm_s24le',sample_rate:'24000',channels:1});
  expect(await fs.readFile(project)).toEqual(plan);
});
