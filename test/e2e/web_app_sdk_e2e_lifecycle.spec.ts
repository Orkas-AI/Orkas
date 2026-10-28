import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { openSidebarEntry, expect, test } from './fixtures/orkas';


test('web app common data survives closing and reopening while host inference remains unavailable',async({orkas},testInfo)=>{
  const definition={version:1,tables:[{id:'notes',name:'notes',fields:[{id:'body',name:'body',type:'string'}],access:{read:['body'],insert:['body'],count:true}}]};
  const app=await orkas.electronApp!.evaluate(async(_electron,input)=>{
    const main=(process as any).mainModule,artifacts=main.require(input.artifacts),saved=main.require(input.saved),chats=main.require(input.chats);const task=await chats.createConversation('account-e2e',{title:'Cloud data'});
    const result=await artifacts.createArtifact('account-e2e',task.conversation_id,'helper',{appType:'web',files:[{path:'index.html',content:'<!doctype html><html><head><script src="/__orkas/sdk.js"></script></head><body><h1>Cloud notes</h1><input aria-label="Note"><button id="save">Save note</button><output></output><script>const refresh=async()=>{const value=await orkasApp.data.query({table:"notes"});document.querySelector("output").textContent=value.records.map(record=>record.body).join(";")||"Empty";};document.getElementById("save").onclick=async()=>{await orkasApp.data.insert({table:"notes",values:{body:document.querySelector("input").value}});await refresh();};refresh();</script></body></html>'},{path:'orkas-app.json',content:JSON.stringify({sdkVersion:1,capabilities:['data'],data:input.definition})}]});if(!result.ok)throw new Error(result.error);return saved.saveFromArtifact('account-e2e',task.conversation_id,result.artifactId);
  },{artifacts:path.resolve('src/main/features/chat_artifacts.ts'),saved:path.resolve('src/main/features/saved_apps.ts'),chats:path.resolve('src/main/features/chats.ts'),definition});
  if(!app.ok)throw new Error(app.error);await openSidebarEntry(orkas.page,'#apps-btn');let preview=await orkas.openPreview(()=>orkas.page.locator(`.app-card[data-app-id="${app.id}"]`).click());let frame=preview.locator('.saved-app-viewer-frame').contentFrame();await expect(frame.locator('output')).toHaveText('Empty');await frame.getByLabel('Note').fill('Retained locally');await frame.getByRole('button',{name:'Save note'}).click();await expect(frame.locator('output')).toHaveText('Retained locally');
  expect(await frame.locator('body').evaluate(()=>(window as any).orkasApp.ai)).toBeUndefined();await orkas.closePreview(preview);preview=await orkas.openPreview(()=>orkas.page.locator(`.app-card[data-app-id="${app.id}"]`).click());frame=preview.locator('.saved-app-viewer-frame').contentFrame();await expect(frame.locator('output')).toHaveText('Retained locally');await preview.screenshot({path:testInfo.outputPath('cloud-local-data.png')});expect(orkas.modelRequests).toHaveLength(0);
});

