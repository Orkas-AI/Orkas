import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {VOICE_DELIVERY_CASE_IDS} from '../../benchmark/scenarios/voice-studio.js';
import type {VoiceEvidence} from './voice-studio-fixtures.js';
import type { VoiceTrace as ProductionRegressionTrace } from './voice-studio-fixtures.js';
const require=createRequire(import.meta.url);
export const deliveryCases:readonly string[]=VOICE_DELIVERY_CASE_IDS;
export function startLocalDeliveryBoundary(){
  const prior=globalThis.fetch;let blocked=0;
  globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
    const segments=url.pathname.split('/');
    const loopback=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
    if(segments.includes('orkas_tools')||['openspeech.bytedance.com','open.volcengineapi.com'].includes(url.hostname)
      ||!loopback&&url.pathname.endsWith('/audio/speech')){
      blocked++;throw new Error('Local audio evaluation cannot dispatch a cloud media request.');
    }
    return prior(input,init);
  }) as typeof fetch;
  return {snapshot:()=>({local:true,requests:0,fulfilled:blocked===0}),close:async()=>{globalThis.fetch=prior;}};
}
const hash=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const env=()=>require('../../../src/main/util/bundled-runtime.ts').bundledRuntimeEnv();
const run=(binary:string,args:string[])=>execFileSync(binary,args,{timeout:60000,maxBuffer:8*1024*1024,stdio:['ignore','pipe','pipe']});
function tone(hz:number,amplitude:number,activeOnly=false){
  const rate=44100,n=rate*4,b=Buffer.alloc(44+n*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);
  b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28);
  b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*2,40);
  for(let i=0;i<n;i++)b.writeInt16LE(Math.round((!activeOnly||i>=rate&&i<rate*3?amplitude*Math.sin(2*Math.PI*hz*i/rate):0)*32767),44+i*2);
  return b;
}
let video:Buffer|undefined,multitrack:Buffer|undefined;
export function deliveryInputs(id:string):Record<string,Buffer|string>{
  const source=tone(660,id==='voice-music-duck'?.3:.025,id==='voice-music-duck');
  const files:Record<string,Buffer|string>={'sources/recording.wav':source,'export-previous/audio.wav':tone(330,.1),
    'voice-project.json':JSON.stringify({schema_version:1,roles:{},segments:[{id:'recording',path:'sources/recording.wav'}]})};
  if(id==='voice-music-duck')files['sources/music.wav']=tone(220,.12);
  if(id==='voice-extract-video'){
    if(!video){const root=fs.mkdtempSync(path.join(os.tmpdir(),'voice-video-fixture-'));try{
      fs.writeFileSync(path.join(root,'source.wav'),source);
      run(env().ORKAS_BUNDLED_FFMPEG,['-v','error','-nostdin','-f','lavfi','-i','color=size=32x32:duration=4:rate=10','-i',path.join(root,'source.wav'),'-fflags','+bitexact','-flags:v','+bitexact','-c:v','mpeg4','-c:a','copy','-shortest',path.join(root,'video.mkv')]);
      video=fs.readFileSync(path.join(root,'video.mkv'));
    }finally{fs.rmSync(root,{recursive:true,force:true});}}
    files['sources/video.mkv']=video;
  }
  if(id==='voice-extract-track'){
    files['sources/second.wav']=tone(880,.04);
    if(!multitrack){const root=fs.mkdtempSync(path.join(os.tmpdir(),'voice-tracks-fixture-'));try{
      fs.writeFileSync(path.join(root,'first.wav'),source);fs.writeFileSync(path.join(root,'second.wav'),files['sources/second.wav']);
      run(env().ORKAS_BUNDLED_FFMPEG,['-v','error','-nostdin','-f','lavfi','-i','color=size=32x32:duration=4:rate=10','-i',path.join(root,'first.wav'),'-i',path.join(root,'second.wav'),'-map','0:v','-map','1:a','-map','2:a','-c:v','mpeg4','-c:a','copy','-metadata:s:a:0','language=eng','-metadata:s:a:1','language=zho','-shortest',path.join(root,'multi.mkv')]);
      multitrack=fs.readFileSync(path.join(root,'multi.mkv'));
    }finally{fs.rmSync(root,{recursive:true,force:true});}}
    files['sources/multi.mkv']=multitrack;
  }
  if(id==='voice-convert-isolated'){
    files['sources/music.wav']=tone(220,.12);
    files['voice-project.json']=JSON.stringify({schema_version:2,roles:{},segments:[{id:'recording',path:'sources/recording.wav',start_sec:1,end_sec:3,speed:1.5,volume:2}],processing:[{type:'denoise',strength:'standard'}],music:{path:'sources/music.wav',volume:1,duck:true},export:{format:'mp3',sample_rate:24000,channels:2,normalize_loudness:true}});
  }
  return files;
}
function decode(file:string){return run(env().ORKAS_BUNDLED_FFMPEG,['-v','error','-nostdin','-i',file,'-map','0:a:0','-ar','44100','-ac','1','-f','f32le','-']);}
function amplitude(b:Buffer,start:number,hz:number){
  const offset=Math.round(start*44100),n=8820;if((offset+n)*4>b.length)return NaN;let a=0,c=0;
  for(let i=0;i<n;i++){const value=b.readFloatLE((offset+i)*4);a+=value*Math.cos(i*2*Math.PI*hz/44100);c+=value*Math.sin(i*2*Math.PI*hz/44100);}return Math.hypot(a,c)/n;
}
export function inspectDelivery(id:string,root:string):VoiceEvidence{
  const base=path.join(root,'audio'),inputs=deliveryInputs(id);
  const same=(rel:string)=>{try{return hash(fs.readFileSync(path.join(base,rel)))===hash(inputs[rel]);}catch{return false;}};
  const e:VoiceEvidence={sourcesPreserved:Object.keys(inputs).filter(p=>p.startsWith('sources/')).every(same),previousPreserved:same('export-previous/audio.wav'),
    projectValid:false,recordingsPreserved:true,recovered:false,exportCount:0,decoded:false,contentMatched:false,transcriptCount:0};
  const files:string[]=[],projects:string[]=[];
  function visit(dir:string,depth=0){if(depth>6||!fs.existsSync(dir))return;for(const item of fs.readdirSync(dir,{withFileTypes:true})){
    if(item.isSymbolicLink()||item.name.startsWith('.')||['sources','export-previous'].includes(item.name))continue;
    const file=path.join(dir,item.name);if(item.isDirectory())visit(file,depth+1);
    else if(/^voice-project(?:-\d+)?\.json$/.test(item.name))projects.push(file);
    else if(/\.(wav|mp3|flac|m4a|aac|ogg|opus)$/i.test(item.name))files.push(file);
  }}visit(base);e.exportCount=files.length;
  for(const file of projects)try{const p=JSON.parse(fs.readFileSync(file,'utf8'));e.projectValid||=[1,2,3].includes(p.schema_version)&&Array.isArray(p.segments)
    &&(id!=='voice-export-spec'||p.export?.format==='wav'&&p.export.sample_rate===24000&&p.export.channels===1&&p.export.bit_depth===24);}catch{}
  if(id==='voice-convert-isolated')e.projectValid &&=same('voice-project.json');
  for(const file of files)try{
    const m=JSON.parse(run(env().ORKAS_BUNDLED_FFPROBE,['-v','error','-show_streams','-show_format','-of','json',file]).toString());
    const s=m.streams[0],b=decode(file);e.decoded=true;e.duration=b.length/4/44100;
    if(m.streams.length!==1||s.codec_type!=='audio'||Math.abs(e.duration-4)>.005)continue;
    // The user did not fix the base music gain. Require audible restored music,
    // relative attenuation during speech and unchanged voice level independently.
    if(id==='voice-music-duck')e.contentMatched=amplitude(b,1.8,220)/amplitude(b,3.7,220)<.4&&amplitude(b,3.7,220)>.0005&&amplitude(b,3.7,220)<.13&&Math.abs(amplitude(b,1.8,660)-.15)<.005;
    else if(id==='voice-export-spec')e.contentMatched=s.codec_name==='pcm_s24le'&&s.sample_rate==='24000'&&s.channels===1&&Number(s.bits_per_raw_sample)===24&&amplitude(b,1.5,660)>.002;
    else e.contentMatched=s.codec_name===(['voice-convert-preserve','voice-convert-isolated'].includes(id)?'flac':'pcm_s16le')&&s.sample_rate==='44100'&&s.channels===1&&b.equals(decode(path.join(base,id==='voice-extract-track'?'sources/second.wav':'sources/recording.wav')));
  }catch{}
  return e;
}
export function deliveryChecks(_id:string,trace:ProductionRegressionTrace){
  const e=trace.voiceStudio;
  const check=(name:string,pass:boolean)=>({id:'acceptance:voice-'+name,pass,critical:true,detail:'Independent media codec, waveform, level and saved-project evidence.'});
  return [check('preservation',!!e?.sourcesPreserved&&e.previousPreserved&&e.projectValid),
    check('local-only',!trace.toolCalls.some(c=>c.name==='generate_speech')),
    check('observed-execution',trace.toolCalls.some(c=>c.name==='bash'&&c.isError===false)),
    check('outcome',!!e?.decoded&&e.contentMatched&&e.exportCount===1)];
}
