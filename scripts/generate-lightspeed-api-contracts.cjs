'use strict';
// Reproducible, offline conversion of the pinned official X-Series OpenAPI.
const fs=require('node:fs'),path=require('node:path');
const evidence=JSON.parse(fs.readFileSync(path.join(__dirname,'../test/fixtures/connectors/official-contracts/lightspeed-20261001.json'),'utf8')),model=evidence.model,rawDefs=model.components.schemas;
const deref=raw=>raw?.$ref?raw.$ref.split('/').slice(1).reduce((o,k)=>o[k],model):raw;
const keys=['type','enum','required','minimum','maximum','exclusiveMinimum','exclusiveMaximum','minLength','maxLength','minItems','maxItems','uniqueItems','pattern','multipleOf','description','default'];
const caps={R:100,W:25,H:10,D:10},methods={};
for(const item of evidence.inventory){
  const operation=model.paths[item.path][item.method.toLowerCase()],defs={},cap=caps[item.risk];
  function ref(name){if(!rawDefs[name])throw Error('Missing Lightspeed definition '+name);if(!Object.hasOwn(defs,name)){defs[name]={};defs[name]=convert(rawDefs[name]);}return {$ref:'#/$defs/'+name};}
  function convert(raw){
    if(typeof raw==='boolean')return raw;
    if(raw.$ref){const r=ref(raw.$ref.split('/').pop());return raw.nullable?{anyOf:[r,{type:'null'}]}:r;}
    // The published allOf request compositions only extend object properties.
    if(raw.allOf){const merged={...raw,properties:{...raw.properties},required:[...(raw.required||[])]};delete merged.allOf;for(const branch of raw.allOf){const b=deref(branch);if(b.allOf)throw Error('Unreviewed nested input composition');Object.assign(merged.properties,b.properties);merged.required.push(...b.required||[]);}merged.type='object';merged.required=[...new Set(merged.required)];return convert(merged);}
    const s=Object.fromEntries(keys.filter(k=>Object.hasOwn(raw,k)).map(k=>[k,raw[k]]));if(raw.properties&&!s.type)s.type='object';
    for(const kind of ['oneOf','anyOf'])if(raw[kind])s[kind]=raw[kind].map(convert);
    if(s.type==='object'){
      if(raw.properties)s.properties=Object.fromEntries(Object.entries(raw.properties).filter(([,v])=>!v.readOnly).map(([k,v])=>[k,convert(v)]));
      s.additionalProperties=raw.additionalProperties===true||!raw.properties;if(typeof raw.additionalProperties==='object')s.additionalProperties=convert(raw.additionalProperties);
      if(s.required)s.required=s.required.filter(k=>!raw.properties?.[k]?.readOnly);
    }
    if(s.type==='array'){s.items=convert(raw.items||{});s.maxItems=Math.min(s.maxItems??cap,cap);}
    if(s.type==='string'){s.maxLength??=256*1024;if(['uuid','date-time','email','uri','ipv4'].includes(raw.format?.toLowerCase()))s.format=raw.format.toLowerCase();}
    if(s.type==='integer'){
      if(raw.format==='int64'){
        const n={type:'integer',minimum:Math.max(raw.minimum??Number.MIN_SAFE_INTEGER,Number.MIN_SAFE_INTEGER),maximum:Math.min(raw.maximum??Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER)};
        const integer={anyOf:[n,{type:'string',pattern:'^-?(0|[1-9][0-9]{0,18})$',maxLength:20}],'x-integer-format':'int64'};
        for(const k of ['minimum','maximum'])if(raw[k]!==undefined)integer['x-integer-'+k]=String(raw[k]);
        for(const k of ['description','default'])if(raw[k]!==undefined)integer[k]=raw[k];return raw.nullable?{anyOf:[integer,{type:'null'}]}:integer;
      }
      s.minimum=Math.max(s.minimum??(raw.format==='int32'?-2147483648:Number.MIN_SAFE_INTEGER),Number.MIN_SAFE_INTEGER);s.maximum=Math.min(s.maximum??(raw.format==='int32'?2147483647:Number.MAX_SAFE_INTEGER),Number.MAX_SAFE_INTEGER);
    }
    return raw.nullable?{anyOf:[s,{type:'null'}]}:s;
  }
  const input={type:'object',properties:{},required:[],additionalProperties:false,description:operation.description||operation.summary},wire=[];
  for(const raw of [...model.paths[item.path].parameters||[],...operation.parameters||[]]){
    const p=deref(raw);if(!['path','query'].includes(p.in))throw Error('Unreviewed Lightspeed parameter location');const group=input.properties[p.in] ||= {type:'object',properties:{},required:[],additionalProperties:false};
    group.properties[p.name]={...convert(p.schema),...(p.description?{description:p.description}:{})};
    if(item.path==='/auditlog_events'&&['page_size','offset'].includes(p.name))group.properties[p.name]={anyOf:[{type:'integer',minimum:p.name==='page_size'?1:0,maximum:p.name==='page_size'?100:Number.MAX_SAFE_INTEGER},{type:'string',pattern:p.name==='page_size'?'^(100|[1-9][0-9]?)$':'^(0|[1-9][0-9]{0,14})$'}],description:p.description};
    else if(p.in==='query'&&['page_size','pageSize','limit'].includes(p.name)&&group.properties[p.name].type==='integer'){group.properties[p.name].minimum=Math.max(p.schema.minimum??1,1);group.properties[p.name].maximum=Math.min(p.schema.maximum??100,100);}
    if(p.required){group.required.push(p.name);if(!input.required.includes(p.in))input.required.push(p.in);}wire.push({name:p.name,in:p.in,style:p.style||'form',explode:p.explode!==false});
  }
  if(operation.requestBody){const b=deref(operation.requestBody),media=b.content['application/json'];if(!media?.schema)throw Error('Unreviewed Lightspeed request content');input.properties.body=convert(media.schema);if(b.required)input.required.push('body');}
  const defaults={query:{},body:{}};
  function boundedPage(s){const numeric=s.anyOf?.find(x=>x.type==='integer')||s,maximum=Math.min(numeric.maximum??100,100),minimum=Math.max(numeric.minimum??1,1);return {type:'integer',minimum,maximum,default:Math.max(minimum,Math.min(s.default??100,maximum)),description:s.description};}
  for(const key of ['page_size','pageSize','limit','size'])if(input.properties.query?.properties[key]){input.properties.query.properties[key]=boundedPage(input.properties.query.properties[key]);defaults.query[key]=input.properties.query.properties[key].default;}
  if(['/inventory','/inventory_levels'].includes(item.path)&&item.method==='POST'){const b=input.properties.body.$ref?defs[input.properties.body.$ref.split('/').pop()]:input.properties.body;b.properties.size=boundedPage(b.properties.size);defaults.body.size=b.properties.size.default;}
  if(Object.keys(defs).length)input.$defs=defs;
  const responses={};for(const [status,response]of Object.entries(operation.responses)){if(!/^2\d\d$/.test(status))continue;const r=deref(response),media=['application/json','text/html','text/plain'].find(x=>r.content?.[x]);responses[status]={media:media||null,schema:media?r.content[media].schema:null};}
  methods[item.action]={method:item.method,path:item.path,risk:item.risk,description:operation.summary,input_schema:input,wire,defaults,responses};
}
const result={version:evidence.api_version,methods,response_schemas:rawDefs,exclusions:evidence.exclusions};
fs.writeFileSync(process.argv[2]||path.join(__dirname,'../bin/lightspeed-api-contracts.cjs'),"'use strict';\n// Generated from the pinned official Lightspeed X-Series OpenAPI.\nmodule.exports = "+JSON.stringify(result,null,2)+';\n');
console.log('Generated '+Object.keys(methods).length+' Lightspeed merchant contracts');
