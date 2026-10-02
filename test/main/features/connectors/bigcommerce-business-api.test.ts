import {createRequire} from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {AjvJsonSchemaValidator} from '@modelcontextprotocol/sdk/validation/ajv';
const require=createRequire(import.meta.url),api=require('../../../../bin/bigcommerce-business-api.cjs');
const requestContext=require('../../../../bin/commerce-request-context.cjs');
const evidence=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../../../fixtures/connectors/official-contracts/bigcommerce-20261001.json'),'utf8'));
const token='fixture-bc-token-never-log';
const config=()=>({provider:'bigcommerce',metadata:{store_hash:'abc123'},credentials:{provider:'bigcommerce',access_token:token,identity:{binding:'abc123',shop_id:'123'}}});
const reply=(body:unknown,status=200)=>new Response(status===204?null:JSON.stringify(body),{status});
const item=(id:number)=>({permission_set:'app_only',namespace:'fixture',key:'color',value:'blue',resource_id:id});
const ack=(id:number)=>({...item(id),description:'',resource_type:'product',id:id+100,date_created:'2026-09-30T00:00:00Z',date_modified:'2026-09-30T00:00:00Z'});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
describe('BigCommerce bound merchant business contracts',()=>{
  it('exposes the pinned inventory with full reachable writable fields and valid schemas',()=>{
    const actions=api.actionsFor(),selected=evidence.inventory.filter((row:any)=>!row.excluded_reason);
    expect(Object.keys(evidence.models)).toHaveLength(77);expect(evidence.inventory).toHaveLength(982);expect(Object.keys(actions)).toHaveLength(608);
    expect(new Set(Object.keys(actions))).toEqual(new Set(selected.map((row:any)=>row.action)));
    const validator=new AjvJsonSchemaValidator();
    for(const [name,spec] of Object.entries(actions) as [string,any][]){
      expect(()=>validator.getValidator(spec.input_schema),name).not.toThrow();
      const row=selected.find((entry:any)=>entry.action===name),source=evidence.models[row.model],op=source.paths[row.path][row.method.toLowerCase()],visited=new Set<string>();
      function compare(original:any,converted:any){
        if(original.$ref){const id=row.model+'__'+original.$ref.slice('#/components/schemas/'.length);expect(converted.$ref).toBe('#/$defs/'+id);if(visited.has(id))return;visited.add(id);compare(source.components.schemas[original.$ref.slice('#/components/schemas/'.length)],spec.input_schema.$defs[id]);return;}
        expect(converted.type).toEqual(original.type ?? (original.properties?'object':undefined));
        if(original.enum)expect(converted.enum).toEqual(original.enum);
        if(original.required)expect(converted.required).toEqual(original.required.filter((key:string)=>!original.properties?.[key]?.readOnly));
        if(original.properties){const keys=Object.keys(original.properties).filter(key=>!original.properties[key].readOnly);expect(Object.keys(converted.properties)).toEqual(keys);for(const key of keys)compare(original.properties[key],converted.properties[key]);}
        if(original.items)compare(original.items,converted.items);
        for(const key of ['oneOf','anyOf','allOf'])if(original[key])original[key].forEach((child:any,index:number)=>compare(child,converted[key][index]));
      }
      if(op.requestBody)compare(op.requestBody.content['application/json'].schema,spec.input_schema.properties.body);
      for(const parameter of op.parameters || [])if(['path','query'].includes(parameter.in) && parameter.name!=='store_hash')compare(parameter.schema,spec.input_schema.properties[parameter.in].properties[parameter.name]);
    }
    for(const name of ['POST /v3/payments/access_tokens','POST /v3/themes','POST /v3/infrastructure/projects'])expect(api.isNative(name)).toBe(false);
    expect(api.isNative('POST /v3/payments/transactions/purchases')).toBe(true);
    const schema=actions['GET /v2/orders/{order_id}'].input_schema,altered=structuredClone(schema);delete altered.properties.query.properties.consignment_structure;
    expect(Object.keys(altered.properties.query.properties)).not.toEqual(Object.keys(schema.properties.query.properties));
  });
  it('preserves fulfillment contacts and explicit page filters within the bound store',async()=>{
    const fetch=vi.fn(async()=>reply({id:123,billing_address:{zip:'10001',email:'fixture@example.invalid',phone:'123'},custom:{errors:'business-data',detail:'keep'},access_token:token}));vi.stubGlobal('fetch',fetch);
    const result=await api.execute(config(),'GET /v2/orders/{order_id}',{path:{order_id:123},query:{include:['consignments','fees'],consignment_structure:'object'}});
    expect(result.data.billing_address).toEqual({zip:'10001',email:'fixture@example.invalid',phone:'123'});expect(result.data.custom).toEqual({errors:'business-data',detail:'keep'});expect(result.data.access_token).toBeUndefined();
    const [raw,init]=fetch.mock.calls[0] as unknown as [string,RequestInit],url=new URL(raw);
    expect(url.origin).toBe('https://api.bigcommerce.com');expect(url.pathname).toBe('/stores/abc123/v2/orders/123');expect(url.searchParams.get('include')).toBe('consignments,fees');
    expect(init).toMatchObject({method:'GET',redirect:'error',headers:{'X-Auth-Token':token}});expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('accepts officially open widget configuration dictionaries while retaining closed transport fields',async()=>{
    const fetch=vi.fn(async()=>reply({data:{uuid:'widget-1',name:'Fixture',widget_configuration:{label:'Hello',nested:{count:0}}}}));vi.stubGlobal('fetch',fetch);
    const body={name:'Fixture',widget_template_uuid:'template-1',widget_configuration:{label:'Hello',nested:{count:0}}};
    const result=await api.execute(config(),'POST /v3/content/widgets',{body});
    expect(result.data.data.widget_configuration).toEqual(body.widget_configuration);
    expect(JSON.parse(String((fetch.mock.calls[0] as unknown as [string,RequestInit])[1].body))).toEqual(body);
    await expect(api.execute(config(),'POST /v3/content/widgets',{body,url:'https://other.invalid'})).rejects.toMatchObject({code:'E_BAD_INPUT'});expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('accepts provider field projections without dropping requested business values',async()=>{
    const fetch=vi.fn(async()=>reply({data:[{id:101,value:'blue'}],meta:{}}));vi.stubGlobal('fetch',fetch);
    const result=await api.execute(config(),'GET /v3/catalog/products/metafields',{query:{include_fields:['value']}});
    expect(result.data.data).toEqual([{id:101,value:'blue'}]);
    await expect(api.execute(config(),'GET /v3/catalog/products/metafields',{})).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('retains partial batch evidence without provider prose and rejects omitted acknowledgements',async()=>{
    const name='POST /v3/catalog/products/metafields',fetch=vi.fn(async()=>reply({data:[ack(1)],errors:[{status:422,title:'private '+token}],meta:{total:2,success:1,failed:1}},422));vi.stubGlobal('fetch',fetch);
    const result=await api.execute(config(),name,{body:[item(1),item(2)]});
    expect(result).toMatchObject({status:'partial_or_failed',data:{data:[ack(1)],meta:{total:2,success:1,failed:1},error_count:1}});expect(JSON.stringify(result)).not.toContain(token);expect(result.data.errors).toBeUndefined();
    expect(JSON.parse(String((fetch.mock.calls[0] as unknown as [string,RequestInit])[1].body))).toEqual([item(1),item(2)]);
    fetch.mockResolvedValueOnce(reply({data:[ack(1)],meta:{total:2,success:2,failed:0}}));
    await expect(api.execute(config(),name,{body:[item(1),item(2)]})).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('acknowledges zero inventory asynchronously and rejects missing transaction evidence without replay',async()=>{
    const fetch=vi.fn(async()=>reply({transaction_id:'tx-1'}));vi.stubGlobal('fetch',fetch);
    const p={body:{items:[{location_id:1,variant_id:2,quantity:0}],reason:'Fixture'}};
    expect(await api.execute(config(),'PUT /v3/inventory/adjustments/absolute',p)).toMatchObject({status:'acknowledged',data:{transaction_id:'tx-1'},follow_up:expect.stringContaining('asynchronously')});
    expect(JSON.parse(String((fetch.mock.calls[0] as unknown as [string,RequestInit])[1].body))).toEqual(p.body);
    fetch.mockResolvedValueOnce(reply({}));await expect(api.execute(config(),'PUT /v3/inventory/adjustments/absolute',p)).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('rejects account tampering, transport injection, excessive batch and oversized bodies before IO',async()=>{
    const fetch=vi.fn();vi.stubGlobal('fetch',fetch);const changed=config();changed.metadata.store_hash='different';
    await expect(api.execute(changed,'GET /v2/orders/{order_id}',{path:{order_id:1}})).rejects.toThrow(/binding/);
    for(const p of [{path:{order_id:1,store_hash:'other'}},{path:{order_id:1},header:{authorization:'evil'}},{path:{order_id:'../other'}}])await expect(api.execute(config(),'GET /v2/orders/{order_id}',p)).rejects.toMatchObject({code:'E_BAD_INPUT'});
    await expect(api.execute(config(),'POST /v3/catalog/products/metafields',{body:Array.from({length:11},(_,i)=>item(i+1))})).rejects.toMatchObject({code:'E_BAD_INPUT'});
    await expect(api.execute(config(),'POST /v3/catalog/products/metafields',{body:[{...item(1),value:'x'.repeat(262144)}]})).rejects.toMatchObject({code:'E_BAD_INPUT'});expect(fetch).not.toHaveBeenCalled();
  });
  it('supports bodyless deletion and rejects a misleading JSON acknowledgement',async()=>{
    const fetch=vi.fn(async()=>reply(null,204));vi.stubGlobal('fetch',fetch);
    expect(await api.execute(config(),'DELETE /v3/catalog/products/{product_id}',{path:{product_id:1}})).toEqual({data:null,status:'acknowledged'});
    fetch.mockResolvedValueOnce(reply({unexpected:true},200));await expect(api.execute(config(),'DELETE /v3/catalog/products/{product_id}',{path:{product_id:1}})).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('preserves unsuccessful asynchronous job status without treating merchant error-like fields as failures',async()=>{
    const fetch=vi.fn(async()=>reply({data:{id:'job-1',status:'FAILED',errors:[],percent_complete:100}}));vi.stubGlobal('fetch',fetch);
    const name=Object.keys(api.actionsFor()).find(name=>name.startsWith('GET /v3/themes/jobs/'));
    expect(name).toBeDefined();
    const params=api.actionsFor()[name!].input_schema.properties.path.properties;
    const result=await api.execute(config(),name,{path:Object.fromEntries(Object.keys(params).map(key=>[key,'job-1']))});
    expect(result.status).toBe('partial_or_failed');expect(result.data.data.status).toBe('FAILED');expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('classifies authorization, streaming cancellation and oversized bodies without replay',async()=>{
    const fetch=vi.fn(async()=>reply({message:token},403));vi.stubGlobal('fetch',fetch);const name='GET /v2/orders/{order_id}',p={path:{order_id:123}};
    await expect(api.execute(config(),name,p)).rejects.toMatchObject({code:'E_TOOL_CALL_AUTH'});
    const controller=new AbortController();fetch.mockImplementationOnce(async()=>new Response(new ReadableStream({pull(){controller.abort();throw new DOMException('fixture','AbortError');}})));
    await expect(requestContext.withRequestSignal(controller.signal,()=>api.execute(config(),name,p))).rejects.toMatchObject({code:'E_TOOL_CALL_CANCELLED'});
    fetch.mockResolvedValueOnce(reply({id:123,large:'x'.repeat(1024*1024)}));await expect(api.execute(config(),name,p)).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});expect(fetch).toHaveBeenCalledTimes(3);
  });
});
