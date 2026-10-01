'use strict';
// Offline, reproducible conversion of current official US and Global models.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const evidence=JSON.parse(fs.readFileSync(path.join(__dirname,'../test/fixtures/connectors/official-contracts/walmart-20261001.json'),'utf8'));
const definitions={},methods={},repairs=[];
const obj=()=>({type:'object',properties:{},required:[],additionalProperties:false});
const allowed=['type','enum','const','required','minimum','maximum','exclusiveMinimum','exclusiveMaximum','multipleOf','minLength','maxLength','pattern','minItems','maxItems','uniqueItems','minProperties','maxProperties','default'];
function availability(raw){
 if(/^(?:US|CA|MX|CL)$/.test(raw?.title||''))return [raw.title.toLowerCase()];
 const text=[raw?.description,raw?.title].filter(Boolean).join(' '),matches=[...text.matchAll(/Market\s+availability\s*:\s*([^<\n)]*)/gi)];
 if(!matches.length)return null;
 return [...new Set(matches.flatMap(m=>/\bGlobal\b/i.test(m[1])?['us','ca','mx','cl']:[...m[1].matchAll(/\b(US|CA|MX|CL)\b/g)].map(v=>v[1].toLowerCase())))];
}
function deref(s,model){if(!s?.$ref)return s;let v=evidence.models[model];for(const k of s.$ref.slice(2).split('/'))v=v[k.replace(/~1/g,'/').replace(/~0/g,'~')];if(!v)throw Error('Missing official reference '+s.$ref);return v;}
function intern(s){const id='s'+crypto.createHash('sha256').update(JSON.stringify(s)).digest('hex').slice(0,24);definitions[id] ||= s;return {$ref:'#/$defs/'+id};}
function convert(raw,model,market,mode,cursor=[]){
 raw=deref(raw,model);if(typeof raw==='boolean')return raw;if(!raw || typeof raw!=='object')throw Error('Invalid schema');
 const input=mode!=='output',s=Object.fromEntries(allowed.filter(k=>Object.hasOwn(raw,k)&&(input||['type','required'].includes(k))).map(k=>[k,raw[k]]));
 for(const [exclusive,bound]of [['exclusiveMinimum','minimum'],['exclusiveMaximum','maximum']])if(typeof s[exclusive]==='boolean'){if(s[exclusive]&&typeof s[bound]==='number'){s[exclusive]=s[bound];delete s[bound];}else delete s[exclusive];}
 if(input&&s.enum&&Object.hasOwn(s,'default')&&!s.enum.includes(s.default)){repairs.push(model+':'+cursor.join('.')+' invalid enum default omitted');delete s.default;}
 if(input&&raw.description)s.description=raw.description.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
 if(raw.properties){
  s.type ||= 'object';s.properties={};
  for(const [key,v]of Object.entries(raw.properties)){
   const markets=availability(v);
   if(input&&(v.readOnly||(markets&&!markets.includes(market))))continue;
   s.properties[key]=convert(v,model,market,mode,[...cursor,key]);
  }
  if(s.required)s.required=s.required.filter(k=>Object.hasOwn(s.properties,k));
  s.additionalProperties=input?raw.additionalProperties===true||Object.keys(raw.properties).length===0:true;
 }
 if(typeof raw.additionalProperties==='object')s.additionalProperties=convert(raw.additionalProperties,model,market,mode,cursor);
 else if(raw.additionalProperties!==undefined)s.additionalProperties=input?raw.additionalProperties:true;
 if(raw.items){s.items=convert(raw.items,model,market,mode,[...cursor,'*']);if(input)s.maxItems=Math.min(raw.maxItems??100,mode==='R'?100:mode==='W'?25:10);}
 for(const kind of ['oneOf','anyOf','allOf'])if(raw[kind]){
  const variants=raw[kind].filter(child=>!input||!availability(child)||availability(child).includes(market));
  // The CL string locale alternative explicitly names Chile in prose but its
  // availability tag omits CL; this exact documented scalar is still applicable.
  if(!variants.length && cursor.at(-1)==='locale'&&market==='cl'&&raw[kind].some(v=>v.type==='string'&&/\bCL\b/.test(v.description||''))){variants.push(raw[kind].find(v=>v.type==='string'));repairs.push(model+':CL locale tag omission');}
  if(!variants.length)throw Error('No market alternatives '+model+' '+cursor.join('.'));
  s[input?kind:kind==='oneOf'?'anyOf':kind]=variants.map(v=>convert(v,model,market,mode,cursor));
 }
 if(!input&&raw.enum){const values=raw.enum.filter(v=>['ERROR','FAIL','FAILURE','PARTIAL','PARTIAL_SUCCESS'].includes(v));if(values.length)s['x-walmart-failure-values']=values;}
 if(raw.not)s.not=convert(raw.not,model,market,mode,cursor);
 if(input&&s.type==='integer'){s.minimum=Math.max(s.minimum??Number.MIN_SAFE_INTEGER,Number.MIN_SAFE_INTEGER);s.maximum=Math.min(s.maximum??Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER);}
 if(!input&&s.type==='integer'&&raw.format==='int64'){delete s.type;s.anyOf=[{type:'integer',minimum:Number.MIN_SAFE_INTEGER,maximum:Number.MAX_SAFE_INTEGER},{type:'string',pattern:'^-?(?:0|[1-9][0-9]*)$'}];s['x-walmart-int64']=true;}
 if(input&&['limit','pageSize','page_size','noOfRecords','numOfRecords','page-size'].includes(cursor.at(-1))){if(['integer','number'].includes(s.type)){s.minimum=Math.max(s.minimum??1,1);s.maximum=Math.min(s.maximum??100,100);}else if(s.type==='string'){s.pattern='^(?:[1-9]|[1-9][0-9]|100)$';s.maxLength=3;}}
 if(input&&s.type==='string')s.maxLength=Math.min(s.maxLength??262144,262144);
 // These are actual feed routing identities, not caller-selected account IDs.
 if(input&&['mart','tenant','businessUnit'].includes(cursor.at(-1))&&/Header$/.test(cursor.at(-2)||''))s.const={us:'WALMART_US',ca:'WALMART_CA',mx:'WALMART_MEXICO',cl:'WALMART_CHILE'}[market];
 if(raw.nullable){const nonnull={...s};return intern({anyOf:[intern(nonnull),{type:'null'}]});}
 if(s.pattern){try{new RegExp(s.pattern,'u');}catch{throw Error('Invalid official regex '+s.pattern);}}
 return intern(s);
}
function shape(s){return s?.$ref?definitions[s.$ref.slice('#/$defs/'.length)]:s;}
function closure(s,ids=new Set()){
 if(!s||typeof s!=='object')return ids;
 if(s.$ref){const id=s.$ref.slice('#/$defs/'.length);if(!ids.has(id)){ids.add(id);closure(definitions[id],ids);}}
 for(const [k,v]of Object.entries(s))if(k!=='$ref')if(Array.isArray(v))v.forEach(x=>closure(x,ids));else closure(v,ids);
 return ids;
}
const fixedHeaders=new Set(['authorization','wm_sec.access_token','wm_qos.correlation_id','wm_svc.name','wm_market','wm_global_version','wm_sandbox','accept','content-type']);
for(const row of evidence.inventory){
 if(row.excluded_reason)continue;
 for(const market of row.markets){
  const model=evidence.models[row.model],pv=model.paths[row.path],op=pv[row.method.toLowerCase()],input=obj(),wire=[],ownedHeaders=[];
  const split=row.path.split('?'),fixedQuery=Object.fromEntries(new URLSearchParams(split[1]||''));
  if(split[0]==='/v3/feeds'&&row.category==='Lag Time')fixedQuery.feedType='lagtime';
  for(let p of [...pv.parameters||[],...op.parameters||[]]){
   p=deref(p,row.model);const markets=availability(p);if(markets&&!markets.includes(market))continue;
   if(p.in==='header'){
    if(fixedHeaders.has(p.name.toLowerCase())){ownedHeaders.push(p.name.toLowerCase());continue;}
    if(p.required)throw Error('Unreviewed required header '+row.action+' '+p.name);
    // Optional partner/channel identity headers do not belong to the seller grant.
    if(['wm_consumer.channel.type','wm_partner.id','wm_partner_id','loggedinuser'].includes(p.name.toLowerCase()))continue;
   }
   if(!['path','query','header'].includes(p.in))throw Error('Unsupported parameter location');
   if(p.in==='query'&&Object.hasOwn(fixedQuery,p.name))continue;
   const group=input.properties[p.in] ||= obj();let s=structuredClone(shape(convert({...p.schema,description:p.description||p.schema?.description},row.model,market,row.risk,[p.in,p.name])));
   if(p.in==='header'){s.maxLength=512;s.pattern='^[^\\r\\n\\x00]*$';if(p.name==='FORMAT')s.enum=['ZIP','PDF','ZPL'];}
   if(p.in==='query'&&['limit','pageSize','page_size','noOfRecords','numOfRecords','page-size'].includes(p.name)){
    if(s.type==='integer'||s.type==='number'){s.minimum=Math.max(s.minimum??1,1);s.maximum=Math.min(s.maximum??100,100);s.default=Math.min(typeof s.default==='number'&&s.default>0?s.default:20,s.maximum);}
    else if(s.type==='string'){s.pattern='^(?:[1-9]|[1-9][0-9]|100)$';s.maxLength=3;s.default=String(Math.min(Number(s.default)||20,100));}
   }
   group.properties[p.name]=s;if(p.required){group.required.push(p.name);if(!input.required.includes(p.in))input.required.push(p.in);}
   wire.push({name:p.name,location:p.in,style:p.style||(p.in==='query'?'form':'simple'),explode:p.explode??(p.in==='query'&&(!p.style||p.style==='form')),default:s.default});
  }
  if(op.requestBody){const body=deref(op.requestBody,row.model);input.properties.body=convert(body.content['application/json'].schema,row.model,market,row.risk,['body']);if(body.required)input.required.push('body');}
  const responses={};for(const [status,r]of Object.entries(op.responses||{}))if(/^2\d\d$/.test(status)){
   const response=deref(r,row.model);if(status==='204'||!response.content)responses[status]=null;
   else if(response.content['application/json']?.schema)responses[status]=convert(response.content['application/json'].schema,row.model,market,'output');
  }
  if(!Object.keys(responses).length)throw Error('No authoritative response '+row.action);
  const errorPaths=[],failPaths=[],pendingPaths=[];
  function inspect(s,cursor=[],seen=new Set()){
   if(!s||typeof s!=='object')return;
   if(s.$ref){const id=s.$ref.slice('#/$defs/'.length);if(seen.has(id))return;inspect(definitions[id],cursor,new Set([...seen,id]));return;}
   for(const k of ['oneOf','anyOf','allOf'])for(const v of s[k]||[])inspect(v,cursor,seen);
   if(s.items)inspect(s.items,[...cursor,'*'],seen);
   for(const [k,v]of Object.entries(s.properties||{})){
    if(['errors','error','ingestionErrors','ingestionError'].includes(k)){errorPaths.push([...cursor,k]);continue;}
    const failureValues=shape(v)?.['x-walmart-failure-values'];if(failureValues)failPaths.push({path:[...cursor,k],kind:'values',values:failureValues});
    if(['itemsFailed','errorCount'].includes(k))failPaths.push({path:[...cursor,k],kind:'positive'});
    if(['feedStatus','requestStatus','ingestionStatus'].includes(k)){failPaths.push({path:[...cursor,k],kind:'values',values:['ERROR','DATA_ERROR','SYSTEM_ERROR','TIMEOUT_ERROR']});pendingPaths.push({path:[...cursor,k],values:['RECEIVED','INPROGRESS']});}
    inspect(v,[...cursor,k],seen);
   }
  }
  Object.values(responses).forEach(s=>inspect(s));
  const key=market+' '+row.action;if(methods[key])throw Error('Duplicate action '+key);
  methods[key]={action:row.action,market,method:row.method,path:split[0],risk:row.risk,operation:row.operation,
   description:row.summary+'. '+(row.requirements||[]).join(' ')+' '+(row.risk==='R'?'One explicit page; no automatic pagination.':'Acknowledgement only; reconcile resource or feed status before retrying uncertain writes.')+' '+row.source_url,
   environments:row.environments||['live','sandbox'],input_schema:input,input_definitions:[...closure(input)],responses,response_definitions:[...new Set(Object.values(responses).flatMap(v=>[...closure(v)]))],wire,fixed_query:fixedQuery,owned_headers:ownedHeaders,error_paths:errorPaths,failure_paths:failPaths,pending_paths:pendingPaths,async:row.risk!=='R'&&(split[0]==='/v3/feeds'||split[0]==='/v3/repricerFeeds'||row.operation==='generateReport')};
 }
}
const data={documentation_snapshot:evidence.documentation_snapshot,methods,definitions,source_repairs:[...new Set(repairs)]};
fs.writeFileSync(path.join(__dirname,'../bin/walmart-api-contracts.cjs'),"'use strict';\n// Generated from pinned official Walmart market-specific OpenAPI contracts.\nmodule.exports = "+JSON.stringify(data)+';\n');
console.log(JSON.stringify({contracts:Object.keys(methods).length,definitions:Object.keys(definitions).length,repairs:data.source_repairs}));
