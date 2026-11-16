import {describe,it,expect} from 'vitest';
const m=require('../../resources/builtin/apps/builtin-product-listing/model.js');
describe('product listing records and publication',()=>{
 it('imports quoted CSV data and preserves missing facts instead of filling them',()=>{const rows=m.csv('name,sku,price,facts\r\n"Cup, blue",CUP-1,12.50,"steel\n500 ml"\r\n');expect(rows).toEqual([{name:'Cup, blue',sku:'CUP-1',price:'12.50',facts:'steel\n500 ml'}]);expect(()=>m.csv('name,price\n"unfinished')).toThrow();});
 it('requires usable product content and freezes a snapshot without a separate fact-confirmation gate',()=>{const p=m.product('p-1');Object.assign(p,{name:'Cup',sku:'CUP',price:'12.50',currency:'USD',facts:'500 ml',confirmed:true});p.copy={title:'Travel cup',description:'Steel cup',bullets:[]};const snapshot=m.snapshot(p);p.copy.title='Later edit';expect(snapshot.title).toBe('Travel cup');expect(m.snapshot({...p,price:'NaN'})).toBeNull();expect(m.snapshot({...p,confirmed:false})).toMatchObject({title:"Later edit",facts:"500 ml"});});
 it('reads only explicit connector acknowledgements, never transport success or prose',()=>{expect(()=>m.unwrap({content:'Published successfully'})).toThrow();expect(()=>m.unwrap({isError:true,content:'{}'})).toThrow();expect(m.unwrap({content:JSON.stringify({provider:'shopify',result:{status:'acknowledged',data:{productCreate:{product:{id:'gid://shopify/Product/1'}}}}})})).toHaveProperty('data.productCreate.product.id');});
 it('keeps generation versions independent and refuses automatic selection of a stale result',()=>{const p=m.product('p');p.revision=2;expect(m.acceptCopy(p,'{"title":"Old","description":"Old","bullets":[]}',1)).toBe(false);expect(p.copy.title).toBe('');expect(p.versions).toHaveLength(1);expect(m.acceptCopy(p,'{"title":"New","description":"New","bullets":["Steel"]}',2)).toBe(true);expect(p.copy.title).toBe('New');expect(m.acceptCopy(p,'I have written the listing.',2)).toBe(false);expect(p.copy.title).toBe('New');});
 it('retains an uncertain creation and reconciles before any second write',async()=>{const p=m.product('p');Object.assign(p,{name:'Cup',sku:'CUP',price:'12',confirmed:true,copy:{title:'Cup',description:'Steel',bullets:[]}});const attempt=m.attempt(p,'shopify-admin','draft');const invoke=async(action:string)=>{if(action==='productCreate')throw new Error('lost receipt');return {data:{products:{nodes:[]}}};};await m.publish(attempt,invoke,async()=>{}).catch(()=>{});expect(attempt.status).toBe('unknown');expect(attempt.step).toBe('create');let writes=0;await expect(m.publish(attempt,async()=>{writes++;return {};},async()=>{})).rejects.toThrow();expect(writes).toBe(0);});
});

