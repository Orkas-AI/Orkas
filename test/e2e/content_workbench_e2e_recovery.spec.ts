import path from 'node:path';
import {readFileSync} from 'node:fs';
import {openSidebarEntry,expect,test} from './fixtures/orkas';
test.setTimeout(90000);

// Exercise explicitly configured public services without dispatching external media work.
test.beforeEach(async({modelOrkas:orkas})=>{
 await orkas.electronApp!.evaluate((_electron:any,root:string)=>{
  const load=(process as any).mainModule.require.bind((process as any).mainModule),auth=load(root+'/features/auth.ts');
  auth.saveImageProfiles([{id:'recovery-image',provider:'openai',model:'gpt-image-2',apiKey:'fixture-unused-image',label:'Local image service',createdAt:1}]);
  auth.saveVideoProfiles([{id:'recovery-video',provider:'doubao',model:'doubao-seedance-2-0-260128',apiKey:'fixture-unused-video',label:'Local video service',createdAt:1}]);
  auth.saveTtsProfiles([{id:'recovery-voice',provider:'openai',model:'tts-1',baseUrl:'https://speech.fixture/v1',apiKey:'fixture-unused-voice',voice:'alloy',label:'Local speech service',createdAt:1}]);
  const image=load(root+'/features/image_gen.ts'),video=load(root+'/features/video_gen.ts'),tts=load(root+'/features/tts.ts'),originals=[image.generateImage,video.generateVideo,tts.generateSpeech];
  const fixture={calls:0,restore:()=>{[image.generateImage,video.generateVideo,tts.generateSpeech]=originals;}};
  (globalThis as any).__contentRecoveryMedia=fixture;
  image.generateImage=video.generateVideo=tts.generateSpeech=async()=>{fixture.calls++;throw Error('Unexpected external media generation in the controlled recovery fixture');};
 },path.resolve(__dirname,'../../src/main'));
});
test.afterEach(async({modelOrkas:orkas})=>{
 const calls=await orkas.electronApp?.evaluate(()=>{const fixture=(globalThis as any).__contentRecoveryMedia;if(!fixture)return null;fixture.restore();return fixture.calls;});
 expect(calls).toBe(0);
});

const key='content-index-v1',png='iVBORw0KGgoAAAANSUhEUgAAACgAAAAyCAIAAACh0Q7HAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAMklEQVR4nO3NoQ0AAAwCMP6/eWJngGhS31xS0VnFYrFYLBaLxWKxWCwWi8VisVgsHokfqPaxKlhS/5wAAAAASUVORK5CYII=';

