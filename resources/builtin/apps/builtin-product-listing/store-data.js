/* Deterministic read adapters and durable entry-triggered cache. No model calls. */
(function(root){
 'use strict';
 const providers=Object.freeze({'shopify-admin':'shopify',woocommerce:'woocommerce',bigcommerce:'bigcommerce',shopline:'shopline',shoplazza:'shoplazza','etsy-seller':'etsy','amazon-seller-central':'amazon_seller','ebay-seller':'ebay','walmart-marketplace':'walmart',shopee:'shopee','tiktok-shop':'tiktok_shop','mercado-libre-global-selling':'mercado_libre','taobao-tmall-seller':'taobao_top','alibaba-1688-seller':'alibaba_1688','jd-seller':'jd_jos','pinduoduo-seller':'pinduoduo','douyin-shop-seller':'douyin_shop','kuaishou-shop-seller':'kuaishou_shop','youzan-seller':'youzan','weimob-wos-seller':'weimob_wos','xiaohongshu-seller':'xiaohongshu_ark','lightspeed-x':'lightspeed'});
 const supported=id=>Object.hasOwn(providers,id);
 const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
 const text=value=>typeof value==='string'?value.trim().slice(0,512):typeof value==='number'&&Number.isSafeInteger(value)?String(value):'';
 function safeUrl(value){try{const url=new URL(value);if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)return '';return url.href.replace(/\/$/,'');}catch{return '';}}
 function shops(connection,body){
  if(!supported(connection.id)||!object(body)||body.provider!==providers[connection.id]||!object(body.identity))throw Error('STORE_IDENTITY');
  const identity=body.identity,provider=body.provider,result=[];
  const add=(id,name,currency,url='',region='')=>{
   id=text(id);name=text(name);if(!id||!name)throw Error('STORE_IDENTITY');
   if(result.some(row=>row.remoteShopId===id))throw Error('STORE_IDENTITY');
   result.push({connectorId:connection.id,connectionName:connection.name,remoteShopId:id,name,platform:provider,url:safeUrl(url),region:text(region),currency:/^[A-Z]{3}$/.test(currency)?currency:''});
  };
  if(provider==='shopify'){const s=identity.shop; if(!object(s))throw Error('STORE_IDENTITY');add(s.id,s.name,s.currencyCode,s.myshopifyDomain?'https://'+s.myshopifyDomain:'');}
  else if(provider==='woocommerce'){
   const url=safeUrl(identity.store_url);if(!url)throw Error('STORE_IDENTITY');add(url,new URL(url).hostname,identity.currency,url);
  }
  else if(['bigcommerce','shopline','shoplazza'].includes(provider))add(identity.shop_id,identity.name,identity.currency,provider==='bigcommerce'?'':'https://'+text(identity.binding));
  else if(provider==='etsy')add(identity.shop_id,identity.shop_name,identity.currency_code,identity.url);
  else if(provider==='amazon_seller'){
   const rows=identity.participations?.payload;if(!Array.isArray(rows)||rows.length>100)throw Error('STORE_IDENTITY');
   for(const row of rows)if(row.participation?.isParticipating===true)add(text(identity.seller_id)+':'+text(row.marketplace?.id),row.marketplace?.name,row.marketplace?.defaultCurrencyCode,'',row.marketplace?.countryCode);
  }
  // Unsupported identity shapes stay explicit; never substitute an account name.
  else throw Error('STORE_UNSUPPORTED');
  return result;
 }
 function tabs(stores,locale){const ordered=[...stores].sort((a,b)=>a.name.localeCompare(b.name,locale,{sensitivity:'base'})||a.id.localeCompare(b.id));return ordered.length>1?[{id:'',name:''},...ordered]:ordered;}
 function daysAt(now){const end=new Date(now).toISOString().slice(0,10);return Array.from({length:30},(_,i)=>({date:new Date(Date.parse(end+'T00:00:00Z')-(29-i)*86400000).toISOString().slice(0,10),sales:0,units:0}));}
 function amount(raw){if(typeof raw!=='string'||!(/^-?\d+(\.\d{1,6})?$/).test(raw))throw Error('STORE_METRICS');const value=Number(raw);if(!Number.isFinite(value)||Math.abs(value)>1e12)throw Error('STORE_METRICS');return value;}
 async function metrics(store,read,now){
  if(store.connectorId!=='shopify-admin')return null;
  const days=daysAt(now),byDate=new Map(days.map(row=>[row.date,row])),seen=new Set(),cursors=new Set();let after;
  const money=[{field:'shopMoney',children:[{field:'amount'},{field:'currencyCode'}]}];
  for(let page=0;page<10;page++){
   const result=await read('orders',{arguments:{first:100,...(after?{after}:{}),query:'created_at:>='+days[0].date+'T00:00:00Z created_at:<='+new Date(now).toISOString()},selection:[{field:'nodes',children:[{field:'id'},{field:'createdAt'},{field:'cancelledAt'},{field:'test'},{field:'currentSubtotalLineItemsQuantity'},{field:'currentSubtotalPriceSet',children:money}]},{field:'pageInfo',children:[{field:'hasNextPage'},{field:'endCursor'}]}]});
   const orders=result?.data?.orders;
   if(!Array.isArray(orders?.nodes)||orders.nodes.length>100||typeof orders.pageInfo?.hasNextPage!=='boolean')throw Error('STORE_METRICS');
   for(const order of orders.nodes){
    if(typeof order.id!=='string'||seen.has(order.id)||typeof order.test!=='boolean'||!(order.cancelledAt===null||typeof order.cancelledAt==='string'))throw Error('STORE_METRICS');seen.add(order.id);
    if(order.test||order.cancelledAt)continue;
    const timestamp=Date.parse(order.createdAt);if(!Number.isFinite(timestamp)||timestamp>now)throw Error('STORE_METRICS');
    const day=byDate.get(new Date(timestamp).toISOString().slice(0,10));if(!day)throw Error('STORE_METRICS');
    const price=order.currentSubtotalPriceSet?.shopMoney,quantity=order.currentSubtotalLineItemsQuantity;
    if(price?.currencyCode!==store.currency||!Number.isSafeInteger(quantity)||quantity<0)throw Error('STORE_METRICS');
    day.sales+=amount(price.amount);day.units+=quantity;
   }
   if(!orders.pageInfo.hasNextPage)return {currency:store.currency,days,asOf:new Date(now).toISOString(),timezone:'UTC'};
   const cursor=orders.pageInfo.endCursor;if(typeof cursor!=='string'||!cursor||cursors.has(cursor))throw Error('STORE_METRICS');cursors.add(cursor);after=cursor;
  }
  throw Error('STORE_LIMIT');
 }
 function totals(reports,today){const sales={},todaySales={};let units=0,todayUnits=0;for(const report of reports){for(const day of report.days){sales[report.currency]=(sales[report.currency]||0)+day.sales;units+=day.units;if(day.date===today){todaySales[report.currency]=(todaySales[report.currency]||0)+day.sales;todayUnits+=day.units;}}}return {sales,todaySales,units,todayUnits};}
 function validReport(report){
  if(!object(report)||!/^[A-Z]{3}$/.test(report.currency)||report.timezone!=='UTC'||!Number.isFinite(Date.parse(report.asOf))||!Array.isArray(report.days)||report.days.length!==30)return false;
  const end=Date.parse(report.asOf.slice(0,10)+'T00:00:00Z');
  return report.days.every((day,i)=>object(day)&&day.date===new Date(end-(29-i)*86400000).toISOString().slice(0,10)&&typeof day.sales==='number'&&Number.isFinite(day.sales)&&Math.abs(day.sales)<=1e15&&Number.isSafeInteger(day.units)&&day.units>=0);
 }
 function createCache({initial=null,read,save,now=Date.now}){
  const initialState=initial??{version:1,entries:{}};
  if(!object(initialState)||initialState.version!==1||!object(initialState.entries)||Object.keys(initialState.entries).length>128||JSON.stringify(initialState).length>524288)throw Error('STORE_CACHE');
  const state=structuredClone(initialState),running=new Map();let writes=Promise.resolve();
  for(const [id,row]of Object.entries(state.entries))if(!validKey(id)||!object(row)||![row.lastAttempt,row.lastSuccess].every(value=>Number.isFinite(value)&&value>=0)||!(row.data===null||object(row.data)))throw Error('STORE_CACHE');
  function validKey(id){return typeof id==='string'&&/^[a-zA-Z0-9:_-]{1,100}$/.test(id)&&!['__proto__','constructor','prototype'].includes(id);}
  const get=id=>Object.hasOwn(state.entries,id)?structuredClone(state.entries[id]):null;
  const persist=()=>{const snapshot=structuredClone(state);if(JSON.stringify(snapshot).length>524288)throw Error('STORE_CACHE');const next=writes.catch(()=>{}).then(()=>save(snapshot));writes=next;return next;};
  async function refresh(id,manual=false){
   if(!validKey(id))throw Error('STORE_CACHE');
   if(running.has(id))return running.get(id);
   const previous=get(id),time=now(),elapsed=previous?time-Math.max(previous.lastAttempt,previous.lastSuccess):Infinity;
   if(!manual&&elapsed>=0&&elapsed<60000)return previous.data;
   if(!previous&&Object.keys(state.entries).length>=128)throw Error('STORE_CACHE');
   const job=(async()=>{
    state.entries[id]={lastAttempt:time,lastSuccess:previous?.lastSuccess||0,data:previous?.data??null};
    try{await persist();}catch(error){if(previous)state.entries[id]=previous;else delete state.entries[id];throw error;}
    let data;
    try {data=await read(id);if(!object(data))throw Error('STORE_CACHE');}
    catch(error){state.entries[id]={lastAttempt:now(),lastSuccess:previous?.lastSuccess||0,data:previous?.data??null,failed:true};await persist();throw error;}
    const updated={lastAttempt:time,lastSuccess:now(),data:structuredClone(data),failed:false};
    state.entries[id]=updated;
    try{await persist();}catch(error){state.entries[id]={lastAttempt:time,lastSuccess:previous?.lastSuccess||0,data:previous?.data??null};throw error;}
    return structuredClone(data);
   })();running.set(id,job);
   try{return await job;}finally{running.delete(id);}
  }
  return {get,refresh};
 }
 const api={providers,supported,shops,tabs,metrics,totals,validReport,createCache};
 if(typeof module==='object'&&module.exports)module.exports=api;else root.ListingStoreData=api;
})(typeof window==='object'?window:globalThis);
