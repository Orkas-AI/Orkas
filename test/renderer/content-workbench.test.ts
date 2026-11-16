import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
const m=require('../../resources/builtin/apps/builtin-content-workbench/model.js');
const asset=(id='source',name='reference.png',bytes=16)=>m.asset({id,name,path:'media/'+id+'.'+name.split('.').pop(),bytes,createdAt:'2026-11-11T00:00:00.000Z'});
const work=(kind='image')=>({...m.draft(kind,'en'),id:'work-one',title:'Launch',brief:'Keep this exact authored request.\nIncluding its second line.',revision:1,jobs:[],results:[]});
describe('content creation, delivery and recovery',()=>{
 it('sends advisory shape and format with reference duration across media and text outputs',()=>{
  for(const kind of ['image','video','audio']){
   const w=m.draft(kind,'en');w.brief='Synthetic creation';
   expect(m.request(w,[],'output-constraints').output).toEqual(kind==='image'?{aspect:'4:5',format:'png'}:kind==='video'?{aspect:'9:16',format:'mp4'}:{format:'wav'});
   w.settings.aspect='any';w.settings.format='any';w.settings.duration=null;
   expect(m.request(w,[],'unrestricted').output).toBeUndefined();
  }
  const w=m.draft('video','en');w.brief='Write subtitles';w.settings.format='srt';
  expect(m.request(w,[],'subtitles').output).toEqual({format:'srt'});
 });
 it('keeps optional product association through editing and material reuse without requiring it for creation',()=>{
  const independent=work();expect(m.request(independent,[],'free').prompt).toBe(independent.brief);
  const linked={...work(),productId:'product-one',results:[{assetId:'source',requestId:'request',outputId:'a'.repeat(64),digest:'b'.repeat(64)}]};
  expect(m.readWork(linked,linked.id).productId).toBe('product-one');
  expect(m.edit(linked,'source').productId).toBe('product-one');expect(m.reuse(linked,'source','video','en').productId).toBe('product-one');expect(m.applyLibrary(linked,{brief:'',assetIds:['photo']}).productId).toBe('product-one');
  expect(()=>m.readWork({...linked,productId:'../another'},linked.id)).toThrow('DATA');
  expect(m.request(linked,[],'linked').prompt).toBe(linked.brief);
 });
 it('submits the authored request without a conflicting operation choice while reading old records',()=>{
  for(const kind of ['image','video','audio']){const w=work(kind);const request=m.request(w,[],'request-auto');expect(request.prompt).toBe(w.brief);expect(request.brief).not.toHaveProperty('operation');if(kind!=='image')expect(m.outputFormats(w)).toContain('txt');}
  const legacy=work('audio');legacy.operation='audio-transcript';expect(m.readWork(legacy,legacy.id).operation).toBe('audio-transcript');
 });
 it('finds unsaved output versions and keeps collection independent of task completion',()=>{
  const w=work(),job={requestId:'request',status:'completed',text:'',outputs:[{id:'a'.repeat(64),name:'result.png',bytes:1,version:'b'.repeat(64)}]};w.jobs=[job];expect(m.uncollected(w)).toEqual(job.outputs);
  w.results=[{assetId:'asset',requestId:'request',outputId:'a'.repeat(64),digest:'c'.repeat(64),version:'b'.repeat(64)}];expect(m.uncollected(w)).toEqual([]);job.outputs[0].version='d'.repeat(64);expect(m.uncollected(w)).toEqual(job.outputs);expect(job.status).toBe('completed');
 });
 it('restores legacy assets beside saved prompts and reusable mixed-media bundles without changing originals',()=>{
  const legacy={schemaVersion:1,works:[],assets:[asset()],drafts:{}};
  expect(m.readIndex(legacy).library).toEqual([]);
  const entry={id:'bundle',type:'bundle',name:'Product campaign',brief:'Keep the product shape.',assetIds:['source','voice'],createdAt:'2026-11-11',updatedAt:'2026-11-11'};
  const saved={...legacy,assets:[asset(),asset('voice','voice.wav')],library:[entry]};
  const restored=m.readIndex(saved);restored.library[0].brief='Only this copy';expect(saved.library[0].brief).toBe('Keep the product shape.');
  for(const change of [{brief:'x'.repeat(40001)},{assetIds:Array.from({length:20},(_,i)=>'a'+i)},{assetIds:['source','source']},{type:'prompt',assetIds:['source']},{type:'prompt',brief:' ',assetIds:[]},{name:''}])expect(()=>m.libraryEntry({...entry,...change})).toThrow();
  expect(()=>m.readIndex({...saved,library:[entry,entry]})).toThrow();
 });
 it('combines chosen prompts and media in selection order and deduplicates overlapping bundle files',()=>{
  const state=m.readIndex({schemaVersion:1,works:[],drafts:{},assets:[asset(),asset('voice','voice.wav')],library:[{id:'prompt',type:'prompt',name:'Style',brief:'Soft lighting.',assetIds:[]},{id:'bundle',type:'bundle',name:'Product',brief:'Keep product shape.',assetIds:['source','voice']}]});
  expect(m.libraryContent(state,['entry:prompt','asset:source','entry:bundle','asset:voice'])).toEqual({brief:'Soft lighting.\n\nKeep product shape.',assetIds:['source','voice']});
  expect(()=>m.libraryContent(state,['asset:missing'])).toThrow('SOURCE');
  state.library[1].assetIds.push('missing');expect(()=>m.libraryContent(state,['entry:bundle'])).toThrow('SOURCE');
 });
 it('requires two distinct choices for a new combination while allowing single items to be used',()=>{
  const state=m.readIndex({schemaVersion:1,works:[],drafts:{},assets:[asset(),asset('document','script.txt')],library:[{id:'prompt',type:'prompt',name:'Style',brief:'Soft light.',assetIds:[]},{id:'second',type:'prompt',name:'Audience',brief:'For a summer campaign.',assetIds:[]},{id:'bundle',type:'bundle',name:'Product',brief:'Keep product shape.',assetIds:['source']}]});
  for(const keys of [[],['asset:source'],['entry:prompt'],['entry:bundle'],['asset:source','asset:source']])expect(()=>m.libraryContent(state,keys,true)).toThrow('COMBINATION');
  expect(m.libraryContent(state,['entry:bundle'])).toEqual({brief:'Keep product shape.',assetIds:['source']});
  const combined=m.libraryContent(state,['entry:bundle','asset:document','asset:source'],true);
  expect(combined).toMatchObject({brief:'Keep product shape.',assetIds:['source','document']});
  expect(m.libraryContent(state,['entry:prompt','entry:second'],true)).toMatchObject({brief:'Soft light.\n\nFor a summer campaign.',assetIds:[]});
  combined.assetIds.push('later');expect(state.library.find((e:any)=>e.id==='bundle').assetIds).toEqual(['source']);
  expect(()=>m.libraryContent(state,['entry:prompt','asset:missing'],true)).toThrow('SOURCE');
 });
 it('counts authored copy and unique files when deciding whether a composer can form a combination',()=>{
  expect(m.materialCount({brief:' ',assetIds:[]})).toBe(0);expect(m.materialCount({brief:'A caption.',assetIds:[]})).toBe(1);
  expect(m.materialCount({brief:'',assetIds:['doc']})).toBe(1);expect(m.materialCount({brief:'',assetIds:['doc','doc']})).toBe(1);
  expect(m.materialCount({brief:'A caption.',assetIds:['doc']})).toBe(2);expect(m.materialCount({brief:'',assetIds:['doc','photo']})).toBe(2);
  expect(m.materialCount({brief:'Two saved copy items.',assetIds:[],textParts:2})).toBe(2);
 });
 it('replaces incoming authored text, appends unique files and preserves existing input atomically',()=>{
  const w=work();w.assetIds=['kept','source'];w.settings.aspect='16:9';const original=JSON.stringify(w);
  const incoming={brief:'New direction.',assetIds:['source','voice']};
  expect(m.applyLibrary(w,incoming)).toMatchObject({id:'',brief:'New direction.',assetIds:['kept','source','voice'],settings:w.settings,jobs:[],results:[]});
  expect(m.applyLibrary(w,{brief:'',assetIds:['document']})).toMatchObject({brief:w.brief,assetIds:['kept','source','document']});
  expect(m.applyLibrary(w,{brief:'Only text.',assetIds:[]})).toMatchObject({brief:'Only text.',assetIds:w.assetIds});
  expect(JSON.stringify(w)).toBe(original);
  expect(m.applyLibrary({...w,brief:'x'.repeat(40000)},incoming).brief).toBe('New direction.');
  expect(()=>m.applyLibrary(w,{brief:'x'.repeat(40001),assetIds:[]})).toThrow('LIMIT');
  const full={...w,assetIds:Array.from({length:19},(_,i)=>'a'+i)},before=JSON.stringify(full);
  expect(()=>m.applyLibrary(full,incoming)).toThrow('LIMIT');expect(JSON.stringify(full)).toBe(before);
  expect(m.applyLibrary(full,{brief:'',assetIds:['a0']}).assetIds).toHaveLength(19);
 });
 it('prepares a fresh edit with the authored request, settings and selected result across media',()=>{
  for(const kind of ['image','video','audio']){
   const source=work(kind);source.settings.aspect='16:9';source.assetIds=['original'];source.results=[{assetId:'chosen'},{assetId:'other'}];source.jobs=[{requestId:'old',status:'completed'}];
   const before=JSON.stringify(source),next=m.edit(source,'chosen');
   expect(next).toMatchObject({id:'',kind,operation:source.operation,brief:source.brief,settings:source.settings,assetIds:['chosen'],sourceWorkId:source.id,jobs:[],results:[]});
   next.settings.aspect='1:1';next.brief='User revision';expect(JSON.stringify(source)).toBe(before);
   expect(()=>m.edit(source,'original')).toThrow();expect(()=>m.edit(source,'missing')).toThrow();
  }
 });
 it('keeps all saved records in their media tab, newest first, without changing the composer',()=>{
  const rows=[{id:'a',kind:'image',title:'Blue landscape',updatedAt:'2026-01-01'},{id:'b',kind:'video',title:'Blue story',updatedAt:'2026-02-01'},{id:'c',kind:'image',title:'Red landscape',updatedAt:'2026-03-01'}],before=JSON.stringify(rows);
  expect(m.historyRows(rows,'image').map((w:any)=>w.id)).toEqual(['c','a']);expect(m.historyRows(rows,'audio')).toEqual([]);expect(JSON.stringify(rows)).toBe(before);
 });
 it('restores original image assets with or without a small thumbnail but rejects foreign thumbnail paths',()=>{
  const a=asset();expect(m.asset(a)).toEqual(a);expect(m.asset({...a,thumbnailPath:'thumbnails/source.jpg'}).thumbnailPath).toBe('thumbnails/source.jpg');
  for(const thumbnailPath of ['../private.png','media/source.png','thumbnails/other.jpg'])expect(()=>m.asset({...a,thumbnailPath})).toThrow();
  expect(()=>m.asset({...asset('audio','voice.wav'),thumbnailPath:'thumbnails/audio.jpg'})).toThrow();
 });
 it('keeps parsed controls disabled until saved drafts and Studio availability have loaded',()=>{
  const html=fs.readFileSync(path.join(__dirname,'../../resources/builtin/apps/builtin-content-workbench/index.html'),'utf8');
  expect(html).not.toContain('id="save-draft"');
  const controls=[...html.matchAll(/<(?:input|textarea|button)\b[^>]*>/g)].map(match=>match[0]);
  expect(controls.length).toBeGreaterThan(10);for(const control of controls)expect(control).toMatch(/\sdisabled(?:\s|>|=)/);
 });
 it('ships the shared AiSelect source and styles without maintaining an app-specific dropdown',()=>{
  const {generatedFiles}=require('../../scripts/update-builtin-app-controls.cjs');
  for(const [file,source]of generatedFiles())expect(fs.readFileSync(file,'utf8')).toBe(source);
 });
 it('starts without a name or output language and preserves legacy names and language data on read',()=>{
  const w=m.draft('image','zh');w.brief='  A blue landscape\nwith water.  ';
  expect(m.displayTitle(w)).toBe('A blue landscape\nwith water.');expect(w.title).toBe('');
  expect(m.request(w,[],'r').brief.settings).toEqual({aspect:'4:5',format:'png'});
  expect(w.operation).toBe('auto');expect(m.draft('audio','ar').operation).toBe('auto');
  const legacy=work();legacy.settings.language='fr';expect(m.readWork(legacy,legacy.id)).toEqual(legacy);expect(m.displayTitle(legacy)).toBe('Launch');
  w.brief='x'.repeat(40000);expect(m.displayTitle(w)).toHaveLength(160);expect(w.brief).toHaveLength(40000);
 });
 it('only submits optional parameters that apply to the media type and output format',()=>{
  for(const kind of ['image','video','audio']){
   const w=work(kind),s=m.request(w,[],'r').brief.settings;expect(s).not.toHaveProperty('language');
   expect(Object.keys(s).sort()).toEqual((kind==='image'?['aspect','format']:kind==='video'?['aspect','duration','format']:['format']).sort());
  }
  const script=work('video');script.operation='video-script';script.settings.format='txt';expect(m.request(script,[],'r').brief.settings).toEqual({format:'txt'});
  const music=work('audio');music.operation='audio-music';expect(m.request(music,[],'r').brief.settings).toEqual({format:'wav'});
 });
 it('routes each media tab to its owning Studio using the authored request without operation inference',()=>{
  for(const [kind,agentId]of [['image','814b61b027f0'],['video','79df9cc89f5f'],['audio','5f890bd72ac4']]){
   const w=work(kind);const request=m.request(w,[],'request-one');expect(request.agentId).toBe(agentId);expect(request.prompt).toBe(w.brief);
   expect(request.brief).toMatchObject({schemaVersion:1,kind,settings:{format:w.settings.format}});
  }
  expect(m.request({...work('audio'),operation:'audio-transcript'},[],'r').brief).not.toHaveProperty('operation');
 });
 it('preserves each media draft and freezes selected source identities before asynchronous submission',()=>{
  const w=work();w.assetIds=['source'];const a=asset();const request=m.request(w,[a],'r');
  w.brief='Later text';w.settings.aspect='16:9';a.name='Changed.png';
  expect(request.prompt).toBe('Keep this exact authored request.\nIncluding its second line.');expect(request.brief.settings.aspect).toBe('4:5');
  expect(request.brief.sources).toEqual([{id:'source',name:'reference.png',file:'source.png'}]);expect(request.files).toEqual(['media/source.png']);
  expect(m.draft('video','zh').settings.aspect).toBe('9:16');expect(m.draft('audio','fr').settings.language).toBe('fr');
 });
 it('requires an authored request and known private references before admission',()=>{
  expect(()=>m.request({...work(),brief:'  '},[],'r')).toThrow();
  expect(()=>m.request({...work(),brief:'a'.repeat(40001)},[],'r')).toThrow();
  expect(()=>m.request({...work(),assetIds:['missing']},[],'r')).toThrow();
  expect(()=>m.request({...work(),assetIds:Array.from({length:20},(_,i)=>'a'+i)},Array.from({length:20},(_,i)=>asset('a'+i)),'r')).toThrow();
  expect(()=>m.asset({...asset(),path:'../other-account/file.png'})).toThrow();
  expect(()=>m.asset({...asset(),path:'media/a/../../secret.png'})).toThrow();
 });
 it('bounds user media by actual file size and retains supported audio and subtitle formats',()=>{
  expect(asset('large','image.png',20*1024*1024).kind).toBe('image');expect(()=>asset('large','image.png',20*1024*1024+1)).toThrow();
  expect(asset('sound','voice.wav',200*1024*1024).kind).toBe('audio');expect(()=>asset('sound','voice.wav',200*1024*1024+1)).toThrow();
  expect(asset('subtitle','captions.srt').kind).toBe('document');expect(asset('video','cut.mp4').kind).toBe('video');
  expect(()=>asset('script','unsafe.exe')).toThrow();expect(()=>asset('negative','voice.mp3',-1)).toThrow();
 });
 it('keeps generated files out of the library until that individual file is explicitly saved',()=>{
  const source=asset(),first:any={...asset('first','audio.mp3'),origin:{requestId:'r'}},second={...asset('second','captions.srt'),origin:{requestId:'r'}};
  const state={assets:[source,first,second]};
  expect(m.libraryAssets(state).map((a:any)=>a.id)).toEqual(['source']);
  first.libraryHidden=false;
  expect(m.libraryAssets(state).map((a:any)=>a.id)).toEqual(['source','first']);
  first.libraryHidden=true;expect(m.libraryAssets(state).map((a:any)=>a.id)).toEqual(['source']);
  expect(state.assets).toHaveLength(3);
 });
 it('keeps every generated file collectible and groups unlisted files without losing cross-format deliverables',()=>{
  const w=work('audio'),files=[['audio.mp3',true],['captions.srt',true],['speech.mp3',false],['receipt.json',false],['project.html',false],['README',false]].map(([name,published],i)=>({id:String(i+1).repeat(64),name,bytes:10,published}));
  const job={requestId:'r',status:'completed',outputs:[]};w.jobs=[job];m.inspect(w,job,{status:'completed',files});
  expect(m.uncollected(w).map((f:any)=>f.name)).toEqual(files.map(f=>f.name));
  w.results=files.map((f:any,i:number)=>({assetId:'a'+i,requestId:'r',outputId:f.id}));
  expect(m.resultGroups(w)).toEqual({primary:w.results.slice(0,2),other:w.results.slice(2)});
  expect(m.uncollected(w)).toEqual([]);expect(m.needsReply(w)).toBe(false);
 });
 it('keeps every legacy output accessible while selected format only changes its default placement',()=>{
  const w=work('audio');w.jobs=[{requestId:'r',status:'completed',text:'Done.',outputs:[{id:'a'.repeat(64),name:'voice.wav',bytes:10},{id:'b'.repeat(64),name:'project.json',bytes:10}]}];
  expect(m.uncollected(w).map((f:any)=>f.name)).toEqual(['voice.wav','project.json']);
  w.results=w.jobs[0].outputs.map((f:any,i:number)=>({assetId:'a'+i,requestId:'r',outputId:f.id}));
  expect(m.resultGroups(w)).toEqual({primary:[w.results[0]],other:[w.results[1]]});
  w.settings.format='json';expect(m.resultGroups(w)).toEqual({primary:[w.results[1]],other:[w.results[0]]});
  w.settings.format='any';expect(m.resultGroups(w)).toEqual({primary:[w.results[0]],other:[w.results[1]]});
 });
 it('retains files even when publication is empty, without manufacturing an extra media reply file',()=>{
  const w=work('audio');w.jobs=[{requestId:'r',status:'completed',text:'Done.',outputs:[{id:'a'.repeat(64),name:'speech.wav',bytes:10,published:false}]}];w.results=[{assetId:'voice',requestId:'r',outputId:'a'.repeat(64)}];
  expect(m.resultGroups(w)).toEqual({primary:[],other:w.results});expect(m.needsReply(w)).toBe(false);
 });
 it('retains generic generated documents and extensionless receipts without expanding local import types',()=>{
  const origin={requestId:'r',outputId:'a'.repeat(64)},saved='results/'+ 'b'.repeat(64)+'/'+'c'.repeat(16)+'-'+'d'.repeat(16);
  for(const name of ['project.html','render.js','delivery.zip','README','raw.customformat']){
   const a=m.asset({id:'output',name,path:saved,bytes:10,origin});expect(a.kind).toBe('document');
   expect(m.readIndex({schemaVersion:1,works:[],assets:[a],drafts:{}}).assets[0]).toEqual(a);
   const w=work();w.assetIds=['output'];expect(m.request(w,[a],'next').files).toEqual([saved]);
   expect(()=>m.asset({...a,origin:undefined})).toThrow('FILE');expect(()=>m.asset({...a,path:'../private'})).toThrow('FILE');
  }
 });
 it('removes hidden audio duration constraints from old drafts and reused settings without changing video',()=>{
  const w=work('audio');w.settings.duration=7200;
  for(const format of ['any','wav','mp3','txt','srt','json']){w.settings.format=format;expect(m.request(w,[],'r').brief.settings).not.toHaveProperty('duration');}
  expect(m.draft('audio','zh').settings.duration).toBeNull();
  expect(m.request(work('video'),[],'r').brief.settings.duration).toBe(30);
 });
 it('collects composition source files alongside the video and deduplicates only accepted versions',()=>{
  const w=work('video'),output={id:'a'.repeat(64),name:'final.mp4',bytes:10};w.jobs=[{requestId:'r',status:'completed',text:'Complete.',outputs:[{id:'b'.repeat(64),name:'index.html',bytes:10},output,{id:'c'.repeat(64),name:'render.js',bytes:10}]}];
  expect(m.uncollected(w)).toEqual(w.jobs[0].outputs);expect(m.needsReply(w)).toBe(false);
  w.results=[{assetId:'video',requestId:'r',outputId:output.id}];expect(m.uncollected(w).map((f:any)=>f.name)).toEqual(['index.html','render.js']);expect(m.needsReply(w)).toBe(false);
 });
 it('keeps direct text delivery collectible alongside unsupported helper files and stops after saving it',()=>{
  const w=work('audio');w.jobs=[{requestId:'r',status:'completed',text:'The actual transcript.',outputs:[{id:'a'.repeat(64),name:'helper.py',bytes:10}]}];
  expect(m.uncollected(w)).toEqual(w.jobs[0].outputs);expect(m.needsReply(w)).toBe(true);
  w.results=[{assetId:'text',requestId:'r',kind:'reply'}];expect(m.needsReply(w)).toBe(false);
  w.results=[];w.jobs[0].status='failed';expect(m.needsReply(w)).toBe(false);
 });
 it('keeps task completion separate from explicitly accepted output files',()=>{
  const w=work(),job={requestId:'r',status:'submitted',text:'',outputs:[]};w.jobs.push(job);
  m.inspect(w,job,{requestId:'r',status:'completed',text:'I made the video.',files:[]});
  expect(job.status).toBe('completed');expect(w.results).toEqual([]);expect(w.brief).toContain('exact authored');
  expect(()=>m.inspect(w,job,{requestId:'another',status:'completed',text:'Wrong',files:[]})).toThrow();
  expect(job.text).toBe('I made the video.');
 });
 it('keeps unsettled terminal inspections pending until the durable host receipt determines delivery',()=>{
  for(const status of ['completed','failed','stopped']){
   const w=work('video'),job={requestId:'r',status:'running',text:'',outputs:[]};w.jobs=[job];
   m.inspect(w,job,{requestId:'r',status,text:'Provisional reply.',files:[],saved:false});
   expect(job.status).toBe('saving');expect(m.needsReply(w)).toBe(false);expect(m.canStart(w)).toBe(false);expect(w.results).toEqual([]);
   m.inspect(w,job,{requestId:'r',status:'failed',text:'No video output.',files:[],saved:true,error:{code:'E_OUTPUT_MISSING'}});
   expect(job).toMatchObject({status:'failed',errorCode:'E_OUTPUT_MISSING'});expect(m.needsReply(w)).toBe(false);
  }
  for(const saved of [true,undefined]){
   const w=work(),job={requestId:'r',status:'running',text:'',outputs:[]};w.jobs=[job];
   m.inspect(w,job,{status:'completed',text:'Archived reply.',files:[],...(saved===undefined?{}:{saved})});
   expect(job.status).toBe('completed');expect(m.needsReply(w)).toBe(true);
  }
 });
 it('rejects malformed receipts without replacing preserved results or manufacturing success',()=>{
  const w=work(),job={requestId:'r',status:'running',text:'Existing',outputs:[]};w.jobs.push(job);
  for(const result of [{status:'published',text:'done',files:[]},{status:'completed',files:'not an array'},{status:'completed',text:'',files:[{id:'../file',name:'file.png',bytes:1}]},{status:'completed',files:[{id:'a'.repeat(64),name:'file.png',bytes:1,published:'yes'}]}])expect(()=>m.inspect(w,job,result)).toThrow();
  expect(job).toMatchObject({status:'running',text:'Existing',outputs:[]});
 });
 it('preserves stopped and uncertain tasks rather than admitting another task on the same work',()=>{
  const w=work();w.jobs=[{requestId:'r',status:'unknown',text:'',outputs:[]}];expect(m.canStart(w)).toBe(false);
  for(const status of ['submitting','submitted','running','waiting_input']){w.jobs[0].status=status;expect(m.canStart(w)).toBe(false);}
  w.jobs[0].status='stopped';expect(m.canStart(w)).toBe(false);
  expect(m.canStart({...work(),jobs:[]})).toBe(true);
 });
 it('deduplicates the same result bytes but retains changed bytes as an independent version',()=>{
  const w=work(),a={...asset('one'),digest:'a'.repeat(64),origin:{requestId:'r',outputId:'b'.repeat(64)}};
  expect(m.accept(w,a)).toBe(true);expect(m.accept(w,{...a,id:'duplicate'})).toBe(false);
  expect(m.accept(w,{...a,id:'new-take',digest:'c'.repeat(64)})).toBe(true);
  expect(w.results.map(r=>r.assetId)).toEqual(['one','new-take']);expect(w.assetIds).toEqual([]);
 });
 it('lets the user preserve a text-only script as text without fabricating a native output descriptor',()=>{
  const w=work('video'),a={...asset('script','reply.txt'),digest:'a'.repeat(64),origin:{requestId:'r',kind:'reply'}};
  expect(m.accept(w,a)).toBe(true);expect(w.results[0]).toMatchObject({assetId:'script',kind:'reply',requestId:'r'});expect(w.results[0]).not.toHaveProperty('outputId');
  expect(m.readWork(w,w.id).results).toHaveLength(1);expect(m.accept(w,{...a,id:'duplicate'})).toBe(false);
 });
 it('reuses selected results across media without mutating the source work or mixing their task histories',()=>{
  const source=work();source.results=[{assetId:'source',requestId:'r',outputId:'b'.repeat(64),digest:'a'.repeat(64)}];source.jobs=[{requestId:'r'}];
  const before=JSON.stringify(source),next=m.reuse(source,'source','video','zh');
  expect(next).toMatchObject({kind:'video',assetIds:['source'],sourceWorkId:'work-one',jobs:[],results:[]});expect(next.id).toBe('');expect(JSON.stringify(source)).toBe(before);
 });
 it('restores durable records and fails closed on malformed data instead of silently clearing it',()=>{
  const w=work();expect(m.readWork(JSON.parse(JSON.stringify(w)),w.id)).toMatchObject({id:w.id,brief:w.brief});
  expect(()=>m.readWork({...w,id:'another'},w.id)).toThrow();expect(()=>m.readWork({...w,schemaVersion:900},w.id)).toThrow();
  expect(()=>m.readIndex({schemaVersion:900,works:[],assets:[],drafts:{}})).toThrow();
  expect(()=>m.readIndex({schemaVersion:1,works:[],assets:[],drafts:{image:{...m.draft('image','en'),settings:null}}})).toThrow();
  expect(()=>m.readWork({...w,results:[{assetId:'../../foreign',digest:'bad'}]},w.id)).toThrow();
  expect(m.readIndex(null)).toMatchObject({schemaVersion:1,works:[],assets:[]});
 });
 it('exposes supported Studio deliverables without inventing undeclared voice synthesis',()=>{
  expect(m.operations.image).toEqual(expect.arrayContaining(['image-document','image-layered','image-process']));
  expect(m.operations.video).toEqual(expect.arrayContaining(['video-highlights','video-cleanup','video-subtitles']));
  expect(m.operations.audio).toEqual(expect.arrayContaining(['audio-transcript','audio-denoise','audio-enhance','audio-silence','audio-edit','audio-extract','audio-convert']));
  for(const operation of ['audio-clone','audio-diarize','audio-song'])expect(m.operations.audio).not.toContain(operation);
  expect(m.mediaKind('project.json')).toBe('document');expect(m.mediaKind('notes.txt')).toBe('document');expect(m.mediaKind('voice.MP3')).toBe('audio');
 });
 it('leaves unrestricted settings out of requests and restores them alongside legacy constrained records',()=>{
  for(const kind of ['image','video','audio']){
   const w=work(kind);w.settings={...w.settings,aspect:'any',duration:null,format:'any'};
   expect(m.readWork(w,w.id)).toEqual(w);expect(m.request(w,[],'r').brief.settings).toEqual({});
  }
  const w=work('video');for(const duration of [0,-1,0.5,7201])expect(()=>m.request({...w,settings:{...w.settings,duration}},[],'r')).toThrow();
  for(const duration of [1,7200])expect(m.request({...w,settings:{...w.settings,duration}},[],'r').brief.settings.duration).toBe(duration);
  expect(m.readWork(work(), 'work-one').settings).toMatchObject({aspect:'4:5',duration:30,format:'png'});
 });
 it('offers PDF and layered image delivery, transcription JSON and supported audio conversions',()=>{
  for(const format of ['pdf','psd']){const w=work();w.settings.format=format;expect(m.outputFormats(w)).toContain(format);expect(m.request(w,[],'r').brief.settings.format).toBe(format);expect(asset('output','result.'+format).kind).toBe('document');}
  const transcript=work('audio');transcript.operation='audio-transcript';transcript.settings.format='json';expect(m.outputFormats(transcript)).toEqual(expect.arrayContaining(['any','txt','srt','json']));expect(m.request(transcript,[],'r').brief.settings).toEqual({format:'json'});
  const convert=work('audio');convert.operation='audio-convert';convert.settings.format='opus';expect(m.request(convert,[],'r').brief.settings).toEqual({format:'opus'});expect(asset('output','result.opus').kind).toBe('audio');
 });
 it('localizes the independent workspace and every operation for all registered product locales',async()=>{
  const {SUPPORTED_LANGS}=await import('../../src/main/i18n');const window:any={};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../resources/builtin/apps/builtin-content-workbench/locales.js'),'utf8'),{window});
  expect(Object.keys(window.ContentLocales).sort()).toEqual([...SUPPORTED_LANGS].sort());
  const keys=Object.keys(window.ContentLocales.en);for(const locale of SUPPORTED_LANGS){expect(Object.keys(window.ContentLocales[locale]).sort(),locale).toEqual([...keys].sort());expect(Object.values(window.ContentLocales[locale]).every(v=>typeof v==='string'&&v.trim().length>0),locale).toBe(true);}
  const html=fs.readFileSync(path.join(__dirname,'../../resources/builtin/apps/builtin-content-workbench/index.html'),'utf8');for(const match of html.matchAll(/data-t="([^"]+)"/g))expect(keys).toContain(match[1]);
  for(const key of Object.values(m.operations).flat())expect(keys).toContain(key);
 });
});
