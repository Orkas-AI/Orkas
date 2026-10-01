import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const require=createRequire(import.meta.url);
const adapter=require('../../../../bin/direct-commerce-mcp-server.cjs');
const native=require('../../../../bin/square-business-api.cjs');
const codec=require('../../../../bin/local-api-credential-codec.cjs');
const {withRequestSignal}=require('../../../../bin/commerce-request-context.cjs');
const {AjvJsonSchemaValidator}=require('@modelcontextprotocol/sdk/validation/ajv');
const evidence=JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../fixtures/connectors/official-contracts/square-20261001.json'),'utf8'));
const directories:string[]=[],TOKEN='fixture-square-access-token';
function envFor(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orkas-square-native-'));directories.push(dir);
 const file=path.join(dir,'credentials.enc'),key=crypto.randomBytes(32).toString('base64url');
 codec.writeCredentialFile(file,key,{provider:'square',access_token:TOKEN});
 return {ORKAS_LOCAL_API_PROVIDER:'square',ORKAS_LOCAL_API_CREDENTIAL_FILE:file,ORKAS_LOCAL_API_CREDENTIAL_KEY:key,ORKAS_LOCAL_API_METADATA_JSON:JSON.stringify({environment:'live'})};
}
function serve(body:any,status=200){const mock=vi.fn(async()=>new Response(status===204?null:JSON.stringify(body),{status}));vi.stubGlobal('fetch',mock);return mock;}
const call=(env:any,action:string,parameters:any,lane='execute_read')=>adapter.callTool(lane,{action,parameters},env);
function compare(raw:any,actual:any,root:any,where:string,seen=new Set<string>()){
 expect(actual,where).toBeTruthy();
 if(raw.nullable){expect(actual.anyOf?.some((s:any)=>s.type==='null'),where).toBe(true);actual=actual.anyOf.find((s:any)=>s.type!=='null');}
 if(raw.$ref){const id=raw.$ref.slice('#/components/schemas/'.length);if(seen.has(id))return;compare(evidence.model.components.schemas[id],actual,root,where,new Set([...seen,id]));return;}
 if(actual.$ref)actual=root.$defs[actual.$ref.slice('#/$defs/'.length)];
 if(raw.type)expect(actual.type,where).toBe(raw.type);
 if(raw.enum)expect(actual.enum,where).toEqual(raw.enum);
 for(const key of raw.required || [])if(!raw.properties?.[key]?.readOnly)expect(actual.required,where).toContain(key);
 for(const [key,child]of Object.entries(raw.properties || {})){
  if((child as any).readOnly){expect(actual.properties,where).not.toHaveProperty(key);continue;}
  compare(child,actual.properties[key],root,where+'.'+key,seen);
 }
 if(raw.items)compare(raw.items,actual.items,root,where+'.*',seen);
 if(typeof raw.additionalProperties==='object')compare(raw.additionalProperties,actual.additionalProperties,root,where+'.<key>',seen);
}
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();for(const dir of directories.splice(0))fs.rmSync(dir,{recursive:true,force:true});});
describe('Square current merchant API coverage',()=>{
 it('discovers the full selected writable field trees, shares reachable definitions and excludes unpublished/app-owned contracts',()=>{
  const config={provider:'square',metadata:{environment:'live'}},actions=adapter.actionsFor(config),selected=evidence.inventory.filter((row:any)=>!row.excluded_reason),validator=new AjvJsonSchemaValidator();
  expect(evidence.inventory).toHaveLength(332);expect(selected).toHaveLength(283);expect(Object.keys(actions)).toHaveLength(388);
  for(const row of selected){const name=row.method+' '+row.path,spec=actions[name],raw=evidence.model.paths[row.path][row.method.toLowerCase()];expect(spec.risk,name).toBe(row.risk);
   for(const p of raw.parameters || [])compare(p.schema,spec.input_schema.properties[p.in].properties[p.name],spec.input_schema,p.in+'.'+p.name);
   if(raw.requestBody){const media=raw.requestBody.content['application/json'] || raw.requestBody.content['multipart/form-data'];compare(media.schema,spec.input_schema.properties.body,spec.input_schema,'body');}
   expect(()=>validator.getValidator(spec.input_schema),name).not.toThrow();
  }
  for(const row of evidence.inventory.filter((row:any)=>row.excluded_reason))expect(actions).not.toHaveProperty(row.method+' '+row.path);
  const disabled=vi.spyOn(native,'actionsFor').mockReturnValue({});
  expect(adapter.actionsFor(config)).not.toHaveProperty('GET /v2/bank-accounts');disabled.mockRestore();
 });
 it('continues customer pages and preserves contacts, nulls and error-looking merchant notes without loading unrelated schemas',async()=>{
  const env=envFor(),mock=serve({customers:[{id:'C-1',given_name:'Merchant customer',email_address:null,address:{address_line_1:'Fixture address'},custom:{errors:['Business attribute'],detail:'Merchant detail'}}],cursor:'PAGE-3'});
  const result=await call(env,'GET /v2/customers',{query:{limit:100,cursor:'PAGE-2'}});
  expect(result.result).not.toHaveProperty('status');expect(result.result.data.customers[0]).toMatchObject({email_address:null,custom:{detail:'Merchant detail'}});
  const url=new URL(mock.mock.calls[0][0]);expect(url.origin+url.pathname).toBe('https://connect.squareup.com/v2/customers');expect(url.searchParams.get('limit')).toBe('100');expect(url.searchParams.get('cursor')).toBe('PAGE-2');expect(mock.mock.calls[0][1].headers['square-version']).toBe('2026-09-16');
  mock.mockResolvedValueOnce(new Response('{}'));
  expect(await call(env,'GET /v2/customers',{})).toMatchObject({result:{data:{}}});
  expect(mock).toHaveBeenCalledTimes(2);
 });
 it('clears nullable writable customer fields and reconciles partial bulk responses without dropping successful identifiers or replaying',async()=>{
  const env=envFor(),p={body:{customers:{'REQ-1':{given_name:null,family_name:'One',email_address:'fixture@example.invalid'},'REQ-2':{family_name:'Two'}}}},mock=serve({responses:{'REQ-1':{customer:{id:'C-1',given_name:null}},'REQ-2':{errors:[{category:'INVALID_REQUEST_ERROR',code:'INVALID_VALUE',detail:TOKEN}]}},errors:[]});
  const result=await adapter.callToolResult('execute_write',{action:'POST /v2/customers/bulk-create',parameters:p},env);
  expect(result.isError).toBe(true);const data=JSON.parse(result.content[0].text).result;
  expect(data.status).toBe('partial_or_failed');expect(data.data.responses['REQ-1'].customer.id).toBe('C-1');expect(data.data.responses['REQ-2'].errors[0]).toEqual({category:'INVALID_REQUEST_ERROR',code:'INVALID_VALUE'});
  expect(JSON.parse(mock.mock.calls[0][1].body)).toEqual(p.body);expect(mock).toHaveBeenCalledTimes(1);
  mock.mockResolvedValueOnce(new Response(JSON.stringify({responses:{'REQ-1':{customer:{id:'C-1'}}}})));
  await expect(call(env,'POST /v2/customers/bulk-create',p,'execute_write')).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});expect(mock).toHaveBeenCalledTimes(2);
  mock.mockResolvedValueOnce(new Response(JSON.stringify({responses:{'REQ-1':{customer:{id:'C-1'}},'REQ-2':{}}})));
  await expect(call(env,'POST /v2/customers/bulk-create',p,'execute_write')).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});expect(mock).toHaveBeenCalledTimes(3);
 });
 it('uses read-only POST for scheduled-shift searches and keeps published Beta operations available',async()=>{
  const env=envFor(),p={body:{limit:50,cursor:'PAGE-2',query:{filter:{assignment_status:'ASSIGNED',scheduled_shift_statuses:['PUBLISHED','DRAFT']},sort:{field:'CREATED_AT',order:'ASC'}}}},mock=serve({scheduled_shifts:[],cursor:'PAGE-3'});
  expect(await call(env,'POST /v2/labor/scheduled-shifts/search',p)).toMatchObject({risk:'R',result:{data:{cursor:'PAGE-3'}}});
  expect(mock.mock.calls[0][1].method).toBe('POST');expect(JSON.parse(mock.mock.calls[0][1].body)).toEqual(p.body);
  await expect(call(env,'POST /v2/labor/scheduled-shifts/search',{body:{limit:51}})).rejects.toMatchObject({code:'E_BAD_INPUT'});expect(mock).toHaveBeenCalledTimes(1);
 });
 it('requires a published business acknowledgement before reporting vendor submission and preserves the caller idempotency key',async()=>{
  const env=envFor(),p={body:{idempotency_key:'VENDOR-REQUEST-1',vendor:{name:'Fixture vendor'}}},mock=serve({vendor:{id:'V-1',name:'Fixture vendor',status:'ACTIVE'}});
  expect(await call(env,'POST /v2/vendors/create',p,'execute_write')).toMatchObject({result:{status:'acknowledged',data:{vendor:{id:'V-1'}}}});expect(JSON.parse(mock.mock.calls[0][1].body)).toEqual(p.body);
  mock.mockResolvedValueOnce(new Response('{}'));
  await expect(call(env,'POST /v2/vendors/create',p,'execute_write')).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});expect(mock).toHaveBeenCalledTimes(2);
 });
 it('detects omitted shift publications and bounds map batches in the described contract before IO',async()=>{
  const env=envFor(),action='POST /v2/labor/scheduled-shifts/bulk-publish',p={body:{scheduled_shifts:{'SHIFT-1':{version:3},'SHIFT-2':{version:2}},scheduled_shift_notification_audience:'AFFECTED'}};
  const schema=adapter.actionsFor({provider:'square',metadata:{}})[action].input_schema;
  expect(schema.$defs.BulkPublishScheduledShiftsRequest.properties.scheduled_shifts.maxProperties).toBe(10);
  const mock=serve({responses:{'SHIFT-1':{scheduled_shift:{id:'SHIFT-1'}},'SHIFT-2':{errors:[{category:'INVALID_REQUEST_ERROR',code:'NOT_FOUND',detail:'Fixture missing shift'}]}}});
  const result=await adapter.callToolResult('execute_high_impact',{action,parameters:p},env);
  expect(result.isError).toBe(true);expect(JSON.parse(result.content[0].text).result).toMatchObject({status:'partial_or_failed',data:{responses:{'SHIFT-1':{scheduled_shift:{id:'SHIFT-1'}}}}});
  mock.mockResolvedValueOnce(new Response(JSON.stringify({responses:{'SHIFT-1':{scheduled_shift:{id:'SHIFT-1'}}}})));
  await expect(call(env,action,p,'execute_high_impact')).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});
  await expect(call(env,action,{body:{scheduled_shifts:Object.fromEntries(Array.from({length:11},(_,i)=>['SHIFT-'+i,{}]))}},'execute_high_impact')).rejects.toMatchObject({code:'E_BAD_INPUT'});
  expect(mock).toHaveBeenCalledTimes(2);
 });
 it('uploads bounded inline JPEG with the official multipart parts and no caller file path or destination',async()=>{
  const env=envFor(),p={body:{request:{idempotency_key:'IMAGE-1',image:{id:'#TEMP',type:'IMAGE',image_data:{caption:'Fixture image'}},is_primary:false},image_file:Buffer.from([255,216,255,217]).toString('base64')}},mock=serve({image:{id:'IMG-1',type:'IMAGE'}});
  expect(await call(env,'POST /v2/catalog/images',p,'execute_write')).toMatchObject({result:{status:'acknowledged'}});
  const form=mock.mock.calls[0][1].body as FormData;
  expect(JSON.parse(await (form.get('request') as Blob).text())).toEqual(p.body.request);expect([...new Uint8Array(await (form.get('image_file') as Blob).arrayBuffer())]).toEqual([255,216,255,217]);
  expect(mock.mock.calls[0][1].headers).not.toHaveProperty('content-type');expect(mock.mock.calls[0][1].signal.aborted).toBe(false);
  await expect(call(env,'POST /v2/catalog/images',{body:{...p.body,image_file:'/tmp/merchant-photo.jpg'}},'execute_write')).rejects.toMatchObject({code:'E_BAD_INPUT'});expect(mock).toHaveBeenCalledTimes(1);
 });
 it('denies transport overrides, read-only writes, oversized map batches and duplicate resources before merchant IO',async()=>{
  const env=envFor(),mock=serve({});
  for(const p of [{query:{limit:1},headers:{authorization:'injected'}},{query:{limit:0}},{query:{cursor:'x'.repeat(262145)}}])await expect(call(env,'GET /v2/customers',p)).rejects.toMatchObject({code:'E_BAD_INPUT'});
  await expect(call(env,'POST /v2/customers',{body:{given_name:'Fixture',id:'READ-ONLY-ID'}},'execute_write')).rejects.toMatchObject({code:'E_BAD_INPUT'});
  await expect(call(env,'POST /v2/customers/bulk-create',{body:{customers:Object.fromEntries(Array.from({length:26},(_,i)=>['REQ-'+i,{family_name:'Fixture'}]))}},'execute_write')).rejects.toMatchObject({code:'E_BAD_INPUT'});
  await expect(call(env,'POST /v2/customers/bulk-retrieve',{body:{customer_ids:['C-1','C-1']}})).rejects.toMatchObject({code:'E_BAD_INPUT'});
  await expect(call(env,'POST /v2/labor/timecards',{body:{timecard:{}}})).rejects.toThrow(/risk mismatch/);expect(mock).not.toHaveBeenCalled();
 });
 it('classifies HTTP failure, cancellation and body timeout with one request each and no automatic retry',async()=>{
  const env=envFor(),mock=serve({errors:[{category:'AUTHENTICATION_ERROR',code:'FORBIDDEN',detail:TOKEN}]},403);
  await expect(call(env,'GET /v2/bank-accounts',{})).rejects.toMatchObject({code:'E_TOOL_CALL_AUTH'});
  const signal=new AbortController();mock.mockImplementation(async()=>({ok:true,status:200,text:async()=>{signal.abort();throw new DOMException('Interrupted','AbortError');}}));
  await expect(withRequestSignal(signal.signal,()=>call(env,'GET /v2/bank-accounts',{}))).rejects.toMatchObject({code:'E_TOOL_CALL_CANCELLED'});
  mock.mockImplementation(async()=>({ok:true,status:200,text:async()=>{throw new DOMException('Timed out','TimeoutError');}}));
  await expect(call(env,'GET /v2/bank-accounts',{})).rejects.toMatchObject({code:'E_TOOL_CALL_TIMEOUT'});expect(mock).toHaveBeenCalledTimes(3);
 });
});
