import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const require = createRequire(import.meta.url), api = require('../../../../bin/yahoo-shopping-business-api.cjs');
const { XMLParser } = require('fast-xml-parser');
const { withRequestSignal } = require('../../../../bin/commerce-request-context.cjs');
let sequence=0;
function config(){const credentials:any={provider:'yahoo_shopping',client_id:'fixture-client-'+ ++sequence,client_secret:'fixture-secret',access_token:'fixture-token',refresh_token:'fixture-refresh',expires_at:Date.now()+3600000};const metadata={seller_id:'fixture-store'};credentials.identity={fingerprint:crypto.createHash('sha256').update(JSON.stringify([metadata.seller_id,'',credentials.client_id,credentials.client_secret,''])).digest('hex')};return{provider:'yahoo_shopping',metadata,credentials};}
async function settle<T>(promise:Promise<T>):Promise<T>{const pending=promise.then(value=>({value}),error=>({error}));await vi.runAllTimersAsync();const outcome=await pending;if('error'in outcome)throw outcome.error;return outcome.value;}
function fixture(handler:(url:URL,init:any)=>Response){const calls:any[]=[];vi.stubGlobal('fetch',async(raw:string,init:any)=>{const url=new URL(raw);calls.push({url,init,time:Date.now()});expect(url.origin).toBe('https://circus.shopping.yahooapis.jp');expect(init.headers.authorization).toBe('Bearer fixture-token');return handler(url,init);});return calls;}
const xml=(body:string,status=200)=>new Response(body,{status});
const json=(data:any,status=200)=>new Response(JSON.stringify(data),{status});
beforeEach(()=>vi.useFakeTimers());afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});
// Merchants need exact current fields, bounded authorized writes and actionable partial receipts.
// Official tables/receipts, rejected contradictory examples and request journals are independent oracles.
it('discovers typed ordinary APIs while excluding binary transport, unsupported fields and contradictory contracts',()=>{
 const a=api.actionsFor();expect(Object.keys(a)).toHaveLength(77);
 expect(a['yahoo.v1.editItem'].input_schema.properties.parameters.properties).toHaveProperty('variation5_free_title');
 expect(a['yahoo.v1.editItem'].input_schema.properties.parameters.properties).not.toHaveProperty('eco_setting_id');
 expect(a['yahoo.v1.orderInfo'].input_schema.properties.body.properties.Target.properties.Field.items.enum).toContain('BillMailAddress');
 expect(Object.keys(a).some(x=>x.includes('upload')||x.includes('getRealStockList'))).toBe(false);
});
it('preserves full selected order contacts, XML entities and exact numeric strings with bound seller',async()=>{
 const calls=fixture((_url,init)=>{const b=new XMLParser({parseTagValue:false}).parse(init.body);expect(b.Req).toEqual({Target:{OrderId:'fixture-store-1',Field:'OrderId,BillMailAddress'},SellerId:'fixture-store'});return xml('<ResultSet><Result><Status>OK</Status><OrderInfo><OrderId>fixture-store-1</OrderId><BillMailAddress>buyer@example.test</BillMailAddress><Notes><![CDATA[A & B]]></Notes><Id>9007199254740993</Id><access_token>fixture-token</access_token></OrderInfo></Result></ResultSet>');});
 const result=await settle(api.execute(config(),'yahoo.v1.orderInfo',{body:{Target:{OrderId:'fixture-store-1',Field:['OrderId','BillMailAddress']}}}));
 expect(result.data.ResultSet.Result.OrderInfo).toMatchObject({BillMailAddress:'buyer@example.test',Id:'9007199254740993',Notes:'A & B'});expect(JSON.stringify(result)).not.toContain('fixture-token');expect(calls).toHaveLength(1);
});
it('preserves exact string identifiers, escaping and unsafe response integers without accepting scientific numeric approximations',async()=>{
 const calls=fixture((_url,init)=>{expect(JSON.parse(init.body).conditions).toEqual({changeRequestId:'9007199254740993',itemId:'quoted"slash\\9007199254740993'});return new Response('{"count":1,"results":[{"changeRequestId":9007199254740993}]}');});
 const parameters={body:{conditions:{changeRequestId:'9007199254740993',itemId:'quoted"slash\\9007199254740993'},countFrom:1,countTo:10}};
 const result=await settle(api.execute(config(),'yahoo.v1.subscription.order.origin.list',parameters));expect(result.data.results[0].changeRequestId).toBe('9007199254740993');
 await expect(api.execute(config(),'yahoo.v1.subscription.order.origin.list',{body:{conditions:{changeRequestId:'1234567890123456789'}}})).rejects.toMatchObject({code:'E_BAD_INPUT'});expect(calls).toHaveLength(1);
 fixture(()=>new Response('{"count":1,"results":[{"changeRequestId":9.007199254740993e15}]}'));await expect(settle(api.execute(config(),'yahoo.v1.subscription.order.origin.list'))).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});
});
it('requires full batch image deletion receipts rather than one plausible success',async()=>{
 const calls=fixture(()=>xml('<ResultSet totalResultsAvailable="2" okResultsCount="1" ngResultsCount="0"><Result><Status>OK</Status><Id>fixture-store_a</Id></Result></ResultSet>'));
 await expect(settle(api.execute(config(),'yahoo.v1.deleteItemImage',{parameters:{image_id:'fixture-store_a,fixture-store_b'}}))).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});expect(calls).toHaveLength(1);
});
it('checks absolute stock acknowledgement, preserves signed deltas and existing overselling settings without retry',async()=>{
 let wrong=true;const calls=fixture((url,init)=>url.pathname.endsWith('/getStock')?xml('<ResultSet><Result><ItemCode>item-1</ItemCode><Status>1</Status><AllowOverdraft>1</AllowOverdraft><Quantity>4</Quantity></Result></ResultSet>'):xml('<ResultSet><Result><ItemCode>item-1</ItemCode><Quantity>'+(wrong?'999':'6')+'</Quantity></Result></ResultSet>'));
 await expect(settle(api.execute(config(),'yahoo.v1.setStock',{parameters:{item_code:'item-1',quantity:'5'}}))).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});
 wrong=false;expect((await settle(api.execute(config(),'yahoo.v1.setStock',{parameters:{item_code:'item-1',quantity:'+2'}}))).status).toBe('acknowledged');
 expect(new URLSearchParams(calls.at(-1).init.body).get('allow_overdraft')).toBe('1');expect(calls.at(-1).init.body).toContain('quantity=%2B2');expect(calls.filter(x=>x.url.pathname.endsWith('/setStock'))).toHaveLength(2);
});
it('returns async acceptance with a usable follow-up action and retains warnings without raw provider text',async()=>{
 fixture(()=>xml('<ResultSet><Result><Status>OK</Status><Warning><Code>it-00001</Code><Message>private provider text</Message></Warning></Result></ResultSet>'));
 const accepted=await settle(api.execute(config(),'yahoo.v1.downloadRequest',{parameters:{type:1}}));expect(accepted.status).toBe('accepted');expect(accepted.follow_up.action).toBe('yahoo.v1.downloadList');expect(JSON.stringify(accepted)).not.toContain('private provider');expect(JSON.stringify(accepted)).toContain('it-00001');
});
it('encodes question body/query and DELETE JSON body distinctly, retaining business contacts',async()=>{
 const calls=fixture((url,init)=>{if(url.pathname.endsWith('/externalTalkAdd')){expect(url.searchParams.get('topicId')).toBe('topic1');expect(JSON.parse(init.body)).toMatchObject({sellerId:'fixture-store',body:'Reply buyer@example.test'});return json({topicid:'topic1',messageid:1,postdate:'1513776685'});}expect(init.method).toBe('DELETE');expect(JSON.parse(init.body)).toEqual({stocks:[{srId:'item1',skuId:null}],sellerId:'fixture-store'});return json({status:'ok'});});
 await settle(api.execute(config(),'yahoo.v1.externalTalkAdd',{query:{topicId:'topic1'},body:{body:'Reply buyer@example.test'}}));await settle(api.execute(config(),'yahoo.v1.deleteRealStock',{body:{stocks:[{srId:'item1',skuId:null}]}}));expect(calls).toHaveLength(2);
});
it('rejects input amplification, seller substitution, unsafe XML and cancelled delayed mutations without replay',async()=>{
 const calls=fixture(()=>xml('<!DOCTYPE x [<!ENTITY x SYSTEM "file:///private">]><ResultSet>&x;</ResultSet>'));
 for(const parameters of [{parameters:{seller_id:'other'}},{parameters:{image_id:Array.from({length:11},(_,i)=>'img'+i).join(',')}}])await expect(api.execute(config(),'yahoo.v1.deleteItemImage',parameters)).rejects.toMatchObject({code:'E_BAD_INPUT'});
 expect(calls).toHaveLength(0);await expect(settle(api.execute(config(),'yahoo.v1.getShopCategory'))).rejects.toMatchObject({code:'E_TOOL_CALL_UPSTREAM'});
 const changed=config();changed.metadata.seller_id='other';await expect(api.execute(changed,'yahoo.v1.getShopCategory')).rejects.toMatchObject({code:'E_TOOL_CALL_AUTH'});
 const controller=new AbortController();controller.abort();await expect(settle(withRequestSignal(controller.signal,()=>api.execute(config(),'yahoo.v1.deleteItem',{parameters:{item_code:'item1'}})))).rejects.toMatchObject({name:'AbortError'});expect(calls).toHaveLength(1);
});

