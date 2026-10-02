import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config, rows, TOKEN } from './merchant-platform-fixtures';
const require = createRequire(import.meta.url);
const api = require('../../../../bin/lazada-seller-api.cjs');
const context = require('../../../../bin/commerce-request-context.cjs');
const { AjvJsonSchemaValidator } = require('@modelcontextprotocol/sdk/validation/ajv');
const evidence = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../fixtures/connectors/official-contracts/lazada-20260930.json'), 'utf8'));
const row = rows.find(row => row.provider === 'lazada')!;
const c = () => ({ ...config(row), credentials: { ...config(row).credentials, provider:'lazada', access_token:TOKEN,
  refresh_token:'fixture-refresh-token', expires_at:Date.now()+3600000, refresh_expires_at:Date.now()+86400000,
  identity:{ shop_id:'456', country:'sg', app_fingerprint:require('node:crypto').createHash('sha256').update(config(row).credentials.app_key).digest('hex') } } });
const reply = (body:any) => new Response(JSON.stringify({ code:'0', ...body }));
const mockReply = (body:any) => { const m=vi.fn().mockResolvedValue(reply(body));vi.stubGlobal('fetch',m);return m; };
afterEach(() => { vi.unstubAllGlobals();vi.restoreAllMocks(); });

function compare(rows:any[], schema:any, apiPath:string) {
  const names=rows.map(r=>r.name);
  expect(Object.keys(schema.properties).sort()).toEqual(names.sort());
  expect(schema.required.sort()).toEqual(rows.filter(r=>r.required).map(r=>r.name).sort());
  expect(schema.additionalProperties).toBe(false);
  for (const r of rows) {
    let s=schema.properties[r.name];
    if (r.type.endsWith('[]') && r.type!=='byte[]') { expect(s.type).toBe('array');s=s.items; }
    if (r.type==='byte[]') {expect(s.required).toEqual(['name','content_base64']);continue;}
    expect(s.type).toBe(r.type.startsWith('Object')?'object':r.type.startsWith('Number')?(apiPath==='/orders/get' && ['limit','offset'].includes(r.name)?'integer':'number'):r.type==='Boolean'?'boolean':'string');
    if (r.children.length) compare(r.children,s,apiPath);
    else if (r.type==='Object') {expect(apiPath).toBe('/product/global/status/get');expect(Object.keys(s.properties)).toEqual(['sellerSku']);}
  }
}