// Recovery cases need a real media receipt, independently of controlled reply prose.
async function stageResult(orkas:any,kind='image',sources:Record<string,string>={}){
 let bytes=Buffer.from(png,'base64'),name='recovered.png';
 if(kind==='video'){bytes=readFileSync(path.join(__dirname,'fixtures/content-workbench-portrait.mp4'));name='recovered.mp4';}
 if(kind==='audio'){
  bytes=Buffer.alloc(44+1600);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(8000,24);bytes.writeUInt32LE(16000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(1600,40);name='recovered.wav';
 }
 await orkas.electronApp.evaluate((_electron:any,{name,base64,sources}:any)=>{
  const {service,workspace,fs,path}=(globalThis as any).__contentReview,original=service.deps.send;
  service.deps.send=async function(uid:string,cid:string,...args:any[]){
   service.deps.send=original;const dir=await workspace.getConversationWorkspacePath(uid,cid);
   fs.mkdirSync(dir,{recursive:true});for(const[name,text]of Object.entries(sources))fs.writeFileSync(path.join(dir,name),text);fs.writeFileSync(path.join(dir,name),Buffer.from(base64,'base64'));return original.call(this,uid,cid,...args);
  };
 },{name,base64:bytes.toString('base64'),sources});
}

async function open(orkas:any,ready=true){
 await orkas.page.evaluate(()=>(window as any).setLang('zh'));
 await openSidebarEntry(orkas.page,'#apps-btn');
 // Cache the real fault seam before opening a source-integrity checked app.
 await orkas.electronApp.evaluate(async(_electron:any,args:any)=>{
  if((globalThis as any).__contentReview)return;
  const load=(process as any).mainModule.require.bind((process as any).mainModule);
  (globalThis as any).__contentReview={runtime:load(args.host).runtime,AppError:load(args.runtime).AppError,
   service:load(args.taskHost).taskService,workspace:load(args.workspace),fs:load('node:fs'),path:load('node:path')};
 },{host:path.resolve(__dirname,'../../src/main/features/web_apps/host.ts'),runtime:path.resolve(__dirname,'../../src/main/features/web_apps/runtime.ts'),taskHost:path.resolve(__dirname,'../../src/main/features/web_apps/task-host.ts'),workspace:path.resolve(__dirname,'../../src/main/features/group_chat/conv_workspace.ts')});
 const preview=await orkas.openPreview(()=>orkas.page.locator('.app-card[data-app-id="builtin-content-workbench"]').click()),frame=preview.frameLocator('.saved-app-viewer-frame');
 if(ready)await expect(frame.locator('#brief')).toBeEnabled();return{preview,frame};
}
async function state(frame:any){return frame.locator('body').evaluate(async()=>((await(window as any).orkasApp.storage.get({key:'content-index-v1',scope:'cloud'})).value));}
test('collects a finished video alongside composition source files without losing the archived sources',async({modelOrkas:orkas})=>{
 let{preview,frame}=await open(orkas);await frame.locator('#nav-video').click();await frame.locator('#brief').fill('Create a portrait video from a composition.');
 await stageResult(orkas,'video',{'index.html':'<html><body>Composition source</body></html>','render.js':'// Composition helper'});orkas.setModelTextReplies(['The composition is complete.']);await frame.locator('#submit').click();
 await expect.poll(()=>frame.locator('body').evaluate(async()=>{const api=(window as any).orkasApp,index=(await api.storage.get({key:'content-index-v1',scope:'cloud'})).value;if(!index.works[0])return null;const w=JSON.parse((await api.appFiles.readText({path:'works/'+index.works[0].id+'.json',scope:'cloud'})).text);return{status:w.jobs[0]?.status,results:w.results.map((r:any)=>index.assets.find((a:any)=>a.id===r.assetId)?.name).sort(),error:!!w.collectionError,pending:!!index.works[0].collectionPending};})).toEqual({status:'completed',results:['index.html','recovered.mp4','render.js'],error:false,pending:false});
 const sources=await frame.locator('body').evaluate(async()=>{const api=(window as any).orkasApp,index=(await api.storage.get({key:'content-index-v1',scope:'cloud'})).value,w=JSON.parse((await api.appFiles.readText({path:'works/'+index.works[0].id+'.json',scope:'cloud'})).text),saved=[];for(const o of w.jobs[0].outputs)if(o.name!=='recovered.mp4')saved.push([o.name,atob((await api.tasks.output({requestId:w.jobs[0].requestId,outputId:o.id})).base64)]);return saved;});
 expect(sources.sort((a:any,b:any)=>a[0].localeCompare(b[0]))).toEqual([['index.html','<html><body>Composition source</body></html>'],['render.js','// Composition helper']]);expect(orkas.modelRequests).toHaveLength(1);await orkas.closePreview(preview);({preview,frame}=await open(orkas));await frame.locator('#nav-video').click();await expect(frame.locator('.history-row')).toHaveCount(1);expect((await state(frame)).assets.map((a:any)=>a.name)).toContain('recovered.mp4');expect(orkas.modelRequests).toHaveLength(1);await orkas.closePreview(preview);
});
test('accepts a locally composed portrait video shorter than the reference duration without generating media',async({modelOrkas:orkas})=>{
 const{preview,frame}=await open(orkas);await frame.locator('#nav-video').click();await frame.locator('#brief').fill('Use existing material for a portrait video.');
 await stageResult(orkas,'video');orkas.setModelTextReplies(['Controlled local composition.']);await frame.locator('#submit').click();
 await expect.poll(async()=>(await state(frame)).works[0]?.status,{timeout:30000}).toBe('completed');
 await expect.poll(async()=>{const row=(await state(frame)).works[0];return{results:row?.resultAssetIds?.length,pending:row?.collectionPending,error:row?.collectionError};},{timeout:30000}).toEqual({results:1,pending:false,error:false});
 const row=(await state(frame)).works[0],saved=await frame.locator('body').evaluate(async(_el:any,id:string)=>JSON.parse((await(window as any).orkasApp.appFiles.readText({path:'works/'+id+'.json',scope:'cloud'})).text),row.id);
 expect(saved.settings.duration).toBe(30);expect(saved.results).toHaveLength(1);expect(orkas.modelRequests).toHaveLength(1);
 expect(await orkas.electronApp.evaluate(()=>(globalThis as any).__contentRecoveryMedia.calls)).toBe(0);await orkas.closePreview(preview);
});
test('accepts image proportions as guidance and retains actual bytes after reopening without replay',async({modelOrkas:orkas},info)=>{
 let{preview,frame}=await open(orkas);await frame.locator('#aspect-trigger').click();await frame.locator('#aspect-listbox [data-value="16:9"]').click();await frame.locator('#brief').fill('A wide campaign image.');
 await stageResult(orkas);orkas.setModelTextReplies(['The wide campaign is ready.']);await frame.locator('#submit').click();
 await expect.poll(async()=>(await state(frame)).works[0]?.status,{timeout:30000}).toBe('completed');
 await expect(frame.locator('.record-failure-summary:visible')).toHaveCount(0);
 await expect.poll(async()=>{const row=(await state(frame)).works[0];return{results:row?.resultAssetIds?.length,pending:row?.collectionPending,error:row?.collectionError};},{timeout:30000}).toEqual({results:1,pending:false,error:false});
 const row=(await state(frame)).works[0],saved=await frame.locator('body').evaluate(async(_el:any,id:string)=>JSON.parse((await(window as any).orkasApp.appFiles.readText({path:'works/'+id+'.json',scope:'cloud'})).text),row.id);
 expect(saved.jobs[0].errorCode).toBeUndefined();expect(saved.results).toHaveLength(1);expect(orkas.modelRequests).toHaveLength(1);
 await preview.screenshot({path:info.outputPath('parameter-mismatch-zh.png')});await orkas.closePreview(preview);({preview,frame}=await open(orkas));
 await expect(frame.locator('.record-failure-summary:visible')).toHaveCount(0);expect((await state(frame)).works[0].status).toBe('completed');expect(orkas.modelRequests).toHaveLength(1);await orkas.closePreview(preview);
});
test('accepts an audio format preference without rejecting the actual WAV export',async({modelOrkas:orkas})=>{
 const{preview,frame}=await open(orkas);await frame.locator('#nav-audio').click();await frame.locator('#format-trigger').click();await frame.locator('#format-listbox [data-value="mp3"]').click();await frame.locator('#brief').fill('Make an MP3 from existing audio.');
 await stageResult(orkas,'audio');orkas.setModelTextReplies(['The MP3 is complete.']);await frame.locator('#submit').click();
 await expect.poll(async()=>(await state(frame)).works[0]?.status,{timeout:30000}).toBe('completed');await expect(frame.locator('.record-failure-summary:visible')).toHaveCount(0);await expect.poll(async()=>(await state(frame)).assets.map((a:any)=>a.name)).toContain('recovered.wav');expect(orkas.modelRequests).toHaveLength(1);await orkas.closePreview(preview);
});
test('keeps valid JSON and SRT extensions while allowing ordinary text for advisory format preferences',async({modelOrkas:orkas})=>{
 const{preview,frame}=await open(orkas);await frame.locator('#nav-audio').click();
 for(const [format,text,status]of [['json','Transcription completed.','completed'],['json','{"transcript":"Synthetic"}','completed'],['srt','1\n00:00:00,000 --> 00:00:01,000\nSynthetic caption','completed']]){
  await frame.locator('#format-trigger').click();await frame.locator('#format-listbox [data-value="'+format+'"]').click();await frame.locator('#brief').fill('Return the transcript as '+format.toUpperCase()+'.');orkas.setModelTextReplies([text]);await frame.locator('#submit').click();
  await expect.poll(async()=>(await state(frame)).works[0]?.status,{timeout:30000}).toBe(status);
  if(status==='completed'){
   const id=(await state(frame)).works[0].id;
   await expect.poll(()=>frame.locator('body').evaluate(async(_el:any,id:string)=>{const api=(window as any).orkasApp,w=JSON.parse((await api.appFiles.readText({path:'works/'+id+'.json',scope:'cloud'})).text),index=(await api.storage.get({key:'content-index-v1',scope:'cloud'})).value;return w.results.map((r:any)=>index.assets.find((a:any)=>a.id===r.assetId)?.name);},id)).toEqual(['reply.'+(text==='Transcription completed.'?'txt':format)]);
   const actual=await frame.locator('body').evaluate(async(_el:any,id:string)=>{const api=(window as any).orkasApp,w=JSON.parse((await api.appFiles.readText({path:'works/'+id+'.json',scope:'cloud'})).text),index=(await api.storage.get({key:'content-index-v1',scope:'cloud'})).value,asset=index.assets.find((a:any)=>a.id===w.results[0].assetId);return(await api.appFiles.readText({path:asset.path,scope:'cloud'})).text;},id);
   expect(actual).toBe(text);
  }
 }
 expect(orkas.modelRequests).toHaveLength(3);await orkas.closePreview(preview);
});
test('ignores files dropped outside the composer without navigating or changing a saved draft',async({modelOrkas:orkas})=>{
 const{preview,frame}=await open(orkas);await frame.locator('#brief').fill('Keep this draft when a file misses the composer.');await expect(frame.locator('#save-state')).toHaveText('已保存');
 const before=await state(frame);
 for(const target of ['.page-head','#works-list']){
  const prevented=await frame.locator(target).evaluate((el:Element)=>{
   const transfer=new DataTransfer();transfer.items.add(new File(['unwanted contents'],'missed.txt'));
   return ['dragover','drop'].map(type=>{const event=new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:transfer});el.dispatchEvent(event);return event.defaultPrevented;});
  });
  expect(prevented).toEqual([true,true]);
 }
 expect(await state(frame)).toEqual(before);await expect(frame.locator('#brief')).toHaveValue('Keep this draft when a file misses the composer.');expect(orkas.modelRequests).toHaveLength(0);await orkas.closePreview(preview);
});
async function language(orkas:any,frame:any,locale:string){await orkas.page.evaluate((locale:string)=>(window as any).setLang(locale),locale);await frame.locator('body').evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(frame.locator('html')).toHaveAttribute('lang',locale);}
async function drop(frame:any,name:string,base64:string){
 await frame.locator('#brief').evaluate((el:any,{name,base64}:any)=>{const transfer=new DataTransfer();transfer.items.add(new File([Uint8Array.from(atob(base64),c=>c.charCodeAt(0))],name));el.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));},{name,base64});
 await expect(frame.locator('#selected-assets')).toContainText(name);await expect(frame.locator('#add-material')).toBeEnabled();
}
async function seedHistory(frame:any,corrupt=false){
 return frame.locator('body').evaluate(async(_el:any,{png,corrupt}:any)=>{
  const w=window as any,api=w.orkasApp,m=w.ContentModel,index=m.readIndex(null),asset=m.asset({id:'source',name:'source.png',path:'media/source.png',bytes:Uint8Array.from(atob(png),c=>c.charCodeAt(0)).length});
  await api.appFiles.writeBase64({path:asset.path,base64:png,scope:'cloud'});index.assets=[asset];
  for(const id of ['first','second']){const record={...m.draft('image','zh'),id,title:id==='first'?'Preserved first record':'Preserved second record',brief:'Keep this authored request.',assetIds:['source'],createdAt:'2026-11-12T00:00:00.000Z',updatedAt:'2026-11-12T00:00:00.000Z'};await api.appFiles.writeText({path:'works/'+id+'.json',text:JSON.stringify(record),scope:'cloud'});index.works.push({id,title:record.title,kind:'image',status:'',assetIds:corrupt?'not-an-array':['source'],resultAssetIds:[],updatedAt:record.updatedAt});}
  await api.storage.set({key:'content-index-v1',value:index,scope:'cloud'});return index;
 },{png,corrupt});
}
test('disables record editing while a material import owns the composer, then makes editing available again',async({modelOrkas:orkas})=>{
 let{preview,frame}=await open(orkas);await seedHistory(frame);await orkas.closePreview(preview);({preview,frame}=await open(orkas));
 await orkas.electronApp.evaluate(()=>{
  const seam=(globalThis as any).__contentReview,runtime=seam.runtime,original=runtime.execute,gate:any={triggered:false,release:()=>{},restore:()=>{runtime.execute=original;}};
  runtime.execute=async function(...args:any[]){if(args[1]==='appFiles.writeBase64'&&args[2].path.startsWith('media/')&&!gate.triggered){gate.triggered=true;await new Promise(resolve=>{gate.release=resolve;});}return original.apply(this,args);};seam.importGate=gate;
 });
 try{
  await frame.locator('#brief').evaluate((el:Element,png:string)=>{const transfer=new DataTransfer();transfer.items.add(new File([Uint8Array.from(atob(png),c=>c.charCodeAt(0))],'pending.png'));el.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));},png);
  await expect.poll(()=>orkas.electronApp.evaluate(()=>(globalThis as any).__contentReview.importGate.triggered)).toBe(true);
  await frame.locator('.history-row').first().hover();await frame.locator('.history-menu-trigger').first().click();await expect(frame.locator('#record-menu').getByRole('menuitem',{name:'编辑',exact:true})).toBeDisabled();await frame.locator('#record-menu').press('Escape');
 }finally{await orkas.electronApp.evaluate(()=>{const g=(globalThis as any).__contentReview.importGate;g.release();g.restore();});}
 await expect(frame.locator('#add-material')).toBeEnabled();await expect(frame.locator('#selected-assets')).toContainText('pending.png');
 await frame.locator('.history-row').first().hover();await frame.locator('.history-menu-trigger').first().click();await expect(frame.locator('#record-menu').getByRole('menuitem',{name:'编辑',exact:true})).toBeEnabled();expect(orkas.modelRequests).toHaveLength(0);await orkas.closePreview(preview);
});
async function fault(orkas:any,mode:string){
 await orkas.electronApp.evaluate((_electron:any,mode:string)=>{
  const seam=(globalThis as any).__contentReview,runtime=seam.runtime,original=runtime.execute;
  const control={triggered:false,failures:0,starts:0,writes:0,restore:()=>{runtime.execute=original;}};seam.control=control;
  runtime.execute=async function(...args:any[]){
   const method=args[1],payload=args[2];if(method==='tasks.start')control.starts++;
   if(['storage.set','appFiles.writeText','appFiles.writeBase64','appFiles.remove'].includes(method))control.writes++;
   const blocked=mode==='draft'&&method==='storage.set'||mode==='work'&&method==='appFiles.writeText'&&payload.path.startsWith('works/')&&JSON.parse(payload.text).jobs[0]?.status==='submitting'||['index','rollback'].includes(mode)&&method==='storage.set'&&payload.value?.works?.some((r:any)=>r.status==='submitting')||mode==='rollback'&&control.failures===1&&method==='appFiles.writeText'&&payload.path.startsWith('works/')&&!JSON.parse(payload.text).jobs.length;
   if(blocked&&control.failures<(mode==='rollback'?2:1)){control.triggered=true;control.failures++;throw new seam.AppError('E_FAILED');}
   const reply=await original.apply(this,args);
   if(mode==='uncertain'&&method==='tasks.start'&&!control.triggered){control.triggered=true;throw new seam.AppError('E_TASK_UNCERTAIN');}
   return reply;
  };
 },mode);
}
test.afterEach(async({modelOrkas:orkas})=>{await orkas.electronApp?.evaluate(()=>(globalThis as any).__contentReview?.control?.restore());});

