import path from 'node:path';
import {openSidebarEntry,expect,test} from './fixtures/orkas';
test.setTimeout(90000);

async function open(orkas:any,services=false,appId='builtin-content-workbench',lang='zh'){
 await orkas.page.evaluate(lang=>(window as any).setLang(lang),lang);await openSidebarEntry(orkas.page,'#apps-btn');
 await orkas.electronApp.evaluate(async(_electron:any,{root,services}:any)=>{
  if((globalThis as any).__mediaChoiceFixture)return;
  const load=(process as any).mainModule.require.bind((process as any).mainModule),auth=load(root+'/features/auth.ts'),routes=load(root+'/features/app_media_route.ts'),host=load(root+'/features/web_apps/task-host.ts');
  const send=host.taskService.deps.send,runtime=load(root+'/features/web_apps/host.ts').runtime,execute=runtime.execute;
  const image=load(root+'/features/image_gen.ts'),video=load(root+'/features/video_gen.ts'),tts=load(root+'/features/tts.ts');
  const originals=[image.generateImage,video.generateVideo,tts.generateSpeech];
  const fixture:any={auth,routes,host,runtime,AppError:load(root+'/features/web_apps/runtime.ts').AppError,calls:[],mediaCalls:0,catalogFails:false,restore:()=>{host.taskService.deps.send=send;runtime.execute=execute;[image.generateImage,video.generateVideo,tts.generateSpeech]=originals;}};(globalThis as any).__mediaChoiceFixture=fixture;
  image.generateImage=video.generateVideo=tts.generateSpeech=async()=>{fixture.mediaCalls++;throw Error('Unexpected external media generation in public app fixture');};
  runtime.execute=async function(...args:any[]){if(fixture.catalogFails&&args[1]==='tasks.services'&&args[2].kind==='video')throw new fixture.AppError('E_FAILED');return execute.apply(this,args);};
  if(services){
   auth.saveImageProfiles([{id:'first-image',provider:'openai',model:'gpt-image-2',apiKey:'fixture-first',label:'商品图片',createdAt:1},{id:'second-image',provider:'openai',model:'gpt-image-2.5-flare',apiKey:'fixture-second',label:'海报',createdAt:2}]);
   auth.saveVideoProfiles([{id:'first-video',provider:'doubao',model:'doubao-seedance-2-0-260128',apiKey:'fixture-video',label:'自有视频',createdAt:1},{id:'second-video',provider:'minimax',model:'MiniMax-Hailuo-2.3',apiKey:'fixture-video-second',label:'第二视频',createdAt:2}]);
   auth.saveTtsProfiles([{id:'own-voice',provider:'openai',model:'tts-1',baseUrl:'https://speech.fixture/v1',apiKey:'fixture-voice',voice:'alloy',label:'旁白',createdAt:1}]);
   host.taskService.deps.send=async(...args:any[])=>{const result=await send(...args);fixture.calls.push({input:args[2],route:await routes.appTaskMediaRoute(args[0],args[1],args[2].media?.kind||'image')});return result;};
  }
 },{root:path.resolve(__dirname,'../../src/main'),services});
 const preview=await orkas.openPreview(()=>orkas.page.locator('.app-card[data-app-id="'+appId+'"]').click());let frame=preview.frameLocator('.saved-app-viewer-frame');if(appId==='builtin-product-listing'){await frame.locator('button[data-view="creative"]').click();frame=frame.frameLocator('#media-workspace');}await expect(frame.locator('#brief')).toBeEnabled();return{preview,frame};
}
async function state(frame:any){return frame.locator('body').evaluate(async()=>((await(window as any).orkasApp.storage.get({key:'content-index-v1',scope:'cloud'})).value));}
async function services(frame:any,kind:string){return frame.locator('body').evaluate(async(_el:any,kind:string)=>(window as any).orkasApp.tasks.services({kind}),kind);}
// Model identities and the configuration action share an AiSelect but have different contracts.
function serviceOptions(frame:any){return frame.locator('#service-listbox [role="option"]:not([data-value="configure-models"])');}
async function choose(frame:any,id:string){await frame.locator('#service-trigger').click();await frame.locator('[role="option"][data-value="'+id+'"]').click();}
// Both installed apps consume the generated Content controls, including Commerce's embedded copy.
for(const appId of ['builtin-content-workbench','builtin-product-listing'])test('anchors shared service menus in RTL and preserves keyboard selection in '+appId,async({modelOrkas:orkas},info)=>{
 for(const [lang,width]of [['ar',980],['zh',980],['en',400],['ar',400]]as const){
  const{preview,frame}=await open(orkas,true,appId,lang),images=(await services(frame,'image')).services;
  await frame.locator('#nav-image').click();await preview.setViewportSize({width,height:700});
  await expect(frame.locator('html')).toHaveAttribute('lang',lang);await expect(frame.locator('#refresh-services')).toBeEnabled();
  const trigger=frame.locator('#service-trigger'),menu=frame.locator('#service-listbox');await trigger.click();await expect(menu).toBeVisible();await expect(serviceOptions(frame)).toHaveCount(2);
  const bounds=await menu.evaluate((el:any)=>{const m=el.getBoundingClientRect(),t=document.querySelector('#service-trigger')!.getBoundingClientRect(),p=document.querySelector('.brief-panel')!.getBoundingClientRect();return{left:m.left,right:m.right,width:m.width,triggerLeft:t.left,triggerWidth:t.width,viewport:innerWidth,rootClientLeft:document.documentElement.clientLeft,rootClientWidth:document.documentElement.clientWidth,cssLeft:getComputedStyle(el).left,cssRight:getComputedStyle(el).right,panelLeft:p.left,panelRight:p.right};});
  await info.attach(`service-geometry-${lang}-${width}`,{body:JSON.stringify(bounds),contentType:'application/json'});
  if(width>440)expect(Math.abs(bounds.left-bounds.triggerLeft),'portaled menu stays on its trigger in both text directions').toBeLessThanOrEqual(1);
  expect(bounds.left).toBeGreaterThanOrEqual(0);expect(bounds.right).toBeLessThanOrEqual(bounds.viewport);expect(bounds.width).toBeGreaterThanOrEqual(bounds.triggerWidth);
  if(width<=440){expect(bounds.left,'narrow menus retain the composer inset').toBeGreaterThanOrEqual(bounds.panelLeft);expect(bounds.right,'narrow menus retain the composer inset').toBeLessThanOrEqual(bounds.panelRight);}
  await preview.screenshot({animations:'disabled',path:info.outputPath(`service-anchor-${lang}-${width}.png`)});
  await trigger.press('Escape');await expect(menu).toBeHidden();await trigger.press('Enter');await expect(menu).toBeVisible();await trigger.press('ArrowDown');await trigger.press('Enter');
  await expect(menu).toBeHidden();await expect(trigger).toContainText('海报');
  await choose(frame,images[0].id);await expect(trigger).toContainText('商品图片');await orkas.closePreview(preview);
 }
 expect(orkas.modelRequests).toHaveLength(0);
});

