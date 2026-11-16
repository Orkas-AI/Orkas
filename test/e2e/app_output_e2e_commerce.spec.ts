import path from 'node:path';
import { openSidebarEntry, expect, test } from './fixtures/orkas';
test.setTimeout(90000);

// Use explicit local profiles in the public edition; no media request may escape this fixture.
test.beforeEach(async({modelOrkas:orkas})=>{
 await orkas.electronApp!.evaluate((_electron:any,root:string)=>{
  const load=(process as any).mainModule.require.bind((process as any).mainModule),auth=load(root+'/features/auth.ts');
  auth.saveImageProfiles([{id:'content-test-image',provider:'openai',model:'gpt-image-2',apiKey:'fixture-unused-image-key',label:'Local image service',createdAt:1}]);
  const image=load(root+'/features/image_gen.ts'),video=load(root+'/features/video_gen.ts'),tts=load(root+'/features/tts.ts'),originals=[image.generateImage,video.generateVideo,tts.generateSpeech];
  const fixture={calls:0,restore:()=>{[image.generateImage,video.generateVideo,tts.generateSpeech]=originals;}};
  (globalThis as any).__commerceOutputMedia=fixture;
  image.generateImage=video.generateVideo=tts.generateSpeech=async()=>{fixture.calls++;throw Error('Unexpected external media generation in the controlled output fixture');};
 },path.resolve(__dirname,'../../src/main'));
});
test.afterEach(async({modelOrkas:orkas})=>{
 const calls=await orkas.electronApp?.evaluate(()=>{const fixture=(globalThis as any).__commerceOutputMedia;if(!fixture)return null;fixture.restore();return fixture.calls;});
 expect(calls).toBe(0);
});

