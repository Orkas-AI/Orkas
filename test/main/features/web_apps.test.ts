import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import nativeFs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import { MAX_TEXT_FILE_BYTES } from '../../../src/main/util/file-size-limits';
import type { WebAppRuntime, HostAdapters, Bundle } from '../../../src/main/features/web_apps/runtime';
let root: string, prev: string | undefined, uid: string, runtime: WebAppRuntime, host: HostAdapters;
let mod: typeof import('../../../src/main/features/web_apps/runtime');
let seq = 0;
const bundle = (name = 'first', capabilities = ['storage','files','ai','library','connectors']): Bundle => ({
  key: createHash('sha256').update(name).digest('hex'), title: name, entry: 'index.html',
  manifest: { sdkVersion: 1, capabilities }, resolve: () => null,
});
const open = (name = 'first', caps?: string[]) => runtime.open(uid, 1, bundle(name, caps));
const call = (token: string, method: string, args: any = {}) => runtime.call(uid, 1, token, 'q' + (++seq), method, args);
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'orkas-web-apps-')); prev = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = path.join(root, 'data'); uid = 'account-a'; seq = 0; vi.resetModules();
  host = { activeUser: () => uid, language: () => 'en', modelAvailable: () => true,
    pick: vi.fn(async () => null), save: vi.fn(async () => null),
    generate: vi.fn(async () => ({ text: 'Test', usage: { outputTokens: 1 }, stopReason: 'end_turn' })),
    tools: vi.fn(async () => [{ name: 'library', capability: 'library', description: 'Library', inputSchema: {}, execute: vi.fn(async () => ({ content: '[]' })) }]),
  };
  mod = await import('../../../src/main/features/web_apps/runtime'); runtime = new mod.WebAppRuntime(host);
});
afterEach(async () => {
  runtime.closeOwner(1); runtime.closeOwner(2);
  await runtime.drainData?.();
  if (prev === undefined) delete process.env.ORKAS_WORKSPACE_ROOT; else process.env.ORKAS_WORKSPACE_ROOT = prev;
  await fs.rm(root, { recursive: true, force: true });
});
describe('Web app capability journeys', () => {
  it('keeps another application instance usable when the first requester closes during shared SQLite startup', async () => {
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let database: import('../../../src/main/features/web_apps/data').LocalAppData;
    const close = vi.fn(async () => { await database?.close(); });
    host.dataOwner = (owner, _key, file, definition) => ({
      async open() {
        enter(); await gate;
        const { LocalAppData } = await import('../../../src/main/features/web_apps/data');
        const { userLocalRoot } = await import('../../../src/main/paths');
        database = new LocalAppData(file, userLocalRoot(owner), definition);
        await database.call('data.insert', { table: 'notes', values: { body: 'KEEP' } });
        return database;
      },
      call: (method, args) => database.call(method, args), close,
    });
    const definition = { version: 1, tables: [{ id: 'notes', name: 'notes',
      fields: [{ id: 'body', name: 'body', type: 'string' }],
      access: { read: ['body'], insert: ['body'], count: true } }] };
    const b = { ...bundle('shared-startup', ['data']), manifest: { sdkVersion: 1, capabilities: ['data'], data: definition } };
    const first = runtime.open(uid, 1, b), second = runtime.open(uid, 2, b);
    const firstResult = call(first.token, 'data.query', { table: 'notes' }).then(value => ({ value }), error => ({ error }));
    await entered;
    const secondResult = runtime.call(uid, 2, second.token, 'second-query', 'data.query', { table: 'notes' }).then(value => ({ value }), error => ({ error }));
    runtime.close(uid, 1, first.token); release();
    expect(await firstResult).toMatchObject({ error: { code: 'E_CANCELLED' } });
    expect(await secondResult).toEqual({ value: { records: [{ body: 'KEEP' }] } });
    expect(close).not.toHaveBeenCalled();
    expect(await runtime.call(uid, 2, second.token, 'second-count', 'data.count', { table: 'notes' })).toEqual({ count: 1 });
    runtime.close(uid, 2, second.token); await runtime.drainData();
    expect(close).toHaveBeenCalledOnce();
    expect(host.generate).not.toHaveBeenCalled(); expect(host.tools).not.toHaveBeenCalled();
  });

  it('closes a late SQLite owner once when its last requester departs before startup completes', async () => {
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let database: import('../../../src/main/features/web_apps/data').LocalAppData;
    const close = vi.fn(async () => { await database?.close(); });
    host.dataOwner = (owner, _key, file, definition) => ({
      async open() {
        enter(); await gate;
        const { LocalAppData } = await import('../../../src/main/features/web_apps/data');
        const { userLocalRoot } = await import('../../../src/main/paths');
        database = new LocalAppData(file, userLocalRoot(owner), definition);
        await database.call('internal.check', {}); return database;
      },
      call: (method, args) => database.call(method, args), close,
    });
    const app = runtime.open(uid, 1, { ...bundle('departing-startup', ['data']),
      manifest: { sdkVersion: 1, capabilities: ['data'], data: { version: 1, tables: [] } } });
    const pending = call(app.token, 'data.query', { table: 'notes' }).then(value => ({ value }), error => ({ error }));
    await entered; runtime.close(uid, 1, app.token); release();
    expect(await pending).toMatchObject({ error: { code: 'E_CANCELLED' } });
    await runtime.drainData(); expect(close).toHaveBeenCalledOnce();
    await expect(database.call('internal.check', {})).rejects.toMatchObject({ code: 'E_CLOSED' });
    expect(host.generate).not.toHaveBeenCalled(); expect(host.tools).not.toHaveBeenCalled();
  });

  it.each(['direct'] as const)('reopens the application database after a timed-out query stops its worker (%s owner)', async mode => {
    const { Worker } = await import('node:worker_threads');
    const definition = { version: 1, tables: [{ id: 'notes', name: 'notes',
      fields: [{ id: 'body', name: 'body', type: 'string' }],
      access: { read: ['body'], insert: ['body'], count: true } }] };
    const b = { ...bundle('stalled-query', ['data']), appType: 'web' as const, manifest: { sdkVersion: 1, capabilities: ['data'], data: definition } };
    const workers = new Set<unknown>();
    let stall = false;
    const post = Worker.prototype.postMessage;
    const spy = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (this: InstanceType<typeof Worker>, message: any, transfer?: any) {
      workers.add(this);
      // A query slower than the data.* budget never answers; the timeout stops this worker.
      if (stall && message?.method === 'data.count') { stall = false; return; }
      return post.call(this, message, transfer);
    });
    try {
      const a = runtime.open(uid, 1, b);
      await call(a.token, 'data.insert', { table: 'notes', values: { body: 'KEEP' } });
      stall = true;
      await expect(call(a.token, 'data.count', { table: 'notes' })).rejects.toMatchObject({ code: 'E_BUSY' });
      // The saved row must stay reachable from the open page and from a later instance.
      expect(await call(a.token, 'data.count', { table: 'notes' })).toEqual({ count: 1 });
      const second = runtime.open(uid, 2, b);
      expect(await runtime.call(uid, 2, second.token, 'second-query', 'data.query', { table: 'notes' })).toEqual({ records: [{ body: 'KEEP' }] });
      expect(workers.size).toBe(2);
    } finally { spy.mockRestore(); }
  });

  it('lets a web app describe the method shown in its supplied discovery example', async () => {
    const { appResource } = await import('../../../src/main/features/web_apps/resources');
    const app = runtime.open(uid, 1, { ...bundle('cloud-discovery-example', []), appType: 'web' });
    const supplied = await appResource(new Request(new URL('/__orkas/capabilities.json', app.url)), runtime);
    const document = JSON.parse(supplied!.body!);
    const example = document.methods.find((method: any) => method.name === 'capabilities.describe').example;
    expect(await call(app.token, 'capabilities.describe', example)).toMatchObject({ name: example.method });
    expect(host.generate).not.toHaveBeenCalled();
    expect(host.tools).not.toHaveBeenCalled();
  });

  it.each(['local', 'web'] as const)('serves the matching %s authoring contract and invalidates it on closure', async appType => {
    const { appResource } = await import('../../../src/main/features/web_apps/resources');
    const b = { ...bundle('catalog-' + appType, []), appType };
    const app = runtime.open(uid, 1, b);
    const request = new Request(new URL('/__orkas/capabilities.json', app.url));
    const result = await appResource(request, runtime);
    expect(result?.status).toBe(200);
    const document = JSON.parse(result!.body!);
    expect(document.manifest.starter.manifest).toBe(`@skill/web-app-sdk/assets/${appType === 'web' ? 'web' : 'starter'}/orkas-app.json`);
    expect(document.methods.some((method: any) => method.name === 'ai.generate')).toBe(appType === 'local');
    runtime.closeOwner(1);
    expect((await appResource(request, runtime))?.status).toBe(403);
  });
  it('preserves ordinary SQLite data without requiring a personal sync adapter',async()=>{
    const definition:any={version:1,tables:[{id:'notes',name:'notes',fields:[{id:'body',name:'body',type:'string'}],access:{read:['body'],insert:['body']}}]};const b=bundle('offline-data',['data']);b.appType='web';b.manifest={sdkVersion:1,capabilities:['data'],data:definition};const app=runtime.open(uid,1,b);await call(app.token,'data.insert',{table:'notes',values:{body:'local only'}});runtime.closeOwner(1);await runtime.drainData();
    const {webAppSandboxRoot}=await import('../../../src/main/paths');expect(nativeFs.existsSync(path.join(webAppSandboxRoot(uid,b.key,'local'),'data.sqlite'))).toBe(true);expect(nativeFs.existsSync(path.join(webAppSandboxRoot(uid,b.key,'cloud'),'database.snapshot'))).toBe(false);const reopened=runtime.open(uid,1,b);expect(await call(reopened.token,'data.query',{table:'notes'})).toEqual({records:[{body:'local only'}]});
  });
  it('runs real common SQLite calls with the same visitor rules and preserves formal records across reopen',async()=>{
    const definition={version:1,tables:[{id:'messages',name:'messages',fields:[{id:'body',name:'body',type:'string'}],access:{read:['body'],insert:['body'],count:true}}]};
    const b={...bundle('common',['data']),appType:'web' as const,manifest:{sdkVersion:1,capabilities:['data'],data:definition}};
    const first=runtime.open(uid,1,b);
    await call(first.token,'data.insert',{table:'messages',values:{body:'KEEP'}});
    expect(await call(first.token,'data.query',{table:'messages',fields:['body']})).toEqual({records:[{body:'KEEP'}]});
    await expect(call(first.token,'data.query',{table:'messages',fields:['private']})).rejects.toMatchObject({code:'E_PERMISSION'});
    // A generated app may sort by a reserved timestamp without declaring read
    // authority. Denial must leave the saved row available to a valid query.
    await expect(call(first.token,'data.query',{table:'messages',fields:['body'],order:{field:'createdAt',direction:'desc'}})).rejects.toMatchObject({code:'E_PERMISSION'});
    expect(await call(first.token,'data.query',{table:'messages',fields:['body']})).toEqual({records:[{body:'KEEP'}]});
    runtime.closeOwner(1);await runtime.drainData();runtime=new mod.WebAppRuntime(host);
    const reopened=runtime.open(uid,1,b);
    expect(await call(reopened.token,'data.count',{table:'messages'})).toEqual({count:1});
    const previewRoot=path.join(root,'preview-common');await fs.mkdir(previewRoot);
    const preview=new mod.WebAppRuntime(host,{storageRoot:previewRoot});const test=preview.open(uid,2,b);
    expect(await preview.call(uid,2,test.token,'preview-q','data.count',{table:'messages'})).toEqual({count:0});
    await preview.call(uid,2,test.token,'preview-w','data.insert',{table:'messages',values:{body:'TEST'}});
    preview.closeOwner(2);await preview.drainData();
    expect(await call(reopened.token,'data.count',{table:'messages'})).toEqual({count:1});
  });
  it('denies cloud host calls using trusted bundle type even after the page changes its manifest',async()=>{
    const b={...bundle('cloud',[]),appType:'web' as const};
    const opened=runtime.open(uid,1,b);
    (b.manifest as any).capabilities.push('ai','storage');
    for(const [method,args] of [['ai.generate',{prompt:'No spend'}],['storage.set',{key:'private',value:1}],['tools.list',{}]] as const)
      await expect(call(opened.token,method,args)).rejects.toMatchObject({code:'E_UNAVAILABLE'});
    expect(host.generate).not.toHaveBeenCalled();expect(host.tools).not.toHaveBeenCalled();
    const catalog=await call(opened.token,'capabilities.list');
    expect(catalog.methods.some((m:any)=>m.name.startsWith('storage.')||m.name.startsWith('ai.')||m.name.startsWith('tools.'))).toBe(false);
  });
  it('reads complete picked and sandbox files when the filesystem returns short chunks', async () => {
    const source = path.join(root, 'chunked.txt');
    const text = '完整内容 αβ — complete payload';
    await fs.writeFile(source, text);
    const a = open('chunked', ['files', 'appFiles']);
    await call(a.token, 'appFiles.writeText', { path: 'chunked.txt', text });
    host.pick = vi.fn(async () => source);
    const realOpen = nativeFs.promises.open.bind(nativeFs.promises);
    const handles: fs.FileHandle[] = [];
    const spy = vi.spyOn(nativeFs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (String(args[0]).endsWith('chunked.txt')) {
        const read = handle.read.bind(handle);
        handle.read = ((buffer: Buffer, offset: number, length: number, position: number) =>
          read(buffer, offset, Math.min(length, 2), position)) as typeof handle.read;
        handles.push(handle);
      }
      return handle;
    });
    syncBuiltinESMExports();
    try {
      const picked = await call(a.token, 'files.pick');
      expect(picked.size).toBe(Buffer.byteLength(text));
      expect(await call(a.token, 'files.readText', { handle: picked.handle })).toEqual({ text });
      expect(await call(a.token, 'appFiles.readText', { path: 'chunked.txt' })).toEqual({ text });
      expect(await call(a.token, 'appFiles.readBase64', { path: 'chunked.txt' })).toEqual({ base64: Buffer.from(text).toString('base64') });
      expect(handles).toHaveLength(3);
      expect(handles.every(handle => handle.fd === -1)).toBe(true);
    } finally { spy.mockRestore(); syncBuiltinESMExports(); }
  });
  it('uses actual isolated preview storage while denying native, paid and external adapters before invocation', async () => {
    const storageRoot = path.join(root, 'preview'); await fs.mkdir(storageRoot);
    const filesBefore = (await fs.readdir(root, { recursive: true })).sort();
    runtime = new mod.WebAppRuntime(host, { storageRoot });
    const a = open();
    expect(await call(a.token, 'host.getContext')).toMatchObject({ mode: 'preview' });
    const catalog = await call(a.token, 'capabilities.list');
    expect(catalog.methods.filter((m: any) => !m.available).map((m: any) => m.name).sort()).toEqual([
      'files.pick', 'files.readText', 'files.readBase64', 'files.release', 'files.saveAs', 'ai.generate', 'tools.call',
    ].sort());
    await call(a.token, 'storage.set', { key: 'draft', value: { text: 'Real preview state' } });
    expect(await call(a.token, 'storage.get', { key: 'draft' })).toEqual({ value: { text: 'Real preview state' } });
    expect(JSON.parse(await fs.readFile(path.join(storageRoot, 'storage.json'), 'utf8')).entries.draft.text).toBe('Real preview state');
    expect((await fs.readdir(root, { recursive: true })).filter(file => file !== path.join('preview', 'storage.json')).sort()).toEqual(filesBefore);
    expect(await call(a.token, 'tools.list')).toEqual({ tools: [] });
    for (const [method, args] of [
      ['files.pick', {}], ['files.saveAs', { name: 'export.txt', text: 'No write' }],
      ['ai.generate', { prompt: 'No spend' }], ['tools.call', { name: 'library', arguments: {} }],
    ] as const) await expect(call(a.token, method, args)).rejects.toMatchObject({ code: 'E_UNAVAILABLE' });
    for (const fn of [host.pick, host.save, host.generate, host.tools]) expect(fn).not.toHaveBeenCalled();
    runtime.closeOwner(1);
    await expect(call(a.token, 'storage.keys')).rejects.toMatchObject({ code: 'E_CLOSED' });
  });
  it('discovers real schemas and distinguishes declaration from authorization', async () => {
    const a = open(); const catalog = await call(a.token, 'capabilities.list');
    expect(catalog.methods.find((m: any) => m.name === 'ai.generate')).toMatchObject({ available: true, declared: true, authorized: true, authorization: 'none' });
    expect((await call(a.token,'capabilities.describe',{method:'ai.generate'})).inputSchema.properties.maxTokens.default).toBeUndefined();
    expect(catalog.unsupported.find((m: any) => m.capability === 'shell').reason).toContain('Host-only');
    expect(catalog.unsupported.some((m: any) => m.capability === 'network')).toBe(false);
    await expect(call(a.token,'invented.execute')).rejects.toMatchObject({code:'E_METHOD'});
    await expect(call(a.token,'storage.get',{key:'x',userId:'other'})).rejects.toMatchObject({code:'E_INPUT'});
  });
  it('rejects unsupported manifests and undeclared direct/tool capabilities before execution', async () => {
    expect(() => runtime.open(uid,1,{...bundle(),manifest:{sdkVersion:2,capabilities:[]}})).toThrow('E_MANIFEST');
    expect(() => open('bad',['shell'])).toThrow('E_MANIFEST');
    const a=open('limited',[]);
    await expect(call(a.token,'storage.set',{key:'x',value:1})).rejects.toMatchObject({code:'E_NOT_DECLARED'});
    await expect(call(a.token,'tools.call',{name:'library',arguments:{}})).rejects.toMatchObject({code:'E_NOT_DECLARED'});
  });
  it('persists isolated JSON state and serializes competing writers across app instances', async () => {
    const a=open(), b=open();
    await Promise.all([call(a.token,'storage.set',{key:'one',value:{n:1}}),call(b.token,'storage.set',{key:'__proto__',value:2})]);
    runtime.closeOwner(1); runtime=new mod.WebAppRuntime(host); const again=open();
    expect(await call(again.token,'storage.get',{key:'one'})).toEqual({value:{n:1}});
    expect(await call(again.token,'storage.keys')).toEqual({keys:['__proto__','one']});
    expect(await call(again.token,'storage.get',{key:'__proto__'})).toEqual({value:2});
    await call(again.token,'storage.remove',{key:'one'});
    expect(await call(again.token,'storage.get',{key:'one'})).toEqual({value:null});
  });
  it('separates copied apps, host owners, accounts and resource origins', async () => {
    const a=open(), b=open('copy'); await call(a.token,'storage.set',{key:'private',value:'alpha'});
    expect(await call(b.token,'storage.get',{key:'private'})).toEqual({value:null});
    await expect(runtime.call(uid,2,a.token,'foreign','storage.keys',{})).rejects.toMatchObject({code:'E_CLOSED'});
    const hostname=new URL(a.url).host;
    expect(await runtime.resource(hostname,'index.html','chat-app://foreign')).toBeNull();
    expect(await runtime.resource(hostname,'../private',null)).toBeNull();
    runtime.closeUser(uid); uid='account-b';
    await expect(call(a.token,'storage.keys')).rejects.toMatchObject({code:'E_CLOSED'});
    expect(await call(open().token,'storage.get',{key:'private'})).toEqual({value:null});
    expect(await runtime.resource(hostname,'index.html',null)).toBeNull();
  });
  it('reads only selected snapshots and exports real bytes without overwriting existing files', async () => {
    const source=path.join(root,'source.txt'), output=path.join(root,'export.txt'); await fs.writeFile(source,'Original α');
    host.pick=vi.fn(async()=>source); host.save=vi.fn(async()=>output); const a=open(), b=open('other');
    const picked=await call(a.token,'files.pick'); expect(picked).not.toHaveProperty('path');
    await fs.writeFile(source,'Changed');
    expect(await call(a.token,'files.readText',{handle:picked.handle})).toEqual({text:'Original α'});
    await expect(call(b.token,'files.readText',{handle:picked.handle})).rejects.toMatchObject({code:'E_HANDLE'});
    await call(a.token,'files.saveAs',{name:'export.txt',text:'Exported β'}); expect(await fs.readFile(output,'utf8')).toBe('Exported β');
    await expect(call(a.token,'files.saveAs',{name:'export.txt',text:'Wrong'})).rejects.toMatchObject({code:'EEXIST'});
    expect(await fs.readFile(output,'utf8')).toBe('Exported β');
    await call(a.token,'files.release',{handle:picked.handle});
    await expect(call(a.token,'files.readText',{handle:picked.handle})).rejects.toMatchObject({code:'E_HANDLE'});
  });
  it('rejects selected managed-data symlinks and returns null for cancelled dialogs', async () => {
    const a=open(); expect(await call(a.token,'files.pick')).toBeNull();
    const data=path.join(root,'data','private.txt'); await fs.mkdir(path.dirname(data),{recursive:true}); await fs.writeFile(data,'Private');
    const link=path.join(root,'link'); await fs.symlink(data,link); host.pick=vi.fn(async()=>link);
    await expect(call(a.token,'files.pick')).rejects.toMatchObject({code:'E_FILE'});
    host.save=vi.fn(async()=>data);
    await expect(call(a.token,'files.saveAs',{name:'private.txt',text:'Wrong'})).rejects.toMatchObject({code:'E_FILE'});
    expect(await fs.readFile(data,'utf8')).toBe('Private');
  });
  it('bounds file bytes and rejects non-UTF8 text without corrupting binary reads', async () => {
    const file=path.join(root,'binary'); await fs.writeFile(file,Buffer.from([255,254])); host.pick=vi.fn(async()=>file);
    const a=open(), selected=await call(a.token,'files.pick');
    await expect(call(a.token,'files.readText',{handle:selected.handle})).rejects.toMatchObject({code:'E_ENCODING'});
    expect(await call(a.token,'files.readBase64',{handle:selected.handle})).toEqual({base64:'//4='});
    await fs.truncate(file, MAX_TEXT_FILE_BYTES + 1);
    await expect(call(a.token,'files.pick')).rejects.toMatchObject({code:'E_LIMIT'});
  });
  it('bounds nested and oversized JSON before persistence', async () => {
    const a=open();
    expect(() => mod.boundedJson({ value: 'x'.repeat(1024) }, 1024)).toThrow('E_LIMIT');
    let deep:any={}; for(let i=0;i<40;i++) deep={child:deep};
    await expect(call(a.token,'storage.set',{key:'x',value:deep})).rejects.toMatchObject({code:'E_LIMIT'});
    expect(await call(a.token,'storage.keys')).toEqual({keys:[]});
  });
  it('permits repeated ordinary model calls without extra approval but refuses unavailable models', async () => {
    const a = open();
    await expect(call(a.token, 'ai.generate', { prompt: 'Hello' })).resolves.toMatchObject({ text: 'Test' });
    await expect(call(a.token, 'ai.generate', { prompt: 'Again' })).resolves.toMatchObject({ text: 'Test' });
    expect(host.generate).toHaveBeenCalledTimes(2);
    host.modelAvailable = () => false;
    await expect(call(a.token, 'ai.generate', { prompt: 'No model' })).rejects.toMatchObject({ code: 'E_UNAVAILABLE' });
    expect(host.generate).toHaveBeenCalledTimes(2);
  });
  it('passes distinct host-owned usage scopes and releases each exactly once on closure', async () => {
    host.closed = vi.fn();
    const a = open(), b = open();
    await call(a.token, 'tools.list'); await call(b.token, 'tools.call', { name: 'library', arguments: {} });
    expect(host.tools).toHaveBeenNthCalledWith(1, uid, { id: a.token, owner: 1 });
    expect(host.tools).toHaveBeenNthCalledWith(2, uid, { id: b.token, owner: 1 });
    expect(a.token).not.toBe(b.token);
    await call(a.token, 'permissions.revoke');
    runtime.close(uid, 1, a.token);
    expect(host.closed).toHaveBeenCalledTimes(1);
    expect(host.closed).toHaveBeenCalledWith(uid, { id: a.token, owner: 1 });
    await expect(call(b.token, 'tools.list')).resolves.toHaveProperty('tools');
    runtime.closeOwner(1);
    expect(host.closed).toHaveBeenCalledTimes(2);
    expect(host.closed).toHaveBeenLastCalledWith(uid, { id: b.token, owner: 1 });
  });
  it('logs one redacted warning per method and code per minute and nothing for cancellation', async () => {
    const warn = vi.fn();
    vi.doMock('../../../src/main/logger', async (original) => ({ ...(await original<any>()),
      createLogger: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
    try {
      vi.resetModules();
      const logged = await import('../../../src/main/features/web_apps/runtime');
      const rt = new logged.WebAppRuntime(host);
      const a = rt.open(uid, 1, bundle());
      host.generate = async () => { throw new Error('/Users/test/private provider body'); };
      for (let i = 0; i < 3; i += 1) {
        await expect(rt.call(uid, 1, a.token, `fail-${i}`, 'ai.generate', { prompt: 'secret prompt' })).rejects.toThrow();
      }
      await expect(rt.call(uid, 1, a.token, 'tool', 'tools.call', { name: 'bash', arguments: {} })).rejects.toMatchObject({ code: 'E_TOOL' });
      host.generate = async () => { throw new logged.AppError('E_CANCELLED'); };
      await expect(rt.call(uid, 1, a.token, 'cancelled', 'ai.generate', { prompt: 'x' })).rejects.toMatchObject({ code: 'E_CANCELLED' });
      const rows = warn.mock.calls.filter(([message]) => message === 'web app call failed');
      expect(rows).toEqual([
        ['web app call failed', { method: 'ai.generate', code: 'E_FAILED', suppressed_count: 0, error: expect.objectContaining({ message_hash: expect.any(String) }) }],
        ['web app call failed', { method: 'tools.call', code: 'E_TOOL', suppressed_count: 0 }],
      ]);
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/alice|secret prompt|provider body/);
      rt.closeOwner(1);
    } finally { vi.doUnmock('../../../src/main/logger'); }
  });
  it('delivers streaming progress and usage without an app-specific output default', async () => {
    const a=open(), progress=vi.fn(); host.generate=vi.fn(async(_uid,_args,_signal,out)=>{out({type:'delta',text:'Hi'});return {text:'Hi',usage:{outputTokens:1},stopReason:'end_turn'};});
    expect(await runtime.call(uid,1,a.token,'model','ai.generate',{prompt:'Hello'},progress)).toMatchObject({text:'Hi',usage:{outputTokens:1}});
    expect(progress).toHaveBeenCalledWith({type:'delta',text:'Hi'});
    expect(host.generate).toHaveBeenCalledWith(uid,{prompt:'Hello'},expect.any(AbortSignal),expect.any(Function));
  });
  it('revocation aborts generation and rejects stale instance calls', async () => {
    const a=open(); let start!:()=>void; const ready=new Promise<void>(r=>{start=r;});
    host.generate=vi.fn(async(_u,_a,signal)=>{start();return new Promise((_r,reject)=>signal.addEventListener('abort',()=>reject(new mod.AppError('E_CANCELLED')),{once:true}));});
    const run=call(a.token,'ai.generate',{prompt:'Wait'}); const rejected=expect(run).rejects.toMatchObject({code:'E_CANCELLED'});
    await ready; expect(await call(a.token,'permissions.revoke')).toEqual({revoked:true}); await rejected;
    await expect(call(a.token,'storage.keys')).rejects.toMatchObject({code:'E_CLOSED'});
  });
  it.each(['ai.generate', 'tools.call'])('normalizes native adapter aborts from %s at the SDK request boundary', async method => {
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const execute = async (signal: AbortSignal) => {
      started();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () =>
        reject(new DOMException('The operation was aborted', 'AbortError')), { once: true }));
    };
    host.generate = async (_uid, _args, signal) => execute(signal);
    host.tools = async () => [{ name: 'library', capability: 'library', description: '', inputSchema: {},
      execute: async (_args, signal) => execute(signal) }];
    const a = open();
    const args = method === 'ai.generate' ? { prompt: 'Wait for cancellation' } : { name: 'library', arguments: { action: 'list' } };
    const running = runtime.call(uid, 1, a.token, 'cancel-adapter', method, args);
    const cancelled = expect(running).rejects.toMatchObject({ code: 'E_CANCELLED' });
    await ready;
    runtime.cancel(uid, 1, a.token, 'cancel-adapter');
    await cancelled;
    // The cancelled operation releases capacity and keeps the app usable.
    expect(await call(a.token, 'storage.keys')).toEqual({ keys: [] });
  });
  it('preserves an adapter failure when the request has not been cancelled', async () => {
    const failure = new Error('Owning service failed');
    host.generate = async () => { throw failure; };
    await expect(call(open().token, 'ai.generate', { prompt: 'Fail once' })).rejects.toBe(failure);
  });
  it('does not replay a duplicate or a request cancelled before execution', async () => {
    const a=open(); runtime.cancel(uid,1,a.token,'cancel-first');
    await expect(runtime.call(uid,1,a.token,'cancel-first','storage.set',{key:'x',value:1})).rejects.toMatchObject({code:'E_DUPLICATE'});
    await runtime.call(uid,1,a.token,'once','storage.set',{key:'x',value:2});
    await expect(runtime.call(uid,1,a.token,'once','storage.set',{key:'x',value:3})).rejects.toMatchObject({code:'E_DUPLICATE'});
    expect(await call(a.token,'storage.get',{key:'x'})).toEqual({value:2});
  });
  it('preserves owning tool failures and rejects unserializable results without replay', async () => {
    const execute=vi.fn(async()=>({content:'Denied',isError:true}));
    host.tools=vi.fn(async()=>[{name:'library',capability:'library',description:'',inputSchema:{},execute}]); const a=open();
    expect(await call(a.token,'tools.call',{name:'library',arguments:{action:'list'}})).toEqual({content:'Denied',isError:true});
    const cyclic: any = {}; cyclic.self = cyclic;
    execute.mockResolvedValueOnce(cyclic);
    await expect(call(a.token,'tools.call',{name:'library',arguments:{}})).rejects.toMatchObject({code:'E_RESULT_LIMIT'});
    expect(execute).toHaveBeenCalledTimes(2);
    await expect(call(a.token,'tools.call',{name:'bash',arguments:{}})).rejects.toMatchObject({code:'E_TOOL'});
  });
  it('invalidates a pending picker before it can return bytes after account closure', async () => {
    let pick!:(file:string)=>void; host.pick=vi.fn(()=>new Promise(r=>{pick=r;}));
    const a=open(), request=call(a.token,'files.pick'); const rejected=expect(request).rejects.toMatchObject({code:'E_CANCELLED'});
    await vi.waitFor(()=>expect(pick).toBeTypeOf('function')); runtime.closeUser(uid); pick(path.join(root,'missing')); await rejected;
  });
});