test('retries a failed video catalog after changing tabs without replacing the authored video draft',async({modelOrkas:orkas},info)=>{
 const{preview,frame}=await open(orkas,true);
 await orkas.electronApp.evaluate(()=>{
  (globalThis as any).__mediaChoiceFixture.catalogFails=true;
 });
 await frame.locator('#nav-video').click();await frame.locator('#brief').fill('Preserve these video instructions through catalog recovery.');await expect(frame.locator('#service-state')).toHaveText('无法读取服务列表，请重试。');
 await preview.screenshot({animations:'disabled',path:info.outputPath('video-catalog-unavailable-zh.png')});await frame.locator('#nav-image').click();await frame.locator('#brief').fill('Independent image instructions.');
 await orkas.electronApp.evaluate(()=>(globalThis as any).__mediaChoiceFixture.catalogFails=false);
 await frame.locator('#nav-video').click();await expect(frame.locator('#brief')).toHaveValue('Preserve these video instructions through catalog recovery.');await frame.locator('#refresh-services').click();await expect(frame.locator('#service-state')).toBeHidden();
 await frame.locator('#service-trigger').click();await expect(serviceOptions(frame)).toHaveCount(2);await expect(frame.locator('#service-listbox [data-value="configure-models"]')).toHaveCount(1);await expect(serviceOptions(frame).first()).toContainText('自有视频');await frame.locator('#service-trigger').press('Escape');
 await frame.locator('#nav-image').click();await expect(frame.locator('#brief')).toHaveValue('Independent image instructions.');expect(orkas.modelRequests).toHaveLength(0);await orkas.closePreview(preview);
});
test.afterEach(async({modelOrkas:orkas})=>{const calls=await orkas.electronApp?.evaluate(()=>{const f=(globalThis as any).__mediaChoiceFixture;if(!f)return 0;f.restore();return f.mediaCalls;});expect(calls).toBe(0);});

