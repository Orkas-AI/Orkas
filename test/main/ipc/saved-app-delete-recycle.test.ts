/** A saved-app delete that fails must leave the app and the recycle bin as they were. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';
import { drainMainRuntimeForTest } from '../../helpers/drain-main-runtime';
import { captureMainLogWorkers } from '../../helpers/capture-main-log-workers';
import { expectTestLog } from '../../helpers/test-log-analysis';

vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  BrowserWindow: { getAllWindows: vi.fn(() => []), getFocusedWindow: vi.fn(() => null) },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn(async () => '') },
  systemPreferences: { getMediaAccessStatus: vi.fn(() => 'granted'), askForMediaAccess: vi.fn(async () => true) },
}));
vi.mock('../../../src/main/model/client', () => ({
  async *streamChatWithModel() { yield { type: 'done' }; },
  async chatWithModel() { return { ok: true, text: '' }; },
}));
// Deletion now verifies publication for every saved app, including legacy local metadata.
vi.mock('../../../src/main/features/account/state', () => ({ isSessionVerified: () => true }));
vi.mock('../../../src/main/features/account/token_store', () => ({
  getSession: () => ({ user_id: 'uSavedAppDeleteRecycle', session_id: 'synthetic' }),
  isCurrentSession: () => true,
}));
vi.mock('../../../src/main/features/account/http', async original => ({
  ...await original<any>(), getJson: async () => ({ok:true,data:{apps:[],quota:{tier:'lite',used:0,limit:3,deadline:0,excess:0}}}),
}));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

const UID = 'uSavedAppDeleteRecycle';
let tmpDir: string, previousWorkspace: string | undefined;
let closeLogs: () => Promise<void>;
beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-saved-app-delete-'));
  previousWorkspace = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  closeLogs = await captureMainLogWorkers();
  (await import('../../../src/main/features/users')).activateUser(UID);
});
afterEach(async () => {
  await drainMainRuntimeForTest();
  await closeLogs();
  if (previousWorkspace === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspace;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function invoke(channel: string, payload: Record<string, unknown>): Promise<any> {
  const electron = await import('electron') as any;
  const { register } = await import('../../../src/main/ipc/index');
  electron.ipcMain.handle.mockClear();
  register();
  const call = electron.ipcMain.handle.mock.calls.find(([name]: [string]) => name === 'orkas.invoke');
  return call[1]({ sender: trustedIpcSender() }, { channel, payload });
}

async function appWithData() {
  const artifacts = await import('../../../src/main/features/chat_artifacts');
  const saved = await import('../../../src/main/features/saved_apps');
  const recycleBin = await import('../../../src/main/features/recycle_bin');
  const { LocalAppData } = await import('../../../src/main/features/web_apps/data');
  const definition: ConstructorParameters<typeof LocalAppData>[2] = {version:1,tables:[{id:'notes',name:'notes',fields:[{id:'body',name:'body',type:'string'}],access:{read:['body'],insert:['body']}}]};
  const created = await artifacts.createArtifact(UID, 'c1', 'helper', { files: [
    { path: 'index.html', content: '<h1>Keep</h1>' },
    { path:'orkas-app.json',content:JSON.stringify({sdkVersion:1,capabilities:['data'],data:definition}) },
  ] });
  if (!created.ok) throw new Error(created.error);
  const app = await saved.saveFromArtifact(UID, 'c1', created.artifactId);
  if (!app.ok) throw new Error(app.error);
  const key = crypto.createHash('sha256').update(JSON.stringify(['saved', app.id])).digest('hex');
  const local = path.join(tmpDir, UID, 'local/web_apps', key);
  const databaseFile=path.join(local,'data.sqlite');
  const database=new LocalAppData(databaseFile,path.join(tmpDir,UID,'local'),definition);
  try {await database.call('data.insert',{table:'notes',values:{body:'KEEP'}});}finally{await database.close();}
  const localBytes=fs.readFileSync(databaseFile);
  const records=async()=>{
    const db=new LocalAppData(databaseFile,path.join(tmpDir,UID,'local'),definition);
    try{return await db.call('data.query',{table:'notes'});}finally{await db.close();}
  };
  const cloud = path.join(tmpDir, UID, 'cloud/web_apps', key);
  fs.mkdirSync(cloud, { recursive: true }); fs.writeFileSync(path.join(cloud, 'state.json'), '{"keep":true}');
  return { saved, recycleBin, app, key, local, cloud, localBytes, records, appDir:path.join(tmpDir,UID,'cloud/saved_apps',app.id) };
}

it.each(['data-detach', 'cloud-detach', 'app-lookup'])('drops the recycle copy after a %s failure, then recycles a successful retry once', async source => {
  expectTestLog({level:'error',source:'ipc',message:/^invoke savedApps\.delete failed \{$/});
  const { saved, recycleBin, app, key, local, cloud, localBytes, records } = await appWithData();
  const nodeFs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const lstat = nodeFs.lstatSync, appDir = path.join(tmpDir, UID, 'cloud/saved_apps', app.id);
  let lookupArmed = false;
  const remove = saved.deleteSavedApp;
  const deletion = vi.spyOn(saved, 'deleteSavedApp').mockImplementation(async (uid, appId) => {
    lookupArmed = true;
    return remove(uid, appId);
  });
  const rename = nodeFs.renameSync;
  const dataFault = vi.spyOn(nodeFs, 'renameSync').mockImplementation((from, to) => {
    if ((source === 'data-detach' && String(from) === local) || (source === 'cloud-detach' && String(from) === cloud))
      throw Object.assign(new Error('fixture data detachment denied'), { code: 'EIO' });
    return rename(from, to);
  });
  const lookupFault = vi.spyOn(nodeFs, 'lstatSync').mockImplementation(((target: any, ...args: any[]) => {
    if (source === 'app-lookup' && lookupArmed && String(target) === appDir) throw Object.assign(new Error('PRIVATE app lookup unavailable'), { code: 'EIO' });
    return (lstat as any)(target, ...args);
  }) as any);
  syncBuiltinESMExports();
  let failed: any;
  try { failed = await invoke('savedApps.delete', { appId: app.id }); }
  finally { dataFault.mockRestore(); lookupFault.mockRestore(); deletion.mockRestore(); syncBuiltinESMExports(); }
  expect(failed).toMatchObject({ ok: false, code: 'app_delete_failed', error: 'app_delete_failed' });
  expect(JSON.stringify(failed)).not.toContain(tmpDir);
  expect(fs.readFileSync(path.join(local, 'data.sqlite'))).toEqual(localBytes);
  expect(await records()).toEqual({records:[{body:'KEEP'}]});
  expect(fs.readFileSync(path.join(cloud, 'state.json'), 'utf8')).toBe('{"keep":true}');
  expect(await recycleBin.listRecycleBatches(UID)).toEqual([]);
  expect(saved.listSavedApps(UID).map(item => item.id)).toEqual([app.id]);
  expect(await invoke('savedApps.delete', { appId: app.id })).toEqual({ ok: true });
  expect(saved.listSavedApps(UID)).toEqual([]);
  expect(await recycleBin.listRecycleBatches(UID)).toHaveLength(1);
});


it('keeps a committed delete successful when staged cleanup fails, excludes its data from sync, and finishes later', async () => {
  const { saved, recycleBin, app, key, local, cloud, appDir } = await appWithData();
  const fsp = await import('node:fs/promises');
  const { rm } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const { isAtomicWriteTempPath } = await import('../../../src/main/storage');
  const spy = vi.spyOn(fsp,'rm').mockImplementation(async (target, options) => {
    if (String(target).startsWith(cloud+'.') && isAtomicWriteTempPath(String(target)))
      throw Object.assign(new Error('fixture staged cleanup unavailable'), {code:'EIO'});
    return rm(target,options);
  });
  try { expect(await invoke('savedApps.delete',{appId:app.id})).toEqual({ok:true}); }
  finally {spy.mockRestore();}
  expect(fs.existsSync(appDir)).toBe(false);
  expect(fs.existsSync(local)).toBe(false);expect(fs.existsSync(cloud)).toBe(false);
  const paths = await import('../../../src/main/paths');
  const intentFile = path.join(paths.userAppDeletesDir(UID),app.id+'.json');
  const intent = JSON.parse(fs.readFileSync(intentFile,'utf8'));
  const stagedCloud = path.join(path.dirname(cloud),intent.dataStaging.cloud);
  expect(fs.readFileSync(path.join(stagedCloud,'state.json'),'utf8')).toBe('{"keep":true}');
  expect(saved.listSavedApps(UID)).toEqual([]);
  await vi.waitFor(()=>expect(fs.existsSync(intentFile)).toBe(false));
  expect(fs.existsSync(stagedCloud)).toBe(false);
  expect(await recycleBin.listRecycleBatches(UID)).toHaveLength(1);
});

it('retains the recycle copy and deletion journal if the filesystem also refuses rollback', async () => {
  expectTestLog({level:'error',source:'ipc',message:/^invoke savedApps\.delete failed \{$/});
  const { saved, recycleBin, app, local, cloud, localBytes, appDir } = await appWithData();
  const nodeFs=(await import('node:fs')).default;
  const {syncBuiltinESMExports}=await import('node:module');
  const rename=nodeFs.renameSync;
  const spy=vi.spyOn(nodeFs,'renameSync').mockImplementation((from,to)=>{
    if(String(from)===cloud || (String(from).startsWith(local+'.')&&String(to)===local))
      throw Object.assign(new Error('fixture detachment and rollback denied'),{code:'EIO'});
    return rename(from,to);
  });
  syncBuiltinESMExports();
  try {expect(await invoke('savedApps.delete',{appId:app.id})).toMatchObject({ok:false,code:'app_delete_failed'});}
  finally{spy.mockRestore();syncBuiltinESMExports();}
  const paths=await import('../../../src/main/paths');
  const intentFile=path.join(paths.userAppDeletesDir(UID),app.id+'.json');
  const intent=JSON.parse(fs.readFileSync(intentFile,'utf8'));
  const stagedLocal=path.join(path.dirname(local),intent.dataStaging.local);
  expect(fs.readFileSync(path.join(stagedLocal,'data.sqlite'))).toEqual(localBytes);
  expect(fs.readFileSync(path.join(cloud,'state.json'),'utf8')).toBe('{"keep":true}');
  expect(fs.existsSync(appDir)).toBe(false);
  expect(await recycleBin.listRecycleBatches(UID)).toHaveLength(1);
  // The retained intent uses the existing interrupted-delete recovery policy.
  expect(saved.listSavedApps(UID)).toEqual([]);
  await vi.waitFor(()=>expect(fs.existsSync(intentFile)).toBe(false));
  expect(fs.existsSync(stagedLocal)).toBe(false);expect(fs.existsSync(cloud)).toBe(false);
  expect(await recycleBin.listRecycleBatches(UID)).toHaveLength(1);
});

it('recovers a durable boundary snapshot taken between local and cloud data detachment', async () => {
  const { saved, app, local, cloud, localBytes }=await appWithData();
  const paths=await import('../../../src/main/paths');
  const roots=[path.join(tmpDir,UID,'cloud/saved_apps'),path.dirname(local),path.dirname(cloud),paths.userAppDeletesDir(UID)];
  const cut=path.join(tmpDir,'durable-cut');
  const nodeFs=(await import('node:fs')).default;
  const {syncBuiltinESMExports}=await import('node:module');
  const rename=nodeFs.renameSync;let captured=false;
  const spy=vi.spyOn(nodeFs,'renameSync').mockImplementation((from,to)=>{
    rename(from,to);
    if(String(from)===local&&!captured){
      captured=true;
      for(const [index,dir] of roots.entries()) fs.cpSync(dir,path.join(cut,String(index)),{recursive:true});
    }
  });
  syncBuiltinESMExports();
  try {expect(await saved.deleteSavedApp(UID,app.id)).toEqual({ok:true});}
  finally{spy.mockRestore();syncBuiltinESMExports();}
  expect(captured).toBe(true);
  await drainMainRuntimeForTest();
  for(const [index,dir] of roots.entries()){
    fs.rmSync(dir,{recursive:true,force:true});
    fs.cpSync(path.join(cut,String(index)),dir,{recursive:true});
  }
  expect(fs.existsSync(local)).toBe(false);expect(fs.existsSync(cloud)).toBe(true);
  const intentFile=path.join(paths.userAppDeletesDir(UID),app.id+'.json');
  const intent=JSON.parse(fs.readFileSync(intentFile,'utf8'));
  const stagedLocal=path.join(path.dirname(local),intent.dataStaging.local);
  expect(fs.readFileSync(path.join(stagedLocal,'data.sqlite'))).toEqual(localBytes);
  vi.resetModules();(await import('../../../src/main/features/users')).activateUser(UID);
  const restarted=await import('../../../src/main/features/saved_apps');
  expect(restarted.listSavedApps(UID)).toEqual([]);
  await vi.waitFor(()=>expect(fs.existsSync(intentFile)).toBe(false));
  for(const dir of [local,cloud,stagedLocal]) expect(fs.existsSync(dir)).toBe(false);
});

it.each(['../outside', 'other.1.1700000000000.deadbeef.tmp'])('rejects an unsafe staged-data journal name %s without deleting records', async name => {
  const { saved, app, local, cloud, localBytes, appDir }=await appWithData();
  const paths=await import('../../../src/main/paths');
  fs.renameSync(appDir,appDir+'.tmp-deadbeef');
  const intentFile=path.join(paths.userAppDeletesDir(UID),app.id+'.json');
  fs.mkdirSync(path.dirname(intentFile),{recursive:true});
  fs.writeFileSync(intentFile,JSON.stringify({version:1,appId:app.id,files:['index.html'],cloudFiles:['state.json'],dataStaging:{local:name,cloud:name}}));
  saved.listSavedApps(UID);
  // Wait for the pending recovery through its owning public deletion entry.
  expect(await saved.deleteSavedApp(UID,'MissingControl')).toEqual({ok:true});
  expect(fs.existsSync(intentFile)).toBe(true);
  expect(fs.readFileSync(path.join(local,'data.sqlite'))).toEqual(localBytes);
  expect(fs.readFileSync(path.join(cloud,'state.json'),'utf8')).toBe('{"keep":true}');
});

it('preserves the first deletion journal when a duplicate request arrives during staged cleanup', async () => {
  const { saved, app, cloud }=await appWithData();
  const paths=await import('../../../src/main/paths');
  const intentFile=path.join(paths.userAppDeletesDir(UID),app.id+'.json');
  const fsp=await import('node:fs/promises');
  const {rm}=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  let release!:()=>void,reached!:()=>void,paused=false;
  const gate=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{reached=resolve;});
  const spy=vi.spyOn(fsp,'rm').mockImplementation(async(target,options)=>{
    if(!paused&&String(target).startsWith(cloud+'.')&&String(target).endsWith('.tmp')){
      paused=true;reached();await gate;
    }
    return rm(target,options);
  });
  const first=saved.deleteSavedApp(UID,app.id);
  try {
    await ready;
    const before=fs.readFileSync(intentFile,'utf8');
    expect.soft(await saved.deleteSavedApp(UID,app.id)).toEqual({ok:false,error:'app_delete_failed',recoveryPending:true});
    expect.soft(fs.existsSync(intentFile)?fs.readFileSync(intentFile,'utf8'):null).toBe(before);
    saved.listSavedApps(UID);
    expect.soft(fs.existsSync(intentFile)?fs.readFileSync(intentFile,'utf8'):null).toBe(before);
  } finally {release();spy.mockRestore();}
  expect(await first).toEqual({ok:true});
  expect(fs.existsSync(intentFile)).toBe(false);
});

it.each([false,true])('finishes detached-data cleanup after recycle restoration without touching new records (cleanup still denied: %s)', async denied => {
  const { saved, recycleBin, app, local, cloud, appDir, records } = await appWithData();
  const fsp = await import('node:fs/promises');
  const { rm } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  let blocked = true;
  const spy = vi.spyOn(fsp,'rm').mockImplementation(async (target,options) => {
    if (String(target).startsWith(cloud+'.') && String(target).endsWith('.tmp')) {
      if (blocked) throw Object.assign(new Error('fixture old cleanup unavailable'),{code:'EIO'});
    }
    return rm(target,options);
  });
  try {
    expect(await invoke('savedApps.delete',{appId:app.id})).toEqual({ok:true});
    const paths = await import('../../../src/main/paths');
    const intentFile = path.join(paths.userAppDeletesDir(UID),app.id+'.json');
    const intent = JSON.parse(fs.readFileSync(intentFile,'utf8'));
    const stagedCloud = path.join(path.dirname(cloud),intent.dataStaging.cloud);
    const batch = (await recycleBin.listRecycleBatches(UID))[0];
    const restored = await recycleBin.restoreRecycleBatch(UID,batch.id);
    expect(restored.failed_paths).toEqual([]);
    expect(fs.existsSync(path.join(appDir,'index.html'))).toBe(true);
    // A restored app starts fresh data; old detached resources belong only to
    // the completed delete, never to the new sandbox at the canonical path.
    const { LocalAppData } = await import('../../../src/main/features/web_apps/data');
    const definition = JSON.parse(fs.readFileSync(path.join(appDir,'orkas-app.json'),'utf8')).data;
    const database = new LocalAppData(path.join(local,'data.sqlite'),path.join(tmpDir,UID,'local'),definition);
    try { await database.call('data.insert',{table:'notes',values:{body:'NEW'}}); }
    finally { await database.close(); }
    const bytes = fs.readFileSync(path.join(local,'data.sqlite'));
    fs.mkdirSync(cloud,{recursive:true});fs.writeFileSync(path.join(cloud,'state.json'),'new state');
    blocked = denied;
    expect(saved.listSavedApps(UID).map(item=>item.id)).toEqual([app.id]);
    // This public action waits for listing-triggered recovery to settle.
    expect(await saved.deleteSavedApp(UID,'MissingControl')).toEqual({ok:true});
    if (denied) {
      expect.soft(fs.existsSync(intentFile)).toBe(true);
      expect.soft(fs.readFileSync(path.join(stagedCloud,'state.json'),'utf8')).toBe('{"keep":true}');
      blocked = false;
      saved.listSavedApps(UID);
      expect(await saved.deleteSavedApp(UID,'MissingControl')).toEqual({ok:true});
    }
    expect.soft(fs.existsSync(stagedCloud)).toBe(false);
    expect.soft(fs.existsSync(intentFile)).toBe(false);
    expect(fs.readFileSync(path.join(local,'data.sqlite'))).toEqual(bytes);
    expect(await records()).toEqual({records:[{body:'NEW'}]});
    expect(fs.readFileSync(path.join(cloud,'state.json'),'utf8')).toBe('new state');
    expect(fs.existsSync(path.join(appDir,'index.html'))).toBe(true);
    expect(await recycleBin.listRecycleBatches(UID)).toHaveLength(1);
  } finally { spy.mockRestore(); }
});

it.each(['legacy','torn','unsafe-staging'])('voids an uncommitted %s intent for a present app without deleting its records', async kind => {
  const { saved, app, cloud, local, localBytes, records } = await appWithData();
  const { userAppDeletesDir } = await import('../../../src/main/paths');
  const dir = userAppDeletesDir(UID), file = path.join(dir,app.id+'.json');
  fs.mkdirSync(dir,{recursive:true});
  const intent = {version:1,appId:app.id,files:['index.html'],cloudFiles:['state.json'],
    ...(kind==='unsafe-staging'?{dataStaging:{local:'../outside',cloud:'../outside'}}:{})};
  fs.writeFileSync(file,kind==='torn'?' {"version":1,':JSON.stringify(intent));
  expect(saved.listSavedApps(UID).map(item=>item.id)).toEqual([app.id]);
  expect(await saved.deleteSavedApp(UID,'MissingControl')).toEqual({ok:true});
  expect(fs.existsSync(file)).toBe(false);
  expect(fs.readFileSync(path.join(local,'data.sqlite'))).toEqual(localBytes);
  expect(await records()).toEqual({records:[{body:'KEEP'}]});
  expect(fs.readFileSync(path.join(cloud,'state.json'),'utf8')).toBe('{"keep":true}');
});

it.each([false,true])('retries an outstanding delete without losing its journal or sweeping another app (cleanup still denied: %s)', async denied => {
  const { saved, recycleBin, app, local, cloud } = await appWithData();
  const { userAppDeletesDir } = await import('../../../src/main/paths');
  const fsp = await import('node:fs/promises');
  const { rm } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  let blocked = true;
  const spy = vi.spyOn(fsp,'rm').mockImplementation(async(target,options)=>{
    if(blocked && String(target).startsWith(cloud+'.') && String(target).endsWith('.tmp'))
      throw Object.assign(new Error('fixture pending deletion cleanup unavailable'),{code:'EIO'});
    return rm(target,options);
  });
  try {
    expect(await invoke('savedApps.delete',{appId:app.id})).toEqual({ok:true});
    const intentFile = path.join(userAppDeletesDir(UID),app.id+'.json');
    const before = fs.readFileSync(intentFile,'utf8'), intent = JSON.parse(before);
    const stagedCloud = path.join(path.dirname(cloud),intent.dataStaging.cloud);
    // An explicit retry owns this app only. Opening the global list would
    // intentionally recover other apps too, so it is not used as the retry.
    const otherId = 'OtherPending', otherIntent = path.join(userAppDeletesDir(UID),otherId+'.json');
    const otherKey = crypto.createHash('sha256').update(JSON.stringify(['saved',otherId])).digest('hex');
    const otherCloud = path.join(path.dirname(cloud),otherKey);
    fs.mkdirSync(otherCloud,{recursive:true});fs.writeFileSync(path.join(otherCloud,'state.json'),'other state');
    const otherJournal = JSON.stringify({version:1,appId:otherId,files:[],cloudFiles:['state.json']});
    fs.writeFileSync(otherIntent,otherJournal);
    blocked = denied;
    const retry = await saved.deleteSavedApp(UID,app.id);
    if(denied) {
      expect.soft(retry).toEqual({ok:false,error:'app_delete_failed',recoveryPending:true});
      expect.soft(fs.existsSync(intentFile)?fs.readFileSync(intentFile,'utf8'):null).toBe(before);
      expect.soft(fs.readFileSync(path.join(stagedCloud,'state.json'),'utf8')).toBe('{"keep":true}');
      blocked = false;
      expect(await saved.deleteSavedApp(UID,app.id)).toEqual({ok:true});
    } else expect(retry).toEqual({ok:true});
    expect.soft(fs.existsSync(stagedCloud)).toBe(false);
    expect(fs.existsSync(intentFile)).toBe(false);
    expect(fs.existsSync(local)).toBe(false);expect(fs.existsSync(cloud)).toBe(false);
    expect(fs.readFileSync(otherIntent,'utf8')).toBe(otherJournal);
    expect(fs.readFileSync(path.join(otherCloud,'state.json'),'utf8')).toBe('other state');
    expect(await recycleBin.listRecycleBatches(UID)).toHaveLength(1);
  } finally {spy.mockRestore();}
});

it('finishes an uncommitted intent before an explicit delete of the present app', async()=>{
  const {saved,app,local,cloud}=await appWithData();
  const {userAppDeletesDir}=await import('../../../src/main/paths');
  const dir=userAppDeletesDir(UID),file=path.join(dir,app.id+'.json');fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(file,JSON.stringify({version:1,appId:app.id,files:['index.html'],cloudFiles:['state.json']}));
  expect(await saved.deleteSavedApp(UID,app.id)).toEqual({ok:true});
  expect(fs.existsSync(file)).toBe(false);
  expect(fs.existsSync(local)).toBe(false);expect(fs.existsSync(cloud)).toBe(false);
});

it('retains a deletion intent and records when its presence cannot be inspected, then permits explicit retry',async()=>{
  const {saved,app,local,cloud,localBytes,records}=await appWithData();
  const {userAppDeletesDir}=await import('../../../src/main/paths');
  const dir=userAppDeletesDir(UID),file=path.join(dir,app.id+'.json');fs.mkdirSync(dir,{recursive:true});
  const journal=JSON.stringify({version:1,appId:app.id,files:['index.html'],cloudFiles:['state.json']});fs.writeFileSync(file,journal);
  const nodeFs=(await import('node:fs')).default,{syncBuiltinESMExports}=await import('node:module');
  const lstat=nodeFs.lstatSync;
  const spy=vi.spyOn(nodeFs,'lstatSync').mockImplementation(((target:any,...args:any[])=>{
    if(String(target)===file)throw Object.assign(new Error('fixture intent lookup unavailable'),{code:'EIO'});
    return (lstat as any)(target,...args);
  }) as any);syncBuiltinESMExports();
  try {expect.soft(await saved.deleteSavedApp(UID,app.id)).toEqual({ok:false,error:'app_delete_failed',recoveryPending:true});}
  finally {spy.mockRestore();syncBuiltinESMExports();}
  expect.soft(fs.existsSync(file)?fs.readFileSync(file,'utf8'):null).toBe(journal);
  expect.soft(fs.existsSync(path.join(local,'data.sqlite'))?crypto.createHash('sha256').update(fs.readFileSync(path.join(local,'data.sqlite'))).digest('hex'):null)
    .toBe(crypto.createHash('sha256').update(localBytes).digest('hex'));
  if(fs.existsSync(path.join(local,'data.sqlite')))expect.soft(await records()).toEqual({records:[{body:'KEEP'}]});
  expect.soft(fs.existsSync(path.join(cloud,'state.json'))?fs.readFileSync(path.join(cloud,'state.json'),'utf8'):null).toBe('{"keep":true}');
  expect(await saved.deleteSavedApp(UID,app.id)).toEqual({ok:true});
});

