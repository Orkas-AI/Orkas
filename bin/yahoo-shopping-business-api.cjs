'use strict';
const owner = require('./yahoo-shopping-api.cjs');
let catalog, actions, validator;
const checks = new Map();
const source = () => catalog ||= require('./yahoo-shopping-api-contracts.cjs');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const list = value => value === undefined || value === '' ? [] : Array.isArray(value) ? value : [value];
const isNative = name => Object.hasOwn(source().methods, name);
function actionsFor() { return actions ||= Object.fromEntries(Object.entries(source().methods).map(([name, row]) => [name, { risk: row.risk, description: row.description, input_schema: row.input_schema, documentation_url: row.source_url }])); }
function visit(schema, value, path, row) {
  if (typeof value === 'string') {
    if (row.byte_limits[path] && Buffer.byteLength(value) > row.byte_limits[path]) fail('E_BAD_INPUT', 'Yahoo field exceeds its documented byte limit');
    if (schema.pattern === '^\\d{4}-\\d{2}-\\d{2}$') { const d = new Date(value + 'T00:00:00Z'); if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== value) fail('E_BAD_INPUT', 'Invalid Yahoo calendar date'); }
  }
  if (Array.isArray(value)) value.forEach(v => visit(schema.items, v, path + '.*', row));
  else if (object(value)) for (const [key, child] of Object.entries(value)) visit(schema.properties[key], child, path ? path + '.' + key : key, row);
}
function at(root, parts, create = false) { let value = root; for (const key of parts) { if (create && value[key] === undefined) value[key] = {}; value = value?.[key]; } return value; }
function build(config, name, parameters = {}) {
  if (config.provider !== 'yahoo_shopping' || !isNative(name)) fail('E_BAD_INPUT', 'Unavailable Yahoo Shopping action');
  const row = source().methods[name]; let encoded; try { encoded = JSON.stringify(parameters); } catch { fail('E_BAD_INPUT', 'Invalid Yahoo parameters'); }
  if (!encoded || Buffer.byteLength(encoded) > 256 * 1024) fail('E_BAD_INPUT', 'Invalid or oversized Yahoo parameters');
  if (!validator) validator = new (require('@modelcontextprotocol/sdk/validation/ajv').AjvJsonSchemaValidator)();
  if (!checks.has(row)) checks.set(row, validator.getValidator(row.input_schema));
  if (!checks.get(row)(parameters).valid) fail('E_BAD_INPUT', 'Invalid Yahoo parameters; check the described fields and types');
  visit(row.input_schema, parameters, '', row);
  const p = JSON.parse(encoded), bound = row.risk === 'R' ? 100 : 10;
  const csvFields = ['item_code','image_id','file_name','quantity','allow_overdraft','stock_close','sort_priority_list','sort_order'];
  for (const key of csvFields) if (p.parameters?.[key] !== undefined && typeof p.parameters[key] === 'string') {
    const values = p.parameters[key].split(','); if (values.length > bound || ['item_code','image_id','file_name'].includes(key) && new Set(values).size !== values.length) fail('E_BAD_INPUT', 'Yahoo resource batch exceeds its host bound or repeats an identifier');
  }
  for (const key of ['subcodes','subcode_param','subcode_price']) if (p.parameters?.[key]?.split('|').length > bound) fail('E_BAD_INPUT', 'Yahoo variation batch exceeds its host bound');
  if (p.parameters?.items) {
    if (new Set(p.parameters.items.map(x => x.item_code)).size !== p.parameters.items.length) fail('E_BAD_INPUT', 'Duplicate Yahoo product in one update');
    for (const item of p.parameters.items) if ((item.price !== undefined) !== (item.sale_price !== undefined)) fail('E_BAD_INPUT', 'Yahoo requires price and sale_price together; use an empty sale_price to clear it');
  }
  if (row.source_id === 'setStock.html') {
    const keys = p.parameters.item_code.split(','), quantities = p.parameters.quantity.split(',');
    if (keys.length !== quantities.length || quantities.some(x => !/^[+-]?[0-9]{1,9}$/.test(x)) || keys.some(x => !/^[A-Za-z0-9-]{1,99}(?::[A-Za-z0-9-]{1,99})?$/.test(x))) fail('E_BAD_INPUT', 'Yahoo stock identifiers and quantities must correspond exactly');
    for (const key of ['allow_overdraft','stock_close']) if (p.parameters[key] !== undefined && p.parameters[key].split(',').length !== keys.length) fail('E_BAD_INPUT', 'Yahoo stock settings must correspond to every identifier');
  }
  if (row.source_id === 'orderList.html') {
    const search = p.body.Search; search.Result ??= 50; search.Start ??= 1;
    if (!search.Condition || !Object.keys(search.Condition).length) fail('E_BAD_INPUT', 'Choose a documented Yahoo order search condition');
  }
  if (row.source_id === 'subscription/list.html') {
    p.body ||= {}; p.body.countFrom ??= 1; p.body.countTo ??= p.body.countFrom + 99;
    if (p.body.countTo < p.body.countFrom || p.body.countTo - p.body.countFrom >= 100) fail('E_BAD_INPUT', 'Yahoo subscription reads are limited to 100 results per call');
  }
  if (p.query?.dateType && (!p.query.startDate || !p.query.endDate)) fail('E_BAD_INPUT', 'Yahoo question date filters require both timestamps');
  if (row.source_id === 'subscription/changerequest.html' && ((p.body.changeRequestType === 'item_switch') !== Boolean(p.body.afterItemId))) fail('E_BAD_INPUT', 'Yahoo item switching requires afterItemId; price changes must omit it');
  let count = 0; const countItems = value => { if (Array.isArray(value)) { count += value.length; value.forEach(countItems); } else if (object(value)) Object.values(value).forEach(countItems); }; countItems(p.body);
  if (row.risk !== 'R' && count > 10) fail('E_BAD_INPUT', 'Yahoo nested mutations are limited to 10 entries per call');
  let route = row.route; for (const [key, value] of Object.entries(p.path || {})) route = route.replace('{' + key + '}', encodeURIComponent(value));
  for (const pointer of row.seller_fields) { const keys = pointer.split('.'); at(p, keys.slice(0,-1), true)[keys.at(-1)] = config.metadata.seller_id; }
  if (p.body?.Target?.Field) p.body.Target.Field = p.body.Target.Field.join(',');
  if (p.body?.Search?.Field) p.body.Search.Field = p.body.Search.Field.join(',');
  if (p.parameters?.items) { const items = p.parameters.items; delete p.parameters.items; items.forEach((item, index) => { p.parameters['item' + (index + 1)] = new URLSearchParams(Object.entries(item).map(([k,v])=>[k,String(v)])).toString(); }); }
  return { row, route, p };
}
function parseJson(text) {
  return JSON.parse(text.replace(/"(?:\\.|[^"\\])*"|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/g, token => {
    if (token.startsWith('"')) return token;
    const value = Number(token);
    if (/^-?[0-9]+$/.test(token) && !Number.isSafeInteger(value)) return JSON.stringify(token);
    if (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value)) fail('E_TOOL_CALL_UPSTREAM', 'Unsupported Yahoo numeric representation');
    return token;
  }));
}
const secretKeys = new Set(['access_token','refresh_token','client_secret','public_key','authorization']);
function clean(value, secrets, depth = 0, diagnostic = false) {
  if (depth > 40) fail('E_TOOL_CALL_UPSTREAM', 'Excessively nested Yahoo response');
  if (typeof value === 'string') { for (const secret of secrets) value = value.split(secret).join('[redacted]'); return value; }
  if (Array.isArray(value)) return value.map(v => clean(v,secrets,depth+1,diagnostic));
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !secretKeys.has(key.toLowerCase()) && key !== 'ErrorMsg' && (!diagnostic || !['Message','Detail','message','detail','title'].includes(key))).map(([key,v])=>[key,clean(v,secrets,depth+1,diagnostic||['Error','Warning','error','errors'].includes(key))]));
}
function examine(data, httpStatus, row) {
  if (!object(data) && !Array.isArray(data)) fail('E_TOOL_CALL_UPSTREAM', 'Yahoo returned incomplete business data');
  const root = data.ResultSet || data.Result || data;
  if (row.encoding !== 'json' && !data.ResultSet && !data.Result) fail('E_TOOL_CALL_UPSTREAM', 'Yahoo omitted its response envelope');
  const rows = list(root.Result); const receipts = rows.length ? rows : [root];
  let partial = httpStatus === 207 || Boolean(data.error || data.Error || root.Error || root.Status === 'NG');
  for (const receipt of receipts) if (receipt?.Status === 'NG' || receipt?.Error || receipt?.ErrorCode) partial = true;
  if (row.risk === 'R') { if (partial) fail('E_TOOL_CALL_UPSTREAM','Yahoo rejected the read; check merchant permissions or query parameters'); return { data }; }
  if (row.encoding === 'json') {
    if (root.error || root.errors || root.result === 'NG') partial = true;
    const acknowledged = root.status === 'ok' || root.result === 'OK' || typeof root.topicid === 'string' && root.topicid.length > 0;
    if (!partial && !acknowledged) fail('E_TOOL_CALL_UPSTREAM','Yahoo omitted the mutation acknowledgement; inspect the shop before retrying');
  } else if (row.source_id !== 'setStock.html' && !partial && !receipts.every(r => r.Status === 'OK')) fail('E_TOOL_CALL_UPSTREAM','Yahoo omitted the mutation acknowledgement; inspect the shop before retrying');
  return { status: partial ? 'partial_or_failed' : ['downloadRequest.html','reservePublish.html','submitItem.html'].includes(row.source_id) ? 'accepted' : 'acknowledged', data };
}
async function execute(config, name, parameters = {}) {
  const { row, route, p } = build(config,name,parameters); owner.validateBinding(config); await owner.ensureToken(config);
  if (row.source_id === 'setStock.html') {
    const keys = p.parameters.item_code.split(',');const current=await owner.request(config,'getStock',{seller_id:config.metadata.seller_id,item_code:p.parameters.item_code},{post:true});const rows=list(current.data.ResultSet?.Result);
    const existing=keys.map(key=>rows.find(r=>(r.ItemCode+(r.SubCode?':'+r.SubCode:''))===key));
    if (rows.length!==keys.length || existing.some(r=>r?.Status!=='1'||!['0','1'].includes(r.AllowOverdraft)))fail('E_BAD_INPUT','Select existing Yahoo inventory before updating stock');
    p.parameters.allow_overdraft ??= existing.map(r=>r.AllowOverdraft).join(',');
  }
  const options={method:row.method,version:row.version,xml:row.encoding==='xml',json:row.encoding==='json',responseJson:row.encoding==='json',query:p.query||{},noBody:row.source_id==='question/fileDelete.html',parseJson,allowBusinessErrors:true};
  const payload=row.encoding==='xml'?{Req:p.body||{}}:row.encoding==='json'?(row.method==='GET'||options.noBody?p.query||{}:p.body||{}):p.parameters||{};
  const result=await owner.request(config,route,payload,options);const outcome=examine(result.data,result.http_status,row);
  if(row.risk==='R'){
    if(row.encoding!=='json') {const root=result.data.ResultSet;if(root&&!Object.hasOwn(root,'Result')&&!Object.hasOwn(root,'@totalResultsAvailable')&&!Object.hasOwn(root,'@totalResultsReturned'))fail('E_TOOL_CALL_UPSTREAM','Yahoo omitted resource data');}
    else {
      const fields={'getRealStock.html':['stocks','array'],'getRealStore.html':['stores','array'],'question/detail.html':['topic','object'],'question/list.html':['headlines','array'],'subscription/list.html':['results','array'],'subscription/historylist.html':['histories','array'],'subscription/origincount.html':['results','array'],'subscription/replica.html':['results','array']}[row.source_id];
      if(fields&&(fields[1]==='array'?!Array.isArray(result.data[fields[0]]):!object(result.data[fields[0]])))fail('E_TOOL_CALL_UPSTREAM','Yahoo omitted resource data');
      if(['subscription/detail.html','subscription/history.html'].includes(row.source_id)&&result.data.subscriptionId!==p.path.subscription_id)fail('E_TOOL_CALL_UPSTREAM','Yahoo returned a different subscription');
    }
  }
  if(row.source_id==='question/send.html'&&outcome.status!=='partial_or_failed'&&(result.data.topicid!==p.query.topicId||!['string','number'].includes(typeof result.data.messageid)||typeof result.data.postdate!=='string'))fail('E_TOOL_CALL_UPSTREAM','Yahoo omitted the message receipt; inspect the conversation before retrying');
  const ownerRows=row.source_id==='orderInfo.html'?list(result.data.ResultSet?.Result).flatMap(r=>list(r.OrderInfo)):row.source_id==='orderList.html'?list(result.data.Result?.Search?.OrderInfo):[];
  if(ownerRows.some(r=>r.SellerId!==undefined&&r.SellerId!==config.metadata.seller_id))fail('E_TOOL_CALL_AUTH','Yahoo returned a different seller; reconnect');
  const jsonOwnerRows=['getRealStock.html','getRealStore.html'].includes(row.source_id)?(result.data.stocks||result.data.stores||[]):['subscription/detail.html','subscription/history.html'].includes(row.source_id)?[result.data]:[];
  if(jsonOwnerRows.some(r=>r.sellerId!==undefined&&r.sellerId!==config.metadata.seller_id))fail('E_TOOL_CALL_AUTH','Yahoo returned a different seller; reconnect');
  const receiptRows=list(result.data.ResultSet?.Result);
  const batchReceipt={ 'deleteItemImage.html':['image_id','Id'], 'deleteLibImage.html':['file_name','Name'] }[row.source_id];
  if(batchReceipt){const expected=p.parameters[batchReceipt[0]].split(',');const returned=receiptRows.map(r=>r[batchReceipt[1]]);
    if(returned.length!==expected.length||new Set(returned).size!==returned.length||returned.some(key=>!expected.includes(key)))fail('E_TOOL_CALL_UPSTREAM','Yahoo omitted or mismatched batch receipts; inspect the shop before retrying');
  }
  const failedTargets={'updateItems.html':'ItemCode','setItemDisplayPriority.html':'ItemCode','sortCategories.html':'PageKey'}[row.source_id];
  if(failedTargets&&outcome.status==='partial_or_failed'){
    const expected=row.source_id==='updateItems.html'?Object.entries(p.parameters).filter(([k])=>/^item[0-9]+$/.test(k)).map(([,v])=>new URLSearchParams(v).get('item_code')):p.parameters[row.source_id==='sortCategories.html'?'sort_order':'sort_priority_list'].split(',').map(v=>v.split(':')[0]);
    if(receiptRows.some(r=>!expected.includes(r[failedTargets])))fail('E_TOOL_CALL_UPSTREAM','Yahoo returned a failure for an unrequested resource');
  }
  if(outcome.status==='accepted')outcome.follow_up=row.source_id==='downloadRequest.html'?{action:'yahoo.v1.downloadList',parameters:{parameters:{type:p.parameters.type}}}:{action:'yahoo.v1.publishHistorySummary',parameters:{parameters:{}}};
  if(row.source_id==='setStock.html'&&outcome.status!=='partial_or_failed'){
    const requested=p.parameters.item_code.split(','), receipts=list(result.data.ResultSet?.Result);
    if(receipts.length!==requested.length||receipts.some(r=>!requested.includes(r.ItemCode+(r.SubCode?':'+r.SubCode:''))||typeof r.Quantity!=='string'||(/^\d+$/.test(p.parameters.quantity.split(',')[requested.indexOf(r.ItemCode+(r.SubCode?':'+r.SubCode:''))])&&r.Quantity!==String(Number(p.parameters.quantity.split(',')[requested.indexOf(r.ItemCode+(r.SubCode?':'+r.SubCode:''))]))))||new Set(receipts.map(r=>r.ItemCode+':'+(r.SubCode||''))).size!==receipts.length)fail('E_TOOL_CALL_UPSTREAM','Yahoo returned incomplete stock acknowledgements; inspect the shop before retrying');
  }
  const secrets=['client_id','client_secret','access_token','refresh_token','public_key'].map(key=>config.credentials[key]).filter(value=>typeof value==='string'&&value);
  return {...clean(outcome,secrets),...(row.encoding==='xml'?{public_key_authorized:result.public_key_authorized}:{})};
}
module.exports={actionsFor,isNative,build,execute};