test('uses single-record Delete confirmation across languages and preserves input and source files on cancel and delete',async({modelOrkas:orkas},info)=>{
 let{preview,frame}=await open(orkas);await seedHistory(frame);await orkas.closePreview(preview);({preview,frame}=await open(orkas));await frame.locator('#brief').fill('Keep this next draft.');
 for(const [locale,label,body]of [['zh','删除','删除这条记录？原始素材和结果文件会保留。'],['en','Delete','Delete this record? Source and result files are kept.'],['ar','حذف','هل تريد حذف هذا السجل؟ تبقى الملفات الأصلية والنتائج محفوظة.']]){
  await language(orkas,frame,locale);const row=frame.locator('.history-row[data-id="first"]');await row.hover();await row.locator('.history-menu-trigger').click();await frame.locator('#record-menu').getByRole('menuitem',{name:label,exact:true}).click();
  await expect(frame.locator('#confirm-title')).toHaveText(label);await expect(frame.locator('#confirm [value="confirm"]')).toHaveText(label);await expect(frame.locator('#confirm-text')).toHaveText('Preserved first record\n'+body);
  await preview.setViewportSize({width:400,height:650});await preview.emulateMedia({colorScheme:'dark'});await preview.screenshot({animations:'disabled',path:info.outputPath('delete-'+locale+'-narrow-dark.png')});
  await frame.locator('#confirm').press('Escape');expect((await state(frame)).works).toHaveLength(2);await expect(frame.locator('#brief')).toHaveValue('Keep this next draft.');
 }
 await language(orkas,frame,'zh');const row=frame.locator('.history-row[data-id="first"]');await row.hover();await row.locator('.history-menu-trigger').click();await frame.locator('#record-menu').getByRole('menuitem',{name:'删除',exact:true}).click();await frame.locator('#confirm [value="confirm"]').click();await expect(frame.locator('.history-row')).toHaveCount(1);await expect(frame.locator('#brief')).toHaveValue('Keep this next draft.');
 expect(await frame.locator('body').evaluate(async()=>((await(window as any).orkasApp.appFiles.readBase64({path:'media/source.png',scope:'cloud'})).base64))).toBe(png);expect(orkas.modelRequests).toHaveLength(0);await orkas.closePreview(preview);
});