describe('Web app resource lifetime and contention', () => {
  it('rejects a private store redirected into another application', async () => {
    const a = open('one'), b = open('two');
    await call(b.token, 'storage.set', { key: 'private', value: 'Other app' });
    const { webAppDataFile } = await import('../../../src/main/paths');
    const first = path.dirname(webAppDataFile(uid, bundle('one').key));
    const second = path.dirname(webAppDataFile(uid, bundle('two').key));
    await fs.symlink(second, first, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(call(a.token, 'storage.get', { key: 'private' })).rejects.toMatchObject({ code: 'E_FILE' });
    expect(await call(b.token, 'storage.get', { key: 'private' })).toEqual({ value: 'Other app' });
  });
  it('accepts concurrent work across applications and cancels it without blocking recovery', async () => {
    let started = 0;
    host.generate = vi.fn(async (_u, _a, signal) => {
      started++;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new mod.AppError('E_CANCELLED')), { once: true }));
    });
    const apps = Array.from({ length: 40 }, (_, i) => open('app-' + i));
    const runs = Array.from({ length: 8 }, (_, i) => call(apps[i % 2].token, 'ai.generate', { prompt: 'Parallel ' + i }));
    const outcomes = Promise.allSettled(runs);
    await vi.waitFor(() => expect(started).toBe(8));
    expect(await call(apps[0].token, 'host.getContext')).toMatchObject({ sdkVersion: 1 });
    runtime.closeOrigin(1, apps[0].url); runtime.closeOrigin(1, apps[1].url);
    expect((await outcomes).every(r => r.status === 'rejected')).toBe(true);
    host.generate = vi.fn(async () => ({ text: 'Recovered' }));
    expect(await call(apps[39].token, 'ai.generate', { prompt: 'Recovered' })).toEqual({ text: 'Recovered' });
  });
  it('keeps an open app usable across days and still revokes it explicitly', async () => {
    const a = open(); const now = Date.now();
    await call(a.token, 'storage.set', { key: 'draft', value: 'Still working' });
    const time = vi.spyOn(Date, 'now').mockReturnValue(now + 7 * 24 * 60 * 60 * 1000);
    try {
      expect(await call(a.token, 'storage.get', { key: 'draft' })).toEqual({ value: 'Still working' });
      open('another-app');
      expect(await call(a.token, 'storage.get', { key: 'draft' })).toEqual({ value: 'Still working' });
      await call(a.token, 'permissions.revoke');
      await expect(call(a.token, 'storage.keys')).rejects.toMatchObject({ code: 'E_CLOSED' });
      expect(await runtime.resource(new URL(a.url).host, 'index.html', null)).toBeNull();
    } finally { time.mockRestore(); }
  });
});