test('a closed saved app retains its records after a compatible update and process restart', async ({ orkas }, testInfo) => {
  const definition = { version: 1, tables: [{ id: 'loans', name: 'loans', fields: [
    { id: 'borrower', name: 'borrower', type: 'string' },
    { id: 'item', name: 'item', type: 'string' },
  ], access: { read: ['borrower', 'item'], insert: ['borrower', 'item'] } }] };
  const html = (revision: number) => `<!doctype html><html><head><script src="/__orkas/sdk.js"></script></head><body>
    <h1>Loan register ${revision}</h1><label>Borrower <input id="borrower"></label><label>Item <input id="item"></label>
    <button id="save">Record loan</button><output></output><script>
    const refresh=async()=>{const result=await orkasApp.data.query({table:'loans'});
      document.querySelector('output').textContent=JSON.stringify(result.records);};
    document.getElementById('save').onclick=async()=>{await orkasApp.data.insert({table:'loans',values:{
      borrower:document.getElementById('borrower').value,item:document.getElementById('item').value}});await refresh();};
    refresh();</script></body></html>`;
  const entry = orkas.createWorkspaceFile('loans/index.html', html(1));
  orkas.createWorkspaceFile('loans/orkas-app.json', JSON.stringify({ sdkVersion: 1, capabilities: ['data'], data: definition }));
  const app: any = await orkas.invoke('savedApps.saveFromPath', { path: entry, title: 'Loan register', mode: 'auto' });
  expect(app.ok).toBe(true);
  const row = { borrower: `Borrower ${randomUUID()}`, item: 'Radio 7' };
  await openSidebarEntry(orkas.page, '#apps-btn');
  let preview = await orkas.openPreview(() => orkas.page.locator(`.app-card[data-app-id="${app.id}"]`).click());
  let frame = preview.locator('.saved-app-viewer-frame').contentFrame();
  await frame.getByLabel('Borrower').fill(row.borrower);
  await frame.getByLabel('Item', { exact: true }).fill(row.item);
  await frame.getByRole('button', { name: 'Record loan' }).click();
  await expect(frame.locator('output')).toHaveText(JSON.stringify([row]));
  await orkas.closePreview(preview);
  writeFileSync(entry, html(2));
  const updated: any = await orkas.invoke('savedApps.saveFromPath', { path: entry, mode: 'auto' });
  expect(updated).toMatchObject({ ok: true, id: app.id });
  await orkas.relaunch();
  await openSidebarEntry(orkas.page, '#apps-btn');
  const listed: any = await orkas.invoke('savedApps.list');
  expect(listed.apps.map((value: any) => value.id)).toEqual([app.id]);
  preview = await orkas.openPreview(() => orkas.page.locator(`.app-card[data-app-id="${app.id}"]`).click());
  frame = preview.locator('.saved-app-viewer-frame').contentFrame();
  await expect(frame.getByRole('heading')).toHaveText('Loan register 2');
  await expect(frame.locator('output')).toHaveText(JSON.stringify([row]));
  const heading = await frame.getByRole('heading').innerText();
  const visible = JSON.parse((await frame.locator('output').textContent())!);
  await orkas.closePreview(preview);
  const persisted = await orkas.electronApp!.evaluate(async (_electron, input) => {
    const main = (process as any).mainModule, { LocalAppData } = main.require(input.module);
    const paths = main.require(input.paths), crypto = main.require('node:crypto');
    const key = crypto.createHash('sha256').update(JSON.stringify(['saved', input.id])).digest('hex');
    const database = new LocalAppData(paths.webAppSandboxRoot('account-e2e', key, 'local') + '/data.sqlite',
      paths.userLocalRoot('account-e2e'), input.definition);
    try { return await database.call('data.query', { table: 'loans' }); }
    finally { await database.close(); }
  }, { id: app.id, definition, module: path.resolve('src/main/features/web_apps/data.ts'), paths: path.resolve('src/main/paths.ts') });
  expect(persisted).toEqual({ records: [row] });
  // A success-looking rendered row alone must not hide skipped writes,
  // duplicate side effects, or stale code at this same consumer boundary.
  const correct = { ids: listed.apps.map((value: any) => value.id), heading, records: persisted.records, visible };
  const accepts = (value: typeof correct) => value.ids.length === 1 && value.ids[0] === app.id && value.heading === 'Loan register 2'
    && JSON.stringify(value.records) === JSON.stringify([row]) && JSON.stringify(value.visible) === JSON.stringify([row]);
  expect(accepts(correct)).toBe(true);
  const controls = [
    { name: 'correct', expected: true, value: correct },
    { name: 'false-success-without-persisted-record', expected: false, value: { ...correct, records: [] } },
    { name: 'duplicate-effect', expected: false, value: { ...correct, records: [row, row] } },
    { name: 'stale-consumer', expected: false, value: { ...correct, heading: 'Loan register 1' } },
  ].map(({ name, expected, value }) => ({ name, expected, accepted: accepts(value) }));
  expect(controls.every(control => control.expected === control.accepted)).toBe(true);
  await testInfo.attach('native-record-controls', { body: JSON.stringify(controls), contentType: 'application/json' });
  expect(orkas.modelRequests).toHaveLength(0);
});