for(const [kind,mode]of [['image','work'],['video','index'],['audio','work']])test('recovers '+kind+' input after pre-dispatch '+mode+' persistence fails without admitting a task',async({modelOrkas:orkas})=>{
 const{preview,frame}=await open(orkas);await frame.locator('#nav-'+kind).click();await frame.locator('#brief').fill('Preserve my exact instructions.');await drop(frame,'source.png',png);await expect.poll(async()=>(await state(frame)).drafts?.[kind]?.assetIds.length).toBe(1);await fault(orkas,mode);await frame.locator('#submit').click();await expect(frame.locator('#notice')).toHaveClass(/error/);
 await expect(frame.locator('#brief')).toBeEnabled();await expect(frame.locator('#brief')).toHaveValue('Preserve my exact instructions.');await expect(frame.locator('#selected-assets')).toContainText('source.png');await expect(frame.locator('#submit')).toBeEnabled();expect(orkas.modelRequests).toHaveLength(0);
 const before=await state(frame);expect(before.works).toHaveLength(1);expect(before.works[0].status).toBe('');const saved=await frame.locator('body').evaluate(async(_el:any,id:string)=>JSON.parse((await(window as any).orkasApp.appFiles.readText({path:'works/'+id+'.json',scope:'cloud'})).text),before.works[0].id);expect(saved.jobs).toEqual([]);
 await stageResult(orkas,kind);orkas.setModelTextReplies(['Controlled completion.']);await frame.locator('#submit').click();await expect.poll(async()=>(await state(frame)).works[0]?.status,{timeout:30000}).toBe('completed');await expect(frame.locator('#notice')).toBeEmpty();expect(orkas.modelRequests).toHaveLength(1);expect(await orkas.electronApp.evaluate(()=>(globalThis as any).__contentReview.control.starts)).toBe(1);expect((await state(frame)).works).toHaveLength(1);await orkas.closePreview(preview);
});