// A regression must reject the special file without hanging Vitest or a worker.
it.skipIf(process.platform === 'win32')('rejects a selected unopened FIFO without waiting for a writer', async () => {
  const fifo = path.join(root, 'selected.pipe');
  expect(spawnSync('mkfifo', [fifo]).status).toBe(0);
  host.pick = vi.fn(async () => fifo);
  const pending = call(open().token, 'files.pick').then(() => 'unexpected-success', error => error.code);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([pending, new Promise<string>(resolve => {
    timer = setTimeout(() => resolve('blocked-on-open'), 500);
  })]);
  clearTimeout(timer);
  // Unblock a regressed read before asserting so cleanup is always bounded.
  if (outcome === 'blocked-on-open') {
    const writer = await fs.open(fifo, constants.O_RDWR | constants.O_NONBLOCK);
    try { await pending; } finally { await writer.close(); }
  }
  expect(outcome).toBe('E_LIMIT');
});

describe('app sandboxes and compatibility', () => {
  it('keeps legacy state local, explicitly syncs business data and isolates files, accounts and copies', async () => {
    host.storageChanged = vi.fn();
    const a = open('sandbox', ['storage', 'appFiles']);
    const paths = await import('../../../src/main/paths');
    const key = bundle('sandbox').key;
    await call(a.token, 'storage.set', { key: 'draft', value: 'legacy cache' });
    expect(host.storageChanged).not.toHaveBeenCalled();
    await call(a.token, 'storage.set', { key: 'draft', value: 'business', scope: 'cloud' });
    expect(await call(a.token, 'storage.get', { key: 'draft' })).toEqual({ value: 'legacy cache' });
    expect(await call(a.token, 'storage.get', { key: 'draft', scope: 'cloud' })).toEqual({ value: 'business' });
    expect(host.storageChanged).toHaveBeenLastCalledWith(uid, `cloud/web_apps/${key}/state.json`);
    await call(a.token, 'appFiles.writeText', { path: 'notes/你好.txt', text: '你好' });
    await call(a.token, 'appFiles.writeBase64', { path: 'image.bin', base64: 'AP8B' });
    expect(await call(a.token, 'appFiles.readBase64', { path: 'image.bin' })).toEqual({ base64: 'AP8B' });
    await expect(call(a.token, 'appFiles.readText', { path: 'image.bin' })).rejects.toMatchObject({ code: 'E_ENCODING' });
    expect(await call(a.token, 'appFiles.list')).toEqual({ files: [{ path: 'image.bin', size: 3 }, { path: 'notes/你好.txt', size: 6 }] });
    expect(await fs.readFile(path.join(paths.webAppSandboxRoot(uid, key, 'cloud'), 'files/notes/你好.txt'), 'utf8')).toBe('你好');
    const count = (host.storageChanged as any).mock.calls.length;
    await call(a.token, 'appFiles.writeText', { path: 'notes/你好.txt', text: 'cache', scope: 'local' });
    expect((host.storageChanged as any).mock.calls).toHaveLength(count);
    expect(await call(a.token, 'appFiles.readText', { path: 'notes/你好.txt', scope: 'local' })).toEqual({ text: 'cache' });
    runtime.closeOwner(1); runtime = new mod.WebAppRuntime(host);
    const reopened = open('sandbox', ['storage', 'appFiles']);
    expect(await call(reopened.token, 'appFiles.readText', { path: 'notes/你好.txt' })).toEqual({ text: '你好' });
    const copy = open('sandbox-copy', ['storage', 'appFiles']);
    expect(await call(copy.token, 'appFiles.readText', { path: 'notes/你好.txt' })).toBeNull();
    await call(reopened.token, 'appFiles.remove', { path: 'notes/你好.txt' });
    expect(await call(reopened.token, 'appFiles.readText', { path: 'notes/你好.txt' })).toBeNull();
    expect(host.storageChanged).toHaveBeenLastCalledWith(uid, `cloud/web_apps/${key}/files/notes/你好.txt`);
    uid = 'account-b';
    await expect(call(reopened.token, 'appFiles.list')).rejects.toMatchObject({ code: 'E_CLOSED' });
    const otherAccount = open('sandbox', ['appFiles']);
    expect(await call(otherAccount.token, 'appFiles.list')).toEqual({ files: [] });
  });

  it('rejects undeclared calls, traversal, aliases and malformed binary without publication', async () => {
    const a = open('sandbox', ['appFiles']);
    const limited = open('limited', []);
    await expect(call(limited.token, 'appFiles.list')).rejects.toMatchObject({ code: 'E_NOT_DECLARED' });
    for (const file of ['../other', '/absolute', 'a//b', 'a/./b', 'a\\b', 'C:evil', '.private', 'x\0y', 'aux.txt', 'a.', 'a ', 'visibility/data', 'Thumbs.db', 'desktop.ini', 'file.123.1789440000000.1234abcd.tmp']) {
      await expect(call(a.token, 'appFiles.writeText', { path: file, text: 'escape' })).rejects.toMatchObject({ code: 'E_INPUT' });
    }
    await expect(call(a.token, 'appFiles.writeBase64', { path: 'bad', base64: 'not base64' })).rejects.toMatchObject({ code: 'E_INPUT' });
    await expect(call(a.token, 'appFiles.list', { scope: 'outside' })).rejects.toMatchObject({ code: 'E_INPUT' });
    const paths = await import('../../../src/main/paths');
    const files = path.join(paths.webAppSandboxRoot(uid, bundle('sandbox').key, 'cloud'), 'files');
    await fs.mkdir(files, { recursive: true });
    const outside = path.join(root, 'private'); await fs.writeFile(outside, 'private');
    await fs.symlink(outside, path.join(files, 'link'));
    for (const method of ['appFiles.readText', 'appFiles.writeText', 'appFiles.remove']) {
      await expect(call(a.token, method, { path: 'link', ...(method === 'appFiles.writeText' ? { text: 'evil' } : {}) })).rejects.toMatchObject({ code: 'E_FILE' });
    }
    expect(await fs.readFile(outside, 'utf8')).toBe('private');
    await fs.unlink(path.join(files, 'link')); await fs.link(outside, path.join(files, 'linked'));
    await expect(call(a.token, 'appFiles.readText', { path: 'linked' })).rejects.toMatchObject({ code: 'E_FILE' });
    await fs.unlink(path.join(files, 'linked'));
    await fs.symlink(path.dirname(files), files + '-alias');
    await fs.mkdir(path.join(files, 'nested')); await fs.symlink(root, path.join(files, 'nested', 'outside'));
    await expect(call(a.token, 'appFiles.writeText', { path: 'nested/outside/new', text: 'evil' })).rejects.toMatchObject({ code: 'E_FILE' });
  });

  it('grows beyond old aggregate quotas without scanning unrelated files for each write', async () => {
    const a = open('quota', ['appFiles']);
    const paths = await import('../../../src/main/paths');
    const rootFiles = path.join(paths.webAppSandboxRoot(uid, bundle('quota').key, 'cloud'), 'files');
    await fs.mkdir(rootFiles, { recursive: true });
    for (let i = 0; i < 300; i++) await fs.writeFile(path.join(rootFiles, `${i}.bin`), Buffer.alloc(64 * 1024, i % 256));
    const scan = vi.spyOn(nativeFs.promises, 'readdir'); syncBuiltinESMExports();
    try {
      await call(a.token, 'appFiles.writeText', { path: 'one.txt', text: 'one' });
      expect(scan).not.toHaveBeenCalled();
    } finally { scan.mockRestore(); syncBuiltinESMExports(); }
    expect((await call(a.token, 'appFiles.list')).files).toHaveLength(301);
    expect(await call(a.token, 'appFiles.readText', { path: 'one.txt' })).toEqual({ text: 'one' });
    await call(a.token, 'appFiles.remove', { path: '0.bin' });
    expect((await call(a.token, 'appFiles.list')).files).toHaveLength(300);
  });

  it('keeps both preview scopes temporary without cloud notifications', async () => {
    host.storageChanged = vi.fn();
    const before = (await fs.readdir(root, { recursive: true })).sort();
    const previewRoot = path.join(root, 'preview');
    runtime = new mod.WebAppRuntime(host, { storageRoot: previewRoot });
    const a = open('preview', ['storage', 'appFiles']);
    for (const scope of ['local', 'cloud']) {
      await call(a.token, 'storage.set', { key: 'draft', value: scope, scope });
      await call(a.token, 'appFiles.writeText', { path: 'note.txt', text: scope, scope });
      expect(await call(a.token, 'appFiles.readText', { path: 'note.txt', scope })).toEqual({ text: scope });
    }
    expect(host.storageChanged).not.toHaveBeenCalled();
    expect((await fs.readdir(root, { recursive: true })).filter(name => name !== 'preview' && !name.startsWith('preview' + path.sep)).sort()).toEqual(before);
  });
});