test('shows a real terminal failure in collapsed and expanded history after reopening without exposing provider diagnostics',async({modelOrkas:orkas},info)=>{
 let{preview,frame}=await open(orkas,true);orkas.setModelMode('auth-error');await frame.locator('#brief').fill('制作一张商品图片');await frame.locator('#submit').click();
 await expect.poll(async()=>(await state(frame))?.works[0]?.status,{timeout:60000}).toBe('failed');expect(orkas.modelRequests.length).toBeGreaterThan(0);const refusals=orkas.apiResponses.filter(r=>r.method==='POST'&&r.path==='/api/v1/chat/completions'&&r.status===401);expect(refusals).toHaveLength(1);orkas.expectApiFailure('POST','/api/v1/chat/completions',401);const row=frame.locator('.history-row').first();await expect(row.locator('.record-failure-summary')).not.toBeEmpty();await expect(row.locator('.record-failure-summary')).not.toContainText('sk-e2e-private-secret');await expect(row.locator('.record-failure-summary')).not.toContainText('req_e2e_auth_failure');
 await row.locator('.record-summary').click();await expect(frame.locator('#record-error')).not.toBeEmpty();await expect(frame.locator('#record-error')).not.toContainText('sk-e2e-private-secret');await expect(frame.locator('#record-error')).not.toContainText('req_e2e_auth_failure');await expect(frame.locator('#no-output')).not.toHaveText('草稿');await preview.screenshot({animations:'disabled',path:info.outputPath('failed-history-zh.png')});const explanation=await frame.locator('#record-error').textContent();
 await orkas.closePreview(preview);({preview,frame}=await open(orkas));await frame.locator('.record-summary').first().click();await expect(frame.locator('#record-error')).toHaveText(explanation!);await expect(frame.locator('#record-detail')).not.toContainText('<span');await orkas.closePreview(preview);
});

test('selects per-task services across media tabs, survives reopening and follows settings order without changing it',async({modelOrkas:orkas},info)=>{
 let{preview,frame}=await open(orkas,true);const images=(await services(frame,'image')).services;expect(images).toHaveLength(2);await expect(frame.locator('#service-trigger')).toContainText('商品图片');await choose(frame,images[1].id);await frame.locator('#brief').fill('保留这条原始制作要求');
 await frame.locator('#nav-video').click();const videos=(await services(frame,'video')).services;expect(videos.map((s:any)=>[s.managed,s.available])).toEqual([[false,true],[false,true]]);await frame.locator('#service-trigger').click();await expect(frame.locator('[role="option"][data-value="'+videos[0].id+'"]')).toContainText('自有视频');await expect(frame.locator('[role="option"][data-value="'+videos[1].id+'"]')).not.toHaveAttribute('aria-disabled','true');await frame.locator('[role="option"][data-value="'+videos[0].id+'"]').click();
 await frame.locator('#nav-audio').click();const voices=(await services(frame,'audio')).services;await choose(frame,voices[0].id);await expect(frame.locator('#service-label')).toHaveText('语音服务');await frame.locator('#nav-image').click();await expect(frame.locator('#service-trigger')).toContainText('海报');await expect(frame.locator('#brief')).toHaveValue('保留这条原始制作要求');
 await orkas.closePreview(preview);({preview,frame}=await open(orkas,true));await expect(frame.locator('#service-trigger')).toContainText('海报');
 await orkas.electronApp.evaluate(()=>{const f=(globalThis as any).__mediaChoiceFixture;f.auth.saveImageProfiles(f.auth.loadImageProfiles().slice().reverse());});await frame.locator('body').evaluate(()=>window.dispatchEvent(new Event('focus')));
 await expect.poll(async()=>(await services(frame,'image')).services[0].id).toBe(images[1].id);await frame.locator('#service-trigger').click();await expect.poll(()=>serviceOptions(frame).evaluateAll(els=>els.map(el=>el.getAttribute('data-value')))).toEqual([images[1].id,images[0].id]);await frame.locator('#service-trigger').press('Escape');
 const before=await orkas.electronApp.evaluate(()=>(globalThis as any).__mediaChoiceFixture.auth.loadImageProfiles().map((p:any)=>p.id));orkas.setModelTextReplies(['Controlled text result without paid generation.']);await frame.locator('#submit').click();await expect.poll(async()=>(await state(frame))?.works[0]?.status,{timeout:30000}).toBe('failed');
 const evidence=await orkas.electronApp.evaluate(()=>{const f=(globalThis as any).__mediaChoiceFixture;return{calls:f.calls,order:f.auth.loadImageProfiles().map((p:any)=>p.id)};});expect(evidence.order).toEqual(before);expect(evidence.calls).toHaveLength(1);expect(evidence.calls[0]).toMatchObject({route:'second-image',input:{prompt:'保留这条原始制作要求',media:{kind:'image',serviceId:images[1].id}}});
 await preview.setViewportSize({width:400,height:650});await preview.emulateMedia({colorScheme:'dark'});await orkas.page.evaluate(()=>(window as any).setLang('en'));await frame.locator('body').evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(frame.locator('html')).toHaveAttribute('lang','en');await frame.locator('#service-trigger').click();await expect(frame.locator('#service-listbox')).toHaveCSS('min-width','220px');await expect(frame.locator('#refresh-services')).toHaveCSS('white-space','nowrap');await preview.screenshot({animations:'disabled',path:info.outputPath('service-picker-en-narrow-dark.png')});await frame.locator('#service-trigger').press('Escape');await orkas.page.evaluate(()=>(window as any).setLang('ar'));await frame.locator('body').evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(frame.locator('html')).toHaveAttribute('dir','rtl');await frame.locator('#service-trigger').click();await preview.screenshot({animations:'disabled',path:info.outputPath('service-picker-ar-narrow-dark.png')});await orkas.closePreview(preview);
});

