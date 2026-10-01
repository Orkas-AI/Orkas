'use strict';
const fs = require('node:fs'), path = require('node:path');
const evidence = require('../test/fixtures/connectors/official-contracts/futureshop-20261001.json');
const names = {
  productsSearch: 'products.search', inventorySearch: 'inventory.search', inventoryRefresh: 'inventory.update', inventoryrealstoreRefresh: 'inventory.realstore.update', inventoryrealstoreDelete: 'inventory.realstore.clear',
  orderdata: 'orders.search', orderdataRequest: 'orders.get', shippingStatus: 'orders.shipping', payment: 'orders.payment', orderStatusComplete: 'orders.complete',
  realstoreRequest: 'stores.get', realstoreRegist: 'stores.create', realstoreEdit: 'stores.update', realstoreDelete: 'stores.delete',
  memberSearch: 'members.search', memberRegist: 'members.create', memberEdit: 'members.update', memberDelete: 'members.delete',
  pointsHistory: 'points.history', pointsstatusRefresh: 'points.status', adjustpointsRegist: 'points.adjust', pointsUse: 'points.use', pointsDelete: 'points.delete',
};
const object = () => ({ type: 'object', properties: {}, additionalProperties: false });
const string = (maxLength = 65536) => ({ type: 'string', maxLength });
const integers = (digits = 9) => ({ type: 'integer', minimum: 0, maximum: Math.min(Number.MAX_SAFE_INTEGER, 10 ** digits - 1) });
const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const dateTime = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}$' };
const csv = (values, maxLength = 4096) => ({ type: 'string', minLength: 1, maxLength, ...(values ? { pattern: '^(' + values.join('|') + ')(,(' + values.join('|') + '))*$' } : {}) });
const enums = { gender: ['UNSPECIFIED', 'MALE', 'FEMALE'], newsletter: ['YES', 'NO'], mobileNewsletter: ['YES', 'NO'], directMail: ['YES', 'NO'], registrationPointsEnabled: ['YES', 'NO'], memberStageAutoConfig: ['ON', 'OFF'], expirationDateStatus: ['EXTEND', 'NOT_EXTEND'], operation: ['VALID', 'VALID_CANCEL', 'INVALID', 'INVALID_CANCEL', 'SUSPENDED', 'SUSPENDED_CANCEL'], shippingStatus: ['notShipped', 'shipped'], paymentStatus: ['notReceived', 'received'], pointsStatus: ['INVALID', 'SUSPENDED', 'EXPIRED', 'USED', 'VALID', 'PENDING'], areaCode: ['HOKKAIDO', 'TOHOKU', 'KANTO', 'CHUBU', 'KANSAI', 'CHUGOKU', 'SHIKOKU', 'KYUSHU', 'OKINAWA', 'OTHER'] };
const prefectures = ['HOKKAIDO','AOMORI','AKITA','IWATE','MIYAGI','YAMAGATA','FUKUSHIMA','IBARAKI','TOCHIGI','GUNMA','SAITAMA','CHIBA','KANAGAWA','TOKYO','YAMANASHI','NIIGATA','NAGANO','SHIZUOKA','AICHI','MIE','GIFU','TOYAMA','ISHIKAWA','FUKUI','OSAKA','KYOTO','SHIGA','NARA','WAKAYAMA','HYOGO','OKAYAMA','HIROSHIMA','YAMAGUCHI','TOTTORI','SHIMANE','KAGAWA','TOKUSHIMA','EHIME','KOCHI','FUKUOKA','SAGA','NAGASAKI','KUMAMOTO','OITA','MIYAZAKI','KAGOSHIMA','OKINAWA','OTHER'];
const methods = {};
for (const op of evidence.operations) {
  const input = object(), byteLimits = {}, id = op.source_id;
  const risk = op.method === 'GET' ? 'R' : op.method === 'DELETE' || id === 'inventoryrealstoreDelete' ? 'D' : 'H';
  for (const table of op.request_tables) {
    const location = table.heading.includes('ボディ') ? 'body' : 'query';
    const root = input.properties[location] ||= object(), stack = [{ depth: -1, schema: root, path: location }];
    for (let i = 0; i < table.fields.length; i++) {
      const field = table.fields[i], key = field.key, next = table.fields[i + 1];
      while (stack.at(-1).depth >= field.depth) stack.pop();
      const parent = stack.at(-1), fieldPath = parent.path + '.' + key;
      let schema;
      const limit = /^\d+$/.test(field.limit || '') ? Number(field.limit) : undefined;
      if (field.type === 'Array' || key === 'realStoreList') schema = { type: 'array', minItems: 1, maxItems: risk === 'R' ? 100 : 10, items: object() };
      else if (next && next.depth > field.depth) schema = object();
      else if (field.type === 'Boolean') schema = { type: 'boolean' };
      else if (field.type === 'Number') schema = integers(limit);
      else if (field.type === 'Number String') schema = { anyOf: [integers(9), { type: 'string', pattern: '^[+-]?[0-9]{1,9}$' }] };
      else schema = string(limit);
      if (enums[key]) schema.enum = enums[key];
      if (key === 'prefecture') schema.enum = prefectures.filter((x, i, a) => a.indexOf(x) === i);
      if (key === 'points') Object.assign(schema, { minimum: 1 });
      if (field.description.includes('yyyy-mm-ddThh:mm:ss')) schema = { ...schema, ...dateTime };
      else if (field.description.includes('yyyy-mm-dd')) schema = { ...schema, ...date };
      if (['receiptDate', 'expectedArrival', 'shippingDate'].includes(key)) schema = { anyOf: [date, { const: '' }] };
      if (key === 'zipCode' && id.startsWith('member')) schema = { type: 'string', maxLength: 8, pattern: '^(|[0-9]{3}-[0-9]{4})$' };
      if (key === 'types') schema = csv(id === 'inventorySearch' ? ['regular', 'preorder', 'planned', 'realstore'] : ['option', 'variation', 'optionPrice', 'subscription', 'preorder', 'image', 'comment', 'plannedStock', 'stockNotification']);
      if (location === 'query' && ['productNo','mainGroupUrl','janCode','memberId','orderNo'].includes(key) && op.method === 'GET') schema = csv();
      if (id === 'productsSearch' && key === 'count') schema = { type: 'integer', minimum: 50, maximum: 100, default: 50, description: 'One page; host read limit 100 (upstream permits up to 250).' };
      if (key === 'cursor') schema = { ...string(2048), minLength: 1, description: 'Use next_cursor with the same filters; no automatic pagination.' };
      if (field.type === 'Text') schema.maxLength = key === 'storePickupMail' ? 1000 : key.startsWith('storePickup') || key === 'htmlComment' ? 16000 : 65536;
      if (field.type === 'Number String') schema.description = 'Integer or unsigned decimal string replaces stock; signed strings increment/decrement it. At most 9 digits; never automatically retry.';
      if (field.required && schema.type === 'string' && ['productNo', 'orderNo', 'memberId', 'pointId', 'mail', 'storeCode', 'storeName'].includes(key)) schema.minLength = 1;
      schema.description ||= key + (limit ? `; maximum ${limit} ${table.units === 'bytes' ? 'UTF-8 bytes' : 'characters'}.` : '.');
      if (schema.type === 'string' && table.units === 'bytes' && limit) byteLimits[fieldPath] = limit;
      parent.schema.properties[key] = schema;
      if (field.required) (parent.schema.required ||= []).push(key);
      if (schema.type === 'array') stack.push({ depth: field.depth, schema: schema.items, path: fieldPath + '.*' });
      else if (schema.type === 'object') stack.push({ depth: field.depth, schema, path: fieldPath });
    }
    if (location === 'body' || root.required?.length) (input.required ||= []).push(location);
  }
  const pathFields = [...op.path.matchAll(/\{([^}]+)\}/g)].map(match => match[1]);
  if (pathFields.length) {
    const p = input.properties.path = object();
    for (const key of pathFields) p.properties[key] = { type: 'string', minLength: 1, maxLength: { memberId: 20, orderNo: 12, storeCode: 10, apiId: 16 }[key], pattern: key === 'memberId' ? '^[0-9]+$' : '^[A-Za-z0-9_-]+$' };
    p.required = pathFields; (input.required ||= []).push('path');
  }
  if (['inventorySearch','memberSearch','pointsHistory'].includes(id)) (input.properties.query ||= object()).properties.cursor = { ...string(2048), minLength: 1, description: 'Use next_cursor with the same filters.' };
  const sideEffects = id === 'pointsDelete' ? ' Deletes the original points history; any extended expiry remains extended.' : id === 'adjustpointsRegist' ? ' EXTEND can extend other valid points; no idempotency key is supported.' : id === 'payment' ? ' Updates futureshop receipt state only; does not capture funds with an external payment processor.' : id === 'inventoryrealstoreDelete' ? ' Omitting inventoryInfo clears all physical-store stock for the listed products.' : '';
  const description = 'futureshop ' + names[id].replaceAll('.', ' ') + '.' + sideEffects + ' ' + op.conditions.join(' ') + (risk === 'R' ? ' Reads one response only.' : ' Never automatically retry an uncertain mutation.');
  methods['futureshop.' + names[id]] = { source_id: id, path: op.path, method: op.method, risk, description, input_schema: input, byte_limits: byteLimits, source_url: op.source_url };
}
if (Object.keys(methods).length !== 23) throw new Error('Unexpected futureshop inventory');
fs.writeFileSync(path.resolve(__dirname, '../bin/futureshop-api-contracts.cjs'), "'use strict';\n// Generated from frozen official tables by scripts/generate-futureshop-api-contracts.cjs.\nmodule.exports=" + JSON.stringify({ methods }) + ';\n');
console.log(JSON.stringify({ operations: Object.keys(methods).length }));
