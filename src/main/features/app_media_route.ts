/** Host-owned app run preferences, outside the Agent's writable workspace.
 * Old runs without this optional record retain their original defaults. */
import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import * as path from 'node:path';
import {appConversationOwner,appLocalConversationRoot,userLocalRoot} from '../paths';
import {writeJson,safeId} from '../storage';
import {getActiveUserId} from './users';
export class AppMediaRouteError extends Error {constructor(readonly code:string){super(code);}}
import type {MediaKind,MediaSelection} from './web_apps/media-services';

function check(uid:string){if(uid!==getActiveUserId())throw new AppMediaRouteError('E_CLOSED');}
async function fileFor(uid:string,cid:string){
 check(uid);if(!safeId(uid)||!appConversationOwner(cid))throw new AppMediaRouteError('E_INPUT');
 const root=appLocalConversationRoot(uid,cid)!,file=path.join(root,'media-route.json');
 for(let current=file;;current=path.dirname(current)){
  try{const stat=await fs.lstat(current);if(stat.isSymbolicLink()||stat.isFile()&&stat.nlink!==1)throw new AppMediaRouteError('E_FILE');}catch(error){if(error.code!=='ENOENT')throw error;}
  if(current===userLocalRoot(uid))break;
 }
 return file;
}
export async function saveAppMediaRoute(uid:string,cid:string,media?:MediaSelection){
 const file=await fileFor(uid,cid);check(uid);
 await writeJson(file,{version:1,media:media??null});
}
export async function appTaskMediaRoute(uid:string,cid:string|undefined,kind:MediaKind,signal?:AbortSignal):Promise<string|undefined>{
 if(!cid||!appConversationOwner(cid))return undefined;check(uid);
 const file=await fileFor(uid,cid);let record:any;
 try{
  const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
   const stat=await handle.stat();if(!stat.isFile()||stat.nlink!==1||stat.size>2048)throw new AppMediaRouteError('E_FILE');
   const data=Buffer.alloc(2049),{bytesRead}=await handle.read(data,0,data.length,0);
   const after=await handle.stat();if(bytesRead>2048||bytesRead!==stat.size||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs)throw new AppMediaRouteError('E_FILE');
   await fileFor(uid,cid);record=JSON.parse(data.subarray(0,bytesRead).toString('utf8'));
  }finally{await handle.close();}
 }catch(error){if(error.code==='ENOENT')return undefined;throw new AppMediaRouteError('E_FILE');}
 if(record?.version!==1||record.media!==null&&(!record.media||!['image','video','audio'].includes(record.media.kind)||!/^[a-f0-9]{32}$/.test(record.media.serviceId)))throw new AppMediaRouteError('E_FILE');
 check(uid);if(!record.media||record.media.kind!==kind)return undefined;
 const choice=await(await import('./web_apps/media-services')).resolveAppMediaService(uid,record.media,signal);check(uid);return choice.routeRef;
}
