'use strict';

// Offline conversion of pinned public Swagger models. No request destination,
// execution risk or unavailable identity is inferred from prose or method names.
const fs = require('node:fs');
const path = require('node:path');
const evidence = JSON.parse(fs.readFileSync(path.join(__dirname, '../test/fixtures/connectors/official-contracts/amazon-20260930.json'), 'utf8'));
const constraints = ['type','enum','required','minLength','maxLength','minimum','maximum','minItems','maxItems','uniqueItems','pattern','multipleOf','description'];
const formats = new Set(['date','date-time','uri','email','ipv4','ipv6','hostname','uuid']);
function schema(raw, definitions, input, stack = [], refs = new Set()) {
  let row = structuredClone(raw || {});
  if (row.$ref) {
    const name = row.$ref.replace(/^#\/definitions\//,'');
    if (!Object.hasOwn(definitions,name)) throw new Error('Unknown schema reference: '+name);
    if (stack.includes(name)) {refs.add(name);return {$ref:'#/$defs/'+name};}
    delete row.$ref;
    return schema({...definitions[name],...row},definitions,input,[...stack,name],refs);
  }
  if (row.allOf) {
    const parts = row.allOf.map(part=>schema(part,definitions,input,stack,refs));
    if (parts.some(part=>part.type !== 'object')) throw new Error('Unestablished schema inheritance');
    delete row.allOf;
    const properties = Object.assign({},...parts.map(part=>part.properties || {}),row.properties || {});
    const required = [...new Set([...parts.flatMap(part=>part.required || []),...(row.required || [])])];
    row = {...row,type:'object',properties,required};
    // Parts have already been converted. Retain inheritance at this owning
    // object rather than closing each branch against its sibling's fields.
    const result = {type:'object',properties,required,additionalProperties:!input};
    if (row.description) result.description=row.description;
    return result;
  }
  const result = Object.fromEntries(constraints.filter(key=>Object.hasOwn(row,key) && (key !== 'required' || Array.isArray(row.required)) && (input || ['type','required'].includes(key))).map(key=>[key,row[key]]));
  if (!result.type && row.properties) result.type='object';
  if (input && formats.has(row.format)) result.format=row.format;
  if (input && typeof row.exclusiveMinimum === 'boolean' && row.exclusiveMinimum && row.minimum !== undefined) {result.exclusiveMinimum=row.minimum;delete result.minimum;}
  if (result.type === 'array') {
    result.items=schema(row.items,definitions,input,stack,refs);
    if (input) result.maxItems=Math.min(result.maxItems ?? 100,100);
  }
  if (result.type === 'object') {
    if (row.properties) result.properties=Object.fromEntries(Object.entries(row.properties).map(([name,child])=>[name,schema(child,definitions,input,stack,refs)]));
    if (row.additionalProperties && typeof row.additionalProperties==='object') result.additionalProperties=schema(row.additionalProperties,definitions,input,stack,refs);
    else result.additionalProperties=input ? (row.additionalProperties === true || !row.properties) : true;
  }
  if (input && result.type==='string' && result.maxLength === undefined) result.maxLength=256*1024;
  if (input && result.type==='integer') {result.minimum=Math.max(result.minimum ?? Number.MIN_SAFE_INTEGER,Number.MIN_SAFE_INTEGER);result.maximum=Math.min(result.maximum ?? Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER);}
  return result;
}
function rootSchema(raw,definitions,input) {
  const refs=new Set(), result=schema(raw,definitions,input,[],refs), resolved={};
  for (const name of refs) resolved[name]=schema(definitions[name],definitions,input,[name],refs);
  if (refs.size) result.$defs=resolved;
  return result;
}
const object = () => ({type:'object',properties:{},required:[],additionalProperties:false});
const methods = {};
for (const row of evidence.inventory) {
  if (row.excluded_reason) continue;
  const name=row.method+' '+row.path, model=evidence.models[row.model], operation=model.operations[name];
  if (!operation || !['R','W','H','D'].includes(row.risk) || Object.hasOwn(methods,name) || name.length>160) throw new Error('Unreviewed operation');
  const input=object(), wire=[];
  for (const p of operation.parameters) {
    if (!['query','path','body','header'].includes(p.in)) throw new Error('Unknown parameter location');
    const location=p.in === 'header' ? 'headers' : p.in;
    const field=rootSchema(p.in === 'body' ? p.schema : p,model.definitions,true);
    if (p.type==='string' && p.items?.enum) {
      const values=p.items.enum.map(value=>String(value).replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
      field.pattern='^(?:'+values.join('|')+')(?:,(?:'+values.join('|')+'))*$';
    }
    if (field.$defs) {input.$defs={...input.$defs,...field.$defs};delete field.$defs;}
    if (p.in === 'body') { if (input.properties.body) throw new Error('Multiple bodies'); input.properties.body=field;if(p.required) input.required.push('body'); }
    else {
      const group=input.properties[location] ||= object();
      if (group.properties[p.name]) throw new Error('Duplicate parameter');
      group.properties[p.name]=field;
      if (p.required) {group.required.push(p.name);if(!input.required.includes(location)) input.required.push(location);}
      wire.push({location,name:p.name,collection:p.collectionFormat || 'csv'});
      if (p.in==='header') {field.maxLength=Math.min(field.maxLength || 1024,1024);field.pattern='^[^\\r\\n\\u0000]*$';}
    }
  }
  const batchLimit=row.risk==='R' ? 100 : row.risk==='W' ? 25 : 10;
  const boundArrays=s=>{
    if(s.type==='array'){
      s.maxItems=Math.min(s.maxItems ?? batchLimit,batchLimit);
      if((s.minItems || 0)>s.maxItems)throw new Error('Operation exceeds the existing host batch limit');
      boundArrays(s.items);
    }
    for(const child of Object.values(s.properties || {}))boundArrays(child);
    if(s.additionalProperties && typeof s.additionalProperties==='object')boundArrays(s.additionalProperties);
  };
  boundArrays(input);
  for(const child of Object.values(input.$defs || {}))boundArrays(child);
  // Batch destinations/methods are protocol literals, never arbitrary transport
  // controls. Authentication headers and opaque subrequest bodies stay host-owned.
  const batchItems=input.properties.body?.properties?.requests?.items;
  if (['getItemOffersBatch','getListingOffersBatch','getFeaturedOfferExpectedPriceBatch','getCompetitiveSummary'].includes(row.operation)) {
    if (!batchItems?.properties?.uri || !batchItems.properties.method) throw new Error('Missing reviewed batch contract');
    batchItems.properties.method={type:'string',const:'GET'};
    if (row.operation==='getItemOffersBatch') batchItems.properties.uri={type:'string',pattern:'^/products/pricing/v0/items/[A-Za-z0-9_-]+/offers$'};
    if (row.operation==='getListingOffersBatch') batchItems.properties.uri={type:'string',pattern:'^/products/pricing/v0/listings/[^/?#]+/offers$',maxLength:600};
    if (row.operation==='getFeaturedOfferExpectedPriceBatch') batchItems.properties.uri={type:'string',const:'/products/pricing/2022-05-01/offer/featuredOfferExpectedPrice'};
    if (row.operation==='getCompetitiveSummary') batchItems.properties.uri={type:'string',const:'/products/pricing/2022-05-01/items/competitiveSummary'};
    delete batchItems.properties.headers;delete batchItems.properties.body;
    batchItems.additionalProperties=false;
    input.properties.body.properties.requests.maxItems=row.operation==='getFeaturedOfferExpectedPriceBatch' ? 40 : 20;
  }
  if (batchItems) {
    input.properties.body.required=[...new Set([...(input.properties.body.required || []),'requests'])];
    input.properties.body.properties.requests.minItems=1;
  }
  if (row.operation==='batchInventory') {input.properties.body.properties.requests.minItems=1;input.properties.body.properties.requests.maxItems=10;}
  if (row.operation==='searchOrders') {const page=input.properties.query.properties.maxResultsPerPage;page.minimum=1;page.maximum=100;}
  const responses=Object.fromEntries(Object.entries(operation.responses).map(([status,response])=>[status,response.schema ? rootSchema(response.schema,model.definitions,false) : null]));
  const outcomes=[], error_prose_paths=[];
  for (const response of Object.values(responses)) {
    const walk=(s,cursor=[],seen=new Set())=>{
      if (!s) return;
      if (s.$ref) {const id=s.$ref.slice('#/$defs/'.length);if(seen.has(id))return;walk(response.$defs[id],cursor,new Set([...seen,id]));return;}
      if (s.type==='array') {walk(s.items,[...cursor,'*'],seen);return;}
      for (const [key,child]of Object.entries(s.properties || {})) {
        const path=[...cursor,key];
        if (['message','details','reasonphrase'].includes(key.toLowerCase()) &&
            (cursor.some(part=>['errors','actionableErrors','Error','errorDetails','warnings','issues','operationProblems'].includes(part)) || (key==='reasonPhrase' && cursor.at(-1)==='status'))) error_prose_paths.push(path);
        if (['errors','actionableErrors','Error','errorDetails'].includes(key)) outcomes.push({path,kind:'nonempty'});
        if (key==='severity') outcomes.push({path,kind:'values',values:['ERROR']});
        if (key==='operationStatus') outcomes.push({path,kind:'values',values:['FAILED']});
        if (key==='Status' && ['getMyFeesEstimateForSKU','getMyFeesEstimateForASIN','getMyFeesEstimates'].includes(row.operation)) outcomes.push({path,kind:'values',values:['ClientError','ServiceError']});
        if (key==='statusCode' && cursor.at(-1)==='status') outcomes.push({path,kind:'http'});
        walk(child,path,seen);
      }
    };
    walk(response);
  }
  if (['putListingsItem','patchListingsItem','deleteListingsItem'].includes(row.operation)) outcomes.push({path:['status'],kind:'values',values:['INVALID']});
  const brief=operation.description.split(/\n\n/)[0].replace(/\s+/g,' ').slice(0,190);
  const note=row.risk==='R' ? 'One explicit page; authorized business fields may include fulfillment contacts and amounts.' : 'Accepted submission is acknowledged; inspect state before retrying an uncertain write.';
  methods[name]={operation:row.operation,model:row.model,method:row.method,path:row.path,risk:row.risk,input_schema:input,wire,responses,outcomes,error_prose_paths,
    description:brief+' '+note+' '+row.source_url};
}
const data={documentation_snapshot:evidence.documentation_snapshot,source_commit:evidence.source_commit,scope:evidence.scope,methods,
  excluded_methods:Object.fromEntries(evidence.inventory.filter(row=>row.excluded_reason).map(row=>[row.method+' '+row.path,row.excluded_reason]))};
fs.writeFileSync(path.join(__dirname,'../bin/amazon-api-contracts.cjs'),"'use strict';\n// Generated offline from pinned official seller-grant models.\nmodule.exports = "+JSON.stringify(data,null,2)+';\n');
console.log('Generated '+Object.keys(methods).length+' Amazon business contracts');
