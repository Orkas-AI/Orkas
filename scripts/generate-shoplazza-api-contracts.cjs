'use strict';
// Offline conversion of the official Shoplazza CLI v202601 contract. The
// registry is protobuf-derived; well-known JSON types follow protobuf.dev.
const fs=require('node:fs'),path=require('node:path');
const evidence=JSON.parse(fs.readFileSync(path.join(__dirname,'../test/fixtures/connectors/official-contracts/shoplazza-20261001.json'),'utf8'));
const source=evidence.source,schemas=source.schemas,commands=new Map(source.modules.flatMap(m=>m.commands.map(c=>[c.id,c]))),methods={};
const object=()=>({type:'object',properties:{},required:[],additionalProperties:false});
for(const item of evidence.inventory){
  const c=commands.get(item.id),cap={R:100,W:25,H:10,D:10}[item.risk],defs={};
  function fields(list){const s=object();for(const f of list){s.properties[f.name]=field(f);if(f.required)s.required.push(f.name);}return s;}
  function ref(name){
    if(name==='google.protobuf.Value')return {};
    if(name==='google.protobuf.Struct')return {type:'object',additionalProperties:true};
    if(name==='google.protobuf.ListValue')return {type:'array',items:{},maxItems:cap};
    if(name==='google.protobuf.Any')return {type:'object',properties:{'@type':{type:'string'}},additionalProperties:true};
    if(!Object.hasOwn(schemas,name))throw Error('Missing Shoplazza schema '+name);
    if(!Object.hasOwn(defs,name)){defs[name]={};defs[name]=fields(schemas[name].fields||[]);}
    return {$ref:'#/$defs/'+name};
  }
  function field(f){
    let s=f.schema?ref(f.schema):{type:f.type};
    if(!f.schema&&f.type==='object')s=f.items?{type:'object',additionalProperties:field(f.items)}:{type:'object',additionalProperties:true};
    if(f.type==='array'){s={type:'array',items:f.items?field(f.items):{},maxItems:cap};if(f.min_length!==undefined)s.minItems=f.min_length;if(f.max_length!==undefined)s.maxItems=Math.min(cap,f.max_length);}
    if(f.type==='string'){s.maxLength=f.max_length??256*1024;if(f.min_length!==undefined)s.minLength=f.min_length;}
    if(f.enum)s.enum=f.enum;
    if(f.type==='integer'){
      if(['uint64','int64'].includes(f.format))s={anyOf:[{type:'integer',minimum:f.format==='uint64'?0:Number.MIN_SAFE_INTEGER,maximum:Number.MAX_SAFE_INTEGER},{type:'string',pattern:f.format==='uint64'?'^(0|[1-9][0-9]{0,19})$':'^-?(0|[1-9][0-9]{0,18})$',maxLength:20}],'x-integer-format':f.format};
      else {s.minimum=f.format==='uint32'?0:f.format==='int32'?-2147483648:Number.MIN_SAFE_INTEGER;s.maximum=f.format==='uint32'?4294967295:f.format==='int32'?2147483647:Number.MAX_SAFE_INTEGER;}
    }
    for(const key of ['minimum','maximum'])if(f[key]!==undefined&&!s.anyOf)s[key]=f[key];
    if(f.default!==undefined)s.default=f.default;
    if(s.anyOf)for(const key of ['minimum','maximum'])if(f[key]!==undefined){s.anyOf[0][key]=f[key];s['x-integer-'+key]=String(f[key]);}
    if(f.description)s.description=f.description;
    return s;
  }
  const input=object();input.description=c.description+' Requires the corresponding merchant app permission.';
  for(const p of c.parameters||[]){if(!['path','query'].includes(p.in))throw Error('Unreviewed parameter location');const group=input.properties[p.in] ||= object();group.properties[p.name]=field(p);if(p.required){group.required.push(p.name);if(!input.required.includes(p.in))input.required.push(p.in);}
    if(p.in==='query'&&['per_page','page_size','limit'].includes(p.name)&&p.type==='integer'){group.properties[p.name].minimum=Math.max(p.minimum??1,1);group.properties[p.name].maximum=Math.min(p.maximum??100,100);}
  }
  if(c.body){input.properties.body=fields(c.body.fields);if(c.body.required)input.required.push('body');}
  if(Object.keys(defs).length)input.$defs=defs;
  const response=schemas[c.response_schema];if(!response)throw Error('Missing response '+c.response_schema);
  const responseFields=(response.fields||[]).map(f=>({name:f.name,type:f.type,...(f.format?{format:f.format}:{}),...(f.schema?{schema:f.schema}:{}),...(f.items?{items:f.items}:{}),...(f.schema&&schemas[f.schema]?.fields?.some(v=>v.name==='id')?{has_id:true}:{})}));
  methods[c.id]={risk:item.risk,module:item.module,method:c.http.method,path:c.http.path.replace('/openapi/2026-01',''),description:c.summary,input_schema:input,response_fields:responseFields};
}
const responseSchemas={};function collect(name){if(!name||Object.hasOwn(responseSchemas,name))return;const model=schemas[name];if(!model)throw Error('Missing response model '+name);responseSchemas[name]=model;function nested(f){if(f.schema)collect(f.schema);if(f.items)nested(f.items);}for(const f of model.fields||[])nested(f);}
for(const row of Object.values(methods))for(const f of row.response_fields){if(f.schema)collect(f.schema);if(f.items?.schema)collect(f.items.schema);}
fs.writeFileSync(path.join(__dirname,'../bin/shoplazza-api-contracts.cjs'),"'use strict';\n// Generated from pinned official Shoplazza v202601 merchant contracts.\nmodule.exports = "+JSON.stringify({version:evidence.version,methods,response_schemas:responseSchemas,exclusions:evidence.exclusions},null,2)+';\n');
console.log('Generated '+Object.keys(methods).length+' Shoplazza contracts');