test('author can export, cancel, and explicitly clear incompatible local data before updating',async({orkas},testInfo)=>{
  const state=await orkas.electronApp!.evaluate(async({dialog},input)=>{
    const main=(process as any).mainModule,artifacts=main.require(input.artifacts),saved=main.require(input.saved),chats=main.require(input.chats),{LocalAppData}=main.require(input.data),paths=main.require(input.paths),crypto=main.require('node:crypto');
    const uid='account-e2e',definition={version:1,tables:[{id:'notes',name:'notes',fields:[{id:'body',name:'body',type:'string'}],access:{read:['body'],insert:['body']}}]};
    const task=await chats.createConversation(uid,{title:'Local migration'});const make=(cid:string,text:string,data:any)=>artifacts.createArtifact(uid,cid,'helper',{files:[{path:'index.html',content:'<h1>'+text+'</h1>'},{path:'orkas-app.json',content:JSON.stringify({sdkVersion:1,capabilities:['data'],data})}]});
    const original=await make(task.conversation_id,'Original',definition),app=await saved.saveFromArtifact(uid,task.conversation_id,original.artifactId);const key=crypto.createHash('sha256').update(JSON.stringify(['saved',app.id])).digest('hex'),file=paths.webAppSandboxRoot(uid,key,'local')+'/data.sqlite';
    const db=new LocalAppData(file,paths.userLocalRoot(uid),definition);await db.call('data.insert',{table:'notes',values:{body:'KEEP'}});await db.close();const edit=await saved.openForEditing(uid,app.id),cid=edit.conversation.conversation_id;
    const changed=await make(cid,'Updated',{version:1,tables:[]});(dialog as any).showSaveDialog=async()=>({canceled:false,filePath:input.exported});return {cid,artifactId:changed.artifactId,appId:app.id,file,definition};
  },{artifacts:path.resolve('src/main/features/chat_artifacts.ts'),saved:path.resolve('src/main/features/saved_apps.ts'),chats:path.resolve('src/main/features/chats.ts'),data:path.resolve('src/main/features/web_apps/data.ts'),paths:path.resolve('src/main/paths.ts'),exported:path.join(orkas.workspaceRoot,'migration-export.sqlite')});
  const page=orkas.page;await openSidebarEntry(page,'#apps-btn');await page.locator(`.app-card[data-app-id="${state.appId}"]`).hover();await page.locator(`.app-card[data-app-id="${state.appId}"] .app-card-more`).click();await page.locator('.app-row-menu-item[data-action="edit"]').click();
  // Render the actual immutable edit result without paying a model provider.
  await page.evaluate(state=>{const host=document.createElement('div');host.id='migration-result';document.querySelector('#panel-conversation')?.append(host);(window as any).renderChatArtifact(host,{cid:state.cid,artifactId:state.artifactId,title:'Updated'});},state);
  const update=async()=>{await page.locator('#migration-result .chat-artifact-more').click();await expect(page.locator('.chat-artifact-menu [data-action="update"]')).toBeVisible();await page.locator('.chat-artifact-menu [data-action="update"]').click();};
  await update();await expect(page.locator('.ui-dialog-overlay:visible')).toContainText('notes: 1');await page.locator('.ui-dialog-overlay:visible [data-act="ok"]').click();await expect(page.locator('.ui-dialog-overlay:visible')).toContainText('Clear all local records');await page.locator('.ui-dialog-overlay:visible').screenshot({path:testInfo.outputPath('migration-confirmation.png')});await page.locator('.ui-dialog-overlay:visible [data-act="cancel"]').click();
  const read=()=>orkas.electronApp!.evaluate(async(_electron,input)=>{const {LocalAppData}=(process as any).mainModule.require(input.module);const db=new LocalAppData(input.file,input.boundary,input.definition);try{return await db.call('internal.inspect',{});}finally{await db.close();}},{module:path.resolve('src/main/features/web_apps/data.ts'),file:state.file,boundary:path.join(orkas.workspaceRoot,'account-e2e/local'),definition:state.definition});expect((await read()).records).toBe(1);
  await update();await page.locator('.ui-dialog-overlay:visible [data-act="cancel"]').click();await page.locator('.ui-dialog-overlay:visible [data-act="ok"]').click();await expect(page.locator('.ui-dialog-overlay:visible')).toHaveCount(0);
  await expect.poll(async()=>orkas.electronApp!.evaluate(({ },input)=>(process as any).mainModule.require('node:fs').readFileSync(input,'utf8'),path.join(orkas.workspaceRoot,'account-e2e/cloud/saved_apps',state.appId,'index.html'))).toContain('Updated');
  const exported=await orkas.electronApp!.evaluate(async(_electron,input)=>{const {LocalAppData}=(process as any).mainModule.require(input.module);const db=new LocalAppData(input.file,input.boundary,input.definition);try{return await db.call('data.query',{table:'notes'});}finally{await db.close();}},{module:path.resolve('src/main/features/web_apps/data.ts'),file:path.join(orkas.workspaceRoot,'migration-export.sqlite'),boundary:orkas.workspaceRoot,definition:state.definition});expect(exported).toEqual({records:[{body:'KEEP'}]});expect(orkas.modelRequests).toHaveLength(0);
});