it('localizes every registered product locale without missing UI labels',async()=>{
 const fs=await import('node:fs'),vm=await import('node:vm'),path=await import('node:path');const {SUPPORTED_LANGS}=await import('../../src/main/i18n');const window:any={};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../resources/builtin/apps/builtin-product-listing/locales.js'),'utf8'),{window});
 expect(Object.keys(window.ListingLocaleRows).sort()).toEqual([...SUPPORTED_LANGS].sort());for(const locale of SUPPORTED_LANGS){const values=window.ListingLocaleRows[locale].split('|');expect(values,locale).toHaveLength(window.ListingLocaleKeys.length);expect(values.every((v:string)=>v.trim().length>0),locale).toBe(true);}
});
it('uses the frozen Shopify parameter contract for every step and verifies the final store state',async()=>{
 const native=require('../../bin/shopify-business-api.cjs');const p=m.product('new-product');Object.assign(p,{name:'Cup',sku:'CUP',price:'19.90',currency:'USD',confirmed:true,copy:{title:'Travel cup',description:'Steel & glass',bullets:['500 ml']}});const a=m.attempt(p,'shopify-admin','publish','gid://shopify/Publication/1');
 const store:any={id:'gid://shopify/Product/1',handle:a.handle,title:'',status:'DRAFT',descriptionHtml:'',variants:{nodes:[{id:'gid://shopify/ProductVariant/1',sku:'',price:'0.00'}]},media:{nodes:[]}};const mutations:string[]=[];
 const invoke=async(action:string,params:any,risk:string)=>{expect(()=>native.build(action,params),action).not.toThrow();if(risk==='H')mutations.push(action);if(action==='productCreate'||action==='productUpdate'){Object.assign(store,params.arguments.product);return {status:'acknowledged',data:{[action]:{product:structuredClone(store)}}};}if(action==='productVariantsBulkUpdate'){store.variants.nodes[0].price=params.arguments.variants[0].price;store.variants.nodes[0].sku=params.arguments.variants[0].inventoryItem.sku;return {status:'acknowledged',data:{productVariantsBulkUpdate:{productVariants:structuredClone(store.variants.nodes)}}};}if(action==='publishablePublish'){store.publishedOnPublication=true;return {status:'acknowledged',data:{publishablePublish:{publishable:{__typename:'Product'}}}};}return {data:{product:structuredClone(store)}};};
 await m.publish(a,invoke,async()=>{});expect(a.status).toBe('published');expect(store).toMatchObject({title:'Travel cup',status:'ACTIVE',publishedOnPublication:true,variants:{nodes:[{sku:'CUP',price:'19.90'}]}});expect(mutations).toEqual(['productCreate','productVariantsBulkUpdate','productUpdate','publishablePublish']);
});

it('reconciles a created draft without replaying creation and excludes already bound media on a later update',async()=>{
 const p=m.product('stable-product');Object.assign(p,{name:'Cup',sku:'CUP',price:'12',confirmed:true,copy:{title:'Cup',description:'Steel',bullets:[]}});const a=m.attempt(p,'shopify-admin','draft');
 const remote={id:'gid://shopify/Product/1',handle:a.handle,title:'Cup',descriptionHtml:'<p>Steel</p>',status:'DRAFT',variants:{nodes:[{id:'variant-1',price:'0.00',sku:''}]},media:{nodes:[]}};let creates=0;
 await expect(m.publish(a,async(action,params)=>{if(action==='productCreate'){creates++;return {status:'acknowledged',data:{productCreate:{product:remote}}};}throw Error('lost variant receipt');},async()=>{})).rejects.toThrow();
 expect(a.remoteId).toBe(remote.id);expect(a.status).toBe('unknown');await m.reconcile(a,async()=>({data:{product:remote}}),async()=>{});expect(a.status).toBe('partial');expect(creates).toBe(1);
 p.remoteId=remote.id;p.connectorId='shopify-admin';p.assets=[{id:'image-1',selected:true,boundTo:'shopify-admin:'+remote.id}];expect(m.snapshot(p).assets).toEqual([]);
});