test('keeps a lost admission reply distinct from a pre-dispatch failure without replaying the task',async({modelOrkas:orkas})=>{
 const{preview,frame}=await open(orkas);await frame.locator('#brief').fill('One controlled creation.');await stageResult(orkas);orkas.setModelTextReplies(['Controlled result.']);await fault(orkas,'uncertain');await frame.locator('#submit').click();await expect.poll(async()=>(await state(frame)).works[0]?.status,{timeout:30000}).toBe('completed');expect(orkas.modelRequests).toHaveLength(1);expect(await orkas.electronApp.evaluate(()=>(globalThis as any).__contentReview.control.starts)).toBe(1);await expect(frame.locator('#brief')).toBeEmpty();await orkas.closePreview(preview);
});

test('retains an explicitly retryable input when pending-job persistence and rollback both fail',async({modelOrkas:orkas})=>{
 const{preview,frame}=await open(orkas);await frame.locator('#brief').fill('Preserve this request through two write failures.');await drop(frame,'source.png',png);await fault(orkas,'rollback');await frame.locator('#submit').click();await expect(frame.locator('#notice')).toHaveClass(/error/);await expect(frame.locator('#brief')).toBeEnabled();await expect(frame.locator('#selected-assets')).toContainText('source.png');expect(await orkas.electronApp.evaluate(()=>(globalThis as any).__contentReview.control.failures)).toBe(2);expect(orkas.modelRequests).toHaveLength(0);
 await frame.locator('#brief').fill('Recovered after two write failures.');const id=(await state(frame)).works[0].id;await expect.poll(()=>frame.locator('body').evaluate(async(_el:any,id:string)=>JSON.parse((await(window as any).orkasApp.appFiles.readText({path:'works/'+id+'.json',scope:'cloud'})).text).jobs,id)).toEqual([]);
 await stageResult(orkas);orkas.setModelTextReplies(['Controlled result.']);await frame.locator('#submit').click();await expect.poll(async()=>(await state(frame)).works[0]?.status,{timeout:30000}).toBe('completed');await expect(frame.locator('#notice')).toBeEmpty();expect(orkas.modelRequests).toHaveLength(1);expect(await orkas.electronApp.evaluate(()=>(globalThis as any).__contentReview.control.starts)).toBe(1);await orkas.closePreview(preview);
});

