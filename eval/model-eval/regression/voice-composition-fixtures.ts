import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { VOICE_COMPOSITION_CASE_IDS } from '../../benchmark/scenarios/voice-studio.js';
import type { VoiceEvidence } from './voice-studio-fixtures.js';
import type { VoiceTrace as ProductionRegressionTrace } from './voice-studio-fixtures.js';
import { publishedVoiceCandidates } from './voice-output-evidence.js';
import { inspectProjectReplay } from './voice-project-replay.js';
const require=createRequire(import.meta.url);
export const compositionCases:readonly string[]=VOICE_COMPOSITION_CASE_IDS;
const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
function wav(seconds:number,frequency:(time:number)=>number){
  const n=Math.round(seconds*48000),b=Buffer.alloc(44+n*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(48000,24);b.writeUInt32LE(96000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*2,40);
  for(let i=0;i<n;i++)b.writeInt16LE(Math.round(.1*32767*Math.sin(2*Math.PI*frequency(i/48000)*i/48000)),44+i*2);return b;
}
export function compositionInputs(id:string):Record<string,Buffer|string>{
  const recording=wav(4,t=>id==='voice-word-cut'?(t<1?440:t<2?660:880):440);
  return {'sources/recording.wav':recording,'sources/effect.wav':wav(.3,()=>1200),'sources/music.wav':wav(id==='voice-bgm-transitions'?.7:2,()=>223.25),'sources/other.wav':wav(2,()=>330),
    'export-previous/audio.wav':wav(.5,()=>1000),'words.json':JSON.stringify({schema_version:1,granularity:'word',timing:'estimated',unit:'word-or-subword',source_sha256:hash(recording),segments:[{text:'开场',start_sec:0,end_sec:1},{text:'嗯',start_sec:1,end_sec:2},{text:'继续讲解',start_sec:2,end_sec:4}]}),
    'voice-project.json':JSON.stringify({schema_version:1,roles:{},segments:[{id:'recording',path:'sources/recording.wav'}]})};
}
function decode(file:string){const env=require('../../../src/main/util/bundled-runtime.ts').bundledRuntimeEnv();return execFileSync(env.ORKAS_BUNDLED_FFMPEG,['-v','error','-nostdin','-i',file,'-ac','1','-ar','48000','-f','f32le','-'],{timeout:60000,maxBuffer:8*1024*1024,stdio:['ignore','pipe','pipe']});}
function amp(b:Buffer,time:number,hz:number,seconds=.1){const n=Math.round(seconds*48000),start=Math.round(time*48000);if((start+n)*4>b.length)return NaN;let re=0,im=0,weight=0;for(let i=0;i<n;i++){const w=.5-.5*Math.cos(2*Math.PI*i/(n-1)),v=b.readFloatLE((start+i)*4)*w;re+=v*Math.cos(2*Math.PI*hz*i/48000);im+=v*Math.sin(2*Math.PI*hz*i/48000);weight+=w;}return Math.hypot(re,im)*2/weight;}
function windows(from:number,to:number,check:(time:number)=>boolean){
  for(let i=0;from+i*.1<=to+1e-6;i++)if(!check(from+i*.1))return false;
  return true;
}
function editableProject(file:string,base:string){
  if(fs.statSync(file).size>65536)return false;
  const p=JSON.parse(fs.readFileSync(file,'utf8'));
  const local=(relative:unknown)=>{
    if(typeof relative!=='string'||!relative)return false;
    try{const target=fs.realpathSync(path.resolve(path.dirname(file),relative));return target.startsWith(fs.realpathSync(base)+path.sep)&&fs.statSync(target).isFile();}catch{return false;}
  };
  return [1,2,3].includes(p.schema_version)&&Array.isArray(p.segments)&&p.segments.length>0
    &&p.segments.every((s:any)=>local(s?.path)&&(!s.word_edit||local(s.word_edit.transcript_path)))
    &&(!p.music||local(p.music.path))&&(!p.tracks||Array.isArray(p.tracks)&&p.tracks.every((t:any)=>local(t?.path)));
}
export function inspectComposition(id:string,root:string,published?:readonly string[]):VoiceEvidence{
  const base=path.join(root,'audio'),inputs=compositionInputs(id);
  const same=(name:string)=>{try{return hash(fs.readFileSync(path.join(base,name)))===hash(inputs[name]);}catch{return false;}};
  const e:VoiceEvidence={sourcesPreserved:Object.keys(inputs).filter(k=>k.startsWith('sources/')).every(same)&&same('words.json'),previousPreserved:same('export-previous/audio.wav'),projectValid:false,recordingsPreserved:true,recovered:false,exportCount:0,decoded:false,contentMatched:false,transcriptCount:0};
  const files:string[]=[],projects:string[]=[];
  function visit(dir:string,depth=0){if(depth>5||!fs.existsSync(dir))return;for(const item of fs.readdirSync(dir,{withFileTypes:true})){if(item.isSymbolicLink()||item.name.startsWith('.')||['sources','export-previous'].includes(item.name))continue;const file=path.join(dir,item.name);if(item.isDirectory())visit(file,depth+1);else if(/^voice-project(?:-\d+)?\.json$/.test(item.name))try{if(editableProject(file,base)){e.projectValid=true;projects.push(file);}}catch{}else if(item.name.endsWith('.wav'))files.push(file);}}
  visit(base);e.exportCount=files.length;
  const selected=publishedVoiceCandidates(files,published);
  if(published!==undefined)e.deliveredAudioCount=selected.length;
  for(const file of selected)try{
    const env=require('../../../src/main/util/bundled-runtime.ts').bundledRuntimeEnv();
    const meta=JSON.parse(execFileSync(env.ORKAS_BUNDLED_FFPROBE,['-v','error','-show_streams','-show_format','-of','json',file],{timeout:60000,maxBuffer:65536,stdio:['ignore','pipe','pipe']}).toString());
    if(meta.format?.format_name!=='wav'||meta.streams?.length!==1||meta.streams[0].codec_type!=='audio'||!meta.streams[0].codec_name?.startsWith('pcm_'))continue;
    const b=decode(file),duration=b.length/4/48000;e.decoded=true;e.duration=duration;e.composition={voice:amp(b,1.1,440),effect:amp(b,1.1,1200),earlyEffect:amp(b,.3,1200),lateEffect:amp(b,1.7,1200),musicA:amp(b,.4,223.25),musicB:amp(b,2.7,330),leakedA:amp(b,2.7,223.25),tail:amp(b,3.85,223.25),loopMiddle:amp(b,1.8,223.25),loopLate:amp(b,3.6,223.25)};
    if(id==='voice-word-cut')e.contentMatched=duration===3
      &&windows(.05,.85,t=>Math.abs(amp(b,t,440)-.1)<.004&&amp(b,t,660)<.001)
      &&windows(1.05,2.85,t=>Math.abs(amp(b,t,880)-.1)<.004&&amp(b,t,660)<.001);
    else if(id==='voice-timed-overlays')e.contentMatched=duration===4
      &&windows(.05,3.85,t=>Math.abs(amp(b,t,440)-.1)<.004)
      &&amp(b,1.1,1200)>.08&&windows(.05,.85,t=>amp(b,t,1200)<.001)&&windows(1.35,3.85,t=>amp(b,t,1200)<.001)
      &&windows(.05,1.85,t=>amp(b,t,223.25)>.005&&amp(b,t,330)<.001)
      &&windows(2.05,3.85,t=>amp(b,t,330)>.005&&amp(b,t,223.25)<.001);
    else {let jump=0;for(let i=1;i<b.length/4;i++)jump=Math.max(jump,Math.abs(b.readFloatLE(i*4)-b.readFloatLE((i-1)*4)));e.composition.max_jump=jump;e.composition.unwanted_voice=amp(b,.4,440);
      e.composition.fade_in=amp(b,.005,223.25,.03);e.composition.fade_out=amp(b,3.95,223.25,.03);
      e.contentMatched=duration===4&&windows(.05,3.85,t=>amp(b,t,440)<.001)&&jump<.015
        &&e.composition.fade_in<amp(b,.4,223.25)*.2&&e.composition.fade_out<amp(b,.4,223.25)*.2
        &&amp(b,3.85,223.25)<amp(b,.4,223.25)*.4&&windows(.25,3.55,t=>amp(b,t,223.25)>.005);}
    if(e.contentMatched){e.projectReplay=inspectProjectReplay(base,projects,file);break;}
  }catch{}
  return e;
}
export function compositionChecks(_id:string,trace:ProductionRegressionTrace){const e=trace.voiceStudio;const check=(name:string,pass:boolean)=>({id:'acceptance:voice-'+name,pass,critical:true,detail:'Independent timed frequency windows, loop continuity, source and saved-project evidence.'});return [check('preservation',!!e?.sourcesPreserved&&e.previousPreserved&&e.projectValid),check('project-replay',e?.projectReplay?.matched===true),check('local-only',!trace.toolCalls.some(c=>c.name==='generate_speech')),check('observed-execution',trace.toolCalls.some(c=>c.name==='bash'&&c.isError===false)),check('outcome',!!e?.decoded&&e.contentMatched&&(e.deliveredAudioCount??e.exportCount)===1)];}