it('lists catalog shop connectors across pages while excluding custom MCP and unrelated services',async()=>{
 const pages=[{connectors:[{id:'woocommerce',name:'My store'},{id:'gmail',name:'Shop mail'},{id:'shopify-admin',name:'Second store'}],nextOffset:3},{connectors:[{id:'custom-store',name:'Private store'},{id:'constant-contact',name:'Shop marketing'},{id:'bigcommerce',name:'Third store'}],nextOffset:null}];const offsets:number[]=[];
 expect((await m.storeConnectors(async({offset})=>{offsets.push(offset);return pages[offset===0?0:1];})).map(x=>x.id)).toEqual(['woocommerce','shopify-admin','bigcommerce']);expect(offsets).toEqual([0,3]);
 await expect(m.storeConnectors(async()=>({connectors:[],nextOffset:0}))).rejects.toThrow();
});
it('freezes reviewed store requests for any connector and keeps missing platform-specific fields explicit',()=>{
 const p=m.product('any-store');Object.assign(p,{name:'Cup',connectorId:'custom-store',confirmed:true,channel:'Private shop',currency:''});p.copy={title:'Travel cup',description:'Steel',bullets:[]};
 const request=m.storeRequest(p,'publish');p.copy.title='Later';expect(request).toMatchObject({operation:'publish',connectorId:'custom-store',product:{title:'Travel cup',sku:'',price:'',currency:''}});
 expect(m.storeRequest({...p,confirmed:false},'publish').product.title).toBe('Later');expect(()=>m.storeReview({...p,name:'',copy:{title:'',description:'',bullets:[]}})).toThrow();expect(()=>m.storeRequest({...p,connectorId:''},'import')).toThrow();expect(m.storeRequest({...p,confirmed:false},'import').product).toBeNull();expect(()=>m.storeRequest(p,'delete')).toThrow();
});
it('accepts explicit imported product data and rejects prose and invalid records without fabricating store results',()=>{
 const rows=m.storeProducts('{"products":[{"id":42,"name":"Cup","sku":"","price":12.5,"currency":"EUR","facts":"Steel","title":"Travel cup","description":"500 ml"}]}');expect(rows[0]).toMatchObject({id:'42',price:'12.5',currency:'EUR',sku:''});expect(()=>m.storeProducts('Successfully imported products')).toThrow();expect(()=>m.storeProducts('{"products":[{"name":"Cup"}]}')).toThrow();
});