it('checks declared response seller ownership without treating unrelated business keys as credentials or bindings',async()=>{
 fixture(()=>xml('<ResultSet><Result><Status>OK</Status><OrderInfo><SellerId>other-store</SellerId><OrderId>other-store-1</OrderId></OrderInfo></Result></ResultSet>'));
 await expect(settle(api.execute(config(),'yahoo.v1.orderInfo',{body:{Target:{OrderId:'fixture-store-1',Field:['OrderId']}}}))).rejects.toMatchObject({code:'E_TOOL_CALL_AUTH'});
 fixture(()=>xml('<ResultSet><Result><Status>OK</Status><OrderInfo><SellerId>fixture-store</SellerId><OrderId>fixture-store-1</OrderId><FreeData><sellerId>other-value</sellerId></FreeData></OrderInfo></Result></ResultSet>'));
 const r=await settle(api.execute(config(),'yahoo.v1.orderInfo',{body:{Target:{OrderId:'fixture-store-1',Field:['OrderId']}}}));expect(r.data.ResultSet.Result.OrderInfo.FreeData.sellerId).toBe('other-value');
});
it('accepts documented full-width and half-width names without inventing a non-ASCII double-width rule',()=>{
 for(const name of ['A'.repeat(150),'ｶ'.repeat(150),'名'.repeat(75)])expect(()=>api.build(config(),'yahoo.v1.editCustomPageDesign',{parameters:{name}})).not.toThrow();
 expect(()=>api.build(config(),'yahoo.v1.editCustomPageDesign',{parameters:{name:'A'.repeat(151)}})).toThrow();
});
