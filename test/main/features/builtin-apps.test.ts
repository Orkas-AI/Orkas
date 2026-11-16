import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';

vi.mock('node:fs/promises',async original=>{
  const actual=await original<typeof import('node:fs/promises')>();
  return {...actual,rename:vi.fn(actual.rename)};
});

let root: string;
let oldWorkspace: string | undefined, oldBuiltin: string | undefined;
const uid = 'builtin-app-user', id = 'builtin-test-seed';
const packaged = () => path.join(root, 'builtin', 'apps', id);
const installed = () => path.join(root, uid, 'local', 'builtin_apps', id);
function fixture(version = '1.0.0', html = '<h1>Timer one</h1>') {
  fs.mkdirSync(packaged(), {recursive:true});
  fs.writeFileSync(path.join(packaged(), '__orkas-meta.json'), JSON.stringify({version,title:'Pomodoro',appType:'local',entry:'index.html'}));
  fs.writeFileSync(path.join(packaged(), 'index.html'), html);
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(),'builtin-apps-'));
  oldWorkspace=process.env.ORKAS_WORKSPACE_ROOT;oldBuiltin=process.env.ORKAS_BUILTIN_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT=root;process.env.ORKAS_BUILTIN_ROOT=path.join(root,'builtin');
  vi.resetModules();fixture();
});
afterEach(() => {
  if(oldWorkspace===undefined)delete process.env.ORKAS_WORKSPACE_ROOT;else process.env.ORKAS_WORKSPACE_ROOT=oldWorkspace;
  if(oldBuiltin===undefined)delete process.env.ORKAS_BUILTIN_ROOT;else process.env.ORKAS_BUILTIN_ROOT=oldBuiltin;
  fs.rmSync(root,{recursive:true,force:true});vi.restoreAllMocks();
});
describe('built-in app installation', () => {
  it('ships a self-contained Commerce creator and refreshes it when the shared Content package advances',async()=>{
    const source=path.join(root,'builtin/apps'),commerce=path.join(source,'builtin-product-listing'),content=path.join(source,'builtin-content-workbench');
    for(const dir of [commerce,content])fs.mkdirSync(dir,{recursive:true});
    const seed=(version:string)=>{fs.writeFileSync(path.join(content,'__orkas-meta.json'),JSON.stringify({version,title:'Content',appType:'local',entry:'index.html'}));fs.writeFileSync(path.join(content,'index.html'),'<script src="app.js"></script>');fs.writeFileSync(path.join(content,'app.js'),'shared '+version);};
    seed('1.0.0');fs.writeFileSync(path.join(commerce,'__orkas-meta.json'),JSON.stringify({version:'2.0.0',title:'Commerce',appType:'local',entry:'index.html',contentWorkspace:true}));fs.writeFileSync(path.join(commerce,'index.html'),'<iframe src="creator/index.html"></iframe>');fs.writeFileSync(path.join(commerce,'creator.js'),'integration');
    const apps=await import('../../../src/main/features/builtin_apps');await apps.syncBuiltinApps(uid);
    const target=path.join(root,uid,'local/builtin_apps/builtin-product-listing'),file=path.join(target,'creator/app.js');
    expect(fs.readFileSync(file,'utf8')).toBe('shared 1.0.0');expect(fs.readFileSync(path.join(target,'creator/index.html'),'utf8')).toContain('<script src="../creator.js"></script>');
    seed('1.1.0');const release=apps.holdBuiltinApp(uid,'builtin-product-listing');await apps.syncBuiltinApps(uid);expect(fs.readFileSync(file,'utf8')).toBe('shared 1.0.0');release();await apps.syncBuiltinApps(uid);expect(fs.readFileSync(file,'utf8')).toBe('shared 1.1.0');
    // An invalid dependency never replaces the last working complete bundle.
    seed('1.2.0');fs.symlinkSync(path.join(root,'private'),path.join(content,'unsafe'));
    await expect(apps.syncBuiltinApps(uid)).rejects.toThrow();expect(fs.readFileSync(file,'utf8')).toBe('shared 1.1.0');fs.unlinkSync(path.join(content,'unsafe'));
    // A newer local Commerce package must never be downgraded by dependency repair.
    fs.writeFileSync(path.join(target,'__orkas-meta.json'),JSON.stringify({version:'9.0.0',title:'Newer',appType:'local'}));await apps.syncBuiltinApps(uid);expect(fs.readFileSync(file,'utf8')).toBe('shared 1.1.0');
    await apps.syncBuiltinApps('second-account');expect(fs.readFileSync(path.join(root,'second-account/local/builtin_apps/builtin-product-listing/creator/app.js'),'utf8')).toBe('shared 1.2.0');
  });
  it('keeps every shipped app in the public manifest identity registry with complete product locales and metadata',async()=>{
    const {BUILTIN_APP_NAMES}=await import('../../../src/main/features/builtin_apps');
    const {SUPPORTED_LANGS}=await import('../../../src/main/i18n');
    const folder=path.resolve('resources/builtin/apps'),ids=fs.readdirSync(folder).filter(id=>fs.statSync(path.join(folder,id)).isDirectory());
    expect(Object.keys(BUILTIN_APP_NAMES).sort()).toEqual(ids.sort());
    for(const id of ids){
      const base=path.join(folder,id),window:any={};vm.runInNewContext(fs.readFileSync(path.join(base,'locales.js'),'utf8'),{window});
      const dictionaries=window.ContentLocales || Object.fromEntries(Object.entries(window.ListingLocaleRows).map(([locale,row])=>[locale,Object.fromEntries(window.ListingLocaleKeys.map((key:string,i:number)=>[key,(row as string).split('|')[i]]))]));
      expect(Object.keys(dictionaries).sort(),id).toEqual([...SUPPORTED_LANGS].sort());
      const meta=JSON.parse(fs.readFileSync(path.join(base,'__orkas-meta.json'),'utf8'));
      const used=[...fs.readFileSync(path.join(base,'index.html'),'utf8').matchAll(/data-t="([^"]+)"/g)].map(match=>match[1]);
      for(const match of fs.readFileSync(path.join(base,'app.js'),'utf8').matchAll(/\b(?:t|notice)\('([^']+)'(?:\s*\)|\s*,)/g))used.push(match[1]);
      for(const locale of SUPPORTED_LANGS){
        const table=JSON.parse(fs.readFileSync(path.resolve('src/main/locales',locale+'.json'),'utf8'));
        for(const key of [meta.titleKey,meta.descriptionKey])expect(table[key],id+' '+locale+' '+key).toBeTruthy();
        for(const key of used)expect(dictionaries[locale][key],id+' '+locale+' '+key).toBeTruthy();
      }
    }
    const {catalogDocument}=await import('../../../src/main/features/web_apps/catalog');
    expect(catalogDocument().methods.map(row=>row?.name)).not.toContain('__builtin.reportFailure');
  });
  it('retires the platform timer without deleting its private state or a custom fork', async () => {
    const timer=path.join(root,uid,'local/builtin_apps/builtin-pomodoro');
    const state=path.join(root,uid,'cloud/web_apps/timer/state.json');
    const copy=path.join(root,uid,'cloud/saved_apps/custom-copy/index.html');
    for(const file of [path.join(timer,'index.html'),state,copy]){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'preserved');}
    fs.writeFileSync(path.join(timer,'__orkas-meta.json'),JSON.stringify({title:'Pomodoro',version:'1.0.0',appType:'local'}));
    const apps=await import('../../../src/main/features/builtin_apps');
    const release=apps.holdBuiltinApp(uid,'builtin-pomodoro');
    await apps.syncBuiltinApps(uid);
    expect(apps.listBuiltinApps(uid).map(app=>app.id)).not.toContain('builtin-pomodoro');
    expect(apps.builtinAppRoot(uid,'builtin-pomodoro')).toBeNull();
    expect(fs.existsSync(timer)).toBe(true);
    release();await apps.syncBuiltinApps(uid);
    expect(fs.existsSync(timer)).toBe(false);
    expect(fs.readFileSync(state,'utf8')).toBe('preserved');
    expect(fs.readFileSync(copy,'utf8')).toBe('preserved');
  });
  it('installs offline per account without creating syncable copies, and follows Agent version precedence', async () => {
    const apps=await import('../../../src/main/features/builtin_apps');
    await apps.syncBuiltinApps(uid);
    expect(fs.readFileSync(path.join(installed(),'index.html'),'utf8')).toContain('Timer one');
    expect(fs.existsSync(path.join(root,uid,'cloud','saved_apps'))).toBe(false);
    fs.writeFileSync(path.join(installed(),'index.html'),'<h1>Local change</h1>');
    await apps.syncBuiltinApps(uid);
    expect(fs.readFileSync(path.join(installed(),'index.html'),'utf8')).toContain('Local change');
    fixture('0.9.0','Older');await apps.syncBuiltinApps(uid);
    expect(fs.readFileSync(path.join(installed(),'index.html'),'utf8')).toContain('Local change');
    fixture('1.1.0','<h1>Timer two</h1>');await apps.syncBuiltinApps(uid);
    expect(fs.readFileSync(path.join(installed(),'index.html'),'utf8')).toContain('Timer two');
    await apps.syncBuiltinApps('second-account');
    expect(fs.readFileSync(path.join(root,'second-account','local','builtin_apps',id,'index.html'),'utf8')).toContain('Timer two');
  });
  it('defers replacement while a reader is open and retains the old app after an invalid upgrade',async()=>{
    const apps=await import('../../../src/main/features/builtin_apps');
    await apps.syncBuiltinApps(uid);
    const release=apps.holdBuiltinApp(uid,id);
    fixture('1.1.0','<h1>Updated</h1>');await apps.syncBuiltinApps(uid);
    expect(fs.readFileSync(path.join(installed(),'index.html'),'utf8')).toContain('Timer one');
    release();
    fs.unlinkSync(path.join(packaged(),'index.html'));
    await expect(apps.syncBuiltinApps(uid)).rejects.toThrow();
    expect(fs.readFileSync(path.join(installed(),'index.html'),'utf8')).toContain('Timer one');
    fixture('1.1.0','<h1>Recovered</h1>');await apps.syncBuiltinApps(uid);
    expect(fs.readFileSync(path.join(installed(),'index.html'),'utf8')).toContain('Recovered');
    expect(apps.builtinAppRoot(uid,'builtin-../../escape')).toBeNull();
  });
  it('rejects source symlinks and never follows an installed-directory escape',async()=>{
    const apps=await import('../../../src/main/features/builtin_apps');
    const outside=path.join(root,'private.txt');fs.writeFileSync(outside,'private');
    fs.symlinkSync(outside,path.join(packaged(),'leak.txt'));
    await expect(apps.syncBuiltinApps(uid)).rejects.toThrow();
    expect(fs.existsSync(installed())).toBe(false);
    fs.unlinkSync(path.join(packaged(),'leak.txt'));await apps.syncBuiltinApps(uid);
    fs.rmSync(installed(),{recursive:true});fs.symlinkSync(packaged(),installed(),'dir');
    expect(apps.builtinAppRoot(uid,id)).toBeNull();
    expect(fs.readFileSync(outside,'utf8')).toBe('private');
  });
  it('refuses an escaped installation parent without writing outside the local domain',async()=>{
    const apps=await import('../../../src/main/features/builtin_apps');
    const local=path.join(root,uid,'local'),outside=path.join(root,'outside');
    fs.mkdirSync(local,{recursive:true});fs.mkdirSync(outside);
    fs.symlinkSync(outside,path.join(local,'builtin_apps'),'dir');
    await expect(apps.syncBuiltinApps(uid)).rejects.toThrow();
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(apps.builtinAppRoot(uid,id)).toBeNull();
  });
  it('restores missing version metadata like built-in Agents and honors runtime use',async()=>{
    const apps=await import('../../../src/main/features/builtin_apps');
    await apps.syncBuiltinApps(uid);
    const meta=path.join(installed(),'__orkas-meta.json');
    fs.writeFileSync(meta,JSON.stringify({title:'Legacy timer',appType:'local'}));
    await apps.syncBuiltinApps(uid);
    expect(JSON.parse(fs.readFileSync(meta,'utf8')).version).toBe('1.0.0');
    apps.setBuiltinAppUsageGuard(()=>true);fixture('2.0.0','Updated');
    expect(await apps.syncBuiltinApps(uid)).toMatchObject({changed:0,deferred:1});
    apps.setBuiltinAppUsageGuard(()=>false);await apps.syncBuiltinApps(uid);
    expect(fs.readFileSync(path.join(installed(),'index.html'),'utf8')).toBe('Updated');
  });
  it('rolls back a refused activation and lets a reader wait until the rename window closes',async()=>{
    const apps=await import('../../../src/main/features/builtin_apps');
    const fsp=await import('node:fs/promises');
    const actual=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    await apps.syncBuiltinApps(uid);fixture('2.0.0','Updated');
    let refused=false;
    vi.mocked(fsp.rename).mockImplementation(async(from,to)=>{
      if(!refused&&String(to)===installed()){refused=true;throw Object.assign(new Error('activation refused'),{code:'EACCES'});}
      return actual.rename(from,to);
    });
    await expect(apps.syncBuiltinApps(uid)).rejects.toThrow('activation refused');
    expect(fs.readFileSync(path.join(installed(),'index.html'),'utf8')).toContain('Timer one');
    let entered!:()=>void,finish!:()=>void;
    const moving=new Promise<void>(resolve=>{entered=resolve;}),pending=new Promise<void>(resolve=>{finish=resolve;});
    vi.mocked(fsp.rename).mockImplementation(async(from,to)=>{
      if(String(from)===installed()){entered();await pending;}
      return actual.rename(from,to);
    });
    const installing=apps.syncBuiltinApps(uid);await moving;
    let read=false;const reading=apps.acquireBuiltinApp(uid,id).then(release=>{read=true;release();});
    await Promise.resolve();expect(read).toBe(false);
    finish();await installing;await reading;
    expect(fs.readFileSync(path.join(installed(),'index.html'),'utf8')).toBe('Updated');
  });
});