test('keeps a removed selection visible and requires a new choice, preserving the authored draft',async({modelOrkas:orkas})=>{
 const{preview,frame}=await open(orkas,true),images=(await services(frame,'image')).services;await choose(frame,images[0].id);await frame.locator('#brief').fill('保留我的输入');
 await orkas.electronApp.evaluate(()=>{const f=(globalThis as any).__mediaChoiceFixture;f.auth.saveImageProfiles(f.auth.loadImageProfiles().filter((p:any)=>p.id!=='first-image'));});await frame.locator('body').evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(frame.locator('#service-state')).toContainText('不可用');await expect(frame.locator('#submit')).toBeDisabled();await expect(frame.locator('#brief')).toHaveValue('保留我的输入');expect(orkas.modelRequests).toHaveLength(0);await choose(frame,images[1].id);await expect(frame.locator('#submit')).toBeEnabled();await orkas.closePreview(preview);
});


test('shows the first configured user services directly and resets to the first choice',async({modelOrkas:orkas},info)=>{
 const{preview,frame}=await open(orkas,true);await expect(frame.locator('#service-trigger')).toContainText('商品图片');
 const images=(await services(frame,'image')).services;await frame.locator('#service-trigger').click();await expect(serviceOptions(frame)).toHaveCount(images.length);await expect(frame.locator('#service-listbox [data-value="configure-models"]')).toHaveCount(1);await expect(frame.locator('#service-listbox')).not.toContainText('默认服务');await frame.locator('#service-trigger').press('Escape');
 await frame.locator('#nav-video').click();const videos=(await services(frame,'video')).services;expect(videos).toHaveLength(2);await expect(frame.locator('#service-trigger')).toContainText('自有视频');await choose(frame,videos[1].id);await expect(frame.locator('#service-trigger')).toContainText('第二视频');await frame.locator('#reset-work').click();await expect(frame.locator('#service-trigger')).toContainText('自有视频');
 await frame.locator('#service-trigger').click();await preview.screenshot({animations:'disabled',path:info.outputPath('user-video-models-zh.png')});await frame.locator('#service-trigger').press('Escape');
 await frame.locator('#nav-audio').click();await expect(frame.locator('#service-trigger')).toContainText('旁白');expect(orkas.modelRequests).toHaveLength(0);await orkas.closePreview(preview);
});

