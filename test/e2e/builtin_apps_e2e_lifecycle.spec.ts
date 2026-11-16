import {writeFileSync} from 'node:fs';import path from 'node:path';
import {openSidebarEntry,expect,test} from './fixtures/orkas';

test.setTimeout(180000);
for(const appId of ['builtin-content-workbench','builtin-product-listing'])test('configures the matching media model tab from '+appId+' without changing the selected model or draft',async({modelOrkas:orkas},info)=>{
 await orkas.page!.evaluate(()=>(window as any).setLang('zh'));await openSidebarEntry(orkas.page!,'#apps-btn');
 const preview=await orkas.openPreview(()=>orkas.page!.locator('.app-card[data-app-id="'+appId+'"]').click()),outer=preview.frameLocator('.saved-app-viewer-frame');let frame=outer;
 if(appId==='builtin-product-listing'){await outer.locator('button[data-view="creative"]').click();frame=outer.frameLocator('#media-workspace');}
 for(const kind of appId==='builtin-content-workbench'?['image','video','audio']:['image','video']){
  await frame.locator('#nav-'+kind).click();const brief='Preserve '+kind+' draft';await frame.locator('#brief').fill(brief);await expect(frame.locator('#service-trigger')).toBeEnabled();
  const selected=await frame.locator('#service-trigger').innerText();await frame.locator('#service-trigger').click();const configure=frame.locator('#service-listbox [data-value="configure-models"]');await expect(configure).toHaveText('配置模型');await expect(frame.locator('#service-listbox .ai-select-item').last()).toHaveText('配置模型');await preview.screenshot({path:info.outputPath(kind+'-configure-zh.png')});
  if(kind==='video'){for(let step=0;step<await frame.locator('#service-listbox .ai-select-item').count();step++)await frame.locator('#service-trigger').press('ArrowDown');await frame.locator('#service-trigger').press('Enter');}else await configure.click();
  await expect(orkas.page!.locator('#panel-settings')).toBeVisible();await expect(orkas.page!.locator('[data-settings-tab="credentials"]')).toHaveAttribute('aria-selected','true');await expect(orkas.page!.locator('[data-settings-model-tab="'+(kind==='audio'?'tts':kind)+'"]')).toHaveAttribute('aria-selected','true');await expect(frame.locator('#brief')).toHaveValue(brief);await expect(frame.locator('#service-trigger')).toHaveText(selected);
  await frame.locator('body').evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(frame.locator('#service-trigger')).toBeEnabled();await expect(frame.locator('#brief')).toHaveValue(brief);
 }
 for(const [language,width,label]of [['en',640,'Configure models'],['ar',400,'تكوين النماذج']]as const){
  await orkas.page!.evaluate(language=>(window as any).setLang(language),language);await outer.locator('body').evaluate(()=>window.dispatchEvent(new Event('focus')));await frame.locator('body').evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(frame.locator('html')).toHaveAttribute('lang',language);await preview.setViewportSize({width,height:560});await expect(frame.locator('#service-trigger')).toBeEnabled();await frame.locator('#service-trigger').click();await expect(frame.locator('#service-listbox .ai-select-item').last()).toHaveText(label);await preview.screenshot({path:info.outputPath('configure-'+language+'.png')});await frame.locator('#service-trigger').press('Escape');
 }
 expect(orkas.modelRequests).toHaveLength(0);await orkas.closePreview(preview);
});

for(const appId of ['builtin-content-workbench','builtin-product-listing'])test('opens model configuration from an empty list after a recoverable failure in '+appId,async({modelOrkas:orkas})=>{
 await orkas.electronApp!.evaluate((_electron,module)=>{const {runtime}= (process as any).mainModule.require(module),services=runtime.host.tasks,configure=runtime.host.configureModels,ErrorType=(process as any).mainModule.require(module.replace('host.ts','runtime.ts')).AppError;const state={failed:false,refresh:false};(globalThis as any).__modelConfigurationProbe=state;runtime.host.tasks=async function(...args:any[]){if(args[2]==='tasks.services'){state.refresh=args[3].refresh===true;return{services:[]};}return services.apply(this,args);};runtime.host.configureModels=async function(...args:any[]){if(!state.failed){state.failed=true;throw new ErrorType('E_UNAVAILABLE');}return configure.apply(this,args);};},path.resolve(__dirname,'../../src/main/features/web_apps/host.ts'));
 await orkas.page!.evaluate(()=>(window as any).setLang('zh'));await openSidebarEntry(orkas.page!,'#apps-btn');const preview=await orkas.openPreview(()=>orkas.page!.locator('.app-card[data-app-id="'+appId+'"]').click()),outer=preview.frameLocator('.saved-app-viewer-frame');let frame=outer;if(appId==='builtin-product-listing'){await outer.locator('button[data-view="creative"]').click();frame=outer.frameLocator('#media-workspace');await frame.locator('#nav-image').click();}
 await frame.locator('#brief').fill('Keep this unsent creation');await expect(frame.locator('#service-trigger')).toBeEnabled();await frame.locator('#service-trigger').click();await expect(frame.locator('#service-listbox .ai-select-item')).toHaveCount(1);await frame.locator('[data-value="configure-models"]').click();await expect(frame.locator('#notice')).toHaveClass('error');await expect(frame.locator('#brief')).toHaveValue('Keep this unsent creation');await expect(orkas.page!.locator('#panel-settings')).toBeHidden();
 await frame.locator('#service-trigger').click();await frame.locator('[data-value="configure-models"]').click();await expect(orkas.page!.locator('[data-settings-model-tab="image"]')).toHaveAttribute('aria-selected','true');await frame.locator('body').evaluate(()=>window.dispatchEvent(new Event('focus')));await expect.poll(()=>orkas.electronApp!.evaluate(()=>(globalThis as any).__modelConfigurationProbe.refresh)).toBe(true);await expect(frame.locator('#brief')).toHaveValue('Keep this unsent creation');expect(orkas.modelRequests).toHaveLength(0);await orkas.closePreview(preview);
});
// Observe native presentation without suppressing a show/focus call that should fail the case.
test.beforeEach(async({modelOrkas:orkas})=>{
 // Public applications select an actual user-owned service. These journeys
 // stage output files and use the local model stub; provider execution is forbidden.
 await orkas.invoke('imageAuth.add',{provider:'openai',apiKey:'sk-e2e-image-synthetic-only',label:'Local app fixture'});
 await orkas.electronApp!.evaluate((_electron,module)=>{
  const image=(process as any).mainModule.require(module),state={calls:0};
  (globalThis as any).__publicAppImageGuard=state;
  image.generateImage=async()=>{state.calls++;throw Error('Unexpected external image generation in app fixture');};
 },path.resolve(__dirname,'../../src/main/features/image_gen.ts'));
 await orkas.electronApp!.evaluate(({app,BrowserWindow})=>{
  if(process.env.ORKAS_E2E_HIDE_WINDOW!=='1')return;
  const state={shown:0,focused:0};(globalThis as any).__commerceWindowPresentation=state;
  const watch=(win:any)=>{if(win.isVisible())state.shown++;win.on('show',()=>state.shown++);win.on('focus',()=>state.focused++);};
  for(const win of BrowserWindow.getAllWindows())watch(win);
  app.on('browser-window-created',(_event,win)=>watch(win));
 });
});
test.afterEach(async({modelOrkas:orkas})=>{
 expect(await orkas.electronApp!.evaluate(()=>(globalThis as any).__publicAppImageGuard.calls)).toBe(0);
 const state=await orkas.electronApp!.evaluate(({BrowserWindow})=>{
  const state=(globalThis as any).__commerceWindowPresentation;
  return state?{...state,visible:BrowserWindow.getAllWindows().filter(win=>win.isVisible()).length}:null;
 });
 if(state)expect(state,'Ordinary Commerce tests must not show or focus native windows').toEqual({shown:0,focused:0,visible:0});
});