test('clears a recovered autosave warning only after the edited draft is durable and preserves it on reopen',async({modelOrkas:orkas})=>{
 let{preview,frame}=await open(orkas);await fault(orkas,'draft');await frame.locator('#brief').fill('First unsaved revision.');await expect(frame.locator('#notice')).toHaveText('未保存，请保留窗口并重试。');await frame.locator('#brief').fill('Recovered durable revision.');await expect.poll(async()=>(await state(frame))?.drafts?.image?.brief).toBe('Recovered durable revision.');await expect(frame.locator('#notice')).toBeEmpty();await expect(frame.locator('#save-state')).toHaveText('已保存');await language(orkas,frame,'en');await expect(frame.locator('#notice')).toBeEmpty();await orkas.closePreview(preview);({preview,frame}=await open(orkas));await expect(frame.locator('#brief')).toHaveValue('Recovered durable revision.');expect(orkas.modelRequests).toHaveLength(0);await orkas.closePreview(preview);
});

test('imports and previews a self-contained SVG with a bounded thumbnail and no change to the authored request',async({modelOrkas:orkas},info)=>{
 let{preview,frame}=await open(orkas);const svg='<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80"><rect width="160" height="80" fill="#5b57d6"/></svg>',base64=Buffer.from(svg).toString('base64');await frame.locator('#brief').fill('Keep the product shape.');await drop(frame,'product.svg',base64);await expect.poll(async()=>!!(await state(frame)).assets[0]?.thumbnailPath).toBe(true);const asset=(await state(frame)).assets[0];expect(asset.thumbnailPath).toMatch(/^thumbnails\/.+\.jpg$/);
 await frame.locator('.attachment-preview').click();await expect.poll(()=>frame.locator('#media-content img').evaluate((img:HTMLImageElement)=>img.naturalWidth)).toBe(160);await preview.screenshot({animations:'disabled',path:info.outputPath('svg-preview.png')});await frame.locator('#media-close').click();await expect(frame.locator('#brief')).toHaveValue('Keep the product shape.');
 const stored=await frame.locator('body').evaluate(async(_el:any,asset:any)=>{const api=(window as any).orkasApp;return{source:(await api.appFiles.readBase64({path:asset.path,scope:'cloud'})).base64,thumbnail:(await api.appFiles.readBase64({path:asset.thumbnailPath,scope:'cloud'})).base64.length};},asset);expect(stored.source).toBe(base64);expect(stored.thumbnail).toBeLessThanOrEqual(32768);await orkas.closePreview(preview);({preview,frame}=await open(orkas));await expect(frame.locator('#selected-assets .chat-attach-thumb')).toHaveCount(1);expect(orkas.modelRequests).toHaveLength(0);await orkas.closePreview(preview);
});

