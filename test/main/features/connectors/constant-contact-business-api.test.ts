import {afterEach,describe,expect,it,vi} from 'vitest';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const require=createRequire(import.meta.url),api=require('../../../../bin/constant-contact-business-api.cjs'),contracts=require('../../../../bin/constant-contact-api-contracts.cjs');
const {AjvJsonSchemaValidator}=require('@modelcontextprotocol/sdk/validation/ajv'),{withRequestSignal}=require('../../../../bin/commerce-request-context.cjs');
const evidence=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../../../fixtures/connectors/official-contracts/constant-contact-20261001.json'),'utf8'));
const TOKEN='fixture-constant-contact-token',config=()=>({provider:'constant_contact',metadata:{},credentials:{access_token:TOKEN,scope:'account_read contact_data campaign_data offline_access',refresh_token:'fixture-refresh'}}),owners={token:async()=>TOKEN};
const response=(data:unknown,status=200)=>new Response(data===null?null:JSON.stringify(data),{status});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
// Merchant journey: discover exact usable fields, read contacts with paging,
// import asynchronously, inspect failures, update registrations and delete.
describe('Constant Contact current-grant business contracts',()=>{
 it('retains complete official writable input trees and excludes other grants and transports',()=>{
  const actions=api.actionsFor(),validator=new AjvJsonSchemaValidator();expect(evidence.inventory).toHaveLength(131);expect(Object.keys(actions)).toHaveLength(111);
  function compare(raw:any,current:any,root:any,seen=new Set<string>()){
   if(raw.$ref){const id=raw.$ref.slice('#/components/schemas/'.length);expect(current.$ref).toBe('#/$defs/'+id);if(seen.has(id))return;compare(evidence.model.components.schemas[id],root.$defs[id],root,new Set([...seen,id]));return;}
   if(raw.type)expect(current.type).toBe(raw.type);if(raw.properties){const keys=Object.keys(raw.properties).filter(k=>!raw.properties[k].readOnly);expect(Object.keys(current.properties)).toEqual(keys);for(const k of keys)compare(raw.properties[k],current.properties[k],root,seen);}
   if(raw.required)expect(current.required).toEqual(raw.required.filter((k:string)=>!raw.properties?.[k]?.readOnly));if(raw.items)compare(raw.items,current.items,root,seen);
   for(const k of ['oneOf','anyOf','allOf'])if(raw[k])raw[k].forEach((v:any,i:number)=>compare(v,current[k][i],root,seen));
  }
  for(const row of evidence.inventory){const name=row.method+' '+row.path;if(row.excluded_reason){expect(actions[name]).toBeUndefined();continue;}
   const spec=actions[name],op=evidence.model.paths[row.path][row.method.toLowerCase()];expect(spec.risk).toBe(row.risk);expect(()=>validator.getValidator(spec.input_schema)).not.toThrow();
   if(op.requestBody)compare(op.requestBody.content['application/json'].schema,spec.input_schema.properties.body,spec.input_schema);
   for(const p of op.parameters||[])compare(p.schema,spec.input_schema.properties[p.in].properties[p.name],spec.input_schema);
   for(const s of Object.values(contracts.methods[name].responses))if(s)expect(()=>validator.getValidator({...s as object,$defs:contracts.definitions.output})).not.toThrow();
  }
 });
 it('preserves authorized business contacts and uses exact repeated query fields without automatic pagination',async()=>{
  const fetch=vi.fn().mockResolvedValue(response({contacts:[{contact_id:'C1',email_address:{address:'fixture@example.invalid'},custom_fields:[{custom_field_id:'F1',value:'merchant errors stay'}]}],_links:{next:{href:'/contacts?cursor=next'}}}));vi.stubGlobal('fetch',fetch);
  const result=await api.execute(config(),'GET /contacts',{query:{limit:100}},owners);expect(result.data.contacts[0].email_address.address).toBe('fixture@example.invalid');expect(fetch.mock.calls[0][0]).toBe('https://api.cc.email/v3/contacts?limit=100');expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockResolvedValue(response({tracking_activities:[]}));await api.execute(config(),'GET /reports/contact_reports/{contact_id}/activity_details',{path:{contact_id:'C1'},query:{tracking_activity_type:['em_sends','em_opens']}},owners);
  expect(new URL(fetch.mock.calls[1][0]).searchParams.getAll('tracking_activity_type')).toEqual(['em_sends','em_opens']);expect(fetch).toHaveBeenCalledTimes(2);
 });
 it('preserves import receipts and failed asynchronous evidence without false completion or replay',async()=>{
  const fetch=vi.fn().mockResolvedValueOnce(response({activity_id:'A1',state:'initialized'},201)).mockResolvedValueOnce(response({activity_id:'A1',state:'failed',activity_errors:[TOKEN],status:{error_count:1,items_completed_count:1}}));vi.stubGlobal('fetch',fetch);
  const body={import_data:[{email:'fixture@example.invalid',first_name:'Fixture'}],list_ids:['L1']};const ack=await api.execute(config(),'POST /activities/contacts_json_import',{body},owners);expect(ack).toMatchObject({status:'acknowledged',data:{activity_id:'A1'},follow_up:expect.stringContaining('asynchronous')});expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(body);
  const failed=await api.execute(config(),'GET /activities/{activity_id}',{path:{activity_id:'A1'}},owners);expect(failed).toMatchObject({status:'partial_or_failed',data:{activity_error_count:1,status:{items_completed_count:1}}});expect(JSON.stringify(failed)).not.toContain(TOKEN);expect(fetch).toHaveBeenCalledTimes(2);
  fetch.mockResolvedValue(response({state:'initialized'},201));await expect(api.execute(config(),'POST /activities/contacts_json_import',{body},owners)).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});expect(fetch).toHaveBeenCalledTimes(3);
 });
 it('retains documented 207 registration failures and accepts bodyless deletion',async()=>{
  const fetch=vi.fn().mockResolvedValueOnce(response({failed_registration_ids:['R2']},207)).mockResolvedValueOnce(response(null,204));vi.stubGlobal('fetch',fetch);
  const result=await api.execute(config(),'PUT /events/{event_id}/tracks/{track_id}/registrations',{path:{event_id:'E1',track_id:'T1'},body:{registration_ids:['R1','R2'],registration_status:'REGISTERED'}},owners);expect(result).toEqual({status:'partial_or_failed',data:{failed_registration_ids:['R2']}});
  expect(await api.execute(config(),'DELETE /contacts/{contact_id}',{path:{contact_id:'C1'}},owners)).toEqual({data:null,status:'acknowledged'});expect(fetch).toHaveBeenCalledTimes(2);
  fetch.mockResolvedValue(response({failed_registration_ids:['UNRELATED']},207));
  await expect(api.execute(config(),'PUT /events/{event_id}/tracks/{track_id}/registrations',{path:{event_id:'E1',track_id:'T1'},body:{registration_ids:['R1'],registration_status:'REGISTERED'}},owners)).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});
  fetch.mockResolvedValue(response([],201));
  await expect(api.execute(config(),'POST /emails/activities/{campaign_activity_id}/schedules',{path:{campaign_activity_id:'M1'},body:{scheduled_date:'2026-10-02T12:00:00Z'}},owners)).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});expect(fetch).toHaveBeenCalledTimes(4);
 });
 it('rejects transport injection, unknown body fields, invalid bounds and missing scope before business IO',async()=>{
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  for(const p of [{headers:{authorization:'wrong'}},{query:{limit:101}},{query:{limit:1.5}}])await expect(api.execute(config(),'GET /contacts',p,owners)).rejects.toMatchObject({code:'E_BAD_INPUT'});
  await expect(api.execute(config(),'POST /contact_lists',{body:{name:'List',unknown:'x'}},owners)).rejects.toMatchObject({code:'E_BAD_INPUT'});
  await expect(api.execute(config(),'POST /contact_lists',{body:{name:'x'.repeat(262144)}},owners)).rejects.toMatchObject({code:'E_BAD_INPUT'});
  const c=config();c.credentials.scope='account_read';await expect(api.execute(c,'GET /contacts',{},owners)).rejects.toMatchObject({code:'E_TOOL_CALL_AUTH'});expect(fetch).not.toHaveBeenCalled();
 });
 it('owns authorization, rate limit, cancellation, timeout and response bounds without repeating a write',async()=>{
  const fetch=vi.fn().mockResolvedValueOnce(response({},403)).mockResolvedValueOnce(response({},429)).mockRejectedValueOnce(new DOMException('Fixture timeout','TimeoutError'));vi.stubGlobal('fetch',fetch);
  for(const code of ['E_TOOL_CALL_AUTH','E_TOOL_CALL_RATE_LIMIT','E_TOOL_CALL_TIMEOUT'])await expect(api.execute(config(),'GET /contacts',{},owners)).rejects.toMatchObject({code});
  const controller=new AbortController();controller.abort();await expect(withRequestSignal(controller.signal,()=>api.execute(config(),'GET /contacts',{},owners))).rejects.toMatchObject({code:'E_TOOL_CALL_CANCELLED'});expect(fetch).toHaveBeenCalledTimes(3);
  fetch.mockResolvedValue(response({contacts:[],huge:'x'.repeat(1024*1024)}));await expect(api.execute(config(),'GET /contacts',{},owners)).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});expect(fetch).toHaveBeenCalledTimes(4);
 });
});
