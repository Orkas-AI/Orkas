/** File-save recovery keeps authorization, identity and data across native dialogs. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';
import { drainMainRuntimeForTest } from '../../helpers/drain-main-runtime';

vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  dialog: { showSaveDialog: vi.fn(async () => ({ canceled: true, filePath: undefined })) },
  BrowserWindow: { getAllWindows: vi.fn(() => []), getFocusedWindow: vi.fn(() => null) },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn(async () => '') },
  systemPreferences: { getMediaAccessStatus: vi.fn(() => 'granted'), askForMediaAccess: vi.fn(async () => true) },
}));
vi.mock('../../../src/main/model/client', () => ({
  async *streamChatWithModel() { yield { type: 'done' }; },
  async chatWithModel() { return { ok: true, text: '' }; },
}));
const UID = 'uSavedAppPathRecovery';
let tmpDir: string, previousWorkspace: string | undefined;
beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-saved-app-recovery-'));
  previousWorkspace = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  vi.clearAllMocks();
  (await import('../../../src/main/features/users')).activateUser(UID);
});
afterEach(async () => {
  await drainMainRuntimeForTest();
  if (previousWorkspace === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspace;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function invoke(channel: string, payload: Record<string, unknown>): Promise<any> {
  const electron = await import('electron') as any;
  const { register } = await import('../../../src/main/ipc/index');
  register();
  const call = electron.ipcMain.handle.mock.calls.find(([name]: [string]) => name === 'orkas.invoke');
  return call[1]({ sender: trustedIpcSender() }, { channel, payload });
}

async function sourceWithData() {
  const workspace=path.join(tmpDir,'workspace'),root=path.join(workspace,'app');
  fs.mkdirSync(root,{recursive:true});
  (await import('../../../src/main/features/user_workspace')).setWorkspacePath(UID,workspace);
  const entry=path.join(root,'index.html'),manifest=path.join(root,'orkas-app.json');
  const definition:any={version:1,tables:[{id:'notes',name:'notes',fields:[{id:'body',name:'body',type:'string'}],access:{read:['body'],insert:['body']}}]};
  fs.writeFileSync(entry,'<h1>Original</h1>');fs.writeFileSync(manifest,JSON.stringify({sdkVersion:1,capabilities:['data'],data:definition}));
  const payload={path:entry};const app=await invoke('savedApps.saveFromPath',payload);expect(app.ok).toBe(true);
  const {LocalAppData}=await import('../../../src/main/features/web_apps/data');
  const key=crypto.createHash('sha256').update(JSON.stringify(['saved',app.id])).digest('hex');
  const file=path.join(tmpDir,UID,'local/web_apps',key,'data.sqlite');
  const db=new LocalAppData(file,path.join(tmpDir,UID,'local'),definition);try{await db.call('data.insert',{table:'notes',values:{body:'KEEP'}});}finally{await db.close();}
  const records=async()=>{const db=new LocalAppData(file,path.join(tmpDir,UID,'local'),definition);try{return await db.call('data.query',{table:'notes'});}finally{await db.close();}};
  fs.writeFileSync(entry,'<h1>Updated</h1>');fs.writeFileSync(manifest,JSON.stringify({sdkVersion:1,capabilities:['data'],data:{version:1,tables:[]}}));
  return {payload,app,records};
}

it('opens an untyped app externally and still rejects invalid paths',async()=>{
  const {app}=await sourceWithData();
  fs.writeFileSync(path.join(tmpDir,UID,'cloud/saved_apps',app.id,'__orkas-meta.json'),'{}');
  const {shell}=await import('electron');
  expect(await invoke('savedApps.openExternal',{appId:app.id})).toMatchObject({ok:true});
  expect(shell.openPath).toHaveBeenCalledExactlyOnceWith(path.join(tmpDir,UID,'cloud/saved_apps',app.id,'index.html'));
  for(const appId of ['../outside','missing-app'])
    expect(await invoke('savedApps.openExternal',{appId})).toMatchObject({ok:false});
  expect(shell.openPath).toHaveBeenCalledTimes(1);
});

it('exposes impact/export and applies confirmed file recovery through real IPC',async()=>{
  const {payload,app,records}=await sourceWithData();
  expect(await invoke('savedApps.saveFromPath',payload)).toMatchObject({ok:false,code:'app_edit_data_migration'});
  expect(await records()).toEqual({records:[{body:'KEEP'}]});
  const impact=await invoke('savedApps.dataImpactFromPath',payload);expect(impact).toMatchObject({ok:true,appId:app.id,records:1});
  const {dialog}=await import('electron');const exported=path.join(tmpDir,'backup.sqlite');
  vi.mocked(dialog.showSaveDialog).mockResolvedValue({canceled:false,filePath:exported});
  expect(await invoke('savedApps.exportDataFromPath',{...payload,appId:impact.appId})).toEqual({ok:true});expect(fs.statSync(exported).size).toBeGreaterThan(0);
  expect(await invoke('savedApps.saveFromPath',{...payload,mode:'update',recovery:{appId:impact.appId,clearVersion:impact.version,clearFingerprint:impact.fingerprint}})).toMatchObject({ok:true,id:app.id});
  expect(fs.readFileSync(path.join(tmpDir,UID,'cloud/saved_apps',app.id,'index.html'),'utf8')).toContain('Updated');
});

it.each(['cancel','account-switch','retarget'] as const)('does not export or clear after %s during the native dialog',async action=>{
  const {payload,app,records}=await sourceWithData();const {dialog}=await import('electron');
  const destination=path.join(tmpDir,'blocked-export.sqlite');
  vi.mocked(dialog.showSaveDialog).mockImplementation(async()=>{
    if(action==='account-switch')(await import('../../../src/main/features/users')).activateUser('other');
    if(action==='retarget')expect(await invoke('savedApps.saveFromPath',{...payload,mode:'new'})).toMatchObject({ok:true});
    return {canceled:action==='cancel',filePath:destination};
  });
  const result=await invoke('savedApps.exportDataFromPath',{...payload,appId:app.id});
  expect(result).toMatchObject(action==='cancel'?{ok:true,canceled:true}:{ok:false});
  expect(fs.existsSync(destination)).toBe(false);expect(await records()).toEqual({records:[{body:'KEEP'}]});
});

it('refuses private paths before resolving data or opening a native dialog',async()=>{
  const {payload,app}=await sourceWithData();const {dialog}=await import('electron');
  const privateEntry=path.join(tmpDir,UID,'cloud/saved_apps',app.id,'index.html');
  for(const channel of ['savedApps.dataImpactFromPath','savedApps.exportDataFromPath']) {
    expect(await invoke(channel,{...payload,path:privateEntry,appId:app.id})).toMatchObject({ok:false});
  }
  expect(dialog.showSaveDialog).not.toHaveBeenCalled();
});
