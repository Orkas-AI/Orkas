/** Versioned common data contract, independent of host permissions. */
import { z } from 'zod';
export const appTypeSchema = z.enum(['local','web']);
export type AppType = z.infer<typeof appTypeSchema>;
/** Recognize a persisted type without mistaking missing authority for local. */
export function metadataAppType(value: unknown): AppType | undefined {
  return value === 'local' ? 'local' : value === 'web' || value === 'cloud' ? 'web' : undefined;
}
/** Legacy persisted bundles retain their restricted web capabilities on read. */
export function normalizeAppType(value: unknown): AppType {
  return value === 'web' || value === 'cloud' ? 'web' : 'local';
}
const name = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
const filter = z.object({field:name,op:z.enum(['eq','ne','lt','lte','gt','gte']),value:z.union([z.string(),z.number().finite().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),z.boolean(),z.null()])}).strict();
function jsonValue(v:unknown,depth=0):boolean{
  if(depth>32)return false;if(v===null||typeof v==='boolean')return true;if(typeof v==='number')return Number.isFinite(v)&&Math.abs(v)<=Number.MAX_SAFE_INTEGER;if(typeof v==='string')return Buffer.from(v).toString('utf8')===v;
  if(Array.isArray(v))return v.every(x=>jsonValue(x,depth+1));return !!v&&Object.getPrototypeOf(v)===Object.prototype&&Object.entries(v).every(([k,x])=>jsonValue(k,depth+1)&&jsonValue(x,depth+1));
}
function defaultValue(f:any):boolean{
  const v=f.default;if(v===null)return !!f.nullable;
  if(f.type==='timestamp'){if(typeof v!=='string'||v.startsWith('0000-')||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(v))return false;const d=new Date(v);return Number.isFinite(d.valueOf())&&d.toISOString()===(v.length===20?v.replace('Z','.000Z'):v);}
  return ({string:typeof v==='string',number:typeof v==='number',integer:Number.isSafeInteger(v),boolean:typeof v==='boolean',json:!!v&&typeof v==='object'} as any)[f.type]&&jsonValue(v);
}
const field = z.object({id:name,name,type:z.enum(['string','number','integer','boolean','json','timestamp']),required:z.boolean().optional(),nullable:z.boolean().optional(),unique:z.boolean().optional(),default:z.unknown().optional(),references:z.object({table:name}).strict().optional()}).strict();
export const dataDefinitionSchema = z.object({version:z.literal(1),tables:z.array(z.object({id:name,name,fields:z.array(field).max(128),access:z.object({read:z.array(name).default([]),insert:z.array(name).default([]),count:z.boolean().optional(),maxCount:z.number().int().min(1).max(1000000).optional(),aggregate:z.array(name).optional(),readFilters:z.array(filter).max(16).optional()}).strict(),indexes:z.array(z.array(name).min(1).max(4)).max(16).optional()}).strict()).max(32)}).strict().superRefine((value,ctx)=>{
  if(!jsonValue(value)||Buffer.byteLength(JSON.stringify(value))>65536)ctx.addIssue({code:'custom',message:'Invalid or oversized definition'});
  const ids=new Set<string>(),names=new Set<string>();
  for(const t of value.tables){
    if(ids.has(t.id)||names.has(t.name))ctx.addIssue({code:'custom',message:'Duplicate table identity'});
    ids.add(t.id);names.add(t.name);
    const fieldIds=new Set<string>(),fieldNames=new Set(['id','createdAt']);
    for(const f of t.fields){if(Object.hasOwn(f,'default')&&!defaultValue(f))ctx.addIssue({code:'custom',message:'Default does not match field type'});if(fieldIds.has(f.id)||fieldNames.has(f.name)||f.name==='relations')ctx.addIssue({code:'custom',message:'Duplicate field identity'});fieldIds.add(f.id);fieldNames.add(f.name);}
    for(const f of t.fields)if(f.references&&(f.type!=='string'||!value.tables.some(table=>table.id===f.references.table)))ctx.addIssue({code:'custom',message:'Invalid relation'});
    for(const group of [t.access.read,t.access.insert,t.access.aggregate??[],...(t.indexes??[])])if(new Set(group).size!==group.length||group.some(f=>!fieldNames.has(f)))ctx.addIssue({code:'custom',message:'Unknown or duplicate access field'});
    if(t.access.insert.some(f=>f==='id'||f==='createdAt')||(t.access.readFilters??[]).some(f=>!fieldNames.has(f.field)))ctx.addIssue({code:'custom',message:'Invalid access scope'});
  }
});
export type DataDefinition=z.infer<typeof dataDefinitionSchema>;
const query=z.object({table:name,fields:z.array(name).max(130).optional(),include:z.array(name).max(4).optional(),filters:z.array(filter).max(16).optional(),limit:z.number().int().min(1).max(100).optional(),offset:z.number().int().min(0).max(100000).optional(),order:z.object({field:name,direction:z.enum(['asc','desc'])}).strict().optional()}).strict();
const insert=z.object({table:name,values:z.record(z.string(), z.unknown()),requestId:z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional()}).strict();
export const DATA_INPUTS={
  'data.query':query,
  'data.count':z.object({table:name,filters:z.array(filter).max(16).optional()}).strict(),
  'data.insert':insert,
  'data.insertIf':insert.extend({maxCount:z.number().int().min(1).max(1000000)}).strict(),
  'data.aggregate':z.object({table:name,field:name,op:z.enum(['count','sum','min','max','avg']),groupBy:name.optional(),filters:z.array(filter).max(16).optional()}).strict(),
};
export function commonMethod(method:string){return Object.hasOwn(DATA_INPUTS,method)||['capabilities.list','capabilities.describe','host.getContext'].includes(method);}