test('saves a Commerce direct text answer even when the run also writes a non-media source file',async({modelOrkas:orkas})=>{
 await orkas.page.evaluate(()=>(window as any).setLang('zh'));await openSidebarEntry(orkas.page,'#apps-btn');
 await orkas.electronApp.evaluate((_electron:any,args:any)=>{const load=(process as any).mainModule.require.bind((process as any).mainModule),service=load(args.host).taskService,workspace=load(args.workspace),fs=load('node:fs'),path=load('node:path'),original=service.deps.send;service.deps.send=async function(uid:string,cid:string,...rest:any[]){service.deps.send=original;const dir=await workspace.getConversationWorkspacePath(uid,cid);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'helper.py'),'# Copy preparation');return original.call(this,uid,cid,...rest);};},{host:path.resolve(__dirname,'../../src/main/features/web_apps/task-host.ts'),workspace:path.resolve(__dirname,'../../src/main/features/group_chat/conv_workspace.ts')});
 const preview=await orkas.openPreview(()=>orkas.page.locator('.app-card[data-app-id="builtin-product-listing"]').click()),outer=preview.frameLocator('.saved-app-viewer-frame');await outer.locator('button[data-view="creative"]').click();const frame=outer.frameLocator('#media-workspace'),text='A concise synthetic product description.';await frame.locator('#brief').fill('Write the product description.');orkas.setModelTextReplies([text]);await frame.locator('#submit').click();
 await expect.poll(()=>frame.locator('body').evaluate(async()=>{const api=(window as any).orkasApp,index=(await api.storage.get({key:'content-index-v1',scope:'cloud'})).value;if(!index?.works?.length)return[];const w=JSON.parse((await api.appFiles.readText({path:'works/'+index.works[0].id+'.json',scope:'cloud'})).text);return w.results.map((r:any)=>index.assets.find((a:any)=>a.id===r.assetId)?.name).sort();})).toEqual(['helper.py','reply.txt']);
 const actual=await frame.locator('body').evaluate(async()=>{const api=(window as any).orkasApp,index=(await api.storage.get({key:'content-index-v1',scope:'cloud'})).value;return(await api.appFiles.readText({path:index.assets.find((a:any)=>a.name==='reply.txt').path,scope:'cloud'})).text;});expect(actual).toBe(text);expect(orkas.modelRequests).toHaveLength(1);await orkas.closePreview(preview);
});
for(const appId of ['builtin-content-workbench','builtin-product-listing'])test('shows an honest unverified-output failure in '+appId+' without replacing the original reply',async({modelOrkas:orkas},info)=>{
 await orkas.page.evaluate(()=>(window as any).setLang('zh'));await openSidebarEntry(orkas.page,'#apps-btn');
 await orkas.electronApp.evaluate((_electron:any,args:any)=>{
  const load=(process as any).mainModule.require.bind((process as any).mainModule),service=load(args.host).taskService,original=service.deps.archive,send=service.deps.send;
  service.deps.send=async function(uid:string,cid:string,...rest:any[]){service.deps.send=send;const fs=load('node:fs'),path=load('node:path'),dir=await load(args.workspace).getConversationWorkspacePath(uid,cid);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'receipt.json'),'{"partial":true}');fs.writeFileSync(path.join(dir,'composition.html'),'<html>Partial composition</html>');return send.call(this,uid,cid,...rest);};
  service.deps.archive=async function(...args:any[]){const result=await original.apply(this,args);return{...result,status:'failed',error:{code:'E_OUTPUT_UNVERIFIED'}};};
 },{host:path.resolve(__dirname,'../../src/main/features/web_apps/task-host.ts'),workspace:path.resolve(__dirname,'../../src/main/features/group_chat/conv_workspace.ts')});
 const card=orkas.page.locator('.app-card[data-app-id="'+appId+'"]');let preview=await orkas.openPreview(()=>card.click()),frame:any=preview.frameLocator('.saved-app-viewer-frame');
 if(appId==='builtin-product-listing'){await frame.locator('button[data-view="creative"]').click();frame=frame.frameLocator('#media-workspace');}
 const claimed='The requested result is complete.';await frame.locator('#brief').fill('Create a synthetic result.');orkas.setModelTextReplies([claimed]);await frame.locator('#submit').click();
 await expect(frame.locator('.record-failure-summary').first()).toHaveText('操作未完成，已保存的内容会保留。');
 const saved=await frame.locator('body').evaluate(async()=>{const api=(window as any).orkasApp,index=(await api.storage.get({key:'content-index-v1',scope:'cloud'})).value;return JSON.parse((await api.appFiles.readText({path:'works/'+index.works[0].id+'.json',scope:'cloud'})).text);});
 expect(saved.jobs[0]).toMatchObject({status:'failed',errorCode:'E_OUTPUT_UNVERIFIED',text:claimed});expect(orkas.modelRequests).toHaveLength(1);
 await expect.poll(()=>frame.locator('body').evaluate(async()=>{const api=(window as any).orkasApp,state=(await api.storage.get({key:'content-index-v1',scope:'cloud'})).value;return state.works[0].resultAssetIds.length;})).toBe(2);await frame.locator('.record-summary').click();await expect(frame.locator('.result-file:visible')).toHaveCount(0);await expect(frame.locator('.result-tools summary')).toHaveText('更多文件 · 2');await frame.locator('.result-tools summary').click();await expect(frame.locator('#record-detail')).toBeVisible();await expect(frame.locator('.result-file:visible')).toHaveCount(2);await frame.locator('.result-file').filter({hasText:'receipt.json'}).locator('.attachment-preview').click();await expect(frame.locator('#media-content pre')).toHaveText('{"partial":true}');await frame.locator('#media-close').click();
 await preview.screenshot({path:info.outputPath('unverified-output-zh.png')});await orkas.closePreview(preview);
 preview=await orkas.openPreview(()=>card.click());frame=preview.frameLocator('.saved-app-viewer-frame');if(appId==='builtin-product-listing'){await frame.locator('button[data-view="creative"]').click();frame=frame.frameLocator('#media-workspace');}
 await expect(frame.locator('.record-failure-summary').first()).toHaveText('操作未完成，已保存的内容会保留。');
 await orkas.page.evaluate(()=>(window as any).setLang('en'));await frame.locator('body').evaluate(()=>window.dispatchEvent(new Event('focus')));
 await expect(frame.locator('.record-failure-summary').first()).toHaveText('Could not complete this action. Your saved content is retained.');
 await preview.setViewportSize({width:400,height:650});await preview.screenshot({path:info.outputPath('unverified-output-en-narrow.png')});expect(orkas.modelRequests).toHaveLength(1);await orkas.closePreview(preview);
});
const png='iVBORw0KGgoAAAANSUhEUgAAAAQAAAAFCAYAAABirU3bAAAAEklEQVR4nGMISNnyHxkzUEEAAOMaMA0yqcWAAAAAAElFTkSuQmCC';

