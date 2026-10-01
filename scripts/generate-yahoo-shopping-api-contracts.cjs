'use strict';
// Frozen official request tables are the input; no network access or merchant credentials.
const fs = require('node:fs'), path = require('node:path');
const evidence = require('../test/fixtures/connectors/official-contracts/yahoo-shopping-20261001.json');
const object = () => ({ type: 'object', properties: {}, additionalProperties: false });
const str = maxLength => ({ type: 'string', maxLength: maxLength || 65536 });
const excludedFields = new Set(['relevant_links','yahoo_product_code','astk_code','supplier_type','y_shopping_display_flag','store-in-stock','store-in-stock-few','store-in-stockupdate','pick_and_delivery_code','pick_and_delivery_transport_rule_type','yamato_ff_flag','eco_setting_id','eco_setting_evidence_url','paypaymall_freespace','paypaymall_sp_freespace']);
const nameOf = raw => (raw || '').match(/^\/?[A-Za-z][A-Za-z0-9_/-]*/)?.[0];
const isSeller = key => ['seller_id','sellerId','sellerid','SellerId'].includes(key);
const methods = {};
function fields(table) {
  const header = table[0], kind = header.indexOf('型') >= 0 ? header.indexOf('型') : header.indexOf('値');
  const required = header.indexOf('必須'), max = header.indexOf('最大長');
  return table.slice(1).flatMap(row => {
    const depth = row[0] === '' && row[1] ? 1 : 0, raw = row[depth], key = nameOf(raw);
    if (!key) return [];
    return [{ key, depth, required: required >= 0 ? /^〇(?:$|\s*※2$)/.test(row[required] || '') : /必須/.test(raw) && !/※1/.test(raw), type: row[kind] || '', limit: max >= 0 ? row[max] : '', description: row.at(-1) || '', raw, row }];
  });
}
function scalar(field, op, pointer, meta) {
  const { type, description, limit } = field; const key = field.key.split('/').at(-1);
  let schema;
  if (/^(object|Object)$/.test(type)) schema = object();
  else if (/^(array|Array)/.test(type)) schema = { type: 'array', minItems: 1, maxItems: op.risk === 'R' ? 100 : 10, items: object() };
  else if (/boolean|false.*true|true.*false/.test(type)) schema = { type: 'boolean' };
  else if (/^(integer|int|number|float)\b/.test(type) || /^(（?数値）?)$/.test(type)) schema = { type: /float/.test(type) ? 'number' : 'integer', minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER };
  else schema = str();
  let digits = /^\d+$/.test(limit) ? Number(limit) : null;
  if (schema.type === 'integer' && digits && digits <= 15) schema.maximum = 10 ** digits - 1;
  if (schema.type === 'integer' && digits && digits > 15) throw new Error('Unsafe numeric input requires explicit source review: ' + op.source_id + ':' + pointer);
  if (schema.type === 'string' && digits) schema.maxLength = digits;
  const half = /全角([\d,]+)/.exec(limit || description), chars = /([\d,]+)文字(?:以内|まで)/.exec(description), bytes = /([\d,]+)\s*byte/i.exec(limit || description);
  if (schema.type === 'string' && half) { const max = Number(half[1].replaceAll(',', '')); schema.maxLength = max * 2; }
  else if (schema.type === 'string' && chars) schema.maxLength = Number(chars[1].replaceAll(',', ''));
  if (schema.type === 'string' && bytes) { schema.maxLength = Number(bytes[1].replaceAll(',', '')); meta.byte_limits[pointer] = schema.maxLength; }
  if (schema.type === 'string' && (/date/i.test(type) || /yyyy-MM-dd/.test(description))) schema.pattern = '^\\d{4}-\\d{2}-\\d{2}$';
  if (['results','limit','Result'].includes(key)) Object.assign(schema, { type: 'integer', minimum: 1, maximum: 100 });
  if (['start','Start','countFrom'].includes(key)) Object.assign(schema, { type: 'integer', minimum: 1, maximum: 99999999 });
  if (field.required && schema.type === 'string') schema.minLength = 1;
  schema.description = description || key;
  return schema;
}
function put(root, parts, schema, required) {
  let at = root;
  for (const key of parts.slice(0, -1)) { at.properties[key] ||= object(); if (required && !at.required?.includes(key)) (at.required ||= []).push(key); at = at.properties[key].items || at.properties[key]; }
  const key = parts.at(-1); at.properties[key] = schema;
  if (required && !at.required?.includes(key)) (at.required ||= []).push(key);
}
function fill(root, rows, op, prefix, meta) {
  let parent;
  for (const field of rows) {
    const key = field.key;
    if (isSeller(key)) { meta.seller_fields.push(prefix + '.' + key); continue; }
    if (excludedFields.has(key) || /現在.*(?:利用できません|使用されておりません)/.test(field.raw + field.description)) { meta.excluded_fields.push(key); continue; }
    const parts = key.includes('/') ? key.split('/').filter(Boolean).filter(x => x !== 'Req') : field.depth && parent ? [parent, key] : [key];
    if (!parts.length || /更新情報キー/.test(field.raw)) continue;
    if (isSeller(parts.at(-1))) { meta.seller_fields.push(prefix + '.' + parts.join('.')); continue; }
    const pointer = prefix + '.' + parts.join('.');
    let schema = scalar(field, op, pointer, meta);
    if (!field.type && key.includes('/')) schema = parts.at(-1) === 'LineId' ? { type: 'integer', minimum: 1, maximum: 9999 } : object();
    if (!field.type && /複数指定可|繰り返し可/.test(field.description)) schema = { type: 'array', minItems: 1, maxItems: op.risk === 'R' ? 100 : 10, items: object(), description: field.description };
    put(root, parts, schema, field.required);
    if (schema.type === 'object' || schema.type === 'array') parent = parts.at(-1);
  }
}
for (const op of evidence.operations.filter(x => x.status === 'candidate')) {
  if (!op.method || !op.route) throw new Error('Unresolved route: ' + op.source_id);
  const meta = { source_id: op.source_id, route: op.route, version: op.version, method: op.method, encoding: op.encoding, risk: op.risk, source_url: op.source_url, seller_fields: [], byte_limits: {}, excluded_fields: [] };
  const input = object(); const tables = op.request_sections.flatMap(x => x.tables).filter(t => t[0]?.some(h => ['パラメータ','キー名'].includes(h)));
  const id = op.source_id;
  if (op.encoding === 'form') {
    const root = input.properties.parameters = object();
    if (id === 'updateItems.html') { const item = object(); fill(item, fields(tables[1]), op, 'parameters.items.*', meta); root.properties.items = { type: 'array', minItems: 1, maxItems: 10, items: item }; root.required = ['items']; meta.seller_fields.push('parameters.seller_id'); }
    else fill(root, fields(tables[0]), op, 'parameters', meta);
  } else if (op.encoding === 'xml') {
    const root = input.properties.body = object(); fill(root, fields(tables[0]), op, 'body', meta);
    if (id === 'orderList.html') {
      const condition = object(); const t = tables[1]; if (!t) throw new Error('Missing order condition');
      const keyIndex = t[0].indexOf('キー名'), typeIndex = t[0].indexOf('型'), limitIndex = t[0].indexOf('最大長');
      fill(condition, t.slice(1).map(row => ({ key: nameOf(row[keyIndex]), type: row[typeIndex], limit: row[limitIndex], description: row.at(-1), required: false, raw: row[keyIndex], depth: 0 })).filter(f => /^[A-Za-z][A-Za-z0-9]*$/.test(f.key)), op, 'body.Search.Condition', meta);
      put(root,['Search','Condition'],condition,false);
    }
    if (['orderInfo.html','orderList.html'].includes(id)) {
      const t = tables[id === 'orderInfo.html' ? 1 : 2];
      if (!t) throw new Error('Missing selectable order fields');
      const keyIndex=t[0].indexOf('キー名');const values=[...new Set(t.slice(1).map(row=>row[keyIndex]).filter(key=>/^[A-Za-z][A-Za-z0-9]*$/.test(key)))];
      put(root,[id==='orderInfo.html'?'Target':'Search','Field'],{type:'array',minItems:1,maxItems:values.length,uniqueItems:true,items:{type:'string',enum:values},description:'Select only the required response fields; encoded as a comma-separated list.'},true);
    }
    if (id === 'orderChange.html') {
      const t = tables.find(t=>t[0][0]==='分類'); const groups={'注文':[],'請求':['Pay'],'配送':['Ship'],'明細':['Detail'],'商品':['Item']}; let group;
      for(const row of t.slice(1)) { if(row[0])group=row[0];const key=nameOf(row[1]);if(!/^[A-Za-z][A-Za-z0-9]*$/.test(key)||!groups[group])continue;
        const f={key,type:row[3],limit:row[4],description:row[5],required:false,raw:key,depth:0};
        if(/現在.*利用できません/.test(f.description)){meta.excluded_fields.push(key);continue;}
        const parts=['Order',...groups[group],key];put(root,parts,scalar(f,op,'body.'+parts.join('.'),meta),false);
      }
    }
  } else {
    if (id.startsWith('question/')) {
      for(const section of op.request_sections)for(const table of section.tables) {
        if(!table[0]?.includes('パラメータ'))continue;
        const location=section.heading.includes('ボディ')?'body':'query';const root=input.properties[location] ||= object();fill(root,fields(table),op,location,meta);
      }
    } else if(id.includes('Real')) {
      const location=op.method==='GET'?'query':'body';const root=input.properties[location]=object(); const rows=fields(tables[0]);
      for(const field of rows) {
        const key=field.key.replace(/^\//,'');if(isSeller(key)){meta.seller_fields.push(location+'.'+key);continue;}
        const parts=key.split('/');let schema=scalar({...field,key:parts.at(-1),type:'string'},op,location+'.'+parts.join('.'),meta);
        if(parts.length===1&&['stocks','stores'].includes(key))schema={type:'array',minItems:1,maxItems:op.risk==='R'?100:10,items:object()};
        put(root,parts,schema,field.required);
      }
    } else {
      const location=op.method==='GET'?'query':'body';const root=input.properties[location]=object();let first=true;
      for(const table of tables) {
        const rows=fields(table);if(!rows.length)continue;
        if(first){fill(root,rows,op,location,meta);first=false;}
        else {const key=id==='subscription/change.html'?'changes':root.properties.conditions?'conditions':null;if(!key)throw new Error('Unresolved nested fields '+id);fill(root.properties[key],rows,op,location+'.'+key,meta);}
      }
    }
  }
  // Explicit corrections are grounded in the same official field descriptions.
  const form = input.properties.parameters?.properties;
  if (form) {
    for(const key of ['path','options','inscriptions','subcodes','subcode_param','subcode_price',...Array.from({length:10},(_,i)=>'spec'+(i+1))])if(form[key]){form[key].maxLength=65536;delete meta.byte_limits['parameters.'+key];}
    if (form.jan) form.jan = { ...str(17), pattern: '^[A-Za-z0-9-]+$', description: form.jan.description };
    if (form.condition) form.condition.enum = [0,2,3,4,5,6,7,8];
    if (form.point_code) form.point_code.enum = Array.from({length:15},(_,i)=>String(i+1));
    if (id==='setStock.html') for(const key of ['allow_overdraft','stock_close'])form[key]={type:'string',pattern:key==='stock_close'?'^(0?)(,0?){0,9}$':'^[01](,[01]){0,9}$',description:form[key].description};
    if (id==='updateItems.html') {form.items.items.properties.subcode_price.maxLength=65536;delete meta.byte_limits['parameters.items.*.subcode_price'];}
    if (id==='updateItems.html') for(const key of ['original_price','sale_price','member_price']) {const item=form.items.items.properties;item[key]={anyOf:[item[key],{const:''}]};}
    if (id==='myItemList.html') { form.type.enum=['item_code','name'];form.sort.pattern='^[+-](item_code|name|stcat_key|sort_priority)$'; }
    if (['myItemList.html','itemImageList.html'].includes(id))input.properties.parameters.anyOf=[{required:['query']},{required:['stcat_key']}];
  }
  if (input.properties.query?.properties.result) Object.assign(input.properties.query.properties.result,{minimum:1,maximum:20});
  if (id==='question/list.html') {const q=input.properties.query.properties;q.dateType.enum=['userPostTime','sellerPostTime'];q.qaType.enum=['item','order'];q.sort.enum=['userPostTime','sellerPostTime'];q.sortOrder.enum=['asc','desc'];q.firstPoster.enum=['seller','user'];q.serviceType.const='shp';}
  if (id==='subscription/changerequest.html')input.properties.body.properties.changeRequestType.enum=['price_update','item_switch'];
  if (id==='orderShipStatusChange.html')input.properties.body.properties.Target.properties.IsPointFix.const=true;
  if (id==='orderChange.html') {const o=input.properties.body.properties.Order;if(o.properties.Item){o.properties.Item.required=['LineId'];o.properties.Item={type:'array',minItems:1,maxItems:10,items:o.properties.Item};}}
  if (id.includes('Real')&&input.properties.body?.properties.stocks) {const sku=input.properties.body.properties.stocks.items.properties.skuId;if(sku)input.properties.body.properties.stocks.items.properties.skuId={anyOf:[sku,{type:'null'}]};}
  if(id==='orderStatusChange.html'&&input.properties.body.properties.Oeder){input.properties.body.properties.Order.properties.CancelReasonDetail=input.properties.body.properties.Oeder.properties.CancelReasonDetail;delete input.properties.body.properties.Oeder;}
  const pathKeys=[...op.route.matchAll(/\{([^}]+)\}/g)].map(m=>m[1]);if(pathKeys.length){const root=input.properties.path=object();for(const key of pathKeys)root.properties[key]={type:'string',minLength:1,maxLength:128,pattern:'^[A-Za-z0-9_-]+$'};root.required=pathKeys;}
  for(const [key,schema] of Object.entries(input.properties)) {if(!Object.keys(schema.properties).length)delete input.properties[key];else if(schema.required?.length)(input.required ||= []).push(key);}
  meta.description='Yahoo Shopping '+op.route.split('/').at(-1)+'. '+(op.risk==='R'?'One response only.':'Never automatically retry an uncertain mutation.')+(id.startsWith('order')?' Order API approval and registered outbound IP are required.':id.startsWith('subscription/')?' Merchant subscription feature must be enabled.':'');
  meta.input_schema=input;methods['yahoo.'+op.version.toLowerCase()+'.'+op.route.replaceAll('/','.').replace(/\{[^}]+\}\.?/g,'').replace(/\.$/,'.get')]=meta;
}
const destination = process.env.ORKAS_YAHOO_CONTRACT_OUTPUT || path.resolve(__dirname,'../bin/yahoo-shopping-api-contracts.cjs');
fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,"'use strict';\n// Generated by scripts/generate-yahoo-shopping-api-contracts.cjs from frozen official tables.\nmodule.exports="+JSON.stringify({methods})+';\n');
console.log(JSON.stringify({operations:Object.keys(methods).length}));