test('keeps idle navigation and service defaults silent and only acknowledges an authored draft save',async({modelOrkas:orkas},info)=>{
 let{preview,frame}=await open(orkas,true);await expect(frame.locator('#service-trigger')).toContainText('商品图片');
 // An ordered read follows any queued autosave, so this also observes delayed false success.
 await expect.poll(async()=>(await state(frame))?.drafts?.image?.settings?.serviceId).toBeTruthy();await expect(frame.locator('#save-state')).toBeEmpty();
 for(const tab of ['video','audio','image']){await frame.locator('#nav-'+tab).click();await expect(frame.locator('#refresh-services')).toBeEnabled();await expect(frame.locator('#save-state')).toBeEmpty();}
 await frame.locator('#refresh-services').click();await expect(frame.locator('#refresh-services')).toBeEnabled();await expect(frame.locator('#save-state')).toBeEmpty();
 await frame.locator('#brief').fill('Only acknowledge my saved edit.');await expect(frame.locator('#save-state')).toHaveText('已保存');expect((await state(frame)).drafts.image.brief).toBe('Only acknowledge my saved edit.');
 await frame.locator('#nav-video').click();await expect(frame.locator('#save-state')).toBeEmpty();await frame.locator('#nav-image').click();await expect(frame.locator('#brief')).toHaveValue('Only acknowledge my saved edit.');await expect(frame.locator('#save-state')).toBeEmpty();
 await orkas.closePreview(preview);({preview,frame}=await open(orkas,true));await expect(frame.locator('#brief')).toHaveValue('Only acknowledge my saved edit.');await expect(frame.locator('#save-state')).toBeEmpty();
 await preview.screenshot({animations:'disabled',path:info.outputPath('restored-draft-without-save-notice-zh.png')});expect(orkas.modelRequests).toHaveLength(0);await orkas.closePreview(preview);
});

test('keeps model configuration available when no media service is configured without allowing generation',async({modelOrkas:orkas},info)=>{
 const{preview,frame}=await open(orkas,true);
 await orkas.electronApp.evaluate(()=>{const f=(globalThis as any).__mediaChoiceFixture;f.auth.saveVideoProfiles([]);});
 await frame.locator('#nav-video').click();await expect(frame.locator('#refresh-services')).toBeEnabled();await expect(frame.locator('#service-trigger')).toBeEnabled();await expect(frame.locator('#service-state')).toBeHidden();await frame.locator('#service-trigger').click();await expect(serviceOptions(frame)).toHaveCount(0);await expect(frame.locator('#service-listbox [data-value="configure-models"]')).toHaveCount(1);await expect(frame.locator('#service-listbox [data-value="configure-models"]')).not.toHaveAttribute('aria-disabled','true');await frame.locator('#service-trigger').press('Escape');await frame.locator('#brief').fill('Keep this request until a service is configured.');await expect(frame.locator('#submit')).toBeDisabled();
 await preview.screenshot({animations:'disabled',path:info.outputPath('empty-video-services-zh.png')});expect(orkas.modelRequests).toHaveLength(0);await orkas.closePreview(preview);
});

for(const appId of ['builtin-content-workbench','builtin-product-listing'])test('keeps video service loading in the refresh action through tab changes, failure and recovery in '+appId,async({modelOrkas:orkas},info)=>{
 const{preview,frame}=await open(orkas,true,appId);
 await orkas.electronApp.evaluate(()=>{
  const f=(globalThis as any).__mediaChoiceFixture,original=f.runtime.execute,gate={hold:true,fail:false,release:()=>{},restore:()=>{f.runtime.execute=original;}};f.serviceGate=gate;
  f.runtime.execute=async function(...args:any[]){if(args[1]==='tasks.services'&&args[2].kind==='video'){if(gate.hold)await new Promise<void>(resolve=>{gate.release=resolve;});if(gate.fail){gate.fail=false;throw new f.AppError('E_FAILED');}}return original.apply(this,args);};
 });
 const release=()=>orkas.electronApp.evaluate(()=>{const g=(globalThis as any).__mediaChoiceFixture.serviceGate;g.hold=false;g.release();});
 try{
  await frame.locator('#nav-video').click();await frame.locator('#brief').fill('Keep this video request while models load.');await expect(frame.locator('#refresh-services')).toHaveText('加载中…');await expect(frame.locator('#refresh-services')).toBeDisabled();await expect(frame.locator('#refresh-services')).toHaveAttribute('aria-busy','true');await expect(frame.locator('#service-state')).toBeHidden();await expect(frame.locator('#service-trigger')).toBeDisabled();await preview.screenshot({path:info.outputPath('service-loading-inline-zh.png')});
  await frame.locator('#nav-image').click();await expect(frame.locator('#refresh-services')).toHaveText('刷新');await frame.locator('#nav-video').click();await expect(frame.locator('#refresh-services')).toHaveText('加载中…');await expect(frame.locator('#brief')).toHaveValue('Keep this video request while models load.');
  await orkas.page.evaluate(()=>(window as any).setLang('en'));await frame.locator('body').evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(frame.locator('html')).toHaveAttribute('lang','en');await preview.setViewportSize({width:400,height:700});await expect(frame.locator('#refresh-services')).toHaveText('Loading…');await expect(frame.locator('#service-state')).toBeHidden();expect(await frame.locator('body').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);await preview.screenshot({path:info.outputPath('service-loading-inline-en-narrow.png')});
  await release();await expect(frame.locator('#refresh-services')).toHaveText('Refresh');await expect(frame.locator('#refresh-services')).toBeEnabled();await expect(frame.locator('#refresh-services')).toHaveAttribute('aria-busy','false');await expect(frame.locator('#service-trigger')).toContainText('自有视频');
  await orkas.electronApp.evaluate(()=>{const g=(globalThis as any).__mediaChoiceFixture.serviceGate;g.hold=true;g.fail=true;});await frame.locator('#refresh-services').click();await expect(frame.locator('#refresh-services')).toHaveText('Loading…');await expect(frame.locator('#service-state')).toBeHidden();await release();await expect(frame.locator('#refresh-services')).toHaveText('Refresh');await expect(frame.locator('#service-state')).toBeVisible();await expect(frame.locator('#service-state')).not.toBeEmpty();
  await frame.locator('#refresh-services').click();await expect(frame.locator('#refresh-services')).toBeEnabled();await expect(frame.locator('#service-state')).toBeHidden();await expect(frame.locator('#brief')).toHaveValue('Keep this video request while models load.');expect(orkas.modelRequests).toHaveLength(0);
 }finally{await release();await orkas.electronApp.evaluate(()=>(globalThis as any).__mediaChoiceFixture.serviceGate.restore());await orkas.closePreview(preview);}
});

