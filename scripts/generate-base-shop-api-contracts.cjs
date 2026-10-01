'use strict';

// Frozen official parameter tables and reviewed scalar contracts; no live discovery.
const fs = require('node:fs'), path = require('node:path');
const evidence = require('../test/fixtures/connectors/official-contracts/base-shop-20261001.json');
const str = (description, minLength = 0) => ({ type: 'string', minLength, maxLength: 65536, description });
const int = (minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => ({ type: 'integer', minimum, maximum });
const id = { anyOf: [int(1), { type: 'string', minLength: 1, maxLength: 128, pattern: '^[1-9][0-9]*$' }], description: 'Exact positive identifier; use a decimal string for integers larger than JavaScript safe range.' };
const enums = values => ({ enum: values });
const array = items => ({ type: 'array', items, minItems: 1, maxItems: 10, description: 'Host high-impact/destructive operation limit: 10 variation entries per call.' });
const scalar = {
  item_id: id, category_id: id, item_category_id: id, variation_id: id,
  title: str('Product title; the API rejects four-byte Unicode characters.', 1), detail: str('Product description; the API rejects four-byte Unicode characters.'),
  name: str('Category name.', 1), price: int(), stock: int(), variation_stock: int(), item_tax_type: enums([1, 2]), visible: enums([0, 1]),
  identifier: { ...str('Merchant product code; ASCII and full-width spaces are not supported.'), pattern: '^[^ \\u3000]*$' }, list_order: int(), parent_number: int(),
  image_no: int(1, 20), image_url: { ...str('Public jpg/png/gif URL, image at most 4 MB. Resized images are generated asynchronously.', 1), maxLength: 8192, pattern: '^https?://' },
  q: str('Search this shop; space-separated keywords. Search indexing can lag by up to one hour.', 1),
  fields: { ...str('Comma-separated search fields.'), pattern: '^(title|detail|categories|shop_name)(,(title|detail|categories|shop_name))*$' },
  sort: enums(['asc', 'desc']), limit: { ...int(1, 100), default: 20 }, offset: { ...int(), default: 0 }, max_image_no: int(1, 20),
  image_size: { ...str('Comma-separated image sizes.'), pattern: '^(origin|76|146|300|500|640|sp_480|sp_640)(,(origin|76|146|300|500|640|sp_480|sp_640))*$' },
  start_ordered: { ...str('Inclusive order start date or local date-time.'), pattern: '^\\d{4}-\\d{2}-\\d{2}( \\d{2}:\\d{2}:\\d{2})?$' },
  end_ordered: { ...str('Inclusive order end date or local date-time.'), pattern: '^\\d{4}-\\d{2}-\\d{2}( \\d{2}:\\d{2}:\\d{2})?$' },
};
const required = {
  '/items/add': ['title', 'price', 'stock'], '/items/edit': ['item_id'], '/items/delete': ['item_id'],
  '/items/add_image': ['item_id', 'image_no', 'image_url'], '/items/delete_image': ['item_id', 'image_no'],
  '/items/edit_stock': ['item_id'], '/items/delete_variation': ['item_id', 'variation_id'],
  '/categories/add': ['name'], '/categories/edit': ['category_id'], '/categories/delete': ['category_id'],
  '/item_categories/add': ['item_id'], '/item_categories/delete': ['item_category_id'], '/items/search': ['q'],
};
const descriptions = {
  '/users/me': 'Read the connected BASE shop profile.', '/items': 'Read one page of products with visibility, image and category filters.',
  '/items/search': 'Search products in this shop; index updates can take up to one hour.', '/items/detail/:item_id': 'Read a product with variations and options.',
  '/items/add': 'Create a product with ordered variations. Daily creation limit: 1000. Never automatically retry an uncertain creation.',
  '/items/edit': 'Update a product. Empty variation IDs add variations; omitted variations are retained. All existing IDs reorder variations; a partial list does not.',
  '/items/delete': 'Delete a product.', '/items/add_image': 'Attach a product image from its public URL; image transformations are asynchronous.',
  '/items/delete_image': 'Delete one product image.', '/items/edit_stock': 'Replace product or variation stock after checking current variations.',
  '/items/delete_variation': 'Delete one product variation.', '/categories': 'Read all shop categories.', '/categories/add': 'Create a category under an optional parent number.',
  '/categories/edit': 'Update a category name or position.', '/categories/delete': 'Delete a category.',
  '/item_categories/detail/:item_id': 'Read category assignments for a product.', '/item_categories/add': 'Add a product category assignment.',
  '/item_categories/delete': 'Delete a product category assignment.', '/orders': 'Read one page of orders including buyer and payment business fields.',
  '/orders/detail/:unique_key': 'Read one complete order with buyer contact, shipping, payment and item details.', '/delivery_companies': 'Read supported delivery companies.',
};
const methods = {};
for (const entry of evidence.operations.filter(row => row.status === 'available_current_grant')) {
  const route = entry.path.slice(2), properties = {}, req = [...(required[route] || [])];
  for (const parameter of entry.parameters) {
    const name = parameter.name.replace('[0] ...', '');
    let schema = scalar[name];
    if (parameter.name.includes('[0]')) {
      schema = array(name === 'variation_id' ? { anyOf: [id, { const: '' }] } : name === 'variation_stock' ? int() : str('Variation value in corresponding array order.'));
    }
    if (name === 'order') schema = enums(route === '/items/search' ? ['list_order', 'modified'] : ['list_order', 'created', 'modified']);
    if (name === 'limit' && route === '/items/search') schema = { ...schema, default: 10 };
    if (name === 'offset' && route === '/items/search') schema = int(0, 10000);
    if (!schema) throw new Error('Unreviewed BASE parameter: ' + name);
    properties[name] = schema;
  }
  for (const [, name] of route.matchAll(/:([a-z_]+)/g)) { properties[name] = name === 'unique_key' ? { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' } : id; req.push(name); }
  const input = { type: 'object', properties, required: req, additionalProperties: false };
  if (route === '/items/edit_stock') input.oneOf = [
    { required: ['stock'], not: { anyOf: [{ required: ['variation_id'] }, { required: ['variation_stock'] }] } },
    { required: ['variation_id', 'variation_stock'], not: { required: ['stock'] } },
  ];
  const name = 'base.' + route.split('/').filter(Boolean).filter(part => !part.startsWith(':')).join('.');
  methods[name] = { path: route, method: entry.method, scope: entry.scope, risk: entry.method === 'GET' ? 'R' : route.includes('/delete') ? 'D' : 'H',
    description: descriptions[route] + (entry.method === 'POST' ? ' No automatic retry; inspect the shop after an uncertain response.' : ''),
    input_schema: input, source_url: entry.source_url };
}
if (Object.keys(methods).length !== 21) throw new Error('BASE inventory changed; review before regeneration');
fs.writeFileSync(path.resolve(__dirname, '../bin/base-shop-api-contracts.cjs'), "'use strict';\n// Generated by scripts/generate-base-shop-api-contracts.cjs; do not edit.\nmodule.exports=" + JSON.stringify({ methods }) + ';\n');
console.log(JSON.stringify({ operations: Object.keys(methods).length }));
