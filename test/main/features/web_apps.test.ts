import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import nativeFs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
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
  if (prev === undefined) delete process.env.ORKAS_WORKSPACE_ROOT; else process.env.ORKAS_WORKSPACE_ROOT = prev;
  await fs.rm(root, { recursive: true, force: true });
});
describe('Web app capability journeys', () => {
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
    expect((await call(a.token,'capabilities.describe',{method:'ai.generate'})).inputSchema.properties.maxTokens.maximum).toBe(4096);
    expect(catalog.unsupported.find((m: any) => m.capability === 'shell').reason).toContain('Host-only');
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
    expect(runtime.resource(hostname,'index.html','chat-app://foreign')).toBeNull();
    expect(runtime.resource(hostname,'../private',null)).toBeNull();
    runtime.closeUser(uid); uid='account-b';
    await expect(call(a.token,'storage.keys')).rejects.toMatchObject({code:'E_CLOSED'});
    expect(await call(open().token,'storage.get',{key:'private'})).toEqual({value:null});
    expect(runtime.resource(hostname,'index.html',null)).toBeNull();
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
    await fs.writeFile(file,Buffer.alloc(512*1024+1));
    await expect(call(a.token,'files.pick')).rejects.toMatchObject({code:'E_LIMIT'});
  });
  it('bounds nested and oversized JSON before persistence', async () => {
    const a=open(); await expect(call(a.token,'storage.set',{key:'x',value:'a'.repeat(1024*1024)})).rejects.toMatchObject({code:'E_LIMIT'});
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
  it('delivers streaming progress and usage with a bounded default output', async () => {
    const a=open(), progress=vi.fn(); host.generate=vi.fn(async(_uid,_args,_signal,out)=>{out({type:'delta',text:'Hi'});return {text:'Hi',usage:{outputTokens:1},stopReason:'end_turn'};});
    expect(await runtime.call(uid,1,a.token,'model','ai.generate',{prompt:'Hello'},progress)).toMatchObject({text:'Hi',usage:{outputTokens:1}});
    expect(progress).toHaveBeenCalledWith({type:'delta',text:'Hi'});
    expect(host.generate).toHaveBeenCalledWith(uid,{prompt:'Hello',maxTokens:1024},expect.any(AbortSignal),expect.any(Function));
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
  it('preserves owning tool failures and rejects oversized results without replay', async () => {
    const execute=vi.fn(async()=>({content:'Denied',isError:true}));
    host.tools=vi.fn(async()=>[{name:'library',capability:'library',description:'',inputSchema:{},execute}]); const a=open();
    expect(await call(a.token,'tools.call',{name:'library',arguments:{action:'list'}})).toEqual({content:'Denied',isError:true});
    execute.mockResolvedValueOnce({content:'x'.repeat(1024*1024+1),isError:false});
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
  it('bounds expensive work across applications and releases capacity after cancellation', async () => {
    let started = 0;
    host.generate = vi.fn(async (_u, _a, signal) => {
      started++;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new mod.AppError('E_CANCELLED')), { once: true }));
    });
    const a = open('a'), b = open('b'), c = open('c');
    const runs = [call(a.token, 'ai.generate', { prompt: 'First' }), call(b.token, 'ai.generate', { prompt: 'Second' })];
    const outcomes = Promise.allSettled(runs);
    await vi.waitFor(() => expect(started).toBe(2));
    await expect(call(c.token, 'ai.generate', { prompt: 'Third' })).rejects.toMatchObject({ code: 'E_BUSY' });
    runtime.closeOrigin(1, a.url); runtime.closeOrigin(1, b.url);
    expect((await outcomes).every(r => r.status === 'rejected')).toBe(true);
    host.generate = vi.fn(async () => ({ text: 'Recovered' }));
    expect(await call(c.token, 'ai.generate', { prompt: 'Recovered' })).toEqual({ text: 'Recovered' });
  });
  it('expires authority even if no new application is opened', async () => {
    const a = open(); const now = Date.now();
    const time = vi.spyOn(Date, 'now').mockReturnValue(now + 13 * 60 * 60 * 1000);
    try {
      await expect(call(a.token, 'storage.keys')).rejects.toMatchObject({ code: 'E_CLOSED' });
      expect(runtime.resource(new URL(a.url).host, 'index.html', null)).toBeNull();
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

  it('rejects undeclared calls, traversal, aliases, malformed binary and excessive data without publication', async () => {
    const a = open('sandbox', ['appFiles']);
    const limited = open('limited', []);
    await expect(call(limited.token, 'appFiles.list')).rejects.toMatchObject({ code: 'E_NOT_DECLARED' });
    for (const file of ['../other', '/absolute', 'a//b', 'a/./b', 'a\\b', 'C:evil', '.private', 'x\0y', 'aux.txt', 'a.', 'a ', 'visibility/data', 'Thumbs.db', 'desktop.ini', 'file.123.1789440000000.1234abcd.tmp']) {
      await expect(call(a.token, 'appFiles.writeText', { path: file, text: 'escape' })).rejects.toMatchObject({ code: 'E_INPUT' });
    }
    await expect(call(a.token, 'appFiles.writeBase64', { path: 'bad', base64: 'not base64' })).rejects.toMatchObject({ code: 'E_INPUT' });
    await expect(call(a.token, 'appFiles.writeText', { path: 'large', text: '你'.repeat(200000) })).rejects.toMatchObject({ code: 'E_LIMIT' });
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

  it('enforces aggregate quota and supports recovery by deleting a file', async () => {
    const a = open('quota', ['appFiles']);
    const paths = await import('../../../src/main/paths');
    const rootFiles = path.join(paths.webAppSandboxRoot(uid, bundle('quota').key, 'cloud'), 'files');
    await fs.mkdir(rootFiles, { recursive: true });
    for (let i = 0; i < 32; i++) await fs.writeFile(path.join(rootFiles, `${i}.bin`), Buffer.alloc(512 * 1024));
    await expect(call(a.token, 'appFiles.writeText', { path: 'one.txt', text: 'one' })).rejects.toMatchObject({ code: 'E_LIMIT' });
    await call(a.token, 'appFiles.remove', { path: '0.bin' });
    await call(a.token, 'appFiles.writeText', { path: 'one.txt', text: 'one' });
    expect(await call(a.token, 'appFiles.readText', { path: 'one.txt' })).toEqual({ text: 'one' });
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