describe('explicit shops and independent product listings',()=>{
 const shop=(id:string,remoteShopId=id)=>m.storeRecord({id,connectorId:'custom-commerce',remoteShopId,name:id,platform:'Private platform',url:'https://'+id+'.example',region:'EU',currency:'EUR'});
 it('requires an explicit destination and retains multiple shops behind one connector',()=>{
  const a=shop('shop-a'),b=shop('shop-b');expect(a.connectorId).toBe(b.connectorId);expect(a.id).not.toBe(b.id);
  expect(a.capabilities.publish).toBeNull();expect(a.checkedAt).toBeNull();
  expect(()=>m.storeRecord({...a,remoteShopId:''})).toThrow();
  expect(()=>m.storeRecord({...a,url:'https://user:secret@store.example/'})).toThrow();
  expect(()=>m.storeRecord({...a,url:'javascript:alert(1)'})).toThrow();
  expect(()=>m.storeRecord({...a,url:'https://store.example/?token=private'})).toThrow();
  expect(()=>m.addStore([a],{...b,remoteShopId:a.remoteShopId})).toThrow();
  expect(m.addStore([a],b)).toHaveLength(2);
 });
 it('preserves each shop price, copy, language and remote identity across switching and reopening',()=>{
  const p=m.product('cup');Object.assign(p,{name:'Cup',price:'10',currency:'USD',language:'en',copy:{title:'Base cup',description:'Steel',bullets:[]}});
  m.bindStore(p,shop('shop-a'));Object.assign(p,{price:'12',remoteId:'remote-a',language:'de'});p.copy.title='German cup';m.captureListing(p);
  m.bindStore(p,shop('shop-b'));expect(p).toMatchObject({price:'10',currency:'EUR',remoteId:'',language:'en',copy:{title:'Base cup'}});
  Object.assign(p,{price:'20',remoteId:'remote-b'});p.copy.title='Second shop cup';m.captureListing(p);
  const restored=JSON.parse(JSON.stringify(p));m.bindStore(restored,shop('shop-a'));
  expect(restored).toMatchObject({price:'12',remoteId:'remote-a',language:'de',copy:{title:'German cup'}});
  m.bindStore(restored,shop('shop-b'));expect(restored).toMatchObject({price:'20',remoteId:'remote-b',copy:{title:'Second shop cup'}});
 });
 it('preserves legacy bindings and receipts without assuming which shop owns a connector product',()=>{
  const p=m.product('legacy');Object.assign(p,{connectorId:'custom-commerce',remoteId:'legacy-product',price:'9',baseline:{title:'Old'},storeBindings:{other:{remoteId:'other-product'}}});p.attempts=[{requestId:'pending',status:'unknown'}];
  m.bindStore(p,shop('shop-a'));expect(p.remoteId).toBe('');expect(p.legacyListing.remoteId).toBe('legacy-product');
  expect(p.storeBindings.other.remoteId).toBe('other-product');expect(p.attempts).toEqual([{requestId:'pending',status:'unknown'}]);
 });
 it('freezes both the shop and its product content in a reviewed publication',()=>{
  const p=m.product('cup');Object.assign(p,{name:'Cup',confirmed:true});m.bindStore(p,shop('shop-a'));p.copy.title='Cup A';
  const request=m.storeRequest(p,'publish');m.bindStore(p,shop('shop-b'));p.copy.title='Cup B';
  expect(request).toMatchObject({connectorId:'custom-commerce',store:{id:'shop-a',remoteShopId:'shop-a'},product:{title:'Cup A'}});
 });
 it('keeps unverified results unknown and matches store filters against all product bindings',()=>{
  const p=m.product('cup');m.bindStore(p,shop('shop-a'));p.remoteId='a';m.captureListing(p);m.bindStore(p,shop('shop-b'));m.captureListing(p);
  const row=m.productRow(p,'2026-11-10T12:00:00.000Z');expect(m.matchesStore(row,'shop-a')).toBe(true);expect(m.matchesStore(row,'missing')).toBe(false);
  expect(row.listings.every((listing:any)=>listing.state==='unknown')).toBe(true);
  expect(m.matchesStore({id:'old-row',name:'Cup',sku:''},'')).toBe(true);expect(m.matchesStore({id:'old-row'},'shop-a')).toBe(false);
 });
 it('blocks unresolved writes for the same shop while allowing work on another resolved destination',()=>{
  const p=m.product('cup');m.bindStore(p,shop('shop-a'));
  p.attempts=[{execution:'agent',connectorId:'custom-commerce',store:{id:'shop-a'},status:'unknown'}];
  expect(m.pendingStoreWrite(p)).toBe(true);m.bindStore(p,shop('shop-b'));expect(m.pendingStoreWrite(p)).toBe(false);
  p.attempts.push({execution:'agent',connectorId:'custom-commerce',status:'unknown'});expect(m.pendingStoreWrite(p)).toBe(true);
 });
 it('rejects inconsistent shop identities before publishing or restoring a listing',()=>{
  const p=m.product('cup');Object.assign(p,{name:'Cup',confirmed:true});m.bindStore(p,shop('shop-a'));
  p.store.connectorId='other-connection';expect(()=>m.storeRequest(p,'publish')).toThrow();
  p.store=shop('shop-a');m.captureListing(p);m.bindStore(p,shop('shop-b'));
  expect(()=>m.bindStore(p,shop('shop-a','different-shop'))).toThrow();
 });
 it('verifies the original shop without borrowing a remote id from another shop on the same connection',()=>{
  const p=m.product('cup');m.bindStore(p,shop('shop-b'));p.remoteId='remote-b';
  const attempt={connectorId:'custom-commerce',store:shop('shop-a'),snapshot:{name:'Cup A',title:'Cup A',remoteId:'',baseline:null,description:'Steel',bullets:[],assets:[]}};
  const frozen=m.verificationProduct(p,attempt);
  expect(frozen).toMatchObject({storeId:'shop-a',store:{remoteShopId:'shop-a'},remoteId:'',copy:{title:'Cup A'}});
  expect(p).toMatchObject({storeId:'shop-b',remoteId:'remote-b'});
 });
});