describe('Lazada complete usable seller business contracts', () => {
  it('matches every independent public definition, excludes unavailable identities and compiles all input schemas', () => {
    const actions=api.actionsFor(), validator=new AjvJsonSchemaValidator();
    const native=Object.keys(actions).filter(n=>n.startsWith('GET ') || n.startsWith('POST '));
    const selected=evidence.inventory.filter((r:any)=>!r.unavailable_reason);
    expect(evidence.inventory).toHaveLength(378);expect(selected).toHaveLength(224);expect(native).toHaveLength(selected.length);
    for (const r of selected) {
      const name=native.find(n=>n.slice(n.indexOf(' ')+1)===r.path)!;expect(name).toBeTruthy();
      const action=actions[name];expect(action.input_schema.additionalProperties).toBe(false);
      compare(evidence.definitions[r.path].parameters.data,action.input_schema.properties.parameters,r.path);
      expect(()=>validator.getValidator(action.input_schema)).not.toThrow();
    }
    for (const r of evidence.inventory.filter((r:any)=>r.unavailable_reason)) expect(native.some(n=>n.endsWith(' '+r.path))).toBe(false);
    expect(api.coverageFor()).toMatchObject({complete:false,reviewed_business_methods:224});
    expect(actions['GET /review/seller/reply/add'].risk).toBe('H');
    expect(actions['GET /order/reverse/cancel/create'].risk).toBe('D');
  });
  it('retains update filters, maximum order pages, buyer fulfillment contacts and amounts while removing credentials', async () => {
    const mock=mockReply({data:{orders:[{order_id:11,address_shipping:{first_name:'Authorized buyer',phone:'123',address1:'Business fixture address'},price:'12',access_token:TOKEN}],countTotal:101,count:100}});
    const p={update_after:'2026-09-01T00:00:00+08:00',status:'toship',offset:100,limit:100,sort_by:'updated_at',sort_direction:'ASC'};
    const result=await api.execute(c(),'GET /orders/get',{parameters:p});
    expect(result).toMatchObject({data:{data:{orders:[{address_shipping:{phone:'123'},price:'12'}],countTotal:101}}});
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    const url=new URL(mock.mock.calls[0][0]);expect(url.hostname).toBe('api.lazada.sg');expect(url.searchParams.get('limit')).toBe('100');expect(url.searchParams.get('update_after')).toBe(p.update_after);
    await expect(api.execute(c(),'GET /orders/get',{parameters:{limit:100}})).rejects.toMatchObject({code:'storefront_validation_failed'});
    await expect(api.execute(c(),'GET /orders/get',{parameters:{...p,limit:101}})).rejects.toThrow();
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it('signs exact form parameters and serializes structured lists without changing published GET side effects', async () => {
    const mock=mockReply({data:{reverse_order_id:33,total_refund:'12',reverse_order_line:[{reverse_order_line_id:2,refund_amount:12}]}});
    await api.execute(c(),'GET /order/reverse/return/update',{parameters:{action:'approve',reverse_order_id:33,reverse_order_item_ids:[2],reason_id:1}});
    const [raw,init]=mock.mock.calls[0];expect(init.method).toBe('GET');const u=new URL(raw);expect(u.pathname).toBe('/rest/order/reverse/return/update');expect(u.searchParams.get('reverse_order_item_ids')).toBe('[2]');
    const values=Object.fromEntries(u.searchParams.entries());expect(values.sign).toBe(api.sign('/order/reverse/return/update',values,c().credentials.app_secret));
    mock.mockResolvedValueOnce(reply({data:{item_id:11,sku_list:[{sku_id:12}],item_status:'Pending QC'}}));
    const payload='<Request><Product><PrimaryCategory>100</PrimaryCategory><Attributes><name>Fixture &amp; product</name></Attributes><Skus><Sku><SellerSku>SKU-1</SellerSku><price>12</price></Sku></Skus></Product></Request>';
    expect(await api.execute(c(),'POST /product/create',{parameters:{payload}})).toMatchObject({status:'acknowledged',data:{data:{item_status:'Pending QC'}}});
    const sent=new URLSearchParams(mock.mock.calls[1][1].body);expect(sent.get('payload')).toBe(payload);expect(mock.mock.calls[1][1].method).toBe('POST');
  });
  it('reconciles every packed item, retains partial failures and never treats success=true as complete shipment', async () => {
    const mock=mockReply({result:{success:true,data:{pack_order_list:[{order_id:11,order_item_list:[{order_item_id:1,item_err_code:'0',package_id:'P1'},{order_item_id:2,item_err_code:'600001',msg:TOKEN}]}]}}});
    const parameters={packReq:{delivery_type:'dropship',shipping_allocate_type:'TFS',pack_order_list:[{order_id:11,order_item_list:[1,2]}]}};
    expect(await api.execute(c(),'POST /order/fulfill/pack',{parameters})).toMatchObject({status:'partial_or_failed',data:{result:{data:{pack_order_list:[{order_item_list:[{package_id:'P1'},{item_err_code:'600001'}]}]}}}});
    mock.mockResolvedValueOnce(reply({result:{success:true,data:{pack_order_list:[{order_id:11,order_item_list:[{order_item_id:1,item_err_code:'0'}]}]}}}));
    await expect(api.execute(c(),'POST /order/fulfill/pack',{parameters})).rejects.toMatchObject({code:'storefront_invalid_response'});
    mock.mockResolvedValueOnce(reply({result:{success:true,data:{pack_order_list:[{order_id:11,order_item_list:[{order_item_id:1,item_err_code:'600001'}]}]}}}));
    await expect(api.execute(c(),'POST /order/fulfill/pack',{parameters})).rejects.toMatchObject({code:'storefront_invalid_response'});
    await expect(api.execute(c(),'POST /order/fulfill/pack',{parameters:{packReq:{...parameters.packReq,pack_order_list:[{order_id:11,order_item_list:[1,1]}]}}})).rejects.toMatchObject({code:'storefront_validation_failed'});
    expect(mock).toHaveBeenCalledTimes(3);
    const encoded=new URLSearchParams(mock.mock.calls[0][1].body);expect(JSON.parse(encoded.get('packReq')!)).toEqual(parameters.packReq);
  });
  it('checks each ready-to-ship package and validates published batch limits before IO', async () => {
    const mock=mockReply({result:{success:true,data:{packages:[{package_id:'P1',item_err_code:'0'},{package_id:'P2',item_err_code:'700020',retry:'true',msg:TOKEN}]}}});
    const parameters={readyToShipReq:{packages:[{package_id:'P1'},{package_id:'P2'}]}};
    expect(await api.execute(c(),'POST /order/package/rts',{parameters})).toMatchObject({status:'partial_or_failed'});
    mock.mockResolvedValueOnce(reply({result:{success:true,data:{packages:[{package_id:'P3',item_err_code:'0'}]}}}));
    await expect(api.execute(c(),'POST /order/package/rts',{parameters})).rejects.toThrow(/acknowledg/);
    await expect(api.execute(c(),'POST /order/package/rts',{parameters:{readyToShipReq:{packages:Array.from({length:21},(_,i)=>({package_id:String(i)}))}}})).rejects.toThrow();
    expect(mock).toHaveBeenCalledTimes(2);
  });
  it('handles non-data envelopes, asynchronous media acknowledgements and void refund decisions', async () => {
    const mock=mockReply({success:true,capacity_size:100,used_size:10,result_code:'ok'});
    expect(await api.execute(c(),'GET /media/video/quota/get',{})).toMatchObject({data:{capacity_size:100,used_size:10}});
    mock.mockResolvedValueOnce(reply({success:true,upload_id:'UPLOAD-1',result_code:'ok'}));
    expect(await api.execute(c(),'POST /media/video/block/create',{parameters:{fileName:'fixture.mp4',fileBytes:100}})).toMatchObject({status:'acknowledged',data:{upload_id:'UPLOAD-1'}});
    mock.mockResolvedValueOnce(reply({data:null}));
    expect(await api.execute(c(),'GET /order/reverse/onlyrefund/seller/decide',{parameters:{action:'approve',reverse_order_id:33,reverse_order_item_ids:[2]}})).toMatchObject({status:'acknowledged',data:{data:null}});
  });
  it('uses bounded inline multipart bytes without signing the file as an object or accepting file paths', async () => {
    const mock=mockReply({data:{image:{url:'https://img.example/authorized.jpg'}}});
    await api.execute(c(),'POST /image/upload',{parameters:{image:{name:'fixture.jpg',content_base64:Buffer.from('image fixture').toString('base64')}}});
    const [raw,init]=mock.mock.calls[0];expect(new URL(raw).pathname).toBe('/rest/image/upload');expect(init.body).toBeInstanceOf(FormData);expect(init.headers).not.toHaveProperty('content-type');
    const form=init.body as FormData;const values=Object.fromEntries([...form.entries()].filter(([key])=>key!=='image').map(([key,v])=>[key,String(v)]));expect(values.sign).toBe(api.sign('/image/upload',values,c().credentials.app_secret));expect(await (form.get('image') as File).text()).toBe('image fixture');
    await expect(api.execute(c(),'POST /image/upload',{parameters:{image:{path:'/tmp/private.jpg'}}})).rejects.toThrow();
    await expect(api.execute(c(),'POST /image/upload',{parameters:{image:{name:'../private.jpg',content_base64:'eA=='}}})).rejects.toThrow();
    await expect(api.execute(c(),'POST /image/upload',{parameters:{image:{name:'fixture.jpg',content_base64:'eB=='}}})).rejects.toThrow();
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it('enforces seller warehouse identity and closed nested fields instead of accepting another shop', async () => {
    const mock=mockReply({result:{success:true,module:true,not_success:false,repeated:false,retry:false}});
    const parameters={ownerType:0,sellerId:456,warehouseOwnerType:'SELLER',warehouseContactDTO:{phoneNumber:'123',email:'fixture@example.com'},siteId:'SG',warehouseAddressInfoDTO:{},warehouseType:200,ownerId:456,warehouseName:'Warehouse fixture',currencyCode:'SGD',resourceType:1};
    const address=evidence.definitions['/rc/sellerWarehouse/saveWarehouseInfo'].parameters.data.find((r:any)=>r.name==='warehouseAddressInfoDTO');
    parameters.warehouseAddressInfoDTO=Object.fromEntries(address.children.filter((r:any)=>r.required).map((r:any)=>[r.name,r.name==='defaultAddress'?0:'fixture']));
    await api.execute(c(),'POST /rc/sellerWarehouse/saveWarehouseInfo',{parameters});
    await expect(api.execute(c(),'POST /rc/sellerWarehouse/saveWarehouseInfo',{parameters:{...parameters,sellerId:999}})).rejects.toThrow(/binding/);
    await expect(api.execute(c(),'POST /rc/sellerWarehouse/saveWarehouseInfo',{parameters:{...parameters,warehouseContactDTO:{...parameters.warehouseContactDTO,access_token:TOKEN}}})).rejects.toThrow();
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it('does not confuse outer success, conflicting business codes or missing results with a valid acknowledgement', async () => {
    const mock=mockReply({success:true,result:false});
    const p={parameters:{bizCode:'SP',campaignId:11,adgroupViewDTOList:[]}};
    expect(await api.execute(c(),'POST /sponsor/solutions/adgroup/addAdgroupBatch',p)).toMatchObject({status:'partial_or_failed'});
    mock.mockResolvedValueOnce(reply({success:'true',data:'{}',error_code:'E207',error_msg:TOKEN}));
    expect(await api.execute(c(),'GET /product/global/status/get',{parameters:{params:{sellerSku:'SKU-1'}}})).toMatchObject({status:'partial_or_failed'});
    mock.mockResolvedValueOnce(reply({}));await expect(api.execute(c(),'GET /order/get',{parameters:{order_id:11}})).rejects.toThrow(/acknowledg/);
    mock.mockResolvedValueOnce(reply({success:true,result_code:'ok'}));
    await expect(api.execute(c(),'POST /media/video/block/create',{parameters:{fileName:'fixture.mp4',fileBytes:100}})).rejects.toThrow(/acknowledg/);
    mock.mockResolvedValueOnce(reply({success:'true',error_code:'null',data:{product_id:11}}));
    expect(await api.execute(c(),'POST /product/global/semi/update',{parameters:{payload:'<Request />'}})).toMatchObject({status:'acknowledged'});
    expect(mock).toHaveBeenCalledTimes(5);
  });
  it('keeps cancellation separate from timeouts through fetch and response-body reads, without replay', async () => {
    const owner=new AbortController();const mock=vi.fn().mockImplementation(async (_u:any,init:any)=>{owner.abort();init.signal.throwIfAborted();});vi.stubGlobal('fetch',mock);
    await expect(context.withRequestSignal(owner.signal,()=>api.execute(c(),'GET /order/get',{parameters:{order_id:11}}))).rejects.toMatchObject({code:'E_TOOL_CALL_CANCELLED'});
    const next=new AbortController();mock.mockResolvedValueOnce({ok:true,body:{getReader:()=>({read:async()=>{next.abort();throw new DOMException('fixture','AbortError');},releaseLock(){}})}});
    await expect(context.withRequestSignal(next.signal,()=>api.execute(c(),'GET /order/get',{parameters:{order_id:11}}))).rejects.toMatchObject({code:'E_TOOL_CALL_CANCELLED'});
    mock.mockResolvedValueOnce(reply({data:{order_id:11}}));await expect(api.execute(c(),'GET /order/get',{parameters:{order_id:11}})).resolves.toMatchObject({data:{data:{order_id:11}}});expect(mock).toHaveBeenCalledTimes(3);
  });
  it('keeps explicit permission failures private and rejects arbitrary endpoints, malformed nested values and overlarge input before IO', async () => {
    const mock=vi.fn().mockResolvedValue(new Response(JSON.stringify({code:'InsufficientPermission',message:TOKEN}),{status:403}));vi.stubGlobal('fetch',mock);
    await expect(api.execute(c(),'GET /order/get',{parameters:{order_id:11}})).rejects.toMatchObject({code:'storefront_permission_denied',message:expect.not.stringContaining(TOKEN)});
    for (const parameters of [{order_id:11,url:'https://evil.example'},{order_id:'11'},{order_id:11,extra:'x'.repeat(256*1024)}]) await expect(api.execute(c(),'GET /order/get',{parameters})).rejects.toThrow();
    await expect(api.execute(c(),'POST /sponsor/solutions/account/sign',{})).rejects.toThrow(/Unreviewed/);expect(mock).toHaveBeenCalledTimes(1);
  });
});
