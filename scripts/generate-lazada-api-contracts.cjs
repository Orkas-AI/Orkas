'use strict';

// Offline official definitions. Identifiers below are reviewed protocol names,
// not intent classifiers; unknown or duplicated operations stop generation.
const fs = require('node:fs');
const path = require('node:path');
const evidence = JSON.parse(fs.readFileSync(path.join(__dirname, '../test/fixtures/connectors/official-contracts/lazada-20260930.json'), 'utf8'));
const risks = {
  R: `
/shop/follow/status/batch/query /rc/store/list/get /seller/get /seller/metrics/get /seller/performance/get
/rc/warehouse/get /rc/warehouse/detail/get /sellercenter/msg/list /seller/policy/fetch
/category/brands/query /category/attributes/get /product/category/suggestion/get /category/tree/get
/category/cascade/getNextCascadeProp /product/seller/item/getPreQcRules /product/content/score/get
/product/item/get /products/get /product/qc/alert/list /image/response/get /product/seller/item/limit
/size/chart/template/get /product/unfilled/attribute/get /product/pre/check
/product/global/extension /product/global/status/get /product/global/semi/recommend/price/get
/product/global/unfilled/attribute/get /product/global/semi/avaible/get
/review/seller/history/list /review/seller/list/v2 /store/custom/page/get /media/video/get /media/video/quota/get
/promotion/flexicombo/details /promotion/flexicombo/list /promotion/flexicombo/products/list
/promotion/voucher/get /promotion/vouchers/get /promotion/voucher/products/get
/promotion/freeshipping/deliveryoptions/get /promotion/freeshipping/get /promotion/freeshippings/get
/promotion/freeshipping/regions/get /promotion/freeshipping/products/get /activity/early/bird/isWhitelistSeller
/order/document/get /orders/items/get /order/get /order/items/get /orders/get /orders/ovo/get /order/reverse/cancel/validate
/order/reverse/return/detail/list /order/reverse/return/history/list /order/reverse/reason/list /reverse/getreverseordersforseller
/order/shipment/providers/get /order/package/document/get /logistic/order/trace
/finance/payout/status/get /finance/transaction/accountTransactions/query /lbs/slb/queryLogisticsFeeDetail /finance/transaction/details/get
/fbl/inbound_reservation/check /fbl/channel_stocks/get /fbl/fulfillment_products/get /fbl/fulfillment_sku_list/get
/fbl/fulfillment_sku_relation/get_by_sc_item /fbl/fulfillment_sku_relation/get_by_sku
/fbl/fulfillment_sku_relation/get_by_sc_items /fbl/fulfillment_sku_relation/get_by_skus
/fbl/icp_order/file /fbl/inbound_order_detail/get /fbl/inbound_orders/get /fbl/inbound_reservation/file
/fbl/inventory_changed_sku/get /fbl/inventory_occupy_details/get /fbl/inventory_operate_log/get
/fbl/outbound_order_detail/get /fbl/outbound_orders/get /fbl/platform_products/get2 /fbl/product_batch/query
/fbl/shipper/get /fbl/stock_rule/get /fbl/vas/getVasOrderByNo /fbl/warehouses/get /fbl/stocks/get /fbl/stocks/getV3
/fbl/icp_warehouse/list /fbl/fulfillment_order_list/get /fbl/inbound_batch/query /fbl/inbound_reservation/get /fbl/reverse_order/get
/im/message/list /im/session/get /im/session/list
/sponsor/solutions/account/getAccountSignInfo /sponsor/solutions/wallet/getAutoTopUpOptionOneConfig
/sponsor/solutions/campaign/getCampaign /sponsor/solutions/campaign/getCampaignCount
/sponsor/solutions/report/getDiscoveryReportAdgroup /sponsor/solutions/report/getDiscoveryReportAudience
/sponsor/solutions/report/getDiscoveryReportCampaign /sponsor/solutions/report/getDiscoveryReportKeyword
/sponsor/solutions/account/getLatestSignInfo /sponsor/solutions/report/getReportCampaignOnPrePlacement
/sponsor/solutions/report/getReportOverview /sponsor/solutions/report/getReportOverviewMetric
/sponsor/solutions/category/listCategory /sponsor/solutions/keyword/listKeywordByAdgroup /sponsor/solutions/keyword/listKeywordByItem
/sponsor/solutions/adgroup/searchAdgroupList /sponsor/solutions/campaign/searchCampaignList
/sponsor/solutions/keyword/searchKeyword /sponsor/solutions/product/searchProductWithPage
/choice/product/item/get /choice/products/get /choice/seller/get /choice/sku_item_relation/get_by_sku
/jit/purchase_order/print /pickup_order/print /jit/purchase_order/query_list /jit/purchase_order/query_list_purchase_item /pickup_order/query
/promotion/storeflashsale/get /promotion/storeflashsale/list`,
  W: `/size/chart/batch/update /image/migrate /images/migrate /image/upload
/media/video/block/create /media/video/block/upload /media/video/block/commit /im/session/open /im/session/read`,
  H: `
/rc/sellerWarehouse/saveWarehouseInfo /product/stock/sellable/adjust /product/create /images/set
/product/price_quantity/update /product/update /product/stock/sellable/update
/product/global/create /product/global/semi/update /product/global/semi/upgrade /product/global/attribute/update
/review/seller/reply/add
/promotion/flexicombo/activate /promotion/flexicombo/products/add /promotion/flexicombo/create /promotion/flexicombo/update
/promotion/voucher/activate /promotion/voucher/product/sku/add /promotion/voucher/create /promotion/voucher/update
/promotion/freeshipping/activate /promotion/freeshipping/product/sku/add /promotion/freeshipping/create /promotion/freeshipping/update
/activity/early/bird/create/v2 /activity/early/bird/addSkus/v2
/order/invoice_number/set /order/reverse/onlyrefund/seller/decide /order/reverse/return/update
/order/package/sof/collect /order/package/sof/delivered /order/digital/delivered
/order/package/sof/failed_delivery /order/fulfill/pack /order/package/sof/status/update /order/package/rts /order/package/repack
/fbl/fulfillment_sku_relation/write /fbl/fulfillment_order/create /fbl/fulfillment_order_pnf/create
/fbl/fulfillment_sku/create /fbl/fulfillment_sku_fbl/create /fbl/inbound_order/create
/fbl/inbound_reservation/create /fbl/outbound_order/create /fbl/product_reinbound/create /fbl/vas/createVasOrder
/fbl/returns/create /fbl/stock_rule/set /fbl/fulfillment_sku/update /fbl/waybill/upload /im/message/send
/sponsor/solutions/adgroup/addAdgroupBatch /sponsor/solutions/addSolution
/sponsor/solutions/adgroup/updateAdgroupBatch /sponsor/solutions/campaign/updateCampaign
/jit/purchase_order/batch_pickup_deliver /choice/stock/edit /jit/purchase_order/package
/promotion/storeflashsale/activate /promotion/storeflashsale/create /promotion/storeflashsale/update`,
  D: `
/product/deactivate /product/remove /product/sku/remove /product/global/delete /product/global/update/status /media/video/remove
/promotion/flexicombo/deactivate /promotion/flexicombo/products/delete
/promotion/voucher/product/sku/remove /promotion/voucher/deactivate
/promotion/freeshipping/deactivate /promotion/freeshipping/product/sku/remove /activity/early/bird/deactivateSkus/v2
/order/reverse/cancel/create /order/reverse/cancel/seller/decide
/fbl/fulfillment_order/cancel /fbl/inbound_reservation/cancel /fbl/inbound_order/cancel /fbl/outbound_order/cancel
/fbl/vas/cancelVasOrder /fbl/fulfillment_sku_relation/remove /fbl/returns/cancel /im/message/recall
/sponsor/solutions/adgroup/deleteAdgroupBatch /sponsor/solutions/campaign/deleteCampaign /promotion/storeflashsale/deactivate`,
};
const riskByPath = new Map();
for (const [risk, list] of Object.entries(risks)) for (const name of list.trim().split(/\s+/)) {
  if (riskByPath.has(name)) throw new Error('Duplicate risk assignment: ' + name);
  riskByPath.set(name, risk);
}
const text = (html = '') => html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const fileSchema = { type: 'object', properties: {
  name: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]*$' },
  content_base64: { type: 'string', minLength: 4, maxLength: 256 * 1024, pattern: '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$' },
}, required: ['name','content_base64'], additionalProperties: false, description: 'Canonical base64 inline file; total action parameters must fit 256 KiB. Local files and arbitrary download requests are not accepted.' };
function fields(rows, apiPath) {
  const s = { type: 'object', properties: {}, required: [], additionalProperties: false };
  for (const row of rows) {
    if (!row.name || Object.hasOwn(s.properties,row.name)) throw new Error('Unknown or duplicate input field');
    s.properties[row.name] = field(row, apiPath);
    if (row.required === true) s.required.push(row.name);
  }
  return s;
}
function field(row, apiPath) {
  let s;
  if (row.type === 'byte[]') s = structuredClone(fileSchema);
  else if (row.type === 'Object' || row.type === 'Object[]') {
    if (!row.children.length) {
      if (apiPath !== '/product/global/status/get' || row.name !== 'params') throw new Error('Unestablished input object');
      // Official request example and java.util.Map<String,String> agree on the
      // single sellerSku selector; do not accept an arbitrary request map.
      s = fields([{ name: 'sellerSku', type: 'String', required: true, children: [], desc: 'Seller SKU selector from the official example.' }], apiPath);
    } else s = fields(row.children,apiPath);
  } else if (row.type === 'Number' || row.type === 'Number[]') s = { type: 'number', minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER };
  else if (row.type === 'String' || row.type === 'String[]' || row.type === 'Payload') s = { type: 'string', maxLength: 256 * 1024 };
  else if (row.type === 'Boolean') s = { type: 'boolean' };
  else throw new Error('Unknown input type: ' + row.type);
  if (text(row.desc)) s.description = text(row.desc);
  if (row.type.endsWith('[]') && row.type !== 'byte[]') s = { type: 'array', items: s, maxItems: 100, description: s.description || '' };
  return s;
}
const contracts = { documentation_snapshot: evidence.documentation_snapshot, scope: evidence.scope, methods: {}, unavailable_methods: {} };
for (const row of evidence.inventory) {
  if (row.unavailable_reason) { contracts.unavailable_methods[row.path] = row.unavailable_reason; continue; }
  const d = evidence.definitions[row.path], risk = riskByPath.get(row.path);
  if (!d || !risk || d.chargeable) throw new Error('Unreviewed or paid operation: ' + row.path);
  const advertised = row.published_method.toUpperCase();
  if (!['GET','POST','GET/POST'].includes(advertised)) throw new Error('Unknown HTTP method');
  const method = advertised === 'GET/POST' ? (risk === 'R' ? 'GET' : 'POST') : advertised;
  const parameters = fields(d.parameters.data,row.path);
  const input = { type: 'object', properties: { parameters }, required: parameters.required.length ? ['parameters'] : [], additionalProperties: false };
  if (row.path === '/orders/get') {
    parameters.anyOf = [{ required: ['created_after'] },{ required: ['update_after'] }];
    parameters.properties.limit = { ...parameters.properties.limit, type: 'integer', minimum: 1, maximum: 100 };
    parameters.properties.offset = { ...parameters.properties.offset, type: 'integer', minimum: 0 };
    parameters.properties.sort_direction.enum = ['ASC','DESC']; parameters.properties.sort_by.enum = ['created_at','updated_at'];
    input.required = ['parameters'];
  }
  if (row.path === '/order/fulfill/pack') {
    const batch = parameters.properties.packReq.properties.pack_order_list; batch.minItems = 1; batch.maxItems = 20;
  }
  if (row.path === '/order/package/rts') { const batch=parameters.properties.readyToShipReq.properties.packages; batch.minItems=1;batch.maxItems=20; }
  if (row.path === '/rc/sellerWarehouse/saveWarehouseInfo') {
    for (const [key,value] of Object.entries({ ownerType:0,warehouseOwnerType:'SELLER',warehouseType:200,resourceType:1 })) parameters.properties[key].const=value;
    parameters.properties.warehouseAddressInfoDTO.properties.defaultAddress.const=0;
  }
  const outputs = d.output_parameters.data.map(item => ({ name:item.name,type:item.type,required:item.required===true }));
  const outcomes = [];
  let example = {};
  try { example = JSON.parse(d.response_example); } catch { /* Templates are not executable response fixtures. */ }
  const examplesAt = (value, cursor) => !cursor.length ? [value] : cursor[0] === '*'
    ? Array.isArray(value) ? value.flatMap(item => examplesAt(item,cursor.slice(1))) : []
    : value && typeof value === 'object' ? examplesAt(value[cursor[0]],cursor.slice(1)) : [];
  const inspectOutput = (rows, prefix = []) => {
    for (const item of rows) {
      const cursor = [...prefix,item.name];
      if (['success','not_success','item_err_code','error_code','err_code','result_code'].includes(item.name)) outcomes.push({ path:cursor, name:item.name, neutral_values: examplesAt(example,cursor).filter(value => value === 'null') });
      inspectOutput(item.children,[...cursor,...(item.type.endsWith('[]') ? ['*'] : [])]);
    }
  };
  inspectOutput(d.output_parameters.data);
  const multipart = d.parameters.data.some(item => item.type === 'byte[]');
  const note = risk === 'R' ? 'Read one explicit page; fulfillment/order data may include authorized customer contacts.'
    : 'Submission is an acknowledgement, not completion. Inspect results before retrying an uncertain write.';
  contracts.methods[`${method} ${row.path}`] = { id:d.id, path:row.path, method, risk, multipart,
    description:`${row.title}: ${text(d.description).slice(0,180)} ${note} Reference: ${row.source}`,
    input_schema:input, outputs, outcomes };
}
if (Object.keys(contracts.methods).length !== riskByPath.size) throw new Error('Risk inventory mismatch');
fs.writeFileSync(path.join(__dirname,'../bin/lazada-api-contracts.cjs'), "'use strict';\n\n// Pinned official seller contracts; regenerate with scripts/generate-lazada-api-contracts.cjs.\nmodule.exports = " + JSON.stringify(contracts,null,2) + ';\n');