it.each(['switch', 'revoke', 'cancel'])('does not publish sandbox bytes after %s during an atomic rename retry', async action => {
  host.storageChanged = vi.fn();
  const a = open('guarded', ['appFiles']);
  await call(a.token, 'appFiles.writeText', { path: 'note.txt', text: 'original' });
  const paths = await import('../../../src/main/paths');
  const file = path.join(paths.webAppSandboxRoot(uid, bundle('guarded').key, 'cloud'), 'files/note.txt');
  const changeCount = (host.storageChanged as any).mock.calls.length;
  const spy = vi.spyOn(nativeFs, 'renameSync').mockImplementation(() => {
    if (action === 'switch') uid = 'new-account';
    if (action === 'revoke') runtime.closeOwner(1);
    if (action === 'cancel') runtime.cancel(uid, 1, a.token, 'guarded-write');
    throw Object.assign(new Error('transient lock'), { code: 'EPERM' });
  });
  syncBuiltinESMExports();
  try {
    await expect(runtime.call(uid, 1, a.token, 'guarded-write', 'appFiles.writeText', { path: 'note.txt', text: 'unpublished' }))
      .rejects.toMatchObject({ code: action === 'switch' ? 'E_CLOSED' : 'E_CANCELLED' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(file, 'utf8')).toBe('original');
    expect(await fs.readdir(path.dirname(file))).toEqual(['note.txt']);
    expect((host.storageChanged as any).mock.calls).toHaveLength(changeCount);
  } finally { spy.mockRestore(); syncBuiltinESMExports(); }
});

// Storage calls run on the main process, so an unchanged store must not be
// re-read and re-parsed for every call; any external replacement (a synced
// copy, an in-place rewrite) must still be seen, and a failed write must not
// leave a value that never reached the disk.
describe('app storage reuse', () => {
  const storeReads = () => {
    const realRead = nativeFs.promises.readFile.bind(nativeFs.promises);
    const reads: string[] = [];
    const spy = vi.spyOn(nativeFs.promises, 'readFile').mockImplementation(async (...args: any[]) => {
      if (String(args[0]).endsWith('.json')) reads.push(String(args[0]));
      return (realRead as any)(...args);
    });
    syncBuiltinESMExports();
    return { reads, restore: () => { spy.mockRestore(); syncBuiltinESMExports(); } };
  };

  it('reads an unchanged store once while the app stays open and writes the same bytes', async () => {
    const paths = await import('../../../src/main/paths');
    const key = bundle('reuse').key;
    const file = paths.webAppDataFile(uid, key);
    const a = open('reuse', ['storage']);
    await call(a.token, 'storage.set', { key: 'draft', value: { text: 'first' } });
    const probe = storeReads();
    try {
      for (let i = 0; i < 5; i++) {
        expect(await call(a.token, 'storage.get', { key: 'draft' })).toEqual({ value: { text: 'first' } });
      }
      expect(await call(a.token, 'storage.keys')).toEqual({ keys: ['draft'] });
      await call(a.token, 'storage.set', { key: 'count', value: 2 });
      expect(await call(a.token, 'storage.get', { key: 'count' })).toEqual({ value: 2 });
      expect(probe.reads).toEqual([]);
      expect(nativeFs.readFileSync(file, 'utf8'))
        .toBe(JSON.stringify({ version: 1, entries: { draft: { text: 'first' }, count: 2 } }, null, 2));

      // Closing the last instance releases the parsed store.
      runtime.close(uid, 1, a.token);
      const again = open('reuse', ['storage']);
      expect(await call(again.token, 'storage.get', { key: 'count' })).toEqual({ value: 2 });
      expect(probe.reads).toEqual([file]);
    } finally { probe.restore(); }
  });

  it('sees replaced and rewritten stores and keeps the stored value when a write fails', async () => {
    const paths = await import('../../../src/main/paths');
    const key = bundle('external').key;
    const a = open('external', ['storage']);
    for (const scope of ['local', 'cloud'] as const) {
      const file = paths.webAppDataFile(uid, key, scope);
      await call(a.token, 'storage.set', { key: 'draft', value: 'v1', scope });
      expect(await call(a.token, 'storage.get', { key: 'draft', scope })).toEqual({ value: 'v1' });

      // A synced copy replaces the file through a temp file and rename.
      const tmp = file + '.sync.tmp';
      await fs.writeFile(tmp, JSON.stringify({ version: 1, entries: { draft: 'v2' } }));
      await fs.rename(tmp, file);
      expect(await call(a.token, 'storage.get', { key: 'draft', scope })).toEqual({ value: 'v2' });

      // An in-place rewrite of the same size is still a different store.
      await new Promise((resolve) => setTimeout(resolve, 5));
      await fs.writeFile(file, JSON.stringify({ version: 1, entries: { draft: 'v3' } }));
      expect(await call(a.token, 'storage.get', { key: 'draft', scope })).toEqual({ value: 'v3' });

      // Guarded atomic writes publish with renameSync.
      const rename = vi.spyOn(nativeFs, 'renameSync').mockImplementationOnce(() => {
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      });
      syncBuiltinESMExports();
      try {
        await expect(call(a.token, 'storage.set', { key: 'draft', value: 'lost', scope })).rejects.toMatchObject({ code: 'ENOSPC' });
      } finally { rename.mockRestore(); syncBuiltinESMExports(); }
      expect(await call(a.token, 'storage.get', { key: 'draft', scope })).toEqual({ value: 'v3' });
      expect(await call(a.token, 'storage.keys', { scope })).toEqual({ keys: ['draft'] });
    }
  });
});

// A working notebook must grow beyond the old demo quotas and stay usable.
it('persists larger files and JSON, many entries and long-lived request sequences', async () => {
  const app = open('growing-notebook', ['storage', 'appFiles']);
  const text = 'data:α\n'.repeat(180000);
  await call(app.token, 'appFiles.writeText', { path: 'large.txt', text });
  expect(await call(app.token, 'appFiles.readText', { path: 'large.txt' })).toEqual({ text });
  await call(app.token, 'storage.set', { key: 'large', value: text });
  expect(await call(app.token, 'storage.get', { key: 'large' })).toEqual({ value: text });
  const paths = await import('../../../src/main/paths');
  const key = bundle('growing-notebook').key;
  // Pre-existing synced state is subject to the same admission as app writes.
  const entries = Object.fromEntries(Array.from({ length: 300 }, (_, i) => ['k' + i, i]));
  await fs.writeFile(paths.webAppDataFile(uid, key), JSON.stringify({ version: 1, entries }));
  await call(app.token, 'storage.set', { key: 'new', value: 'retained' });
  expect((await call(app.token, 'storage.keys')).keys).toHaveLength(301);
  runtime.closeOwner(1); runtime = new mod.WebAppRuntime(host);
  const reopened = open('growing-notebook', ['storage', 'appFiles']);
  expect(await call(reopened.token, 'appFiles.readText', { path: 'large.txt' })).toEqual({ text });
  expect(await call(reopened.token, 'storage.get', { key: 'new' })).toEqual({ value: 'retained' });
  for (let i = 0; i < 20000; i++) await call(reopened.token, 'host.getContext');
  expect(await call(reopened.token, 'storage.get', { key: 'new' })).toEqual({ value: 'retained' });
  await expect(runtime.call(uid, 1, reopened.token, 'q' + seq, 'storage.remove', { key: 'new' }))
    .rejects.toMatchObject({ code: 'E_DUPLICATE' });
  expect(await call(reopened.token, 'storage.get', { key: 'new' })).toEqual({ value: 'retained' });
});

it('remembers cancelled and completed SDK ids out of order without rejecting intervening work', async () => {
  const a = open();
  runtime.cancel(uid, 1, a.token, 'q4');
  for (const id of ['q2', 'q1', 'q3', 'q5'])
    await runtime.call(uid, 1, a.token, id, 'storage.set', { key: id, value: id });
  for (const id of ['q1', 'q2', 'q3', 'q4', 'q5'])
    await expect(runtime.call(uid, 1, a.token, id, 'storage.set', { key: 'replay', value: true }))
      .rejects.toMatchObject({ code: 'E_DUPLICATE' });
  expect(await runtime.call(uid, 1, a.token, 'q6', 'storage.keys', {})).toEqual({ keys: ['q1', 'q2', 'q3', 'q5'] });
});

it.each(['custom', 'sparse', 'documents'])('bounds an identity flood, preserves replay protection, and recovers by reopening (%s)', async shape => {
  const a = open();
  let limited = 0;
  for (let n = 0; n < 100000; n++) {
    const id = shape === 'custom' ? 'custom_' + n : shape === 'sparse' ? 'q' + (2 * n + 1) : 'd' + n.toString(16).padStart(32, '0') + 'q1';
    try { runtime.cancel(uid, 1, a.token, id); }
    catch (error) { expect(error).toMatchObject({ code: 'E_LIMIT' }); limited++; }
  }
  expect(limited).toBeGreaterThan(90000);
  const first = shape === 'custom' ? 'custom_0' : shape === 'sparse' ? 'q1' : 'd' + '0'.repeat(32) + 'q1';
  await expect(runtime.call(uid, 1, a.token, first, 'storage.set', { key: 'replayed', value: true })).rejects.toMatchObject({ code: 'E_DUPLICATE' });
  await expect(runtime.call(uid, 1, a.token, 'fresh', 'storage.set', { key: 'replayed', value: true })).rejects.toMatchObject({ code: 'E_LIMIT' });
  const other = open(); expect(await runtime.call(uid, 1, other.token, 'q1', 'storage.get', { key: 'replayed' })).toEqual({ value: null });
  runtime.close(uid, 1, a.token);
  const reopened = open(); expect(await runtime.call(uid, 1, reopened.token, first, 'host.getContext', {})).toMatchObject({ sdkVersion: 1 });
});

it('still cancels accepted work after the replay history is exhausted', async () => {
  const a = open(); let started!: () => void;
  const gate = new Promise<void>(resolve => { started = resolve; });
  host.generate = async (_uid, _args, signal) => { started(); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); return { text: 'discarded' }; };
  const work = runtime.call(uid, 1, a.token, 'running', 'ai.generate', { prompt: 'Controlled operation' });
  const outcome = expect(work).rejects.toMatchObject({ code: 'E_CANCELLED' }); await gate;
  let saturated = false;
  for (let i = 0; i < 9000; i++) { try { runtime.cancel(uid, 1, a.token, 'cancel_' + i); } catch { saturated = true; break; } }
  expect(saturated).toBe(true);
  runtime.cancel(uid, 1, a.token, 'running'); await outcome;
});