test('rejects malformed saved history without rewriting it or enabling destructive actions, then reopens corrected data',async({modelOrkas:orkas},info)=>{
 let{preview,frame}=await open(orkas);const original=await seedHistory(frame,true);await orkas.closePreview(preview);await fault(orkas,'observe');({preview,frame}=await open(orkas,false));await expect(frame.locator('#notice')).toHaveText('暂时无法读取历史记录。关闭后重新打开再试，已有数据未被重置。');await expect(frame.locator('#brief')).toBeDisabled();await expect(frame.locator('#reset-work')).toBeDisabled();await expect(frame.locator('#submit')).toBeDisabled();expect(await state(frame)).toEqual(original);expect(await orkas.electronApp.evaluate(()=>(globalThis as any).__contentReview.control.writes)).toBe(0);await preview.screenshot({animations:'disabled',path:info.outputPath('malformed-history-recovery.png')});
 await frame.locator('body').evaluate(async()=>{const api=(window as any).orkasApp,index=(await api.storage.get({key:'content-index-v1',scope:'cloud'})).value;for(const row of index.works)row.assetIds=['source'];await api.storage.set({key:'content-index-v1',value:index,scope:'cloud'});});await orkas.closePreview(preview);({preview,frame}=await open(orkas));await expect(frame.locator('.history-row')).toHaveCount(2);await expect(frame.locator('#notice')).toBeEmpty();expect(orkas.modelRequests).toHaveLength(0);await orkas.closePreview(preview);
});