test('treats image proportions as guidance in composed Commerce and keeps results after reopen', async ({modelOrkas:orkas},info) => {
 await orkas.page.evaluate(()=>(window as any).setLang('zh'));await openSidebarEntry(orkas.page,'#apps-btn');
 await orkas.electronApp.evaluate((_electron:any,args:any)=>{
  const load=(process as any).mainModule.require.bind((process as any).mainModule);
  (globalThis as any).__commerceOutputParameters={service:load(args.host).taskService,workspace:load(args.workspace),fs:load('node:fs'),path:load('node:path')};
 },{host:path.resolve(__dirname,'../../src/main/features/web_apps/task-host.ts'),workspace:path.resolve(__dirname,'../../src/main/features/group_chat/conv_workspace.ts')});
 const card=orkas.page.locator('.app-card[data-app-id="builtin-product-listing"]');
 let preview=await orkas.openPreview(()=>card.click()),frame=preview.frameLocator('.saved-app-viewer-frame');await frame.locator('button[data-view="creative"]').click();
 let creator=frame.frameLocator('#media-workspace');await expect(creator.locator('#brief')).toBeEnabled();await creator.locator('#nav-image').click();
 const state=()=>creator.locator('body').evaluate(async()=>((await(window as any).orkasApp.storage.get({key:'content-index-v1',scope:'cloud'})).value));
 let expectedWorks=0;for(const [aspect,status]of [['4:5','completed'],['16:9','completed']]){
  await creator.locator('#aspect-trigger').click();await creator.locator('#aspect-listbox [data-value="'+aspect+'"]').click();await creator.locator('#brief').fill('Create a synthetic product image.');
  await orkas.electronApp.evaluate((_electron:any,base64:string)=>{
   const {service,workspace,fs,path}=(globalThis as any).__commerceOutputParameters,original=service.deps.send;
   service.deps.send=async function(uid:string,cid:string,...args:any[]){service.deps.send=original;const dir=await workspace.getConversationWorkspacePath(uid,cid);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'result.png'),Buffer.from(base64,'base64'));return original.call(this,uid,cid,...args);};
  },png);
  orkas.setModelTextReplies(['Controlled image completion.']);await creator.locator('#submit').click();await expect.poll(async()=>(await state())?.works.length).toBe(++expectedWorks);await expect.poll(async()=>(await state())?.works[0]?.status,{timeout:30000}).toBe(status);
 }
 await expect(creator.locator('.record-failure-summary:visible')).toHaveCount(0);expect((await state()).works).toHaveLength(2);expect(orkas.modelRequests).toHaveLength(2);
 await preview.screenshot({path:info.outputPath('commerce-parameter-guidance-zh.png')});await orkas.closePreview(preview);
 preview=await orkas.openPreview(()=>card.click());frame=preview.frameLocator('.saved-app-viewer-frame');await frame.locator('button[data-view="creative"]').click();creator=frame.frameLocator('#media-workspace');await creator.locator('#nav-image').click();
 await expect(creator.locator('.record-failure-summary:visible')).toHaveCount(0);expect((await state()).works).toHaveLength(2);expect(orkas.modelRequests).toHaveLength(2);await orkas.closePreview(preview);
});