it('lets the owning service complete long work without an additional SDK deadline', async () => {
  vi.useFakeTimers();
  let finish!: (value: unknown) => void;
  let signal!: AbortSignal;
  host.generate = async (_u, _args, ownedSignal) => {
    signal = ownedSignal;
    return new Promise(resolve => { finish = resolve; });
  };
  try {
    const app = open();
    const work = call(app.token, 'ai.generate', { prompt: 'Long operation' });
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(signal.aborted).toBe(false);
    finish({ text: 'Completed once' });
    expect(await work).toEqual({ text: 'Completed once' });
    expect(await call(app.token, 'host.getContext')).toMatchObject({ sdkVersion: 1 });
  } finally { vi.useRealTimers(); }
});

it('keeps acknowledged browser calls alive until result or explicit cancellation', async () => {
  const { runInNewContext } = await import('node:vm');
  const source = await fs.readFile(path.resolve('src/main/features/web_apps/sdk.js'), 'utf8');
  vi.useFakeTimers();
  try {
    const listeners: Record<string, (event: any) => void> = {};
    const parent = { postMessage: vi.fn() };
    const window: any = { parent, addEventListener: (type: string, fn: any) => { listeners[type] = fn; } };
    runInNewContext(source, { window, parent, setTimeout, clearTimeout, crypto: (await import('node:crypto')).webcrypto });
    const unavailable = window.orkasApp.call('tools.call', {});
    const missing = expect(unavailable).rejects.toMatchObject({ code: 'E_HOST_UNAVAILABLE' });
    await vi.advanceTimersByTimeAsync(10000);
    await missing;
    parent.postMessage.mockClear();
    const work = window.orkasApp.call('tools.call', {});
    const { id } = parent.postMessage.mock.calls[0][0];
    listeners.message({ source: parent, data: { __orkasApp: 1, id, type: 'ack' } });
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(parent.postMessage).toHaveBeenCalledTimes(1);
    listeners.message({ source: parent, data: { __orkasApp: 1, id, type: 'result', ok: true, value: 'Complete' } });
    expect(await work).toBe('Complete');
    const delayed = window.orkasApp.call('tools.call', {});
    const delayedId = parent.postMessage.mock.calls.at(-1)![0].id;
    // A known host can be busy; subsequent transport acknowledgements do not
    // impose a second deadline on the owning service's operation.
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(parent.postMessage).toHaveBeenCalledTimes(2);
    listeners.message({ source: parent, data: { __orkasApp: 1, id: delayedId, type: 'result', ok: true, value: 'Delayed' } });
    expect(await delayed).toBe('Delayed');
    const controller = new AbortController();
    const cancelled = window.orkasApp.call('tools.call', {}, { signal: controller.signal });
    const outcome = expect(cancelled).rejects.toMatchObject({ code: 'E_CANCELLED' });
    controller.abort();
    await outcome;
    expect(parent.postMessage.mock.calls.at(-1)![0].type).toBe('cancel');
  } finally { vi.useRealTimers(); }
});