// The document starts real SDK inference while an unrelated image keeps its
// first load pending. Load completion must not cancel that same document's work.
test('SDK inference survives initial document load and a throwing progress consumer', async ({ modelOrkas: orkas }) => {
  let releaseImage!: () => void;
  const imageGate = new Promise<void>(resolve => { releaseImage = resolve; });
  let requested = false;
  await orkas.page.context().route('**/load-gate.svg', async route => {
    requested = true;
    await imageGate;
    await route.continue();
  });
  const entry = orkas.createWorkspaceFile('load-race/index.html', `<!doctype html><html><head>
    <script src="/__orkas/sdk.js"></script></head><body><h1>Loading notebook</h1>
    <p role="status">Generating</p><img src="load-gate.svg" alt="">
    <script>
      window.finishedLoading = false; window.progressCalls = 0;
      window.addEventListener('load', () => { window.finishedLoading = true; });
      window.orkasApp.ai.generate({prompt:'Controlled stream',maxTokens:128}, {
        onProgress: () => { window.progressCalls++; throw new Error('App progress renderer failed'); }
      }).then(result => { document.querySelector('[role=status]').textContent = result.text; },
        error => { document.querySelector('[role=status]').textContent = error.code; });
    </script></body></html>`);
  orkas.createWorkspaceFile('load-race/load-gate.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
  orkas.createWorkspaceFile('load-race/orkas-app.json', JSON.stringify({ sdkVersion: 1, capabilities: ['ai'] }));
  await orkas.electronApp!.evaluate(({ dialog }) => { (dialog as any).showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
  orkas.setModelMode('controlled-slow');
  const app: any = await orkas.invoke('savedApps.saveFromPath', { path: entry, title: 'Loading notebook' });
  await openSidebarEntry(orkas.page, '#apps-btn');
  const preview = await orkas.openPreview(() => orkas.page.locator(`.app-card[data-app-id="${app.id}"]`).click());
  const frame = preview.locator('.saved-app-viewer-frame').contentFrame();
  try {
    await expect.poll(() => requested).toBe(true);
    await expect.poll(() => orkas.modelRequests.length).toBe(1);
    expect(await frame.locator('body').evaluate(() => (window as any).finishedLoading)).toBe(false);
    releaseImage();
    await expect.poll(() => frame.locator('body').evaluate(() => (window as any).finishedLoading)).toBe(true);
    await expect(frame.getByRole('status')).toHaveText('Generating');
    orkas.releaseControlledModelChunk(); orkas.finishControlledModelStream();
    await expect(frame.getByRole('status')).toHaveText('Hello from the local E2E model.');
    expect(await frame.locator('body').evaluate(() => (window as any).progressCalls)).toBeGreaterThan(0);
    expect(orkas.modelRequests).toHaveLength(1);
  } finally { releaseImage(); }
});

// Same-app navigation cancels departing work without closing the application.
test('same-app navigation cancels departing inference and the replacement document can use SDK', async ({ modelOrkas: orkas }, info) => {
  await orkas.electronApp!.evaluate(async ({ dialog }, observer) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const Module = req('node:module');
    const originalLoad = Module._load;
    const profile = { startedAt: Date.now(), hostAlreadyLoaded: false, loads: [] as Array<{ name: string; ms: number; at: number }>, calls: [] as any[], restore: () => {} };
    Module._load = function (id: string, ...args: any[]) {
      const started = performance.now();
      try { return originalLoad.call(this, id, ...args); }
      finally {
        const ms = performance.now() - started;
        const normalized = String(id).replace(/\\/g, '/');
        if (ms > 20 && /core-agent/.test(normalized) && profile.loads.length < 100) {
          profile.loads.push({ name: normalized.split('/').slice(-2).join('/'), ms, at: Date.now() });
        }
      }
    };
    (globalThis as any).__webAppObserver = await req(observer).observeWebAppCalls();
    // Inspect only an already loaded host; profiling must not prewarm setup.
    const hostModule = Object.entries(Module._cache as Record<string, { exports: any }>)
      .find(([id]) => id.replace(/\\/g, '/').endsWith('/features/web_apps/host.ts'))?.[1];
    const host = hostModule?.exports.runtime?.host;
    const generate = host?.generate;
    if (typeof generate === 'function') {
      profile.hostAlreadyLoaded = true;
      host.generate = async function (...args: any[]) {
        const call = { start: Date.now(), end: null as number | null };
        profile.calls.push(call);
        try { return await generate.apply(this, args); }
        finally { call.end = Date.now(); }
      };
    }
    profile.restore = () => { Module._load = originalLoad; if (generate) host.generate = generate; };
    (globalThis as any).__webAppStartupProfile = profile;
    (dialog as any).showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  }, path.resolve(__dirname, 'fixtures/web-app-author-main.ts'));
  try {
    const entry = orkas.createWorkspaceFile('navigation-cancel/index.html', `<!doctype html><html><head>
      <script src="/__orkas/sdk.js"></script></head><body><h1>Navigation notebook</h1><p role="status">Ready</p></body></html>`);
    orkas.createWorkspaceFile('navigation-cancel/orkas-app.json', JSON.stringify({ sdkVersion: 1, capabilities: ['ai','storage'] }));
    const app: any = await orkas.invoke('savedApps.saveFromPath', { path: entry, title: 'Navigation notebook' });
    await openSidebarEntry(orkas.page, '#apps-btn');
    let preview = await orkas.openPreview(() => orkas.page.locator(`.app-card[data-app-id="${app.id}"]`).click());
    let frame = preview.locator('.saved-app-viewer-frame').contentFrame();
    await expect(frame.getByRole('heading')).toHaveText('Navigation notebook');
    orkas.setModelMode('controlled-slow');
    await frame.locator('body').evaluate(() => {
      (window as any).orkasApp.ai.generate({prompt:'Controlled stream',maxTokens:128}).then(
        (result: any) => { document.querySelector('[role=status]')!.textContent = result.text; },
        (error: any) => { document.querySelector('[role=status]')!.textContent = error.code; });
    });
    await expect.poll(() => orkas.modelRequests.length).toBe(1);
    // The resource is an existing app document, not a network fixture that can
    // accidentally bypass the owning will-frame-navigate guard.
    await frame.locator('body').evaluate(() => { location.href = location.href + '?replacement'; });
    await expect(frame.getByRole('status')).toHaveText('Ready');
    // Cold inference first performs the existing read-only host handshake.
    // Cancellation ownership is measured on inference, not that discovery call.
    await expect.poll(() => orkas.electronApp!.evaluate(() => (globalThis as any).__webAppObserver.read().filter((call:any)=>call.method==='ai.generate'))).toEqual([
      { method: 'ai.generate', ok: false, code: 'E_CANCELLED' },
    ]);
    expect(await frame.locator('body').evaluate(() => location.search)).toBe('?replacement');
    expect(await frame.locator('body').evaluate(() => (window as any).orkasApp.storage.keys())).toEqual({keys:[]});
    orkas.releaseControlledModelChunk(); orkas.finishControlledModelStream();
    await expect(frame.getByRole('status')).toHaveText('Ready');
    expect(orkas.modelRequests).toHaveLength(1);
    await orkas.closePreview(preview);
    orkas.setModelMode('success');
    preview = await orkas.openPreview(() => orkas.page.locator(`.app-card[data-app-id="${app.id}"]`).click());
    frame = preview.locator('.saved-app-viewer-frame').contentFrame();
    await expect(frame.getByRole('status')).toHaveText('Ready');
    expect(await frame.locator('body').evaluate(() => (window as any).orkasApp.ai.generate({prompt:'Explicit recovery',maxTokens:128})))
      .toMatchObject({text:'Hello from the local E2E model.',stopReason:'end_turn'});
    expect(orkas.modelRequests).toHaveLength(2);
  } finally {
    const profile = await orkas.electronApp!.evaluate(() => {
      const { restore, ...data } = (globalThis as any).__webAppStartupProfile;
      restore();
      return data;
    }).catch(() => ({ unavailable: true }));
    await info.attach('sdk-startup-profile.json', { body: JSON.stringify(profile), contentType: 'application/json' });
  }
});

// Independent page scripts begin at request 1. They must not collide after navigation.
test('local pages, reload and rejected navigation preserve the app SDK', async ({ modelOrkas: orkas }) => {
  const code = `<script src="/__orkas/sdk.js"></script><script>
    orkasApp.storage.get({key:'count'}).then(async ({value}) => {
      await orkasApp.storage.set({key:'count',value:(value || 0)+1});
      document.querySelector('output').textContent=String((value || 0)+1);
    });</script>`;
  const entry=orkas.createWorkspaceFile('multi/index.html','<!doctype html><h1>First</h1><output></output><a href="pages/second.html">Next</a>'+code);
  orkas.createWorkspaceFile('multi/pages/second.html','<!doctype html><h1>Second</h1><output></output><button onclick="location.reload()">Reload</button><a href="chat-app://saved/foreign/index.html">Forbidden</a>'+code);
  orkas.createWorkspaceFile('multi/orkas-app.json',JSON.stringify({sdkVersion:1,capabilities:['storage']}));
  const app:any=await orkas.invoke('savedApps.saveFromPath',{path:entry,title:'Pages'});
  await openSidebarEntry(orkas.page, '#apps-btn');
  const preview=await orkas.openPreview(()=>orkas.page.locator(`.app-card[data-app-id="${app.id}"]`).click());
  const frame=preview.locator('.saved-app-viewer-frame').contentFrame();
  await expect(frame.locator('output')).toHaveText('1');
  await frame.getByRole('link',{name:'Next'}).click();
  await expect(frame.getByRole('heading')).toHaveText('Second');
  await expect(frame.locator('output')).toHaveText('2');
  await frame.getByRole('button',{name:'Reload'}).click();
  await expect(frame.locator('output')).toHaveText('3');
  await frame.getByRole('link',{name:'Forbidden'}).click();
  expect(await frame.locator('body').evaluate(()=>(window as any).orkasApp.storage.get({key:'count'}))).toEqual({value:3});
  expect(orkas.modelRequests).toHaveLength(0);
});

test('a same-length source edit revokes the live SDK and protocol while reopening preserves saved data', async ({ orkas }) => {
  const entry = orkas.createWorkspaceFile('revision/index.html', '<!doctype html><h1>Revision before</h1><script src="/__orkas/sdk.js"></script>');
  orkas.createWorkspaceFile('revision/orkas-app.json', JSON.stringify({ sdkVersion: 1, capabilities: ['storage'] }));
  const app: any = await orkas.invoke('savedApps.saveFromPath', { path: entry, title: 'Source revision' });
  await openSidebarEntry(orkas.page, '#apps-btn');
  const open = () => orkas.openPreview(() => orkas.page.locator(`.app-card[data-app-id="${app.id}"]`).click());
  const preview = await open();
  const frame = preview.locator('.saved-app-viewer-frame').contentFrame();
  await expect(frame.getByRole('heading')).toHaveText('Revision before');
  expect(await frame.locator('body').evaluate(() => (window as any).orkasApp.storage.set({ key: 'value', value: 'KEEP' }))).toEqual({ saved: true });
  const mutation = await orkas.electronApp!.evaluate((_electron, input) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const fs = req('node:fs'), saved = req(input.module);
    const file = saved.resolveSavedAppFilePath('account-e2e', input.id, 'index.html');
    if (!file.ok) throw new Error('Source fixture is unavailable');
    const before = fs.readFileSync(file.absPath, 'utf8'), after = before.replace('Revision before', 'Revision after!');
    fs.writeFileSync(file.absPath, after);
    return { changed: before !== after, sameLength: Buffer.byteLength(before) === Buffer.byteLength(after) };
  }, { module: path.resolve('src/main/features/saved_apps.ts'), id: app.id });
  expect(mutation).toEqual({ changed: true, sameLength: true });
  expect(await frame.locator('body').evaluate(async () => {
    try { await (window as any).orkasApp.storage.set({ key: 'value', value: 'WRONG' }); return 'unexpected-success'; }
    catch (error: any) { return error.code; }
  })).toBe('E_CLOSED');
  expect(await frame.locator('body').evaluate(async () => (await fetch(location.href)).status)).toBe(403);
  await preview.close();
  const reopened = await open();
  const fresh = reopened.locator('.saved-app-viewer-frame').contentFrame();
  await expect(fresh.getByRole('heading')).toHaveText('Revision after!');
  expect(await fresh.locator('body').evaluate(() => (window as any).orkasApp.storage.get({ key: 'value' }))).toEqual({ value: 'KEEP' });
  expect(orkas.modelRequests).toHaveLength(0);
});

test('unavailable conversation apps show independent inline retries without modal stacks', async ({ orkas }, testInfo) => {
  const fixture = await orkas.electronApp!.evaluate(async (_electron, input) => {
    const main = (process as any).mainModule, fs = main.require('node:fs');
    const artifacts = main.require(input.artifacts), chats = main.require(input.chats);
    const task = await chats.createConversation('account-e2e', { title: 'App recovery' });
    const items = [];
    for (const title of ['Recovered form', 'Second form']) {
      const app = await artifacts.createArtifact('account-e2e', task.conversation_id, 'helper', { files: [{ path: 'index.html', content: '<h1>' + title + '</h1>' }] });
      const resolved = artifacts.resolveArtifactDir('account-e2e', task.conversation_id, app.artifactId);
      fs.renameSync(resolved.dirPath, resolved.dirPath + '.held');
      items.push({ cid: task.conversation_id, artifactId: app.artifactId, title, dir: resolved.dirPath });
    }
    return items;
  }, { artifacts: path.resolve('src/main/features/chat_artifacts.ts'), chats: path.resolve('src/main/features/chats.ts') });
  await orkas.page.evaluate(items => {
    const host = document.createElement('div'); host.id = 'recovery-cards';
    document.body.append(host); host.style.cssText = 'position:fixed;inset:60px 24px 24px;z-index:100;background:var(--bg);overflow:auto';
    for (const item of items) (window as any).renderChatArtifact(host, item);
  }, fixture);
  const cards = orkas.page.locator('#recovery-cards .chat-artifact-card');
  await expect(cards.locator('.chat-artifact-unavailable')).toHaveCount(2);
  await expect(orkas.page.locator('.ui-dialog-overlay:visible')).toHaveCount(0);
  await orkas.page.locator('#recovery-cards').screenshot({ path: testInfo.outputPath('inline-load-errors-en.png') });
  await orkas.electronApp!.evaluate((_electron, dir) => {
    const fs = (process as any).mainModule.require('node:fs'); fs.renameSync(dir + '.held', dir);
  }, fixture[0].dir);
  await cards.first().locator('.chat-artifact-unavailable button').click();
  await expect(cards.first().locator('iframe').contentFrame().getByRole('heading')).toHaveText('Recovered form');
  await expect(cards.first().locator('.chat-artifact-unavailable')).toHaveCount(0);
  await expect(cards.nth(1).locator('.chat-artifact-unavailable')).toBeVisible();
  await orkas.page.setViewportSize({ width: 820, height: 680 });
  await orkas.page.evaluate(async item => {
    await (window as any).setLang('zh');
    const host = document.querySelector('#recovery-cards')!; host.innerHTML = '';
    (window as any).renderChatArtifact(host, item);
  }, fixture[1]);
  await expect(cards.locator('.chat-artifact-unavailable button')).toHaveText('重新加载');
  await orkas.page.locator('#recovery-cards').screenshot({ path: testInfo.outputPath('inline-load-error-zh-narrow.png') });
  expect(orkas.modelRequests).toHaveLength(0);
});

test('editing source survives recycle recovery and is reclaimed only after permanent task removal', async ({ orkas }) => {
  const result = await orkas.electronApp!.evaluate(async (_electron, input) => {
    const main = (process as any).mainModule, fs = main.require('node:fs');
    const artifacts = main.require(input.artifacts), chats = main.require(input.chats);
    const saved = main.require(input.saved), recycle = main.require(input.recycle), paths = main.require(input.paths);
    const uid = 'account-e2e', task = await chats.createConversation(uid, { title: 'Edit retention' });
    const original = await artifacts.createArtifact(uid, task.conversation_id, 'helper', { files: [{ path: 'index.html', content: '<h1>Retained source</h1>' }] });
    const app = await saved.saveFromArtifact(uid, task.conversation_id, original.artifactId);
    const edit = await saved.openForEditing(uid, app.id), cid = edit.conversation.conversation_id;
    const snapshot = paths.userAppEditsDir(uid) + '/' + cid + '/snapshot/index.html';
    const contents = fs.readFileSync(snapshot, 'utf8');
    const batch = await recycle.createAppRecycleBatchForConversation(uid, cid);
    await chats.deleteConversation(uid, cid);
    const retained = fs.readFileSync(snapshot, 'utf8') === contents;
    // Exercise real module instances and competing restore/purge operations.
    const [restored] = await Promise.all([recycle.restoreRecycleBatch(uid, batch.id), recycle.deleteRecycleBatch(uid, batch.id)]);
    const recovered = fs.readFileSync(snapshot, 'utf8') === contents;
    await chats.deleteConversation(uid, cid);
    return { retained, recovered, failures: restored.failed_paths.length, removed: !fs.existsSync(snapshot), originalIntact: fs.existsSync(paths.savedAppDir(uid, app.id) + '/index.html') };
  }, { artifacts: path.resolve('src/main/features/chat_artifacts.ts'), chats: path.resolve('src/main/features/chats.ts'), saved: path.resolve('src/main/features/saved_apps.ts'), recycle: path.resolve('src/main/features/recycle_bin.ts'), paths: path.resolve('src/main/paths.ts') });
  expect(result).toEqual({ retained: true, recovered: true, failures: 0, removed: true, originalIntact: true });
  expect(orkas.modelRequests).toHaveLength(0);
});
