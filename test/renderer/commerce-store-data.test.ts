import {describe,it,expect} from 'vitest';
const s=require('../../resources/builtin/apps/builtin-product-listing/store-data.js');
describe('persistent store refresh on entry',()=>{
 it('retains data across reopening and admits automatic refresh at 60 seconds, with manual override',async()=>{
  let time=100000,reads=0,saved:any=null;
  const options={now:()=>time,save:async(value:any)=>{saved=structuredClone(value);},read:async()=>({sales:++reads})};
  let cache=s.createCache(options);expect(await cache.refresh('shop')).toEqual({sales:1});
  time+=59999;cache=s.createCache({...options,initial:JSON.parse(JSON.stringify(saved))});
  expect(cache.get('shop').data).toEqual({sales:1});await cache.refresh('shop');expect(reads).toBe(1);
  time++;expect(await cache.refresh('shop')).toEqual({sales:2});
  expect(await cache.refresh('shop',true)).toEqual({sales:3});
 });
 it('joins concurrent manual requests and preserves the last successful data after failure and reopening',async()=>{
  let time=100000,saved:any,fail=false,release:any;
  const options={now:()=>time,save:async(value:any)=>{saved=structuredClone(value);},read:async()=>{if(fail)throw Error('offline');await new Promise(r=>{release=r;});return {sales:12};}};
  const cache=s.createCache(options),first=cache.refresh('shop');await new Promise(r=>setTimeout(r,0));
  const second=cache.refresh('shop',true);release();await Promise.all([first,second]);
  expect(cache.get('shop').lastSuccess).toBe(100000);time+=60000;fail=true;
  await expect(cache.refresh('shop')).rejects.toThrow('offline');
  const reopened=s.createCache({...options,initial:saved});expect(reopened.get('shop')).toMatchObject({data:{sales:12},lastSuccess:100000,lastAttempt:160000});
  expect(await reopened.refresh('shop')).toEqual({sales:12});
  time+=60000;await expect(reopened.refresh('shop')).rejects.toThrow('offline');
 });
 it('never fetches when the refresh claim cannot be persisted',async()=>{
  let calls=0;const cache=s.createCache({save:async()=>{throw Error('disk');},read:async()=>{calls++;return {};}});
  await expect(cache.refresh('shop')).rejects.toThrow('disk');expect(calls).toBe(0);
 });
 it('recovers from a backward clock and rejects incompatible or oversized persisted cache',async()=>{
  const cache=s.createCache({initial:{version:1,entries:{shop:{lastAttempt:200000,lastSuccess:200000,data:{sales:1}}}},now:()=>100000,save:async()=>{},read:async()=>({sales:2})});
  expect(await cache.refresh('shop')).toEqual({sales:2});
  expect(()=>s.createCache({initial:{version:2,entries:{}},save:async()=>{},read:async()=>({})})).toThrow();
  expect(()=>s.createCache({initial:{version:1,entries:{shop:{lastAttempt:0,lastSuccess:0,data:{oversized:'x'.repeat(524288)}}}},save:async()=>{},read:async()=>({})})).toThrow();
 });
});
describe('store data from reviewed connector reads',()=>{
 it('discovers server-reported shop identities without asking for a name or copying owner details',()=>{
  const shops=s.shops({id:'shopify-admin',name:'Account'}, {provider:'shopify',identity:{shop:{id:'gid://shopify/Shop/1',name:'Atlas',myshopifyDomain:'atlas.myshopify.com',currencyCode:'USD',email:'private@example.test'}}});
  expect(shops).toHaveLength(1);expect(shops[0]).toMatchObject({name:'Atlas',remoteShopId:'gid://shopify/Shop/1',currency:'USD',url:'https://atlas.myshopify.com'});
  expect(JSON.stringify(shops)).not.toContain('private@example.test');
  expect(()=>s.shops({id:'custom-store',name:'Private'}, {provider:'shopify',identity:{shop:{id:'1',name:'Fake'}}})).toThrow();
 });
 it('uses stable shop bindings when WooCommerce does not report a display name',()=>{
  expect(s.shops({id:'woocommerce',name:'Woo account'}, {provider:'woocommerce',identity:{store_url:'https://shop.example',currency:'EUR'}})[0]).toMatchObject({name:'shop.example',remoteShopId:'https://shop.example',currency:'EUR'});
 });
 it('computes net merchandise and pieces in UTC from complete Shopify pages, excluding cancelled and test orders',async()=>{
  const native=require('../../bin/shopify-business-api.cjs'),calls:any[]=[];
  const order=(id:string,date:string,amount:string,qty:number,extra={})=>({id,createdAt:date,cancelledAt:null,test:false,currentSubtotalLineItemsQuantity:qty,currentSubtotalPriceSet:{shopMoney:{amount,currencyCode:'USD'}},...extra});
  const metrics=await s.metrics({connectorId:'shopify-admin',currency:'USD'},async(action:string,parameters:any)=>{
   calls.push({action,parameters});expect(()=>native.build(action,parameters)).not.toThrow();
   return {data:{orders:{nodes:calls.length===1?[order('1','2026-11-11T01:00:00Z','12.50',2),order('2','2026-11-10T23:30:00Z','7.00',1),order('3','2026-11-11T02:00:00Z','99',9,{cancelledAt:'2026-11-11T03:00:00Z'})]:[order('4','2026-11-11T02:00:00Z','90',9,{test:true})],pageInfo:{hasNextPage:calls.length===1,endCursor:'cursor-1'}}}};
  },Date.parse('2026-11-11T12:00:00Z'));
  expect(metrics.currency).toBe('USD');expect(metrics.days).toHaveLength(30);
  expect(metrics.days.at(-1)).toEqual({date:'2026-11-11',sales:12.5,units:2});expect(metrics.days.at(-2)).toEqual({date:'2026-11-10',sales:7,units:1});
  expect(calls[1].parameters.arguments.after).toBe('cursor-1');
 });
 it('rejects incomplete, duplicate or currency-mixed pages instead of presenting a partial total',async()=>{
  await expect(s.metrics({connectorId:'shopify-admin',currency:'USD'},async()=>({data:{orders:{nodes:[],pageInfo:{hasNextPage:true,endCursor:'same'}}}}),Date.now())).rejects.toThrow();
  await expect(s.metrics({connectorId:'shopify-admin',currency:'USD'},async()=>({data:{orders:{nodes:[{id:'1',createdAt:new Date().toISOString(),cancelledAt:null,test:false,currentSubtotalLineItemsQuantity:1,currentSubtotalPriceSet:{shopMoney:{amount:'2',currencyCode:'EUR'}}}],pageInfo:{hasNextPage:false,endCursor:null}}}}),Date.now())).rejects.toThrow();
  expect(await s.metrics({connectorId:'bigcommerce',currency:'USD'},async()=>{throw Error('should not call an unreviewed report');},Date.now())).toBeNull();
 });
 it('orders single/multiple shop tabs by name and preserves different currencies in totals',()=>{
  expect(s.tabs([{id:'b',name:'Zulu'}],'en').map((x:any)=>x.id)).toEqual(['b']);
  expect(s.tabs([{id:'b',name:'Zulu'},{id:'a',name:'Alpha'}],'en').map((x:any)=>x.id)).toEqual(['','a','b']);
  const total=s.totals([{currency:'EUR',days:[{date:'2026-11-11',sales:4,units:2}]},{currency:'USD',days:[{date:'2026-11-11',sales:6,units:1}]}],'2026-11-11');
  expect(total.sales).toEqual({EUR:4,USD:6});expect(total.units).toBe(3);
 });
});