async function browserSdkHarness() {
  const { runInNewContext } = await import('node:vm');
  const source = await fs.readFile(path.resolve('src/main/features/web_apps/sdk.js'), 'utf8');
  const listeners: Record<string, (event?: any) => void> = {};
  const messages: any[] = [];
  const parent = { postMessage: vi.fn(message => { messages.push(structuredClone(message)); }) };
  const window: any = { parent, addEventListener: (type: string, fn: any) => { listeners[type] = fn; } };
  runInNewContext(source, { window, parent, setTimeout, clearTimeout, structuredClone, crypto: (await import('node:crypto')).webcrypto });
  return { call: window.orkasApp.call, listeners,
    calls: () => messages.filter(message => message.type === 'call'),
    result: (id: string, value: unknown) => listeners.message({ source: parent,
      data: { __orkasApp: 1, id, type: 'result', ok: true, value } }),
  };
}

it('discovers the host before first inference so a cold service cannot expire host discovery', async () => {
  vi.useFakeTimers();
  try {
    const sdk = await browserSdkHarness();
    const input = { prompt: 'Cold inference', maxTokens: 128 };
    const work = sdk.call('ai.generate', input);
    input.prompt = 'Changed after the call';
    let status = 'pending';
    void work.then(() => { status = 'resolved'; }, () => { status = 'rejected'; });
    expect(sdk.calls().map(call => call.method)).toEqual(['host.getContext']);
    sdk.result(sdk.calls()[0].id, { sdkVersion: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(sdk.calls().map(call => call.method)).toEqual(['host.getContext', 'ai.generate']);
    expect(sdk.calls()[1].args).toEqual({ prompt: 'Cold inference', maxTokens: 128 });
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(status).toBe('pending');
    expect(sdk.calls()).toHaveLength(2);
    sdk.result(sdk.calls()[1].id, { text: 'One completed inference' });
    expect(await work).toEqual({ text: 'One completed inference' });
  } finally { vi.useRealTimers(); }
});

it('shares inference discovery and never dispatches an operation cancelled while waiting', async () => {
  vi.useFakeTimers();
  try {
    const sdk = await browserSdkHarness();
    const controller = new AbortController();
    const cancelled = sdk.call('ai.generate', { prompt: 'Cancelled operation' }, { signal: controller.signal });
    const outcome = expect(cancelled).rejects.toMatchObject({ code: 'E_CANCELLED' });
    const kept = sdk.call('ai.generate', { prompt: 'Kept operation' });
    expect(sdk.calls().map(call => call.method)).toEqual(['host.getContext']);
    controller.abort();
    await outcome;
    sdk.result(sdk.calls()[0].id, { sdkVersion: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(sdk.calls().map(call => call.method)).toEqual(['host.getContext', 'ai.generate']);
    expect(sdk.calls()[1].args).toEqual({ prompt: 'Kept operation' });
    sdk.result(sdk.calls()[1].id, { text: 'Completed' });
    expect(await kept).toEqual({ text: 'Completed' });
  } finally { vi.useRealTimers(); }
});

it('does not start late inference when the document departs just after discovery resolves', async () => {
  vi.useFakeTimers();
  try {
    const sdk = await browserSdkHarness();
    const work = sdk.call('ai.generate', { prompt: 'Departing document' });
    const outcome = expect(work).rejects.toMatchObject({ code: 'E_CLOSED' });
    expect(sdk.calls().map(call => call.method)).toEqual(['host.getContext']);
    sdk.result(sdk.calls()[0].id, { sdkVersion: 1 });
    sdk.listeners.pagehide();
    await outcome;
    await vi.advanceTimersByTimeAsync(0);
    expect(sdk.calls().map(call => call.method)).toEqual(['host.getContext']);
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it('keeps missing-host discovery bounded without dispatching inference or retrying it', async () => {
  vi.useFakeTimers();
  try {
    const sdk = await browserSdkHarness();
    const work = sdk.call('ai.generate', { prompt: 'Unavailable host' });
    const outcome = expect(work).rejects.toMatchObject({ code: 'E_HOST_UNAVAILABLE' });
    await vi.advanceTimersByTimeAsync(10_000);
    await outcome;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sdk.calls().map(call => call.method)).toEqual(['host.getContext']);
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it('retains serialization failure and cancellation during input snapshot without contacting the host', async () => {
  const sdk = await browserSdkHarness();
  await expect(sdk.call('ai.generate', { prompt: 'Invalid', unsupported: () => {} }))
    .rejects.toMatchObject({ code: 'E_INPUT' });
  const controller = new AbortController();
  const input = { get prompt() { controller.abort(); return 'Must not dispatch'; } };
  await expect(sdk.call('ai.generate', input, { signal: controller.signal }))
    .rejects.toMatchObject({ code: 'E_CANCELLED' });
  expect(sdk.calls()).toEqual([]);
});

it('can select more than sixteen files and release snapshots independently', async () => {
  const source = path.join(root, 'selected.txt');
  await fs.writeFile(source, 'Selected content');
  host.pick = async () => source;
  const a = open();
  const handles: string[] = [];
  for (let i = 0; i < 20; i++) handles.push((await call(a.token, 'files.pick')).handle);
  for (const handle of handles) {
    expect(await call(a.token, 'files.readText', { handle })).toEqual({ text: 'Selected content' });
    await call(a.token, 'files.release', { handle });
    await expect(call(a.token, 'files.readText', { handle })).rejects.toMatchObject({ code: 'E_HANDLE' });
  }
});

it('keeps deep application paths and long storage keys usable across reopening', async () => {
  const a=open('first',['storage','appFiles']);const rel=Array.from({length:12},(_,i)=>'directory-'+i+'-long-name').join('/')+'/value.txt';
  await call(a.token,'appFiles.writeText',{path:rel,text:'Preserved'});
  const key='k'.repeat(256);await call(a.token,'storage.set',{key,value:42});
  runtime.closeOwner(1);const b=open('first',['storage','appFiles']);
  expect(await call(b.token,'appFiles.readText',{path:rel})).toEqual({text:'Preserved'});
  expect(await call(b.token,'appFiles.list')).toMatchObject({files:[{path:rel,size:9}]});
  expect(await call(b.token,'storage.get',{key})).toEqual({value:42});
  await expect(call(b.token,'appFiles.readText',{path:'../private.txt'})).rejects.toMatchObject({code:'E_INPUT'});
});

it('measures JSON bytes and nesting while preserving state after a rejected update', async () => {
  expect(mod.boundedJson('汉', 5)).toBe('"汉"');
  expect(() => mod.boundedJson('汉', 4)).toThrow('E_LIMIT');
  const nested = (depth: number) => { let value: any = 0; for (let i = 0; i < depth; i++) value = [value]; return value; };
  expect(JSON.parse(mod.boundedJson(nested(32)))).toEqual(nested(32));
  expect(() => mod.boundedJson(nested(33))).toThrow('E_LIMIT');
  const a = open();
  await call(a.token, 'storage.set', { key: 'draft', value: 'Original' });
  await expect(call(a.token, 'storage.set', { key: 'draft', value: nested(33) })).rejects.toMatchObject({ code: 'E_LIMIT' });
  runtime.closeOwner(1);
  const reopened = open();
  expect(await call(reopened.token, 'storage.get', { key: 'draft' })).toEqual({ value: 'Original' });
  await call(reopened.token, 'storage.set', { key: 'draft', value: 'Recovered' });
  expect(await call(reopened.token, 'storage.get', { key: 'draft' })).toEqual({ value: 'Recovered' });
});

it('exports an ordinary long filename without weakening path validation or create-only publication', async () => {
  const a = open();
  const name = 'report-'.repeat(25) + '.txt';
  const target = path.join(root, name);
  host.save = vi.fn(async () => target);
  expect(await call(a.token, 'files.saveAs', { name, text: 'Preserved report' })).toEqual({ saved: true, name });
  expect(host.save).toHaveBeenCalledWith(name);
  expect(await fs.readFile(target, 'utf8')).toBe('Preserved report');
  await expect(call(a.token, 'files.saveAs', { name: '../outside.txt', text: 'Not saved' })).rejects.toMatchObject({ code: 'E_INPUT' });
  expect(host.save).toHaveBeenCalledOnce();
  await expect(call(a.token, 'files.saveAs', { name, text: 'Do not overwrite' })).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await fs.readFile(target, 'utf8')).toBe('Preserved report');
});

it('rejects oversized progress without replay and allows a new explicit request', async () => {
  const a = open();
  const progress = vi.fn();
  host.generate = vi.fn(async (_uid, _args, _signal, emit) => {
    emit({ text: '汉'.repeat(22000) }); // Below 64 Ki characters, above 64 KiB.
    return { text: 'Must not be reported as success' };
  });
  await expect(runtime.call(uid, 1, a.token, 'oversized', 'ai.generate', { prompt: 'Report' }, progress))
    .rejects.toMatchObject({ code: 'E_LIMIT' });
  expect(progress).not.toHaveBeenCalled();
  expect(host.generate).toHaveBeenCalledOnce();
  host.generate = vi.fn(async (_uid, _args, _signal, emit) => { emit({ text: 'Recovered' }); return { text: 'Recovered' }; });
  expect(await runtime.call(uid, 1, a.token, 'retry', 'ai.generate', { prompt: 'Retry' }, progress)).toEqual({ text: 'Recovered' });
  expect(progress).toHaveBeenCalledOnce();
  expect(host.generate).toHaveBeenCalledOnce();
});

it('keeps replay and cancellation independent across page generations and legacy SDK requests', async () => {
  const a = open();
  const first = 'd' + 'a'.repeat(32) + 'q';
  const second = 'd' + 'b'.repeat(32) + 'q';
  const write = (id: string, value: number) => runtime.call(uid, 1, a.token, id, 'storage.set', { key: 'counter', value });
  await write(first + '1', 1);
  await write(second + '1', 2);
  runtime.cancel(uid, 1, a.token, first + '2');
  await expect(write(first + '2', 99)).rejects.toMatchObject({ code: 'E_DUPLICATE' });
  await expect(write(first + '1', 99)).rejects.toMatchObject({ code: 'E_DUPLICATE' });
  await write(second + '2', 3);
  await write('q1', 4);
  expect(await runtime.call(uid, 1, a.token, 'read-counter', 'storage.get', { key: 'counter' })).toEqual({ value: 4 });
});

it('shares initial host discovery across concurrent requests and cancels all work on page departure', async () => {
  const { runInNewContext } = await import('node:vm');
  const source = await fs.readFile(path.resolve('src/main/features/web_apps/sdk.js'), 'utf8');
  vi.useFakeTimers();
  try {
    const listeners: Record<string, (event?: any) => void> = {};
    const parent = { postMessage: vi.fn() };
    const window: any = { parent, addEventListener: (type: string, fn: any) => { listeners[type] = fn; } };
    runInNewContext(source, { window, parent, setTimeout, clearTimeout, crypto: (await import('node:crypto')).webcrypto });
    const requests = [window.orkasApp.call('storage.keys'), window.orkasApp.call('host.getContext')];
    const outcomes = requests.map(request => expect(request).rejects.toMatchObject({ code: 'E_CLOSED' }));
    const ids = parent.postMessage.mock.calls.map(([message]) => message.id);
    listeners.message({ source: parent, data: { __orkasApp: 1, id: ids[0], type: 'ack' } });
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(parent.postMessage).toHaveBeenCalledTimes(2);
    listeners.pagehide();
    await Promise.all(outcomes);
    expect(parent.postMessage.mock.calls.slice(2).map(([message]) => message)).toEqual(ids.map(id => ({ __orkasApp: 1, type: 'cancel', id })));
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it('cannot obtain hosted publication authority from a standalone browser',async()=>{
  const {runInNewContext}=await import('node:vm');const {sdkScript}=await import('../../../src/main/features/web_apps/resources');
  const fetch=vi.fn(),window:any={addEventListener:vi.fn()};window.parent=window;
  runInNewContext(sdkScript('web'),{window,location:{protocol:'https:',hostname:'example.invalid'},document:{currentScript:null,documentElement:{lang:'en'}},navigator:{language:'en'},crypto:(await import('node:crypto')).webcrypto,fetch,AbortController,setTimeout,clearTimeout});
  await expect(window.orkasApp.data.insert({table:'messages',values:{body:'Keep private'}})).rejects.toMatchObject({code:'E_HOST_UNAVAILABLE'});
  expect(fetch).not.toHaveBeenCalled();
});

it('matches the shared independent data contract fixtures through the real browser runtime',async()=>{
  const fixture=JSON.parse(await fs.readFile(path.resolve(__dirname,'../../fixtures/app-data-v1.json'),'utf8'));
  const b=bundle('conformance',['data']);b.appType='web';b.manifest={sdkVersion:1,capabilities:['data'],data:fixture.definition};const app=runtime.open(uid,1,b);
  for(const values of fixture.inserts)await call(app.token,'data.insert',{table:'items',values});
  for(const [method,key] of [['data.query','queries'],['data.aggregate','aggregates']])for(const test of fixture[key])expect(await call(app.token,method,test.args)).toEqual(test.expected);
  for(const test of fixture.rejections){const result=call(app.token,test.method,test.args);if(test.code)await expect(result).rejects.toMatchObject({code:test.code});else await expect(result).rejects.toBeInstanceOf(Error);}
  expect(await call(app.token,'data.count',{table:'items'})).toEqual({count:3});
  expect(await call(app.token,'data.query',fixture.queries[0].args)).toEqual(fixture.queries[0].expected);
});

it('fails grouped analytics explicitly when more than one hundred groups match',async()=>{
  const definition={version:1,tables:[{id:'items',name:'items',fields:[{id:'category',name:'category',type:'string'},{id:'n',name:'n',type:'integer'}],access:{read:['category','n'],insert:['category','n'],aggregate:['n']}}]};
  const b=bundle('group-boundary',['data']);b.appType='web';b.manifest={sdkVersion:1,capabilities:['data'],data:definition};const app=runtime.open(uid,1,b);
  for(let n=0;n<101;n++)await call(app.token,'data.insert',{table:'items',values:{category:String(n),n}});
  await expect(call(app.token,'data.aggregate',{table:'items',field:'n',op:'sum',groupBy:'category'})).rejects.toMatchObject({code:'E_LIMIT'});
});

// Web type contract. The expected common surface is the published v1 product
// contract (Common/docs/plans/app-publishing.md), not a copy of commonMethod().
const WEB_COMMON_V1 = ['capabilities.describe', 'capabilities.list', 'data.aggregate', 'data.count', 'data.insert', 'data.insertIf', 'data.query', 'host.getContext'];
const webBundle = (name: string, data?: any): Bundle => ({ ...bundle(name, data ? ['data'] : []), appType: 'web',
  manifest: data ? { sdkVersion: 1, capabilities: ['data'], data } : { sdkVersion: 1, capabilities: [] } });
const notesDefinition = { version: 1, tables: [{ id: 'notes', name: 'notes', fields: [{ id: 'body', name: 'body', type: 'string' }], access: { read: ['body'], insert: ['body'], count: true } }] };

it('denies every registered host method to a web app before any host adapter or sandbox write runs', async () => {
  const { METHODS } = await import('../../../src/main/features/web_apps/catalog');
  const { webAppSandboxRoot } = await import('../../../src/main/paths');
  const hostOnly = Object.keys(METHODS).filter(name => !WEB_COMMON_V1.includes(name));
  // Guard the derived list: new registry entries are covered automatically,
  // and an empty or truncated list cannot make this case pass vacuously.
  expect(hostOnly).toEqual(expect.arrayContaining(['storage.set', 'appFiles.writeText', 'files.pick', 'files.saveAs', 'ai.generate', 'tools.list', 'tools.call', 'permissions.revoke']));
  const b = webBundle('web-registry'); const app = runtime.open(uid, 1, b);
  for (const name of hostOnly) {
    await expect(call(app.token, name, (METHODS as any)[name].example), name).rejects.toMatchObject({ code: 'E_UNAVAILABLE' });
  }
  for (const adapter of [host.pick, host.save, host.generate, host.tools]) expect(adapter).not.toHaveBeenCalled();
  for (const scope of ['local', 'cloud'] as const) expect(nativeFs.existsSync(webAppSandboxRoot(uid, b.key, scope))).toBe(false);
  // permissions.revoke was denied, so the instance is still open and usable.
  expect(await call(app.token, 'host.getContext')).toMatchObject({ sdkVersion: 1 });
});

it('serves a web app only the common SDK surface inside Orkas: no bridge script, no host stubs, no host schemas', async () => {
  const { runInNewContext } = await import('node:vm');
  const { appResource } = await import('../../../src/main/features/web_apps/resources');
  const { METHODS } = await import('../../../src/main/features/web_apps/catalog');
  const app = runtime.open(uid, 1, webBundle('web-resources'));
  const at = (rel: string) => appResource(new Request(new URL('/' + rel, app.url)), runtime);
  expect(await at('__orkas/bridge.js')).toEqual({ status: 403 });
  const sdk = await at('__orkas/sdk.js'); expect(sdk?.status).toBe(200);
  const parent = { postMessage: vi.fn() }, window: any = { addEventListener: vi.fn(), parent };
  runInNewContext(sdk!.body!, { window, parent, location: { protocol: 'chat-app:', hostname: new URL(app.url).host }, crypto: (await import('node:crypto')).webcrypto, setTimeout, clearTimeout });
  const exposed = Object.entries(window.orkasApp).flatMap(([group, value]) => value && typeof value === 'object' ? Object.keys(value as object).map(method => `${group}.${method}`) : []);
  expect(exposed.sort()).toEqual(WEB_COMMON_V1);
  for (const name of Object.keys(METHODS).filter(name => !WEB_COMMON_V1.includes(name))) {
    await expect(call(app.token, 'capabilities.describe', { method: name }), name).rejects.toMatchObject({ code: 'E_METHOD' });
  }
  expect(await call(app.token, 'capabilities.describe', { method: 'data.insertIf' })).toMatchObject({ name: 'data.insertIf', appTypes: ['local', 'web'] });
});

it('matches the shared stateful data scenarios: retries, relations, read filters, capacity and stable pages', async () => {
  // Same fixture steps are replayed against the Server SQLite runtime; expected
  // values come from the published data contract, never from either runtime.
  const { scenarios } = JSON.parse(await fs.readFile(path.resolve(__dirname, '../../fixtures/app-data-v1.json'), 'utf8'));
  const b = webBundle('shared-scenarios', scenarios.definition);
  let app = runtime.open(uid, 1, b);
  const saved: Record<string, string> = {};
  const resolve = (value: any): any => Array.isArray(value) ? value.map(resolve)
    : value && typeof value === 'object' ? (Object.keys(value).join() === '$ref' ? saved[value.$ref] : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v)]))) : value;
  for (const [index, step] of scenarios.steps.entries()) {
    const label = `step ${index}`;
    if (step.reopen) { runtime.closeOwner(1); await runtime.drainData(); runtime = new mod.WebAppRuntime(host); app = runtime.open(uid, 1, b); continue; }
    if (step.paginate) {
      const pages: any[] = [];
      for (let offset = 0; ; offset += step.pageSize) {
        const { records } = await call(app.token, 'data.query', { ...step.paginate, limit: step.pageSize, offset });
        if (!records.length) break; pages.push(...records);
      }
      const { records: whole } = await call(app.token, 'data.query', { ...step.paginate, limit: 100 });
      expect(pages, label).toEqual(whole);
      expect(pages.map(r => r.rank), label).toEqual(step.expectedRanks);
      expect(pages.map(r => r.title).sort(), label).toEqual(step.expectedTitles);
      continue;
    }
    const result = call(app.token, step.method, resolve(step.args));
    if (step.code) { await expect(result, label).rejects.toMatchObject({ code: step.code }); continue; }
    const value = await result;
    if (step.expected) expect(value, label).toEqual(step.expected);
    if (step.sameIdAs) expect(value, label).toEqual({ id: saved[step.sameIdAs] });
    if (step.save) saved[step.save] = value.id;
  }
});

it('isolates formal data by application and account and closes the previous account immediately', async () => {
  const first = webBundle('isolated-a', notesDefinition), second = webBundle('isolated-b', notesDefinition);
  const a = runtime.open(uid, 1, first), b = runtime.open(uid, 1, second);
  await call(a.token, 'data.insert', { table: 'notes', values: { body: 'A private' } });
  expect(await call(b.token, 'data.query', { table: 'notes' })).toEqual({ records: [] });
  uid = 'account-b';
  await expect(runtime.call('account-a', 1, a.token, 'after-switch', 'data.query', { table: 'notes' })).rejects.toMatchObject({ code: 'E_CLOSED' });
  await expect(runtime.call('account-a', 1, a.token, 'after-switch-write', 'data.insert', { table: 'notes', values: { body: 'late' } })).rejects.toMatchObject({ code: 'E_CLOSED' });
  runtime.closeUser('account-a'); await runtime.drainData();
  const other = runtime.open(uid, 1, first);
  expect(await call(other.token, 'data.count', { table: 'notes' })).toEqual({ count: 0 });
  await call(other.token, 'data.insert', { table: 'notes', values: { body: 'B private' } });
  runtime.closeUser(uid); await runtime.drainData();
  uid = 'account-a';
  const back = runtime.open(uid, 1, first);
  expect(await call(back.token, 'data.query', { table: 'notes' })).toEqual({ records: [{ body: 'A private' }] });
});

it.each(['local', 'web'] as const)('rejects record update and delete from a %s app without changing records', async appType => {
  const b = { ...webBundle('no-mutation-' + appType, notesDefinition), appType };
  const app = runtime.open(uid, 1, b);
  const { id } = await call(app.token, 'data.insert', { table: 'notes', values: { body: 'KEEP' } });
  for (const [method, args] of [['data.update', { table: 'notes', id, values: { body: 'changed' } }], ['data.delete', { table: 'notes', id }], ['data.deleteMany', { table: 'notes' }]] as const)
    await expect(call(app.token, method, args), method).rejects.toMatchObject({ code: 'E_METHOD' });
  expect(await call(app.token, 'data.query', { table: 'notes' })).toEqual({ records: [{ body: 'KEEP' }] });
});

it('bounds concurrently open application databases and recovers once one closes', async () => {
  const apps = Array.from({ length: 5 }, (_, n) => { const b = webBundle('bounded-' + n, notesDefinition); return { b, app: runtime.open(uid, 1, b) }; });
  for (const { app } of apps.slice(0, 4)) expect(await call(app.token, 'data.count', { table: 'notes' })).toEqual({ count: 0 });
  await expect(call(apps[4].app.token, 'data.insert', { table: 'notes', values: { body: 'refused' } })).rejects.toMatchObject({ code: 'E_BUSY' });
  runtime.close(uid, 1, apps[0].app.token); await runtime.drainData();
  await call(apps[4].app.token, 'data.insert', { table: 'notes', values: { body: 'accepted' } });
  expect(await call(apps[4].app.token, 'data.query', { table: 'notes' })).toEqual({ records: [{ body: 'accepted' }] });
});