for(const appId of ['builtin-content-workbench','builtin-product-listing'])test('folds additional files without losing previews, saved materials or restored records in '+appId,async({modelOrkas:orkas},info)=>{
 await orkas.page.evaluate(()=>(window as any).setLang('zh'));await openSidebarEntry(orkas.page,'#apps-btn');
 const card=orkas.page.locator('.app-card[data-app-id="'+appId+'"]');let preview=await orkas.openPreview(()=>card.click()),frame:any=preview.frameLocator('.saved-app-viewer-frame');
 if(appId==='builtin-product-listing'){await frame.locator('button[data-view="creative"]').click();frame=frame.frameLocator('#media-workspace');}
 await frame.locator('#nav-image').click();await expect(frame.locator('#brief')).toBeEnabled();await frame.locator('#format-trigger').click();await frame.locator('#format-listbox [data-value="any"]').click();
 const files=[{name:'final.svg',content:'<svg xmlns="http://www.w3.org/2000/svg" width="400" height="500"><rect width="400" height="500" fill="royalblue"/></svg>'},{name:'caption.txt',content:'Final companion copy.'},{name:'intermediate.svg',content:'<svg xmlns="http://www.w3.org/2000/svg" width="400" height="500"/>'},{name:'receipt.json',content:'{"internal":true}'},{name:'project.html',content:'<html>Composition source</html>'},{name:'README',content:'Supporting notes.'}];let step=0;
 orkas.setModelRequestScript((_request,tools)=>{
  if(!tools.has('write_file'))return{calls:[{callId:'load-output',name:'tool_load',args:{groups:['workspace.write.output']}}]};
  if(step++===0)return{calls:files.map((file,i)=>({callId:'write-'+i,name:'write_file',args:{path:file.name,content:file.content}}))};
  if(step===2)return{calls:[{callId:'publish-final',name:'publish_outputs',args:{paths:['final.svg','caption.txt']}}]};
  return{text:'Synthetic final delivery.'};
 });
 const brief='Create a synthetic final image and its companion copy.\n'+('Preserve every product detail and keep the text readable. '.repeat(12))+'\nEnd of the original request.';await frame.locator('#brief').fill(brief);await frame.locator('#submit').click();
 const state=()=>frame.locator('body').evaluate(async()=>((await(window as any).orkasApp.storage.get({key:'content-index-v1',scope:'cloud'})).value));
 await expect.poll(async()=>(await state())?.works[0]?.status,{timeout:60000}).toBe('completed');await expect.poll(async()=>(await state())?.works[0]?.resultAssetIds.length,{timeout:30000}).toBe(6);
 await frame.locator('.record-summary').click();await expect(frame.locator('.result-file:visible')).toHaveCount(2);await expect(frame.locator('.record-summary')).toHaveText(brief);await expect(frame.locator('.history-row').getByText(brief,{exact:true})).toHaveCount(1);expect(await frame.locator('.result-file:visible').first().evaluate((el:HTMLElement)=>el.getBoundingClientRect().height)).toBeLessThanOrEqual(36);await expect(frame.locator('#output-list')).toHaveAccessibleName('生成结果');await expect(frame.locator('.record-result-count')).toContainText('6');await expect(frame.locator('.result-tools summary')).toHaveText('更多文件 · 4');await expect(frame.locator('.result-tools')).not.toHaveAttribute('open','');await frame.locator('.result-tools summary').scrollIntoViewIfNeeded();await frame.locator('.history-row').screenshot({path:info.outputPath('more-files-collapsed-zh.png')});
 for(const name of ['final.svg','caption.txt'])await expect(frame.locator('.result-file').filter({hasText:name})).toBeVisible();
 for(const name of ['intermediate.svg','receipt.json','project.html','README'])await expect(frame.locator('.result-file').filter({hasText:name})).not.toBeVisible();
 await frame.locator('.result-tools summary').focus();await frame.locator('.result-tools summary').press('Enter');await expect(frame.locator('#record-detail')).toBeVisible();await expect(frame.locator('.result-file:visible')).toHaveCount(6);await expect(frame.locator('.result-tools .result-file')).toHaveCount(4);await frame.locator('.history-row').hover();await frame.locator('.history-menu-trigger').click();await frame.locator('#record-menu').getByRole('menuitem',{name:'刷新',exact:true}).click();await expect(frame.locator('.result-tools')).toHaveAttribute('open','');
 const receipt=frame.locator('.result-file').filter({hasText:'receipt.json'});await receipt.locator('.attachment-preview').click();await expect(frame.locator('#media-content pre')).toHaveText('{"internal":true}');await frame.locator('#media-close').click();await expect(frame.locator('.result-tools')).toHaveAttribute('open','');await frame.locator('.result-tools').scrollIntoViewIfNeeded();await frame.locator('.history-row').screenshot({path:info.outputPath('more-files-expanded-zh.png')});await frame.locator('.result-tools summary').click();await expect(frame.locator('.result-file:visible')).toHaveCount(2);await expect(frame.locator('#record-detail')).toBeVisible();await frame.locator('.result-tools summary').click();await expect(frame.locator('.result-file:visible')).toHaveCount(6);
 // The host must keep supporting bytes after execution-context cleanup, without registering them as library cards.
 const archived=await orkas.electronApp.evaluate((_electron:any,{appId,paths}:any)=>{const load=(process as any).mainModule.require.bind((process as any).mainModule),fs=load('node:fs'),path=load('node:path'),hash=(s:string)=>load('node:crypto').createHash('sha256').update(s).digest('hex'),root=load(paths).webAppSandboxRoot('account-e2e',hash(JSON.stringify(['saved',appId])),'cloud'),receiptFile=fs.readdirSync(path.join(root,'tasks')).find((name:string)=>name.endsWith('.json')),receipt=JSON.parse(fs.readFileSync(path.join(root,'tasks',receiptFile),'utf8'));return receipt.result.files.map((f:any)=>({name:f.name,published:f.published,exists:fs.existsSync(path.join(root,'files',f.path))}));},{appId,paths:path.resolve(__dirname,'../../src/main/paths.ts')});
 expect(archived).toHaveLength(6);for(const f of archived){expect(f.exists).toBe(true);expect(f.published).toBe(['final.svg','caption.txt'].includes(f.name));}
 const selected=frame.locator('.result-file').filter({hasText:'receipt.json'});await selected.hover();await selected.locator('.result-menu-trigger').click();await frame.locator('#record-menu').getByRole('menuitem',{name:'保存为素材',exact:true}).click();await expect(selected.locator('.save-feedback')).toBeVisible();
 await frame.locator('#nav-library').click();await expect(frame.locator('.library-card')).toHaveCount(1);await expect(frame.locator('.library-card')).toContainText('receipt.json');await preview.screenshot({path:info.outputPath('single-saved-material-zh.png')});await orkas.closePreview(preview);
 preview=await orkas.openPreview(()=>card.click());frame=preview.frameLocator('.saved-app-viewer-frame');if(appId==='builtin-product-listing'){await frame.locator('button[data-view="creative"]').click();frame=frame.frameLocator('#media-workspace');}await frame.locator('#nav-image').click();await expect(frame.locator('#brief')).toBeEnabled();await expect(frame.locator('.record-result-count')).toContainText('6');await frame.locator('.record-summary').click();await expect(frame.locator('.result-file:visible')).toHaveCount(2);await expect(frame.locator('.result-tools')).not.toHaveAttribute('open','');await frame.locator('.result-tools summary').click();await expect(frame.locator('.result-file:visible')).toHaveCount(6);
 await orkas.page.evaluate(()=>(window as any).setLang('en'));await frame.locator('body').evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(frame.locator('html')).toHaveAttribute('lang','en');await expect(frame.locator('.result-tools')).toHaveAttribute('open','');await expect(frame.locator('.result-tools summary')).toHaveText('More files · 4');await preview.setViewportSize({width:400,height:700});expect(await frame.locator('body').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);await frame.locator('.result-tools summary').scrollIntoViewIfNeeded();await frame.locator('.history-row').screenshot({path:info.outputPath('final-deliverables-en-narrow.png')});await frame.locator('#nav-library').click();await expect(frame.locator('.library-card')).toHaveCount(1);await expect(frame.locator('.library-card')).toContainText('receipt.json');await orkas.closePreview(preview);
});
