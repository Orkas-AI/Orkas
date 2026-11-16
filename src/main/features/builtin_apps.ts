/** Packaged app seeds follow the built-in Agent missing/newer version policy.
 * Code stays machine-local; edits are independent saved apps, never overlays. */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { packagedBuiltinAppsDir, userBuiltinAppsDir, userLocalRoot } from '../paths';
import { safeId } from '../storage';
import { compareVersions, parseSemver } from '../util/app-version-compat';
import { replaceDirectoryAtomically } from '../util/atomic-directory-replace';
import { isPathAllowed } from '../util/path-sandbox';
import { t } from '../i18n';

const META = '__orkas-meta.json';
// Retire packaged identities only; custom forks and private business data survive.
const RETIRED_IDS = new Set(['builtin-pomodoro']);
// Generated custom IDs are 12 characters; this namespace is always longer.
const ID = /^builtin-[a-z0-9][a-z0-9-]{5,47}$/;
const readers = new Map<string, number>();
const queues = new Map<string, Promise<unknown>>();
let inUse: (uid: string, id: string) => boolean = () => false;
export function setBuiltinAppUsageGuard(guard: typeof inUse): void { inUse = guard; }
export const isBuiltinAppId = (id: string): boolean => ID.test(id);
const identity = (uid: string, id: string) => JSON.stringify([uid, id]);
export function holdBuiltinApp(uid: string, id: string): () => void {
  if (!isBuiltinAppId(id)) return () => {};
  const key = identity(uid,id);readers.set(key,(readers.get(key)||0)+1);
  let released=false;
  return () => { if(released)return;released=true;const n=(readers.get(key)||1)-1;if(n)readers.set(key,n);else readers.delete(key); };
}
/** Readers arriving during the rename window wait for the existing installer. */
export async function acquireBuiltinApp(uid: string, id: string): Promise<() => void> {
  if (!isBuiltinAppId(id)) return () => {};
  while (queues.has(uid)) await queues.get(uid)!.catch(() => undefined);
  return holdBuiltinApp(uid, id);
}
function directory(root: string): boolean {
  try {const stat=fs.lstatSync(root);return stat.isDirectory()&&!stat.isSymbolicLink()&&isPathAllowed(root,[path.dirname(root)]);}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw new Error('app_list_failed');}
}
export function builtinAppRoot(uid: string,id: string): string | null {
  if(!safeId(uid)||!isBuiltinAppId(id)||RETIRED_IDS.has(id))return null;
  const root=path.join(userBuiltinAppsDir(uid),id);
  if(!isPathAllowed(root,[userLocalRoot(uid)]))return null;
  return directory(root)?root:null;
}
function metadata(root: string): Record<string, any> {
  const file=path.join(root,META),stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536||!isPathAllowed(file,[root]))throw new Error('app_builtin_invalid');
  const value=JSON.parse(fs.readFileSync(file,'utf8'));
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('app_builtin_invalid');
  return value;
}
export function builtinAppDisplayTitle(meta: { title?: unknown; titleKey?: unknown }, fallback: string): string {
  const title = typeof meta.titleKey === 'string' && meta.titleKey ? t(meta.titleKey) : meta.title;
  return typeof title === 'string' ? title : fallback;
}
export function listBuiltinApps(uid: string) {
  const root=userBuiltinAppsDir(uid);
  if(!safeId(uid)||!isPathAllowed(root,[userLocalRoot(uid)]))throw new Error('app_list_failed');
  let names:string[];
  try{names=fs.readdirSync(root);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw new Error('app_list_failed');}
  return names.filter(isBuiltinAppId).flatMap(id=>{
    const dir=builtinAppRoot(uid,id);if(!dir)return [];
    const meta=metadata(dir);
    const title=builtinAppDisplayTitle(meta,id);
    return [{id,source:'builtin' as const,appType:meta.appType==='web'?'web' as const:'local' as const,
      titleKey:meta.titleKey,descriptionKey:meta.descriptionKey,
      icon:meta.icon,
      title,description:meta.descriptionKey?t(meta.descriptionKey):meta.description,
      version:meta.version,savedAt:'',sourceCid:''}];
  }).sort((a,b)=>a.title.localeCompare(b.title));
}

/** Bound package work, reject links/special files and validate a complete candidate
 * before touching the working version. No user runtime state lives in this tree. */