describe('commerce import and destination boundaries',()=>{
 it('accepts a full CSV batch without losing quoted facts and rejects an oversized batch',()=>{
  const rows=Array.from({length:500},(_,i)=>`"Cup ${i}, blue",CUP-${i},"Steel\n500 ml"`);
  const input='name,sku,facts\r\n'+rows.join('\r\n');
  const imported=m.csv(input);
  expect(imported).toHaveLength(500);
  expect(imported[0]).toEqual({name:'Cup 0, blue',sku:'CUP-0',facts:'Steel\n500 ml'});
  expect(imported[499].sku).toBe('CUP-499');
  expect(()=>m.csv(input+'\r\nOverflow,CUP-500,Steel')).toThrow();
 });
 it('bounds store imports and rejects the whole malformed response rather than silently importing a partial list',()=>{
  const products=Array.from({length:20},(_,id)=>({id,name:'Cup '+id,sku:'',price:'',currency:'',facts:'',title:'',description:''}));
  expect(m.storeProducts('```json\n'+JSON.stringify({products})+'\n```')).toHaveLength(20);
  expect(()=>m.storeProducts(JSON.stringify({products:[...products,{...products[0],id:20,name:'Overflow'}]}))).toThrow();
  expect(()=>m.storeProducts(JSON.stringify({products:[products[0],{name:'Missing remote identity'}]}))).toThrow();
  expect(m.storeProducts('{"products":[]}')).toEqual([]);
 });
 it('filters remote state within the chosen shop without borrowing another shop state',()=>{
  const row={id:'cup',listings:[{storeId:'eu',state:'published'},{storeId:'us',state:'draft'},{storeId:'new',state:'unknown'}]};
  expect(m.matchesStore(row,'eu','published')).toBe(true);
  expect(m.matchesStore(row,'eu','draft')).toBe(false);
  expect(m.matchesStore(row,'us','published')).toBe(false);
  expect(m.matchesStore(row,'','draft')).toBe(true);
  expect(m.matchesStore(row,'new','unknown')).toBe(true);
  expect(m.matchesStore({id:'legacy'},'','published')).toBe(false);
 });
 it('keeps read-only store requests usable for empty products while blocking missing titles and unsupported operations',()=>{
  const p=m.product('cup');m.bindStore(p,m.storeRecord({id:'eu',connectorId:'custom-commerce',remoteShopId:'shop-eu',name:'EU shop',platform:'Private',url:'',region:'EU',currency:'EUR'}));
  p.remoteId='remote-eu';const before=JSON.stringify(p);
  expect(m.storeRequest(p,'import')).toMatchObject({operation:'import',store:{remoteShopId:'shop-eu'},product:null});
  expect(m.storeRequest(p,'verify')).toMatchObject({operation:'verify',product:{remoteId:'remote-eu',confirmed:false}});
  for(const operation of ['draft','publish','unpublish','delete'])expect(()=>m.storeRequest(p,operation),operation).toThrow();
  expect(JSON.stringify(p)).toBe(before);
 });
});

it('uses a listing title for an unnamed product without overwriting its explicit name',()=>{
 const p=m.product('unnamed');p.copy.title='旅行保温杯';expect(m.productRow(p,'2026-11-12').name).toBe('旅行保温杯');p.name='我的商品名称';expect(m.productRow(p,'2026-11-12').name).toBe('我的商品名称');expect(p.copy.title).toBe('旅行保温杯');
});
it('distinguishes an empty new form from meaningful unnamed legacy data',()=>{
 const p=m.product('draft');expect(m.hasContent(p)).toBe(false);p.name='   ';expect(m.hasContent(p)).toBe(false);
 for(const value of [{facts:'500 ml'},{copy:{title:'Cup',description:'',bullets:[]}},{assets:[{id:'photo'}]},{jobs:[{requestId:'pending'}]},{storeId:'store-a'}])expect(m.hasContent({...m.product('draft'),...value})).toBe(true);
});
