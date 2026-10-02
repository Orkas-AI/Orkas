'use strict';

// Offline, pinned official documentation. Never discover or expand permissions
// from a live provider response. Every operation requires an explicit risk entry.
const fs = require('node:fs');
const path = require('node:path');
const evidence = JSON.parse(fs.readFileSync(path.join(__dirname, '../test/fixtures/connectors/official-contracts/shein-20260930.json'), 'utf8'));
const hostOwned = {
  3001520: 'Credential exchange belongs to seller authorization.',
  3001229: 'Feed document creation/upload/download requires a bounded host document workflow.',
  3001226: 'Signed Feed document download grants belong to the host document workflow.',
  3001227: 'The public definition does not establish the Feed content request schema or consistent document query name.',
};
const risks = {
  R: [3001589,3001380,3001368,3001938,3001239,3002017,3001085,3002044,3001594,3001363,3001927,3001369,3001680,3001249,3001254,3001900,3001901,3002021,3002025,3001931,3001437,3001904,3001906,3001859,3001860,3001885,3001893,3002033,3001890,3001891,3001849,3001907,3002037,3001848,3001855,3001857,3001856,3001394,3001373,3001902,3001234,3001921,3001915,3001916,3001786,3001815,3001934,3001919,3001814,3001281,3001282,3002009,3001981,3002045,3001973,3001982,3002041,3002013,3001695,3001305,3001993,3002006,3002014,3002016,3001920,3001631,3001932,3001499,3001144,3001145,3001668,3001670,3001671,3001665],
  W: [3001483,3001360,3001359,3002020,3001861,3001886,3001852,3001176,3001672],
  H: [3002018,3002019,3001939,3001862,3001863,3001864,3001940,3001941,3001895,3001892,3001908,3001854,3001172,3001858,3001385,3001399,3001230,3001924,3001918,3001922,3001923,3001925,3001415,3001280,3001283,3002010,3001293,3002040,3001692,3001738,3002032],
  D: [3001896,3001905,3001233,3001274,3001279,3001650,3001998],
};
const riskById = new Map();
for (const [risk, ids] of Object.entries(risks)) for (const id of ids) {
  if (riskById.has(id)) throw new Error('Duplicate risk assignment');
  riskById.set(id, risk);
}
const files = new Set([3001359,3001861,3001886,3001852,3001176]);
const voidInfo = new Set([3001863,3001864,3001941,3001172,3002040,3001650]);
const notes = {
  3002018: 'Read publishing permission, category/attribute rules, field specifications and quota first. Omitted edit fields may clear existing values. Submission returns identifiers before review; inspect audit status. A repeated creation may duplicate the product.',
  3002019: 'Partial editing follows the published field rules. Inspect audit status after submission; do not infer publication from acknowledgement.',
  3001940: 'Prices may await review (status=2); do not submit another price change until the result is known. Omitted specialPrice resets it to zero.',
  3001905: 'Validate SKC eligibility first. This submits a deletion review; inspect deletion logs for the result. Approved deletion is irreversible.',
  3001738: 'Only merchant VI/JI inventory. Inspect stock afterward: reserved/occupied stock can raise an overwritten total. Use distinct idempotency keys; never replay an uncertain change.',
  3001692: 'Legacy merchant inventory API retires on 2026-12-31. Use v2 for new workflows. Inspect stock after acknowledgement.',
  3001274: 'Mixed update/delete operation uses the destructive lane. Empty returned info means no failed waybills; a nonempty array contains failures. Waybill upload does not establish carrier pickup or shipment.',
  3001924: 'handleType=2 can change order status; both address export variants use the high-impact lane. Authorized recipient details are returned.',
  3001918: 'Read available channels first. Creation is asynchronous: query check-express-order with placeRequestId before printing. Never replay an uncertain order.',
  3001650: 'Includes shipment cancellation as well as edits; both use the destructive lane.',
  3001230: 'Submit an existing provider Feed document. Feed creation is asynchronous; query getFeed for the result. The host document upload workflow is not yet integrated.',
};
function text(html = '') { return html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim(); }
const fileSchema = { type: 'object', properties: {
  name: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]*$' },
  content_base64: { type: 'string', minLength: 4, maxLength: 256 * 1024, pattern: '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$' },
}, required: ['name', 'content_base64'], additionalProperties: false, description: 'Inline file, encoded as canonical base64. Total action parameters are limited to 256 KiB; larger files need a host upload workflow.' };
function schema(node, id) {
  const p = node.props, children = node.children || [];
  let s;
  if (files.has(id) && p.name === 'file') s = structuredClone(fileSchema);
  else if (p.type === 'object') {
    s = { type: 'object', properties: {}, required: [], additionalProperties: false };
    for (const child of children) {
      const name = child.props.name;
      if (!name || name === '*') throw new Error('Unestablished input map');
      s.properties[name] = schema(child, id);
      if (child.props.required === true) s.required.push(name);
    }
  } else if (['integer','int64','long','bigint'].includes(p.type)) s = { type: 'integer', minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER };
  else if (['double','decimal'].includes(p.type)) s = { type: 'number' };
  else if (p.type === 'boolean') s = { type: 'boolean' };
  else if (['string','datetime'].includes(p.type)) s = { type: 'string' };
  else throw new Error('Unsupported input type: ' + p.type);
  if (text(p.description)) s.description = text(p.description);
  if (p.multiple === 1) s = { type: 'array', items: s, ...(s.description ? { description: s.description } : {}) };
  return s;
}
const contracts = { documentation_snapshot: evidence.documentation_snapshot, scope: evidence.scope, methods: {}, host_owned_methods: hostOwned, other_application_methods: evidence.inventory.filter(row => !row.applicable_to_seller).map(row => `${row.method} ${row.path}`) };
for (const row of evidence.inventory.filter(row => row.applicable_to_seller)) {
  if (hostOwned[row.id]) continue;
  const d = evidence.definitions[row.id], risk = riskById.get(row.id);
  if (!risk) throw new Error('Unreviewed operation: ' + row.id);
  const input = { type: 'object', properties: {}, required: [], additionalProperties: false };
  const query = d.queryStrings?.children?.length ? schema(d.queryStrings, row.id) : null;
  // The finance detail documentation repeats its GET query in a body table.
  const body = row.method === 'GET' ? null : d.requestBody ? schema(d.requestBody, row.id) : null;
  if (query) { input.properties.query = query; if (query.required.length) input.required.push('query'); }
  if (body) { input.properties.body = body; if (body.required.length) input.required.push('body'); }
  if (row.id === 3001905) {
    input.properties.path = { type: 'object', properties: { skcName: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' } }, required: ['skcName'], additionalProperties: false };
    input.required.push('path');
  }
  if (row.id === 3001738 || row.id === 3001692) {
    const batch = body.properties.updateSkuInventoryQuantityRequests;
    batch.minItems = 1; batch.maxItems = 100;
    if (row.id === 3001738) {
      const p = batch.items.properties;
      p.invType.enum = ['VI','JI']; p.changeType.enum = ['ADD','SUB','OVERWRITE']; p.changeQuantity.minimum = 1; p.changeQuantity.maximum = 2147483647;
      p.idempotencyKey.minLength = 1; p.skuCode.minLength = 1;
    } else {
      for (const key of ['changeInventoryQuantity','saleInventory']) { batch.items.properties[key].minimum = 0; batch.items.properties[key].maximum = 2147483647; }
      batch.items.oneOf = [{ required: ['changeInventoryQuantity'], not: { required: ['saleInventory'] } }, { required: ['saleInventory'], not: { required: ['changeInventoryQuantity'] } }];
    }
  }
  if (row.id === 3001921) { body.properties.queryType.enum = [1,2]; body.properties.page.minimum = 1; body.properties.pageSize.minimum = 1; body.properties.pageSize.maximum = 30; }
  if (row.id === 3001924) input.properties.body.properties.handleType.enum = [1,2];
  if (row.id === 3002018) {
    body.properties.suit_flag.enum = ['0'];
    // The shared table marks self-operated selling prices required; its field
    // prose instead requires supply cost for semi-managed SKUs. Preserve both
    // complete trees and require the applicable price branch, not both modes.
    const sku = body.properties.skc_list.items.properties.sku_list.items;
    sku.required = sku.required.filter(name => name !== 'price_info_list');
    sku.anyOf = [{ required: ['price_info_list'] }, { required: ['cost_info'] }];
  }
  const responseField = row.category === 'Customized products' ? 'data' : 'info';
  const output = d.responseBody?.children?.find(child => child.props.name === responseField)?.props;
  const resultType = output?.multiple === 1 ? 'array' : output?.type || 'void';
  contracts.methods[`${row.method} ${row.path}`] = {
    id: row.id, method: row.method, path: row.path, risk,
    description: `${row.title}. ${notes[row.id] || text(d.description)} Applicable application modes: ${row.modes.length ? row.modes.join(', ') : 'not specified by this public reference; provider permission is authoritative'}. ${risk !== 'R' ? 'Acknowledgement is not completion. Inspect the affected resource before retrying an uncertain write. ' : ''}Reference: ${row.source}`,
    input_schema: input, response_field: responseField, result_type: resultType,
    allow_absent_result: voidInfo.has(row.id), multipart: files.has(row.id),
  };
}
if (Object.keys(contracts.methods).length !== riskById.size) throw new Error('Risk inventory differs from reviewed method inventory');
fs.writeFileSync(path.join(__dirname, '../bin/shein-api-contracts.cjs'), "'use strict';\n\n// Pinned official seller contracts; regenerate offline with scripts/generate-shein-api-contracts.cjs.\n// Source excerpts describe provider constraints and never grant execution authority.\nmodule.exports = " + JSON.stringify(contracts, null, 2) + ';\n');