test('renders the public Orkas·Voice choice through refresh and reopen without changing speech authorization',async({modelOrkas:orkas},info)=>{
 let{preview,frame}=await open(orkas,true);
 await orkas.electronApp.evaluate(()=>{
  const auth=(globalThis as any).__mediaChoiceFixture.auth;
  auth.saveTtsProfiles([{id:'public-speech',provider:'orkas-api',model:'orkas-tts-1',baseUrl:'https://orkas.ai/v1',apiKey:'fixture-public-key',voice:'alloy',label:'My API key',createdAt:1},...auth.loadTtsProfiles()]);
 });
 await frame.locator('#nav-audio').click();await expect(frame.locator('#refresh-services')).toBeEnabled();
 const choices=(await services(frame,'audio')).services;expect(choices).toHaveLength(2);
 expect(choices[0]).toMatchObject({provider:'orkas-api',model:'orkas-tts-1',managed:false});
 await expect(frame.locator('#service-trigger')).toContainText('Orkas·Voice');
 await frame.locator('#brief').fill('Keep my speech script.');
 for(const[lang,width]of [['zh',980],['en',400]]as const){
  await preview.setViewportSize({width,height:700});await orkas.page.evaluate(lang=>(window as any).setLang(lang),lang);
  await frame.locator('body').evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(frame.locator('html')).toHaveAttribute('lang',lang);
  await frame.locator('#refresh-services').click();await expect(frame.locator('#refresh-services')).toBeEnabled();
  await frame.locator('#service-trigger').click();await expect(frame.locator('[role="option"][data-value="'+choices[0].id+'"]').first()).toContainText('Orkas·Voice');
  expect(await frame.locator('body').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
  await preview.screenshot({animations:'disabled',path:info.outputPath('public-voice-'+lang+'.png')});await frame.locator('#service-trigger').press('Escape');
 }
 expect((await state(frame)).drafts.audio.settings.serviceId).toBe(choices[0].id);
 await choose(frame,choices[1].id);await expect(frame.locator('#service-trigger')).toContainText('旁白');
 await choose(frame,choices[0].id);await orkas.closePreview(preview);({preview,frame}=await open(orkas,true));
 await frame.locator('#nav-audio').click();await expect(frame.locator('#service-trigger')).toContainText('Orkas·Voice');await expect(frame.locator('#brief')).toHaveValue('Keep my speech script.');
 const final=await orkas.electronApp.evaluate(()=>{const f=(globalThis as any).__mediaChoiceFixture;return{profiles:f.auth.loadTtsProfiles().map((p:any)=>[p.id,p.provider,p.model]),mediaCalls:f.mediaCalls};});
 expect(final.profiles).toEqual([['public-speech','orkas-api','orkas-tts-1'],['own-voice','openai','tts-1']]);expect(final.mediaCalls).toBe(0);expect(orkas.modelRequests).toHaveLength(0);await orkas.closePreview(preview);
});
