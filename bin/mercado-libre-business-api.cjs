'use strict';
const {requestFetch,requestFailureCode,httpFailure}=require('./commerce-request-context.cjs');
const {readBody}=require('./storefront-admin-api.cjs');
let contracts,validator,actionCache;const schemas=new Map(),checks=new Map();
const source=()=>contracts ||= require('./mercado-libre-api-contracts.cjs');
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const shape=s=>s?.$ref?source().definitions[s.$ref.slice(8)]:s;
function schema(row){if(!schemas.has(row.action))schemas.set(row.action,{...row.input_schema,$defs:Object.fromEntries(row.input_definitions.map(k=>[k,source().definitions[k]]))});return schemas.get(row.action);}
function isNative(name){return Object.hasOwn(source().methods,name);}
function scope(config){return String(config.credentials?.scope||'').split(/\s+/).filter(Boolean);}
function actionsFor(config){if(config.provider!=='mercado_libre')fail('E_BAD_INPUT','Invalid Global Selling provider');if(config.credentials?.identity?.site_id&&config.credentials.identity.site_id!=='CBT')return {};
 if(!actionCache)actionCache=Object.fromEntries(Object.values(source().methods).map(r=>[r.action,{risk:r.risk,description:r.description,input_schema:schema(r)}]));
 const scopes=scope(config);return scopes.length?Object.fromEntries(Object.entries(actionCache).filter(([,r])=>scopes.includes(r.risk==='R'?'read':'write'))):actionCache;
}
function check(s,v){if(!validator){const {AjvJsonSchemaValidator}=require('@modelcontextprotocol/sdk/validation/ajv');validator=new AjvJsonSchemaValidator();}let f=checks.get(s);if(!f){f=validator.getValidator(s);checks.set(s,f);}if(!f(v).valid)fail('E_BAD_INPUT','Invalid Global Selling parameters; use the described fields and bounds');}
function integer(v){if(typeof v==='number'){if(!Number.isSafeInteger(v)||v<1)fail('E_BAD_INPUT','Use an exact decimal string for a large identifier');return String(v);}if(!/^[1-9][0-9]{0,19}$/.test(v)||BigInt(v)>9223372036854775807n)fail('E_BAD_INPUT','Identifier exceeds the supported positive signed 64-bit range');return v;}
function encode(v,s){s=shape(s);if(s?.['x-mercado-integer'])return integer(v);if(s?.oneOf||s?.anyOf){const candidate=(s.oneOf||s.anyOf).find(x=>{x=shape(x);return Array.isArray(v)?x.type==='array':object(v)?x.type==='object':typeof v===x.type;});if(candidate)s=shape(candidate);}
 if(Array.isArray(v))return '['+v.map(x=>encode(x,s?.items)).join(',')+']';if(object(v))return '{'+Object.entries(v).map(([k,x])=>JSON.stringify(k)+':'+encode(x,s?.properties?.[k])).join(',')+'}';return JSON.stringify(v);
}
function segment(v){let decoded=String(v);for(let i=0;i<3;i++){let n;try{n=decodeURIComponent(decoded);}catch{break;}if(n===decoded)break;decoded=n;}if(!decoded||decoded==='.'||decoded==='..'||/[\\/\u0000-\u001f\u007f]/.test(decoded))fail('E_BAD_INPUT','Invalid resource identifier');return encodeURIComponent(String(v));}
function bounded(value,code='E_BAD_INPUT'){const queue=[[value,0]],seen=new Set();let nodes=0;while(queue.length){const [v,depth]=queue.pop();if(++nodes>50000||depth>40)fail(code,'Global Selling JSON exceeds the structural bound');if(typeof v==='number'&&!Number.isFinite(v))fail(code,'Non-finite JSON number');if(v&&typeof v==='object'){if(seen.has(v))fail(code,'Cyclic Global Selling JSON');seen.add(v);if(Object.keys(v).length>1000)fail(code,'Global Selling JSON object exceeds the structural bound');for(const x of Object.values(v))queue.push([x,depth+1]);}}}
function binding(config){const c=config.credentials,m=config.metadata?.user_id;if(config.provider!=='mercado_libre'||!c||!/^\d{1,19}$/.test(String(m))||String(c.identity?.user_id)!==String(m))fail('E_TOOL_CALL_AUTH','Global Selling main merchant binding does not match');if(c.identity.site_id&&c.identity.site_id!=='CBT')fail('E_TOOL_CALL_AUTH','Use a verified Global Selling CBT main merchant grant');return String(m);}
// Unknown unsafe numbers remain exact text. Documented floating point amount fields remain numbers.
const floats=new Set(['price','global_net_proceeds','net_proceeds','min_price','max_price','amount','total_amount','unit_price','full_unit_price','sale_fee','base_exchange_rate','percent_change','usd_price','cost','budget','roas_target','rating_average','number','percentage','rate']);
function parse(text){let depth=0,quoted=false,escape=false;for(const c of text){if(quoted){if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')quoted=false;}else if(c==='"')quoted=true;else if(c==='{'||c==='['){if(++depth>40)throw Error('Provider JSON depth');}else if(c==='}'||c===']')depth--;}return JSON.parse(text,(key,value,context)=>{if(typeof value!=='number')return value;if(!Number.isFinite(value))throw Error('Non-finite provider number');if(context?.source&&Math.abs(value)>Number.MAX_SAFE_INTEGER&&!floats.has(key))return context.source;return value;});}
function nonempty(v){return v!==null&&v!==undefined&&v!==false&&v!==''&&(Array.isArray(v)?v.length>0:object(v)?Object.keys(v).length>0:true);}
function statusOf(value,row,http){const state={failed:http===206,pending:false};
 if(row.receipt==='up'){
  const rows=Array.isArray(value)?value:[value];
  for(const item of rows){const parts=[item,...(item.listing_sites||[]),...(item.locations||[]),...(item.variants||[]),...(item.site_items||[])];
   for(const part of parts){if(part.success===false||nonempty(part.errors)||nonempty(part.error))state.failed=true;if(nonempty(part.task_id))state.pending=true;for(const nested of [...(part.listing_sites||[]),...(part.locations||[])]){if(nested.success===false||nonempty(nested.errors)||nonempty(nested.error))state.failed=true;if(nonempty(nested.task_id))state.pending=true;}}
  }
 }else if(row.receipt==='task'){
  state.pending=['pending','processing'].includes(value.status);for(const v of value.user_products||[]){if(v.status==='failed')state.failed=true;if(['pending','processing'].includes(v.status))state.pending=true;}
 }else if(row.receipt==='suggestions'){
  for(const process of value.processes||[value])if(process.status==='in_progress')state.pending=true;for(const global of value.global_items||[])for(const site of global.marketplace_items||[]){if(site.status==='error')state.failed=true;if(site.status==='in_progress')state.pending=true;}
  for(const v of Array.isArray(value)?value:value.items||value.results||[]){if(v.success===false||nonempty(v.error)||nonempty(v.errors))state.failed=true;for(const site of v.suggestions||[]){if(site.success===false||nonempty(site.error)||nonempty(site.errors))state.failed=true;}}
 }else if(row.receipt==='multiget'){for(const v of Array.isArray(value)?value:[])if(Number(v.code)>=400)state.failed=true;
 }else if(row.receipt==='ad_bulk'){
  for(const v of Array.isArray(value)?value:value.results||value.ad_groups||[]){if(v.success===false||nonempty(v.error)||nonempty(v.errors)||Number(v.code)>=400)state.failed=true;}
 }
 return state;
}
function acknowledge(data,row,http,p){if(row.ack_dynamic_key)return object(data)&&(p.query?.[row.ack_dynamic_key]||[]).every(k=>Object.hasOwn(data,k)&&typeof data[k]==='number');if(row.ack_http)return row.ack_http.includes(http);if(row.ack_message)return object(data)&&typeof data.message==='string'&&data.message.startsWith(row.ack_message);if(row.ack_values)return object(data)&&Object.entries(row.ack_values).every(([k,values])=>values.includes(data[k]));if(!object(data)&&!Array.isArray(data))return false;if(Array.isArray(data))return row.ack_array!==false&&data.every(v=>object(v)||typeof v==='string'||typeof v==='number');if(!Object.keys(data).length)return Boolean(row.empty_ack);if(row.resource_key)return Array.isArray(data[row.resource_key]);return row.ack_keys?.some(k=>{if(!Object.hasOwn(data,k)||data[k]===null||data[k]===undefined)return false;const v=data[k];if(/(?:^id$|_id$)/.test(k))return (typeof v==='string'&&v.length>0)||(typeof v==='number'&&Number.isFinite(v));if(['results','items','user_products','variants','listing_sites','advertisers','messages','processes','marketplaces','dates','rows','available','rules','global_items','order_items'].includes(k))return Array.isArray(v)||k==='available'&&typeof v==='boolean';return typeof v==='object'||typeof v==='boolean'||typeof v==='number'||typeof v==='string'&&v.length>0;});}
const secretKeys=new Set(['accesstoken','refreshtoken','clientsecret','authorization','cookie','password']);
function clean(v,secrets,diagnostic=false){if(typeof v==='string')return secrets.reduce((t,s)=>s?t.split(s).join('[redacted]'):t,v);if(Array.isArray(v))return v.map(x=>clean(x,secrets,diagnostic));if(!object(v))return v;const out={};for(const[k,x]of Object.entries(v)){if(secretKeys.has(k.replace(/[_-]/g,'').toLowerCase()))continue;if(diagnostic&&['message','description','reason','stack','trace'].includes(k))continue;out[k]=clean(x,secrets,diagnostic||['error','errors','cause','reasons'].includes(k));}return out;}
async function execute(config,name,p={},owners={}){
 const row=source().methods[name];if(!row)fail('E_BAD_INPUT','Unsupported Global Selling action');const main=binding(config);bounded(p);
 let size;try{size=Buffer.byteLength(JSON.stringify(p));}catch{fail('E_BAD_INPUT','Invalid Global Selling JSON parameters');}if(size>262144)fail('E_BAD_INPUT','Global Selling request exceeds 256 KiB');check(schema(row),p);
 const knownScopes=scope(config);if(knownScopes.length&&!knownScopes.includes(row.risk==='R'?'read':'write'))fail('E_TOOL_CALL_AUTH','Reauthorize this merchant with the required business scope');
 let body=p.body;const input=shape(row.input_schema);
 if(row.risk!=='R'&&body&&object(body)&&!Object.keys(body).length&&!row.empty_ack)fail('E_BAD_INPUT','A write must include a business change');
 const impacts=Array.isArray(body)?body.reduce((n,v)=>n+(v.sites_to_sell?.length||v.suggestions?.length||1),0):body?.variants?body.variants.reduce((n,v)=>n+(v.listing_sites?.length||v.locations?.length||1),0):body?.sites_to_sell?.length||body?.listing_sites?.length||body?.locations?.length||1;
 if(row.risk!=='R'&&impacts>10)fail('E_BAD_INPUT','Review at most ten explicitly targeted business entities per write');
 if(body?.min_price!==undefined&&body?.max_price!==undefined&&body.min_price>body.max_price)fail('E_BAD_INPUT','Minimum price exceeds maximum price');
 if(row.source_page==='visits'&&p.query?.date_from){const a=Date.parse(p.query.date_from),b=Date.parse(p.query.date_to);if(!Number.isFinite(a)||!Number.isFinite(b)||b<a||b-a>150*86400000)fail('E_BAD_INPUT','Visit dates must be ordered and span at most 150 days');}
 if(row.advertising&&p.query){const q=p.query;if(q.metrics&&(!q.date_from||!q.date_to))fail('E_BAD_INPUT','Metrics require both date bounds');if(q.date_from||q.date_to){const a=Date.parse(q.date_from),b=Date.parse(q.date_to);if(!Number.isFinite(a)||!Number.isFinite(b)||b<a||b-a>90*86400000)fail('E_BAD_INPUT','Advertising metrics require an ordered date range of at most 90 days');}if(row.path.endsWith('/ad_groups/metrics')&&q.date_from!==q.date_to&&!q['filters[ad_group_ids]'])fail('E_BAD_INPUT','A multi-day campaign range requires explicit Ad Group filters');}
 let route=row.path.replace('{bound_user_id}',segment(main));for(const[k,v]of Object.entries(p.path||{}))route=route.replace('{'+k+'}',segment(v));if(/[{}]/.test(route))fail('E_BAD_INPUT','Missing resource identifier');
 const query=new URLSearchParams();for(const[k,v]of Object.entries(p.query||{}))query.set(k,Array.isArray(v)?v.join(','):String(v));for(const[k,s]of Object.entries(input.properties?.query?.properties||{}))if(!query.has(k)&&s.default!==undefined)query.set(k,String(s.default));for(const[k,v]of Object.entries(row.owned_query||{}))query.set(k,v==='main'?main:v);for(const[k,v]of Object.entries(row.fixed_query||{}))query.set(k,v);
 if(row.owned_body)body={...body,...Object.fromEntries(Object.entries(row.owned_body).map(([k,v])=>[k,v==='main'?main:v]))};
 let bodyText=body===undefined?undefined:encode(body,input.properties?.body);if(row.owned_body?.seller_id==='main')bodyText=bodyText.replace('"seller_id":'+JSON.stringify(main),'"seller_id":'+main);
 if(bodyText&&Buffer.byteLength(bodyText)>262144)fail('E_BAD_INPUT','Global Selling body exceeds 256 KiB');
 if(typeof owners.token!=='function')fail('E_TOOL_CALL_AUTH','Global Selling token owner is unavailable');let token;try{token=await owners.token(config);}catch(e){if(requestFailureCode(e)==='E_TOOL_CALL_CANCELLED')fail('E_TOOL_CALL_CANCELLED','Global Selling authorization was cancelled');throw e;}binding(config);const freshScopes=scope(config);if(freshScopes.length&&!freshScopes.includes(row.risk==='R'?'read':'write'))fail('E_TOOL_CALL_AUTH','The refreshed merchant grant lacks the required scope');
 const deadline=AbortSignal.timeout(60000),headers={accept:'application/json','content-type':'application/json',authorization:'Bearer '+token,...row.headers};
 async function call(pathname,method='GET',payload,extraHeaders={}){let response;try{response=await requestFetch('https://api.mercadolibre.com'+pathname,{method,headers:{...headers,...extraHeaders},redirect:'error',signal:deadline,...(payload===undefined?{}:{body:payload})});}catch(e){fail(requestFailureCode(e,deadline),'Global Selling request failed; reconcile an uncertain write before retrying');}
  if(!response.ok)throw httpFailure(response.status,'Global Selling request failed (HTTP '+response.status+')');let text;try{text=await readBody(response);}catch(e){fail(e?.code==='E_CONNECTOR_RESPONSE_TOO_LARGE'?'E_TOOL_CALL_UPSTREAM':requestFailureCode(e,deadline),'Global Selling response could not be read');}let data;try{data=text.trim()?parse(text):{};bounded(data,'E_TOOL_CALL_UPSTREAM');}catch{fail('E_TOOL_CALL_UPSTREAM','Global Selling returned invalid JSON');}return {data,http:response.status};
 }
 if(!config.credentials.identity.site_id){const {data}=await call('/users/me');if(String(data.id)!==main||data.site_id!=='CBT')fail('E_TOOL_CALL_AUTH','The current grant is not verified as this Global Selling main merchant');}
 if(row.child_query?.length||row.child_path?.length){const {data}=await call('/marketplace/users/'+segment(main));if(String(data.user_id)!==main||data.site_id!=='CBT'||!Array.isArray(data.marketplaces))fail('E_TOOL_CALL_AUTH','Global Selling returned a mismatched main marketplace mapping');for(const [part,keys]of [['query',row.child_query||[]],['path',row.child_path||[]]])for(const key of keys){const target=String(p[part]?.[key]);if(!data.marketplaces.some(v=>String(v.user_id)===target))fail('E_BAD_INPUT','The requested marketplace seller is not owned by this main merchant');}}
 if(row.advertising){
  const {data:grant}=await call('/advertising/advertisers?product_id='+row.advertising,'GET',undefined,{'Api-Version':'1'});
  if(!Array.isArray(grant.advertisers))fail('E_TOOL_CALL_AUTH','The merchant grant has no verified advertising account');
  const authorized=(aid,site)=>grant.advertisers.some(v=>String(v.advertiser_id)===String(aid)&&(!site||v.site_id===site));
  let current=p.path?.advertiser_id;const site=p.path?.site_id;
  if(current){if(!authorized(current,site))fail('E_BAD_INPUT','The advertiser is not authorized under this merchant grant');}
  else if(p.path?.campaign_id){const {data:campaign}=await call('/marketplace/advertising/'+segment(site)+'/product_ads/campaigns/'+segment(p.path.campaign_id));current=campaign.advertiser_id;if(!current||!authorized(current,site))fail('E_TOOL_CALL_AUTH','Campaign advertiser does not match this merchant grant');}
  else if(p.path?.ad_group_id){const {data:group}=await call('/marketplace/advertising/'+segment(site)+'/product_ads/ad_groups/'+segment(p.path.ad_group_id));current=group.advertiser_id;if(!current||!authorized(current,site))fail('E_TOOL_CALL_AUTH','Ad Group advertiser does not match this merchant grant');}
  if(body?.campaign_id!==undefined){const {data:target}=await call('/marketplace/advertising/'+segment(site)+'/product_ads/campaigns/'+segment(body.campaign_id));if(String(target.advertiser_id)!==String(current))fail('E_BAD_INPUT','Destination campaign belongs to a different advertiser');}
 }
 const {data,http}=await call(route+(query.size?'?'+query:''),row.method,bodyText);
 if(['/users/me','/users/{bound_user_id}'].includes(row.path)&&(String(data?.id)!==main||data?.site_id!=='CBT')||row.path==='/marketplace/users/{bound_user_id}'&&(String(data?.user_id)!==main||data?.site_id!=='CBT'))fail('E_TOOL_CALL_AUTH','The returned merchant identity does not match the bound Global Selling main account');
 if(!object(data)&&!Array.isArray(data))fail('E_TOOL_CALL_UPSTREAM','Global Selling returned an invalid business response');
 if(object(data)&&!Object.keys(data).length&&!row.empty_ack)fail('E_TOOL_CALL_UPSTREAM','Global Selling omitted its business acknowledgement');
 if(!acknowledge(data,row,http,p))fail('E_TOOL_CALL_UPSTREAM','Global Selling omitted the documented business resource or acknowledgement');
 const state=statusOf(data,row,http);
 if(object(data)&&nonempty(data.error)&&!row.business_error_resource&&!['listing_sites','variants','results','items'].some(k=>Array.isArray(data[k])))fail('E_TOOL_CALL_UPSTREAM','Global Selling rejected the business operation');
 const result=clean(data,[token,config.credentials.refresh_token,config.credentials.client_secret]);
 return {data:result,...(state.failed?{status:'partial_or_failed'}:state.pending||row.risk!=='R'?{status:'accepted'}:{}),...(state.pending||row.risk!=='R'?{follow_up:'Inspect each returned resource and task before retrying. Acknowledgement is not proof that asynchronous work completed; failed entities are never replayed automatically.'}:{})};
}
module.exports={actionsFor,isNative,execute};
