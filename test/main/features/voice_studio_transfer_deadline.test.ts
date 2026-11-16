import {afterEach,expect,it,vi} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {transfer}=require('../../../resources/builtin/marketplace/agents/5f890bd72ac4/skills/voice-project/scripts/transfer.js');
afterEach(()=>vi.useRealTimers());
it('bounds the entire transfer even when a dependency fails to enforce its own request timeout',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'voice-deadline-'));
  await fs.writeFile(path.join(root,'source.wav'),'fixture');
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
  const run=vi.fn(async(_binary:string,_args:string[],signal:AbortSignal)=>{
    entered();return new Promise((_resolve,reject)=>signal?.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  });
  try{
    const result=transfer(root,{input_path:'source.wav',format:'flac'},'convert',undefined,{
      local:async()=>path.join(root,'source.wav'),binary:async()=>'/fixture/codec',run,
    });
    const rejected=expect(result).rejects.toMatchObject({code:'E_TIMEOUT'});
    await started;await vi.advanceTimersByTimeAsync(30*60*1000);await rejected;
    expect(run).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
    expect(await fs.readdir(root)).toEqual(['source.wav']);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
it('rejects an overlong input before hashing, converting or creating an output candidate',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'voice-length-'));await fs.writeFile(path.join(root,'source.wav'),'fixture');
  const digest=vi.fn(),run=vi.fn(async()=>({stdout:JSON.stringify({streams:[{codec_type:'audio',duration:'14401'}]})}));
  try{
    await expect(transfer(root,{input_path:'source.wav',format:'flac'},'convert',undefined,{
      local:async()=>path.join(root,'source.wav'),binary:async()=>'/fixture/codec',run,digest,
    })).rejects.toMatchObject({code:'E_DURATION'});
    expect(digest).not.toHaveBeenCalled();expect(run).toHaveBeenCalledOnce();expect(await fs.readdir(root)).toEqual(['source.wav']);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

it.each(['encode','decode','receipt','source-changed'])('preserves completed work after %s failure and permits a clean retry',async fault=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'voice-transfer-fault-'));
  const source=path.join(root,'source.wav');await fs.writeFile(source,'original source');
  await fs.mkdir(path.join(root,'export-previous'));await fs.writeFile(path.join(root,'export-previous/audio.wav'),'previous completed audio');
  let failing=true,hashes=0;
  const metadata={streams:[{codec_type:'audio',codec_name:'pcm_s16le',sample_rate:'44100',channels:1,duration:'2'}],format:{duration:'2'}};
  const helpers={local:async()=>source,binary:async(name:string)=>name,
    digest:async(file:string)=>{if(file===source){hashes++;return failing&&fault==='source-changed'&&hashes===2?'changed':'original';}return 'output';},
    atomic:async(file:string,value:unknown)=>{if(failing&&fault==='receipt')throw Object.assign(new Error('Fixture disk full'),{code:'ENOSPC'});await fs.writeFile(file,JSON.stringify(value));},
    run:async(name:string,args:string[])=>{
      if(name==='ORKAS_BUNDLED_FFPROBE')return {stdout:JSON.stringify(metadata)};
      if(args.includes('-n')){await fs.writeFile(args.at(-1)!,'candidate audio');if(failing&&fault==='encode')throw Object.assign(new Error('Fixture encode failure'),{code:'E_PROCESS'});}
      else if(failing&&fault==='decode')throw Object.assign(new Error('Fixture truncated output'),{code:'E_PROCESS'});
      return {stdout:''};
    }};
  try{
    await expect(transfer(root,{input_path:'source.wav',format:'wav'},'convert',undefined,helpers)).rejects.toMatchObject({code:fault==='receipt'?'ENOSPC':fault==='source-changed'?'E_INPUT_CHANGED':'E_PROCESS'});
    expect((await fs.readdir(root)).sort()).toEqual(['export-previous','source.wav']);
    expect(await fs.readFile(source,'utf8')).toBe('original source');
    expect(await fs.readFile(path.join(root,'export-previous/audio.wav'),'utf8')).toBe('previous completed audio');
    failing=false;hashes=0;
    const result=await transfer(root,{input_path:'source.wav',format:'wav'},'convert',undefined,helpers);
    expect(result.ok).toBe(true);expect(result.files).toHaveLength(2);
    expect(JSON.parse(await fs.readFile(path.join(root,result.files[1]),'utf8'))).toMatchObject({operation:'convert',source_sha256:'original'});
    expect((await fs.readdir(root)).some(f=>f.startsWith('.voice-transfer-'))).toBe(false);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
