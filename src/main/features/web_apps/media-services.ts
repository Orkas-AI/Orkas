/** Safe service identities for app-owned media tasks. Credentials stay native. */
import {createHash} from 'node:crypto';
import {listOpenImageGenCandidates} from '../image_gen';
import {listVideoGenCandidates} from '../video_gen';
import {listUsableTtsProfiles} from '../tts_auth';
import {loadImageProfiles} from '../auth';
import {listImageModelOptions} from '../image_auth';
import {listVideoModelOptions} from '../video_auth';
import {TTS_MODELS} from '../tts_catalog';
import {getActiveUserId} from '../users';
import {AppError} from './runtime';

export type MediaKind='image'|'video'|'audio';
export interface MediaSelection {kind:MediaKind;serviceId:string}
interface NativeService {id:string;kind:MediaKind;profileId:string;routeRef:string;provider:string;model:string;name:string;nameZh?:string;label:string;managed:boolean;available:boolean}
const identity=(kind:MediaKind,profileId:string,model:string)=>createHash('sha256').update(JSON.stringify([kind,profileId,model])).digest('hex').slice(0,32);
function service(kind:MediaKind,profileId:string,provider:string,model:string,name:string,label='',nameZh?:string,available=true):NativeService{
 const managed=false;
 return{id:identity(kind,profileId,model),kind,profileId,routeRef:profileId,provider,model,name,nameZh,label:label==='default'?'':label.slice(0,80),managed,available};
}
function bounded<T>(items:T[]):T[]{if(items.length>100)throw new AppError('E_LIMIT');return items;}
async function nativeServices(kind:MediaKind,signal?:AbortSignal,refresh=false):Promise<{services:NativeService[];managedStatus:'complete'|'unavailable'}>{
 if(!['image','video','audio'].includes(kind))throw new AppError('E_INPUT');
 let managedStatus:'complete'|'unavailable'='complete';const services:NativeService[]=[];
 if(kind==='image'){
  const labels=new Map(loadImageProfiles().map(p=>[p.id,p.label]));
  for(const {entry,capability}of bounded(listOpenImageGenCandidates())){
   const model=capability.model,name=listImageModelOptions(entry.provider).find(m=>m.id===model)?.name||model;
   services.push(service(kind,entry.entryId,entry.provider,model,name,labels.get(entry.entryId)||''));
  }
 }else if(kind==='audio'){
  for(const p of bounded(listUsableTtsProfiles()))services.push(service(kind,p.id,p.provider,p.model,TTS_MODELS[p.provider]?.find(m=>m.id===p.model)?.name||p.model,p.label));
 }else{
  for(const {entry:p} of bounded(listVideoGenCandidates()))services.push(service(kind,p.id,p.provider,p.model,listVideoModelOptions(p.provider).find(m=>m.id===p.model)?.name||p.model,p.label));
 }
 const unique=[...new Map(services.map(s=>[s.id,s])).values()];if(unique.length>200)throw new AppError('E_LIMIT');
 return{services:unique,managedStatus};
}
export async function listAppMediaServices(kind:MediaKind,signal?:AbortSignal,refresh=false){
 const uid=getActiveUserId(),result=await nativeServices(kind,signal,refresh);
 if(uid!==getActiveUserId())throw new AppError('E_CLOSED');
 return{...result,services:result.services.map(({id,provider,model,name,nameZh,label,managed,available})=>({id,provider,model,name,...nameZh?{nameZh}:{},label,managed,available}))};
}
export async function resolveAppMediaService(uid:string,selection:MediaSelection,signal?:AbortSignal):Promise<NativeService>{
 if(uid!==getActiveUserId())throw new AppError('E_CLOSED');
 if(!selection||!/^[a-f0-9]{32}$/.test(selection.serviceId))throw new AppError('E_INPUT');
 const chosen=(await nativeServices(selection.kind,signal)).services.find(v=>v.id===selection.serviceId&&v.available);
 if(uid!==getActiveUserId())throw new AppError('E_CLOSED');
 if(!chosen)throw new AppError('E_UNAVAILABLE');
 return chosen;
}