test('keeps a long text preview readable with the shared Close icon and reachable actions in narrow dark RTL layouts',async({modelOrkas:orkas},info)=>{
 const{preview,frame}=await open(orkas);const name='Product campaign '.repeat(4).trim(),brief='Keep the product shape and label.\n'.repeat(80)+'<script>window.previewExecuted=true</script>';
 await frame.locator('#nav-library').click();await frame.locator('#add-prompt').click();await frame.locator('#library-name').fill(name);await frame.locator('#library-brief').fill(brief);await frame.locator('#library-save').click();await expect(frame.locator('#library-editor')).toBeHidden();
 for(const [locale,scheme,width]of [['zh','light',1000],['en','dark',400],['ar','dark',400]] as const){
  await language(orkas,frame,locale);await preview.setViewportSize({width:Number(width),height:650});await preview.emulateMedia({colorScheme:scheme,reducedMotion:'reduce'});await frame.locator('.library-preview').click();
  expect(await frame.locator('#library-detail-use').evaluate(el=>getComputedStyle(el).transitionDuration)).toBe('0s');await expect(frame.locator('#library-detail-close svg')).toHaveCount(1);await expect(frame.locator('#library-detail-close')).toHaveText('');await expect(frame.locator('#library-detail-brief')).toHaveText(brief);expect(await frame.locator('body').evaluate(()=>(window as any).previewExecuted)).toBeUndefined();
  const bounds=await frame.locator('#library-detail').evaluate((dialog:HTMLDialogElement)=>({viewport:innerWidth,items:[dialog,...dialog.querySelectorAll('button')].map(el=>{const r=el.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom};}),scroll:document.documentElement.scrollWidth}));expect(bounds.scroll).toBeLessThanOrEqual(bounds.viewport);for(const b of bounds.items){expect(b.left).toBeGreaterThanOrEqual(0);expect(b.right).toBeLessThanOrEqual(bounds.viewport);expect(b.top).toBeGreaterThanOrEqual(0);expect(b.bottom).toBeLessThanOrEqual(650);}
  await preview.screenshot({animations:'disabled',path:info.outputPath('text-preview-'+locale+'-'+scheme+'.png')});await frame.locator('#library-detail').press('Escape');await expect(frame.locator('.library-preview')).toBeFocused();
 }
 expect(orkas.modelRequests).toHaveLength(0);await orkas.closePreview(preview);
});