async function validateTree(root:string,entry:string) {
  if(!entry||entry.includes('\\')||entry.split('/').some(p=>!p||p==='.'||p==='..'||p.startsWith('.'))||!['.html','.htm'].includes(path.extname(entry)))throw new Error('app_builtin_invalid');
  let count=0,bytes=0;
  async function walk(dir:string,depth:number):Promise<void>{
    if(depth>16)throw new Error('app_builtin_invalid');
    for await(const item of await fsp.opendir(dir)){
      if(++count>2048)throw new Error('app_builtin_invalid');
      const file=path.join(dir,item.name),stat=await fsp.lstat(file);
      if(stat.isSymbolicLink()||!isPathAllowed(file,[root]))throw new Error('app_builtin_invalid');
      if(stat.isDirectory())await walk(file,depth+1);
      else if(stat.isFile()){bytes+=stat.size;if(bytes>32*1024*1024)throw new Error('app_builtin_invalid');}
      else throw new Error('app_builtin_invalid');
    }
  }
  await walk(root,0);
  if(!(await fsp.lstat(path.join(root,entry))).isFile())throw new Error('app_builtin_invalid');
}
export async function syncBuiltinApps(uid:string,shouldContinue:()=>boolean=()=>true):Promise<{changed:number;deferred:number}>{
  if(!safeId(uid)||!isPathAllowed(userBuiltinAppsDir(uid),[userLocalRoot(uid)]))throw new Error('app_builtin_invalid');
  const previous=queues.get(uid)||Promise.resolve();
  const work=previous.catch(()=>undefined).then(async()=>{
    const result={changed:0,deferred:0};
    for(const id of RETIRED_IDS){
      if(!shouldContinue())return result;
      const target=path.join(userBuiltinAppsDir(uid),id);
      if(!directory(target))continue;
      if(readers.get(identity(uid,id))||inUse(uid,id)){result.deferred++;continue;}
      await fsp.rm(target,{recursive:true});result.changed++;
    }
    let entries:fs.Dirent[];
    try{entries=await fsp.readdir(packagedBuiltinAppsDir(),{withFileTypes:true});}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return result;throw error;}
    if(entries.length>128)throw new Error('app_builtin_invalid');
    for(const item of entries){
      if(!shouldContinue())break;
      if(!isBuiltinAppId(item.name)||RETIRED_IDS.has(item.name))continue;
      if(!item.isDirectory()||item.isSymbolicLink())throw new Error('app_builtin_invalid');
      const id=item.name,src=path.join(packagedBuiltinAppsDir(),id),target=path.join(userBuiltinAppsDir(uid),id),meta=metadata(src);
      if(!parseSemver(meta.version)||!['local','web'].includes(meta.appType)||typeof meta.title!=='string')throw new Error('app_builtin_invalid');
      let local:Record<string,any>|undefined;
      if(directory(target)){try{local=metadata(target);}catch{/* Missing install metadata is rebuilt, like a missing Agent version. */}}
      // Commerce embeds the maintained Content UI in its own complete bundle.
      // Copies/exports stay self-contained, and neither app reads the other's data.
      let contentRoot:string|undefined,contentMeta:Record<string,any>|undefined;
      if(id==='builtin-product-listing'&&meta.contentWorkspace===true){
        contentRoot=path.join(packagedBuiltinAppsDir(),'builtin-content-workbench');
        if(!directory(contentRoot))throw new Error('app_builtin_invalid');
        contentMeta=metadata(contentRoot);
        if(!parseSemver(contentMeta.version)||contentMeta.entry!=='index.html')throw new Error('app_builtin_invalid');
      }
      const order=local?.version?compareVersions(meta.version,local.version):1;
      const contentUpdate=contentMeta&&(!local?.contentWorkspaceVersion||compareVersions(contentMeta.version,local.contentWorkspaceVersion)===1);
      if(local?.version&&order!==1&&!(order===0&&contentUpdate))continue;
      const busy=()=>!!readers.get(identity(uid,id))||inUse(uid,id);
      if(busy()){result.deferred++;continue;}
      let deferred = false;
      await replaceDirectoryAtomically(target,async staged=>{
        await validateTree(src,meta.entry||'index.html');
        await fsp.cp(src,staged,{recursive:true,dereference:false});
        if(contentRoot&&contentMeta){
          await validateTree(contentRoot,'index.html');
          const creator=path.join(staged,'creator');
          if(fs.existsSync(creator))throw new Error('app_builtin_invalid');
          await fsp.cp(contentRoot,creator,{recursive:true,dereference:false});
          // The nested document uses its owning app's SDK session, not a second
          // postMessage endpoint. This also keeps private task-input dialogs visible.
          const html=(await fsp.readFile(path.join(creator,'index.html'),'utf8')).replace('<script src="/__orkas/sdk.js"></script>',''),marker='<script src="';
          const at=html.indexOf(marker);if(at<0||!(await fsp.lstat(path.join(staged,'creator.js'))).isFile())throw new Error('app_builtin_invalid');
          await fsp.writeFile(path.join(creator,'index.html'),html.slice(0,at)+'<script src="../creator.js"></script>'+html.slice(at));
        }
        await validateTree(staged,meta.entry||'index.html');
        await fsp.writeFile(path.join(staged,META),JSON.stringify({...meta,...contentMeta?{contentWorkspaceVersion:contentMeta.version}:{},browserStorage:'isolated-v1'}));
      },async()=>{}, {assertReady:()=>{
        if(!isPathAllowed(target,[userLocalRoot(uid)]))throw new Error('app_builtin_invalid');
        if(!shouldContinue()||busy())throw new Error('app_builtin_busy');
      }}).catch(error=>{
        if((error as Error).message==='app_builtin_busy'){result.deferred++;deferred=true;return;}
        throw error;
      });
      if(!deferred)result.changed++;
    }
    return result;
  });
  queues.set(uid,work);
  try{return await work;}finally{if(queues.get(uid)===work)queues.delete(uid);}
}

// These identities select product manifests and connector navigation.
export const BUILTIN_APP_NAMES = {
  'builtin-content-workbench': 'content_workbench',
  'builtin-product-listing': 'product_listing',
} as const;
export type BuiltinAppName = typeof BUILTIN_APP_NAMES[keyof typeof BUILTIN_APP_NAMES];