test('discovers real applications and renders specific reply entries through the Commander tool flow', async ({ modelOrkas: orkas }, info) => {
 const page = orkas.page!;
 await page.evaluate(() => (window as any).setLang('zh'));
 const source = orkas.createWorkspaceFile('catalog-copy/index.html', '<!doctype html><h1>Custom content calculator</h1>');
 // A custom app may share the platform title; the catalog ID must disambiguate it.
 const saved = await orkas.invoke<any>('savedApps.saveFromPath', { path: source, title: '内容工作台' });
 expect(saved.ok).toBe(true);
 let listed = false, staged = false, discovered: any[] = [];
 orkas.setModelRequestScript((request, tools) => {
  if (!tools.has('list_apps')) return { calls: [{ callId: 'load-app-catalog', name: 'tool_load', args: { groups: ['management.app'] } }] };
  if (!listed) { listed = true; return { calls: [{ callId: 'discover-current-apps', name: 'list_apps', args: {} }] }; }
  if (!staged) {
   const receipt = (request.messages as any[]).find(row => row.role === 'tool' && row.tool_call_id === 'discover-current-apps');
   const result = JSON.parse(receipt.content); expect(result.ok).toBe(true);
   discovered = result.apps;
   const entries = discovered.filter(row => row.available).map(row => row.navigation);
   staged = true;
   return { calls: [...entries, entries[0]].map((args, index) => ({ callId: 'app-entry-' + index, name: 'open_app_view', args })) };
  }
  return { text: '可以从下方直接打开具体应用。' };
 });
 const windowsBefore = await orkas.electronApp!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
 await page.locator('#new-chat-input').fill('显示我的内置应用和已保存应用，并给出每个应用的入口。');
 await page.locator('#new-chat-send-btn').click();
 await expect(page.locator('#chat-history .chat-message.assistant [data-role="final"]')).toContainText('可以从下方直接打开具体应用。', { timeout: 60000 });
 expect(discovered.map(row => row.id).sort()).toEqual(['builtin-content-workbench', 'builtin-product-listing', saved.id].sort());
 const cards = page.locator('#chat-history .chat-app-nav-btn');
 await expect(cards).toHaveCount(3);
 await expect(cards.filter({ hasText: '打开内容工作台' })).toHaveCount(2);
 await expect(cards.filter({ hasText: '打开电商工作台' })).toHaveCount(1);
 expect(await orkas.electronApp!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(windowsBefore);
 const cid = await page.evaluate<string>('currentCid');
 await page.reload();
 await page.evaluate(async cid => { await (window as any).loadConversations(); (window as any).setView('conversation', cid); }, cid);
 await expect(cards).toHaveCount(3);
 const customCard = page.locator(`#chat-history .chat-app-nav-btn[data-app-nav*="${saved.id}"]`);
 const custom = await orkas.openPreview(() => customCard.click());
 await expect(custom.frameLocator('.saved-app-viewer-frame').getByRole('heading', { name: 'Custom content calculator' })).toBeVisible();
 await orkas.closePreview(custom);
 const commerce = await orkas.openPreview(() => cards.filter({ hasText: '打开电商工作台' }).click());
 await expect(commerce.frameLocator('.saved-app-viewer-frame').locator('button[data-view="stores"]')).toBeVisible();
 await orkas.closePreview(commerce);
 await page.screenshot({ path: info.outputPath('discovered-specific-app-entries.png') });
});

test('opens Apps and a specific platform app from persisted reply footer cards', async ({ modelOrkas: orkas }, info) => {
 const page = orkas.page!;
 const customTitle = 'Revenue calculator — Quarterly investment and operating budget planner for Europe';
 const source = orkas.createWorkspaceFile('reply-app/index.html', '<!doctype html><h1>Budget navigation target</h1>');
 expect((await orkas.invoke<any>('savedApps.saveFromPath', { path: source, title: customTitle })).ok).toBe(true);
 const { conversation } = await orkas.invoke<any>('conversations.create', { title: 'App navigation' });
 const cid = conversation.conversation_id, uid = await page.evaluate<string>('currentUserId');
 const file = path.join(orkas.workspaceRoot, uid, 'cloud', 'chats', cid + '.jsonl');
 writeFileSync(file, JSON.stringify({ id: 'app-navigation-reply', from: 'commander', type: 'message', text: '已准备好，可以从下方打开应用。', ts: Date.now(), app_nav_requests: [
  { surface_id: 'apps', action: 'open', requested_at: new Date().toISOString() },
  { surface_id: 'apps', action: 'configure', target_id: 'builtin-product-listing', requested_at: new Date().toISOString() },
  { surface_id: 'apps', action: 'configure', target_id: 'deleted-app', requested_at: new Date().toISOString() },
  { surface_id: 'apps', action: 'configure', target_id: customTitle, requested_at: new Date().toISOString() },
 ] }) + '\n');
 for (const [language, width, listLabel, appLabel] of [['zh', 1280, '打开页面：应用', '打开电商工作台'], ['en', 800, 'Open page: Apps', 'Open Commerce workspace']] as const) {
  await page.setViewportSize({ width, height: 720 });
  await page.evaluate(async ({ language, cid }) => { const app = window as any; app.setLang(language); await app.loadConversations({ fresh: true }); app.setView('conversation', cid); await app.loadConversationHistory(cid); }, { language, cid });
  const cards = page.locator('#chat-history .chat-app-nav-btn'); await expect(cards).toHaveCount(4);
  await expect(cards.nth(1)).toHaveText(appLabel); await expect(cards.nth(0)).toHaveText(listLabel);
  await expect(cards.nth(3)).toContainText(customTitle);
  for (const card of await cards.all()) await expect(card).toBeInViewport();
  expect(await cards.evaluateAll(elements => elements.every(element => {
   const box = element.getBoundingClientRect(); return box.right <= innerWidth && box.left >= 0 && element.scrollWidth <= element.clientWidth;
  }))).toBe(true);
  await page.screenshot({ path: info.outputPath('reply-app-entries-' + language + '.png') });
  await cards.nth(0).click(); await expect(page.locator('#panel-apps')).toBeVisible();
  await page.evaluate(cid => (window as any).setView('conversation', cid), cid);
  const preview = await orkas.openPreview(() => page.getByRole('button', { name: appLabel, exact: true }).click());
  await expect(preview.frameLocator('.saved-app-viewer-frame').locator('button[data-view="stores"]')).toBeVisible(); await orkas.closePreview(preview);
  const custom = await orkas.openPreview(() => cards.nth(3).click());
  await expect(custom.frameLocator('.saved-app-viewer-frame').getByRole('heading', { name: 'Budget navigation target' })).toBeVisible();
  await orkas.closePreview(custom);
  await cards.nth(2).click(); await expect(page.locator('.ui-toast').last()).toBeVisible();
  await expect(cards.nth(2)).toBeEnabled();
  await expect(page.locator('.ui-toast')).toHaveCount(0);
 }
 expect(orkas.modelRequests).toHaveLength(0);
});

test('keeps the store connection entry in the first viewport with a legacy SDK and opens Connectors directly', async ({ modelOrkas: orkas }, info) => {
 await orkas.electronApp!.evaluate((_electron, module) => {
  const runtime = (process as any).mainModule.require(module).runtime, original = runtime.resource;
  // Model an already-cached SDK without the convenience helper. The live
  // instance keeps its real packaged identity and native authorization checks.
  runtime.resource = async function (...args: any[]) {
   const scoped = await original.apply(this, args);
   return args[1] === '__orkas/sdk.js' && scoped ? { ...scoped, bundle: { ...scoped.bundle, builtinApp: undefined } } : scoped;
  };
 }, path.resolve(__dirname, '../../src/main/features/web_apps/host.ts'));
 const page = orkas.page!;
 for (const [language, width, label, repeatedTitle] of [['zh', 1080, '连接店铺', '店铺管理'], ['en', 400, 'Connect store', 'Stores']] as const) {
  await page.evaluate(language => (window as any).setLang(language), language); await openSidebarEntry(page, '#apps-btn');
  const preview = await orkas.openPreview(() => page.locator('.app-card[data-app-id="builtin-product-listing"]').click());
  await preview.setViewportSize({ width, height: 382 });
  const frame = preview.frameLocator('.saved-app-viewer-frame');
  await frame.locator('button[data-view="stores"]').click(); await expect(frame.locator('#stores-page')).toHaveAttribute('aria-busy', 'false');
  expect(await frame.locator('body').evaluate(() => typeof (window as any).orkasApp.openConnectors)).toBe('undefined');
  const connect = frame.getByRole('button', { name: label, exact: true });
  await expect(connect).toBeVisible();
  expect(await connect.evaluate(element => { const r = element.getBoundingClientRect(); return r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth; })).toBe(true);
  await expect(frame.getByRole('heading', { name: repeatedTitle, exact: true })).toHaveCount(0);
  expect(await frame.locator('body').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await preview.screenshot({ path: info.outputPath('stores-connection-first-viewport-' + language + '.png') });
  await connect.click(); await expect(page.locator('#panel-connectors')).toBeVisible();
  await orkas.closePreview(preview);
 }
 expect(orkas.modelRequests).toHaveLength(0);
});
test('shows a failed store lookup as recoverable and retries without claiming that no stores are connected', async ({ modelOrkas: orkas }) => {
 await orkas.electronApp!.evaluate((_electron, module) => {
  const runtime = (process as any).mainModule.require(module).runtime, original = runtime.execute;
  const control = { fail: true }; (globalThis as any).__commerceDirectoryFailure = control;
  runtime.execute = async function (...args: any[]) {
   if (args[1] === 'connectors.list') {
    if (control.fail) throw new ((process as any).mainModule.require(module.replace('host.ts', 'runtime.ts')).AppError)('E_TOOL');
    return { connectors: [], nextOffset: null };
   }
   return original.apply(this, args);
  };
 }, path.resolve(__dirname, '../../src/main/features/web_apps/host.ts'));
 const page = orkas.page!; await page.evaluate(() => (window as any).setLang('zh')); await openSidebarEntry(page, '#apps-btn');
 const preview = await orkas.openPreview(() => page.locator('.app-card[data-app-id="builtin-product-listing"]').click());
 const frame = preview.frameLocator('.saved-app-viewer-frame');
 await frame.locator('button[data-view="stores"]').click(); await expect(frame.locator('#stores-page')).toHaveAttribute('aria-busy', 'false');
 await expect(frame.locator('#store-list')).toContainText('暂时无法读取店铺资料');
 await expect(frame.locator('#store-list')).not.toContainText('还没有连接店铺');
 await expect(frame.getByRole('button', { name: '连接店铺', exact: true })).toBeEnabled();
 await orkas.electronApp!.evaluate(() => { (globalThis as any).__commerceDirectoryFailure.fail = false; });
 await frame.locator('#refresh-stores').click(); await expect(frame.locator('#stores-page')).toHaveAttribute('aria-busy', 'false');
 await expect(frame.locator('#store-list')).toContainText('还没有连接店铺');
 expect(orkas.modelRequests).toHaveLength(0); await orkas.closePreview(preview);
});
test('connects from the empty store page and discovers stores on return without losing the creation draft', async ({ modelOrkas: orkas }, info) => {
 await orkas.electronApp!.evaluate((_electron, module) => {
  const runtime = (process as any).mainModule.require(module).runtime, original = runtime.execute;
  const state = { connected: false, fail: false, discoveries: 0, shop: 'travel', hold: false, waiting: false, release: () => {} }; (globalThis as any).__commerceConnect = state;
  runtime.execute = async function (...args: any[]) {
   if (args[1] === 'connectors.list') return { connectors: state.connected ? [{ id: 'woocommerce', name: 'Travel store', tools: [] }] : [], nextOffset: null };
   if (args[1] === 'tools.call' && args[2]?.name === 'call_connector_tool') {
    state.discoveries++;
    if (state.fail) throw new ((process as any).mainModule.require(module.replace('host.ts', 'runtime.ts')).AppError)('E_TOOL');
    const reply = { content: JSON.stringify({ provider: 'woocommerce', identity: { store_url: 'https://' + state.shop + '.example', currency: 'EUR' } }) };
    if (state.hold) { state.hold = false; state.waiting = true; await new Promise<void>(resolve => { state.release = resolve; }); }
    return reply;
   }
   return original.apply(this, args);
  };
 }, path.resolve(__dirname, '../../src/main/features/web_apps/host.ts'));
 const page = orkas.page!; await page.evaluate(() => (window as any).setLang('zh')); await openSidebarEntry(page, '#apps-btn');
 const preview = await orkas.openPreview(() => page.locator('.app-card[data-app-id="builtin-product-listing"]').click());
 const frame = preview.frameLocator('.saved-app-viewer-frame');
 await frame.locator('button[data-view="creative"]').click();const creator=frame.frameLocator('#media-workspace');await expect(creator.locator('#brief')).toBeEnabled();await creator.locator('#brief').fill('保留的文案核心内容');
 await frame.locator('button[data-view="stores"]').click(); await expect(frame.locator('#stores-page')).toHaveAttribute('aria-busy', 'false');
 await expect(frame.locator('#store-connection-guide')).toContainText('连接器');
 await expect(frame.locator('#store-list')).toContainText('还没有连接店铺');
 await preview.screenshot({ path: info.outputPath('commerce-empty-stores-zh.png') });
 await frame.getByRole('button', { name: '连接店铺', exact: true }).click();
 await expect(page.locator('#panel-connectors')).toBeVisible();
 expect(await orkas.electronApp!.evaluate(() => (globalThis as any).__commerceConnect.discoveries)).toBe(0);
 await orkas.electronApp!.evaluate(() => { (globalThis as any).__commerceConnect.connected = true; });
 await frame.locator('body').evaluate(() => window.dispatchEvent(new Event('focus')));
 await expect(frame.locator('.store-card h2')).toHaveText('travel.example');
 await frame.locator('button[data-view="creative"]').click();await expect(creator.locator('#brief')).toHaveValue('保留的文案核心内容');
 await page.evaluate(() => (window as any).setLang('en'));
 await frame.locator('body').evaluate(() => window.dispatchEvent(new Event('focus')));
 await expect(frame.locator('html')).toHaveAttribute('lang', 'en');
 await frame.locator('button[data-view="stores"]').click(); await preview.setViewportSize({ width: 640, height: 720 });
 await expect(frame.getByRole('button', { name: 'Connect store', exact: true })).toBeVisible();
 expect(await frame.locator('body').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
 await preview.screenshot({ path: info.outputPath('commerce-connected-en-narrow.png') });
 // Returning during an existing read must queue one fresh discovery, not lose it.
 await orkas.electronApp!.evaluate(() => { (globalThis as any).__commerceConnect.hold = true; });
 await frame.locator('#refresh-stores').click();
 await expect.poll(() => orkas.electronApp!.evaluate(() => (globalThis as any).__commerceConnect.waiting)).toBe(true);
 await frame.getByRole('button', { name: 'Connect store', exact: true }).click();
 await orkas.electronApp!.evaluate(() => { (globalThis as any).__commerceConnect.shop = 'second'; });
 await frame.locator('body').evaluate(() => window.dispatchEvent(new Event('focus')));
 await orkas.electronApp!.evaluate(() => (globalThis as any).__commerceConnect.release());
 await expect(frame.locator('#store-tabs button')).toHaveText(['All stores', 'second.example', 'travel.example']);
 await frame.locator('#store-tabs button[data-shop-tab=""]').click();
 await expect(frame.locator('.store-card h2')).toHaveText(['travel.example', 'second.example']);
 await orkas.electronApp!.evaluate(() => { (globalThis as any).__commerceConnect.fail = true; });
 await frame.locator('#refresh-stores').click(); await expect(frame.locator('#stores-page')).toHaveAttribute('aria-busy', 'false');
 await expect(frame.locator('.store-card h2')).toHaveText(['travel.example', 'second.example']);
 await expect(frame.locator('#store-updated')).toContainText('retained');
 expect(orkas.modelRequests).toHaveLength(0); await orkas.closePreview(preview);
});
test('refreshes store tabs only on entry, retains reports across reopen and recovers a failed manual refresh',async({modelOrkas:orkas},info)=>{
 await orkas.electronApp!.evaluate(async(_electron,module)=>{
  const runtime=(process as any).mainModule.require(module).runtime,original=runtime.execute;
  const control={reports:0,discoveries:0,fail:false};(globalThis as any).__storeRefreshFixture=control;
  runtime.execute=async function(...args:any[]){
   if(args[1]==='connectors.list')return {connectors:[{id:'shopify-admin',name:'Atlas account',tools:['list_capabilities','execute_read']},{id:'woocommerce',name:'Zen account',tools:['list_capabilities','execute_read']},{id:'custom-store',name:'Private shop',tools:[]},{id:'gmail',name:'Mail',tools:[]}],nextOffset:null};
   if(args[1]==='tools.call'&&args[2]?.name==='call_connector_tool'){
    const request=args[2].arguments;
    if(request.tool_name==='list_capabilities'){
     control.discoveries++;
     return {content:JSON.stringify(request.connector_id==='shopify-admin'?{provider:'shopify',identity:{shop:{id:'gid://shopify/Shop/1',name:'Atlas Store',myshopifyDomain:'atlas.myshopify.com',currencyCode:'USD'}}}:{provider:'woocommerce',identity:{store_url:'https://zen.example',currency:'EUR'}})};
    }
    if(request.tool_name==='execute_read'&&request.args.action==='orders'){
     control.reports++;if(control.fail)throw new ((process as any).mainModule.require(module.replace('host.ts','runtime.ts')).AppError)('E_TOOL');
     return {content:JSON.stringify({provider:'shopify',result:{data:{orders:{nodes:[{id:'order-1',createdAt:new Date(Date.now()-60000).toISOString(),cancelledAt:null,test:false,currentSubtotalLineItemsQuantity:2,currentSubtotalPriceSet:{shopMoney:{amount:'12.50',currencyCode:'USD'}}}],pageInfo:{hasNextPage:false,endCursor:null}}}}})};
    }
    throw Error('Unexpected commerce read');
   }
   return original.apply(this,args);
  };
 },path.resolve(__dirname,'../../src/main/features/web_apps/host.ts'));
 const page=orkas.page!;await page.evaluate(()=>(window as any).setLang('zh'));await openSidebarEntry(page,'#apps-btn');
 const card=page.locator('.app-card[data-app-id="builtin-product-listing"]');let preview=await orkas.openPreview(()=>card.click()),frame=preview.frameLocator('.saved-app-viewer-frame');
 await frame.locator('button[data-view="stores"]').click();await expect(frame.locator('#stores-page')).toHaveAttribute('aria-busy','false');
 await expect(frame.locator('#store-tabs button')).toHaveText(['全部店铺','Atlas Store','zen.example']);await expect(frame.locator('.store-metric strong').first()).toContainText('12.50');
 await expect(frame.locator('#store-list')).not.toContainText('Private shop');await expect(frame.locator('#store-list')).not.toContainText('Mail');
 const counts=()=>orkas.electronApp!.evaluate(()=>(globalThis as any).__storeRefreshFixture);
 expect(await counts()).toMatchObject({reports:1,discoveries:3});
 await frame.locator('button[data-view="creative"]').click();await frame.locator('button[data-view="stores"]').click();await expect(frame.locator('#stores-page')).toHaveAttribute('aria-busy','false');expect(await counts()).toMatchObject({reports:1,discoveries:3});
 await frame.locator('#store-tabs button').filter({hasText:'Atlas Store'}).click();await expect(frame.locator('#stores-page')).toHaveAttribute('aria-busy','false');expect((await counts()).reports).toBe(1);
 await frame.locator('#refresh-stores').click();await expect.poll(async()=>(await counts()).reports).toBe(2);await expect(frame.locator('#stores-page')).toHaveAttribute('aria-busy','false');
 await orkas.electronApp!.evaluate(()=>(globalThis as any).__storeRefreshFixture.fail=true);await frame.locator('#refresh-stores').click();await expect(frame.locator('#store-updated')).toContainText('保留');await expect(frame.locator('.store-metric strong').first()).toContainText('12.50');
 await preview.screenshot({path:info.outputPath('stores-cached-zh.png')});await orkas.closePreview(preview);
 await page.evaluate(()=>(window as any).setLang('en'));preview=await orkas.openPreview(()=>card.click());await preview.setViewportSize({width:640,height:800});frame=preview.frameLocator('.saved-app-viewer-frame');await frame.locator('button[data-view="stores"]').click();await expect(frame.locator('#stores-page')).toHaveAttribute('aria-busy','false');await expect(frame.locator('.store-metric strong').first()).toContainText('12.50');expect((await counts()).reports).toBe(3);
 expect(await frame.locator('body').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);await preview.screenshot({path:info.outputPath('stores-cached-en-narrow.png')});expect(orkas.modelRequests).toHaveLength(0);await orkas.closePreview(preview);
});
test('retains the old shop report when the same connector is reauthorized to a different shop', async ({ modelOrkas: orkas }) => {
 await orkas.electronApp!.evaluate(async (_electron, module) => {
  const runtime = (process as any).mainModule.require(module).runtime, original = runtime.execute;
  const control = { shop: '1', reads: [] as string[] }; (globalThis as any).__shopBindingFixture = control;
  runtime.execute = async function (...args: any[]) {
   if (args[1] === 'connectors.list') return { connectors: [{ id: 'shopify-admin', name: 'Shop account', tools: ['list_capabilities', 'execute_read'] }], nextOffset: null };
   if (args[1] === 'tools.call' && args[2]?.name === 'call_connector_tool') {
    const request = args[2].arguments;
    if (request.tool_name === 'list_capabilities') return { content: JSON.stringify({ provider: 'shopify', identity: { shop: {
      id: 'gid://shopify/Shop/' + control.shop, name: control.shop === '1' ? 'Atlas Store' : 'Beta Store', currencyCode: 'USD',
    } } }) };
    if (request.tool_name === 'execute_read' && request.args.action === 'orders') {
     control.reads.push(control.shop);
     return { content: JSON.stringify({ provider: 'shopify', result: { data: { orders: { nodes: [{
      id: 'order-' + control.shop, createdAt: new Date(Date.now() - 60000).toISOString(), cancelledAt: null, test: false,
      currentSubtotalLineItemsQuantity: 2, currentSubtotalPriceSet: { shopMoney: { amount: control.shop === '1' ? '12.50' : '25.00', currencyCode: 'USD' } },
     }], pageInfo: { hasNextPage: false, endCursor: null } } } } }) };
    }
    throw Error('Unexpected shop binding read');
   }
   return original.apply(this, args);
  };
 }, path.resolve(__dirname, '../../src/main/features/web_apps/host.ts'));
 const page = orkas.page!; await page.evaluate(() => (window as any).setLang('en')); await openSidebarEntry(page, '#apps-btn');
 const preview = await orkas.openPreview(() => page.locator('.app-card[data-app-id="builtin-product-listing"]').click());
 const frame = preview.frameLocator('.saved-app-viewer-frame'); await frame.locator('button[data-view="stores"]').click();
 await expect(frame.locator('#stores-page')).toHaveAttribute('aria-busy', 'false');
 await expect(frame.locator('.store-metric strong').first()).toContainText('12.50');
 await orkas.electronApp!.evaluate(() => { (globalThis as any).__shopBindingFixture.shop = '2'; });
 await frame.locator('#refresh-stores').click(); await expect(frame.locator('#stores-page')).toHaveAttribute('aria-busy', 'false');
 await expect(frame.locator('#store-tabs button')).toHaveText(['All stores', 'Atlas Store', 'Beta Store']);
 await expect(frame.locator('.store-metric strong').first()).toContainText('12.50');
 await expect(frame.locator('#store-updated')).toContainText('retained');
 expect(await orkas.electronApp!.evaluate(() => (globalThis as any).__shopBindingFixture.reads)).toEqual(['1']);
 await frame.locator('#store-tabs button').filter({ hasText: 'Beta Store' }).click();
 await expect(frame.locator('#stores-page')).toHaveAttribute('aria-busy', 'false');
 await expect(frame.locator('.store-metric strong').first()).toContainText('25.00');
 expect(await orkas.electronApp!.evaluate(() => (globalThis as any).__shopBindingFixture.reads)).toEqual(['1', '2']);
 await frame.locator('#store-tabs button').filter({ hasText: 'Atlas Store' }).click();
 await expect(frame.locator('#stores-page')).toHaveAttribute('aria-busy', 'false');
 await expect(frame.locator('.store-metric strong').first()).toContainText('12.50');
 expect(orkas.modelRequests).toHaveLength(0); await orkas.closePreview(preview);
});

async function commerceProduct(frame:any,name:string) {
 return frame.locator('body').evaluate(async(_element:any,name:string)=>{const api=(window as any).orkasApp,index=(await api.storage.get({key:'listing-index-v1',scope:'cloud'})).value;const row=index.find((item:any)=>item.name===name);if(!row)throw Error('Fixture product missing');return JSON.parse((await api.appFiles.readText({path:'products/'+row.id+'.json',scope:'cloud'})).text);},name);
}

async function stageCommerceImage(orkas:any) {
 await orkas.electronApp.evaluate(async(_electron:any,args:any)=>{
  const load=(process as any).mainModule.require.bind((process as any).mainModule),service=load(args.host).taskService,original=service.deps.send;
  service.deps.send=async function(uid:string,cid:string,...rest:any[]){service.deps.send=original;const fs=load('node:fs'),path=load('node:path'),workspace=await load(args.workspace).getConversationWorkspacePath(uid,cid);fs.mkdirSync(workspace,{recursive:true});fs.writeFileSync(path.join(workspace,'studio-result.png'),Buffer.from(args.png,'base64'));fs.writeFileSync(path.join(workspace,'notes.txt'),'Fixture output metadata');return original.call(this,uid,cid,...rest);};
 },{host:path.resolve(__dirname,'../../src/main/features/web_apps/task-host.ts'),workspace:path.resolve(__dirname,'../../src/main/features/group_chat/conv_workspace.ts'),png:'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAFCAYAAABirU3bAAAAEklEQVR4nGMISNnyHxkzUEEAAOMaMA0yqcWAAAAAAElFTkSuQmCC'});
}
async function writeCommerceImage(orkas:any,requestId:string,png:string) {
 const actual=await orkas.electronApp.evaluate(async(_electron:any,args:any)=>{
  const load=(process as any).mainModule.require.bind((process as any).mainModule),fs=load('node:fs'),path=load('node:path'),hash=(value:string)=>load('node:crypto').createHash('sha256').update(value).digest('hex');
  const key=hash(JSON.stringify(['saved','builtin-product-listing'])),root=load(args.paths).webAppSandboxRoot('account-e2e',key,'cloud'),receipt=JSON.parse(fs.readFileSync(path.join(root,'tasks',hash(args.requestId)+'.json'),'utf8'));
  const file=receipt.result.files.find((file:any)=>file.name==='studio-result.png');return fs.readFileSync(path.join(root,'files',file.path)).toString('base64');
 },{paths:path.resolve(__dirname,'../../src/main/paths.ts'),requestId});
 expect(actual).toBe(png);
}

// Lose or delay a reply after the real owning service has completed its work.
async function commerceFault(app:any,mode:'lost-start'|'output-retry') {
 await app.evaluate(async(_electron:any,args:any)=>{
  const load=(process as any).mainModule.require.bind((process as any).mainModule),runtime=load(args.host).runtime,original=runtime.execute,{AppError}=load(args.runtime);
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  const control={starts:0,outputs:0,ready:false,lost:false,release,restore:()=>{release();runtime.execute=original;delete(globalThis as any).__commerceFault;}};
  runtime.execute=async function(...input:any[]){
   const method=input[1];if(method==='tasks.start')control.starts++;
   const result=await original.apply(this,input);
   if(args.mode==='lost-start'&&method==='tasks.start'&&control.starts===1){control.lost=true;throw new AppError('E_TASK_UNCERTAIN');}
   if(args.mode==='output-retry'&&method==='tasks.output'){
    control.outputs++;if(control.outputs===1)throw new AppError('E_FAILED');
    if(control.outputs===2){control.ready=true;await gate;}
   }
   return result;
  };
  (globalThis as any).__commerceFault=control;
 },{host:path.resolve(__dirname,'../../src/main/features/web_apps/host.ts'),runtime:path.resolve(__dirname,'../../src/main/features/web_apps/runtime.ts'),mode});
}

test('automatically collects native image outputs without a product and reuses one private result after reopening',async({modelOrkas:orkas})=>{
 let{card,preview,frame,creator}=await openCommerceCreator(orkas);await creator.locator('#nav-image').click();await stageCommerceImage(orkas);orkas.setModelTextReplies(['Image job finished.']);await creator.locator('#brief').fill('Create a summer poster.');await creator.locator('#submit').click();await expect.poll(async()=>(await commerceMediaIndex(frame))?.works[0]?.status,{timeout:60000}).toBe('completed');await expect.poll(async()=>(await commerceMediaIndex(frame))?.works[0]?.resultAssetIds.length).toBe(2);
 const state=await commerceMediaIndex(frame),w=await frame.locator('body').evaluate(async(_el:any,id:string)=>JSON.parse((await(window as any).orkasApp.appFiles.readText({path:'works/'+id+'.json',scope:'cloud'})).text),state.works[0].id),png='iVBORw0KGgoAAAANSUhEUgAAAAQAAAAFCAYAAABirU3bAAAAEklEQVR4nGMISNnyHxkzUEEAAOMaMA0yqcWAAAAAAElFTkSuQmCC';await writeCommerceImage(orkas,w.jobs[0].requestId,png);await orkas.closePreview(preview);
 preview=await orkas.openPreview(()=>card.click());frame=preview.frameLocator('.saved-app-viewer-frame');await frame.locator('button[data-view="creative"]').click();creator=frame.frameLocator('#media-workspace');await creator.locator('#nav-image').click();await expect(creator.locator('.history-row')).toHaveCount(1);await creator.locator('.record-summary').click();await expect(creator.locator('.result-file:visible')).toHaveCount(1);await expect(creator.locator('.result-tools summary')).toContainText('更多文件');await creator.locator('.result-tools summary').click();await expect(creator.locator('.result-file')).toHaveCount(2);await creator.locator('.result-file').filter({hasText:'studio-result.png'}).locator('.attachment-preview').click();await expect(creator.locator('#media-content img')).toHaveJSProperty('naturalWidth',4);await creator.locator('#media-close').click();
 const resultFile=creator.locator('.result-file').filter({hasText:'studio-result.png'});await resultFile.hover();await resultFile.locator('.result-menu-trigger').click();await creator.locator('#record-menu').getByRole('menuitem',{name:'保存为素材',exact:true}).click();await creator.locator('#nav-library').click();await creator.locator('.library-card').filter({hasText:'studio-result.png'}).locator('input').check();await creator.locator('#use-selection').click();await expect(creator.locator('#selected-assets')).toContainText('studio-result.png');expect(orkas.modelRequests).toHaveLength(1);await orkas.closePreview(preview);
});

async function openCommerceCreator(orkas:any){
 const page=orkas.page!;await page.evaluate(()=>(window as any).setLang('zh'));await openSidebarEntry(page,'#apps-btn');
 const card=page.locator('.app-card[data-app-id="builtin-product-listing"]'),preview=await orkas.openPreview(()=>card.click()),frame=preview.frameLocator('.saved-app-viewer-frame');await frame.locator('button[data-view="creative"]').click();
 const creator=frame.frameLocator('#media-workspace');await expect(creator.locator('#brief')).toBeEnabled();return{card,preview,frame,creator};
}
async function commerceMediaIndex(frame:any){return frame.locator('body').evaluate(async()=>((await (window as any).orkasApp.storage.get({key:'content-index-v1',scope:'cloud'})).value));}

test('creates media without a product and keeps independent history, editable drafts and isolated Content data',async({modelOrkas:orkas},info)=>{
 let{card,preview,frame,creator}=await openCommerceCreator(orkas);await expect(frame.locator('#context-empty')).toHaveCount(0);await expect(creator.locator('#nav-audio')).toBeHidden();await expect(creator.locator('#product-association')).toBeHidden();await creator.locator('#nav-image').click();
 await creator.locator('#brief').fill('制作夏季促销海报');await stageCommerceImage(orkas);orkas.setModelTextReplies(['夏日促销文案']);await creator.locator('#submit').click();await expect.poll(async()=>(await commerceMediaIndex(frame))?.works[0]?.status,{timeout:60000}).toBe('completed');
 await expect.poll(async()=>(await commerceMediaIndex(frame))?.works[0]?.resultAssetIds?.length).toBe(2);const output=(await commerceMediaIndex(frame)).assets.find((asset:any)=>asset.name==='studio-result.png');expect(output.kind).toBe('image');expect(output.path).toMatch(/^results\//);expect(await frame.locator('body').evaluate(async()=>((await(window as any).orkasApp.storage.get({key:'listing-index-v1',scope:'cloud'})).value))).toBeNull();
 await creator.locator('#brief').fill('下一张保留暖色背景');await expect(creator.locator('#save-state')).toHaveText('已保存');await preview.screenshot({path:info.outputPath('commerce-independent-creator.png')});
 await orkas.closePreview(preview);preview=await orkas.openPreview(()=>card.click());frame=preview.frameLocator('.saved-app-viewer-frame');await frame.locator('button[data-view="creative"]').click();creator=frame.frameLocator('#media-workspace');await creator.locator('#nav-image').click();await expect(creator.locator('#brief')).toHaveValue('下一张保留暖色背景');await expect(creator.locator('.history-row')).toHaveCount(1);await creator.locator('.record-summary').click();await expect(creator.locator('#record-brief')).toHaveText('制作夏季促销海报');await expect(creator.locator('.result-file:visible')).toHaveCount(1);await expect(creator.locator('.result-tools summary')).toContainText('更多文件');await creator.locator('.result-tools summary').click();await expect(creator.locator('.result-file')).toHaveCount(2);await creator.locator('.result-file').filter({hasText:'studio-result.png'}).locator('.attachment-preview').click();await expect(creator.locator('#media-content img')).toHaveJSProperty('naturalWidth',4);await creator.locator('#media-close').click();
 await creator.locator('.history-menu-trigger').click();await creator.locator('#record-menu').getByRole('menuitem',{name:'编辑',exact:true}).click();await creator.locator('#confirm [value="confirm"]').click();await expect(creator.locator('#brief')).toHaveValue('制作夏季促销海报');expect(orkas.modelRequests).toHaveLength(1);await orkas.closePreview(preview);
 const content=await orkas.openPreview(()=>orkas.page!.locator('.app-card[data-app-id="builtin-content-workbench"]').click()),separate=content.frameLocator('.saved-app-viewer-frame');await expect(separate.locator('#brief')).toBeEnabled();await expect(separate.locator('.media-tabs button:visible')).toHaveText(['图片','视频','音频','素材库']);await expect(separate.locator('.history-row')).toHaveCount(0);await expect(separate.locator('#brief')).toBeEmpty();await orkas.closePreview(content);
});

test('recovers an uncertain copy submission after reopening without a second dispatch',async({modelOrkas:orkas})=>{
 let{card,preview,frame,creator}=await openCommerceCreator(orkas);await creator.locator('#brief').fill('制作独立商品文案');orkas.setModelTextReplies(['Independent media reply.']);await commerceFault(orkas.electronApp!,'lost-start');
 try{
  await creator.locator('#submit').click();await expect.poll(async()=>(await commerceMediaIndex(frame))?.works[0]?.status,{timeout:60000}).toBe('completed');const before=await commerceMediaIndex(frame);await orkas.closePreview(preview);preview=await orkas.openPreview(()=>card.click());frame=preview.frameLocator('.saved-app-viewer-frame');await frame.locator('button[data-view="creative"]').click();creator=frame.frameLocator('#media-workspace');await expect(creator.locator('.history-row')).toHaveCount(1);expect((await commerceMediaIndex(frame)).works[0].id).toBe(before.works[0].id);expect(orkas.modelRequests).toHaveLength(1);expect(await orkas.electronApp!.evaluate(()=>(globalThis as any).__commerceFault.starts)).toBe(1);
 }finally{await orkas.electronApp!.evaluate(()=>(globalThis as any).__commerceFault?.restore());await orkas.closePreview(preview);}
});

test('keeps the composed creator localized, keyboard accessible and usable in narrow windows without losing a draft',async({modelOrkas:orkas},info)=>{
 const{preview,frame,creator}=await openCommerceCreator(orkas);await creator.locator('#brief').fill('Preserve this Commerce draft.');await expect(creator.locator('#save-state')).toHaveText('已保存');
 const locales=await orkas.electronApp!.evaluate(async(_electron:any,module:string)=>(process as any).mainModule.require(module).SUPPORTED_LANGS,path.resolve(__dirname,'../../src/main/i18n.ts'));
 for(const language of locales){
  await orkas.page!.evaluate(language=>(window as any).setLang(language),language);await frame.locator('body').evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(creator.locator('html')).toHaveAttribute('lang',language);await expect(creator.locator('#brief')).toHaveValue('Preserve this Commerce draft.');
  const expected=await frame.locator('body').evaluate(()=>{const w=window as any;return w.ListingLocaleRows[document.documentElement.lang].split('|')[w.ListingLocaleKeys.indexOf('associateProduct')];});await expect(creator.locator('#product-association-label')).toHaveText(expected);
  if(['zh','en','ar'].includes(language)){
   for(const width of language==='zh'?[1400,1000]:language==='en'?[640]:[400]){
    await preview.setViewportSize({width,height:language==='zh'?800:560});
    const nav=frame.locator('#workspace-nav'),box=(await nav.boundingBox())!,padding=await nav.evaluate(e=>{const s=getComputedStyle(e);return{left:parseFloat(s.paddingLeft),right:parseFloat(s.paddingRight)};});
    const heading=(await creator.locator('.page-head').boundingBox())!,tabs=(await creator.locator('.media-tabs').boundingBox())!,first=(await frame.locator('#workspace-nav button').first().boundingBox())!;
    const column={box,padding,heading,tabs,first,outer:await frame.locator('body').evaluate(e=>({width:e.clientWidth,viewport:innerWidth,root:document.documentElement.clientWidth,gutter:getComputedStyle(document.documentElement).getPropertyValue('--creator-scrollbar-width'),topbar:getComputedStyle(document.querySelector('.topbar')!).paddingInlineEnd})),inner:await creator.locator('body').evaluate(e=>({width:e.clientWidth,viewport:innerWidth,root:document.documentElement.clientWidth,body:e.getBoundingClientRect()}))};
    writeFileSync(info.outputPath('creation-column-'+language+'-'+width+'.json'),JSON.stringify(column));
    await info.attach('creation-column-'+language+'-'+width,{body:JSON.stringify(column),contentType:'application/json'});
    await preview.screenshot({path:info.outputPath('creation-column-'+language+'-'+width+'.png')});
    // Both navigation levels and the creation content share the same column edges.
    expect(Math.abs(box.x-tabs.x)).toBeLessThanOrEqual(1);expect(Math.abs(box.width-tabs.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.x+padding.left-heading.x)).toBeLessThanOrEqual(1);expect(Math.abs(box.x+box.width-padding.right-heading.x-heading.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(language==='ar'?first.x+first.width-heading.x-heading.width:first.x-heading.x)).toBeLessThanOrEqual(1);
    expect(await creator.locator('body').evaluate(e=>e.scrollWidth<=e.clientWidth)).toBe(true);await expect(creator.locator('#product-association')).toBeHidden();await preview.screenshot({path:info.outputPath('commerce-creator-'+language+'-'+width+'.png')});
    await frame.locator('button[data-view="stores"]').click();
    await expect(frame.locator('#stores-page')).toBeVisible();
    const store=(await frame.locator('#stores-page').boundingBox())!,storeFirst=(await frame.locator('#workspace-nav button').first().boundingBox())!;
    const storeNav=(await nav.boundingBox())!;
    // Switching between Stores and creation must keep the same navigation and content column.
    expect(Math.abs(storeNav.x-box.x)).toBeLessThanOrEqual(1);expect(Math.abs(storeNav.width-box.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(store.x-heading.x)).toBeLessThanOrEqual(1);expect(Math.abs(store.width-heading.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(language==='ar'?storeFirst.x+storeFirst.width-store.x-store.width:storeFirst.x-store.x)).toBeLessThanOrEqual(1);
    expect(await frame.locator('body').evaluate(e=>e.scrollWidth<=e.clientWidth)).toBe(true);await preview.screenshot({path:info.outputPath('commerce-stores-'+language+'-'+width+'.png')});
    await frame.locator('button[data-view="creative"]').click();await expect(creator.locator('#brief')).toHaveValue('Preserve this Commerce draft.');
   }
  }
 }
 await creator.locator('#nav-video').focus();await creator.locator('#nav-video').press('End');await expect(creator.locator('#nav-library')).toHaveAttribute('aria-selected','true');await expect(creator.locator('#nav-audio')).toBeHidden();expect(orkas.modelRequests).toHaveLength(0);await orkas.closePreview(preview);
});

test('creates product copy from core content in the shared workspace with only Stores and Media creation navigation',async({modelOrkas:orkas},info)=>{
 const {card,preview,frame,creator}=await openCommerceCreator(orkas);
 await expect(frame.locator('#workspace-nav button')).toHaveText(['店铺管理','素材制作']);await expect(frame.locator('button[data-view="products"]')).toHaveCount(0);await expect(frame.locator('#catalog')).toBeHidden();
 await expect(creator.locator('.media-tabs button:visible')).toHaveText(['文案','图片','视频','素材库']);await expect(creator.locator('#nav-copy')).toHaveAttribute('aria-selected','true');await expect(creator.locator('#brief')).toHaveAccessibleName('核心内容');
 for(const id of ['service-field','aspect-field','duration-field'])await expect(creator.locator('#'+id)).toBeHidden();
 const brief='500ml 不锈钢保温杯，适合通勤，写一段简洁的商品介绍。',copy='通勤路上，随手带上温暖。500ml 不锈钢保温杯，装下每天的从容。';
 await creator.locator('#brief').fill(brief);await creator.locator('#nav-image').click();await creator.locator('#brief').fill('保留图片制作要求');await creator.locator('#nav-copy').click();await expect(creator.locator('#brief')).toHaveValue(brief);
 await preview.screenshot({path:info.outputPath('commerce-copy-input-zh.png')});orkas.setModelTextReplies([copy]);await creator.locator('#submit').click();await expect.poll(async()=>(await commerceMediaIndex(frame))?.works[0]?.status,{timeout:60000}).toBe('completed');await expect.poll(async()=>(await commerceMediaIndex(frame))?.works[0]?.resultAssetIds.length).toBe(1);
 const state=await commerceMediaIndex(frame);expect(state.works[0].kind).toBe('copy');await creator.locator('.record-summary').click();await expect.poll(()=>creator.locator('#record-detail').evaluate(e=>e.innerText.trim())).toBe('reply.txt');await expect(creator.locator('.history-row').getByText(brief,{exact:true})).toHaveCount(1);await creator.locator('.result-file .attachment-preview').click();await expect(creator.locator('#media-content')).toHaveText(copy);await creator.locator('#media-close').click();
 expect(await frame.locator('body').evaluate(async()=>((await(window as any).orkasApp.storage.get({key:'listing-index-v1',scope:'cloud'})).value))).toBeNull();
 await creator.locator('#brief').fill('下一条文案的核心内容');await expect(creator.locator('#save-state')).toHaveText('已保存');await preview.screenshot({path:info.outputPath('commerce-copy-result-zh.png')});await orkas.closePreview(preview);
 const reopened=await orkas.openPreview(()=>card.click()),again=reopened.frameLocator('.saved-app-viewer-frame');await again.locator('button[data-view="creative"]').click();const restored=again.frameLocator('#media-workspace');await expect(restored.locator('#brief')).toHaveValue('下一条文案的核心内容');await expect(restored.locator('.history-row')).toHaveCount(1);await restored.locator('.record-summary').click();await expect.poll(()=>restored.locator('#record-detail').evaluate(e=>(e as HTMLElement).innerText.trim())).toBe('reply.txt');await restored.locator('.result-file .attachment-preview').click();await expect(restored.locator('#media-content')).toHaveText(copy);await restored.locator('#media-close').click();await restored.locator('#nav-image').click();await expect(restored.locator('#brief')).toHaveValue('保留图片制作要求');await expect(restored.locator('.history-row')).toHaveCount(0);
 for(const [lang,width]of [['en',640],['ar',400]]as const){await orkas.page!.evaluate(lang=>(window as any).setLang(lang),lang);await reopened.setViewportSize({width,height:680});await again.locator('body').evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(restored.locator('html')).toHaveAttribute('lang',lang);await restored.locator('#nav-copy').click();await expect(restored.locator('#brief')).toBeEnabled();await expect(restored.locator('#brief')).toHaveValue('下一条文案的核心内容');await restored.locator('.record-summary').click();await expect(restored.locator('#record-detail')).toBeVisible();await expect.poll(()=>restored.locator('#record-detail').evaluate(e=>(e as HTMLElement).innerText.trim())).toBe('reply.txt');expect(await restored.locator('body').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);await reopened.screenshot({path:info.outputPath('commerce-copy-'+lang+'.png')});}
 expect(orkas.modelRequests).toHaveLength(1);await orkas.closePreview(reopened);
});
test('shows only the generated copy file instead of the completion message and keeps preview and material saving',async({modelOrkas:orkas},info)=>{
 const{card,preview,frame,creator}=await openCommerceCreator(orkas),brief='口红，妖艳',name='口红文案.txt',copy='一抹浓艳，点亮你的主场。',completion='已生成妖艳风口红文案：'+name;let written=false;
 orkas.setModelRequestScript((_request,tools)=>{
  if(!tools.has('write_file'))return{calls:[{callId:'load-copy-output',name:'tool_load',args:{groups:['workspace.write.output']}}]};
  if(!written){written=true;return{calls:[{callId:'write-copy',name:'write_file',args:{path:name,content:copy}}]};}
  return{text:completion};
 });
 await creator.locator('#brief').fill(brief);await creator.locator('#submit').click();await expect.poll(async()=>(await commerceMediaIndex(frame))?.works[0]?.resultAssetIds.length,{timeout:60000}).toBe(1);await creator.locator('.record-summary').click();
 await expect.poll(()=>creator.locator('#record-detail').evaluate(e=>e.innerText.trim())).toBe(name);await expect(creator.locator('.history-row').getByText(brief,{exact:true})).toHaveCount(1);await creator.locator('.result-file .attachment-preview').click();await expect(creator.locator('#media-content')).toHaveText(copy);await creator.locator('#media-close').click();
 await creator.locator('.result-menu-trigger').click();await creator.locator('#record-menu').getByRole('menuitem',{name:'保存为素材',exact:true}).click();await expect(creator.locator('.result-file [data-save-location]')).toHaveText('已保存');expect((await commerceMediaIndex(frame)).assets.filter((a:any)=>a.name===name&&a.libraryHidden===false)).toHaveLength(1);
 await preview.screenshot({path:info.outputPath('commerce-copy-file-only-zh.png')});await orkas.closePreview(preview);
 const reopened=await orkas.openPreview(()=>card.click()),outer=reopened.frameLocator('.saved-app-viewer-frame');await outer.locator('button[data-view="creative"]').click();const restored=outer.frameLocator('#media-workspace');await restored.locator('.record-summary').click();await expect.poll(()=>restored.locator('#record-detail').evaluate(e=>(e as HTMLElement).innerText.trim())).toBe(name);
 const saved=await outer.locator('body').evaluate(async()=>{const api=(window as any).orkasApp,index=(await api.storage.get({key:'content-index-v1',scope:'cloud'})).value;return JSON.parse((await api.appFiles.readText({path:'works/'+index.works[0].id+'.json',scope:'cloud'})).text);});expect(saved.jobs[0].text).toBe(completion);expect(saved.results).toHaveLength(1);await orkas.closePreview(reopened);
});
test('preserves existing product facts and references while creation and library adoption stay optional without a product manager',async({modelOrkas:orkas},info)=>{
 let{card,preview,frame,creator}=await openCommerceCreator(orkas);
 const png='iVBORw0KGgoAAAANSUhEUgAAAAQAAAAFCAYAAABirU3bAAAAEklEQVR4nGMISNnyHxkzUEEAAOMaMA0yqcWAAAAAAElFTkSuQmCC';
 const product={id:'legacy-product',name:'旧商品旅行杯',facts:'500 ml',revision:1,copy:{title:'旅行杯',description:'原商品文案',bullets:[]},assets:[{id:'legacy-source',name:'legacy-reference.png',path:'media/legacy-reference.png',kind:'image',selected:true}],versions:[],jobs:[],attempts:[]};
 await frame.locator('body').evaluate(async(_el,{product,png})=>{const api=(window as any).orkasApp;await api.appFiles.writeBase64({path:'media/legacy-reference.png',base64:png,scope:'cloud'});await api.appFiles.writeText({path:'products/'+product.id+'.json',text:JSON.stringify(product),scope:'cloud'});await api.storage.set({key:'listing-index-v1',value:[{id:product.id,name:product.name,sku:'',listings:[]}],scope:'cloud'});},{product,png});
 await orkas.closePreview(preview);preview=await orkas.openPreview(()=>card.click());frame=preview.frameLocator('.saved-app-viewer-frame');await frame.locator('button[data-view="creative"]').click();creator=frame.frameLocator('#media-workspace');await creator.locator('#nav-image').click();await creator.locator('#product-association button').click();await creator.getByRole('option',{name:'旧商品旅行杯',exact:true}).click();await creator.locator('#brief').fill('根据商品资料制作宣传图');await creator.locator('#add-material').click();await creator.locator('#product-references').click();await frame.locator('#picker-options button').filter({hasText:'legacy-reference.png'}).click();await expect(creator.locator('#selected-assets')).toContainText('legacy-reference.png');
 await stageCommerceImage(orkas);orkas.setModelTextReplies(['Image generated.']);await creator.locator('#submit').click();await expect.poll(async()=>(await commerceMediaIndex(frame)).works[0]?.status,{timeout:60000}).toBe('completed');
 const request=await frame.locator('body').evaluate(async()=>{const api=(window as any).orkasApp,files=(await api.appFiles.list({scope:'cloud'})).files;return JSON.parse((await api.appFiles.readText({path:files.find((file:any)=>file.path.startsWith('requests/')).path,scope:'cloud'})).text);});expect(request.product).toMatchObject({id:product.id,name:product.name,facts:'500 ml'});expect(request.sources).toHaveLength(1);
 await creator.locator('#product-history-filter button').click();await creator.getByRole('option',{name:'不关联商品',exact:true}).click();await expect(creator.locator('.history-row')).toHaveCount(0);await creator.locator('#product-history-filter button').click();await creator.getByRole('option',{name:'全部商品',exact:true}).click();await expect(creator.locator('.history-row')).toHaveCount(1);
 await creator.locator('.record-summary').click();const resultFile=creator.locator('.result-file').filter({hasText:'studio-result.png'});await resultFile.hover();await resultFile.locator('.result-menu-trigger').click();await creator.locator('#record-menu').getByRole('menuitem',{name:'保存为素材',exact:true}).click();await creator.locator('#nav-library').click();await expect(creator.locator('#library-product-actions')).toBeHidden();await creator.locator('.library-card').filter({hasText:'studio-result.png'}).locator('input').check();await expect(creator.locator('.library-use-actions #assign-product-media')).toHaveCount(0);
 await orkas.electronApp!.evaluate((_electron,module)=>{const runtime=(process as any).mainModule.require(module).runtime,original=runtime.execute;runtime.execute=async function(...args:any[]){if(args[1]==='appFiles.writeText'&&args[2].path.startsWith('products/')){runtime.execute=original;throw new ((process as any).mainModule.require(module.replace('host.ts','runtime.ts')).AppError)('E_DATA');}return original.apply(this,args);};},path.resolve(__dirname,'../../src/main/features/web_apps/host.ts'));
 await creator.locator('#assign-product-media').click();await expect(creator.locator('#product-media-feedback')).toContainText('未保存');expect((await commerceProduct(frame,product.name)).assets).toHaveLength(1);await creator.locator('#assign-product-media').click();await expect(creator.locator('#product-media-feedback')).toHaveText('已保存');await creator.locator('#assign-product-media').click();const retained=await commerceProduct(frame,product.name);expect(retained.assets).toHaveLength(2);expect(retained.assets[0]).toMatchObject(product.assets[0]);expect(retained.copy).toEqual(product.copy);expect(retained.attempts).toHaveLength(0);await preview.screenshot({path:info.outputPath('commerce-legacy-context-library.png')});expect(orkas.modelRequests).toHaveLength(1);await orkas.closePreview(preview);
});

test('keeps core copy input after a failed request save and retries once without hidden dispatch',async({modelOrkas:orkas})=>{
 const{preview,frame,creator}=await openCommerceCreator(orkas);const brief='写一段适合通勤人群的旅行杯商品介绍。';await creator.locator('#brief').fill(brief);
 await orkas.electronApp!.evaluate((_electron,module)=>{const runtime=(process as any).mainModule.require(module).runtime,original=runtime.execute;runtime.execute=async function(...args:any[]){if(args[1]==='appFiles.writeText'&&args[2].path.startsWith('requests/')){runtime.execute=original;throw new ((process as any).mainModule.require(module.replace('host.ts','runtime.ts')).AppError)('E_DATA');}return original.apply(this,args);};},path.resolve(__dirname,'../../src/main/features/web_apps/host.ts'));
 orkas.setModelTextReplies(['为通勤带上你的旅行杯。']);await creator.locator('#submit').click();await expect(creator.locator('#notice')).not.toBeEmpty();await expect(creator.locator('#brief')).toHaveValue(brief);await expect(creator.locator('#submit')).toBeEnabled();expect(orkas.modelRequests).toHaveLength(0);await creator.locator('#submit').click();await expect.poll(async()=>(await commerceMediaIndex(frame)).works[0]?.status,{timeout:60000}).toBe('completed');expect((await commerceMediaIndex(frame)).works).toHaveLength(1);expect(orkas.modelRequests).toHaveLength(1);await orkas.closePreview(preview);
});

test('explains an unsupported store connection entry and recovers without changing the creation draft',async({modelOrkas:orkas},info)=>{
 await orkas.electronApp!.evaluate((_electron,module)=>{const runtime=(process as any).mainModule.require(module).runtime,original=runtime.dispatch,state={oldHost:true};(globalThis as any).__oldCommerceHost=state;runtime.dispatch=async function(...args:any[]){if(args[2]==='__builtin.openConnectors'&&state.oldHost)throw new ((process as any).mainModule.require(module.replace('host.ts','runtime.ts')).AppError)('E_METHOD');return original.apply(this,args);};},path.resolve(__dirname,'../../src/main/features/web_apps/host.ts'));
 const{preview,frame,creator}=await openCommerceCreator(orkas);await creator.locator('#brief').fill('连接恢复后保留的核心内容');await frame.locator('button[data-view="stores"]').click();await frame.locator('#connect-store').click();await expect(frame.locator('#notice')).toContainText('重启 Orkas');await expect(frame.locator('#connect-store')).toBeEnabled();
 await orkas.page!.evaluate(()=>(window as any).setLang('en'));await preview.setViewportSize({width:480,height:450});await frame.locator('body').evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(frame.locator('#notice')).toContainText('Restart Orkas');await preview.screenshot({path:info.outputPath('commerce-old-host-recovery-en.png')});
 await orkas.electronApp!.evaluate(()=>(globalThis as any).__oldCommerceHost.oldHost=false);await frame.locator('#connect-store').click();await expect(orkas.page!.locator('#panel-connectors')).toBeVisible();await frame.locator('button[data-view="creative"]').click();await expect(creator.locator('#brief')).toHaveValue('连接恢复后保留的核心内容');expect(orkas.modelRequests).toHaveLength(0);await orkas.closePreview(preview);
});

test('keeps core content when ContentWriter is unavailable and enables explicit creation after refreshing it',async({modelOrkas:orkas})=>{
 await orkas.electronApp!.evaluate((_electron,module)=>{const runtime=(process as any).mainModule.require(module).runtime,original=runtime.execute,state={missing:true};(globalThis as any).__copyAgentAvailability=state;runtime.execute=async function(...args:any[]){const result=await original.apply(this,args);if(args[1]==='tasks.agents'&&state.missing)return{...result,agents:result.agents.filter((agent:any)=>agent.id!=='173d4235a431')};return result;};},path.resolve(__dirname,'../../src/main/features/web_apps/host.ts'));
 const{preview,creator}=await openCommerceCreator(orkas);await creator.locator('#brief').fill('保留尚未提交的商品核心内容');await expect(creator.locator('#submit')).toBeDisabled();await expect(creator.locator('#agent-state')).toContainText('ContentWriter');await expect(creator.locator('#refresh-agents')).toBeVisible();
 await orkas.electronApp!.evaluate(()=>(globalThis as any).__copyAgentAvailability.missing=false);await creator.locator('#refresh-agents').click();await expect(creator.locator('#submit')).toBeEnabled();await expect(creator.locator('#brief')).toHaveValue('保留尚未提交的商品核心内容');await expect(creator.locator('#agent-state')).toBeEmpty();expect(orkas.modelRequests).toHaveLength(0);await orkas.closePreview(preview);
});
