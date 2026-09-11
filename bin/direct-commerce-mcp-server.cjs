#!/usr/bin/env node
'use strict';

const sellerApi = require('./marketplace-seller-api.cjs');
const storefrontApi = require('./merchant-platform-api.cjs');
const shopifySetupRequirements = require('./shopify-setup-requirements.cjs');
const { refundSignatureHeaders } = require('./ebay-signature.cjs');
const { withRequestSignal, requestFetch, credentialOperation, requestFailureCode, httpFailureCode } = require('./commerce-request-context.cjs');

require('./proxy-bootstrap.cjs');
const { createHash, createHmac, randomUUID } = require('node:crypto');
const { isIP } = require('node:net');
const { readCredentialFile, writeCredentialFile } = require('./local-api-credential-codec.cjs');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  ListToolsRequestSchema, CallToolRequestSchema,
  LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS, McpError, ErrorCode,
} = require('@modelcontextprotocol/sdk/types.js');

const MAX_OUTPUT_CHARS = 1024 * 1024;
const MAX_INPUT_CHARS = 256 * 1024;
const PROVIDERS = new Set([
  'shopify', 'constant_contact', 'lightspeed', 'woocommerce', 'walmart',
  'ebay', 'etsy', 'amazon_seller', 'mercado_libre', 'taobao_top', 'alibaba_1688',
  'jd_jos', 'pinduoduo', 'douyin_shop', 'kuaishou_shop', 'youzan', 'weimob_wos',
  'xiaohongshu_ark', 'reloadly', 'square', 'instacart', 'commerce_layer',
]);
const TOOL_POLICIES = Object.freeze({
  list_capabilities: { risk: 'R', confirmation: 'none', maxBatchSize: 100 },
  describe_action: { risk: 'R', confirmation: 'none', maxBatchSize: 1 },
  execute_read: { risk: 'R', confirmation: 'none', maxBatchSize: 100 },
  execute_write: { risk: 'W', confirmation: 'preview', maxBatchSize: 25 },
  execute_high_impact: { risk: 'H', confirmation: 'fresh', maxBatchSize: 10, sensitiveOperation: 'external_or_financial_change' },
  execute_destructive: { risk: 'D', confirmation: 'destructive', maxBatchSize: 10, sensitiveOperation: 'destructive' },
});

function action(risk, description, properties = {}, required = []) {
  return Object.freeze({
    risk, description,
    input_schema: { type: 'object', properties, required, additionalProperties: false },
  });
}

const ID = { type: 'string', minLength: 1, maxLength: 200 };
const BODY = { type: 'object', description: 'Provider resource payload; describe_action documents the fixed destination.', additionalProperties: true };
const QUERY = { type: 'object', description: 'Provider query filters; raw URL, headers, tokens, and methods are never accepted.', additionalProperties: true };
const IDS = { type: 'array', minItems: 1, maxItems: 10, items: ID };
const BODIES = { type: 'array', minItems: 1, maxItems: 10, items: BODY };
const SHOPIFY_ACTIONS = Object.freeze({
  'shop.get': action('R', 'Get the bound Shopify shop identity.'),
  'products.list': action('R', 'List products.', { first: { type: 'integer', minimum: 1, maximum: 100 }, after: ID, query: { type: 'string', maxLength: 1000 } }),
  'products.get': action('R', 'Get one product by Shopify GID.', { id: ID }, ['id']),
  'products.create': action('W', 'Create a product draft or resource.', { input: BODY }, ['input']),
  'products.update': action('W', 'Update a product.', { input: BODY }, ['input']),
  'products.delete': action('D', 'Delete a product.', { id: ID }, ['id']),
  'product_variants.bulk_create': action('W', 'Create up to 10 variants for one product.', { product_id: ID, variants: BODIES }, ['product_id', 'variants']),
  'product_variants.bulk_update': action('W', 'Update up to 10 variants for one product atomically.', { product_id: ID, variants: BODIES }, ['product_id', 'variants']),
  'product_variants.bulk_delete': action('D', 'Delete up to 10 variants from one product.', { product_id: ID, variant_ids: IDS }, ['product_id', 'variant_ids']),
  'collections.list': action('R', 'List product collections.', { first: { type: 'integer', minimum: 1, maximum: 100 }, after: ID, query: { type: 'string', maxLength: 1000 } }),
  'collections.get': action('R', 'Get one product collection.', { id: ID }, ['id']),
  'collections.create': action('W', 'Create a product collection.', { input: BODY }, ['input']),
  'collections.update': action('W', 'Update a product collection.', { input: BODY }, ['input']),
  'collections.delete': action('D', 'Permanently delete a product collection.', { id: ID }, ['id']),
  'orders.list': action('R', 'List orders.', { first: { type: 'integer', minimum: 1, maximum: 100 }, after: ID, query: { type: 'string', maxLength: 1000 } }),
  'orders.get': action('R', 'Get one order by Shopify GID.', { id: ID }, ['id']),
  'orders.create': action('H', 'Create an order, which can record financial and fulfillment state.', { order: BODY, options: BODY }, ['order']),
  'orders.update': action('W', 'Update ordinary order attributes such as note, tags, email, or shipping address.', { input: BODY }, ['input']),
  'orders.close': action('H', 'Mark an order as closed.', { input: BODY }, ['input']),
  'orders.cancel': action('D', 'Cancel an order with an explicit refund method and restock decision.', {
    order_id: ID,
    refund_method: BODY,
    restock: { type: 'boolean' },
    reason: { type: 'string', enum: ['CUSTOMER', 'DECLINED', 'FRAUD', 'INVENTORY', 'OTHER', 'STAFF'] },
    notify_customer: { type: 'boolean' },
    staff_note: { type: 'string', maxLength: 255 },
  }, ['order_id', 'refund_method', 'restock', 'reason']),
  'customers.list': action('R', 'List customers.', { first: { type: 'integer', minimum: 1, maximum: 100 }, after: ID, query: { type: 'string', maxLength: 1000 } }),
  'customers.get': action('R', 'Get one customer by Shopify GID.', { id: ID }, ['id']),
  'customers.create': action('W', 'Create a customer.', { input: BODY }, ['input']),
  'customers.update': action('W', 'Update a customer.', { input: BODY }, ['input']),
  'customers.delete': action('D', 'Delete a customer.', { id: ID }, ['id']),
  'locations.list': action('R', 'List inventory locations.', { first: { type: 'integer', minimum: 1, maximum: 100 } }),
  'inventory_items.list': action('R', 'List inventory items and their stock metadata.', { first: { type: 'integer', minimum: 1, maximum: 100 }, after: ID, query: { type: 'string', maxLength: 1000 } }),
  'inventory_items.get': action('R', 'Get one inventory item and its location quantities.', { id: ID }, ['id']),
  'inventory_items.update': action('W', 'Update inventory-item metadata such as cost, tracking, or country of origin.', { id: ID, input: BODY }, ['id', 'input']),
  'inventory.set_quantities': action('H', 'Set absolute inventory quantities.', { input: BODY }, ['input']),
  'draft_orders.list': action('R', 'List draft orders.', { first: { type: 'integer', minimum: 1, maximum: 100 }, after: ID, query: { type: 'string', maxLength: 1000 } }),
  'draft_orders.get': action('R', 'Get one draft order.', { id: ID }, ['id']),
  'draft_orders.create': action('W', 'Create a draft order.', { input: BODY }, ['input']),
  'draft_orders.update': action('W', 'Update a draft order.', { id: ID, input: BODY }, ['id', 'input']),
  'draft_orders.complete': action('H', 'Complete a draft order into an order.', { id: ID, payment_pending: { type: 'boolean' } }, ['id']),
  'draft_orders.delete': action('D', 'Delete a draft order.', { id: ID }, ['id']),
  'fulfillments.create': action('H', 'Create a fulfillment for reviewed fulfillment-order line items.', { fulfillment: BODY, message: { type: 'string', maxLength: 1000 } }, ['fulfillment']),
  'refunds.create': action('H', 'Create an order refund.', { input: BODY }, ['input']),
  'returns.get': action('R', 'Get one return and its line items.', { id: ID }, ['id']),
  'returns.create': action('H', 'Approve and create a return for fulfilled order line items.', { input: BODY }, ['input']),
  'returns.cancel': action('D', 'Cancel an untouched return.', { id: ID }, ['id']),
  'discounts.list': action('R', 'List code and automatic discounts.', { first: { type: 'integer', minimum: 1, maximum: 100 }, after: ID, query: { type: 'string', maxLength: 1000 } }),
  'discounts.get': action('R', 'Get one code or automatic discount.', { id: ID }, ['id']),
  'discounts.code_basic_create': action('H', 'Create a basic code discount that changes checkout pricing.', { input: BODY }, ['input']),
  'discounts.code_basic_update': action('H', 'Update a basic code discount.', { id: ID, input: BODY }, ['id', 'input']),
  'discounts.code_delete': action('D', 'Permanently delete a code discount.', { id: ID }, ['id']),
  'discounts.automatic_basic_create': action('H', 'Create a basic automatic discount that changes checkout pricing.', { input: BODY }, ['input']),
  'discounts.automatic_basic_update': action('H', 'Update a basic automatic discount.', { id: ID, input: BODY }, ['id', 'input']),
  'discounts.automatic_delete': action('D', 'Permanently delete an automatic discount.', { id: ID }, ['id']),
  'publications.list': action('R', 'List sales-channel publications.', { first: { type: 'integer', minimum: 1, maximum: 100 }, after: ID }),
  'publications.publish': action('H', 'Publish a product or collection to up to 10 reviewed publications.', { id: ID, publications: BODIES }, ['id', 'publications']),
  'publications.unpublish': action('D', 'Remove a product or collection from up to 10 publications.', { id: ID, publications: BODIES }, ['id', 'publications']),
});

const CONSTANT_CONTACT_ACTIONS = Object.freeze({
  'account.get': action('R', 'Get the bound Constant Contact account summary.'),
  'contacts.list': action('R', 'List or filter contacts.', { query: QUERY }),
  'contacts.get': action('R', 'Get one contact.', { id: ID, query: QUERY }, ['id']),
  'contacts.create_or_update': action('W', 'Create or explicitly opt-in/update a contact using the sign-up-form endpoint.', { body: BODY }, ['body']),
  'contacts.update': action('W', 'Update one existing contact.', { id: ID, body: BODY }, ['id', 'body']),
  'contacts.delete': action('D', 'Delete one contact.', { id: ID }, ['id']),
  'lists.list': action('R', 'List contact lists.', { query: QUERY }),
  'lists.get': action('R', 'Get one contact list.', { id: ID }, ['id']),
  'lists.create': action('W', 'Create a contact list.', { body: BODY }, ['body']),
  'lists.update': action('W', 'Update a contact list.', { id: ID, body: BODY }, ['id', 'body']),
  'lists.delete': action('D', 'Delete a contact list.', { id: ID }, ['id']),
  'campaigns.list': action('R', 'List email campaigns.', { query: QUERY }),
  'campaigns.get': action('R', 'Get an email campaign.', { id: ID }, ['id']),
  'campaigns.create': action('W', 'Create an email campaign draft.', { body: BODY }, ['body']),
  'campaigns.update_activity': action('W', 'Update a campaign email activity.', { id: ID, body: BODY }, ['id', 'body']),
  'campaigns.schedule': action('H', 'Schedule or immediately send a campaign activity.', { id: ID, scheduled_date: { type: 'string', maxLength: 64 } }, ['id', 'scheduled_date']),
  'campaigns.unschedule': action('D', 'Remove a scheduled campaign activity.', { id: ID }, ['id']),
  'campaigns.delete': action('D', 'Delete an email campaign.', { id: ID }, ['id']),
});

const COMMERCE_LAYER_CUSTOMER_ATTRIBUTES = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    email: { type: 'string', minLength: 3, maxLength: 320 },
    shopper_reference: { type: 'string', minLength: 3, maxLength: 128 },
    profile_id: { type: 'string', minLength: 1, maxLength: 128 },
    tax_exemption_code: { type: 'string', maxLength: 128 },
    reference: { type: 'string', maxLength: 255 },
    reference_origin: { type: 'string', maxLength: 255 },
    metadata: BODY,
  },
});
const COMMERCE_LAYER_CUSTOMER_CREATE_ATTRIBUTES = Object.freeze({
  ...COMMERCE_LAYER_CUSTOMER_ATTRIBUTES,
  required: ['email'],
});

const COMMERCE_LAYER_ACTIONS = Object.freeze({
  'application.get': action('R', 'Get the bound Commerce Layer API credential and application identity.'),
  'customers.list': action('R', 'List customers.', { query: QUERY }),
  'customers.get': action('R', 'Get one customer.', { id: ID, query: QUERY }, ['id']),
  'customers.create': action('W', 'Create a customer with reviewed non-password attributes.', { attributes: COMMERCE_LAYER_CUSTOMER_CREATE_ATTRIBUTES }, ['attributes']),
  'customers.update': action('W', 'Update reviewed non-password customer attributes.', { id: ID, attributes: COMMERCE_LAYER_CUSTOMER_ATTRIBUTES }, ['id', 'attributes']),
  'customers.delete': action('D', 'Delete a customer.', { id: ID }, ['id']),
  'orders.list': action('R', 'List orders.', { query: QUERY }),
  'orders.get': action('R', 'Get one order.', { id: ID, query: QUERY }, ['id']),
  'skus.list': action('R', 'List SKUs.', { query: QUERY }),
  'skus.get': action('R', 'Get one SKU.', { id: ID, query: QUERY }, ['id']),
  'stock_items.list': action('R', 'List stock items.', { query: QUERY }),
  'stock_items.get': action('R', 'Get one stock item.', { id: ID, query: QUERY }, ['id']),
});

const LIGHTSPEED_ACTIONS = Object.freeze({
  'store.get': action('R', 'Get the bound Lightspeed Retail X-Series store setup.'),
  'search': action('R', 'Search supported sales, products, and customers.', { query: QUERY }),
  'products.list': action('R', 'List products.', { query: QUERY }),
  'products.get': action('R', 'Get one product.', { id: ID }, ['id']),
  'products.create': action('W', 'Create a product.', { body: BODY }, ['body']),
  'products.update': action('W', 'Update a product.', { id: ID, body: BODY }, ['id', 'body']),
  'products.delete': action('D', 'Delete a product.', { id: ID }, ['id']),
  'customers.list': action('R', 'List customers.', { query: QUERY }),
  'customers.get': action('R', 'Get one customer.', { id: ID }, ['id']),
  'customers.create': action('W', 'Create a customer.', { body: BODY }, ['body']),
  'customers.update': action('W', 'Update a customer.', { id: ID, body: BODY }, ['id', 'body']),
  'customers.delete': action('D', 'Delete a customer.', { id: ID }, ['id']),
  'outlets.list': action('R', 'List store outlets.', { query: QUERY }),
  'sales.list': action('R', 'List sales.', { query: QUERY }),
  'sales.get': action('R', 'Get one sale.', { id: ID }, ['id']),
  'sales.create': action('H', 'Create a sale.', { body: BODY }, ['body']),
  'sales.update': action('H', 'Update a sale.', { id: ID, body: BODY }, ['id', 'body']),
  'sales.delete': action('D', 'Delete or void a sale.', { id: ID }, ['id']),
});

const RELOADLY_COMMON = {
  'balance.get': action('R', 'Get the Reloadly wallet balance.'),
  'countries.list': action('R', 'List supported countries.', { query: QUERY }),
};
const RELOADLY_ACTIONS = Object.freeze({
  airtime: Object.freeze({
    ...RELOADLY_COMMON,
    'operators.list': action('R', 'List airtime operators for a country.', { country_code: ID, query: QUERY }, ['country_code']),
    'topups.get': action('R', 'Get a top-up transaction.', { id: ID }, ['id']),
    'topups.create': action('H', 'Spend wallet balance to create an airtime top-up.', { body: BODY }, ['body']),
  }),
  giftcards: Object.freeze({
    ...RELOADLY_COMMON,
    'products.list': action('R', 'List gift-card products.', { query: QUERY }),
    'products.get': action('R', 'Get a gift-card product.', { id: ID }, ['id']),
    'orders.get': action('R', 'Get a gift-card order.', { id: ID }, ['id']),
    'orders.create': action('H', 'Spend wallet balance to create a gift-card order.', { body: BODY }, ['body']),
  }),
  utilities: Object.freeze({
    ...RELOADLY_COMMON,
    'billers.list': action('R', 'List utility billers.', { query: QUERY }),
    'transactions.get': action('R', 'Get a utility payment transaction.', { id: ID }, ['id']),
    'bills.pay': action('H', 'Spend wallet balance to pay a utility bill.', { body: BODY }, ['body']),
  }),
});

const SQUARE_ACTIONS = Object.freeze({
  'merchant.get': action('R', 'Get the bound Square merchant identity.'),
  'locations.list': action('R', 'List seller locations.'),
  'locations.get': action('R', 'Get one seller location.', { id: ID }, ['id']),
  'locations.create': action('W', 'Create a seller location.', { body: BODY }, ['body']),
  'locations.update': action('W', 'Update a seller location.', { id: ID, body: BODY }, ['id', 'body']),

  'catalog.list': action('R', 'List catalog objects.', { query: QUERY }),
  'catalog.get': action('R', 'Get one catalog object.', { id: ID, query: QUERY }, ['id']),
  'catalog.search': action('R', 'Search catalog objects.', { body: BODY }, ['body']),
  'catalog.batch_retrieve': action('R', 'Retrieve a reviewed batch of catalog objects.', { body: BODY }, ['body']),
  'catalog.upsert': action('W', 'Create or update one catalog object with an idempotency key.', { body: BODY }, ['body']),
  'catalog.batch_upsert': action('W', 'Create or update catalog-object batches with an idempotency key.', { body: BODY }, ['body']),
  'catalog.delete': action('D', 'Delete one catalog object.', { id: ID }, ['id']),
  'catalog.batch_delete': action('D', 'Delete a reviewed catalog-object batch.', { body: BODY }, ['body']),

  'inventory.counts_batch_retrieve': action('R', 'Retrieve inventory counts.', { body: BODY }, ['body']),
  'inventory.changes_batch_retrieve': action('R', 'Retrieve inventory changes.', { body: BODY }, ['body']),
  'inventory.changes_batch_create': action('H', 'Apply inventory adjustments, transfers, counts, or physical-count state.', { body: BODY }, ['body']),

  'customers.list': action('R', 'List customers.', { query: QUERY }),
  'customers.search': action('R', 'Search customers.', { body: BODY }, ['body']),
  'customers.get': action('R', 'Get one customer.', { id: ID }, ['id']),
  'customers.create': action('W', 'Create a customer.', { body: BODY }, ['body']),
  'customers.update': action('W', 'Update a customer.', { id: ID, body: BODY }, ['id', 'body']),
  'customers.delete': action('D', 'Delete a customer.', { id: ID }, ['id']),
  'customer_groups.list': action('R', 'List customer groups.', { query: QUERY }),
  'customer_groups.get': action('R', 'Get one customer group.', { id: ID }, ['id']),
  'customer_groups.create': action('W', 'Create a customer group.', { body: BODY }, ['body']),
  'customer_groups.update': action('W', 'Update a customer group.', { id: ID, body: BODY }, ['id', 'body']),
  'customer_groups.delete': action('D', 'Delete a customer group.', { id: ID }, ['id']),
  'customer_segments.list': action('R', 'List smart customer segments.', { query: QUERY }),
  'customer_segments.get': action('R', 'Get one smart customer segment.', { id: ID }, ['id']),

  'orders.search': action('R', 'Search orders.', { body: BODY }, ['body']),
  'orders.get': action('R', 'Get one order.', { id: ID }, ['id']),
  'orders.batch_retrieve': action('R', 'Retrieve a reviewed order batch.', { body: BODY }, ['body']),
  'orders.calculate': action('R', 'Calculate an order without persisting it.', { body: BODY }, ['body']),
  'orders.create': action('H', 'Create an order that records pricing and fulfillment state.', { body: BODY }, ['body']),
  'orders.update': action('H', 'Update order pricing, line items, fulfillment, or other consequential state.', { id: ID, body: BODY }, ['id', 'body']),
  'orders.pay': action('H', 'Pay an order using reviewed payment IDs.', { id: ID, body: BODY }, ['id', 'body']),

  'payments.list': action('R', 'List payments.', { query: QUERY }),
  'payments.get': action('R', 'Get one payment.', { id: ID }, ['id']),
  'payments.create': action('H', 'Create a real or sandbox payment from a reviewed payment source.', { body: BODY }, ['body']),
  'payments.update': action('H', 'Update an approved payment amount, tip, or other consequential state.', { id: ID, body: BODY }, ['id', 'body']),
  'payments.complete': action('H', 'Capture an approved payment.', { id: ID, body: BODY }, ['id']),
  'payments.cancel': action('D', 'Void an approved payment.', { id: ID }, ['id']),
  'payments.cancel_by_idempotency_key': action('D', 'Void a payment selected by its idempotency key.', { body: BODY }, ['body']),
  'refunds.list': action('R', 'List payment refunds.', { query: QUERY }),
  'refunds.get': action('R', 'Get one payment refund.', { id: ID }, ['id']),
  'refunds.create': action('H', 'Refund a payment amount.', { body: BODY }, ['body']),

  'invoices.list': action('R', 'List invoices for a location.', { query: QUERY }),
  'invoices.search': action('R', 'Search invoices.', { body: BODY }, ['body']),
  'invoices.get': action('R', 'Get one invoice.', { id: ID }, ['id']),
  'invoices.create': action('W', 'Create an unpublished invoice draft.', { body: BODY }, ['body']),
  'invoices.update': action('H', 'Update invoice delivery, payment, or schedule terms.', { id: ID, body: BODY }, ['id', 'body']),
  'invoices.publish': action('H', 'Publish an invoice so Square can notify or charge its recipient.', { id: ID, body: BODY }, ['id', 'body']),
  'invoices.cancel': action('D', 'Cancel a published invoice.', { id: ID, body: BODY }, ['id', 'body']),
  'invoices.delete': action('D', 'Delete an invoice draft.', { id: ID, query: QUERY }, ['id']),

  'subscriptions.search': action('R', 'Search subscriptions.', { body: BODY }, ['body']),
  'subscriptions.get': action('R', 'Get one subscription.', { id: ID }, ['id']),
  'subscriptions.events_list': action('R', 'List events for one subscription.', { id: ID, query: QUERY }, ['id']),
  'subscriptions.create': action('H', 'Enroll a customer in a recurring subscription.', { body: BODY }, ['body']),
  'subscriptions.update': action('H', 'Update a recurring subscription.', { id: ID, body: BODY }, ['id', 'body']),
  'subscriptions.billing_anchor_change': action('H', 'Change a subscription billing anchor date.', { id: ID, body: BODY }, ['id', 'body']),
  'subscriptions.pause': action('H', 'Schedule a subscription pause.', { id: ID, body: BODY }, ['id', 'body']),
  'subscriptions.resume': action('H', 'Schedule a subscription resume.', { id: ID, body: BODY }, ['id', 'body']),
  'subscriptions.swap_plan': action('H', 'Schedule a subscription plan change.', { id: ID, body: BODY }, ['id', 'body']),
  'subscriptions.cancel': action('D', 'Schedule cancellation of a subscription.', { id: ID }, ['id']),
  'subscriptions.action_delete': action('D', 'Delete a scheduled subscription action.', { id: ID, action_id: ID }, ['id', 'action_id']),

  'loyalty.program_get': action('R', 'Get the seller loyalty program.', { id: ID }, ['id']),
  'loyalty.accounts.search': action('R', 'Search loyalty accounts.', { body: BODY }, ['body']),
  'loyalty.accounts.get': action('R', 'Get one loyalty account.', { id: ID }, ['id']),
  'loyalty.accounts.create': action('W', 'Create a loyalty account.', { body: BODY }, ['body']),
  'loyalty.points.calculate': action('R', 'Calculate loyalty points without changing a balance.', { id: ID, body: BODY }, ['id', 'body']),
  'loyalty.points.accumulate': action('H', 'Add purchase-earned points to a loyalty account.', { id: ID, body: BODY }, ['id', 'body']),
  'loyalty.points.adjust': action('H', 'Add or subtract points from a loyalty account.', { id: ID, body: BODY }, ['id', 'body']),
  'loyalty.events.search': action('R', 'Search loyalty balance events.', { body: BODY }, ['body']),
  'loyalty.promotions.list': action('R', 'List loyalty promotions.', { id: ID, query: QUERY }, ['id']),
  'loyalty.promotions.get': action('R', 'Get one loyalty promotion.', { id: ID, promotion_id: ID }, ['id', 'promotion_id']),
  'loyalty.promotions.create': action('H', 'Create a loyalty promotion that changes earning rules.', { id: ID, body: BODY }, ['id', 'body']),
  'loyalty.promotions.cancel': action('D', 'Cancel a loyalty promotion.', { id: ID, promotion_id: ID }, ['id', 'promotion_id']),
  'loyalty.rewards.search': action('R', 'Search loyalty rewards.', { body: BODY }, ['body']),
  'loyalty.rewards.get': action('R', 'Get one loyalty reward.', { id: ID }, ['id']),
  'loyalty.rewards.create': action('H', 'Create a reward and deduct its points.', { body: BODY }, ['body']),
  'loyalty.rewards.redeem': action('H', 'Redeem a loyalty reward.', { id: ID, body: BODY }, ['id', 'body']),
  'loyalty.rewards.delete': action('D', 'Delete a reward and return its points.', { id: ID }, ['id']),

  'gift_cards.list': action('R', 'List gift cards.', { query: QUERY }),
  'gift_cards.get': action('R', 'Get one gift card.', { id: ID }, ['id']),
  'gift_cards.get_by_gan': action('R', 'Get one gift card by reviewed GAN payload.', { body: BODY }, ['body']),
  'gift_cards.activities.list': action('R', 'List gift-card activities.', { query: QUERY }),
  'gift_cards.create': action('W', 'Create an inactive gift card.', { body: BODY }, ['body']),
  'gift_cards.link_customer': action('H', 'Link a gift card to a customer profile.', { id: ID, body: BODY }, ['id', 'body']),
  'gift_cards.unlink_customer': action('D', 'Unlink a gift card from a customer profile.', { id: ID, body: BODY }, ['id', 'body']),
  'gift_cards.activities.create': action('H', 'Activate, load, redeem, refund, transfer, or otherwise change gift-card value.', { body: BODY }, ['body']),

  'payment_links.list': action('R', 'List hosted Square payment links.', { query: QUERY }),
  'payment_links.get': action('R', 'Get one hosted Square payment link.', { id: ID }, ['id']),
  'payment_links.create': action('H', 'Create a hosted checkout link that can collect payment.', { body: BODY }, ['body']),
  'payment_links.update': action('H', 'Update a hosted payment link.', { id: ID, body: BODY }, ['id', 'body']),
  'payment_links.delete': action('D', 'Delete a hosted payment link.', { id: ID }, ['id']),

  'disputes.list': action('R', 'List payment disputes.', { query: QUERY }),
  'disputes.get': action('R', 'Get one payment dispute.', { id: ID }, ['id']),
  'disputes.evidence.list': action('R', 'List evidence for a dispute.', { id: ID }, ['id']),
  'disputes.evidence.get': action('R', 'Get one dispute evidence record.', { id: ID, evidence_id: ID }, ['id', 'evidence_id']),
  'disputes.evidence_text.create': action('W', 'Add text evidence to a dispute without submitting the case.', { id: ID, body: BODY }, ['id', 'body']),
  'disputes.evidence.delete': action('D', 'Delete unsubmitted dispute evidence.', { id: ID, evidence_id: ID }, ['id', 'evidence_id']),
  'disputes.evidence.submit': action('H', 'Submit the dispute evidence package to the cardholder bank.', { id: ID }, ['id']),
  'disputes.accept': action('D', 'Accept a dispute loss and return the disputed funds.', { id: ID }, ['id']),
  'payouts.list': action('R', 'List seller payouts.', { query: QUERY }),
  'payouts.get': action('R', 'Get one seller payout.', { id: ID }, ['id']),
});

const INSTACART_ACTIONS = Object.freeze({
  'retailers.list': action('R', 'List nearby Instacart retailers for a US or Canadian postal code.', {
    postal_code: { type: 'string', minLength: 1, maxLength: 20 },
    country_code: { type: 'string', enum: ['US', 'CA'] },
  }, ['postal_code', 'country_code']),
  'recipe_page.create': action('H', 'Create an externally visible Instacart recipe page and shareable cart-building link.', { body: BODY }, ['body']),
  'shopping_list_page.create': action('H', 'Create an externally visible Instacart shopping-list page and shareable cart-building link.', { body: BODY }, ['body']),
});

const WOOCOMMERCE_ACTIONS = Object.freeze({
  'store.status': action('R', 'Get WooCommerce and WordPress environment status for the bound store.'),
  'data.countries': action('R', 'List country and state codes.', { query: QUERY }),
  'data.currencies': action('R', 'List currency codes.', { query: QUERY }),
  'data.continents': action('R', 'List continent and country codes.', { query: QUERY }),
  'products.list': action('R', 'List products.', { query: QUERY }),
  'products.get': action('R', 'Get one product.', { id: ID, query: QUERY }, ['id']),
  'products.create': action('H', 'Create a product that can immediately affect the live catalog, pricing, or inventory.', { body: BODY }, ['body']),
  'products.update': action('H', 'Update product publication, pricing, inventory, or other externally visible fields.', { id: ID, body: BODY }, ['id', 'body']),
  'products.delete': action('D', 'Trash or permanently delete a product.', { id: ID, query: QUERY }, ['id']),
  'variations.list': action('R', 'List variations for a product.', { product_id: ID, query: QUERY }, ['product_id']),
  'variations.get': action('R', 'Get one product variation.', { product_id: ID, id: ID, query: QUERY }, ['product_id', 'id']),
  'variations.create': action('H', 'Create a product variation that can affect pricing and inventory.', { product_id: ID, body: BODY }, ['product_id', 'body']),
  'variations.update': action('H', 'Update product-variation pricing, inventory, or other externally visible fields.', { product_id: ID, id: ID, body: BODY }, ['product_id', 'id', 'body']),
  'variations.delete': action('D', 'Trash or permanently delete a product variation.', { product_id: ID, id: ID, query: QUERY }, ['product_id', 'id']),
  'categories.list': action('R', 'List product categories.', { query: QUERY }),
  'categories.get': action('R', 'Get one product category.', { id: ID, query: QUERY }, ['id']),
  'categories.create': action('W', 'Create a product category.', { body: BODY }, ['body']),
  'categories.update': action('W', 'Update a product category.', { id: ID, body: BODY }, ['id', 'body']),
  'categories.delete': action('D', 'Delete a product category.', { id: ID, query: QUERY }, ['id']),
  'tags.list': action('R', 'List product tags.', { query: QUERY }),
  'tags.get': action('R', 'Get one product tag.', { id: ID, query: QUERY }, ['id']),
  'tags.create': action('W', 'Create a product tag.', { body: BODY }, ['body']),
  'tags.update': action('W', 'Update a product tag.', { id: ID, body: BODY }, ['id', 'body']),
  'tags.delete': action('D', 'Delete a product tag.', { id: ID, query: QUERY }, ['id']),
  'attributes.list': action('R', 'List product attributes.', { query: QUERY }),
  'attributes.get': action('R', 'Get one product attribute.', { id: ID, query: QUERY }, ['id']),
  'attributes.create': action('W', 'Create a product attribute.', { body: BODY }, ['body']),
  'attributes.update': action('W', 'Update a product attribute.', { id: ID, body: BODY }, ['id', 'body']),
  'attributes.delete': action('D', 'Delete a product attribute.', { id: ID, query: QUERY }, ['id']),
  'attribute_terms.list': action('R', 'List terms for a product attribute.', { attribute_id: ID, query: QUERY }, ['attribute_id']),
  'attribute_terms.get': action('R', 'Get one product-attribute term.', { attribute_id: ID, id: ID, query: QUERY }, ['attribute_id', 'id']),
  'attribute_terms.create': action('W', 'Create a product-attribute term.', { attribute_id: ID, body: BODY }, ['attribute_id', 'body']),
  'attribute_terms.update': action('W', 'Update a product-attribute term.', { attribute_id: ID, id: ID, body: BODY }, ['attribute_id', 'id', 'body']),
  'attribute_terms.delete': action('D', 'Delete a product-attribute term.', { attribute_id: ID, id: ID, query: QUERY }, ['attribute_id', 'id']),
  'orders.list': action('R', 'List orders.', { query: QUERY }),
  'orders.get': action('R', 'Get one order.', { id: ID, query: QUERY }, ['id']),
  'orders.create': action('H', 'Create an order with financial, inventory, and fulfillment consequences.', { body: BODY }, ['body']),
  'orders.update': action('H', 'Update order status, totals, customer, or fulfillment data.', { id: ID, body: BODY }, ['id', 'body']),
  'orders.delete': action('D', 'Trash or permanently delete an order.', { id: ID, query: QUERY }, ['id']),
  'order_notes.list': action('R', 'List notes for an order.', { order_id: ID, query: QUERY }, ['order_id']),
  'order_notes.get': action('R', 'Get one order note.', { order_id: ID, id: ID, query: QUERY }, ['order_id', 'id']),
  'order_notes.create': action('H', 'Create an order note that may be visible or sent to the customer.', { order_id: ID, body: BODY }, ['order_id', 'body']),
  'order_notes.delete': action('D', 'Delete an order note.', { order_id: ID, id: ID, query: QUERY }, ['order_id', 'id']),
  'refunds.list': action('R', 'List refunds for an order.', { order_id: ID, query: QUERY }, ['order_id']),
  'refunds.get': action('R', 'Get one order refund.', { order_id: ID, id: ID, query: QUERY }, ['order_id', 'id']),
  'refunds.create': action('H', 'Create a full or partial order refund.', { order_id: ID, body: BODY }, ['order_id', 'body']),
  'refunds.delete': action('D', 'Delete a refund record where WooCommerce permits it.', { order_id: ID, id: ID, query: QUERY }, ['order_id', 'id']),
  'customers.list': action('R', 'List customers.', { query: QUERY }),
  'customers.get': action('R', 'Get one customer.', { id: ID, query: QUERY }, ['id']),
  'customers.create': action('W', 'Create a customer.', { body: BODY }, ['body']),
  'customers.update': action('W', 'Update a customer.', { id: ID, body: BODY }, ['id', 'body']),
  'customers.delete': action('D', 'Delete a customer.', { id: ID, query: QUERY }, ['id']),
  'coupons.list': action('R', 'List coupons.', { query: QUERY }),
  'coupons.get': action('R', 'Get one coupon.', { id: ID, query: QUERY }, ['id']),
  'coupons.create': action('H', 'Create a coupon that changes checkout pricing.', { body: BODY }, ['body']),
  'coupons.update': action('H', 'Update a coupon and its checkout-pricing effect.', { id: ID, body: BODY }, ['id', 'body']),
  'coupons.delete': action('D', 'Delete a coupon.', { id: ID, query: QUERY }, ['id']),
  'reviews.list': action('R', 'List product reviews.', { query: QUERY }),
  'reviews.get': action('R', 'Get one product review.', { id: ID, query: QUERY }, ['id']),
  'reviews.create': action('H', 'Create an externally visible product review.', { body: BODY }, ['body']),
  'reviews.update': action('H', 'Update review content, rating, or publication state.', { id: ID, body: BODY }, ['id', 'body']),
  'reviews.delete': action('D', 'Delete a product review.', { id: ID, query: QUERY }, ['id']),
  'reports.sales': action('R', 'Get the sales report.', { query: QUERY }),
  'reports.orders': action('R', 'Get order totals.', { query: QUERY }),
  'reports.products': action('R', 'Get product totals.', { query: QUERY }),
  'reports.customers': action('R', 'Get customer totals.', { query: QUERY }),
  'reports.coupons': action('R', 'Get coupon totals.', { query: QUERY }),
  'reports.reviews': action('R', 'Get review totals.', { query: QUERY }),
});

const WALMART_COMMON_ACTIONS = Object.freeze({
  'account.permissions': action('R', 'Get the bound Walmart seller credential validity and granted API permissions.'),
  'items.list': action('R', 'List seller items.', { query: QUERY }),
  'items.get': action('R', 'Get one seller item by SKU, GTIN, or Walmart item ID.', { id: ID, query: QUERY }, ['id']),
  'inventory.get': action('R', 'Get inventory for one SKU and optional ship node.', { sku: ID, ship_node: ID }, ['sku']),
  'inventory.nodes_get': action('R', 'Get inventory for one SKU across all or one ship node.', { sku: ID, ship_node: ID }, ['sku']),
  'inventory.set': action('H', 'Replace inventory for one SKU at the default or selected ship node.', { sku: ID, ship_node: ID, body: BODY }, ['sku', 'body']),
  'inventory.nodes_set': action('H', 'Replace inventory for one SKU at multiple reviewed ship nodes.', { sku: ID, body: BODY }, ['sku', 'body']),
  'price.set': action('H', 'Set a seller item price.', { sku: ID, body: BODY }, ['sku', 'body']),
  'orders.list': action('R', 'List seller orders.', { query: QUERY }),
  'orders.released': action('R', 'List released orders ready for acknowledgement.', { query: QUERY }),
  'orders.get': action('R', 'Get one purchase order.', { id: ID }, ['id']),
  'orders.acknowledge': action('H', 'Acknowledge that the seller has received and will fulfill an order.', { id: ID }, ['id']),
  'orders.ship': action('H', 'Mark reviewed order lines shipped; this notifies the customer and can trigger charging.', { id: ID, body: BODY }, ['id', 'body']),
  'orders.cancel': action('D', 'Cancel reviewed order lines or an entire order.', { id: ID, body: BODY }, ['id', 'body']),
  'orders.refund': action('H', 'Issue a reviewed full or partial order refund.', { id: ID, body: BODY }, ['id', 'body']),
});
const WALMART_RETURN_ACTIONS = Object.freeze({
  'returns.list': action('R', 'List Marketplace return orders.', { query: QUERY }),
  'returns.get': action('R', 'Get one Marketplace return order.', { id: ID }, ['id']),
});
const EBAY_MARKETPLACE_LOCALES = Object.freeze({
  EBAY_US: ['en-US'], EBAY_MOTORS_US: ['en-US'], EBAY_AT: ['de-AT'], EBAY_AU: ['en-AU'], EBAY_BE: ['nl-BE', 'fr-BE'],
  EBAY_CA: ['en-CA', 'fr-CA'], EBAY_CH: ['de-CH'], EBAY_DE: ['de-DE'], EBAY_ES: ['es-ES'],
  EBAY_FR: ['fr-FR'], EBAY_GB: ['en-GB'], EBAY_HK: ['zh-HK'], EBAY_IE: ['en-IE'],
  EBAY_IT: ['it-IT'], EBAY_MY: ['en-US'], EBAY_NL: ['nl-NL'], EBAY_PH: ['en-PH'],
  EBAY_PL: ['pl-PL'], EBAY_SG: ['en-US'], EBAY_TW: ['zh-TW'],
});

const EBAY_ACTIONS = Object.freeze({
  'account.privileges': action('R', 'Get seller privileges and selling limits for the bound eBay marketplace.'),
  'fulfillment_policies.list': action('R', 'List fulfillment business policies for the bound marketplace.'),
  'fulfillment_policies.get': action('R', 'Get one fulfillment business policy.', { id: ID }, ['id']),
  'fulfillment_policies.create': action('W', 'Create an unattached fulfillment business policy.', { body: BODY }, ['body']),
  'fulfillment_policies.update': action('H', 'Update a fulfillment policy that may be referenced by active offers.', { id: ID, body: BODY }, ['id', 'body']),
  'fulfillment_policies.delete': action('D', 'Delete a fulfillment business policy.', { id: ID }, ['id']),
  'payment_policies.list': action('R', 'List payment business policies for the bound marketplace.'),
  'payment_policies.get': action('R', 'Get one payment business policy.', { id: ID }, ['id']),
  'payment_policies.create': action('W', 'Create an unattached payment business policy.', { body: BODY }, ['body']),
  'payment_policies.update': action('H', 'Update a payment policy that may be referenced by active offers.', { id: ID, body: BODY }, ['id', 'body']),
  'payment_policies.delete': action('D', 'Delete a payment business policy.', { id: ID }, ['id']),
  'return_policies.list': action('R', 'List return business policies for the bound marketplace.'),
  'return_policies.get': action('R', 'Get one return business policy.', { id: ID }, ['id']),
  'return_policies.create': action('W', 'Create an unattached return business policy.', { body: BODY }, ['body']),
  'return_policies.update': action('H', 'Update a return policy that may be referenced by active offers.', { id: ID, body: BODY }, ['id', 'body']),
  'return_policies.delete': action('D', 'Delete a return business policy.', { id: ID }, ['id']),
  'locations.list': action('R', 'List seller inventory locations.', { query: QUERY }),
  'locations.get': action('R', 'Get one seller inventory location.', { location_key: ID }, ['location_key']),
  'locations.create': action('H', 'Create and enable a seller inventory location.', { location_key: ID, body: BODY }, ['location_key', 'body']),
  'locations.update': action('H', 'Update externally used inventory-location details.', { location_key: ID, body: BODY }, ['location_key', 'body']),
  'locations.enable': action('H', 'Enable an inventory location for offers and fulfillment.', { location_key: ID }, ['location_key']),
  'locations.disable': action('D', 'Disable an inventory location.', { location_key: ID }, ['location_key']),
  'locations.delete': action('D', 'Delete an inventory location.', { location_key: ID }, ['location_key']),
  'inventory_items.list': action('R', 'List seller inventory items.', { query: QUERY }),
  'inventory_items.get': action('R', 'Get one inventory item by SKU.', { sku: ID }, ['sku']),
  'inventory_items.replace': action('H', 'Create or fully replace an inventory item, including quantity used by live offers.', { sku: ID, body: BODY }, ['sku', 'body']),
  'inventory_items.delete': action('D', 'Delete an inventory item.', { sku: ID }, ['sku']),
  'inventory_item_groups.get': action('R', 'Get one inventory item group.', { group_key: ID }, ['group_key']),
  'inventory_item_groups.replace': action('H', 'Create or fully replace a variation inventory item group.', { group_key: ID, body: BODY }, ['group_key', 'body']),
  'inventory_item_groups.delete': action('D', 'Delete an inventory item group.', { group_key: ID }, ['group_key']),
  'offers.list': action('R', 'List offers for a reviewed SKU in the bound marketplace.', { sku: ID, query: QUERY }, ['sku']),
  'offers.get': action('R', 'Get one offer.', { offer_id: ID }, ['offer_id']),
  'offers.create': action('W', 'Create an unpublished offer bound to the selected marketplace.', { body: BODY }, ['body']),
  'offers.update': action('H', 'Update an offer; changes apply to a published listing when active.', { offer_id: ID, body: BODY }, ['offer_id', 'body']),
  'offers.publish': action('H', 'Publish an offer as a live eBay listing.', { offer_id: ID }, ['offer_id']),
  'offers.withdraw': action('D', 'Withdraw a published offer and end its live listing.', { offer_id: ID }, ['offer_id']),
  'offers.delete': action('D', 'Delete an unpublished offer.', { offer_id: ID }, ['offer_id']),
  'orders.list': action('R', 'List seller orders.', { query: QUERY }),
  'orders.get': action('R', 'Get one seller order.', { order_id: ID }, ['order_id']),
  'shipping_fulfillments.list': action('R', 'List shipping fulfillments for an order.', { order_id: ID }, ['order_id']),
  'shipping_fulfillments.get': action('R', 'Get one shipping fulfillment.', { order_id: ID, fulfillment_id: ID }, ['order_id', 'fulfillment_id']),
  'shipping_fulfillments.create': action('H', 'Mark reviewed order lines shipped and notify eBay.', { order_id: ID, body: BODY }, ['order_id', 'body']),
  'orders.issue_refund': action('H', 'Issue a reviewed full or partial order refund.', { order_id: ID, body: BODY }, ['order_id', 'body']),
});

const ETSY_ACTIONS = Object.freeze({
  'shop.get': action('R', 'Get the bound Etsy shop.'),
  'shop.update': action('H', 'Update externally visible Etsy shop settings.', { body: BODY }, ['body']),
  'listings.list': action('R', 'List listings owned by the bound shop.', { query: QUERY }),
  'listings.get': action('R', 'Get one Etsy listing.', { listing_id: ID }, ['listing_id']),
  'listings.create_draft': action('W', 'Create an unpublished Etsy listing draft.', { body: BODY }, ['body']),
  'listings.update': action('H', 'Update a listing, including publication, pricing, or visible content.', { listing_id: ID, body: BODY }, ['listing_id', 'body']),
  'listings.delete': action('D', 'Delete an Etsy listing.', { listing_id: ID }, ['listing_id']),
  'listing_inventory.get': action('R', 'Get variants, offerings, SKUs, price, and quantity for a listing.', { listing_id: ID, query: QUERY }, ['listing_id']),
  'listing_inventory.update': action('H', 'Replace listing variants, offerings, prices, and quantities.', { listing_id: ID, body: BODY }, ['listing_id', 'body']),
  'receipts.list': action('R', 'List order receipts for the bound shop.', { query: QUERY }),
  'receipts.get': action('R', 'Get one order receipt.', { receipt_id: ID }, ['receipt_id']),
  'receipt_payments.list': action('R', 'List payments associated with a receipt.', { receipt_id: ID }, ['receipt_id']),
  'receipt_listings.list': action('R', 'List listings associated with a receipt.', { receipt_id: ID }, ['receipt_id']),
  'receipt_transactions.list': action('R', 'List transactions associated with a receipt.', { receipt_id: ID }, ['receipt_id']),
  'receipts.update': action('H', 'Update a receipt paid or shipped state.', { receipt_id: ID, body: BODY }, ['receipt_id', 'body']),
  'receipt_shipments.create': action('H', 'Create shipment tracking for a receipt and notify Etsy.', { receipt_id: ID, body: BODY }, ['receipt_id', 'body']),
  'shipping_profiles.list': action('R', 'List shipping profiles.'),
  'shipping_profiles.get': action('R', 'Get one shipping profile.', { profile_id: ID }, ['profile_id']),
  'shipping_profiles.create': action('W', 'Create an unattached shipping profile.', { body: BODY }, ['body']),
  'shipping_profiles.update': action('H', 'Update a shipping profile that can affect active listings.', { profile_id: ID, body: BODY }, ['profile_id', 'body']),
  'shipping_profiles.delete': action('D', 'Delete a shipping profile.', { profile_id: ID }, ['profile_id']),
  'shipping_destinations.list': action('R', 'List destinations for a shipping profile.', { profile_id: ID }, ['profile_id']),
  'shipping_destinations.create': action('W', 'Create a destination on a shipping profile.', { profile_id: ID, body: BODY }, ['profile_id', 'body']),
  'shipping_destinations.update': action('H', 'Update a shipping-profile destination used by listings.', { profile_id: ID, destination_id: ID, body: BODY }, ['profile_id', 'destination_id', 'body']),
  'shipping_destinations.delete': action('D', 'Delete a shipping-profile destination.', { profile_id: ID, destination_id: ID }, ['profile_id', 'destination_id']),
  'shipping_upgrades.list': action('R', 'List upgrades for a shipping profile.', { profile_id: ID }, ['profile_id']),
  'shipping_upgrades.create': action('W', 'Create an upgrade on a shipping profile.', { profile_id: ID, body: BODY }, ['profile_id', 'body']),
  'shipping_upgrades.update': action('H', 'Update a shipping-profile upgrade used by listings.', { profile_id: ID, upgrade_id: ID, body: BODY }, ['profile_id', 'upgrade_id', 'body']),
  'shipping_upgrades.delete': action('D', 'Delete a shipping-profile upgrade.', { profile_id: ID, upgrade_id: ID }, ['profile_id', 'upgrade_id']),
  'shop_sections.list': action('R', 'List shop sections.'),
  'shop_sections.get': action('R', 'Get one shop section.', { section_id: ID }, ['section_id']),
  'shop_sections.create': action('W', 'Create a shop section.', { body: BODY }, ['body']),
  'shop_sections.update': action('H', 'Rename a shop section visible to buyers.', { section_id: ID, body: BODY }, ['section_id', 'body']),
  'shop_sections.delete': action('D', 'Delete a shop section.', { section_id: ID }, ['section_id']),
  'production_partners.list': action('R', 'List the bound shop production partners.'),
});

const AMAZON_MARKETPLACE_REGIONS = Object.freeze({
  A2EUQ1WTGCTBG2: 'na', ATVPDKIKX0DER: 'na', A1AM78C64UM0Y8: 'na', A2Q3Y263D00KWC: 'na',
  A28R8C7NBKEWEA: 'eu', A1RKKUPIHCS9HS: 'eu', A1F83G8C2ARO7P: 'eu', A13V1IB3VIYZZH: 'eu',
  AMEN7PMS3EDWL: 'eu', A1805IZSGTT6HS: 'eu', A1PA6795UKMFR9: 'eu', APJ6JRA9NG5V4: 'eu',
  A2NODRKZP88ZB9: 'eu', AE08WJ6YKNBMC: 'eu', A1C3SOZRARQ6R3: 'eu', ARBP9OOSHTCHU: 'eu',
  A33AVAJ2PDY3EV: 'eu', A17E79C6D8DWNP: 'eu', A2VIGQ35RCS4UG: 'eu', A21TJRUUN4KGV: 'eu',
  A19VAU5U5O7RUS: 'fe', A39IBJ37TRP1C6: 'fe', A1VC38T7YXB528: 'fe',
});
const DATE_TIME = { type: 'string', minLength: 20, maxLength: 40 };
const AMAZON_ACTIONS = Object.freeze({
  'account.marketplace_participations': action('R', 'List the authorized seller marketplace participations and status.'),
  'catalog.search': action('R', 'Search the public Amazon catalog in the bound marketplace.', {
    keywords: { type: 'string', minLength: 1, maxLength: 1000 }, identifiers: { type: 'array', minItems: 1, maxItems: 20, items: ID },
    identifiers_type: { type: 'string', enum: ['ASIN', 'EAN', 'GTIN', 'ISBN', 'JAN', 'MINSAN', 'SKU', 'UPC'] },
    page_size: { type: 'integer', minimum: 1, maximum: 20 }, page_token: ID,
  }),
  'catalog.get': action('R', 'Get one public Amazon catalog item in the bound marketplace.', { asin: ID }, ['asin']),
  'listings.search': action('R', 'Search seller listings in the bound marketplace.', {
    sku: ID, status: { type: 'string', enum: ['BUYABLE', 'DISCOVERABLE'] },
    page_size: { type: 'integer', minimum: 1, maximum: 20 }, page_token: ID,
  }),
  'listings.get': action('R', 'Get one seller listing by SKU in the bound marketplace.', { sku: ID }, ['sku']),
  'listings.restrictions': action('R', 'Get listing restrictions for an ASIN in the bound marketplace.', {
    asin: ID, condition_type: { type: 'string', maxLength: 80 }, reason_locale: { type: 'string', maxLength: 20 },
  }, ['asin']),
  'listings.put': action('H', 'Create or fully replace a live seller listing in the bound marketplace.', {
    sku: ID, product_type: ID, requirements: { type: 'string', enum: ['LISTING', 'LISTING_PRODUCT_ONLY', 'LISTING_OFFER_ONLY'] }, body: BODY,
  }, ['sku', 'product_type', 'body']),
  'listings.patch': action('H', 'Apply reviewed JSON patches to a live seller listing in the bound marketplace.', {
    sku: ID, product_type: ID, body: BODY,
  }, ['sku', 'product_type', 'body']),
  'listings.delete': action('D', 'Delete a seller listing from the bound marketplace.', { sku: ID }, ['sku']),
  'orders.search': action('R', 'Search orders without requesting restricted buyer or recipient data.', {
    created_after: DATE_TIME, created_before: DATE_TIME, last_updated_after: DATE_TIME, last_updated_before: DATE_TIME,
    fulfillment_statuses: { type: 'array', minItems: 1, maxItems: 10, items: ID },
    fulfilled_by: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', enum: ['AMAZON', 'MERCHANT'] } },
    page_size: { type: 'integer', minimum: 1, maximum: 100 }, page_token: ID,
  }),
  'orders.get': action('R', 'Get one order without requesting restricted buyer or recipient data.', { order_id: ID }, ['order_id']),
  'inventory.fba_summaries': action('R', 'List FBA inventory summaries for the bound marketplace.', {
    start_date_time: DATE_TIME, seller_skus: { type: 'array', minItems: 1, maxItems: 50, items: ID }, next_token: ID,
  }),
  'finances.transactions': action('R', 'List financial transactions for the bound marketplace.', {
    posted_after: DATE_TIME, posted_before: DATE_TIME,
    transaction_status: { type: 'string', enum: ['DEFERRED', 'RELEASED'] }, next_token: ID,
  }),
  'finances.balances': action('R', 'List account balances for the bound marketplace.', {
    balance_type: ID, account_type: ID, as_of_date: DATE_TIME, next_token: ID,
  }),
  'finances.summary': action('R', 'List financial summary data for the bound marketplace.', {
    account_type: ID, period_start: DATE_TIME, period_end: DATE_TIME, next_token: ID,
  }),
  'product_types.search': action('R', 'Search Amazon listing product types for the bound marketplace.', {
    keywords: { type: 'string', minLength: 1, maxLength: 1000 },
  }),
  'product_types.get': action('R', 'Get a product-type listing schema for the bound marketplace.', {
    product_type: ID, requirements: { type: 'string', enum: ['LISTING', 'LISTING_PRODUCT_ONLY', 'LISTING_OFFER_ONLY'] },
  }, ['product_type']),
});

const MERCADO_LIBRE_ACTIONS = Object.freeze({
  'account.get': action('R', 'Get the bound Mercado Libre seller identity and account status.'),
  'listings.search': action('R', 'Search global listings owned by the bound seller.', { query: QUERY }),
  'listings.get': action('R', 'Get one global listing.', { item_id: ID }, ['item_id']),
  'marketplace_listings.get': action('R', 'Get one marketplace child listing.', { item_id: ID }, ['item_id']),
  'listings.marketplace_mappings': action('R', 'List marketplace child listings for one global listing.', { item_id: ID }, ['item_id']),
  'listings.create': action('H', 'Publish a new global listing.', { body: BODY }, ['body']),
  'listings.update': action('H', 'Update a global or marketplace listing and its buyer-visible state.', { item_id: ID, body: BODY }, ['item_id', 'body']),
  'listings.pause': action('H', 'Pause a marketplace listing.', { item_id: ID }, ['item_id']),
  'listings.delete_marketplace': action('D', 'Delete one paused marketplace child listing from a reviewed destination site.', {
    item_id: ID, site_id: { type: 'string', enum: ['MLA', 'MLB', 'MLC', 'MCO', 'MLM', 'MPE'] },
  }, ['item_id', 'site_id']),
  'orders.search': action('R', 'Search orders for the bound seller.', { query: QUERY }),
  'orders.get': action('R', 'Get one order.', { order_id: ID }, ['order_id']),
  'shipments.get': action('R', 'Get one shipment.', { shipment_id: ID }, ['shipment_id']),
  'shipments.items': action('R', 'List items in one shipment.', { shipment_id: ID }, ['shipment_id']),
  'shipments.costs': action('R', 'Get shipping costs for one shipment.', { shipment_id: ID }, ['shipment_id']),
  'shipments.compensation_costs': action('R', 'Get compensation costs for one shipment.', { shipment_id: ID }, ['shipment_id']),
  'questions.search': action('R', 'Search marketplace questions for the bound seller.', { query: QUERY }),
  'questions.get': action('R', 'Get one marketplace question.', { question_id: ID }, ['question_id']),
  'questions.answer': action('H', 'Send a reviewed answer to a marketplace buyer question.', { question_id: ID, text: { type: 'string', minLength: 1, maxLength: 2000 } }, ['question_id', 'text']),
  'questions.delete': action('D', 'Delete one marketplace question.', { question_id: ID }, ['question_id']),
  'price_benchmarks.list': action('R', 'List listing price benchmarks for the bound seller.', { query: QUERY }),
  'price_benchmarks.get': action('R', 'Get detailed price benchmark data for one item.', { item_id: ID }, ['item_id']),
  'prices.history': action('R', 'Get price history for one marketplace item.', { item_id: ID }, ['item_id']),
});

const TAOBAO_ACTIONS = Object.freeze({
  'account.get': action('R', 'Get the bound Taobao/Tmall seller identity and shop status.'),
  'listings.onsale': action('R', 'List products currently on sale without buyer data.', {
    query: { type: 'string', maxLength: 200 }, page_no: { type: 'integer', minimum: 1, maximum: 1000 },
    page_size: { type: 'integer', minimum: 1, maximum: 100 },
    order_by: { type: 'string', enum: ['list_time:desc', 'list_time:asc', 'modified:desc', 'modified:asc'] },
  }),
  'listings.inventory': action('R', 'List products in seller inventory without buyer data.', {
    query: { type: 'string', maxLength: 200 }, page_no: { type: 'integer', minimum: 1, maximum: 1000 },
    page_size: { type: 'integer', minimum: 1, maximum: 100 },
    order_by: { type: 'string', enum: ['list_time:desc', 'list_time:asc', 'modified:desc', 'modified:asc'] },
  }),
  'listings.get': action('R', 'Get one seller-owned product by numeric item ID.', { item_id: ID }, ['item_id']),
  'orders.list': action('R', 'List recent seller orders with a fixed non-PII field projection.', {
    start_created: { type: 'string', minLength: 19, maxLength: 19 },
    end_created: { type: 'string', minLength: 19, maxLength: 19 },
    status: { type: 'string', maxLength: 80 }, page_no: { type: 'integer', minimum: 1, maximum: 1000 },
    page_size: { type: 'integer', minimum: 1, maximum: 100 },
  }),
  'inventory.update': action('H', 'Set or adjust stock for one seller-owned item or SKU.', {
    item_id: ID, sku_id: ID, outer_id: { type: 'string', maxLength: 128 },
    quantity: { type: 'integer', minimum: 0, maximum: 2147483647 },
    mode: { type: 'string', enum: ['absolute', 'increment'] },
  }, ['item_id', 'quantity', 'mode']),
  'listings.publish': action('H', 'Publish one seller-owned fixed-price item, optionally with a reviewed quantity.', {
    item_id: ID, quantity: { type: 'integer', minimum: 0, maximum: 2147483647 },
  }, ['item_id']),
  'listings.unpublish': action('H', 'Take one seller-owned item off sale.', { item_id: ID }, ['item_id']),
  'orders.memo_add': action('W', 'Add an internal seller memo and optional flag to one order.', {
    order_id: ID, memo: { type: 'string', minLength: 1, maxLength: 1000 },
    flag: { type: 'integer', minimum: 1, maximum: 5 },
  }, ['order_id', 'memo']),
  'orders.memo_update': action('W', 'Update an internal seller memo and optional flag on one order.', {
    order_id: ID, memo: { type: 'string', minLength: 1, maxLength: 1000 },
    flag: { type: 'integer', minimum: 1, maximum: 5 },
  }, ['order_id', 'memo']),
  'listings.delete': action('D', 'Delete one seller-owned item.', { item_id: ID }, ['item_id']),
});

const ALIBABA_1688_SKU_STOCK = {
  type: 'object', additionalProperties: false, properties: {
    sku_id: ID, stock_change: { type: 'integer', minimum: -2147483648, maximum: 2147483647 },
  }, required: ['sku_id', 'stock_change'],
};
const ALIBABA_1688_STOCK_CHANGE = {
  type: 'object', additionalProperties: false, properties: {
    product_id: ID, product_amount_change: { type: 'integer', minimum: -2147483648, maximum: 2147483647 },
    sku_stocks: { type: 'array', minItems: 0, maxItems: 100, items: ALIBABA_1688_SKU_STOCK },
  }, required: ['product_id', 'product_amount_change', 'sku_stocks'],
};
const ALIBABA_1688_ORDER_ENTRY = {
  type: 'object', additionalProperties: false, properties: {
    order_entry_id: ID, amount: { type: 'integer', minimum: 1, maximum: 2147483647 },
    weight_kg: { type: 'number', exclusiveMinimum: 0, maximum: 1000000 },
  }, required: ['order_entry_id', 'amount', 'weight_kg'],
};
const ALIBABA_1688_ACTIONS = Object.freeze({
  'account.get': action('R', 'Get the bound 1688 seller account identity.'),
  'products.list': action('R', 'List seller products with reviewed filters.', {
    page: { type: 'integer', minimum: 1, maximum: 1000 }, page_size: { type: 'integer', minimum: 1, maximum: 20 },
    status: { type: 'string', enum: ['published', 'expired', 'TBD', 'deleted', 'new', 'modified', 'member expired'] },
    category_id: ID, keyword: { type: 'string', maxLength: 200 },
    product_ids: { type: 'array', minItems: 1, maxItems: 20, items: ID },
    order_by: { type: 'string', enum: ['CREATE_DATE', 'POST_DATE', 'MODIFY_DATE', 'APPROVED_DATE', 'EXPIRE_DATE', 'STATUS', 'ID', 'GROUP_ID', 'PRICE', 'SALE_QUANTITY'] },
    order_direction: { type: 'string', enum: ['ASC', 'DESC'] },
  }),
  'products.get': action('R', 'Get one seller product.', { product_id: ID }, ['product_id']),
  'orders.list': action('R', 'List seller orders without requesting buyer address or phone.', {
    create_start: { type: 'string', minLength: 19, maxLength: 19 }, create_end: { type: 'string', minLength: 19, maxLength: 19 },
    modify_start: { type: 'string', minLength: 19, maxLength: 19 }, modify_end: { type: 'string', minLength: 19, maxLength: 19 },
    page: { type: 'integer', minimum: 1, maximum: 1000 }, page_size: { type: 'integer', minimum: 1, maximum: 20 },
    status: { type: 'string', enum: ['success', 'cancel', 'waitbuyerpay', 'waitsellersend', 'waitbuyerreceive'] },
    refund_status: { type: 'string', enum: ['waitselleragree', 'refundsuccess', 'refundclose', 'waitbuyermodify', 'waitbuyersend', 'waitsellerreceive'] },
    product_name: { type: 'string', maxLength: 200 },
  }),
  'refunds.list': action('R', 'List seller refunds with reviewed date, status, and order filters.', {
    order_id: ID, apply_start: { type: 'string', minLength: 19, maxLength: 19 }, apply_end: { type: 'string', minLength: 19, maxLength: 19 },
    modify_start: { type: 'string', minLength: 19, maxLength: 19 }, modify_end: { type: 'string', minLength: 19, maxLength: 19 },
    statuses: { type: 'array', minItems: 1, maxItems: 20, items: ID },
    page: { type: 'integer', minimum: 0, maximum: 1000 }, page_size: { type: 'integer', minimum: 1, maximum: 20 },
    dispute_type: { type: 'integer', minimum: 0, maximum: 2 },
  }),
  'freight_templates.list': action('R', 'List freight templates or retrieve one reviewed template.', {
    template_id: ID, include_subtemplates: { type: 'boolean' }, include_rates: { type: 'boolean' },
  }),
  'inventory.adjust': action('H', 'Apply reviewed stock deltas to up to 20 products.', {
    changes: { type: 'array', minItems: 1, maxItems: 20, items: ALIBABA_1688_STOCK_CHANGE },
  }, ['changes']),
  'products.update': action('H', 'Incrementally update buyer-visible title, description, or online-trade state.', {
    product_id: ID, subject: { type: 'string', minLength: 1, maxLength: 120 },
    description: { type: 'string', minLength: 1, maxLength: 100000 }, support_online_trade: { type: 'boolean' },
  }, ['product_id']),
  'products.expire': action('H', 'Move up to 20 reviewed products to expired/off-sale state.', {
    product_ids: { type: 'array', minItems: 1, maxItems: 20, items: ID },
  }, ['product_ids']),
  'shipments.offline': action('H', 'Mark one order as shipped with a reviewed carrier and tracking number.', {
    order_id: ID, entries: { type: 'array', minItems: 1, maxItems: 100, items: ALIBABA_1688_ORDER_ENTRY },
    carrier_code: { type: 'string', minLength: 1, maxLength: 64 }, carrier_name: { type: 'string', minLength: 1, maxLength: 100 },
    tracking_number: { type: 'string', minLength: 1, maxLength: 128 }, remarks: { type: 'string', maxLength: 500 },
  }, ['order_id', 'entries', 'carrier_code', 'carrier_name', 'tracking_number']),
  'shipments.no_logistics': action('H', 'Mark one order fulfilled without a carrier using a reviewed official reason.', {
    order_id: ID, entries: { type: 'array', minItems: 1, maxItems: 100, items: ALIBABA_1688_ORDER_ENTRY },
    reason: { type: 'string', enum: ['1', '2', '3', '4', '5'] }, name: { type: 'string', maxLength: 100 },
    phone: { type: 'string', maxLength: 32 }, bill_number: { type: 'string', maxLength: 128 }, remarks: { type: 'string', maxLength: 500 },
  }, ['order_id', 'entries', 'reason']),
  'products.delete': action('D', 'Delete one reviewed seller product.', { product_id: ID }, ['product_id']),
});

const JD_SKU_STOCK = {
  type: 'object', additionalProperties: false, properties: {
    sku_id: ID, stock: { type: 'integer', minimum: -2147483648, maximum: 2147483647 },
    store_id: ID, stock_model: { type: 'string', enum: ['POP_SOP', 'POP_PARTITION'] },
  }, required: ['sku_id', 'stock'],
};
const JD_ACTIONS = Object.freeze({
  'account.get': action('R', 'Get the bound JD.com seller and shop identity.'),
  'products.list_valid': action('R', 'List valid seller products with reviewed filters.', {
    page: { type: 'integer', minimum: 1, maximum: 1000 }, page_size: { type: 'integer', minimum: 1, maximum: 50 },
    keyword: { type: 'string', maxLength: 200 }, product_ids: { type: 'array', minItems: 1, maxItems: 20, items: ID },
  }),
  'products.list_recycled': action('R', 'List products in the seller recycle bin.', {
    page: { type: 'integer', minimum: 1, maximum: 1000 }, page_size: { type: 'integer', minimum: 1, maximum: 50 },
    keyword: { type: 'string', maxLength: 200 }, product_ids: { type: 'array', minItems: 1, maxItems: 20, items: ID },
  }),
  'products.get': action('R', 'Get one seller product.', { product_id: ID }, ['product_id']),
  'skus.list': action('R', 'List SKUs for up to 10 products or 20 SKU IDs.', {
    product_ids: { type: 'array', minItems: 1, maxItems: 10, items: ID },
    sku_ids: { type: 'array', minItems: 1, maxItems: 20, items: ID },
    page: { type: 'integer', minimum: 1, maximum: 1000 }, page_size: { type: 'integer', minimum: 1, maximum: 50 },
  }),
  'skus.get': action('R', 'Get one seller SKU.', { sku_id: ID }, ['sku_id']),
  'inventory.get': action('R', 'Get stock for up to 20 reviewed SKUs.', {
    sku_ids: { type: 'array', minItems: 1, maxItems: 20, items: ID },
  }, ['sku_ids']),
  'orders.list': action('R', 'List non-PII seller order data with reviewed filters.', {
    order_state: { type: 'string', minLength: 1, maxLength: 64 },
    start_date: { type: 'string', minLength: 19, maxLength: 19 }, end_date: { type: 'string', minLength: 19, maxLength: 19 },
    page: { type: 'integer', minimum: 1, maximum: 1000 }, page_size: { type: 'integer', minimum: 1, maximum: 100 },
    date_type: { type: 'integer', minimum: 0, maximum: 2 }, sort_type: { type: 'integer', minimum: 1, maximum: 2 },
  }, ['order_state']),
  'orders.get': action('R', 'Get one order without requesting buyer, consignee, invoice, or contact fields.', {
    order_id: ID,
  }, ['order_id']),
  'refunds.list': action('R', 'List after-sales refund applications.', {
    page: { type: 'integer', minimum: 1, maximum: 1000 }, page_size: { type: 'integer', minimum: 1, maximum: 100 },
    status: { type: 'integer', minimum: 1, maximum: 16 }, order_id: ID,
  }),
  'refunds.get': action('R', 'Get one after-sales refund application.', { refund_id: ID }, ['refund_id']),
  'refunds.waiting_count': action('R', 'Get the count of refund applications awaiting seller handling.'),
  'orders.memo_update': action('W', 'Update an internal seller remark on one order.', {
    order_id: ID, remark: { type: 'string', minLength: 1, maxLength: 500 },
  }, ['order_id', 'remark']),
  'products.recover': action('W', 'Recover one product from the seller recycle bin.', { product_id: ID }, ['product_id']),
  'inventory.set': action('H', 'Set absolute stock or apply reviewed stock increments to up to 100 SKUs.', {
    update_mode: { type: 'string', enum: ['absolute', 'increment'] }, stock_reference_id: { type: 'string', minLength: 1, maxLength: 128 },
    sku_stocks: { type: 'array', minItems: 1, maxItems: 100, items: JD_SKU_STOCK },
  }, ['update_mode', 'stock_reference_id', 'sku_stocks']),
  'prices.update': action('H', 'Update the buyer-visible JD price for one SKU.', {
    sku_id: ID, price_yuan: { type: 'number', exclusiveMinimum: 0, maximum: 100000000 },
  }, ['sku_id', 'price_yuan']),
  'products.publish': action('H', 'Publish one product.', { product_id: ID, reason: { type: 'string', maxLength: 200 } }, ['product_id']),
  'products.unpublish': action('H', 'Take one product off sale.', { product_id: ID, reason: { type: 'string', maxLength: 200 } }, ['product_id']),
  'products.title_update': action('H', 'Update the buyer-visible title of one product.', {
    product_id: ID, title: { type: 'string', minLength: 1, maxLength: 100 },
  }, ['product_id', 'title']),
  'shipments.create': action('H', 'Mark one order shipped with reviewed carrier and waybill data.', {
    order_id: ID, logistics_id: ID, waybill: { type: 'string', minLength: 1, maxLength: 128 },
  }, ['order_id', 'logistics_id', 'waybill']),
  'shipments.update': action('H', 'Correct the carrier or waybill for one shipped order.', {
    order_id: ID, logistics_id: ID, waybill: { type: 'string', minLength: 1, maxLength: 128 },
  }, ['order_id', 'logistics_id', 'waybill']),
  'refunds.decide': action('H', 'Approve, reject, or otherwise decide one refund using an official reviewed status.', {
    refund_id: ID, status: { type: 'integer', enum: [1, 2, 6, 9, 10, 16] },
    operator_name: { type: 'string', minLength: 1, maxLength: 100 }, remark: { type: 'string', maxLength: 500 },
    reject_type: { type: 'integer', minimum: 1, maximum: 99 }, out_ware_status: { type: 'integer', enum: [1, 2] },
  }, ['refund_id', 'status', 'operator_name']),
  'products.delete': action('D', 'Move one product to the seller recycle bin.', { product_id: ID }, ['product_id']),
});

const PINDUODUO_ACTIONS = Object.freeze({
  'account.get': action('R', 'Get the bound Pinduoduo merchant identity.'),
  'products.list': action('R', 'List seller products with reviewed filters.', {
    page: { type: 'integer', minimum: 1, maximum: 1000 }, page_size: { type: 'integer', minimum: 1, maximum: 100 },
    keyword: { type: 'string', maxLength: 200 }, outer_id: { type: 'string', maxLength: 128 }, outer_goods_id: { type: 'string', maxLength: 128 },
    is_on_sale: { type: 'boolean' }, cost_template_id: ID,
  }),
  'products.get': action('R', 'Get one seller product.', { product_id: ID }, ['product_id']),
  'orders.list_basic': action('R', 'List order basics using the official endpoint that excludes consumer information.', {
    start_confirmed_at: { type: 'integer', minimum: 1 }, end_confirmed_at: { type: 'integer', minimum: 1 },
    order_status: { type: 'integer', enum: [1, 2, 3, 5] }, refund_status: { type: 'integer', enum: [1, 2, 3, 4, 5] },
    page: { type: 'integer', minimum: 1, maximum: 1000 }, page_size: { type: 'integer', minimum: 1, maximum: 100 },
    trade_type: { type: 'integer', minimum: 0, maximum: 99 }, use_has_next: { type: 'boolean' },
  }, ['start_confirmed_at', 'end_confirmed_at', 'order_status']),
  'orders.status': action('R', 'Get status for up to 20 reviewed orders.', {
    order_ids: { type: 'array', minItems: 1, maxItems: 20, items: ID },
  }, ['order_ids']),
  'logistics.companies': action('R', 'List available logistics companies.'),
  'refunds.list': action('R', 'List after-sales cases updated in a reviewed 30-minute window.', {
    after_sales_status: { type: 'integer', minimum: 0, maximum: 32 }, after_sales_type: { type: 'integer', enum: [1, 2, 3, 4, 5] },
    start_updated_at: { type: 'integer', minimum: 1 }, end_updated_at: { type: 'integer', minimum: 1 },
    order_id: ID, page: { type: 'integer', minimum: 1, maximum: 1000 }, page_size: { type: 'integer', minimum: 1, maximum: 100 },
  }, ['after_sales_status', 'after_sales_type', 'start_updated_at', 'end_updated_at']),
  'refunds.get': action('R', 'Get one after-sales case.', { order_id: ID, after_sales_id: ID }, ['order_id']),
  'refunds.return_addresses': action('R', 'List merchant return addresses needed for reviewed return approvals.'),
  'orders.note_update': action('W', 'Update one internal seller note and optional tag.', {
    order_id: ID, note: { type: 'string', minLength: 1, maxLength: 500 }, tag: { type: 'integer', minimum: 1, maximum: 5 },
    tag_name: { type: 'string', minLength: 1, maxLength: 3 },
  }, ['order_id', 'note']),
  'inventory.update': action('H', 'Set or increment inventory for one product SKU.', {
    product_id: ID, sku_id: ID, outer_id: { type: 'string', maxLength: 128 },
    quantity: { type: 'integer', minimum: -2147483648, maximum: 2147483647 }, mode: { type: 'string', enum: ['absolute', 'increment'] },
  }, ['product_id', 'quantity', 'mode']),
  'prices.update': action('H', 'Update buyer-visible SKU prices for one product.', {
    product_id: ID, market_price_fen: { type: 'integer', minimum: 1, maximum: 2147483647 },
    sku_prices: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', additionalProperties: false, properties: {
      sku_id: ID, group_price_fen: { type: 'integer', minimum: 1, maximum: 2147483647 },
      single_price_fen: { type: 'integer', minimum: 1, maximum: 2147483647 }, is_on_sale: { type: 'boolean' },
    }, required: ['sku_id'] } },
  }, ['product_id', 'sku_prices']),
  'products.publish': action('H', 'Publish one product.', { product_id: ID }, ['product_id']),
  'products.unpublish': action('H', 'Take one product off sale.', { product_id: ID }, ['product_id']),
  'shipments.send': action('H', 'Mark one order shipped with a reviewed logistics company and tracking number.', {
    order_id: ID, logistics_id: ID, tracking_number: { type: 'string', minLength: 1, maxLength: 128 }, refund_address_id: ID,
  }, ['order_id', 'logistics_id', 'tracking_number']),
  'shipments.update': action('H', 'Correct logistics information for one previously shipped order.', {
    order_id: ID, logistics_id: ID, tracking_number: { type: 'string', minLength: 1, maxLength: 128 }, refund_address_id: ID,
  }, ['order_id', 'logistics_id', 'tracking_number']),
  'refunds.approve': action('H', 'Approve a refund-only after-sales case.', {
    order_id: ID, after_sales_id: ID, description: { type: 'string', maxLength: 500 },
  }, ['order_id', 'after_sales_id']),
  'refunds.return_approve': action('H', 'Approve a return-and-refund case with a reviewed merchant return address.', {
    order_id: ID, after_sales_id: ID, return_address_id: ID, description: { type: 'string', maxLength: 500 },
  }, ['order_id', 'after_sales_id', 'return_address_id']),
  'refunds.exchange_ship': action('H', 'Ship a replacement for one approved exchange case.', {
    order_id: ID, after_sales_id: ID, logistics_id: ID, logistics_name: { type: 'string', minLength: 1, maxLength: 100 },
    tracking_number: { type: 'string', minLength: 1, maxLength: 128 },
  }, ['order_id', 'after_sales_id', 'logistics_id', 'logistics_name', 'tracking_number']),
  'products.delete': action('D', 'Delete up to 10 reviewed seller products.', {
    product_ids: { type: 'array', minItems: 1, maxItems: 10, items: ID },
  }, ['product_ids']),
});

const DOUYIN_SHOP_ACTIONS = Object.freeze({
  'account.get': action('R', 'Get the bound Douyin Shop authorization and shop identity.'),
  'products.list': action('R', 'List seller products with official product filters.', { query: BODY }),
  'products.get': action('R', 'Get one seller product.', { product_id: ID }, ['product_id']),
  'skus.list': action('R', 'List SKUs for one seller product.', { product_id: ID }, ['product_id']),
  'skus.get': action('R', 'Get one SKU for one seller product.', { product_id: ID, sku_id: ID }, ['product_id', 'sku_id']),
  'inventory.get': action('R', 'Get stock for one reviewed SKU.', { sku_id: ID }, ['sku_id']),
  'orders.list': action('R', 'List orders using official reviewed filters; sensitive buyer and receiver fields are removed.', { query: BODY }),
  'orders.get': action('R', 'Get one order with sensitive buyer and receiver fields removed.', { order_id: ID }, ['order_id']),
  'refunds.list': action('R', 'List after-sales cases; sensitive return-contact fields are removed.', { query: BODY }),
  'refunds.get': action('R', 'Get one after-sales case with sensitive return-contact fields removed.', { after_sale_id: ID }, ['after_sale_id']),
  'refunds.reject_reasons': action('R', 'List official rejection reasons for one after-sales case.', { after_sale_id: ID }, ['after_sale_id']),
  'orders.memo_update': action('W', 'Update one internal seller order remark.', {
    order_id: ID, remark: { type: 'string', minLength: 1, maxLength: 500 },
  }, ['order_id', 'remark']),
  'products.create': action('H', 'Create a buyer-visible seller product from a reviewed official product payload.', { payload: BODY }, ['payload']),
  'products.update': action('H', 'Update one buyer-visible seller product from a reviewed official product payload.', {
    product_id: ID, payload: BODY,
  }, ['product_id', 'payload']),
  'inventory.update': action('H', 'Set absolute stock for one reviewed SKU.', {
    product_id: ID, sku_id: ID, quantity: { type: 'integer', minimum: 0, maximum: 99999999 },
  }, ['product_id', 'sku_id', 'quantity']),
  'prices.update': action('H', 'Update the buyer-visible price for one reviewed SKU in fen.', {
    product_id: ID, sku_id: ID, price_fen: { type: 'integer', minimum: 1, maximum: 2147483647 },
  }, ['product_id', 'sku_id', 'price_fen']),
  'products.publish': action('H', 'Publish one seller product.', { product_id: ID }, ['product_id']),
  'products.unpublish': action('H', 'Take one seller product off sale.', { product_id: ID }, ['product_id']),
  'shipments.send': action('H', 'Mark one order shipped using reviewed official logistics data.', {
    order_id: ID, payload: BODY,
  }, ['order_id', 'payload']),
  'shipments.update': action('H', 'Correct logistics data for one shipped order.', {
    order_id: ID, payload: BODY,
  }, ['order_id', 'payload']),
  'refunds.decide': action('H', 'Approve, reject, or approve return handling for one after-sales case.', {
    after_sale_id: ID, decision: { type: 'string', enum: ['approve', 'reject', 'return_approve'] }, payload: BODY,
  }, ['after_sale_id', 'decision']),
  'products.delete': action('D', 'Delete one reviewed seller product.', { product_id: ID }, ['product_id']),
});

const KUAISHOU_SHOP_ACTIONS = Object.freeze({
  'account.get': action('R', 'Get the bound Kuaishou seller and shop identities.'),
  'products.list': action('R', 'List seller products with reviewed official filters.', {
    item_id: ID, external_item_id: { type: 'string', maxLength: 128 },
    page: { type: 'integer', minimum: 1, maximum: 1000 }, page_size: { type: 'integer', minimum: 10, maximum: 100 },
    item_status: { type: 'integer', enum: [1] }, item_type: { type: 'integer', enum: [1] },
    on_offline_status: { type: 'integer', enum: [1] }, support_negative_stock: { type: 'boolean' },
  }),
  'products.get': action('R', 'Get one seller product.', {
    item_id: ID, support_negative_stock: { type: 'boolean' },
  }, ['item_id']),
  'skus.list': action('R', 'List SKUs for one seller product.', {
    item_id: ID, external_sku_id: { type: 'string', maxLength: 128 },
    sku_status: { type: 'integer', enum: [1] },
  }, ['item_id']),
  'orders.list': action('R', 'List orders in a reviewed seven-day window; sensitive buyer and receiver fields are removed.', {
    cursor: { type: 'string', maxLength: 1024 }, order_view_status: { type: 'integer', minimum: 0, maximum: 7 },
    page_size: { type: 'integer', minimum: 1, maximum: 50 }, sort: { type: 'integer', enum: [1, 2] },
    query_type: { type: 'integer', enum: [1, 2] }, begin_time: { type: 'integer', minimum: 1 },
    end_time: { type: 'integer', minimum: 1 }, cps_type: { type: 'integer', enum: [0, 1, 2] },
  }, ['query_type', 'begin_time', 'end_time']),
  'orders.get': action('R', 'Get one order with sensitive buyer and receiver fields removed.', { order_id: ID }, ['order_id']),
  'refunds.list': action('R', 'List after-sales cases in a reviewed one-day window.', {
    cursor: { type: 'string', maxLength: 1024 }, page: { type: 'integer', minimum: 1, maximum: 1000 },
    page_size: { type: 'integer', minimum: 1, maximum: 100 }, sort: { type: 'integer', enum: [1, 2] },
    query_type: { type: 'integer', enum: [1, 2] }, begin_time: { type: 'integer', minimum: 1 },
    end_time: { type: 'integer', minimum: 1 }, refund_type: { type: 'integer', enum: [8, 9] },
    negotiate_status: { type: 'integer', enum: [1, 2, 3] },
    status: { type: 'integer', enum: [10, 12, 20, 30, 40, 45, 50, 60, 70] }, order_id: ID,
  }, ['query_type', 'begin_time', 'end_time']),
  'refunds.get': action('R', 'Get one after-sales case with sensitive return-contact fields removed.', { refund_id: ID }, ['refund_id']),
  'refunds.reject_reasons': action('R', 'List official rejection reasons for one after-sales case.', { refund_id: ID }, ['refund_id']),
  'addresses.list': action('R', 'List reviewed seller shipping or return addresses.', {
    address_type: { type: 'integer', enum: [2, 3] },
  }, ['address_type']),
  'products.create': action('H', 'Create a buyer-visible product from a reviewed official item payload.', { payload: BODY }, ['payload']),
  'products.update': action('H', 'Update one buyer-visible product from a reviewed official item payload.', {
    item_id: ID, payload: BODY,
  }, ['item_id', 'payload']),
  'products.publish': action('H', 'Publish one seller product.', { item_id: ID }, ['item_id']),
  'products.unpublish': action('H', 'Take one seller product off sale.', { item_id: ID }, ['item_id']),
  'inventory.update': action('H', 'Increase or decrease stock for one reviewed SKU.', {
    item_id: ID, sku_id: ID, quantity: { type: 'integer', minimum: 1, maximum: 9999998 },
    change_type: { type: 'integer', enum: [1, 2] },
  }, ['item_id', 'sku_id', 'quantity', 'change_type']),
  'prices.update': action('H', 'Update the buyer-visible price for one reviewed SKU in fen.', {
    item_id: ID, sku_id: ID, price_fen: { type: 'integer', minimum: 1, maximum: 2147483647 },
  }, ['item_id', 'sku_id', 'price_fen']),
  'shipments.send': action('H', 'Mark one order shipped with reviewed carrier and tracking data.', {
    order_id: ID, express_code: { type: 'integer', minimum: 1 }, tracking_number: { type: 'string', minLength: 1, maxLength: 128 },
    return_address_id: ID, serial_numbers: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 128 } },
    imeis: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 128 } },
  }, ['order_id', 'express_code', 'tracking_number']),
  'shipments.update': action('H', 'Correct carrier and tracking data for one shipped order.', {
    order_id: ID, express_code: { type: 'integer', minimum: 1 }, tracking_number: { type: 'string', minLength: 1, maxLength: 128 },
    logistics_id: ID,
  }, ['order_id', 'express_code', 'tracking_number']),
  'refunds.approve': action('H', 'Approve one refund amount in fen.', {
    refund_id: ID, refund_amount_fen: { type: 'integer', minimum: 1, maximum: 2147483647 },
    status: { type: 'integer', minimum: 1, maximum: 100 }, negotiate_status: { type: 'integer', minimum: 1, maximum: 100 },
    handling_way: { type: 'integer', minimum: 1, maximum: 100 },
  }, ['refund_id', 'refund_amount_fen']),
  'refunds.reject': action('H', 'Reject one after-sales case using a reviewed official reason and version.', {
    refund_id: ID, reason_code: ID, refund_version: { type: 'integer', minimum: 1 },
    description: { type: 'string', maxLength: 500 },
    image_urls: { type: 'array', maxItems: 6, items: { type: 'string', pattern: '^https://', maxLength: 2048 } },
    handling_way: { type: 'integer', minimum: 1, maximum: 100 }, return_address_id: ID,
  }, ['refund_id', 'reason_code', 'refund_version']),
  'refunds.return_approve': action('H', 'Approve a return-and-refund case and refund amount in fen.', {
    refund_id: ID, refund_amount_fen: { type: 'integer', minimum: 1, maximum: 2147483647 }, address_id: ID,
  }, ['refund_id', 'refund_amount_fen']),
  'products.delete': action('D', 'Delete one reviewed seller product.', {
    item_id: ID, external_item_id: { type: 'string', maxLength: 128 },
  }, ['item_id']),
});

const YOUZAN_ACTIONS = Object.freeze({
  'account.get': action('R', 'Get the shop identity bound to the Youzan self-use application.'),
  'products.list_on_sale': action('R', 'List on-sale products with reviewed official filters.', { query: BODY }),
  'products.list_inventory': action('R', 'List off-sale or sold-out products with reviewed official filters.', { query: BODY }),
  'products.get': action('R', 'Get one seller product.', { item_id: ID }, ['item_id']),
  'orders.list': action('R', 'List seller orders; sensitive buyer and receiver fields are removed.', { query: BODY }),
  'orders.get': action('R', 'Get one order with sensitive buyer and receiver fields removed.', { order_id: ID }, ['order_id']),
  'products.create': action('H', 'Create a buyer-visible product from a reviewed official item payload.', { payload: BODY }, ['payload']),
  'products.update': action('H', 'Update one buyer-visible product from a reviewed official item payload.', {
    item_id: ID, payload: BODY,
  }, ['item_id', 'payload']),
  'inventory.update': action('H', 'Set or adjust inventory using the reviewed Youzan item-quantity endpoint.', {
    item_id: ID, payload: BODY,
  }, ['item_id', 'payload']),
  'products.publish': action('H', 'Publish one seller product.', { item_id: ID }, ['item_id']),
  'products.unpublish': action('H', 'Take one seller product off sale.', { item_id: ID }, ['item_id']),
  'shipments.send': action('H', 'Mark one order shipped using reviewed official logistics data.', {
    order_id: ID, payload: BODY,
  }, ['order_id', 'payload']),
  'products.delete': action('D', 'Delete one reviewed seller product.', { item_id: ID }, ['item_id']),
});

const WEIMOB_WOS_ACTIONS = Object.freeze({
  'account.get': action('R', 'Get the organizations visible to the bound Weimob WOS shop token.'),
  'organizations.get': action('R', 'Get one Weimob WOS organization by vid.', { vid: ID }, ['vid']),
  'products.list': action('R', 'List seller products with reviewed v2.0 WOS filters.', { payload: BODY }, ['payload']),
  'products.get': action('R', 'Get one seller product with the reviewed official request payload.', { payload: BODY }, ['payload']),
  'skus.search': action('R', 'Search seller SKUs with reviewed official filters.', { payload: BODY }, ['payload']),
  'orders.list': action('R', 'List orders in a reviewed time range; sensitive buyer and receiver fields are removed.', { payload: BODY }, ['payload']),
  'orders.get': action('R', 'Get one order with sensitive buyer and receiver fields removed.', { payload: BODY }, ['payload']),
  'refunds.list': action('R', 'List after-sales cases in a reviewed time range; sensitive contact fields are removed.', { payload: BODY }, ['payload']),
  'refunds.get': action('R', 'Get one after-sales case with sensitive contact fields removed.', { payload: BODY }, ['payload']),
  'products.create': action('H', 'Create a buyer-visible product from a reviewed official goods payload.', { payload: BODY }, ['payload']),
  'products.update': action('H', 'Fully replace one buyer-visible product after reviewing the current product state.', { payload: BODY }, ['payload']),
  'inventory.update': action('H', 'Set absolute inventory using the reviewed Weimob WOS stock endpoint.', { payload: BODY }, ['payload']),
  'prices.update': action('H', 'Update buyer-visible SKU prices with a reviewed official payload.', { payload: BODY }, ['payload']),
  'products.publish': action('H', 'Publish up to 10 reviewed products.', {
    vid: ID, goods_ids: { type: 'array', minItems: 1, maxItems: 10, items: ID },
  }, ['vid', 'goods_ids']),
  'products.unpublish': action('H', 'Take up to 10 reviewed products off sale.', {
    vid: ID, goods_ids: { type: 'array', minItems: 1, maxItems: 10, items: ID },
  }, ['vid', 'goods_ids']),
  'shipments.send': action('H', 'Mark one order shipped using reviewed official logistics data.', { payload: BODY }, ['payload']),
  'shipments.update': action('H', 'Correct logistics information for one shipped order.', { payload: BODY }, ['payload']),
  'refunds.approve': action('H', 'Approve one reviewed after-sales request.', { payload: BODY }, ['payload']),
  'refunds.reject': action('H', 'Reject one reviewed after-sales request with an explicit reason.', { payload: BODY }, ['payload']),
  'products.delete': action('D', 'Delete up to 10 reviewed seller products.', {
    vid: ID, goods_ids: { type: 'array', minItems: 1, maxItems: 10, items: ID },
  }, ['vid', 'goods_ids']),
});

const XIAOHONGSHU_ARK_ACTIONS = Object.freeze({
  'connection.check': action('R', 'Verify the production Ark app credentials with a one-item lightweight product query.'),
  'catalog.brands.search': action('R', 'Search official Xiaohongshu brand IDs.', {
    keyword: { type: 'string', minLength: 1, maxLength: 100 },
    page: { type: 'integer', minimum: 1, maximum: 10_000 },
    page_size: { type: 'integer', minimum: 1, maximum: 50 },
  }, ['keyword']),
  'catalog.categories.list': action('R', 'List official seller categories.', {
    category_ids: { type: 'array', minItems: 1, maxItems: 25, items: ID },
  }),
  'catalog.category_variants.list': action('R', 'List variations for one category.', { category_id: ID }, ['category_id']),
  'catalog.category_attributes.list': action('R', 'List attribute options for one category.', { category_id: ID }, ['category_id']),
  'catalog.attribute_values.list': action('R', 'List values for one official attribute.', { attribute_id: ID }, ['attribute_id']),
  'catalog.logistics_companies.list': action('R', 'List official express-company codes.'),
  'catalog.logistics_modes.list': action('R', 'List logistics modes available to the seller application.'),
  'products.list_lite': action('R', 'List lightweight seller product records with reviewed filters.', { query: QUERY }),
  'products.list': action('R', 'List complete seller product records with reviewed filters.', { query: QUERY }),
  'products.get': action('R', 'Get one seller product by item ID.', { item_id: ID }, ['item_id']),
  'products.spu_get': action('R', 'Get one seller SPU.', { spu_id: ID }, ['spu_id']),
  'inventory.get': action('R', 'Get current inventory for one seller item.', { item_id: ID }, ['item_id']),
  'orders.list_latest': action('R', 'List recent paid orders without consumer PII.', { query: QUERY }),
  'orders.list': action('R', 'List orders without exporting them or exposing consumer PII.', { query: QUERY }),
  'orders.statuses_get': action('R', 'Get statuses for up to 10 package IDs.', { package_ids: IDS }, ['package_ids']),
  'cancellations.list': action('R', 'List pending cancellation requests without consumer PII.', { query: QUERY }),
  'products.spu_create': action('W', 'Create a non-published SPU from a reviewed official payload.', { payload: BODY }, ['payload']),
  'products.spl_create': action('W', 'Create a non-published SPL under one SPU.', { spu_id: ID, payload: BODY }, ['spu_id', 'payload']),
  'products.spl_item_create': action('W', 'Create non-published SPL item content.', { spl_id: ID, payload: BODY }, ['spl_id', 'payload']),
  'products.spv_create': action('W', 'Create a non-published SPV under one SPL.', { spl_id: ID, payload: BODY }, ['spl_id', 'payload']),
  'products.item_create': action('W', 'Create a non-published item under one SPV.', { spv_id: ID, payload: BODY }, ['spv_id', 'payload']),
  'products.spu_update': action('H', 'Update one product SPU after reviewing its current buyer-visible state.', { spu_id: ID, payload: BODY }, ['spu_id', 'payload']),
  'products.spl_update': action('H', 'Update one product SPL after reviewing its current buyer-visible state.', { spl_id: ID, payload: BODY }, ['spl_id', 'payload']),
  'products.spl_item_update': action('H', 'Update buyer-visible SPL item content.', { spl_id: ID, payload: BODY }, ['spl_id', 'payload']),
  'products.spv_update': action('H', 'Update one buyer-visible SPV.', { spv_id: ID, payload: BODY }, ['spv_id', 'payload']),
  'products.spv_customs_update': action('H', 'Update customs data for one SPV.', { spv_id: ID, payload: BODY }, ['spv_id', 'payload']),
  'products.item_update': action('H', 'Update one buyer-visible item, including reviewed price fields.', { item_id: ID, payload: BODY }, ['item_id', 'payload']),
  'products.item_logistics_update': action('H', 'Update the logistics mode for one buyer-visible item.', { item_id: ID, payload: BODY }, ['item_id', 'payload']),
  'products.submit_review': action('H', 'Submit one SPL item for platform review.', { spl_id: ID, payload: BODY }, ['spl_id']),
  'products.availability_set': action('H', 'Publish or unpublish one reviewed item.', { item_id: ID, available: { type: 'boolean' } }, ['item_id', 'available']),
  'inventory.set': action('H', 'Set absolute inventory for one reviewed item.', {
    item_id: ID, quantity: { type: 'integer', minimum: 0, maximum: 1_000_000_000 },
  }, ['item_id', 'quantity']),
  'inventory.adjust': action('H', 'Atomically increase or decrease inventory for one reviewed item.', {
    item_id: ID, quantity_delta: { type: 'integer', minimum: -1_000_000_000, maximum: 1_000_000_000 },
  }, ['item_id', 'quantity_delta']),
  'orders.export': action('H', 'Export one order detail. This changes the buyer cancellation state; consumer PII is removed from output.', { package_id: ID }, ['package_id']),
  'shipments.send': action('H', 'Ship one exported order with a reviewed express company and tracking number.', {
    package_id: ID, express_company_code: ID, express_no: ID,
  }, ['package_id', 'express_company_code', 'express_no']),
  'transfer_batches.create': action('H', 'Create one reviewed small-parcel transfer batch.', {
    packages: { type: 'array', minItems: 1, maxItems: 10, items: {
      type: 'object', additionalProperties: false, properties: {
        package_id: ID, weight: { type: 'number', exclusiveMinimum: 0, maximum: 10_000 },
      }, required: ['package_id', 'weight'],
    } },
  }, ['packages']),
  'transfer_batches.ship': action('H', 'Ship one reviewed small-parcel transfer batch.', { batch_no: ID }, ['batch_no']),
  'cancellations.audit': action('H', 'Approve or refuse one reviewed cancellation request.', {
    package_id: ID, audit_result: { type: 'string', enum: ['canceled', 'refused'] },
    audit_reason: { type: 'string', maxLength: 500 },
  }, ['package_id', 'audit_result']),
});

function configured(env = process.env) {
  const provider = String(env.ORKAS_LOCAL_API_PROVIDER || '');
  if (!PROVIDERS.has(provider) && !sellerApi.isSellerProvider(provider) && !storefrontApi.isProvider(provider)) throw new Error('unsupported direct commerce provider');
  const credentialFile = String(env.ORKAS_LOCAL_API_CREDENTIAL_FILE || '');
  const credentialKey = String(env.ORKAS_LOCAL_API_CREDENTIAL_KEY || '');
  if (!credentialFile || !credentialKey) throw new Error('local API credential runtime is incomplete');
  let metadata;
  try { metadata = JSON.parse(env.ORKAS_LOCAL_API_METADATA_JSON || '{}'); } catch { metadata = {}; }
  let credentials = {};
  try { credentials = readCredentialFile(credentialFile, credentialKey); }
  catch { throw new Error('local API credentials are unavailable; reconnect this connector'); }
  if (credentials.provider !== provider) throw new Error('local API credential provider mismatch');
  const config = { provider, credentialFile, credentialKey, credentials, metadata };
  if (sellerApi.isSellerProvider(provider)) sellerApi.validateBinding(config);
  if (storefrontApi.isProvider(provider)) storefrontApi.validateBinding(config);
  if (provider === 'commerce_layer') {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(String(metadata.organization_slug || ''))
        || typeof credentials.client_id !== 'string' || credentials.client_id.length < 3
        || typeof credentials.client_secret !== 'string' || credentials.client_secret.length < 8) {
      throw new Error('invalid Commerce Layer integration credentials or organization binding');
    }
  }
  if (provider === 'ebay') {
    if (!['sandbox', 'live'].includes(metadata.environment)
        || !EBAY_MARKETPLACE_LOCALES[metadata.marketplace_id]?.includes(metadata.content_language)) {
      throw new Error('invalid eBay environment, marketplace, or locale binding');
    }
    if (credentials.identity?.environment !== metadata.environment
        || credentials.identity?.marketplace_id !== metadata.marketplace_id
        || credentials.identity?.content_language !== metadata.content_language) {
      throw new Error('eBay encrypted authorization does not match the synced binding');
    }
  }
  if (provider === 'etsy') {
    if (!/^[1-9][0-9]{0,18}$/.test(String(metadata.shop_id || ''))) throw new Error('invalid Etsy shop binding');
    if (String(credentials.identity?.shop_id || '') !== String(metadata.shop_id)) {
      throw new Error('Etsy encrypted authorization does not match the synced shop binding');
    }
  }
  if (provider === 'amazon_seller') {
    if (!['sandbox', 'live'].includes(metadata.environment)
        || !AMAZON_MARKETPLACE_REGIONS[metadata.marketplace_id]
        || !/^[A-Z0-9]{8,32}$/.test(String(metadata.seller_id || ''))
        || typeof credentials.client_id !== 'string' || credentials.client_id.length < 3
        || typeof credentials.client_secret !== 'string' || credentials.client_secret.length < 8
        || !/^Atzr\|[A-Za-z0-9._|~+/=-]{16,4090}$/.test(String(credentials.refresh_token || ''))) {
      throw new Error('invalid Amazon Seller authorization or marketplace binding');
    }
  }
  if (provider === 'mercado_libre') {
    if (!/^[1-9][0-9]{0,18}$/.test(String(metadata.user_id || ''))
        || String(credentials.identity?.user_id || '') !== String(metadata.user_id)
        || typeof credentials.client_id !== 'string' || credentials.client_id.length < 3
        || typeof credentials.client_secret !== 'string' || credentials.client_secret.length < 8
        || typeof credentials.refresh_token !== 'string' || credentials.refresh_token.length < 8) {
      throw new Error('invalid Mercado Libre authorization or seller binding');
    }
  }
  if (provider === 'taobao_top') {
    if (typeof credentials.app_key !== 'string' || credentials.app_key.length < 3
        || typeof credentials.app_secret !== 'string' || credentials.app_secret.length < 8
        || typeof credentials.access_token !== 'string' || credentials.access_token.length < 8
        || !/^[1-9][0-9]{0,24}$/.test(String(credentials.identity?.user_id || ''))
        || (credentials.identity?.open_uid !== undefined && typeof credentials.identity.open_uid !== 'string')
        || typeof credentials.identity?.nick !== 'string' || !credentials.identity.nick) {
      throw new Error('invalid Taobao/Tmall authorization or seller binding');
    }
  }
  if (provider === 'alibaba_1688') {
    if (typeof credentials.app_key !== 'string' || credentials.app_key.length < 3
        || typeof credentials.app_secret !== 'string' || credentials.app_secret.length < 8
        || typeof credentials.access_token !== 'string' || credentials.access_token.length < 8
        || typeof credentials.refresh_token !== 'string' || credentials.refresh_token.length < 8
        || typeof credentials.identity?.member_id !== 'string' || !credentials.identity.member_id) {
      throw new Error('invalid 1688 authorization or seller binding');
    }
  }
  if (provider === 'jd_jos') {
    if (typeof credentials.app_key !== 'string' || credentials.app_key.length < 3
        || typeof credentials.app_secret !== 'string' || credentials.app_secret.length < 8
        || typeof credentials.access_token !== 'string' || credentials.access_token.length < 8
        || typeof credentials.refresh_token !== 'string' || credentials.refresh_token.length < 8
        || typeof credentials.identity?.vender_id !== 'string' || !credentials.identity.vender_id
        || typeof credentials.identity?.shop_id !== 'string' || !credentials.identity.shop_id) {
      throw new Error('invalid JD.com authorization or seller binding');
    }
  }
  if (provider === 'pinduoduo') {
    if (typeof credentials.client_id !== 'string' || credentials.client_id.length < 3
        || typeof credentials.client_secret !== 'string' || credentials.client_secret.length < 8
        || typeof credentials.access_token !== 'string' || credentials.access_token.length < 8
        || typeof credentials.refresh_token !== 'string' || credentials.refresh_token.length < 8
        || typeof credentials.identity?.mall_id !== 'string' || !credentials.identity.mall_id) {
      throw new Error('invalid Pinduoduo authorization or merchant binding');
    }
  }
  if (provider === 'douyin_shop') {
    if (!/^[1-9][0-9]{0,24}$/.test(String(metadata.shop_id || ''))
        || String(credentials.identity?.shop_id || '') !== String(metadata.shop_id)
        || typeof credentials.app_key !== 'string' || credentials.app_key.length < 3
        || typeof credentials.app_secret !== 'string' || credentials.app_secret.length < 8
        || typeof credentials.access_token !== 'string' || credentials.access_token.length < 8
        || typeof credentials.refresh_token !== 'string' || credentials.refresh_token.length < 8) {
      throw new Error('invalid Douyin Shop authorization or shop binding');
    }
  }
  if (provider === 'kuaishou_shop') {
    if (typeof credentials.app_key !== 'string' || credentials.app_key.length < 3
        || typeof credentials.app_secret !== 'string' || credentials.app_secret.length < 8
        || typeof credentials.sign_secret !== 'string' || credentials.sign_secret.length < 8
        || typeof credentials.access_token !== 'string' || credentials.access_token.length < 8
        || typeof credentials.refresh_token !== 'string' || credentials.refresh_token.length < 8
        || typeof credentials.identity?.open_id !== 'string' || !credentials.identity.open_id
        || typeof credentials.identity?.shop_id !== 'string' || !credentials.identity.shop_id) {
      throw new Error('invalid Kuaishou Shop authorization or shop binding');
    }
  }
  if (provider === 'youzan') {
    if (!/^[1-9][0-9]{0,24}$/.test(String(metadata.kdt_id || ''))
        || String(credentials.identity?.kdt_id || '') !== String(metadata.kdt_id)
        || typeof credentials.client_id !== 'string' || credentials.client_id.length < 3
        || typeof credentials.client_secret !== 'string' || credentials.client_secret.length < 8
        || typeof credentials.access_token !== 'string' || credentials.access_token.length < 8) {
      throw new Error('invalid Youzan authorization or shop binding');
    }
  }
  if (provider === 'weimob_wos') {
    if (!/^[1-9][0-9]{0,24}$/.test(String(metadata.shop_id || ''))
        || metadata.shop_type !== 'business_operation_system_id'
        || String(credentials.identity?.business_operation_system_id || '') !== String(metadata.shop_id)
        || typeof credentials.client_id !== 'string' || credentials.client_id.length < 3
        || typeof credentials.client_secret !== 'string' || credentials.client_secret.length < 8
        || typeof credentials.access_token !== 'string' || credentials.access_token.length < 8) {
      throw new Error('invalid Weimob WOS authorization or shop binding');
    }
  }
  if (provider === 'xiaohongshu_ark') {
    const fingerprint = createHash('sha256').update(String(credentials.app_key || ''), 'utf8').digest('hex').slice(0, 16);
    if (typeof credentials.app_key !== 'string' || credentials.app_key.length < 3
        || typeof credentials.app_secret !== 'string' || credentials.app_secret.length < 8
        || credentials.identity?.app_key_fingerprint !== fingerprint) {
      throw new Error('invalid Xiaohongshu Ark authorization or application binding');
    }
  }
  return config;
}

function actionsFor(config) {
  if (storefrontApi.isProvider(config.provider)) return storefrontApi.actionsFor(config.provider);
  if (sellerApi.isSellerProvider(config.provider)) return sellerApi.actionsFor(config.provider);
  if (config.provider === 'shopify') return SHOPIFY_ACTIONS;
  if (config.provider === 'constant_contact') return CONSTANT_CONTACT_ACTIONS;
  if (config.provider === 'commerce_layer') return COMMERCE_LAYER_ACTIONS;
  if (config.provider === 'lightspeed') return LIGHTSPEED_ACTIONS;
  if (config.provider === 'woocommerce') return WOOCOMMERCE_ACTIONS;
  if (config.provider === 'walmart') {
    const market = config.metadata.market;
    if (!['us', 'ca', 'mx', 'cl'].includes(market)) throw new Error('invalid Walmart market binding');
    if (config.metadata.environment === 'sandbox' && market !== 'us') {
      throw new Error('Walmart dynamic sandbox is available only for the US market');
    }
    return market === 'us' || market === 'mx'
      ? Object.freeze({ ...WALMART_COMMON_ACTIONS, ...WALMART_RETURN_ACTIONS })
      : WALMART_COMMON_ACTIONS;
  }
  if (config.provider === 'ebay') return EBAY_ACTIONS;
  if (config.provider === 'etsy') return ETSY_ACTIONS;
  if (config.provider === 'amazon_seller') return AMAZON_ACTIONS;
  if (config.provider === 'mercado_libre') return MERCADO_LIBRE_ACTIONS;
  if (config.provider === 'taobao_top') return TAOBAO_ACTIONS;
  if (config.provider === 'alibaba_1688') return ALIBABA_1688_ACTIONS;
  if (config.provider === 'jd_jos') return JD_ACTIONS;
  if (config.provider === 'pinduoduo') return PINDUODUO_ACTIONS;
  if (config.provider === 'douyin_shop') return DOUYIN_SHOP_ACTIONS;
  if (config.provider === 'kuaishou_shop') return KUAISHOU_SHOP_ACTIONS;
  if (config.provider === 'youzan') return YOUZAN_ACTIONS;
  if (config.provider === 'weimob_wos') return WEIMOB_WOS_ACTIONS;
  if (config.provider === 'xiaohongshu_ark') return XIAOHONGSHU_ARK_ACTIONS;
  if (config.provider === 'square') return SQUARE_ACTIONS;
  if (config.provider === 'instacart') return INSTACART_ACTIONS;
  const actions = RELOADLY_ACTIONS[config.metadata.product];
  if (!actions) throw new Error('invalid Reloadly product binding');
  return actions;
}

function validateParameters(value) {
  if (value == null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('parameters must be an object');
  const serialized = JSON.stringify(value);
  if (serialized.length > MAX_INPUT_CHARS) throw new Error('parameters are too large');
  const seen = new Set();
  function inspect(node) {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    for (const [key, child] of Object.entries(node)) {
      if (/(?:access|refresh)[_-]?token|client[_-]?secret|authorization/i.test(key)
          || (node === value && /^(?:headers?|method|url)$/i.test(key))) {
        throw new Error('raw transport or credential parameters are not allowed');
      }
      inspect(child);
    }
  }
  inspect(value);
  return value;
}

function validateActionParameters(spec, value) {
  const supplied = validateParameters(value);
  const properties = spec.input_schema.properties || {};
  for (const key of Object.keys(supplied)) {
    if (!Object.prototype.hasOwnProperty.call(properties, key)) {
      throw new Error(`unknown action parameter: ${key}`);
    }
  }
  for (const key of spec.input_schema.required || []) {
    if (supplied[key] === undefined || supplied[key] === null || supplied[key] === '') {
      throw new Error(`required action parameter is missing: ${key}`);
    }
  }
  function validateDescriptor(descriptor, item, path) {
    if (descriptor.type === 'string' && (typeof item !== 'string'
        || item.length < Number(descriptor.minLength || 0)
        || item.length > Number(descriptor.maxLength || Number.MAX_SAFE_INTEGER)
        || (descriptor.enum && !descriptor.enum.includes(item)))) {
      throw new Error(`invalid action parameter: ${path}`);
    }
    if (descriptor.type === 'integer' && (!Number.isInteger(item)
        || item < Number(descriptor.minimum ?? Number.MIN_SAFE_INTEGER)
        || item > Number(descriptor.maximum ?? Number.MAX_SAFE_INTEGER))) {
      throw new Error(`invalid action parameter: ${path}`);
    }
    if (descriptor.type === 'number' && (typeof item !== 'number' || !Number.isFinite(item)
        || item < Number(descriptor.minimum ?? -Number.MAX_VALUE)
        || item > Number(descriptor.maximum ?? Number.MAX_VALUE)
        || (descriptor.exclusiveMinimum !== undefined && item <= Number(descriptor.exclusiveMinimum)))) {
      throw new Error(`invalid action parameter: ${path}`);
    }
    if (descriptor.type === 'boolean' && typeof item !== 'boolean') throw new Error(`invalid action parameter: ${path}`);
    if (descriptor.type === 'object') {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`invalid action parameter: ${path}`);
      const childProperties = descriptor.properties || {};
      if (descriptor.additionalProperties === false) {
        for (const childKey of Object.keys(item)) {
          if (!Object.prototype.hasOwnProperty.call(childProperties, childKey)) {
            throw new Error(`invalid action parameter: ${path}.${childKey}`);
          }
        }
      }
      for (const requiredKey of descriptor.required || []) {
        if (item[requiredKey] === undefined || item[requiredKey] === null || item[requiredKey] === '') {
          throw new Error(`invalid action parameter: ${path}.${requiredKey}`);
        }
      }
      for (const [childKey, childDescriptor] of Object.entries(childProperties)) {
        if (item[childKey] !== undefined) validateDescriptor(childDescriptor, item[childKey], `${path}.${childKey}`);
      }
    }
    if (descriptor.type === 'array') {
      if (!Array.isArray(item)
          || item.length < Number(descriptor.minItems || 0)
          || item.length > Number(descriptor.maxItems || Number.MAX_SAFE_INTEGER)) {
        throw new Error(`invalid action parameter: ${path}`);
      }
      item.forEach((child, index) => validateDescriptor(descriptor.items || {}, child, `${path}[${index}]`));
    }
  }
  for (const [key, descriptor] of Object.entries(properties)) {
    if (supplied[key] !== undefined) validateDescriptor(descriptor, supplied[key], key);
  }
  return supplied;
}

function safeId(value, name = 'id') {
  const id = String(value || '');
  if (!/^[A-Za-z0-9_:.\/-]{1,200}$/.test(id) || id.includes('..')) throw new Error(`invalid ${name}`);
  return encodeURIComponent(id);
}

function safeNumericId(value, name = 'id') {
  const id = String(value || '');
  if (!/^[1-9][0-9]{0,18}$/.test(id)) throw new Error(`invalid ${name}`);
  return id;
}

function queryString(value) {
  if (value == null) return '';
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('query must be an object');
  const params = new URLSearchParams();
  for (const [key, raw] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key) || /token|secret|auth|url|method|header/i.test(key)) throw new Error(`query key is not allowed: ${key}`);
    const values = Array.isArray(raw) ? raw : [raw];
    if (values.length > 25) throw new Error(`too many query values: ${key}`);
    for (const item of values) {
      if (!['string', 'number', 'boolean'].includes(typeof item)) throw new Error(`invalid query value: ${key}`);
      params.append(key, String(item));
    }
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

function redact(value) {
  return String(value || '')
    .replace(/("(?:access|refresh|id)[_-]?token"|"client[_-]?secret"|"authorization"|"password")\s*:\s*"[^"]*"/gi, '$1:"[redacted]"')
    .replace(/([?&#](?:code|access_token|refresh_token|client_secret)=)[^&\s"'<>]+/gi, '$1[redacted]')
    .slice(0, MAX_OUTPUT_CHARS);
}

function commerceError(code, message) {
  return Object.assign(new Error(message), { code });
}

async function fetchJson(url, init = {}, providerName = 'provider') {
  const deadline = AbortSignal.timeout(45_000);
  let response;
  try {
    response = await requestFetch(url, { ...init, redirect: 'manual', signal: deadline });
  } catch (error) {
    throw commerceError(requestFailureCode(error, deadline), `${providerName} request failed`);
  }
  if (response.status >= 300 && response.status < 400) throw commerceError('E_TOOL_CALL_UPSTREAM', `${providerName} redirect refused`);
  let text;
  try { text = await response.text(); }
  catch (error) { throw commerceError(requestFailureCode(error, deadline), `${providerName} response could not be read (HTTP ${response.status})`); }
  // HTTP status is authoritative even if an error body is HTML or oversized.
  if (!response.ok) throw commerceError(httpFailureCode(response.status), `${providerName} request failed (HTTP ${response.status})`);
  if (text.length > MAX_OUTPUT_CHARS) throw commerceError('E_TOOL_CALL_UPSTREAM', `${providerName} response is too large`);
  let body;
  try { body = text ? JSON.parse(text) : { ok: true }; }
  catch { throw commerceError('E_TOOL_CALL_UPSTREAM', `${providerName} returned invalid JSON`); }
  return body;
}

async function fetchStatusOnlyJson(url, init, providerName) {
  return fetchJson(url, init, providerName);
}

const tokenCache = new Map();

async function shopifyToken(config) {
  const cached = tokenCache.get('shopify');
  if (cached && cached.expires_at > Date.now() + 300_000) return cached.access_token;
  const shop = config.metadata.shop_domain;
  if (!/^[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com$/.test(shop || '')) throw new Error('invalid Shopify shop binding');
  const token = await fetchJson(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'client_credentials', client_id: config.credentials.client_id,
      client_secret: config.credentials.client_secret,
    }).toString(),
  });
  const granted = new Set(String(token.scope || '').split(/[ ,]+/).filter(Boolean));
  const required = shopifySetupRequirements.required_scopes;
  // Shopify compresses redundant read grants: write_X includes read_X, not
  // vice versa (Shopify SDK AuthScopes). Keep the requested capabilities intact.
  const missing = required.filter((scope) => !granted.has(scope)
    && !(scope.startsWith('read_') && granted.has(`write_${scope.slice(5)}`)));
  const fulfillmentScopes = shopifySetupRequirements.fulfillment_scopes_any_of;
  if (!fulfillmentScopes.some((scope) => granted.has(scope))) {
    missing.push(`one of: ${fulfillmentScopes.join(' / ')}`);
  }
  if (!token.access_token || missing.length) throw new Error(`Shopify app is missing required Admin API scopes: ${missing.join(', ')}`);
  const record = { access_token: token.access_token, expires_at: Date.now() + Math.max(60, Number(token.expires_in || 86400)) * 1000 };
  tokenCache.set('shopify', record);
  return record.access_token;
}

const constantContactToken = credentialOperation(async function constantContactToken(config) {
  if (Number(config.credentials.expires_at || 0) > Date.now() + 300_000) return config.credentials.access_token;
  const token = await fetchJson('https://authz.constantcontact.com/oauth2/default/v1/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      client_id: config.credentials.client_id,
      refresh_token: config.credentials.refresh_token,
      grant_type: 'refresh_token',
    }).toString(),
  });
  if (!token.access_token || !token.refresh_token) throw new Error('Constant Contact refresh returned incomplete credentials');
  const granted = new Set(String(token.scope || config.credentials.scope || '').split(/[ ,]+/).filter(Boolean));
  const missing = ['account_read', 'contact_data', 'campaign_data', 'offline_access']
    .filter((scope) => !granted.has(scope));
  if (missing.length) throw new Error(`Constant Contact authorization is missing required scopes: ${missing.join(', ')}`);
  config.credentials = {
    ...config.credentials,
    access_token: token.access_token, refresh_token: token.refresh_token,
    token_type: token.token_type || 'Bearer', scope: token.scope || config.credentials.scope,
    expires_at: Date.now() + Math.max(60, Number(token.expires_in || 86400)) * 1000,
  };
  try { writeCredentialFile(config.credentialFile, config.credentialKey, config.credentials); }
  catch { throw new Error('Constant Contact refreshed credentials could not be stored; reconnect this connector'); }
  return config.credentials.access_token;
});

function reloadlyBase(config) {
  const product = config.metadata.product;
  const environment = config.metadata.environment;
  const roots = { airtime: 'topups', giftcards: 'giftcards', utilities: 'utilities' };
  if (!roots[product] || !['sandbox', 'live'].includes(environment)) throw new Error('invalid Reloadly account binding');
  return `https://${roots[product]}${environment === 'sandbox' ? '-sandbox' : ''}.reloadly.com`;
}

async function reloadlyToken(config) {
  const cached = tokenCache.get('reloadly');
  if (cached && cached.expires_at > Date.now() + 300_000) return cached.access_token;
  const audience = reloadlyBase(config);
  const token = await fetchJson('https://auth.reloadly.com/oauth/token', {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_id: config.credentials.client_id, client_secret: config.credentials.client_secret,
      grant_type: 'client_credentials', audience,
    }),
  });
  if (!token.access_token) throw new Error('Reloadly token response is incomplete');
  const record = { access_token: token.access_token, expires_at: Date.now() + Math.max(60, Number(token.expires_in || 86400)) * 1000 };
  tokenCache.set('reloadly', record);
  return record.access_token;
}

async function shopifyGraphql(config, query, variables = {}) {
  const token = await shopifyToken(config);
  const body = await fetchJson(`https://${config.metadata.shop_domain}/admin/api/2026-07/graphql.json`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'x-shopify-access-token': token },
    body: JSON.stringify({ query, variables }),
  });
  if (body?.errors?.length) {
    // Shopify returns these protocol errors with HTTP 200. Never classify the
    // arbitrary message or emit its extensions/request identifiers.
    const codes = body.errors.map(error => error?.extensions?.code);
    const code = codes.includes('THROTTLED') ? 'E_TOOL_CALL_RATE_LIMIT'
      : codes.includes('ACCESS_DENIED') ? 'E_TOOL_CALL_AUTH' : 'E_TOOL_CALL_UPSTREAM';
    throw commerceError(code, 'Shopify GraphQL request failed');
  }
  if (!body?.data || typeof body.data !== 'object' || Array.isArray(body.data)) {
    throw commerceError('E_TOOL_CALL_UPSTREAM', 'Shopify returned an invalid response');
  }
  const payload = body.data && Object.values(body.data)[0];
  const userErrors = payload && Object.entries(payload)
    .filter(([key, value]) => /userErrors$/i.test(key) && Array.isArray(value))
    .flatMap(([, value]) => value);
  if (userErrors?.length) throw commerceError('E_BAD_INPUT', 'Shopify rejected the operation');
  return body.data;
}

const SHOP_FIELDS = 'id name myshopifyDomain email currencyCode timezoneAbbreviation';
const PRODUCT_FIELDS = 'id title handle status vendor productType totalInventory createdAt updatedAt';
const ORDER_FIELDS = 'id name displayFinancialStatus displayFulfillmentStatus email createdAt updatedAt totalPriceSet { shopMoney { amount currencyCode } }';
const CUSTOMER_FIELDS = 'id displayName email phone state createdAt updatedAt';
const DRAFT_FIELDS = 'id name status email createdAt updatedAt totalPriceSet { shopMoney { amount currencyCode } }';
const COLLECTION_FIELDS = 'id title handle descriptionHtml sortOrder updatedAt productsCount { count }';
const INVENTORY_FIELDS = 'id sku tracked requiresShipping countryCodeOfOrigin provinceCodeOfOrigin harmonizedSystemCode unitCost { amount currencyCode } updatedAt';
const DISCOUNT_FIELDS = 'id discount { ... on DiscountCodeBasic { title summary status startsAt endsAt codes(first:10){nodes{id code}} } ... on DiscountAutomaticBasic { title summary status startsAt endsAt } ... on DiscountCodeBxgy { title summary status } ... on DiscountAutomaticBxgy { title summary status } ... on DiscountCodeFreeShipping { title summary status } ... on DiscountAutomaticFreeShipping { title summary status } }';

async function executeShopify(config, name, p) {
  const connection = (resource, fields, extra = '') => `query($first:Int!,$after:String,$query:String){${resource}(first:$first,after:$after,query:$query){nodes{${fields}} pageInfo{hasNextPage endCursor}}${extra}}`;
  const variables = { first: Math.min(100, Math.max(1, Number(p.first || 50))), after: p.after || null, query: p.query || null };
  if (name === 'shop.get') return shopifyGraphql(config, `query{shop{${SHOP_FIELDS}}}`);
  if (name === 'products.list') return shopifyGraphql(config, connection('products', PRODUCT_FIELDS), variables);
  if (name === 'products.get') return shopifyGraphql(config, `query($id:ID!){product(id:$id){${PRODUCT_FIELDS} descriptionHtml options{name values} variants(first:100){nodes{id title sku barcode price inventoryQuantity}}}}`, { id: p.id });
  if (name === 'products.create') return shopifyGraphql(config, `mutation($product:ProductCreateInput!){productCreate(product:$product){product{${PRODUCT_FIELDS}} userErrors{field message}}}`, { product: p.input });
  if (name === 'products.update') return shopifyGraphql(config, `mutation($product:ProductUpdateInput!){productUpdate(product:$product){product{${PRODUCT_FIELDS}} userErrors{field message}}}`, { product: p.input });
  if (name === 'products.delete') return shopifyGraphql(config, 'mutation($input:ProductDeleteInput!){productDelete(input:$input){deletedProductId userErrors{field message}}}', { input: { id: p.id } });
  if (name === 'product_variants.bulk_create') return shopifyGraphql(config, 'mutation($productId:ID!,$variants:[ProductVariantsBulkInput!]!){productVariantsBulkCreate(productId:$productId,variants:$variants){product{id} productVariants{id title sku price} userErrors{field message}}}', { productId: p.product_id, variants: p.variants });
  if (name === 'product_variants.bulk_update') return shopifyGraphql(config, 'mutation($productId:ID!,$variants:[ProductVariantsBulkInput!]!){productVariantsBulkUpdate(productId:$productId,variants:$variants){product{id} productVariants{id title sku price} userErrors{field message}}}', { productId: p.product_id, variants: p.variants });
  if (name === 'product_variants.bulk_delete') return shopifyGraphql(config, 'mutation($productId:ID!,$variantsIds:[ID!]!){productVariantsBulkDelete(productId:$productId,variantsIds:$variantsIds){product{id title} userErrors{field message}}}', { productId: p.product_id, variantsIds: p.variant_ids });
  if (name === 'collections.list') return shopifyGraphql(config, connection('collections', COLLECTION_FIELDS), variables);
  if (name === 'collections.get') return shopifyGraphql(config, `query($id:ID!){collection(id:$id){${COLLECTION_FIELDS} products(first:100){nodes{id title handle status}}}}`, { id: p.id });
  if (name === 'collections.create') return shopifyGraphql(config, `mutation($collection:CollectionCreateInput!){collectionCreate(collection:$collection){collection{${COLLECTION_FIELDS}} userErrors{field message}}}`, { collection: p.input });
  if (name === 'collections.update') return shopifyGraphql(config, `mutation($collection:CollectionUpdateInput!){collectionUpdate(collection:$collection){collection{${COLLECTION_FIELDS}} job{id done} userErrors{field message}}}`, { collection: p.input });
  if (name === 'collections.delete') return shopifyGraphql(config, 'mutation($input:CollectionDeleteInput!){collectionDelete(input:$input){deletedCollectionId userErrors{field message}}}', { input: { id: p.id } });
  if (name === 'orders.list') return shopifyGraphql(config, connection('orders', ORDER_FIELDS), variables);
  if (name === 'orders.get') return shopifyGraphql(config, `query($id:ID!){order(id:$id){${ORDER_FIELDS} lineItems(first:100){nodes{id name sku quantity refundableQuantity}}}}`, { id: p.id });
  if (name === 'orders.create') return shopifyGraphql(config, `mutation($order:OrderCreateOrderInput!,$options:OrderCreateOptionsInput){orderCreate(order:$order,options:$options){order{${ORDER_FIELDS}} userErrors{field message}}}`, { order: p.order, options: p.options || null });
  if (name === 'orders.update') return shopifyGraphql(config, `mutation($input:OrderInput!){orderUpdate(input:$input){order{${ORDER_FIELDS}} userErrors{field message}}}`, { input: p.input });
  if (name === 'orders.close') return shopifyGraphql(config, `mutation($input:OrderCloseInput!){orderClose(input:$input){order{${ORDER_FIELDS}} userErrors{field message}}}`, { input: p.input });
  if (name === 'orders.cancel') return shopifyGraphql(config, 'mutation($orderId:ID!,$notifyCustomer:Boolean,$refundMethod:OrderCancelRefundMethodInput!,$restock:Boolean!,$reason:OrderCancelReason!,$staffNote:String){orderCancel(orderId:$orderId,notifyCustomer:$notifyCustomer,refundMethod:$refundMethod,restock:$restock,reason:$reason,staffNote:$staffNote){job{id done} orderCancelUserErrors{field message code} userErrors{field message}}}', {
    orderId: p.order_id, notifyCustomer: p.notify_customer ?? false, refundMethod: p.refund_method,
    restock: p.restock, reason: p.reason, staffNote: p.staff_note || null,
  });
  if (name === 'customers.list') return shopifyGraphql(config, connection('customers', CUSTOMER_FIELDS), variables);
  if (name === 'customers.get') return shopifyGraphql(config, `query($id:ID!){customer(id:$id){${CUSTOMER_FIELDS} defaultAddress{id address1 city province country zip}}}`, { id: p.id });
  if (name === 'customers.create') return shopifyGraphql(config, `mutation($input:CustomerInput!){customerCreate(input:$input){customer{${CUSTOMER_FIELDS}} userErrors{field message}}}`, { input: p.input });
  if (name === 'customers.update') return shopifyGraphql(config, `mutation($input:CustomerInput!){customerUpdate(input:$input){customer{${CUSTOMER_FIELDS}} userErrors{field message}}}`, { input: p.input });
  if (name === 'customers.delete') return shopifyGraphql(config, 'mutation($input:CustomerDeleteInput!){customerDelete(input:$input){deletedCustomerId userErrors{field message}}}', { input: { id: p.id } });
  if (name === 'locations.list') return shopifyGraphql(config, 'query($first:Int!){locations(first:$first){nodes{id name isActive fulfillsOnlineOrders address{address1 city province country zip}}}}', { first: Math.min(100, Math.max(1, Number(p.first || 50))) });
  if (name === 'inventory_items.list') return shopifyGraphql(config, connection('inventoryItems', INVENTORY_FIELDS), variables);
  if (name === 'inventory_items.get') return shopifyGraphql(config, `query($id:ID!){inventoryItem(id:$id){${INVENTORY_FIELDS} variant{id title product{id title}} inventoryLevels(first:100){nodes{id location{id name} quantities(names:["available","committed","incoming","on_hand","reserved"]){name quantity}}}}}`, { id: p.id });
  if (name === 'inventory_items.update') return shopifyGraphql(config, `mutation($id:ID!,$input:InventoryItemInput!){inventoryItemUpdate(id:$id,input:$input){inventoryItem{${INVENTORY_FIELDS}} userErrors{field message}}}`, { id: p.id, input: p.input });
  // Required since 2026-04. One key per dispatch; this adapter never retries writes.
  if (name === 'inventory.set_quantities') return shopifyGraphql(config, 'mutation($input:InventorySetQuantitiesInput!,$idempotencyKey:String!){inventorySetQuantities(input:$input) @idempotent(key:$idempotencyKey){inventoryAdjustmentGroup{createdAt reason changes{name delta}} userErrors{field message}}}', { input: p.input, idempotencyKey: randomUUID() });
  if (name === 'draft_orders.list') return shopifyGraphql(config, connection('draftOrders', DRAFT_FIELDS), variables);
  if (name === 'draft_orders.get') return shopifyGraphql(config, `query($id:ID!){draftOrder(id:$id){${DRAFT_FIELDS} lineItems(first:100){nodes{id name sku quantity originalUnitPriceSet{shopMoney{amount currencyCode}}}}}}`, { id: p.id });
  if (name === 'draft_orders.create') return shopifyGraphql(config, `mutation($input:DraftOrderInput!){draftOrderCreate(input:$input){draftOrder{${DRAFT_FIELDS}} userErrors{field message}}}`, { input: p.input });
  if (name === 'draft_orders.update') return shopifyGraphql(config, `mutation($id:ID!,$input:DraftOrderInput!){draftOrderUpdate(id:$id,input:$input){draftOrder{${DRAFT_FIELDS}} userErrors{field message}}}`, { id: p.id, input: p.input });
  if (name === 'draft_orders.complete') return shopifyGraphql(config, `mutation($id:ID!,$paymentPending:Boolean){draftOrderComplete(id:$id,paymentPending:$paymentPending){draftOrder{${DRAFT_FIELDS}} userErrors{field message}}}`, { id: p.id, paymentPending: p.payment_pending ?? false });
  if (name === 'draft_orders.delete') return shopifyGraphql(config, 'mutation($input:DraftOrderDeleteInput!){draftOrderDelete(input:$input){deletedId userErrors{field message}}}', { input: { id: p.id } });
  if (name === 'fulfillments.create') return shopifyGraphql(config, 'mutation($fulfillment:FulfillmentInput!,$message:String){fulfillmentCreate(fulfillment:$fulfillment,message:$message){fulfillment{id status createdAt} userErrors{field message}}}', { fulfillment: p.fulfillment, message: p.message || null });
  if (name === 'refunds.create') return shopifyGraphql(config, 'mutation($input:RefundInput!){refundCreate(input:$input){refund{id createdAt totalRefundedSet{shopMoney{amount currencyCode}}} userErrors{field message}}}', { input: p.input });
  if (name === 'returns.get') return shopifyGraphql(config, 'query($id:ID!){return(id:$id){id name status createdAt order{id name} returnLineItems(first:100){nodes{id quantity returnReason returnReasonNote}}}}', { id: p.id });
  if (name === 'returns.create') return shopifyGraphql(config, 'mutation($returnInput:ReturnInput!){returnCreate(returnInput:$returnInput){return{id name status createdAt} userErrors{field message}}}', { returnInput: p.input });
  if (name === 'returns.cancel') return shopifyGraphql(config, 'mutation($id:ID!){returnCancel(id:$id){return{id name status} userErrors{field message}}}', { id: p.id });
  if (name === 'discounts.list') return shopifyGraphql(config, `query($first:Int!,$after:String,$query:String){discountNodes(first:$first,after:$after,query:$query){nodes{${DISCOUNT_FIELDS}} pageInfo{hasNextPage endCursor}}}`, variables);
  if (name === 'discounts.get') return shopifyGraphql(config, `query($id:ID!){discountNode(id:$id){${DISCOUNT_FIELDS}}}`, { id: p.id });
  if (name === 'discounts.code_basic_create') return shopifyGraphql(config, 'mutation($input:DiscountCodeBasicInput!){discountCodeBasicCreate(basicCodeDiscount:$input){codeDiscountNode{id} userErrors{field message code}}}', { input: p.input });
  if (name === 'discounts.code_basic_update') return shopifyGraphql(config, 'mutation($id:ID!,$input:DiscountCodeBasicInput!){discountCodeBasicUpdate(id:$id,basicCodeDiscount:$input){codeDiscountNode{id} userErrors{field message code}}}', { id: p.id, input: p.input });
  if (name === 'discounts.code_delete') return shopifyGraphql(config, 'mutation($id:ID!){discountCodeDelete(id:$id){deletedCodeDiscountId userErrors{field message code}}}', { id: p.id });
  if (name === 'discounts.automatic_basic_create') return shopifyGraphql(config, 'mutation($input:DiscountAutomaticBasicInput!){discountAutomaticBasicCreate(automaticBasicDiscount:$input){automaticDiscountNode{id} userErrors{field message code}}}', { input: p.input });
  if (name === 'discounts.automatic_basic_update') return shopifyGraphql(config, 'mutation($id:ID!,$input:DiscountAutomaticBasicInput!){discountAutomaticBasicUpdate(id:$id,automaticBasicDiscount:$input){automaticDiscountNode{id} userErrors{field message code}}}', { id: p.id, input: p.input });
  if (name === 'discounts.automatic_delete') return shopifyGraphql(config, 'mutation($id:ID!){discountAutomaticDelete(id:$id){deletedAutomaticDiscountId userErrors{field message code}}}', { id: p.id });
  if (name === 'publications.list') return shopifyGraphql(config, 'query($first:Int!,$after:String){publications(first:$first,after:$after){nodes{id name supportsFuturePublishing catalog{title}} pageInfo{hasNextPage endCursor}}}', variables);
  if (name === 'publications.publish') return shopifyGraphql(config, 'mutation($id:ID!,$input:[PublicationInput!]!){publishablePublish(id:$id,input:$input){publishable{publishedOnCurrentPublication} userErrors{field message}}}', { id: p.id, input: p.publications });
  if (name === 'publications.unpublish') return shopifyGraphql(config, 'mutation($id:ID!,$input:[PublicationInput!]!){publishableUnpublish(id:$id,input:$input){publishable{publishedOnCurrentPublication} userErrors{field message}}}', { id: p.id, input: p.publications });
  throw new Error('unsupported Shopify action');
}

async function restRequest(base, token, method, path, p, authHeader = 'authorization') {
  const headers = { accept: 'application/json', [authHeader]: authHeader === 'authorization' ? `Bearer ${token}` : token };
  const init = { method, headers };
  if (p.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(p.body);
  }
  return fetchJson(`${base}${path}${queryString(p.query)}`, init);
}

function commerceLayerBase(config) {
  const slug = String(config.metadata.organization_slug || '');
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)) {
    throw new Error('invalid Commerce Layer organization binding');
  }
  return `https://${slug}.commercelayer.io`;
}

async function commerceLayerToken(config) {
  const cacheKey = `commerce_layer:${config.metadata.organization_slug}:${config.credentials.client_id}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expires_at > Date.now() + 300_000) return cached.access_token;
  const token = await fetchJson('https://auth.commercelayer.io/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: config.credentials.client_id,
      client_secret: config.credentials.client_secret,
    }),
  });
  if (!token.access_token) throw new Error('Commerce Layer token response is incomplete');
  const record = {
    access_token: token.access_token,
    expires_at: Date.now() + Math.max(60, Number(token.expires_in || 7200)) * 1000,
  };
  tokenCache.set(cacheKey, record);
  return record.access_token;
}

function commerceLayerQuery(value) {
  if (value == null) return '';
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('query must be an object');
  const params = new URLSearchParams();
  for (const [key, raw] of Object.entries(value)) {
    const allowed = /^(?:sort|page\[(?:number|size)\]|fields\[[a-z_]+\]|filter\[[a-z0-9_]+\])$/i.test(key);
    if (!allowed || /token|secret|auth|url|method|header/i.test(key)) {
      throw new Error(`Commerce Layer query key is not allowed: ${key}`);
    }
    const values = Array.isArray(raw) ? raw : [raw];
    if (values.length > 25) throw new Error(`too many query values: ${key}`);
    for (const item of values) {
      if (!['string', 'number', 'boolean'].includes(typeof item)) throw new Error(`invalid query value: ${key}`);
      params.append(key, String(item));
    }
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

async function commerceLayerRequest(config, method, path, { query, attributes } = {}) {
  if (!/^\/api\/(?:application|customers(?:\/[A-Za-z0-9_-]+)?|orders(?:\/[A-Za-z0-9_-]+)?|skus(?:\/[A-Za-z0-9_-]+)?|stock_items(?:\/[A-Za-z0-9_-]+)?)$/.test(path)) {
    throw new Error('unreviewed Commerce Layer API destination');
  }
  const token = await commerceLayerToken(config);
  const init = {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.api+json',
    },
  };
  if (method === 'POST' || method === 'PATCH') {
    init.headers['content-type'] = 'application/vnd.api+json';
    const id = path.split('/').pop();
    init.body = JSON.stringify({ data: {
      type: 'customers',
      ...(method === 'PATCH' ? { id } : {}),
      attributes,
    } });
  }
  return fetchJson(`${commerceLayerBase(config)}${path}${commerceLayerQuery(query)}`, init);
}

async function executeCommerceLayer(config, name, p) {
  if (name === 'application.get') return commerceLayerRequest(config, 'GET', '/api/application');
  const matches = /^(customers|orders|skus|stock_items)\.(list|get|create|update|delete)$/.exec(name);
  if (!matches) throw new Error('unsupported Commerce Layer action');
  const [, resource, operation] = matches;
  if (resource !== 'customers' && !['list', 'get'].includes(operation)) {
    throw new Error('unsupported Commerce Layer mutation');
  }
  const path = `/api/${resource}${p.id ? `/${safeId(p.id)}` : ''}`;
  if (operation === 'list' || operation === 'get') {
    return commerceLayerRequest(config, 'GET', path, { query: p.query });
  }
  if (operation === 'create') {
    return commerceLayerRequest(config, 'POST', path, { attributes: p.attributes });
  }
  if (operation === 'update') {
    if (!Object.keys(p.attributes).length) throw new Error('Commerce Layer customer update has no attributes');
    return commerceLayerRequest(config, 'PATCH', path, { attributes: p.attributes });
  }
  return commerceLayerRequest(config, 'DELETE', path);
}

async function executeConstantContact(config, name, p) {
  const token = await constantContactToken(config);
  const map = {
    'account.get': () => ['GET', '/account/summary'], 'contacts.list': () => ['GET', '/contacts'],
    'contacts.get': () => ['GET', `/contacts/${safeId(p.id)}`],
    'contacts.create_or_update': () => ['POST', '/contacts/sign_up_form'],
    'contacts.update': () => ['PUT', `/contacts/${safeId(p.id)}`],
    'contacts.delete': () => ['DELETE', `/contacts/${safeId(p.id)}`],
    'lists.list': () => ['GET', '/contact_lists'], 'lists.get': () => ['GET', `/contact_lists/${safeId(p.id)}`],
    'lists.create': () => ['POST', '/contact_lists'], 'lists.update': () => ['PUT', `/contact_lists/${safeId(p.id)}`],
    'lists.delete': () => ['DELETE', `/contact_lists/${safeId(p.id)}`],
    'campaigns.list': () => ['GET', '/emails'], 'campaigns.get': () => ['GET', `/emails/${safeId(p.id)}`],
    'campaigns.create': () => ['POST', '/emails'],
    'campaigns.update_activity': () => ['PUT', `/emails/activities/${safeId(p.id)}`],
    'campaigns.unschedule': () => ['DELETE', `/emails/activities/${safeId(p.id)}/schedules`],
    'campaigns.delete': () => ['DELETE', `/emails/${safeId(p.id)}`],
  };
  if (name === 'campaigns.schedule') return restRequest('https://api.cc.email/v3', token, 'POST', `/emails/activities/${safeId(p.id)}/schedules`, { body: { scheduled_date: p.scheduled_date } });
  const route = map[name]?.();
  if (!route) throw new Error('unsupported Constant Contact action');
  return restRequest('https://api.cc.email/v3', token, route[0], route[1], p);
}

async function executeLightspeed(config, name, p) {
  const domain = config.metadata.store_domain;
  if (!/^[a-z0-9][a-z0-9-]{0,62}\.retail\.lightspeed\.app$/.test(domain || '')) throw new Error('invalid Lightspeed store binding');
  const map = {
    'store.get': () => ['GET', '/api/2.0/retailer'], 'search': () => ['GET', '/api/2.0/search'],
    'products.list': () => ['GET', '/api/2.0/products'], 'products.get': () => ['GET', `/api/2.0/products/${safeId(p.id)}`],
    'products.create': () => ['POST', '/api/2.0/products'], 'products.update': () => ['PUT', `/api/2.1/products/${safeId(p.id)}`],
    'products.delete': () => ['DELETE', `/api/2.0/products/${safeId(p.id)}`],
    'customers.list': () => ['GET', '/api/2.0/customers'], 'customers.get': () => ['GET', `/api/2.0/customers/${safeId(p.id)}`],
    'customers.create': () => ['POST', '/api/2.0/customers'], 'customers.update': () => ['PUT', `/api/2.0/customers/${safeId(p.id)}`],
    'customers.delete': () => ['DELETE', `/api/2.0/customers/${safeId(p.id)}`],
    'outlets.list': () => ['GET', '/api/2.0/outlets'], 'sales.list': () => ['GET', '/api/2.0/sales'],
    'sales.get': () => ['GET', `/api/2.0/sales/${safeId(p.id)}`], 'sales.create': () => ['POST', '/api/2.0/sales'],
    'sales.update': () => ['PUT', `/api/2.0/sales/${safeId(p.id)}`], 'sales.delete': () => ['DELETE', `/api/2.0/sales/${safeId(p.id)}`],
  };
  const route = map[name]?.();
  if (!route) throw new Error('unsupported Lightspeed action');
  return restRequest(`https://${domain}`, config.credentials.access_token, route[0], route[1], p);
}

function woocommerceBase(config) {
  let store;
  try { store = new URL(String(config.metadata.store_url || '')); } catch {
    throw new Error('invalid WooCommerce store binding');
  }
  const host = store.hostname.toLowerCase();
  const reserved = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
    || host.endsWith('.internal') || host.endsWith('.test') || host.endsWith('.invalid')
    || host.endsWith('.example');
  if (store.protocol !== 'https:' || store.username || store.password || store.search || store.hash
      || isIP(host) !== 0 || reserved || !host.includes('.')
      || /\/(?:wp-json|wc-api)(?:\/|$)/i.test(store.pathname)) {
    throw new Error('invalid WooCommerce store binding');
  }
  if (!/^ck_[A-Fa-f0-9]{40}$/.test(String(config.credentials.consumer_key || ''))
      || !/^cs_[A-Fa-f0-9]{40}$/.test(String(config.credentials.consumer_secret || ''))) {
    throw new Error('WooCommerce credential verification failed');
  }
  return `${store.origin}${store.pathname.replace(/\/+$/, '')}/wp-json/wc/v3`;
}

async function woocommerceRequest(config, method, path, p = {}) {
  const authorization = Buffer.from(
    `${config.credentials.consumer_key}:${config.credentials.consumer_secret}`,
    'utf8',
  ).toString('base64');
  const headers = { accept: 'application/json', authorization: `Basic ${authorization}` };
  const init = { method, headers };
  if (p.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(p.body);
  }
  try {
    return await fetchJson(`${woocommerceBase(config)}${path}${queryString(p.query)}`, init);
  } catch (error) {
    const status = String(error?.message || '').match(/HTTP (\d{3})/)?.[1];
    throw commerceError(error?.code, `WooCommerce request failed${status ? ` (HTTP ${status})` : ''}`);
  }
}

async function executeWooCommerce(config, name, p) {
  const simple = {
    'store.status': ['GET', '/system_status'],
    'data.countries': ['GET', '/data/countries'],
    'data.currencies': ['GET', '/data/currencies'],
    'data.continents': ['GET', '/data/continents'],
    'reports.sales': ['GET', '/reports/sales'],
    'reports.orders': ['GET', '/reports/orders/totals'],
    'reports.products': ['GET', '/reports/products/totals'],
    'reports.customers': ['GET', '/reports/customers/totals'],
    'reports.coupons': ['GET', '/reports/coupons/totals'],
    'reports.reviews': ['GET', '/reports/reviews/totals'],
  };
  if (simple[name]) return woocommerceRequest(config, simple[name][0], simple[name][1], p);

  const resources = {
    products: '/products', categories: '/products/categories', tags: '/products/tags',
    attributes: '/products/attributes', orders: '/orders', customers: '/customers',
    coupons: '/coupons', reviews: '/products/reviews',
  };
  const match = name.match(/^(products|categories|tags|attributes|orders|customers|coupons|reviews)\.(list|get|create|update|delete)$/);
  if (match) {
    const [, resource, operation] = match;
    const path = `${resources[resource]}${['get', 'update', 'delete'].includes(operation) ? `/${safeId(p.id)}` : ''}`;
    const method = operation === 'list' || operation === 'get' ? 'GET'
      : operation === 'create' ? 'POST' : operation === 'update' ? 'PUT' : 'DELETE';
    return woocommerceRequest(config, method, path, p);
  }

  const nested = name.match(/^(variations|attribute_terms|order_notes|refunds)\.(list|get|create|update|delete)$/);
  if (nested) {
    const [, resource, operation] = nested;
    const parentKey = resource === 'variations' ? 'product_id'
      : resource === 'attribute_terms' ? 'attribute_id' : 'order_id';
    const prefix = resource === 'variations' ? `/products/${safeId(p[parentKey], parentKey)}/variations`
      : resource === 'attribute_terms' ? `/products/attributes/${safeId(p[parentKey], parentKey)}/terms`
        : resource === 'order_notes' ? `/orders/${safeId(p[parentKey], parentKey)}/notes`
          : `/orders/${safeId(p[parentKey], parentKey)}/refunds`;
    const path = `${prefix}${['get', 'update', 'delete'].includes(operation) ? `/${safeId(p.id)}` : ''}`;
    const method = operation === 'list' || operation === 'get' ? 'GET'
      : operation === 'create' ? 'POST' : operation === 'update' ? 'PUT' : 'DELETE';
    return woocommerceRequest(config, method, path, p);
  }
  throw new Error('unsupported WooCommerce action');
}

async function woocommerceIdentity(config) {
  const status = await woocommerceRequest(config, 'GET', '/system_status');
  const environment = status?.environment && typeof status.environment === 'object'
    ? status.environment : {};
  const settings = status?.settings && typeof status.settings === 'object'
    ? status.settings : {};
  return Object.fromEntries(Object.entries({
    store_url: config.metadata.store_url,
    site_url: environment.site_url,
    home_url: environment.home_url,
    woocommerce_version: environment.version,
    wordpress_version: environment.wp_version,
    currency: settings.currency,
    timezone: settings.timezone,
  }).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value)));
}

function walmartBase(config) {
  const environment = config.metadata.environment;
  const market = config.metadata.market;
  if (!['sandbox', 'live'].includes(environment) || !['us', 'ca', 'mx', 'cl'].includes(market)
      || (environment === 'sandbox' && market !== 'us')) {
    throw new Error('invalid Walmart environment or market binding');
  }
  return environment === 'sandbox'
    ? 'https://sandbox.walmartapis.com' : 'https://marketplace.walmartapis.com';
}

function walmartCredentialHeaders(config) {
  const clientId = String(config.credentials.client_id || '');
  const clientSecret = String(config.credentials.client_secret || '');
  if (clientId.length < 3 || clientId.length > 512 || clientSecret.length < 8 || clientSecret.length > 4096
      || /[\r\n]/.test(clientId + clientSecret)) {
    throw new Error('Walmart credential verification failed');
  }
  return {
    accept: 'application/json',
    authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')}`,
    'WM_MARKET': config.metadata.market,
    'WM_QOS.CORRELATION_ID': randomUUID(),
    'WM_SVC.NAME': 'Walmart Marketplace',
    ...(config.metadata.environment === 'sandbox' ? { WM_SANDBOX: 'v2' } : {}),
  };
}

async function walmartToken(config) {
  const cacheKey = `walmart:${config.metadata.environment}:${config.metadata.market}:${config.credentials.client_id}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expires_at > Date.now() + 60_000) return cached.access_token;
  const headers = { ...walmartCredentialHeaders(config), 'content-type': 'application/x-www-form-urlencoded' };
  let token;
  try {
    token = await fetchJson(`${walmartBase(config)}/v3/token`, {
      method: 'POST', headers, body: 'grant_type=client_credentials',
    });
  } catch (error) {
    const status = String(error?.message || '').match(/HTTP (\d{3})/)?.[1];
    throw commerceError(error?.code, `Walmart credential verification failed${status ? ` (HTTP ${status})` : ''}`);
  }
  if (typeof token.access_token !== 'string' || !token.access_token) {
    throw new Error('Walmart credential verification failed');
  }
  const record = {
    access_token: token.access_token,
    expires_at: Date.now() + Math.max(60, Number(token.expires_in || 900)) * 1000,
  };
  tokenCache.set(cacheKey, record);
  return record.access_token;
}

async function walmartTokenDetails(config) {
  let details;
  try {
    details = await fetchJson(`${walmartBase(config)}/v3/token/detail`, {
      method: 'GET', headers: walmartCredentialHeaders(config),
    });
  } catch (error) {
    const status = String(error?.message || '').match(/HTTP (\d{3})/)?.[1];
    throw commerceError(error?.code, `Walmart credential verification failed${status ? ` (HTTP ${status})` : ''}`);
  }
  const scopes = details?.scopes;
  const required = {
    item: ['view_only', 'full_access'],
    price: ['full_access'],
    orders: ['full_access'],
    inventory: ['full_access'],
  };
  if (config.metadata.market === 'us' || config.metadata.market === 'mx') {
    required.returns = ['view_only', 'full_access'];
  }
  const missing = Object.entries(required)
    .filter(([scope, accepted]) => !accepted.includes(scopes?.[scope]))
    .map(([scope, accepted]) => `${scope} (${accepted.join(' or ')})`);
  if (details?.is_valid !== true || missing.length) {
    throw new Error(`Walmart credentials are missing required permissions: ${missing.join(', ') || 'credential invalid'}`);
  }
  return {
    environment: config.metadata.environment,
    market: config.metadata.market,
    expire_at: details.expire_at,
    is_valid: true,
    scopes: Object.fromEntries(Object.keys(required).map((scope) => [scope, scopes[scope]])),
  };
}

async function walmartRequest(config, method, path, p = {}) {
  const accessToken = await walmartToken(config);
  const headers = {
    ...walmartCredentialHeaders(config),
    authorization: undefined,
    'WM_SEC.ACCESS_TOKEN': accessToken,
  };
  delete headers.authorization;
  const init = { method, headers };
  if (p.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(p.body);
  }
  try {
    return await fetchJson(`${walmartBase(config)}${path}${queryString(p.query)}`, init);
  } catch (error) {
    const status = String(error?.message || '').match(/HTTP (\d{3})/)?.[1];
    throw commerceError(error?.code, `Walmart Marketplace request failed${status ? ` (HTTP ${status})` : ''}`);
  }
}

function validateWalmartMutation(name, sku, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error(`Walmart ${name} body is required`);
  }
  if (body.sku !== undefined && body.sku !== sku) throw new Error(`Walmart ${name} SKU does not match the bound route`);
  const quantity = (value, label) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || !Number.isInteger(value.amount) || value.amount < 0 || value.amount > 1_000_000_000
        || value.unit !== 'EACH') {
      throw new Error(`Walmart ${name} requires ${label}.amount and unit EACH`);
    }
  };
  if (name === 'inventory.set') quantity(body.quantity, 'quantity');
  if (name === 'inventory.nodes_set') {
    const nodes = body.inventories?.nodes;
    if (!Array.isArray(nodes) || nodes.length < 1 || nodes.length > 10) {
      throw new Error('Walmart inventory.nodes_set supports 1-10 ship nodes');
    }
    for (const [index, node] of nodes.entries()) {
      if (!node || typeof node !== 'object' || Array.isArray(node)
          || typeof node.shipNode !== 'string' || !node.shipNode.trim() || node.shipNode.length > 200) {
        throw new Error(`Walmart inventory.nodes_set has an invalid ship node at index ${index}`);
      }
      quantity(node.inputQty, `inventories.nodes[${index}].inputQty`);
    }
  }
  if (name === 'price.set') {
    if (!Array.isArray(body.pricing) || body.pricing.length < 1 || body.pricing.length > 10) {
      throw new Error('Walmart price.set supports 1-10 reviewed pricing entries');
    }
    for (const [index, price] of body.pricing.entries()) {
      const money = price?.currentPrice;
      if (!money || typeof money !== 'object' || Array.isArray(money)
          || !Number.isFinite(money.amount) || money.amount <= 0 || money.amount > 1_000_000_000
          || typeof money.currency !== 'string' || !/^[A-Z]{3}$/.test(money.currency)) {
        throw new Error(`Walmart price.set has invalid pricing[${index}].currentPrice`);
      }
    }
  }
  const orderWrapper = {
    'orders.ship': 'orderShipment',
    'orders.cancel': 'orderCancellation',
    'orders.refund': 'orderRefund',
  }[name];
  if (orderWrapper) {
    const lines = body[orderWrapper]?.orderLines?.orderLine;
    if (!Array.isArray(lines) || lines.length < 1 || lines.length > 10) {
      throw new Error(`Walmart ${name} requires 1-10 reviewed order lines`);
    }
  }
  return { ...body, ...(sku && name !== 'inventory.nodes_set' ? { sku } : {}) };
}

async function executeWalmart(config, name, p) {
  if (name === 'account.permissions') return walmartTokenDetails(config);
  const body = [
    'inventory.set', 'inventory.nodes_set', 'price.set',
    'orders.ship', 'orders.cancel', 'orders.refund',
  ].includes(name)
    ? validateWalmartMutation(name, p.sku, p.body) : p.body;
  const map = {
    'items.list': () => ['GET', '/v3/items', { query: p.query }],
    'items.get': () => ['GET', `/v3/items/${safeId(p.id)}`, { query: p.query }],
    'inventory.get': () => ['GET', '/v3/inventory', { query: { sku: p.sku, ...(p.ship_node ? { shipNode: p.ship_node } : {}) } }],
    'inventory.nodes_get': () => ['GET', `/v3/inventories/${safeId(p.sku, 'sku')}`, { query: p.ship_node ? { shipNode: p.ship_node } : undefined }],
    'inventory.set': () => ['PUT', '/v3/inventory', { query: { sku: p.sku, ...(p.ship_node ? { shipNode: p.ship_node } : {}) }, body }],
    'inventory.nodes_set': () => ['PUT', `/v3/inventories/${safeId(p.sku, 'sku')}`, { body }],
    'price.set': () => ['PUT', '/v3/price', { body }],
    'orders.list': () => ['GET', '/v3/orders', { query: p.query }],
    'orders.released': () => ['GET', '/v3/orders/released', { query: p.query }],
    'orders.get': () => ['GET', `/v3/orders/${safeId(p.id)}`, {}],
    'orders.acknowledge': () => ['POST', `/v3/orders/${safeId(p.id)}/acknowledge`, {}],
    'orders.ship': () => ['POST', `/v3/orders/${safeId(p.id)}/shipping`, { body }],
    'orders.cancel': () => ['POST', `/v3/orders/${safeId(p.id)}/cancel`, { body }],
    'orders.refund': () => ['POST', `/v3/orders/${safeId(p.id)}/refund`, { body }],
    'returns.list': () => ['GET', '/v3/returns', { query: p.query }],
    'returns.get': () => ['GET', `/v3/returns/${safeId(p.id)}`, {}],
  };
  const route = map[name]?.();
  if (!route) throw new Error('unsupported Walmart Marketplace action');
  return walmartRequest(config, route[0], route[1], route[2]);
}

const EBAY_REQUIRED_SCOPES = Object.freeze([
  'https://api.ebay.com/oauth/api_scope/sell.account',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
]);

function ebayBase(config) {
  if (!['sandbox', 'live'].includes(config.metadata.environment)) throw new Error('invalid eBay environment binding');
  return config.metadata.environment === 'sandbox' ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com';
}

function ebayAppAuthorization(config) {
  const clientId = String(config.credentials.client_id || '');
  const clientSecret = String(config.credentials.client_secret || '');
  if (clientId.length < 3 || clientId.length > 512 || clientSecret.length < 8 || clientSecret.length > 4096
      || /[\r\n]/.test(clientId + clientSecret)) throw new Error('eBay application credentials are invalid');
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')}`;
}

const ebayToken = credentialOperation(async function ebayToken(config) {
  if (Number(config.credentials.expires_at || 0) > Date.now() + 300_000) return config.credentials.access_token;
  if (Number(config.credentials.refresh_expires_at || Number.MAX_SAFE_INTEGER) <= Date.now()) {
    throw new Error('eBay refresh token has expired; reconnect the seller account');
  }
  let token;
  try {
    token = await fetchJson(`${ebayBase(config)}/identity/v1/oauth2/token`, {
      method: 'POST',
      headers: { authorization: ebayAppAuthorization(config), 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'refresh_token', refresh_token: String(config.credentials.refresh_token || ''),
        scope: EBAY_REQUIRED_SCOPES.join(' '),
      }).toString(),
    });
  } catch (error) {
    const status = String(error?.message || '').match(/HTTP (\d{3})/)?.[1];
    throw commerceError(error?.code, `eBay authorization refresh failed${status ? ` (HTTP ${status})` : ''}`);
  }
  if (!token.access_token) throw new Error('eBay refresh returned incomplete credentials');
  const granted = new Set(String(token.scope || config.credentials.scope || '').split(/[ ,]+/).filter(Boolean));
  const missing = EBAY_REQUIRED_SCOPES.filter((scope) => !granted.has(scope));
  if (missing.length) throw new Error(`eBay authorization is missing required scopes: ${missing.join(', ')}`);
  config.credentials = {
    ...config.credentials, access_token: token.access_token,
    refresh_token: token.refresh_token || config.credentials.refresh_token,
    token_type: token.token_type || 'Bearer', scope: token.scope || config.credentials.scope,
    expires_at: Date.now() + Math.max(60, Number(token.expires_in || 7200)) * 1000,
  };
  writeCredentialFile(config.credentialFile, config.credentialKey, config.credentials);
  return config.credentials.access_token;
});

async function ebayRequest(config, method, path, p = {}) {
  const token = await ebayToken(config);
  const headers = {
    authorization: `Bearer ${token}`, accept: 'application/json',
    'X-EBAY-C-MARKETPLACE-ID': config.metadata.marketplace_id,
    'Content-Language': config.metadata.content_language,
  };
  const init = { method, headers };
  if (p.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(p.body);
  }
  const url = `${ebayBase(config)}${path}${queryString(p.query)}`;
  if (method === 'POST' && path.endsWith('/issue_refund')) {
    Object.assign(headers, refundSignatureHeaders(config.credentials, url, method, init.body));
  }
  try {
    return await fetchJson(url, init);
  } catch (error) {
    const status = String(error?.message || '').match(/HTTP (\d{3})/)?.[1];
    throw commerceError(error?.code, `eBay request failed${status ? ` (HTTP ${status})` : ''}`);
  }
}

function validateEbayMutation(config, name, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(`eBay ${name} body is required`);
  const marketplaceId = config.metadata.marketplace_id;
  if (body.marketplaceId !== undefined && body.marketplaceId !== marketplaceId) {
    throw new Error('eBay request marketplace does not match the connected marketplace');
  }
  if (/^(?:fulfillment|payment|return)_policies\.(?:create|update)$/.test(name) || name === 'offers.create') {
    return { ...body, marketplaceId };
  }
  return body;
}

async function executeEbay(config, name, p) {
  if (name === 'account.privileges') return ebayRequest(config, 'GET', '/sell/account/v1/privilege');
  const policy = name.match(/^(fulfillment|payment|return)_policies\.(list|get|create|update|delete)$/);
  if (policy) {
    const [, kind, operation] = policy;
    const collection = `/sell/account/v1/${kind}_policy`;
    const path = `${collection}${['get', 'update', 'delete'].includes(operation) ? `/${safeId(p.id)}` : ''}`;
    const method = operation === 'list' || operation === 'get' ? 'GET'
      : operation === 'create' ? 'POST' : operation === 'update' ? 'PUT' : 'DELETE';
    const query = operation === 'list' ? { marketplace_id: config.metadata.marketplace_id } : undefined;
    const body = ['create', 'update'].includes(operation) ? validateEbayMutation(config, name, p.body) : undefined;
    return ebayRequest(config, method, path, { query, body });
  }
  const routes = {
    'locations.list': () => ['GET', '/sell/inventory/v1/location', { query: p.query }],
    'locations.get': () => ['GET', `/sell/inventory/v1/location/${safeId(p.location_key, 'location_key')}`, {}],
    'locations.create': () => ['POST', `/sell/inventory/v1/location/${safeId(p.location_key, 'location_key')}`, { body: p.body }],
    'locations.update': () => ['POST', `/sell/inventory/v1/location/${safeId(p.location_key, 'location_key')}/update_location_details`, { body: p.body }],
    'locations.enable': () => ['POST', `/sell/inventory/v1/location/${safeId(p.location_key, 'location_key')}/enable`, {}],
    'locations.disable': () => ['POST', `/sell/inventory/v1/location/${safeId(p.location_key, 'location_key')}/disable`, {}],
    'locations.delete': () => ['DELETE', `/sell/inventory/v1/location/${safeId(p.location_key, 'location_key')}`, {}],
    'inventory_items.list': () => ['GET', '/sell/inventory/v1/inventory_item', { query: p.query }],
    'inventory_items.get': () => ['GET', `/sell/inventory/v1/inventory_item/${safeId(p.sku, 'sku')}`, {}],
    'inventory_items.replace': () => ['PUT', `/sell/inventory/v1/inventory_item/${safeId(p.sku, 'sku')}`, { body: p.body }],
    'inventory_items.delete': () => ['DELETE', `/sell/inventory/v1/inventory_item/${safeId(p.sku, 'sku')}`, {}],
    'inventory_item_groups.get': () => ['GET', `/sell/inventory/v1/inventory_item_group/${safeId(p.group_key, 'group_key')}`, {}],
    'inventory_item_groups.replace': () => ['PUT', `/sell/inventory/v1/inventory_item_group/${safeId(p.group_key, 'group_key')}`, { body: p.body }],
    'inventory_item_groups.delete': () => ['DELETE', `/sell/inventory/v1/inventory_item_group/${safeId(p.group_key, 'group_key')}`, {}],
    'offers.list': () => ['GET', '/sell/inventory/v1/offer', { query: { ...p.query, sku: p.sku } }],
    'offers.get': () => ['GET', `/sell/inventory/v1/offer/${safeId(p.offer_id, 'offer_id')}`, {}],
    'offers.create': () => ['POST', '/sell/inventory/v1/offer', { body: validateEbayMutation(config, name, p.body) }],
    'offers.update': () => ['PUT', `/sell/inventory/v1/offer/${safeId(p.offer_id, 'offer_id')}`, { body: validateEbayMutation(config, name, p.body) }],
    'offers.publish': () => ['POST', `/sell/inventory/v1/offer/${safeId(p.offer_id, 'offer_id')}/publish`, {}],
    'offers.withdraw': () => ['POST', `/sell/inventory/v1/offer/${safeId(p.offer_id, 'offer_id')}/withdraw`, {}],
    'offers.delete': () => ['DELETE', `/sell/inventory/v1/offer/${safeId(p.offer_id, 'offer_id')}`, {}],
    'orders.list': () => ['GET', '/sell/fulfillment/v1/order', { query: p.query }],
    'orders.get': () => ['GET', `/sell/fulfillment/v1/order/${safeId(p.order_id, 'order_id')}`, {}],
    'shipping_fulfillments.list': () => ['GET', `/sell/fulfillment/v1/order/${safeId(p.order_id, 'order_id')}/shipping_fulfillment`, {}],
    'shipping_fulfillments.get': () => ['GET', `/sell/fulfillment/v1/order/${safeId(p.order_id, 'order_id')}/shipping_fulfillment/${safeId(p.fulfillment_id, 'fulfillment_id')}`, {}],
    'shipping_fulfillments.create': () => ['POST', `/sell/fulfillment/v1/order/${safeId(p.order_id, 'order_id')}/shipping_fulfillment`, { body: p.body }],
    'orders.issue_refund': () => ['POST', `/sell/fulfillment/v1/order/${safeId(p.order_id, 'order_id')}/issue_refund`, { body: p.body }],
  };
  const route = routes[name]?.();
  if (!route) throw new Error('unsupported eBay action');
  return ebayRequest(config, route[0], route[1], route[2]);
}

const ETSY_REQUIRED_SCOPES = Object.freeze([
  'shops_r', 'shops_w', 'listings_r', 'listings_w', 'listings_d',
  'transactions_r', 'transactions_w',
]);

function etsyApiKey(config) {
  const keystring = String(config.credentials.keystring || '');
  const sharedSecret = String(config.credentials.shared_secret || '');
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(keystring) || sharedSecret.length < 8 || sharedSecret.length > 4096
      || /[\r\n]/.test(sharedSecret)) throw new Error('Etsy application credentials are invalid');
  return `${keystring}:${sharedSecret}`;
}

const etsyToken = credentialOperation(async function etsyToken(config) {
  if (Number(config.credentials.expires_at || 0) > Date.now() + 300_000) return config.credentials.access_token;
  let token;
  try {
    token = await fetchJson('https://api.etsy.com/v3/public/oauth/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'refresh_token', client_id: String(config.credentials.keystring || ''),
        refresh_token: String(config.credentials.refresh_token || ''),
      }).toString(),
    });
  } catch (error) {
    const status = String(error?.message || '').match(/HTTP (\d{3})/)?.[1];
    throw commerceError(error?.code, `Etsy authorization refresh failed${status ? ` (HTTP ${status})` : ''}`);
  }
  if (!token.access_token || !token.refresh_token) throw new Error('Etsy refresh returned incomplete credentials');
  const refreshedUserId = String(token.access_token).split('.', 1)[0];
  if (!/^[1-9][0-9]*$/.test(refreshedUserId)
      || refreshedUserId !== String(config.credentials.identity?.user_id || '')) {
    throw new Error('Etsy refreshed authorization belongs to a different user');
  }
  const granted = new Set(String(token.scope || config.credentials.scope || '').split(/[ ,]+/).filter(Boolean));
  const missing = ETSY_REQUIRED_SCOPES.filter((scope) => !granted.has(scope));
  if (missing.length) throw new Error(`Etsy authorization is missing required scopes: ${missing.join(', ')}`);
  config.credentials = {
    ...config.credentials, access_token: token.access_token, refresh_token: token.refresh_token,
    token_type: token.token_type || 'Bearer', scope: token.scope || config.credentials.scope,
    expires_at: Date.now() + Math.max(60, Number(token.expires_in || 3600)) * 1000,
  };
  writeCredentialFile(config.credentialFile, config.credentialKey, config.credentials);
  return config.credentials.access_token;
});

function etsyFormBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Etsy form body is required');
  const params = new URLSearchParams();
  for (const [key, raw] of Object.entries(body)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) throw new Error(`invalid Etsy body field: ${key}`);
    const values = Array.isArray(raw) ? raw : [raw];
    if (values.length > 100) throw new Error(`too many Etsy body values: ${key}`);
    for (const value of values) {
      if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
        throw new Error(`invalid Etsy form value: ${key}`);
      }
      params.append(key, value === null ? '' : String(value));
    }
  }
  return params.toString();
}

async function etsyRequest(config, method, path, p = {}) {
  const token = await etsyToken(config);
  const headers = { authorization: `Bearer ${token}`, 'x-api-key': etsyApiKey(config), accept: 'application/json' };
  const init = { method, headers };
  if (p.body !== undefined) {
    if (p.json) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(p.body);
    } else {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      init.body = etsyFormBody(p.body);
    }
  }
  try {
    return await fetchJson(`https://openapi.etsy.com/v3/application${path}${queryString(p.query)}`, init);
  } catch (error) {
    const status = String(error?.message || '').match(/HTTP (\d{3})/)?.[1];
    throw commerceError(error?.code, `Etsy request failed${status ? ` (HTTP ${status})` : ''}`);
  }
}

async function executeEtsy(config, name, p) {
  const shop = safeNumericId(config.metadata.shop_id, 'shop_id');
  const routes = {
    'shop.get': () => ['GET', `/shops/${shop}`, {}],
    'shop.update': () => ['PUT', `/shops/${shop}`, { body: p.body }],
    'listings.list': () => ['GET', `/shops/${shop}/listings`, { query: p.query }],
    'listings.get': () => ['GET', `/listings/${safeNumericId(p.listing_id, 'listing_id')}`, {}],
    'listings.create_draft': () => ['POST', `/shops/${shop}/listings`, { body: p.body }],
    'listings.update': () => ['PATCH', `/shops/${shop}/listings/${safeNumericId(p.listing_id, 'listing_id')}`, { body: p.body }],
    'listings.delete': () => ['DELETE', `/listings/${safeNumericId(p.listing_id, 'listing_id')}`, {}],
    'listing_inventory.get': () => ['GET', `/listings/${safeNumericId(p.listing_id, 'listing_id')}/inventory`, { query: p.query }],
    'listing_inventory.update': () => ['PUT', `/listings/${safeNumericId(p.listing_id, 'listing_id')}/inventory`, { body: p.body, json: true }],
    'receipts.list': () => ['GET', `/shops/${shop}/receipts`, { query: p.query }],
    'receipts.get': () => ['GET', `/shops/${shop}/receipts/${safeNumericId(p.receipt_id, 'receipt_id')}`, {}],
    'receipt_payments.list': () => ['GET', `/shops/${shop}/receipts/${safeNumericId(p.receipt_id, 'receipt_id')}/payments`, {}],
    'receipt_listings.list': () => ['GET', `/shops/${shop}/receipts/${safeNumericId(p.receipt_id, 'receipt_id')}/listings`, {}],
    'receipt_transactions.list': () => ['GET', `/shops/${shop}/receipts/${safeNumericId(p.receipt_id, 'receipt_id')}/transactions`, {}],
    'receipts.update': () => ['PUT', `/shops/${shop}/receipts/${safeNumericId(p.receipt_id, 'receipt_id')}`, { body: p.body }],
    'receipt_shipments.create': () => ['POST', `/shops/${shop}/receipts/${safeNumericId(p.receipt_id, 'receipt_id')}/tracking`, { body: p.body, json: true }],
    'shipping_profiles.list': () => ['GET', `/shops/${shop}/shipping-profiles`, {}],
    'shipping_profiles.get': () => ['GET', `/shops/${shop}/shipping-profiles/${safeNumericId(p.profile_id, 'profile_id')}`, {}],
    'shipping_profiles.create': () => ['POST', `/shops/${shop}/shipping-profiles`, { body: p.body }],
    'shipping_profiles.update': () => ['PUT', `/shops/${shop}/shipping-profiles/${safeNumericId(p.profile_id, 'profile_id')}`, { body: p.body }],
    'shipping_profiles.delete': () => ['DELETE', `/shops/${shop}/shipping-profiles/${safeNumericId(p.profile_id, 'profile_id')}`, {}],
    'shipping_destinations.list': () => ['GET', `/shops/${shop}/shipping-profiles/${safeNumericId(p.profile_id, 'profile_id')}/destinations`, {}],
    'shipping_destinations.create': () => ['POST', `/shops/${shop}/shipping-profiles/${safeNumericId(p.profile_id, 'profile_id')}/destinations`, { body: p.body }],
    'shipping_destinations.update': () => ['PUT', `/shops/${shop}/shipping-profiles/${safeNumericId(p.profile_id, 'profile_id')}/destinations/${safeNumericId(p.destination_id, 'destination_id')}`, { body: p.body }],
    'shipping_destinations.delete': () => ['DELETE', `/shops/${shop}/shipping-profiles/${safeNumericId(p.profile_id, 'profile_id')}/destinations/${safeNumericId(p.destination_id, 'destination_id')}`, {}],
    'shipping_upgrades.list': () => ['GET', `/shops/${shop}/shipping-profiles/${safeNumericId(p.profile_id, 'profile_id')}/upgrades`, {}],
    'shipping_upgrades.create': () => ['POST', `/shops/${shop}/shipping-profiles/${safeNumericId(p.profile_id, 'profile_id')}/upgrades`, { body: p.body }],
    'shipping_upgrades.update': () => ['PUT', `/shops/${shop}/shipping-profiles/${safeNumericId(p.profile_id, 'profile_id')}/upgrades/${safeNumericId(p.upgrade_id, 'upgrade_id')}`, { body: p.body }],
    'shipping_upgrades.delete': () => ['DELETE', `/shops/${shop}/shipping-profiles/${safeNumericId(p.profile_id, 'profile_id')}/upgrades/${safeNumericId(p.upgrade_id, 'upgrade_id')}`, {}],
    'shop_sections.list': () => ['GET', `/shops/${shop}/sections`, {}],
    'shop_sections.get': () => ['GET', `/shops/${shop}/sections/${safeNumericId(p.section_id, 'section_id')}`, {}],
    'shop_sections.create': () => ['POST', `/shops/${shop}/sections`, { body: p.body }],
    'shop_sections.update': () => ['PUT', `/shops/${shop}/sections/${safeNumericId(p.section_id, 'section_id')}`, { body: p.body }],
    'shop_sections.delete': () => ['DELETE', `/shops/${shop}/sections/${safeNumericId(p.section_id, 'section_id')}`, {}],
    'production_partners.list': () => ['GET', `/shops/${shop}/production-partners`, {}],
  };
  const route = routes[name]?.();
  if (!route) throw new Error('unsupported Etsy action');
  return etsyRequest(config, route[0], route[1], route[2]);
}

function amazonBase(config) {
  const region = AMAZON_MARKETPLACE_REGIONS[config.metadata.marketplace_id];
  if (!region || !['sandbox', 'live'].includes(config.metadata.environment)) {
    throw new Error('invalid Amazon Seller marketplace binding');
  }
  return `https://${config.metadata.environment === 'sandbox' ? 'sandbox.' : ''}sellingpartnerapi-${region}.amazon.com`;
}

async function amazonToken(config) {
  const cacheKey = `amazon:${config.credentialFile}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expires_at > Date.now() + 300_000) return cached.access_token;
  const token = await fetchStatusOnlyJson('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: String(config.credentials.refresh_token || ''),
      client_id: String(config.credentials.client_id || ''), client_secret: String(config.credentials.client_secret || ''),
    }).toString(),
  }, 'Amazon Seller authorization');
  if (!token.access_token) throw new Error('Amazon Seller authorization returned incomplete credentials');
  const cachedToken = {
    access_token: token.access_token,
    expires_at: Date.now() + Math.max(60, Number(token.expires_in || 3600)) * 1000,
  };
  tokenCache.set(cacheKey, cachedToken);
  return cachedToken.access_token;
}

async function amazonRequest(config, method, path, p = {}) {
  const token = await amazonToken(config);
  const headers = {
    accept: 'application/json', 'x-amz-access-token': token,
    'x-amz-date': new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''),
    'user-agent': 'Orkas/1.7.0 (Language=JavaScript; Platform=Desktop)',
  };
  const init = { method, headers };
  if (p.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(p.body);
  }
  return fetchStatusOnlyJson(`${amazonBase(config)}${path}${queryString(p.query)}`, init, 'Amazon Seller');
}

function amazonCatalogQuery(config, p) {
  if (p.keywords && p.identifiers) throw new Error('Amazon catalog search accepts either keywords or identifiers, not both');
  if (p.identifiers && !p.identifiers_type) throw new Error('Amazon catalog identifiers_type is required with identifiers');
  if (p.identifiers_type === 'SKU' && !p.identifiers) throw new Error('Amazon catalog SKU search requires identifiers');
  return {
    marketplaceIds: config.metadata.marketplace_id,
    includedData: 'summaries,identifiers,images,productTypes,salesRanks',
    ...(p.keywords ? { keywords: p.keywords } : {}),
    ...(p.identifiers ? { identifiers: p.identifiers.join(','), identifiersType: p.identifiers_type } : {}),
    ...(p.identifiers_type === 'SKU' ? { sellerId: config.metadata.seller_id } : {}),
    ...(p.page_size ? { pageSize: p.page_size } : {}), ...(p.page_token ? { pageToken: p.page_token } : {}),
  };
}

async function executeAmazon(config, name, p) {
  const seller = safeId(config.metadata.seller_id, 'seller_id');
  const marketplace = config.metadata.marketplace_id;
  if (name === 'account.marketplace_participations') {
    return amazonRequest(config, 'GET', '/sellers/v1/marketplaceParticipations');
  }
  if (name === 'catalog.search') return amazonRequest(config, 'GET', '/catalog/2022-04-01/items', { query: amazonCatalogQuery(config, p) });
  if (name === 'catalog.get') return amazonRequest(config, 'GET', `/catalog/2022-04-01/items/${safeId(p.asin, 'asin')}`, {
    query: { marketplaceIds: marketplace, includedData: 'summaries,identifiers,images,productTypes,salesRanks' },
  });
  if (name === 'listings.search') return amazonRequest(config, 'GET', `/listings/2021-08-01/items/${seller}`, {
    query: {
      marketplaceIds: marketplace,
      includedData: 'summaries,attributes,issues,offers,fulfillmentAvailability,procurement,relationships,productTypes',
      ...(p.sku ? { identifiers: p.sku, identifiersType: 'SKU' } : {}),
      ...(p.status ? { withStatus: p.status } : {}),
      ...(p.page_size ? { pageSize: p.page_size } : {}), ...(p.page_token ? { pageToken: p.page_token } : {}),
    },
  });
  if (name === 'listings.get') return amazonRequest(config, 'GET', `/listings/2021-08-01/items/${seller}/${safeId(p.sku, 'sku')}`, {
    query: { marketplaceIds: marketplace, includedData: 'summaries,attributes,issues,offers,fulfillmentAvailability,procurement,relationships,productTypes' },
  });
  if (name === 'listings.restrictions') return amazonRequest(config, 'GET', '/listings/2021-08-01/restrictions', {
    query: { asin: p.asin, sellerId: config.metadata.seller_id, marketplaceIds: marketplace,
      ...(p.condition_type ? { conditionType: p.condition_type } : {}), ...(p.reason_locale ? { reasonLocale: p.reason_locale } : {}) },
  });
  if (name === 'listings.put' || name === 'listings.patch') {
    const body = { ...p.body, productType: p.product_type };
    if (name === 'listings.put') body.requirements = p.requirements || 'LISTING';
    return amazonRequest(config, name === 'listings.put' ? 'PUT' : 'PATCH',
      `/listings/2021-08-01/items/${seller}/${safeId(p.sku, 'sku')}`,
      { query: { marketplaceIds: marketplace }, body });
  }
  if (name === 'listings.delete') return amazonRequest(config, 'DELETE',
    `/listings/2021-08-01/items/${seller}/${safeId(p.sku, 'sku')}`, { query: { marketplaceIds: marketplace } });
  if (name === 'orders.search') return amazonRequest(config, 'GET', '/orders/2026-01-01/orders', { query: {
    marketplaceIds: marketplace,
    ...(p.created_after ? { createdAfter: p.created_after } : {}), ...(p.created_before ? { createdBefore: p.created_before } : {}),
    ...(p.last_updated_after ? { lastUpdatedAfter: p.last_updated_after } : {}), ...(p.last_updated_before ? { lastUpdatedBefore: p.last_updated_before } : {}),
    ...(p.fulfillment_statuses ? { fulfillmentStatuses: p.fulfillment_statuses.join(',') } : {}),
    ...(p.fulfilled_by ? { fulfilledBy: p.fulfilled_by.join(',') } : {}),
    ...(p.page_size ? { maxResultsPerPage: p.page_size } : {}), ...(p.page_token ? { paginationToken: p.page_token } : {}),
  } });
  if (name === 'orders.get') return amazonRequest(config, 'GET', `/orders/2026-01-01/orders/${safeId(p.order_id, 'order_id')}`);
  if (name === 'inventory.fba_summaries') return amazonRequest(config, 'GET', '/fba/inventory/v1/summaries', { query: {
    details: true, granularityType: 'Marketplace', granularityId: marketplace, marketplaceIds: marketplace,
    ...(p.start_date_time ? { startDateTime: p.start_date_time } : {}),
    ...(p.seller_skus ? { sellerSkus: p.seller_skus.join(',') } : {}), ...(p.next_token ? { nextToken: p.next_token } : {}),
  } });
  if (name === 'finances.transactions') return amazonRequest(config, 'GET', '/finances/2024-06-19/transactions', { query: {
    marketplaceId: marketplace, ...(p.posted_after ? { postedAfter: p.posted_after } : {}),
    ...(p.posted_before ? { postedBefore: p.posted_before } : {}), ...(p.transaction_status ? { transactionStatus: p.transaction_status } : {}),
    ...(p.next_token ? { nextToken: p.next_token } : {}),
  } });
  if (name === 'finances.balances') return amazonRequest(config, 'GET', '/finances/2024-06-19/balances', { query: {
    marketplaceIds: marketplace, ...(p.balance_type ? { balanceType: p.balance_type } : {}),
    ...(p.account_type ? { accountType: p.account_type } : {}), ...(p.as_of_date ? { asOfDate: p.as_of_date } : {}),
    ...(p.next_token ? { nextToken: p.next_token } : {}),
  } });
  if (name === 'finances.summary') return amazonRequest(config, 'GET', '/finances/2024-06-19/summary', { query: {
    marketplaceIds: marketplace, ...(p.account_type ? { accountType: p.account_type } : {}),
    ...(p.period_start ? { periodStart: p.period_start } : {}), ...(p.period_end ? { periodEnd: p.period_end } : {}),
    ...(p.next_token ? { nextToken: p.next_token } : {}),
  } });
  if (name === 'product_types.search') return amazonRequest(config, 'GET', '/definitions/2020-09-01/productTypes', {
    query: { marketplaceIds: marketplace, ...(p.keywords ? { keywords: p.keywords } : {}) },
  });
  if (name === 'product_types.get') return amazonRequest(config, 'GET', `/definitions/2020-09-01/productTypes/${safeId(p.product_type, 'product_type')}`, {
    query: { sellerId: config.metadata.seller_id, marketplaceIds: marketplace, requirements: p.requirements || 'LISTING', requirementsEnforced: 'ENFORCED' },
  });
  throw new Error('unsupported Amazon Seller action');
}

const MERCADO_LIBRE_REQUIRED_SCOPES = Object.freeze(['offline_access', 'read', 'write']);
const mercadoRefreshes = new Map();

async function refreshMercadoLibreToken(config) {
  const token = await fetchStatusOnlyJson('https://api.mercadolibre.com/oauth/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', client_id: String(config.credentials.client_id || ''),
      client_secret: String(config.credentials.client_secret || ''), refresh_token: String(config.credentials.refresh_token || ''),
    }).toString(),
  }, 'Mercado Libre authorization');
  if (!token.access_token || !token.refresh_token || String(token.user_id || '') !== String(config.metadata.user_id)) {
    throw new Error('Mercado Libre refresh returned incomplete or mismatched credentials');
  }
  const granted = new Set(String(token.scope || config.credentials.scope || '').split(/[ ,]+/).filter(Boolean));
  const missing = MERCADO_LIBRE_REQUIRED_SCOPES.filter((scope) => !granted.has(scope));
  if (missing.length) throw new Error(`Mercado Libre authorization is missing required scopes: ${missing.join(', ')}`);
  config.credentials = {
    ...config.credentials, access_token: token.access_token, refresh_token: token.refresh_token,
    token_type: token.token_type || 'Bearer', scope: token.scope || config.credentials.scope,
    expires_at: Date.now() + Math.max(60, Number(token.expires_in || 21_600)) * 1000,
  };
  writeCredentialFile(config.credentialFile, config.credentialKey, config.credentials);
  return config.credentials.access_token;
}

const mercadoLibreToken = credentialOperation(async function mercadoLibreToken(config) {
  if (config.credentials.access_token && Number(config.credentials.expires_at || 0) > Date.now() + 300_000) {
    return config.credentials.access_token;
  }
  const key = config.credentialFile;
  if (mercadoRefreshes.has(key)) return mercadoRefreshes.get(key);
  const pending = refreshMercadoLibreToken(config).finally(() => mercadoRefreshes.delete(key));
  mercadoRefreshes.set(key, pending);
  return pending;
});

async function mercadoLibreRequest(config, method, path, p = {}) {
  const token = await mercadoLibreToken(config);
  const headers = { authorization: `Bearer ${token}`, accept: 'application/json', ...(p.headers || {}) };
  const init = { method, headers };
  if (p.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(p.body);
  }
  return fetchStatusOnlyJson(`https://api.mercadolibre.com${path}${queryString(p.query)}`, init, 'Mercado Libre');
}

async function executeMercadoLibre(config, name, p) {
  const user = safeNumericId(config.metadata.user_id, 'user_id');
  const routes = {
    'account.get': () => ['GET', '/users/me', {}],
    'listings.search': () => ['GET', `/marketplace/users/${user}/items/search`, { query: p.query }],
    'listings.get': () => ['GET', `/items/${safeId(p.item_id, 'item_id')}`, {}],
    'marketplace_listings.get': () => ['GET', `/marketplace/items/${safeId(p.item_id, 'item_id')}`, {}],
    'listings.marketplace_mappings': () => ['GET', `/items/${safeId(p.item_id, 'item_id')}/marketplace_items`, {}],
    'listings.create': () => ['POST', '/global/items', { body: p.body, headers: { 'parent-item-info': 'true' } }],
    'listings.update': () => ['PUT', `/global/items/${safeId(p.item_id, 'item_id')}`, { body: p.body }],
    'listings.pause': () => ['PUT', `/global/items/${safeId(p.item_id, 'item_id')}`, { body: { status: 'paused' } }],
    'listings.delete_marketplace': () => ['PUT', `/global/items/${safeId(p.item_id, 'item_id')}`, { body: { site_id: p.site_id, logistic_type: 'remote', deleted: true } }],
    'orders.search': () => ['GET', '/marketplace/orders/search', { query: { ...p.query, 'seller.id': user } }],
    'orders.get': () => ['GET', `/marketplace/orders/${safeId(p.order_id, 'order_id')}`, {}],
    'shipments.get': () => ['GET', `/marketplace/shipments/${safeId(p.shipment_id, 'shipment_id')}`, { headers: { 'x-format-new': 'true' } }],
    'shipments.items': () => ['GET', `/marketplace/shipments/${safeId(p.shipment_id, 'shipment_id')}/items`, {}],
    'shipments.costs': () => ['GET', `/marketplace/shipments/${safeId(p.shipment_id, 'shipment_id')}/costs`, { headers: { 'x-format-new': 'true' } }],
    'shipments.compensation_costs': () => ['GET', `/marketplace/shipments/${safeId(p.shipment_id, 'shipment_id')}/compensation_costs`, {}],
    'questions.search': () => ['GET', '/marketplace/questions/search', { query: { ...p.query, seller_id: user } }],
    'questions.get': () => ['GET', `/marketplace/questions/${safeNumericId(p.question_id, 'question_id')}`, {}],
    'questions.answer': () => ['POST', '/marketplace/answers', { body: { question_id: Number(safeNumericId(p.question_id, 'question_id')), text: p.text } }],
    'questions.delete': () => ['DELETE', `/marketplace/questions/${safeNumericId(p.question_id, 'question_id')}`, {}],
    'price_benchmarks.list': () => ['GET', `/marketplace/benchmarks/user/${user}/items`, { query: p.query }],
    'price_benchmarks.get': () => ['GET', `/marketplace/benchmarks/items/${safeId(p.item_id, 'item_id')}/details`, {}],
    'prices.history': () => ['GET', `/marketplace/items/${safeId(p.item_id, 'item_id')}/prices/history`, {}],
  };
  const route = routes[name]?.();
  if (!route) throw new Error('unsupported Mercado Libre action');
  return mercadoLibreRequest(config, route[0], route[1], route[2]);
}

const TAOBAO_API_URL = 'https://gw.api.taobao.com/router/rest';
const taobaoRefreshes = new Map();

function chinaTimestamp(now = Date.now()) {
  return new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

function signTaobao(parameters, appSecret) {
  const message = Object.keys(parameters).sort().map((key) => `${key}${parameters[key]}`).join('');
  return createHmac('sha256', appSecret).update(message, 'utf8').digest('hex').toUpperCase();
}

async function taobaoRequestWithToken(config, accessToken, method, parameters = {}) {
  const form = {
    method, app_key: config.credentials.app_key, session: accessToken,
    timestamp: chinaTimestamp(), v: '2.0', sign_method: 'hmac-sha256',
    format: 'json', simplify: 'true', ...parameters,
  };
  form.sign = signTaobao(form, config.credentials.app_secret);
  const body = await fetchStatusOnlyJson(TAOBAO_API_URL, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8', accept: 'application/json' },
    body: new URLSearchParams(Object.fromEntries(Object.entries(form).map(([key, value]) => [key, String(value)]))).toString(),
  }, 'Taobao');
  if (body?.error_response) {
    throw new Error(`Taobao request failed (provider code ${String(body.error_response.code || 'unknown').slice(0, 40)})`);
  }
  return body;
}

async function refreshTaobaoToken(config) {
  if (!config.credentials.refresh_token
      || Number(config.credentials.refresh_expires_at || 0) <= Date.now() + 300_000) {
    throw new Error('Taobao authorization expired; reconnect this seller account');
  }
  const token = await fetchStatusOnlyJson('https://oauth.taobao.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: String(config.credentials.refresh_token),
      client_id: String(config.credentials.app_key), client_secret: String(config.credentials.app_secret),
    }).toString(),
  }, 'Taobao authorization');
  if (!token.access_token
      || (token.taobao_user_id && String(token.taobao_user_id) !== String(config.credentials.identity.user_id))
      || (config.credentials.identity.open_uid && token.taobao_open_uid
        && String(token.taobao_open_uid) !== String(config.credentials.identity.open_uid))) {
    throw new Error('Taobao refresh returned incomplete or mismatched credentials');
  }
  const identityResponse = await taobaoRequestWithToken(config, token.access_token, 'taobao.user.seller.get', {
    fields: 'user_id,nick,type,has_shop',
  });
  const identity = identityResponse.user_seller_get_response?.user || identityResponse.user || {};
  if (!identity.nick || String(identity.user_id || '') !== String(config.credentials.identity.user_id)) {
    throw new Error('Taobao refresh returned a different seller');
  }
  config.credentials = {
    ...config.credentials, access_token: token.access_token,
    refresh_token: token.refresh_token || config.credentials.refresh_token,
    expires_at: Date.now() + Math.max(60, Number(token.expires_in || 86_400)) * 1000,
    refresh_expires_at: token.re_expires_in
      ? Date.now() + Math.max(60, Number(token.re_expires_in)) * 1000
      : config.credentials.refresh_expires_at,
    identity: {
      ...config.credentials.identity,
      ...(token.taobao_open_uid ? { open_uid: String(token.taobao_open_uid) } : {}),
    },
  };
  writeCredentialFile(config.credentialFile, config.credentialKey, config.credentials);
  return config.credentials.access_token;
}

const taobaoToken = credentialOperation(async function taobaoToken(config) {
  if (Number(config.credentials.expires_at || 0) > Date.now() + 300_000) return config.credentials.access_token;
  const key = config.credentialFile;
  if (taobaoRefreshes.has(key)) return taobaoRefreshes.get(key);
  const pending = refreshTaobaoToken(config).finally(() => taobaoRefreshes.delete(key));
  taobaoRefreshes.set(key, pending);
  return pending;
});

async function taobaoRequest(config, method, parameters = {}) {
  return taobaoRequestWithToken(config, await taobaoToken(config), method, parameters);
}

function sellerDate(value, name) {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(value || ''))) throw new Error(`invalid ${name}`);
  return value;
}

async function executeTaobao(config, name, p) {
  const itemFields = 'num_iid,title,price,num,outer_id,cid,modified,list_time,delist_time,approve_status,has_discount,has_showcase,freight_payer,sku,skus';
  const listFields = 'num_iid,title,price,num,outer_id,cid,modified,list_time,delist_time,approve_status';
  if (name === 'account.get') return taobaoRequest(config, 'taobao.user.seller.get', { fields: 'user_id,nick,type,has_shop,consumer_protection,created,last_visit' });
  if (name === 'listings.onsale' || name === 'listings.inventory') {
    return taobaoRequest(config, name === 'listings.onsale' ? 'taobao.items.onsale.get' : 'taobao.items.inventory.get', {
      fields: listFields, page_no: String(p.page_no || 1), page_size: String(p.page_size || 40),
      ...(p.query ? { q: p.query } : {}), ...(p.order_by ? { order_by: p.order_by } : {}),
    });
  }
  if (name === 'listings.get') return taobaoRequest(config, 'taobao.item.seller.get', {
    num_iid: safeNumericId(p.item_id, 'item_id'), fields: itemFields,
  });
  if (name === 'orders.list') return taobaoRequest(config, 'taobao.trades.sold.get', {
    fields: 'tid,status,created,modified,payment,post_fee,num,num_iid,title,type,seller_nick,orders.oid,orders.num_iid,orders.sku_id,orders.outer_sku_id,orders.num,orders.title,orders.price,orders.total_fee,orders.payment,orders.status',
    page_no: String(p.page_no || 1), page_size: String(p.page_size || 40),
    ...(p.start_created ? { start_created: sellerDate(p.start_created, 'start_created') } : {}),
    ...(p.end_created ? { end_created: sellerDate(p.end_created, 'end_created') } : {}),
    ...(p.status ? { status: p.status } : {}),
  });
  if (name === 'inventory.update') return taobaoRequest(config, 'taobao.item.quantity.update', {
    num_iid: safeNumericId(p.item_id, 'item_id'), quantity: String(p.quantity), type: p.mode === 'absolute' ? '1' : '2',
    ...(p.sku_id ? { sku_id: safeNumericId(p.sku_id, 'sku_id') } : {}), ...(p.outer_id ? { outer_id: p.outer_id } : {}),
  });
  if (name === 'listings.publish') return taobaoRequest(config, 'taobao.item.update.listing', {
    num_iid: safeNumericId(p.item_id, 'item_id'), ...(p.quantity !== undefined ? { num: String(p.quantity) } : {}),
  });
  if (name === 'listings.unpublish') return taobaoRequest(config, 'taobao.item.update.delisting', {
    num_iid: safeNumericId(p.item_id, 'item_id'),
  });
  if (name === 'orders.memo_add' || name === 'orders.memo_update') {
    return taobaoRequest(config, name === 'orders.memo_add' ? 'taobao.trade.memo.add' : 'taobao.trade.memo.update', {
      tid: safeNumericId(p.order_id, 'order_id'), memo: p.memo, ...(p.flag ? { flag: String(p.flag) } : {}),
    });
  }
  if (name === 'listings.delete') return taobaoRequest(config, 'taobao.item.delete', {
    num_iid: safeNumericId(p.item_id, 'item_id'),
  });
  throw new Error('unsupported Taobao/Tmall action');
}

const alibaba1688Refreshes = new Map();

function encode1688Parameter(value) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function sign1688(pathName, parameters, appSecret) {
  const message = pathName + Object.keys(parameters).sort()
    .map((key) => `${key}${encode1688Parameter(parameters[key])}`).join('');
  return createHmac('sha1', appSecret).update(message, 'utf8').digest('hex').toUpperCase();
}

async function alibaba1688RequestWithToken(config, accessToken, namespace, method, parameters = {}) {
  const pathName = `param2/1/${namespace}/${method}/${config.credentials.app_key}`;
  const form = { ...parameters, access_token: accessToken, _aop_timestamp: String(Date.now()) };
  form._aop_signature = sign1688(pathName, form, config.credentials.app_secret);
  const body = await fetchStatusOnlyJson(`https://gw.open.1688.com/openapi/${pathName}`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8', accept: 'application/json' },
    body: new URLSearchParams(Object.fromEntries(
      Object.entries(form).map(([key, value]) => [key, encode1688Parameter(value)]),
    )).toString(),
  }, '1688');
  if (body?.success === false) throw new Error(`1688 request failed (provider code ${String(body.errorCode || 'unknown').slice(0, 40)})`);
  return body;
}

async function refreshAlibaba1688Token(config) {
  const token = await fetchStatusOnlyJson(
    `https://gw.open.1688.com/openapi/http/1/system.oauth2/getToken/${encodeURIComponent(config.credentials.app_key)}`,
    {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'refresh_token', client_id: String(config.credentials.app_key),
        client_secret: String(config.credentials.app_secret), refresh_token: String(config.credentials.refresh_token),
      }).toString(),
    }, '1688 authorization',
  );
  if (!token.access_token || (token.memberId && String(token.memberId) !== String(config.credentials.identity.member_id))) {
    throw new Error('1688 refresh returned incomplete or mismatched credentials');
  }
  const identityResponse = await alibaba1688RequestWithToken(
    config, token.access_token, 'com.alibaba.account', 'alibaba.account.basic',
  );
  if (String(identityResponse?.result?.memberId || '') !== String(config.credentials.identity.member_id)) {
    throw new Error('1688 refresh returned a different seller');
  }
  config.credentials = {
    ...config.credentials, access_token: token.access_token,
    refresh_token: token.refresh_token || config.credentials.refresh_token,
    expires_at: Date.now() + Math.max(60, Number(token.expires_in || 36_000)) * 1000,
    refresh_token_timeout: token.refresh_token_timeout || config.credentials.refresh_token_timeout,
  };
  writeCredentialFile(config.credentialFile, config.credentialKey, config.credentials);
  return config.credentials.access_token;
}

const alibaba1688Token = credentialOperation(async function alibaba1688Token(config) {
  if (Number(config.credentials.expires_at || 0) > Date.now() + 300_000) return config.credentials.access_token;
  const key = config.credentialFile;
  if (alibaba1688Refreshes.has(key)) return alibaba1688Refreshes.get(key);
  const pending = refreshAlibaba1688Token(config).finally(() => alibaba1688Refreshes.delete(key));
  alibaba1688Refreshes.set(key, pending);
  return pending;
});

async function alibaba1688Request(config, namespace, method, parameters = {}) {
  return alibaba1688RequestWithToken(config, await alibaba1688Token(config), namespace, method, parameters);
}

function jsonLong(value, name) {
  const text = safeNumericId(value, name);
  const number = Number(text);
  if (!Number.isSafeInteger(number)) throw new Error(`invalid ${name}`);
  return number;
}

function sendGoods(orderId, entries) {
  return [{
    sourceId: safeNumericId(orderId, 'order_id'),
    sendGoodEntries: entries.map((entry) => ({
      sourceEntryId: safeNumericId(entry.order_entry_id, 'order_entry_id'),
      amount: entry.amount, weight: entry.weight_kg,
    })),
  }];
}

const ALIBABA_1688_SENSITIVE_ORDER_FIELDS = new Set([
  'address', 'buyeraddress', 'buyeralipayid', 'buyercontact', 'buyeremail', 'buyerloginid',
  'buyermemo', 'buyermobile', 'buyername', 'buyerphone', 'buyeruserid', 'contact', 'email',
  'idcard', 'identitycard', 'mobile', 'phone', 'receiver', 'receiveraddress', 'receiverinfo',
  'receivermobile', 'receivername', 'receiverphone', 'toaddress', 'toarea', 'tofullname',
  'tomobile', 'tophone', 'topost',
]);

function minimizeAlibaba1688OrderData(value) {
  if (Array.isArray(value)) return value.map(minimizeAlibaba1688OrderData);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    return ALIBABA_1688_SENSITIVE_ORDER_FIELDS.has(normalized)
      ? [] : [[key, minimizeAlibaba1688OrderData(child)]];
  }));
}

async function executeAlibaba1688(config, name, p) {
  if (name === 'account.get') return alibaba1688Request(config, 'com.alibaba.account', 'alibaba.account.basic');
  if (name === 'products.list') return alibaba1688Request(config, 'com.alibaba.product', 'alibaba.product.list.get', {
    pageNo: String(p.page || 1), pageSize: String(p.page_size || 20),
    ...(p.status ? { statusList: [p.status] } : {}), ...(p.category_id ? { categoryId: safeNumericId(p.category_id, 'category_id') } : {}),
    ...(p.keyword ? { subjectKey: p.keyword } : {}), ...(p.product_ids ? { productIds: p.product_ids.map((id) => jsonLong(id, 'product_id')) } : {}),
    ...(p.order_by ? { orderByCondition: p.order_by } : {}), ...(p.order_direction ? { orderByType: p.order_direction } : {}),
    needDetail: false, needFreight: false, needUserCategoryInfo: false,
  });
  if (name === 'products.get') return alibaba1688Request(config, 'com.alibaba.product', 'alibaba.product.get', {
    productID: safeNumericId(p.product_id, 'product_id'), webSite: '1688', scene: '1688',
  });
  if (name === 'orders.list') {
    const response = await alibaba1688Request(config, 'com.alibaba.trade', 'alibaba.trade.getSellerOrderList', {
      page: String(p.page || 1), pageSize: String(p.page_size || 20),
      needBuyerAddressAndPhone: false, needMemoInfo: false,
      ...(p.create_start ? { createStartTime: sellerDate(p.create_start, 'create_start') } : {}),
      ...(p.create_end ? { createEndTime: sellerDate(p.create_end, 'create_end') } : {}),
      ...(p.modify_start ? { modifyStartTime: sellerDate(p.modify_start, 'modify_start') } : {}),
      ...(p.modify_end ? { modifyEndTime: sellerDate(p.modify_end, 'modify_end') } : {}),
      ...(p.status ? { orderStatus: p.status } : {}), ...(p.refund_status ? { refundStatus: p.refund_status } : {}),
      ...(p.product_name ? { productName: p.product_name } : {}),
    });
    return minimizeAlibaba1688OrderData(response);
  }
  if (name === 'refunds.list') {
    const response = await alibaba1688Request(config, 'com.alibaba.trade', 'alibaba.trade.refund.queryOrderRefundList', {
      ...(p.order_id ? { orderId: safeNumericId(p.order_id, 'order_id') } : {}),
      ...(p.apply_start ? { applyStartTime: sellerDate(p.apply_start, 'apply_start') } : {}),
      ...(p.apply_end ? { applyEndTime: sellerDate(p.apply_end, 'apply_end') } : {}),
      ...(p.modify_start ? { modifyStartTime: sellerDate(p.modify_start, 'modify_start') } : {}),
      ...(p.modify_end ? { modifyEndTime: sellerDate(p.modify_end, 'modify_end') } : {}),
      ...(p.statuses ? { refundStatusSet: p.statuses } : {}), currentPageNum: String(p.page || 0),
      pageSize: String(p.page_size || 20), ...(p.dispute_type !== undefined ? { dipsuteType: String(p.dispute_type) } : {}),
    });
    return minimizeAlibaba1688OrderData(response);
  }
  if (name === 'freight_templates.list') return alibaba1688Request(config, 'com.alibaba.logistics', 'alibaba.logistics.myFreightTemplate.list.get', {
    ...(p.template_id ? { templateId: safeNumericId(p.template_id, 'template_id') } : {}),
    ...(p.include_subtemplates !== undefined ? { querySubTemplate: p.include_subtemplates } : {}),
    ...(p.include_rates !== undefined ? { queryRate: p.include_rates } : {}),
  });
  if (name === 'inventory.adjust') return alibaba1688Request(config, 'com.alibaba.product', 'alibaba.product.modifyStock', {
    webSite: '1688', increaceModify: true,
    productStockChange: p.changes.map((change) => ({
      productId: jsonLong(change.product_id, 'product_id'), productAmountChange: change.product_amount_change,
      skuStocks: change.sku_stocks.map((sku) => ({
        skuId: safeId(sku.sku_id, 'sku_id'), stockChange: sku.stock_change,
      })),
    })),
  });
  if (name === 'products.update') {
    if (p.subject === undefined && p.description === undefined && p.support_online_trade === undefined) {
      throw new Error('at least one product field must be supplied');
    }
    return alibaba1688Request(config, 'com.alibaba.product', 'alibaba.product.incrementModify', {
      productID: safeNumericId(p.product_id, 'product_id'), webSite: '1688',
      ...(p.subject !== undefined ? { subject: p.subject } : {}), ...(p.description !== undefined ? { description: p.description } : {}),
      ...(p.support_online_trade !== undefined ? { supportOnlineTrade: p.support_online_trade } : {}),
    });
  }
  if (name === 'products.expire') return alibaba1688Request(config, 'com.alibaba.product', 'alibaba.product.expire', {
    productIds: p.product_ids.map((id) => jsonLong(id, 'product_id')), webSite: '1688',
  });
  if (name === 'shipments.offline') return alibaba1688Request(config, 'com.alibaba.logistics', 'alibaba.logistics.OpDeliverySendOrder.offline', {
    multiPackage: false, sendGoods: sendGoods(p.order_id, p.entries), remarks: p.remarks || '',
    extBody: JSON.stringify({ cpCode: p.carrier_code, logisticsCpName: p.carrier_name, mailNo: p.tracking_number }),
  });
  if (name === 'shipments.no_logistics') {
    if ((p.reason === '1' || p.reason === '3') && (!p.name || !p.phone)) throw new Error('name and phone are required for this no-logistics reason');
    if (p.reason === '2' && !p.bill_number) throw new Error('bill_number is required for this no-logistics reason');
    if (p.reason === '5' && !p.remarks) throw new Error('remarks are required for this no-logistics reason');
    return alibaba1688Request(config, 'com.alibaba.logistics', 'alibaba.logistics.OpDeliverySendOrder.dummy', {
      sendGoods: sendGoods(p.order_id, p.entries), remarks: p.remarks || '',
      extBody: JSON.stringify({ noLogisticsCondition: p.reason, ...(p.name ? { noLogisticsName: p.name } : {}),
        ...(p.phone ? { noLogisticsTel: p.phone } : {}), ...(p.bill_number ? { noLogisticsBillNo: p.bill_number } : {}) }),
    });
  }
  if (name === 'products.delete') return alibaba1688Request(config, 'com.alibaba.product', 'alibaba.product.delete', {
    productID: safeNumericId(p.product_id, 'product_id'),
  });
  throw new Error('unsupported 1688 action');
}

const jdRefreshes = new Map();

function encodeJdParameter(value) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function signJd(parameters, appSecret) {
  const message = appSecret + Object.keys(parameters).sort()
    .map((key) => `${key}${encodeJdParameter(parameters[key])}`).join('') + appSecret;
  return createHash('md5').update(message, 'utf8').digest('hex').toUpperCase();
}

async function jdRequestWithToken(config, accessToken, method, parameters = {}) {
  const form = {
    method, access_token: accessToken, app_key: config.credentials.app_key,
    timestamp: chinaTimestamp(), '360buy_param_json': JSON.stringify(parameters), v: '2.0',
  };
  form.sign = signJd(form, config.credentials.app_secret);
  const body = await fetchStatusOnlyJson('https://api.jd.com/routerjson', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8', accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
  }, 'JD.com');
  if (body?.error_response) {
    throw new Error(`JD.com request failed (provider code ${String(body.error_response.code || 'unknown').slice(0, 40)})`);
  }
  return body;
}

function jdSellerIdentity(body) {
  const wrapper = body?.jingdong_seller_vender_info_get_responce
    || body?.jingdong_seller_vender_info_get_response
    || body?.seller_vender_info_get_response || body;
  return wrapper?.vender_info_result?.data || wrapper?.vender_info_result || wrapper?.result || {};
}

async function refreshJdToken(config) {
  const token = await fetchStatusOnlyJson('https://open-oauth.jd.com/oauth2/access_token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', app_key: config.credentials.app_key,
      app_secret: config.credentials.app_secret, refresh_token: config.credentials.refresh_token,
    }).toString(),
  }, 'JD.com authorization');
  if (!token.access_token) throw new Error('JD.com refresh returned incomplete credentials');
  if (token.xid && config.credentials.identity.xid && String(token.xid) !== String(config.credentials.identity.xid)) {
    throw new Error('JD.com refresh returned a different seller');
  }
  const identity = jdSellerIdentity(await jdRequestWithToken(
    config, token.access_token, 'jingdong.seller.vender.info.get',
  ));
  const venderId = String(identity.vender_id || identity.venderId || '');
  const shopId = String(identity.shop_id || identity.shopId || '');
  if (venderId !== String(config.credentials.identity.vender_id)
      || shopId !== String(config.credentials.identity.shop_id)) {
    throw new Error('JD.com refresh returned a different seller');
  }
  config.credentials = {
    ...config.credentials, access_token: token.access_token,
    refresh_token: token.refresh_token || config.credentials.refresh_token,
    expires_at: Date.now() + Math.max(60, Number(token.expires_in || 31_536_000)) * 1000,
    refresh_expires_at: token.refresh_token_expires_in
      ? Date.now() + Math.max(60, Number(token.refresh_token_expires_in)) * 1000
      : config.credentials.refresh_expires_at,
  };
  writeCredentialFile(config.credentialFile, config.credentialKey, config.credentials);
  return config.credentials.access_token;
}

const jdToken = credentialOperation(async function jdToken(config) {
  if (Number(config.credentials.expires_at || 0) > Date.now() + 300_000) return config.credentials.access_token;
  const key = config.credentialFile;
  if (jdRefreshes.has(key)) return jdRefreshes.get(key);
  const pending = refreshJdToken(config).finally(() => jdRefreshes.delete(key));
  jdRefreshes.set(key, pending);
  return pending;
});

async function jdRequest(config, method, parameters = {}) {
  return jdRequestWithToken(config, await jdToken(config), method, parameters);
}

const COMMERCE_SENSITIVE_FIELDS = new Set([
  'address', 'buyeraddress', 'buyeremail', 'buyerid', 'buyermemo', 'buyermobile', 'buyername',
  'buyerphone', 'buyerpin', 'consignee', 'consigneeaddress', 'consigneemail', 'consigneemobile',
  'consigneename', 'consigneephone', 'email', 'exchangeaddress', 'exchangemobile', 'exchangename',
  'exchangephone', 'idcard', 'identitycard', 'invoiceemail', 'invoicetitle', 'mobile', 'openid',
  'phone', 'receiver', 'receiveraddress', 'receiverinfo', 'receivermobile', 'receivername',
  'receiverphone', 'returnaddress', 'returnmobile', 'returnname', 'returnphone', 'xid',
]);

function minimizeCommerceSensitiveData(value) {
  if (Array.isArray(value)) return value.map(minimizeCommerceSensitiveData);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    return COMMERCE_SENSITIVE_FIELDS.has(normalized)
      || /^(?:buyer|consignee|receiver|exchange|return).*(?:address|email|idcard|mobile|name|phone|pin|openid|xid)$/.test(normalized)
      ? [] : [[key, minimizeCommerceSensitiveData(child)]];
  }));
}

function jdWareQuery(p) {
  return {
    pageNo: p.page || 1, pageSize: p.page_size || 20,
    ...(p.keyword ? { searchKey: p.keyword, searchField: ['title'] } : {}),
    ...(p.product_ids ? { wareIds: p.product_ids.map((id) => safeNumericId(id, 'product_id')) } : {}),
  };
}

const JD_ORDER_FIELDS = 'orderId,venderId,orderType,payType,totalOriginalPrice,totalSellerDiscount,totalSellerReceivable,shouldPay,actualPay,freightPrice,orderState,orderStartTime,orderEndTime,paymentConfirmTime,modified,itemInfoList';

async function executeJd(config, name, p) {
  if (name === 'account.get') return jdRequest(config, 'jingdong.seller.vender.info.get');
  if (name === 'products.list_valid' || name === 'products.list_recycled') {
    return jdRequest(config, name === 'products.list_valid'
      ? 'jingdong.ware.read.searchWare4Valid' : 'jingdong.ware.read.searchWare4Recycled', {
      wareQuery: jdWareQuery(p), field: 'wareId,title,itemNum,wareStatus,categoryId,brandId,marketPrice,jdPrice,modified',
    });
  }
  if (name === 'products.get') return jdRequest(config, 'jingdong.ware.read.findWareById', {
    wareId: safeNumericId(p.product_id, 'product_id'), field: 'wareId,title,itemNum,wareStatus,categoryId,brandId,marketPrice,jdPrice,modified',
  });
  if (name === 'skus.list') return jdRequest(config, 'jingdong.sku.read.searchSkuList', {
    skuQuery: {
      pageNo: p.page || 1, pageSize: p.page_size || 20,
      ...(p.product_ids ? { wareIds: p.product_ids.map((id) => safeNumericId(id, 'product_id')) } : {}),
      ...(p.sku_ids ? { skuIds: p.sku_ids.map((id) => safeNumericId(id, 'sku_id')) } : {}),
    }, field: 'skuId,wareId,status,outerId,jdPrice,stockNum,modified',
  });
  if (name === 'skus.get') return jdRequest(config, 'jingdong.sku.read.findSkuById', {
    skuId: safeNumericId(p.sku_id, 'sku_id'), field: 'skuId,wareId,status,outerId,jdPrice,stockNum,modified',
  });
  if (name === 'inventory.get') return jdRequest(config, 'jingdong.stock.read.findSkuStock', {
    skuIds: p.sku_ids.map((id) => safeNumericId(id, 'sku_id')),
  });
  if (name === 'orders.list') {
    const response = await jdRequest(config, 'jingdong.pop.order.search', { paramOrderJSFQuery: {
      order_state: p.order_state, optional_fields: JD_ORDER_FIELDS, page: p.page || 1, page_size: p.page_size || 20,
      ...(p.start_date ? { start_date: sellerDate(p.start_date, 'start_date') } : {}),
      ...(p.end_date ? { end_date: sellerDate(p.end_date, 'end_date') } : {}),
      ...(p.date_type !== undefined ? { dateType: p.date_type } : {}),
      ...(p.sort_type !== undefined ? { sortType: p.sort_type } : {}),
    } });
    return minimizeCommerceSensitiveData(response);
  }
  if (name === 'orders.get') {
    const response = await jdRequest(config, 'jingdong.pop.order.get', {
      orderId: safeNumericId(p.order_id, 'order_id'), optional_fields: JD_ORDER_FIELDS,
    });
    return minimizeCommerceSensitiveData(response);
  }
  if (name === 'refunds.list') return minimizeCommerceSensitiveData(await jdRequest(config, 'jingdong.pop.afs.soa.refundapply.queryPageList', {
    pageIndex: p.page || 1, pageSize: p.page_size || 20,
    ...(p.status !== undefined ? { status: p.status } : {}), ...(p.order_id ? { orderId: safeNumericId(p.order_id, 'order_id') } : {}),
  }));
  if (name === 'refunds.get') return minimizeCommerceSensitiveData(await jdRequest(config, 'jingdong.pop.afs.soa.refundapply.queryById', {
    id: safeNumericId(p.refund_id, 'refund_id'),
  }));
  if (name === 'refunds.waiting_count') return jdRequest(config, 'jingdong.pop.afs.soa.refundapply.getWaitRefundNum');
  if (name === 'orders.memo_update') return jdRequest(config, 'jingdong.pop.order.modifyVenderRemark', {
    orderId: safeNumericId(p.order_id, 'order_id'), remark: p.remark,
  });
  if (name === 'products.recover') return jdRequest(config, 'jingdong.ware.write.recoverWare', { wareId: safeNumericId(p.product_id, 'product_id') });
  if (name === 'inventory.set') return jdRequest(config, 'jingdong.ware.stock.sku.set', { req: {
    updateModel: p.update_mode === 'absolute' ? 'fullStockIn' : 'incrStockIn', stockRfId: p.stock_reference_id,
    skuStocks: p.sku_stocks.map((stock) => ({
      skuId: safeNumericId(stock.sku_id, 'sku_id'),
      ...(p.update_mode === 'absolute' ? { stockNum: stock.stock } : { incrStockNum: stock.stock }),
      ...(stock.store_id ? { storeId: safeNumericId(stock.store_id, 'store_id') } : {}),
      ...(stock.stock_model ? { stockModel: stock.stock_model } : {}),
    })),
  } });
  if (name === 'prices.update') return jdRequest(config, 'jingdong.price.write.updateSkuJdPrice', {
    skuPriceSetParam: { skuId: safeNumericId(p.sku_id, 'sku_id'), jdPrice: p.price_yuan },
  });
  if (name === 'products.publish' || name === 'products.unpublish') return jdRequest(config, 'jingdong.ware.write.upOrDown', {
    wareStatusChange: { wareId: safeNumericId(p.product_id, 'product_id'), ...(p.reason ? { opReason: p.reason } : {}) },
    opType: name === 'products.publish' ? 1 : 2,
  });
  if (name === 'products.title_update') return jdRequest(config, 'jingdong.ware.write.updateWareTitle', {
    wareId: safeNumericId(p.product_id, 'product_id'), title: p.title,
  });
  if (name === 'shipments.create' || name === 'shipments.update') return jdRequest(config,
    name === 'shipments.create' ? 'jingdong.pop.order.shipment' : 'jingdong.pop.order.sop.logistics.update', {
      orderId: safeNumericId(p.order_id, 'order_id'), logisticsId: safeNumericId(p.logistics_id, 'logistics_id'), waybill: p.waybill,
    });
  if (name === 'refunds.decide') {
    if (p.status === 2 && p.reject_type === undefined) throw new Error('reject_type is required when rejecting a JD.com refund');
    return jdRequest(config, 'jingdong.pop.afs.soa.refundapply.replyRefund', { replyParam: {
      id: safeNumericId(p.refund_id, 'refund_id'), status: p.status, checkUserName: p.operator_name,
      ...(p.remark ? { remark: p.remark } : {}), ...(p.reject_type !== undefined ? { rejectType: p.reject_type } : {}),
      ...(p.out_ware_status !== undefined ? { outWareStatus: p.out_ware_status } : {}),
    } });
  }
  if (name === 'products.delete') return jdRequest(config, 'jingdong.ware.write.delete', { wareId: safeNumericId(p.product_id, 'product_id') });
  throw new Error('unsupported JD.com action');
}

const pinduoduoRefreshes = new Map();

function encodePinduoduoParameter(value) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function signPinduoduo(parameters, clientSecret) {
  const message = clientSecret + Object.keys(parameters).sort()
    .map((key) => `${key}${encodePinduoduoParameter(parameters[key])}`).join('') + clientSecret;
  return createHash('md5').update(message, 'utf8').digest('hex').toUpperCase();
}

async function pinduoduoRequestWithToken(config, accessToken, type, parameters = {}) {
  const form = {
    type, client_id: config.credentials.client_id, timestamp: String(Math.floor(Date.now() / 1000)), data_type: 'JSON',
    ...(accessToken ? { access_token: accessToken } : {}), ...parameters,
  };
  form.sign = signPinduoduo(form, config.credentials.client_secret);
  const body = await fetchStatusOnlyJson('https://gw-api.pinduoduo.com/api/router', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8', accept: 'application/json' },
    body: new URLSearchParams(Object.fromEntries(
      Object.entries(form).map(([key, value]) => [key, encodePinduoduoParameter(value)]),
    )).toString(),
  }, 'Pinduoduo');
  if (body?.error_response) {
    throw new Error(`Pinduoduo request failed (provider code ${String(body.error_response.error_code || 'unknown').slice(0, 40)})`);
  }
  return body;
}

async function refreshPinduoduoToken(config) {
  const response = await pinduoduoRequestWithToken(config, '', 'pdd.pop.auth.token.refresh', {
    refresh_token: config.credentials.refresh_token,
  });
  const token = response.pop_auth_token_refresh_response || response;
  if (!token.access_token) throw new Error('Pinduoduo refresh returned incomplete credentials');
  if (token.owner_id && String(token.owner_id) !== String(config.credentials.identity.mall_id)) {
    throw new Error('Pinduoduo refresh returned a different merchant');
  }
  const identityResponse = await pinduoduoRequestWithToken(config, token.access_token, 'pdd.mall.info.get');
  if (String(identityResponse?.mall_info_get_response?.mall_id || '') !== String(config.credentials.identity.mall_id)) {
    throw new Error('Pinduoduo refresh returned a different merchant');
  }
  config.credentials = {
    ...config.credentials, access_token: token.access_token,
    refresh_token: token.refresh_token || config.credentials.refresh_token,
    scope: Array.isArray(token.scope) ? token.scope : config.credentials.scope,
    expires_at: Date.now() + Math.max(60, Number(token.expires_in || 86_400)) * 1000,
    refresh_expires_at: token.refresh_token_expires_in
      ? Date.now() + Math.max(60, Number(token.refresh_token_expires_in)) * 1000
      : config.credentials.refresh_expires_at,
  };
  writeCredentialFile(config.credentialFile, config.credentialKey, config.credentials);
  return config.credentials.access_token;
}

const pinduoduoToken = credentialOperation(async function pinduoduoToken(config) {
  if (Number(config.credentials.expires_at || 0) > Date.now() + 300_000) return config.credentials.access_token;
  const key = config.credentialFile;
  if (pinduoduoRefreshes.has(key)) return pinduoduoRefreshes.get(key);
  const pending = refreshPinduoduoToken(config).finally(() => pinduoduoRefreshes.delete(key));
  pinduoduoRefreshes.set(key, pending);
  return pending;
});

async function pinduoduoRequest(config, type, parameters = {}) {
  return pinduoduoRequestWithToken(config, await pinduoduoToken(config), type, parameters);
}

function pinduoduoWindow(start, end, maxSeconds, label) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start || end - start > maxSeconds) {
    throw new Error(`invalid Pinduoduo ${label} window`);
  }
}

async function executePinduoduo(config, name, p) {
  if (name === 'account.get') return pinduoduoRequest(config, 'pdd.mall.info.get');
  if (name === 'products.list') return pinduoduoRequest(config, 'pdd.goods.list.get', {
    page: p.page || 1, page_size: p.page_size || 20,
    ...(p.keyword ? { goods_name: p.keyword } : {}), ...(p.outer_id ? { outer_id: p.outer_id } : {}),
    ...(p.outer_goods_id ? { outer_goods_id: p.outer_goods_id } : {}),
    ...(p.is_on_sale !== undefined ? { is_onsale: p.is_on_sale ? 1 : 0 } : {}),
    ...(p.cost_template_id ? { cost_template_id: safeNumericId(p.cost_template_id, 'cost_template_id') } : {}),
  });
  if (name === 'products.get') return pinduoduoRequest(config, 'pdd.goods.detail.get', { goods_id: safeNumericId(p.product_id, 'product_id') });
  if (name === 'orders.list_basic') {
    pinduoduoWindow(p.start_confirmed_at, p.end_confirmed_at, 86_400, 'order confirmation');
    const response = await pinduoduoRequest(config, 'pdd.order.basic.list.get', {
      start_confirm_at: p.start_confirmed_at, end_confirm_at: p.end_confirmed_at,
      order_status: p.order_status, page: p.page || 1, page_size: p.page_size || 20,
      ...(p.refund_status !== undefined ? { refund_status: p.refund_status } : {}),
      ...(p.trade_type !== undefined ? { trade_type: p.trade_type } : {}),
      ...(p.use_has_next !== undefined ? { use_has_next: p.use_has_next } : {}),
    });
    return minimizeCommerceSensitiveData(response);
  }
  if (name === 'orders.status') return minimizeCommerceSensitiveData(await pinduoduoRequest(config, 'pdd.order.status.get', {
    order_sns: p.order_ids.map((id) => safeNumericId(id, 'order_id')).join(','),
  }));
  if (name === 'logistics.companies') return pinduoduoRequest(config, 'pdd.logistics.companies.get');
  if (name === 'refunds.list') {
    pinduoduoWindow(p.start_updated_at, p.end_updated_at, 1_800, 'refund update');
    return minimizeCommerceSensitiveData(await pinduoduoRequest(config, 'pdd.refund.list.increment.get', {
      after_sales_status: p.after_sales_status, after_sales_type: p.after_sales_type,
      start_updated_at: p.start_updated_at, end_updated_at: p.end_updated_at,
      page: p.page || 1, page_size: p.page_size || 100,
      ...(p.order_id ? { order_sn: safeNumericId(p.order_id, 'order_id') } : {}),
    }));
  }
  if (name === 'refunds.get') return minimizeCommerceSensitiveData(await pinduoduoRequest(config, 'pdd.refund.information.get', {
    order_sn: safeNumericId(p.order_id, 'order_id'),
    ...(p.after_sales_id ? { after_sales_id: safeNumericId(p.after_sales_id, 'after_sales_id') } : {}),
  }));
  if (name === 'refunds.return_addresses') return minimizeCommerceSensitiveData(
    await pinduoduoRequest(config, 'pdd.refund.address.list.get'),
  );
  if (name === 'orders.note_update') {
    if ((p.tag === undefined) !== (p.tag_name === undefined)) throw new Error('tag and tag_name must be supplied together');
    return pinduoduoRequest(config, 'pdd.order.note.update', {
      order_sn: safeNumericId(p.order_id, 'order_id'), note: p.note,
      ...(p.tag !== undefined ? { tag: p.tag, tag_name: p.tag_name } : {}),
    });
  }
  if (name === 'inventory.update') {
    if (!p.sku_id && !p.outer_id) throw new Error('sku_id or outer_id is required');
    if (p.mode === 'absolute' && p.quantity < 0) throw new Error('absolute inventory cannot be negative');
    return pinduoduoRequest(config, 'pdd.goods.quantity.update', {
      goods_id: safeNumericId(p.product_id, 'product_id'), quantity: p.quantity, update_type: p.mode === 'absolute' ? 1 : 2,
      ...(p.sku_id ? { sku_id: safeNumericId(p.sku_id, 'sku_id') } : {}), ...(p.outer_id ? { outer_id: p.outer_id } : {}),
    });
  }
  if (name === 'prices.update') return pinduoduoRequest(config, 'pdd.goods.sku.price.update', {
    goods_id: safeNumericId(p.product_id, 'product_id'),
    ...(p.market_price_fen !== undefined ? { market_price: p.market_price_fen } : {}),
    sku_price_list: p.sku_prices.map((price) => ({
      sku_id: safeNumericId(price.sku_id, 'sku_id'), ...(price.group_price_fen !== undefined ? { group_price: price.group_price_fen } : {}),
      ...(price.single_price_fen !== undefined ? { single_price: price.single_price_fen } : {}),
      ...(price.is_on_sale !== undefined ? { is_onsale: price.is_on_sale ? 1 : 0 } : {}),
    })),
  });
  if (name === 'products.publish' || name === 'products.unpublish') return pinduoduoRequest(config, 'pdd.goods.sale.status.set', {
    goods_id: safeNumericId(p.product_id, 'product_id'), is_onsale: name === 'products.publish' ? 1 : 0,
  });
  if (name === 'shipments.send' || name === 'shipments.update') return pinduoduoRequest(config, 'pdd.logistics.online.send', {
    order_sn: safeNumericId(p.order_id, 'order_id'), logistics_id: safeNumericId(p.logistics_id, 'logistics_id'),
    tracking_number: p.tracking_number, redelivery_type: name === 'shipments.send' ? 1 : 2,
    ...(p.refund_address_id ? { refund_address_id: safeNumericId(p.refund_address_id, 'refund_address_id') } : {}),
  });
  if (name === 'refunds.approve') return pinduoduoRequest(config, 'pdd.refund.agree', { request: {
    order_sn: safeNumericId(p.order_id, 'order_id'), after_sales_id: safeNumericId(p.after_sales_id, 'after_sales_id'),
    ...(p.description ? { operate_desc: p.description } : {}),
  } });
  if (name === 'refunds.return_approve') return pinduoduoRequest(config, 'pdd.refund.returngoods.agree', { request: {
    order_sn: safeNumericId(p.order_id, 'order_id'), after_sales_id: safeNumericId(p.after_sales_id, 'after_sales_id'),
    return_address_id: safeNumericId(p.return_address_id, 'return_address_id'), operate_desc: p.description || '',
  } });
  if (name === 'refunds.exchange_ship') return pinduoduoRequest(config, 'pdd.refund.exchange.shipping', { request: {
    order_sn: safeNumericId(p.order_id, 'order_id'), after_sales_id: safeNumericId(p.after_sales_id, 'after_sales_id'),
    shipping_id: safeNumericId(p.logistics_id, 'logistics_id'), shipping_name: p.logistics_name, tracking_number: p.tracking_number,
  } });
  if (name === 'products.delete') return pinduoduoRequest(config, 'pdd.delete.goods.commit', {
    goods_ids: p.product_ids.map((id) => safeNumericId(id, 'product_id')),
  });
  throw new Error('unsupported Pinduoduo action');
}

function sortCommerceJson(value) {
  if (Array.isArray(value)) return value.map(sortCommerceJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortCommerceJson(value[key])]));
}

function stableCommerceJson(value) {
  return JSON.stringify(sortCommerceJson(value));
}

function platformExpiryMs(value, fallbackSeconds) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return Date.now() + fallbackSeconds * 1000;
  return numeric >= 1_000_000_000 ? numeric * 1000 : Date.now() + numeric * 1000;
}

function safePlatformNumericId(value, name = 'id') {
  const id = String(value || '');
  if (!/^[1-9][0-9]{0,24}$/.test(id)) throw new Error(`invalid ${name}`);
  return id;
}

const douyinRefreshes = new Map();

function signDouyin(appKey, method, paramJson, timestamp, appSecret) {
  const message = `app_key${appKey}method${method}param_json${paramJson}timestamp${timestamp}v2`;
  return createHmac('sha256', appSecret)
    .update(`${appSecret}${message}${appSecret}`, 'utf8').digest('hex');
}

async function douyinRequestWithToken(config, accessToken, pathName, method, parameters = {}) {
  const timestamp = chinaTimestamp();
  const paramJson = stableCommerceJson(parameters);
  const query = {
    app_key: config.credentials.app_key, method, param_json: paramJson,
    timestamp, v: '2', sign_method: 'hmac-sha256',
    sign: signDouyin(config.credentials.app_key, method, paramJson, timestamp, config.credentials.app_secret),
    ...(accessToken ? { access_token: accessToken } : {}),
  };
  const body = await fetchStatusOnlyJson(
    `https://openapi-fxg.jinritemai.com${pathName}?${new URLSearchParams(query)}`,
    {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: paramJson,
    },
    'Douyin Shop',
  );
  if (body?.code !== undefined && Number(body.code) !== 10000) {
    throw new Error(`Douyin Shop request failed (provider code ${String(body.code).slice(0, 40)})`);
  }
  return body?.data ?? body;
}

async function refreshDouyinToken(config) {
  const token = await douyinRequestWithToken(config, '', '/token/refresh', 'token.refresh', {
    grant_type: 'refresh_token', refresh_token: config.credentials.refresh_token,
  });
  if (!token.access_token || !token.refresh_token) throw new Error('Douyin Shop refresh returned incomplete credentials');
  if (token.shop_id && String(token.shop_id) !== String(config.credentials.identity.shop_id)) {
    throw new Error('Douyin Shop refresh returned a different shop');
  }
  const identity = await douyinRequestWithToken(config, '', '/open/getAuthInfo', 'open.getAuthInfo', {
    auth_id: config.credentials.identity.shop_id, auth_subject_type: 'shop',
  });
  if (String(identity.auth_id || identity.shop_id || '') !== String(config.credentials.identity.shop_id)
      || Number(identity.status) !== 1) {
    throw new Error('Douyin Shop refresh returned an inactive or different shop');
  }
  config.credentials = {
    ...config.credentials, access_token: token.access_token, refresh_token: token.refresh_token,
    scope: token.scope || config.credentials.scope,
    expires_at: platformExpiryMs(token.expires_in, 7 * 86_400),
    refresh_expires_at: platformExpiryMs(token.refresh_expires_in, 14 * 86_400),
  };
  writeCredentialFile(config.credentialFile, config.credentialKey, config.credentials);
  return config.credentials.access_token;
}

const douyinToken = credentialOperation(async function douyinToken(config) {
  if (Number(config.credentials.expires_at || 0) > Date.now() + 300_000) return config.credentials.access_token;
  const key = config.credentialFile;
  if (douyinRefreshes.has(key)) return douyinRefreshes.get(key);
  const pending = refreshDouyinToken(config).finally(() => douyinRefreshes.delete(key));
  douyinRefreshes.set(key, pending);
  return pending;
});

async function douyinRequest(config, pathName, method, parameters = {}, needsAccessToken = true) {
  const accessToken = needsAccessToken ? await douyinToken(config) : '';
  return douyinRequestWithToken(config, accessToken, pathName, method, parameters);
}

async function executeDouyinShop(config, name, p) {
  if (name === 'account.get') return douyinRequest(config, '/open/getAuthInfo', 'open.getAuthInfo', {
    auth_id: config.credentials.identity.shop_id, auth_subject_type: 'shop',
  }, false);
  if (name === 'products.list') return douyinRequest(config, '/product/listV2', 'product.listV2', p.query || {});
  if (name === 'products.get') return douyinRequest(config, '/product/detail', 'product.detail', {
    product_id: safePlatformNumericId(p.product_id, 'product_id'),
  });
  if (name === 'skus.list') return douyinRequest(config, '/sku/list', 'sku.list', {
    product_id: safePlatformNumericId(p.product_id, 'product_id'),
  });
  if (name === 'skus.get') return douyinRequest(config, '/sku/detail', 'sku.detail', {
    product_id: safePlatformNumericId(p.product_id, 'product_id'),
    sku_id: safePlatformNumericId(p.sku_id, 'sku_id'),
  });
  if (name === 'inventory.get') return douyinRequest(config, '/sku/stockNum', 'sku.stockNum', {
    sku_id: safePlatformNumericId(p.sku_id, 'sku_id'),
  });
  if (name === 'orders.list') return minimizeCommerceSensitiveData(
    await douyinRequest(config, '/order/searchList', 'order.searchList', p.query || {}),
  );
  if (name === 'orders.get') return minimizeCommerceSensitiveData(await douyinRequest(
    config, '/order/orderDetail', 'order.orderDetail', { shop_order_id: safePlatformNumericId(p.order_id, 'order_id') },
  ));
  if (name === 'refunds.list') return minimizeCommerceSensitiveData(
    await douyinRequest(config, '/afterSale/List', 'afterSale.List', p.query || {}),
  );
  if (name === 'refunds.get') return minimizeCommerceSensitiveData(await douyinRequest(
    config, '/afterSale/Detail', 'afterSale.Detail', { after_sale_id: safePlatformNumericId(p.after_sale_id, 'after_sale_id') },
  ));
  if (name === 'refunds.reject_reasons') return douyinRequest(
    config, '/afterSale/rejectReasonCodeList', 'afterSale.rejectReasonCodeList',
    { after_sale_id: safePlatformNumericId(p.after_sale_id, 'after_sale_id') },
  );
  if (name === 'orders.memo_update') return douyinRequest(config, '/order/addOrderRemark', 'order.addOrderRemark', {
    order_id: safePlatformNumericId(p.order_id, 'order_id'), remark: p.remark,
  });
  if (name === 'products.create') return douyinRequest(config, '/product/addV2', 'product.addV2', p.payload);
  if (name === 'products.update') return douyinRequest(config, '/product/editV2', 'product.editV2', {
    ...p.payload, product_id: safePlatformNumericId(p.product_id, 'product_id'),
  });
  if (name === 'inventory.update') return douyinRequest(config, '/sku/syncStock', 'sku.syncStock', {
    product_id: safePlatformNumericId(p.product_id, 'product_id'),
    sku_id: safePlatformNumericId(p.sku_id, 'sku_id'), stock_num: p.quantity,
  });
  if (name === 'prices.update') return douyinRequest(config, '/sku/editPrice', 'sku.editPrice', {
    product_id: safePlatformNumericId(p.product_id, 'product_id'),
    sku_id: safePlatformNumericId(p.sku_id, 'sku_id'), price: p.price_fen,
  });
  if (name === 'products.publish' || name === 'products.unpublish') return douyinRequest(
    config,
    name === 'products.publish' ? '/product/launchProduct' : '/product/setOffline',
    name === 'products.publish' ? 'product.launchProduct' : 'product.setOffline',
    { product_id: safePlatformNumericId(p.product_id, 'product_id') },
  );
  if (name === 'shipments.send' || name === 'shipments.update') return douyinRequest(
    config,
    name === 'shipments.send' ? '/order/logisticsAdd' : '/order/logisticsEdit',
    name === 'shipments.send' ? 'order.logisticsAdd' : 'order.logisticsEdit',
    { ...p.payload, order_id: safePlatformNumericId(p.order_id, 'order_id') },
  );
  if (name === 'refunds.decide') return douyinRequest(config, '/afterSale/operate', 'afterSale.operate', {
    ...(p.payload || {}), after_sale_id: safePlatformNumericId(p.after_sale_id, 'after_sale_id'),
  });
  if (name === 'products.delete') return douyinRequest(config, '/product/del', 'product.del', {
    product_id: safePlatformNumericId(p.product_id, 'product_id'),
  });
  throw new Error('unsupported Douyin Shop action');
}

const kuaishouRefreshes = new Map();
const KUAISHOU_REQUIRED_SCOPES = [
  'user_base', 'user_info', 'merchant_user', 'merchant_item',
  'merchant_order', 'merchant_refund', 'merchant_logistics',
];

function signKuaishou(parameters, signSecret) {
  const message = Object.keys(parameters).sort()
    .map((key) => `${key}=${parameters[key]}`).join('&') + `&signSecret=${signSecret}`;
  return createHmac('sha256', signSecret).update(message, 'utf8').digest('hex');
}

async function kuaishouRequestWithToken(config, accessToken, method, parameters = {}, httpMethod = 'GET') {
  const common = {
    appkey: config.credentials.app_key, method, version: '1',
    param: stableCommerceJson(parameters), access_token: accessToken,
    timestamp: String(Date.now()), signMethod: 'HMAC_SHA256',
  };
  common.sign = signKuaishou(common, config.credentials.sign_secret);
  const pathName = `/${method.split('.').join('/')}`;
  const init = {
    method: httpMethod, headers: { accept: 'application/json' },
  };
  let url = `https://openapi.kwaixiaodian.com${pathName}`;
  if (httpMethod === 'GET') url += `?${new URLSearchParams(common)}`;
  else {
    init.headers['content-type'] = 'application/x-www-form-urlencoded';
    init.body = new URLSearchParams(common).toString();
  }
  const body = await fetchStatusOnlyJson(url, init, 'Kuaishou Shop');
  if (body?.result !== undefined && Number(body.result) !== 1
      && String(body.result).toLowerCase() !== 'success') {
    throw new Error(`Kuaishou Shop request failed (provider result ${String(body.result).slice(0, 40)})`);
  }
  return body?.data ?? body;
}

async function refreshKuaishouToken(config) {
  const body = await fetchStatusOnlyJson('https://openapi.kwaixiaodian.com/oauth2/refresh_token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: config.credentials.refresh_token,
      app_id: config.credentials.app_key, app_secret: config.credentials.app_secret,
    }).toString(),
  }, 'Kuaishou Shop');
  const token = body?.data ?? body;
  if (!token.access_token || !token.refresh_token) throw new Error('Kuaishou Shop refresh returned incomplete credentials');
  if (token.open_id && String(token.open_id) !== String(config.credentials.identity.open_id)) {
    throw new Error('Kuaishou Shop refresh returned a different seller');
  }
  const granted = new Set(String(token.scope || config.credentials.scope || '').split(/[ ,]+/).filter(Boolean));
  const missing = KUAISHOU_REQUIRED_SCOPES.filter((scope) => !granted.has(scope));
  if (missing.length) throw new Error(`Kuaishou Shop authorization is missing required scopes: ${missing.join(', ')}`);
  const seller = await kuaishouRequestWithToken(config, token.access_token, 'open.user.seller.get');
  const shop = await kuaishouRequestWithToken(config, token.access_token, 'open.shop.info.get');
  if ((seller.open_id || seller.openId)
      && String(seller.open_id || seller.openId) !== String(config.credentials.identity.open_id)) {
    throw new Error('Kuaishou Shop refresh returned a different seller');
  }
  if (String(shop.shop_id || shop.shopId || shop.id || '') !== String(config.credentials.identity.shop_id)) {
    throw new Error('Kuaishou Shop refresh returned a different shop');
  }
  config.credentials = {
    ...config.credentials, access_token: token.access_token, refresh_token: token.refresh_token,
    scope: token.scope || config.credentials.scope,
    expires_at: platformExpiryMs(token.expires_in, 48 * 60 * 60),
    refresh_expires_at: platformExpiryMs(token.refresh_token_expires_in, 180 * 86_400),
  };
  writeCredentialFile(config.credentialFile, config.credentialKey, config.credentials);
  return config.credentials.access_token;
}

const kuaishouToken = credentialOperation(async function kuaishouToken(config) {
  if (Number(config.credentials.expires_at || 0) > Date.now() + 300_000) return config.credentials.access_token;
  const key = config.credentialFile;
  if (kuaishouRefreshes.has(key)) return kuaishouRefreshes.get(key);
  const pending = refreshKuaishouToken(config).finally(() => kuaishouRefreshes.delete(key));
  kuaishouRefreshes.set(key, pending);
  return pending;
});

async function kuaishouRequest(config, method, parameters = {}, httpMethod = 'GET') {
  return kuaishouRequestWithToken(config, await kuaishouToken(config), method, parameters, httpMethod);
}

function assertKuaishouWindow(begin, end, maxMs, label) {
  if (!Number.isInteger(begin) || !Number.isInteger(end) || end < begin || end - begin > maxMs) {
    throw new Error(`invalid Kuaishou Shop ${label} window`);
  }
  if (begin < Date.now() - 90 * 86_400_000 - 60_000 || end > Date.now() + 60_000) {
    throw new Error(`Kuaishou Shop ${label} window must be within the most recent 90 days`);
  }
}

async function executeKuaishouShop(config, name, p) {
  if (name === 'account.get') return {
    seller: await kuaishouRequest(config, 'open.user.seller.get'),
    shop: await kuaishouRequest(config, 'open.shop.info.get'),
  };
  if (name === 'products.list') return kuaishouRequest(config, 'open.item.list.get', {
    ...(p.item_id ? { kwaiItemId: safePlatformNumericId(p.item_id, 'item_id') } : {}),
    ...(p.external_item_id ? { relItemId: p.external_item_id } : {}),
    pageNumber: p.page || 1, pageSize: p.page_size || 20,
    ...(p.item_status !== undefined ? { itemStatus: p.item_status } : {}),
    ...(p.item_type !== undefined ? { itemType: p.item_type } : {}),
    ...(p.on_offline_status !== undefined ? { onOfflineStatus: p.on_offline_status } : {}),
    ...(p.support_negative_stock !== undefined ? { supportNegativeStock: p.support_negative_stock } : {}),
  });
  if (name === 'products.get') return kuaishouRequest(config, 'open.item.get', {
    kwaiItemId: safePlatformNumericId(p.item_id, 'item_id'),
    ...(p.support_negative_stock !== undefined ? { supportNegativeStock: p.support_negative_stock } : {}),
  });
  if (name === 'skus.list') return kuaishouRequest(config, 'open.item.sku.list.get', {
    kwaiItemId: safePlatformNumericId(p.item_id, 'item_id'),
    ...(p.external_sku_id ? { relSkuId: p.external_sku_id } : {}),
    ...(p.sku_status !== undefined ? { skuStatus: p.sku_status } : {}),
  });
  if (name === 'orders.list') {
    assertKuaishouWindow(p.begin_time, p.end_time, 7 * 86_400_000, 'order');
    return minimizeCommerceSensitiveData(await kuaishouRequest(config, 'open.order.cursor.list', {
      pcursor: p.cursor || '', queryType: p.query_type, beginTime: p.begin_time, endTime: p.end_time,
      pageSize: p.page_size || 50, sort: p.sort || 1,
      ...(p.order_view_status !== undefined ? { orderViewStatus: p.order_view_status } : {}),
      ...(p.cps_type !== undefined ? { cpsType: p.cps_type } : {}),
    }));
  }
  if (name === 'orders.get') return minimizeCommerceSensitiveData(await kuaishouRequest(config, 'open.order.detail', {
    oid: safePlatformNumericId(p.order_id, 'order_id'),
  }));
  if (name === 'refunds.list') {
    assertKuaishouWindow(p.begin_time, p.end_time, 86_400_000, 'refund');
    return minimizeCommerceSensitiveData(await kuaishouRequest(config, 'open.seller.order.refund.pcursor.list', {
      pcursor: p.cursor || '', currentPage: p.page || 1, pageSize: p.page_size || 100,
      sort: p.sort || 1, queryType: p.query_type, beginTime: p.begin_time, endTime: p.end_time,
      ...(p.refund_type !== undefined ? { type: p.refund_type } : {}),
      ...(p.negotiate_status !== undefined ? { negotiateStatus: p.negotiate_status } : {}),
      ...(p.status !== undefined ? { status: p.status } : {}),
      ...(p.order_id ? { orderId: safePlatformNumericId(p.order_id, 'order_id') } : {}),
    }));
  }
  if (name === 'refunds.get') return minimizeCommerceSensitiveData(await kuaishouRequest(
    config, 'open.seller.order.refund.detail', { refundId: safePlatformNumericId(p.refund_id, 'refund_id') },
  ));
  if (name === 'refunds.reject_reasons') return kuaishouRequest(
    config, 'open.refund.reject.reason', { refundId: safePlatformNumericId(p.refund_id, 'refund_id') },
  );
  if (name === 'addresses.list') return minimizeCommerceSensitiveData(await kuaishouRequest(
    config, 'open.address.seller.list', { addressType: p.address_type },
  ));
  if (name === 'products.create') return kuaishouRequest(config, 'open.item.new', p.payload, 'POST');
  if (name === 'products.update') return kuaishouRequest(config, 'open.item.edit', {
    ...p.payload, kwaiItemId: safePlatformNumericId(p.item_id, 'item_id'),
  }, 'POST');
  if (name === 'products.publish' || name === 'products.unpublish') return kuaishouRequest(
    config, 'open.item.shelf.status.update', {
      kwaiItemId: safePlatformNumericId(p.item_id, 'item_id'),
      shelfStatus: name === 'products.publish' ? 1 : 0,
    }, 'POST',
  );
  if (name === 'inventory.update') return kuaishouRequest(config, 'open.item.sku.stock.update', {
    kwaiItemId: safePlatformNumericId(p.item_id, 'item_id'),
    skuId: safePlatformNumericId(p.sku_id, 'sku_id'), skuChangeStock: p.quantity, changeType: p.change_type,
  }, 'POST');
  if (name === 'prices.update') return kuaishouRequest(config, 'open.item.sku.price.update', {
    itemId: safePlatformNumericId(p.item_id, 'item_id'),
    skuId: safePlatformNumericId(p.sku_id, 'sku_id'), price: p.price_fen,
  }, 'POST');
  if (name === 'shipments.send') return kuaishouRequest(config, 'open.seller.order.goods.deliver', {
    orderId: safePlatformNumericId(p.order_id, 'order_id'), expressCode: p.express_code,
    expressNo: p.tracking_number,
    ...(p.return_address_id ? { returnAddressId: safePlatformNumericId(p.return_address_id, 'return_address_id') } : {}),
    ...(p.serial_numbers ? { serialNumberList: p.serial_numbers } : {}),
    ...(p.imeis ? { imeiList: p.imeis } : {}),
  }, 'POST');
  if (name === 'shipments.update') return kuaishouRequest(config, 'open.seller.order.logistics.update', {
    orderId: safePlatformNumericId(p.order_id, 'order_id'), expressCode: p.express_code,
    expressNo: p.tracking_number,
    ...(p.logistics_id ? { logisticsId: safePlatformNumericId(p.logistics_id, 'logistics_id') } : {}),
  }, 'POST');
  if (name === 'refunds.approve') return kuaishouRequest(config, 'open.seller.order.refund.approve', {
    refundId: safePlatformNumericId(p.refund_id, 'refund_id'), refundAmount: p.refund_amount_fen,
    ...(p.status !== undefined ? { status: p.status } : {}),
    ...(p.negotiate_status !== undefined ? { negotiateStatus: p.negotiate_status } : {}),
    ...(p.handling_way !== undefined ? { refundHandingWay: p.handling_way } : {}),
  }, 'POST');
  if (name === 'refunds.reject') return kuaishouRequest(config, 'open.refund.reject', {
    refundId: safePlatformNumericId(p.refund_id, 'refund_id'), reasonCode: p.reason_code,
    refundVersion: p.refund_version,
    ...(p.description ? { rejectDesc: p.description } : {}),
    ...(p.image_urls ? { rejectImages: p.image_urls } : {}),
    ...(p.handling_way !== undefined ? { editHandlingWay: p.handling_way } : {}),
    ...(p.return_address_id ? { editReturnAddressId: safePlatformNumericId(p.return_address_id, 'return_address_id') } : {}),
  }, 'POST');
  if (name === 'refunds.return_approve') return kuaishouRequest(
    config, 'open.seller.order.refund.returngoods.approve', {
      refundId: safePlatformNumericId(p.refund_id, 'refund_id'), refundAmount: p.refund_amount_fen,
      ...(p.address_id ? { addressId: safePlatformNumericId(p.address_id, 'address_id') } : {}),
    }, 'POST',
  );
  if (name === 'products.delete') return kuaishouRequest(config, 'open.item.delete', {
    kwaiItemId: safePlatformNumericId(p.item_id, 'item_id'),
    ...(p.external_item_id ? { relItemId: p.external_item_id } : {}),
  }, 'POST');
  throw new Error('unsupported Kuaishou Shop action');
}

const youzanRefreshes = new Map();
const weimobRefreshes = new Map();

function youzanExpiresAt(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return Date.now() + 7 * 86_400_000;
  if (numeric >= 1_000_000_000_000) return numeric;
  if (numeric >= 1_000_000_000) return numeric * 1000;
  return Date.now() + numeric * 1000;
}

async function youzanTokenRequest(config, refresh) {
  const body = await fetchStatusOnlyJson('https://open.youzanyun.com/auth/token', {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_id: config.credentials.client_id, client_secret: config.credentials.client_secret,
      authorize_type: 'silent', grant_id: safePlatformNumericId(config.metadata.kdt_id, 'kdt_id'),
      refresh: Boolean(refresh),
    }),
  }, 'Youzan token');
  const token = body?.data ?? body;
  if (!token?.access_token || String(token.authority_id || '') !== String(config.metadata.kdt_id)) {
    throw new Error('Youzan token returned incomplete credentials or a different shop');
  }
  return token;
}

async function youzanRequestWithToken(config, accessToken, method, version, parameters = {}) {
  if (!/^youzan\.[a-z0-9_.]{1,120}$/.test(method) || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error('invalid reviewed Youzan API destination');
  }
  const url = new URL(`https://open.youzanyun.com/api/${method}/${version}`);
  url.searchParams.set('access_token', accessToken);
  const body = await fetchStatusOnlyJson(url, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(parameters),
  }, 'Youzan');
  if (body?.success === false || (body?.code !== undefined && Number(body.code) !== 200)) {
    throw new Error(`Youzan request failed (provider code ${String(body.code || 'unknown').slice(0, 40)})`);
  }
  return body?.data ?? body;
}

async function refreshYouzanToken(config) {
  const token = await youzanTokenRequest(config, true);
  config.credentials = {
    ...config.credentials, access_token: token.access_token,
    expires_at: youzanExpiresAt(token.expires), scope: token.scope || config.credentials.scope || [],
  };
  writeCredentialFile(config.credentialFile, config.credentialKey, config.credentials);
  return config.credentials.access_token;
}

const youzanToken = credentialOperation(async function youzanToken(config) {
  if (Number(config.credentials.expires_at || 0) > Date.now() + 300_000) return config.credentials.access_token;
  const key = config.credentialFile;
  if (youzanRefreshes.has(key)) return youzanRefreshes.get(key);
  const pending = refreshYouzanToken(config).finally(() => youzanRefreshes.delete(key));
  youzanRefreshes.set(key, pending);
  return pending;
});

async function youzanRequest(config, method, version, parameters = {}) {
  return youzanRequestWithToken(config, await youzanToken(config), method, version, parameters);
}

async function executeYouzan(config, name, p) {
  if (name === 'account.get') return youzanRequest(config, 'youzan.shop.get', '3.0.0');
  if (name === 'products.list_on_sale') return youzanRequest(config, 'youzan.items.onsale.get', '3.0.0', p.query || {});
  if (name === 'products.list_inventory') return youzanRequest(config, 'youzan.items.inventory.get', '3.0.0', p.query || {});
  if (name === 'products.get') return youzanRequest(config, 'youzan.item.get', '3.0.0', {
    item_id: safePlatformNumericId(p.item_id, 'item_id'),
  });
  if (name === 'orders.list') return minimizeCommerceSensitiveData(await youzanRequest(
    config, 'youzan.trades.sold.get', '4.0.0', p.query || {},
  ));
  if (name === 'orders.get') return minimizeCommerceSensitiveData(await youzanRequest(
    config, 'youzan.trade.get', '4.0.0', { tid: safePlatformNumericId(p.order_id, 'order_id') },
  ));
  if (name === 'products.create') return youzanRequest(config, 'youzan.item.create', '3.0.0', p.payload);
  if (name === 'products.update') return youzanRequest(config, 'youzan.item.update', '3.0.0', {
    ...p.payload, item_id: safePlatformNumericId(p.item_id, 'item_id'),
  });
  if (name === 'inventory.update') return youzanRequest(config, 'youzan.item.quantity.update', '3.0.0', {
    ...p.payload, item_id: safePlatformNumericId(p.item_id, 'item_id'),
  });
  if (name === 'products.publish' || name === 'products.unpublish') return youzanRequest(
    config,
    name === 'products.publish' ? 'youzan.item.update.listing' : 'youzan.item.update.delisting',
    '3.0.0', { item_id: safePlatformNumericId(p.item_id, 'item_id') },
  );
  if (name === 'shipments.send') return youzanRequest(config, 'youzan.logistics.online.confirm', '3.0.0', {
    ...p.payload, tid: safePlatformNumericId(p.order_id, 'order_id'),
  });
  if (name === 'products.delete') return youzanRequest(config, 'youzan.item.delete', '3.0.0', {
    item_id: safePlatformNumericId(p.item_id, 'item_id'),
  });
  throw new Error('unsupported Youzan action');
}

async function weimobTokenRequest(config) {
  const url = new URL('https://dopen.weimob.com/fuwu/b/oauth2/token');
  url.search = new URLSearchParams({
    grant_type: 'client_credentials', client_id: config.credentials.client_id,
    client_secret: config.credentials.client_secret,
    shop_id: safePlatformNumericId(config.metadata.shop_id, 'shop_id'),
    shop_type: 'business_operation_system_id',
  }).toString();
  const body = await fetchStatusOnlyJson(url, {
    method: 'POST', headers: { accept: 'application/json' },
  }, 'Weimob WOS token');
  const token = body?.data ?? body;
  if (!token?.access_token
      || String(token.business_operation_system_id || '') !== String(config.metadata.shop_id)) {
    throw new Error('Weimob WOS token returned incomplete credentials or a different shop');
  }
  return token;
}

async function weimobRequestWithToken(accessToken, pathName, parameters = {}) {
  if (!/^(?:bos|weimob_shop)\/v2\.0\/[a-z0-9/_]{1,160}$/i.test(pathName)) {
    throw new Error('invalid reviewed Weimob WOS API destination');
  }
  const url = new URL(`https://dopen.weimob.com/apigw/${pathName}`);
  url.searchParams.set('accesstoken', accessToken);
  const body = await fetchStatusOnlyJson(url, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(parameters),
  }, 'Weimob WOS');
  const providerCode = body?.code?.errcode ?? body?.errcode;
  if (providerCode !== undefined && String(providerCode) !== '0') {
    throw new Error(`Weimob WOS request failed (provider code ${String(providerCode).slice(0, 40)})`);
  }
  return body?.data ?? body;
}

async function refreshWeimobToken(config) {
  const token = await weimobTokenRequest(config);
  config.credentials = {
    ...config.credentials, access_token: token.access_token,
    expires_at: platformExpiryMs(token.expires_in, 7 * 86_400),
    identity: {
      ...config.credentials.identity,
      business_operation_system_id: String(token.business_operation_system_id),
      public_account_id: String(token.public_account_id || config.credentials.identity?.public_account_id || ''),
      business_id: String(token.business_id || config.credentials.identity?.business_id || ''),
    },
  };
  writeCredentialFile(config.credentialFile, config.credentialKey, config.credentials);
  return config.credentials.access_token;
}

const weimobToken = credentialOperation(async function weimobToken(config) {
  if (Number(config.credentials.expires_at || 0) > Date.now() + 300_000) return config.credentials.access_token;
  const key = config.credentialFile;
  if (weimobRefreshes.has(key)) return weimobRefreshes.get(key);
  const pending = refreshWeimobToken(config).finally(() => weimobRefreshes.delete(key));
  weimobRefreshes.set(key, pending);
  return pending;
});

async function weimobRequest(config, pathName, parameters = {}) {
  return weimobRequestWithToken(await weimobToken(config), pathName, parameters);
}

async function executeWeimobWos(config, name, p) {
  if (name === 'account.get') return weimobRequest(config, 'bos/v2.0/organization/getList', { pageNum: 1, pageSize: 100 });
  if (name === 'organizations.get') return weimobRequest(config, 'bos/v2.0/organization/detail/get', {
    vid: safePlatformNumericId(p.vid, 'vid'),
  });
  const routes = {
    'products.list': 'weimob_shop/v2.0/goods/getList',
    'products.get': 'weimob_shop/v2.0/goods/get',
    'skus.search': 'weimob_shop/v2.0/goods/sku/search',
    'orders.list': 'weimob_shop/v2.0/order/list/search',
    'orders.get': 'weimob_shop/v2.0/order/detail/get',
    'refunds.list': 'weimob_shop/v2.0/rights/list/search',
    'refunds.get': 'weimob_shop/v2.0/rights/detail/get',
    'products.create': 'weimob_shop/v2.0/goods/create',
    'products.update': 'weimob_shop/v2.0/goods/update',
    'prices.update': 'weimob_shop/v2.0/goods/price/update',
    'shipments.send': 'weimob_shop/v2.0/fulfill/logistics/update',
    'shipments.update': 'weimob_shop/v2.0/fulfill/logistics/info/update',
    'refunds.approve': 'weimob_shop/v2.0/rights/agree',
    'refunds.reject': 'weimob_shop/v2.0/rights/refuse',
  };
  if (name === 'inventory.update') return weimobRequest(
    config, 'weimob_shop/v2.0/stock/update', { ...p.payload, quantityEditType: 0 },
  );
  if (routes[name]) {
    const result = await weimobRequest(config, routes[name], p.payload);
    return /^(?:orders|refunds)\./.test(name) ? minimizeCommerceSensitiveData(result) : result;
  }
  if (name === 'products.publish' || name === 'products.unpublish') return weimobRequest(
    config, 'weimob_shop/v2.0/goods/onlinestatus/update', {
      goodsIdList: p.goods_ids.map((id) => safePlatformNumericId(id, 'goods_id')),
      isOnline: name === 'products.publish', basicInfo: { vid: safePlatformNumericId(p.vid, 'vid') },
    },
  );
  if (name === 'products.delete') return weimobRequest(config, 'weimob_shop/v2.0/goods/delete', {
    goodsIdList: p.goods_ids.map((id) => safePlatformNumericId(id, 'goods_id')),
    basicInfo: { vid: safePlatformNumericId(p.vid, 'vid') },
  });
  throw new Error('unsupported Weimob WOS action');
}

function xiaohongshuRawId(value, name) {
  return decodeURIComponent(safeId(value, name));
}

function xiaohongshuQuery(query = {}) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) throw new Error('invalid Xiaohongshu query');
  const result = {};
  for (const [key, raw] of Object.entries(query)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || /token|secret|auth|url|method|header/i.test(key)) {
      throw new Error(`Xiaohongshu query key is not allowed: ${key}`);
    }
    const value = Array.isArray(raw) ? raw.join(',') : raw;
    if (!['string', 'number', 'boolean'].includes(typeof value)
        || String(value).length > 2_000) throw new Error(`invalid Xiaohongshu query value: ${key}`);
    result[key] = String(value);
  }
  return result;
}

function signXiaohongshu(pathName, query, appKey, timestamp, appSecret) {
  const parameters = { 'app-key': appKey, ...xiaohongshuQuery(query), timestamp: String(timestamp) };
  const parameterString = Object.keys(parameters).sort()
    .map((key) => `${key}=${parameters[key]}`).join('&');
  return createHash('md5').update(`${pathName}?${parameterString}${appSecret}`, 'utf8').digest('hex');
}

async function xiaohongshuRequest(config, method, pathName, query = {}, body) {
  if (!['GET', 'POST', 'PUT', 'PATCH'].includes(method)
      || !/^\/ark\/open_api\/v[01]\/[A-Za-z0-9_./-]{1,180}$/.test(pathName)
      || pathName.includes('..')) throw new Error('invalid reviewed Xiaohongshu Ark destination');
  const reviewedQuery = xiaohongshuQuery(query);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const url = new URL(`https://ark.xiaohongshu.com${pathName}`);
  for (const [key, value] of Object.entries(reviewedQuery)) url.searchParams.set(key, value);
  const result = await fetchStatusOnlyJson(url, {
    method,
    headers: {
      accept: 'application/json', 'content-type': 'application/json;charset=utf-8',
      timestamp, 'app-key': config.credentials.app_key,
      sign: signXiaohongshu(pathName, reviewedQuery, config.credentials.app_key, timestamp, config.credentials.app_secret),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, 'Xiaohongshu Ark');
  if (result?.success === false || (result?.error_code !== undefined && Number(result.error_code) !== 0)) {
    throw new Error(`Xiaohongshu Ark request failed (provider code ${String(result.error_code || 'unknown').slice(0, 40)})`);
  }
  return result?.data ?? result;
}

async function executeXiaohongshuArk(config, name, p) {
  if (name === 'connection.check') return xiaohongshuRequest(
    config, 'GET', '/ark/open_api/v1/items/lite', { page_no: 1, page_size: 1 },
  );
  if (name === 'catalog.brands.search') return xiaohongshuRequest(
    config, 'GET', '/ark/open_api/v1/brand_search', {
      keyword: p.keyword, page_no: p.page || 1, page_size: p.page_size || 50,
    },
  );
  if (name === 'catalog.categories.list') return xiaohongshuRequest(
    config, 'GET', '/ark/open_api/v1/categories', p.category_ids
      ? { category_ids: p.category_ids.map((id) => xiaohongshuRawId(id, 'category_id')) } : {},
  );
  const catalogPaths = {
    'catalog.category_variants.list': () => `/ark/open_api/v1/category/${safeId(p.category_id, 'category_id')}/variations`,
    'catalog.category_attributes.list': () => `/ark/open_api/v1/categories/${safeId(p.category_id, 'category_id')}/attribute_options`,
    'catalog.attribute_values.list': () => `/ark/open_api/v1/attributes/${safeId(p.attribute_id, 'attribute_id')}/values`,
    'catalog.logistics_companies.list': () => '/ark/open_api/v0/express_companies',
    'catalog.logistics_modes.list': () => '/ark/open_api/v0/package/logistics',
  };
  if (catalogPaths[name]) return xiaohongshuRequest(config, 'GET', catalogPaths[name]());
  if (name === 'products.list_lite' || name === 'products.list') return xiaohongshuRequest(
    config, 'GET', name === 'products.list_lite' ? '/ark/open_api/v1/items/lite' : '/ark/open_api/v1/items',
    p.query || {},
  );
  if (name === 'products.get') return xiaohongshuRequest(
    config, 'GET', '/ark/open_api/v1/items', { id: xiaohongshuRawId(p.item_id, 'item_id') },
  );
  if (name === 'products.spu_get') return xiaohongshuRequest(
    config, 'GET', `/ark/open_api/v1/spu/${safeId(p.spu_id, 'spu_id')}`,
  );
  if (name === 'inventory.get') return xiaohongshuRequest(
    config, 'GET', `/ark/open_api/v0/items/${safeId(p.item_id, 'item_id')}/stock`,
  );
  if (name === 'orders.list_latest' || name === 'orders.list' || name === 'cancellations.list') {
    const pathName = name === 'orders.list_latest' ? '/ark/open_api/v0/packages/latest_packages'
      : name === 'orders.list' ? '/ark/open_api/v0/packages'
        : '/ark/open_api/v0/packages/canceling/list';
    return minimizeCommerceSensitiveData(await xiaohongshuRequest(config, 'GET', pathName, p.query || {}));
  }
  if (name === 'orders.statuses_get') return minimizeCommerceSensitiveData(await xiaohongshuRequest(
    config, 'GET', '/ark/open_api/v0/packages/packages_status', {
      package_ids: p.package_ids.map((id) => xiaohongshuRawId(id, 'package_id')),
    },
  ));
  const createRoutes = {
    'products.spu_create': () => '/ark/open_api/v1/spu',
    'products.spl_create': () => `/ark/open_api/v1/spu/${safeId(p.spu_id, 'spu_id')}/spl`,
    'products.spl_item_create': () => `/ark/open_api/v1/spl/${safeId(p.spl_id, 'spl_id')}/spl_item`,
    'products.spv_create': () => `/ark/open_api/v1/spl/${safeId(p.spl_id, 'spl_id')}/spv`,
    'products.item_create': () => `/ark/open_api/v1/spv/${safeId(p.spv_id, 'spv_id')}/item`,
  };
  if (createRoutes[name]) return xiaohongshuRequest(config, 'POST', createRoutes[name](), {}, p.payload);
  const updateRoutes = {
    'products.spu_update': () => `/ark/open_api/v1/spu/${safeId(p.spu_id, 'spu_id')}`,
    'products.spl_update': () => `/ark/open_api/v1/spl/${safeId(p.spl_id, 'spl_id')}`,
    'products.spl_item_update': () => `/ark/open_api/v1/spl/${safeId(p.spl_id, 'spl_id')}/spl_item`,
    'products.spv_update': () => `/ark/open_api/v1/spv/${safeId(p.spv_id, 'spv_id')}`,
    'products.spv_customs_update': () => `/ark/open_api/v1/spv/${safeId(p.spv_id, 'spv_id')}/customs`,
    'products.item_update': () => `/ark/open_api/v1/item/${safeId(p.item_id, 'item_id')}`,
    'products.item_logistics_update': () => `/ark/open_api/v1/item/${safeId(p.item_id, 'item_id')}/logistics`,
  };
  if (updateRoutes[name]) return xiaohongshuRequest(config, 'PUT', updateRoutes[name](), {}, p.payload);
  if (name === 'products.submit_review') return xiaohongshuRequest(
    config, 'POST', `/ark/open_api/v1/spl/${safeId(p.spl_id, 'spl_id')}/spl_item/submit`, {}, p.payload || {},
  );
  if (name === 'products.availability_set') return xiaohongshuRequest(
    config, 'PUT', `/ark/open_api/v1/item/${safeId(p.item_id, 'item_id')}/availability`, {}, { available: p.available },
  );
  if (name === 'inventory.set' || name === 'inventory.adjust') return xiaohongshuRequest(
    config, name === 'inventory.set' ? 'PUT' : 'PATCH',
    `/ark/open_api/v0/inventories/item/${safeId(p.item_id, 'item_id')}`, {},
    { qty: name === 'inventory.set' ? p.quantity : p.quantity_delta },
  );
  if (name === 'orders.export') return minimizeCommerceSensitiveData(await xiaohongshuRequest(
    config, 'GET', `/ark/open_api/v0/packages/${safeId(p.package_id, 'package_id')}`,
  ));
  if (name === 'shipments.send') return xiaohongshuRequest(
    config, 'PUT', `/ark/open_api/v0/packages/${safeId(p.package_id, 'package_id')}`, {}, {
      status: 'shipped', express_company_code: p.express_company_code, express_no: p.express_no,
    },
  );
  if (name === 'transfer_batches.create') return xiaohongshuRequest(
    config, 'POST', '/ark/open_api/v0/packages/transfer_batches', {}, {
      packages: p.packages.map((item) => ({
        package_id: xiaohongshuRawId(item.package_id, 'package_id'), weight: item.weight,
      })),
    },
  );
  if (name === 'transfer_batches.ship') return xiaohongshuRequest(
    config, 'PUT', `/ark/open_api/v0/packages/transfer_batches/${safeId(p.batch_no, 'batch_no')}`,
  );
  if (name === 'cancellations.audit') return xiaohongshuRequest(
    config, 'PUT', '/ark/open_api/v0/packages/canceling/audit', {}, {
      package_id: xiaohongshuRawId(p.package_id, 'package_id'), audit_result: p.audit_result,
      ...(p.audit_reason ? { audit_reason: p.audit_reason } : {}),
    },
  );
  throw new Error('unsupported Xiaohongshu Ark action');
}

async function executeReloadly(config, name, p) {
  const token = await reloadlyToken(config);
  const product = config.metadata.product;
  const maps = {
    airtime: {
      'balance.get': () => ['GET', '/accounts/balance'], 'countries.list': () => ['GET', '/countries'],
      'operators.list': () => ['GET', `/operators/countries/${safeId(p.country_code, 'country_code')}`],
      'topups.get': () => ['GET', `/topups/reports/transactions/${safeId(p.id)}`], 'topups.create': () => ['POST', '/topups'],
    },
    giftcards: {
      'balance.get': () => ['GET', '/accounts/balance'], 'countries.list': () => ['GET', '/countries'],
      'products.list': () => ['GET', '/products'], 'products.get': () => ['GET', `/products/${safeId(p.id)}`],
      'orders.get': () => ['GET', `/reports/transactions/${safeId(p.id)}`], 'orders.create': () => ['POST', '/orders'],
    },
    utilities: {
      'balance.get': () => ['GET', '/accounts/balance'], 'countries.list': () => ['GET', '/countries'],
      'billers.list': () => ['GET', '/billers'], 'transactions.get': () => ['GET', `/transactions/${safeId(p.id)}`],
      'bills.pay': () => ['POST', '/pay'],
    },
  };
  const route = maps[product]?.[name]?.();
  if (!route) throw new Error('unsupported Reloadly action for the connected product');
  const base = reloadlyBase(config);
  if (name === 'topups.create' || name === 'orders.create' || name === 'bills.pay') {
    validateReloadlyPurchase(product, p.body);
    const balanceBefore = await restRequest(base, token, 'GET', '/accounts/balance', {});
    const transaction = await restRequest(base, token, route[0], route[1], p);
    return { balance_before: balanceBefore, transaction };
  }
  return restRequest(base, token, route[0], route[1], p);
}

function validateReloadlyPurchase(product, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Reloadly purchase body is required');
  const positive = (name) => {
    const value = Number(body[name]);
    if (!Number.isFinite(value) || value <= 0 || value > 1_000_000_000) throw new Error(`invalid Reloadly purchase ${name}`);
  };
  const reference = product === 'utilities' ? body.referenceId : body.customIdentifier;
  if (typeof reference !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(reference)) {
    throw new Error(`Reloadly ${product === 'utilities' ? 'referenceId' : 'customIdentifier'} is required for idempotent reconciliation`);
  }
  if (product === 'airtime') {
    positive('operatorId');
    positive('amount');
    if ((!body.recipientPhone || typeof body.recipientPhone !== 'object')
        && (typeof body.recipientEmail !== 'string' || !body.recipientEmail.includes('@'))) {
      throw new Error('Reloadly airtime recipientPhone or recipientEmail is required');
    }
  } else if (product === 'giftcards') {
    positive('productId');
    positive('quantity');
    positive('unitPrice');
    if (typeof body.countryCode !== 'string' || !/^[A-Z]{2}$/.test(body.countryCode)) throw new Error('invalid Reloadly gift-card countryCode');
    if (typeof body.recipientEmail !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.recipientEmail)) throw new Error('invalid Reloadly gift-card recipientEmail');
  } else if (product === 'utilities') {
    positive('amount');
    positive('billerId');
    if (!['string', 'number'].includes(typeof body.subscriberAccountNumber)
        || !String(body.subscriberAccountNumber).trim()) throw new Error('Reloadly utility subscriberAccountNumber is required');
  } else {
    throw new Error('invalid Reloadly purchase product');
  }
}

const SQUARE_API_VERSION = '2026-08-19';
const SQUARE_IDEMPOTENCY_MAX_LENGTH = Object.freeze({
  'catalog.upsert': 128, 'catalog.batch_upsert': 128, 'inventory.changes_batch_create': 128,
  'orders.create': 192, 'payments.create': 45, 'payments.update': 45, 'refunds.create': 45,
  'invoices.create': 128, 'invoices.update': 128, 'invoices.publish': 128,
  'subscriptions.create': 128, 'loyalty.accounts.create': 128,
  'loyalty.points.accumulate': 128, 'loyalty.points.adjust': 128,
  'loyalty.promotions.create': 128, 'loyalty.rewards.create': 128,
  'loyalty.rewards.redeem': 128, 'gift_cards.create': 128,
  'gift_cards.activities.create': 128, 'payment_links.create': 192,
  'disputes.evidence_text.create': 45,
});

function squareBase(config) {
  const environment = config.metadata.environment;
  if (!['sandbox', 'live'].includes(environment)) throw new Error('invalid Square environment binding');
  return environment === 'sandbox' ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com';
}

function validateSquareMutation(name, body) {
  const idempotencyMaxLength = SQUARE_IDEMPOTENCY_MAX_LENGTH[name];
  if (body === undefined && !idempotencyMaxLength) return;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(`Square ${name} body is required`);
  if (idempotencyMaxLength) {
    const key = body.idempotency_key;
    if (typeof key !== 'string' || key.length < 1 || key.length > idempotencyMaxLength || /[\u0000-\u001f\u007f]/.test(key)) {
      throw new Error(`Square ${name} requires an idempotency_key of 1-${idempotencyMaxLength} characters`);
    }
  }
  const requireMoney = (money, label) => {
    if (!money || typeof money !== 'object' || Array.isArray(money)
        || !Number.isSafeInteger(money.amount) || money.amount <= 0
        || typeof money.currency !== 'string' || !/^[A-Z]{3}$/.test(money.currency)) {
      throw new Error(`Square ${name} requires positive ${label}.amount and an ISO currency`);
    }
  };
  if (name === 'payments.create') {
    if (typeof body.source_id !== 'string' || !body.source_id.trim()) throw new Error('Square payments.create requires source_id');
    requireMoney(body.amount_money, 'amount_money');
  }
  if (name === 'refunds.create') {
    if (typeof body.payment_id !== 'string' || !body.payment_id.trim()) throw new Error('Square refunds.create requires payment_id');
    requireMoney(body.amount_money, 'amount_money');
  }
  if (name === 'payment_links.create' && body.quick_pay !== undefined) {
    requireMoney(body.quick_pay?.price_money, 'quick_pay.price_money');
  }
  const bounded = (items, max, label) => {
    if (items !== undefined && (!Array.isArray(items) || items.length < 1 || items.length > max)) {
      throw new Error(`Square ${name} ${label} must contain 1-${max} items`);
    }
  };
  if (name === 'catalog.batch_retrieve') bounded(body.object_ids, 100, 'object_ids');
  if (name === 'catalog.batch_delete') bounded(body.object_ids, 10, 'object_ids');
  if (name === 'catalog.batch_upsert') {
    bounded(body.batches, 25, 'batches');
    for (const batch of body.batches || []) bounded(batch?.objects, 25, 'batch objects');
  }
  if (name === 'inventory.changes_batch_create') bounded(body.changes, 10, 'changes');
  if (name === 'orders.batch_retrieve') bounded(body.order_ids, 100, 'order_ids');
  if (name === 'orders.pay') bounded(body.payment_ids, 10, 'payment_ids');
}

async function squareRequest(config, method, path, p = {}) {
  const headers = {
    accept: 'application/json', authorization: `Bearer ${config.credentials.access_token}`,
    'square-version': SQUARE_API_VERSION,
  };
  const init = { method, headers };
  if (p.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(p.body);
  }
  return fetchJson(`${squareBase(config)}${path}${queryString(p.query)}`, init);
}

async function executeSquare(config, name, p) {
  const map = {
    'merchant.get': () => ['GET', '/v2/merchants/me'],
    'locations.list': () => ['GET', '/v2/locations'],
    'locations.get': () => ['GET', `/v2/locations/${safeId(p.id)}`],
    'locations.create': () => ['POST', '/v2/locations'],
    'locations.update': () => ['PUT', `/v2/locations/${safeId(p.id)}`],
    'catalog.list': () => ['GET', '/v2/catalog/list'],
    'catalog.get': () => ['GET', `/v2/catalog/object/${safeId(p.id)}`],
    'catalog.search': () => ['POST', '/v2/catalog/search'],
    'catalog.batch_retrieve': () => ['POST', '/v2/catalog/batch-retrieve'],
    'catalog.upsert': () => ['POST', '/v2/catalog/object'],
    'catalog.batch_upsert': () => ['POST', '/v2/catalog/batch-upsert'],
    'catalog.delete': () => ['DELETE', `/v2/catalog/object/${safeId(p.id)}`],
    'catalog.batch_delete': () => ['POST', '/v2/catalog/batch-delete'],
    'inventory.counts_batch_retrieve': () => ['POST', '/v2/inventory/counts/batch-retrieve'],
    'inventory.changes_batch_retrieve': () => ['POST', '/v2/inventory/changes/batch-retrieve'],
    'inventory.changes_batch_create': () => ['POST', '/v2/inventory/changes/batch-create'],
    'customers.list': () => ['GET', '/v2/customers'],
    'customers.search': () => ['POST', '/v2/customers/search'],
    'customers.get': () => ['GET', `/v2/customers/${safeId(p.id)}`],
    'customers.create': () => ['POST', '/v2/customers'],
    'customers.update': () => ['PUT', `/v2/customers/${safeId(p.id)}`],
    'customers.delete': () => ['DELETE', `/v2/customers/${safeId(p.id)}`],
    'customer_groups.list': () => ['GET', '/v2/customers/groups'],
    'customer_groups.get': () => ['GET', `/v2/customers/groups/${safeId(p.id)}`],
    'customer_groups.create': () => ['POST', '/v2/customers/groups'],
    'customer_groups.update': () => ['PUT', `/v2/customers/groups/${safeId(p.id)}`],
    'customer_groups.delete': () => ['DELETE', `/v2/customers/groups/${safeId(p.id)}`],
    'customer_segments.list': () => ['GET', '/v2/customers/segments'],
    'customer_segments.get': () => ['GET', `/v2/customers/segments/${safeId(p.id)}`],
    'orders.search': () => ['POST', '/v2/orders/search'],
    'orders.get': () => ['GET', `/v2/orders/${safeId(p.id)}`],
    'orders.batch_retrieve': () => ['POST', '/v2/orders/batch-retrieve'],
    'orders.calculate': () => ['POST', '/v2/orders/calculate'],
    'orders.create': () => ['POST', '/v2/orders'],
    'orders.update': () => ['PUT', `/v2/orders/${safeId(p.id)}`],
    'orders.pay': () => ['POST', `/v2/orders/${safeId(p.id)}/pay`],
    'payments.list': () => ['GET', '/v2/payments'],
    'payments.get': () => ['GET', `/v2/payments/${safeId(p.id)}`],
    'payments.create': () => ['POST', '/v2/payments'],
    'payments.update': () => ['PUT', `/v2/payments/${safeId(p.id)}`],
    'payments.complete': () => ['POST', `/v2/payments/${safeId(p.id)}/complete`],
    'payments.cancel': () => ['POST', `/v2/payments/${safeId(p.id)}/cancel`],
    'payments.cancel_by_idempotency_key': () => ['POST', '/v2/payments/cancel'],
    'refunds.list': () => ['GET', '/v2/refunds'],
    'refunds.get': () => ['GET', `/v2/refunds/${safeId(p.id)}`],
    'refunds.create': () => ['POST', '/v2/refunds'],
    'invoices.list': () => ['GET', '/v2/invoices'],
    'invoices.search': () => ['POST', '/v2/invoices/search'],
    'invoices.get': () => ['GET', `/v2/invoices/${safeId(p.id)}`],
    'invoices.create': () => ['POST', '/v2/invoices'],
    'invoices.update': () => ['PUT', `/v2/invoices/${safeId(p.id)}`],
    'invoices.publish': () => ['POST', `/v2/invoices/${safeId(p.id)}/publish`],
    'invoices.cancel': () => ['POST', `/v2/invoices/${safeId(p.id)}/cancel`],
    'invoices.delete': () => ['DELETE', `/v2/invoices/${safeId(p.id)}`],
    'subscriptions.search': () => ['POST', '/v2/subscriptions/search'],
    'subscriptions.get': () => ['GET', `/v2/subscriptions/${safeId(p.id)}`],
    'subscriptions.events_list': () => ['GET', `/v2/subscriptions/${safeId(p.id)}/events`],
    'subscriptions.create': () => ['POST', '/v2/subscriptions'],
    'subscriptions.update': () => ['PUT', `/v2/subscriptions/${safeId(p.id)}`],
    'subscriptions.billing_anchor_change': () => ['POST', `/v2/subscriptions/${safeId(p.id)}/billing-anchor`],
    'subscriptions.pause': () => ['POST', `/v2/subscriptions/${safeId(p.id)}/pause`],
    'subscriptions.resume': () => ['POST', `/v2/subscriptions/${safeId(p.id)}/resume`],
    'subscriptions.swap_plan': () => ['POST', `/v2/subscriptions/${safeId(p.id)}/swap-plan`],
    'subscriptions.cancel': () => ['POST', `/v2/subscriptions/${safeId(p.id)}/cancel`],
    'subscriptions.action_delete': () => ['DELETE', `/v2/subscriptions/${safeId(p.id)}/actions/${safeId(p.action_id, 'action_id')}`],
    'loyalty.program_get': () => ['GET', `/v2/loyalty/programs/${safeId(p.id)}`],
    'loyalty.accounts.search': () => ['POST', '/v2/loyalty/accounts/search'],
    'loyalty.accounts.get': () => ['GET', `/v2/loyalty/accounts/${safeId(p.id)}`],
    'loyalty.accounts.create': () => ['POST', '/v2/loyalty/accounts'],
    'loyalty.points.calculate': () => ['POST', `/v2/loyalty/programs/${safeId(p.id)}/calculate`],
    'loyalty.points.accumulate': () => ['POST', `/v2/loyalty/accounts/${safeId(p.id)}/accumulate`],
    'loyalty.points.adjust': () => ['POST', `/v2/loyalty/accounts/${safeId(p.id)}/adjust`],
    'loyalty.events.search': () => ['POST', '/v2/loyalty/events/search'],
    'loyalty.promotions.list': () => ['GET', `/v2/loyalty/programs/${safeId(p.id)}/promotions`],
    'loyalty.promotions.get': () => ['GET', `/v2/loyalty/programs/${safeId(p.id)}/promotions/${safeId(p.promotion_id, 'promotion_id')}`],
    'loyalty.promotions.create': () => ['POST', `/v2/loyalty/programs/${safeId(p.id)}/promotions`],
    'loyalty.promotions.cancel': () => ['POST', `/v2/loyalty/programs/${safeId(p.id)}/promotions/${safeId(p.promotion_id, 'promotion_id')}/cancel`],
    'loyalty.rewards.search': () => ['POST', '/v2/loyalty/rewards/search'],
    'loyalty.rewards.get': () => ['GET', `/v2/loyalty/rewards/${safeId(p.id)}`],
    'loyalty.rewards.create': () => ['POST', '/v2/loyalty/rewards'],
    'loyalty.rewards.redeem': () => ['POST', `/v2/loyalty/rewards/${safeId(p.id)}/redeem`],
    'loyalty.rewards.delete': () => ['DELETE', `/v2/loyalty/rewards/${safeId(p.id)}`],
    'gift_cards.list': () => ['GET', '/v2/gift-cards'],
    'gift_cards.get': () => ['GET', `/v2/gift-cards/${safeId(p.id)}`],
    'gift_cards.get_by_gan': () => ['POST', '/v2/gift-cards/from-gan'],
    'gift_cards.activities.list': () => ['GET', '/v2/gift-cards/activities'],
    'gift_cards.create': () => ['POST', '/v2/gift-cards'],
    'gift_cards.link_customer': () => ['POST', `/v2/gift-cards/${safeId(p.id)}/link-customer`],
    'gift_cards.unlink_customer': () => ['POST', `/v2/gift-cards/${safeId(p.id)}/unlink-customer`],
    'gift_cards.activities.create': () => ['POST', '/v2/gift-cards/activities'],
    'payment_links.list': () => ['GET', '/v2/online-checkout/payment-links'],
    'payment_links.get': () => ['GET', `/v2/online-checkout/payment-links/${safeId(p.id)}`],
    'payment_links.create': () => ['POST', '/v2/online-checkout/payment-links'],
    'payment_links.update': () => ['PUT', `/v2/online-checkout/payment-links/${safeId(p.id)}`],
    'payment_links.delete': () => ['DELETE', `/v2/online-checkout/payment-links/${safeId(p.id)}`],
    'disputes.list': () => ['GET', '/v2/disputes'],
    'disputes.get': () => ['GET', `/v2/disputes/${safeId(p.id)}`],
    'disputes.evidence.list': () => ['GET', `/v2/disputes/${safeId(p.id)}/evidence`],
    'disputes.evidence.get': () => ['GET', `/v2/disputes/${safeId(p.id)}/evidence/${safeId(p.evidence_id, 'evidence_id')}`],
    'disputes.evidence_text.create': () => ['POST', `/v2/disputes/${safeId(p.id)}/evidence-text`],
    'disputes.evidence.delete': () => ['DELETE', `/v2/disputes/${safeId(p.id)}/evidence/${safeId(p.evidence_id, 'evidence_id')}`],
    'disputes.evidence.submit': () => ['POST', `/v2/disputes/${safeId(p.id)}/submit-evidence`],
    'disputes.accept': () => ['POST', `/v2/disputes/${safeId(p.id)}/accept`],
    'payouts.list': () => ['GET', '/v2/payouts'],
    'payouts.get': () => ['GET', `/v2/payouts/${safeId(p.id)}`],
  };
  const route = map[name]?.();
  if (!route) throw new Error('unsupported Square action');
  if (!['GET', 'DELETE'].includes(route[0]) || p.body !== undefined) validateSquareMutation(name, p.body);
  return squareRequest(config, route[0], route[1], p);
}

function instacartBase(config) {
  const environment = config.metadata.environment;
  if (!['sandbox', 'live'].includes(environment)) throw new Error('invalid Instacart environment binding');
  return environment === 'sandbox' ? 'https://connect.dev.instacart.tools' : 'https://connect.instacart.com';
}

function instacartMcpEndpoint(config) {
  const environment = config.metadata.environment;
  if (!['sandbox', 'live'].includes(environment)) throw new Error('invalid Instacart environment binding');
  return environment === 'sandbox' ? 'https://mcp.dev.instacart.tools/mcp' : 'https://mcp.instacart.com/mcp';
}

function validateInstacartPage(name, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(`Instacart ${name} body is required`);
  const recipe = name === 'recipe_page.create';
  if (!recipe && name !== 'shopping_list_page.create') throw new Error('unsupported Instacart page action');
  const exactKeys = (value, allowed, label) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Instacart ${label} must be an object`);
    for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Instacart ${label} field is not allowed: ${key}`);
  };
  const text = (value, label, max, required = false) => {
    if (value === undefined && !required) return;
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new Error(`Instacart ${label} must be non-empty text up to ${max} characters`);
    }
  };
  const textArray = (value, label, maxItems, maxText) => {
    if (value === undefined) return;
    if (!Array.isArray(value) || value.length > maxItems) throw new Error(`Instacart ${label} supports at most ${maxItems} items`);
    value.forEach((item, index) => text(item, `${label}[${index}]`, maxText, true));
  };
  const httpsUrl = (value, label) => {
    if (value === undefined) return;
    text(value, label, 2048, true);
    let parsed;
    try { parsed = new URL(value); } catch { throw new Error(`Instacart ${label} must be an HTTPS URL`); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error(`Instacart ${label} must be an HTTPS URL`);
  };
  const topFields = recipe
    ? ['title', 'image_url', 'author', 'servings', 'cooking_time', 'external_reference_id', 'content_creator_credit_info', 'expires_in', 'instructions', 'ingredients', 'landing_page_configuration']
    : ['title', 'image_url', 'link_type', 'expires_in', 'instructions', 'line_items', 'landing_page_configuration'];
  exactKeys(body, topFields, `${name} body`);
  text(body.title, 'title', 200, true);
  httpsUrl(body.image_url, 'image_url');
  textArray(body.instructions, 'instructions', 100, 2000);
  if (body.expires_in !== undefined && (!Number.isInteger(body.expires_in) || body.expires_in < 1 || body.expires_in > 365)) {
    throw new Error('Instacart expires_in must be an integer from 1 to 365');
  }
  if (recipe) {
    text(body.author, 'author', 200);
    text(body.external_reference_id, 'external_reference_id', 200);
    text(body.content_creator_credit_info, 'content_creator_credit_info', 500);
    for (const field of ['servings', 'cooking_time']) {
      if (body[field] !== undefined && (!Number.isInteger(body[field]) || body[field] < 1 || body[field] > 10000)) {
        throw new Error(`Instacart ${field} must be a positive integer`);
      }
    }
  } else if (body.link_type !== undefined && body.link_type !== 'shopping_list') {
    throw new Error('Instacart shopping_list_page.create link_type must be shopping_list');
  }
  if (body.landing_page_configuration !== undefined) {
    exactKeys(body.landing_page_configuration, ['partner_linkback_url', 'enable_pantry_items'], 'landing_page_configuration');
    httpsUrl(body.landing_page_configuration.partner_linkback_url, 'partner_linkback_url');
    if (body.landing_page_configuration.enable_pantry_items !== undefined
        && typeof body.landing_page_configuration.enable_pantry_items !== 'boolean') {
      throw new Error('Instacart enable_pantry_items must be boolean');
    }
  }
  const lineItems = recipe ? body.ingredients : body.line_items;
  const lineLabel = recipe ? 'ingredients' : 'line_items';
  if (!Array.isArray(lineItems) || lineItems.length < 1 || lineItems.length > 100) {
    throw new Error(`Instacart ${lineLabel} must contain 1-100 items`);
  }
  const seenProductIds = new Set();
  const seenUpcs = new Set();
  for (const [index, item] of lineItems.entries()) {
    const itemLabel = `${lineLabel}[${index}]`;
    exactKeys(item, recipe
      ? ['name', 'display_text', 'product_ids', 'upcs', 'measurements', 'filters']
      : ['name', 'quantity', 'unit', 'display_text', 'product_ids', 'upcs', 'line_item_measurements', 'filters'], itemLabel);
    text(item.name, `${itemLabel}.name`, 200, true);
    text(item.display_text, `${itemLabel}.display_text`, 500);
    if (item.product_ids !== undefined && item.upcs !== undefined) throw new Error(`Instacart ${itemLabel} cannot include both product_ids and upcs`);
    if (item.product_ids !== undefined) {
      if (!Array.isArray(item.product_ids) || item.product_ids.length < 1 || item.product_ids.length > 10
          || new Set(item.product_ids).size !== item.product_ids.length
          || item.product_ids.some((id) => !Number.isSafeInteger(id) || id <= 0 || seenProductIds.has(id))) {
        throw new Error(`Instacart ${itemLabel}.product_ids must contain 1-10 unique positive integers`);
      }
      item.product_ids.forEach((id) => seenProductIds.add(id));
    }
    if (item.upcs !== undefined) {
      if (!Array.isArray(item.upcs) || item.upcs.length < 1 || item.upcs.length > 10
          || new Set(item.upcs).size !== item.upcs.length
          || item.upcs.some((upc) => typeof upc !== 'string' || !/^(?:\d{12}|\d{14})$/.test(upc) || seenUpcs.has(upc))) {
        throw new Error(`Instacart ${itemLabel}.upcs must contain 1-10 unique 12- or 14-digit UPCs`);
      }
      item.upcs.forEach((upc) => seenUpcs.add(upc));
    }
    const measurements = recipe ? item.measurements : item.line_item_measurements;
    if (measurements !== undefined) {
      if (!Array.isArray(measurements) || measurements.length < 1 || measurements.length > 10) {
        throw new Error(`Instacart ${itemLabel} measurements must contain 1-10 items`);
      }
      for (const [measurementIndex, measurement] of measurements.entries()) {
        exactKeys(measurement, ['quantity', 'unit'], `${itemLabel}.measurements[${measurementIndex}]`);
        if (measurement.quantity !== undefined && (!Number.isFinite(measurement.quantity) || measurement.quantity <= 0)) {
          throw new Error(`Instacart ${itemLabel} measurement quantity must be positive`);
        }
        text(measurement.unit, `${itemLabel}.measurements[${measurementIndex}].unit`, 64);
      }
    }
    if (!recipe) {
      if (item.quantity !== undefined && (!Number.isFinite(item.quantity) || item.quantity <= 0)) {
        throw new Error(`Instacart ${itemLabel}.quantity must be positive`);
      }
      text(item.unit, `${itemLabel}.unit`, 64);
    }
    if (item.filters !== undefined) {
      exactKeys(item.filters, ['brand_filters', 'health_filters'], `${itemLabel}.filters`);
      textArray(item.filters.brand_filters, `${itemLabel}.filters.brand_filters`, 10, 100);
      textArray(item.filters.health_filters, `${itemLabel}.filters.health_filters`, 7, 32);
      const health = new Set(['ORGANIC', 'GLUTEN_FREE', 'FAT_FREE', 'VEGAN', 'KOSHER', 'SUGAR_FREE', 'LOW_FAT']);
      if ((item.filters.health_filters || []).some((value) => !health.has(value))) throw new Error(`Instacart ${itemLabel} contains an unsupported health filter`);
    }
  }
  return body;
}

async function instacartMcpCapabilities(config, fetchImpl = fetch) {
  const apiKey = config.credentials.api_key;
  if (typeof apiKey !== 'string' || !/^keys\.[A-Za-z0-9_-]{16,256}$/.test(apiKey)) throw new Error('Instacart credential verification failed');
  const endpoint = instacartMcpEndpoint(config);
  let sessionId = '';
  let protocolVersion = LATEST_PROTOCOL_VERSION;
  let requestId = 1;
  const send = async (message, expectResponse = true) => {
    const headers = {
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    if (message.method !== 'initialize') headers['mcp-protocol-version'] = protocolVersion;
    const response = await requestFetch(endpoint, {
      method: 'POST', headers, body: JSON.stringify(message), redirect: 'manual',
      signal: AbortSignal.timeout(45_000),
    }, fetchImpl);
    if (response.status >= 300 && response.status < 400) throw new Error('Instacart MCP redirect refused');
    if (!response.ok) throw new Error(`Instacart MCP request failed (HTTP ${response.status})`);
    const returnedSession = response.headers.get('mcp-session-id');
    if (returnedSession) {
      if (!/^[\x21-\x7e]{1,1024}$/.test(returnedSession)) throw new Error('invalid Instacart MCP session');
      sessionId = returnedSession;
    }
    if (!expectResponse || response.status === 202 || response.status === 204) {
      await response.body?.cancel();
      return null;
    }
    const raw = await response.text();
    if (raw.length > MAX_OUTPUT_CHARS) throw new Error('Instacart MCP response is too large');
    const contentType = response.headers.get('content-type') || '';
    let messages;
    if (contentType.includes('application/json')) {
      const parsed = JSON.parse(raw);
      messages = Array.isArray(parsed) ? parsed : [parsed];
    } else if (contentType.includes('text/event-stream')) {
      messages = raw.split(/\r?\n\r?\n/).flatMap((event) => {
        const data = event.split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        return data ? [JSON.parse(data)] : [];
      });
    } else {
      throw new Error('unexpected Instacart MCP response type');
    }
    const result = messages.find((candidate) => candidate?.id === message.id);
    if (!result || result.jsonrpc !== '2.0') throw new Error('missing Instacart MCP response');
    if (result.error) throw new Error('Instacart MCP returned an error');
    return result.result;
  };
  try {
    const initialized = await send({
      jsonrpc: '2.0', id: requestId++, method: 'initialize', params: {
        protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {},
        clientInfo: { name: 'orkas-instacart-key-check', version: '1.0.0' },
      },
    });
    const negotiatedProtocol = String(initialized?.protocolVersion || '');
    if (!SUPPORTED_PROTOCOL_VERSIONS.includes(negotiatedProtocol)) throw new Error('unsupported Instacart MCP protocol');
    protocolVersion = negotiatedProtocol;
    await send({ jsonrpc: '2.0', method: 'notifications/initialized' }, false);
    const result = await send({ jsonrpc: '2.0', id: requestId++, method: 'tools/list', params: {} });
    if (!Array.isArray(result?.tools)) throw new Error('invalid Instacart MCP tool list');
    const tools = result.tools.map((tool) => String(tool?.name || '')).filter(Boolean).sort();
    const normalized = tools.map((name) => name.toLowerCase().replace(/_/g, '-'));
    if (!normalized.some((name) => name.includes('create-recipe') || name.includes('create-a-recipe'))
        || !normalized.some((name) => name.includes('create-shopping-list'))) {
      throw new Error('required Instacart MCP tools are unavailable');
    }
    return { environment: config.metadata.environment, official_mcp_tools: tools };
  } catch {
    throw new Error('Instacart credential verification failed');
  } finally {
    if (sessionId) {
      await fetchImpl(endpoint, {
        method: 'DELETE', redirect: 'manual', signal: AbortSignal.timeout(45_000),
        headers: {
          authorization: `Bearer ${apiKey}`,
          'mcp-session-id': sessionId,
          'mcp-protocol-version': protocolVersion,
        },
      }).then((response) => response.body?.cancel()).catch(() => {});
    }
  }
}

async function instacartRequest(config, method, path, p = {}) {
  const headers = { accept: 'application/json', authorization: `Bearer ${config.credentials.api_key}` };
  const init = { method, headers };
  if (p.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(p.body);
  }
  try {
    return await fetchJson(`${instacartBase(config)}${path}${queryString(p.query)}`, init);
  } catch (error) {
    const status = String(error?.message || '').match(/HTTP (\d{3})/)?.[1];
    throw commerceError(error?.code, `Instacart request failed${status ? ` (HTTP ${status})` : ''}`);
  }
}

async function executeInstacart(config, name, p) {
  if (name === 'retailers.list') {
    if (!/^[A-Za-z0-9 -]{1,20}$/.test(p.postal_code) || !['US', 'CA'].includes(p.country_code)) {
      throw new Error('invalid Instacart postal or country code');
    }
    return instacartRequest(config, 'GET', '/idp/v1/retailers', {
      query: { postal_code: p.postal_code, country_code: p.country_code },
    });
  }
  const body = validateInstacartPage(name, p.body);
  const path = name === 'recipe_page.create'
    ? '/idp/v1/products/recipe' : '/idp/v1/products/products_link';
  return instacartRequest(config, 'POST', path, { body });
}

async function execute(config, name, parameters) {
  if (storefrontApi.isProvider(config.provider)) return storefrontApi.execute(config, name, parameters);
  const p = validateParameters(parameters);
  if (sellerApi.isSellerProvider(config.provider)) return sellerApi.execute(config, name, p);
  if (config.provider === 'shopify') return executeShopify(config, name, p);
  if (config.provider === 'constant_contact') return executeConstantContact(config, name, p);
  if (config.provider === 'commerce_layer') return executeCommerceLayer(config, name, p);
  if (config.provider === 'lightspeed') return executeLightspeed(config, name, p);
  if (config.provider === 'woocommerce') return executeWooCommerce(config, name, p);
  if (config.provider === 'walmart') return executeWalmart(config, name, p);
  if (config.provider === 'ebay') return executeEbay(config, name, p);
  if (config.provider === 'etsy') return executeEtsy(config, name, p);
  if (config.provider === 'amazon_seller') return executeAmazon(config, name, p);
  if (config.provider === 'mercado_libre') return executeMercadoLibre(config, name, p);
  if (config.provider === 'taobao_top') return executeTaobao(config, name, p);
  if (config.provider === 'alibaba_1688') return executeAlibaba1688(config, name, p);
  if (config.provider === 'jd_jos') return executeJd(config, name, p);
  if (config.provider === 'pinduoduo') return executePinduoduo(config, name, p);
  if (config.provider === 'douyin_shop') return executeDouyinShop(config, name, p);
  if (config.provider === 'kuaishou_shop') return executeKuaishouShop(config, name, p);
  if (config.provider === 'youzan') return executeYouzan(config, name, p);
  if (config.provider === 'weimob_wos') return executeWeimobWos(config, name, p);
  if (config.provider === 'xiaohongshu_ark') return executeXiaohongshuArk(config, name, p);
  if (config.provider === 'square') return executeSquare(config, name, p);
  if (config.provider === 'instacart') return executeInstacart(config, name, p);
  return executeReloadly(config, name, p);
}

async function verifyIdentity(config) {
  if (storefrontApi.isProvider(config.provider)) return storefrontApi.identity(config);
  if (sellerApi.isSellerProvider(config.provider)) return sellerApi.execute(config, 'shop.get', {});
  if (config.provider === 'shopify') return executeShopify(config, 'shop.get', {});
  if (config.provider === 'constant_contact') return executeConstantContact(config, 'account.get', {});
  if (config.provider === 'commerce_layer') return executeCommerceLayer(config, 'application.get', {});
  if (config.provider === 'lightspeed') return executeLightspeed(config, 'store.get', {});
  if (config.provider === 'woocommerce') return woocommerceIdentity(config);
  if (config.provider === 'walmart') return walmartTokenDetails(config);
  if (config.provider === 'ebay') return executeEbay(config, 'account.privileges', {});
  if (config.provider === 'etsy') return executeEtsy(config, 'shop.get', {});
  if (config.provider === 'amazon_seller') {
    const identity = await executeAmazon(config, 'account.marketplace_participations', {});
    if (config.metadata.environment === 'live') {
      const participations = Array.isArray(identity?.payload) ? identity.payload : [];
      const selected = participations.find((row) => row?.marketplace?.id === config.metadata.marketplace_id);
      if (!selected || selected.participation?.isParticipating === false) {
        throw new Error('Amazon Seller authorization is not active for the selected marketplace');
      }
    }
    return { seller_id: config.metadata.seller_id, marketplace_id: config.metadata.marketplace_id, participations: identity };
  }
  if (config.provider === 'mercado_libre') {
    const identity = await executeMercadoLibre(config, 'account.get', {});
    if (String(identity?.id || '') !== String(config.metadata.user_id)) {
      throw new Error('Mercado Libre authorization belongs to a different seller');
    }
    return identity;
  }
  if (config.provider === 'taobao_top') {
    const response = await executeTaobao(config, 'account.get', {});
    const identity = response.user_seller_get_response?.user || response.user || {};
    if (!identity.nick || String(identity.user_id || '') !== String(config.credentials.identity.user_id)) {
      throw new Error('Taobao authorization belongs to a different seller');
    }
    return identity;
  }
  if (config.provider === 'alibaba_1688') {
    const response = await executeAlibaba1688(config, 'account.get', {});
    if (String(response?.result?.memberId || '') !== String(config.credentials.identity.member_id)) {
      throw new Error('1688 authorization belongs to a different seller');
    }
    return response.result;
  }
  if (config.provider === 'jd_jos') {
    const identity = jdSellerIdentity(await executeJd(config, 'account.get', {}));
    if (String(identity.vender_id || identity.venderId || '') !== String(config.credentials.identity.vender_id)
        || String(identity.shop_id || identity.shopId || '') !== String(config.credentials.identity.shop_id)) {
      throw new Error('JD.com authorization belongs to a different seller');
    }
    return identity;
  }
  if (config.provider === 'pinduoduo') {
    const response = await executePinduoduo(config, 'account.get', {});
    const identity = response?.mall_info_get_response || {};
    if (String(identity.mall_id || '') !== String(config.credentials.identity.mall_id)) {
      throw new Error('Pinduoduo authorization belongs to a different merchant');
    }
    return identity;
  }
  if (config.provider === 'douyin_shop') {
    const identity = await executeDouyinShop(config, 'account.get', {});
    if (String(identity.auth_id || identity.shop_id || '') !== String(config.credentials.identity.shop_id)
        || Number(identity.status) !== 1) {
      throw new Error('Douyin Shop authorization belongs to an inactive or different shop');
    }
    return identity;
  }
  if (config.provider === 'kuaishou_shop') {
    const identity = await executeKuaishouShop(config, 'account.get', {});
    if ((identity.seller?.open_id || identity.seller?.openId)
        && String(identity.seller.open_id || identity.seller.openId) !== String(config.credentials.identity.open_id)) {
      throw new Error('Kuaishou Shop authorization belongs to a different seller');
    }
    if (String(identity.shop?.shop_id || identity.shop?.shopId || identity.shop?.id || '')
        !== String(config.credentials.identity.shop_id)) {
      throw new Error('Kuaishou Shop authorization belongs to a different shop');
    }
    return identity;
  }
  if (config.provider === 'youzan') {
    const identity = await executeYouzan(config, 'account.get', {});
    const returnedKdtId = String(identity?.kdt_id || identity?.id || identity?.shop_id || '');
    if (returnedKdtId && returnedKdtId !== String(config.credentials.identity.kdt_id)) {
      throw new Error('Youzan authorization belongs to a different shop');
    }
    return { ...identity, kdt_id: String(config.credentials.identity.kdt_id) };
  }
  if (config.provider === 'weimob_wos') {
    return {
      business_operation_system_id: String(config.credentials.identity.business_operation_system_id),
      organizations: await executeWeimobWos(config, 'account.get', {}),
    };
  }
  if (config.provider === 'xiaohongshu_ark') {
    return {
      app_key_fingerprint: String(config.credentials.identity.app_key_fingerprint),
      production_api: true,
      probe: await executeXiaohongshuArk(config, 'connection.check', {}),
    };
  }
  if (config.provider === 'square') return executeSquare(config, 'merchant.get', {});
  if (config.provider === 'instacart') return instacartMcpCapabilities(config);
  return executeReloadly(config, 'balance.get', {});
}

function tool(name, description, schema, annotations) {
  return { name, description, inputSchema: schema, annotations, _meta: { orkas: { actionPolicy: TOOL_POLICIES[name] } } };
}
const EXECUTE_SCHEMA = Object.freeze({
  type: 'object', properties: {
    action: { type: 'string', maxLength: 160 },
    parameters: { type: 'object', additionalProperties: true },
  }, required: ['action'], additionalProperties: false,
});
const TOOLS = Object.freeze([
  tool('list_capabilities', 'List all exact reviewed actions available for this bound commerce account.', { type: 'object', properties: {}, additionalProperties: false }, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }),
  tool('describe_action', 'Describe one exact reviewed action, its parameters, and its risk lane.', { type: 'object', properties: { action: { type: 'string' } }, required: ['action'], additionalProperties: false }, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }),
  tool('execute_read', 'Execute a reviewed read action.', EXECUTE_SCHEMA, { readOnlyHint: true, destructiveHint: false, openWorldHint: true }),
  tool('execute_write', 'Execute a reviewed ordinary write after preview.', EXECUTE_SCHEMA, { readOnlyHint: false, destructiveHint: false, openWorldHint: true }),
  tool('execute_high_impact', 'Execute a reviewed financial or externally visible action after fresh confirmation.', EXECUTE_SCHEMA, { readOnlyHint: false, destructiveHint: false, openWorldHint: true }),
  tool('execute_destructive', 'Execute a reviewed delete, void, or unschedule action after destructive confirmation.', EXECUTE_SCHEMA, { readOnlyHint: false, destructiveHint: true, openWorldHint: true }),
]);

async function callTool(name, args = {}, env = process.env) {
  const config = configured(env);
  const actions = actionsFor(config);
  if (name === 'list_capabilities') {
    const identity = await verifyIdentity(config);
    return { provider: config.provider, binding: config.metadata, identity, actions: Object.entries(actions).map(([actionName, spec]) => ({ action: actionName, risk: spec.risk, description: spec.description })) };
  }
  if (name === 'describe_action') {
    const spec = actions[String(args.action || '')];
    if (!spec) throw new Error('unreviewed or unknown action');
    return { provider: config.provider, action: args.action, ...spec };
  }
  const expected = name === 'execute_read' ? 'R' : name === 'execute_write' ? 'W' : name === 'execute_high_impact' ? 'H' : name === 'execute_destructive' ? 'D' : '';
  if (!expected) throw new Error('unknown tool');
  const actionName = String(args.action || '');
  const spec = actions[actionName];
  if (!spec) throw new Error('unreviewed or unknown action');
  if (spec.risk !== expected) throw new Error(`action risk mismatch: ${actionName} is ${spec.risk}`);
  const supplied = validateActionParameters(spec, args.parameters);
  return { provider: config.provider, action: actionName, risk: spec.risk, result: await execute(config, actionName, supplied) };
}

// Preserve the closed adapter reason out of band. The existing user-facing error
// envelope stays compatible; credentials, request data and raw upstream codes never
// enter MCP diagnostics consumed by desktop logs/analytics.
const DIAGNOSTIC_CODES = new Set([
  'E_TOOL_CALL_AUTH', 'E_TOOL_CALL_CANCELLED', 'E_TOOL_CALL_NETWORK', 'E_TOOL_CALL_TIMEOUT',
  'E_TOOL_CALL_RATE_LIMIT', 'E_TOOL_CALL_UPSTREAM', 'E_BAD_INPUT',
  'storefront_permission_denied', 'storefront_binding_mismatch', 'storefront_invalid_credentials',
  'storefront_invalid_binding', 'storefront_validation_failed', 'storefront_timeout',
  'storefront_network_failed', 'storefront_rate_limit', 'storefront_upstream_error',
  'storefront_invalid_response', 'storefront_request_failed',
]);

async function callToolResult(name, args = {}, env = process.env) {
  try {
    const result = await callTool(name, args, env);
    // Recognize the product-owned seller outcome and documented provider failure
    // arrays, never provider prose. Preserve reconciliation data and never retry
    // an update which may already have changed some resources.
    const partial = (sellerApi.isSellerProvider(result.provider) && result.result?.status === 'partial_or_failed')
      || (result.provider === 'square' && Array.isArray(result.result?.errors) && result.result.errors.length > 0)
      || (result.provider === 'weimob_wos' && result.action === 'inventory.update'
        && Array.isArray(result.result?.failList) && result.result.failList.length > 0);
    return { ...(partial ? { isError: true, _meta: { orkas: { errorCode: 'E_TOOL_CALL_UPSTREAM' } } } : {}),
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return { isError: true,
      ...(DIAGNOSTIC_CODES.has(error?.code) ? { _meta: { orkas: { errorCode: error.code } } } : {}),
      content: [{ type: 'text', text: JSON.stringify({
        error_code: /401|403|authoriz|credential|token|scope/i.test(String(error?.message)) ? 'connector_reconnect_required' : 'direct_commerce_action_failed',
        message: redact(error?.message || error),
      }) }],
    };
  }
}

async function main() {
  const lifetime = new AbortController();
  const server = new Server({ name: 'orkas-direct-commerce', version: '1.0.0' }, { capabilities: { tools: {} } });
  const shutdown = () => {
    lifetime.abort();
    void server.close().catch(() => {});
  };
  process.stdin.once('end', shutdown);
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  server.setRequestHandler(ListToolsRequestSchema, (_request, extra) => withRequestSignal(
    AbortSignal.any([lifetime.signal, extra.signal]), async () => {
      try {
        await verifyIdentity(configured());
        return { tools: TOOLS };
      } catch (error) {
        // tools/list fails as JSON-RPC, not a CallToolResult. Preserve the same
        // closed diagnostic across the SDK's error serialization boundary.
        throw new McpError(ErrorCode.InternalError, redact(error?.message || error),
          DIAGNOSTIC_CODES.has(error?.code) ? { orkas: { errorCode: error.code } } : undefined);
      }
    }));
  server.setRequestHandler(CallToolRequestSchema, (request, extra) => withRequestSignal(
    AbortSignal.any([lifetime.signal, extra.signal]), () =>
      callToolResult(request.params.name, request.params.arguments || {})));
  await server.connect(new StdioServerTransport());
}

module.exports = {
  TOOL_POLICIES, TOOLS, SHOPIFY_ACTIONS, CONSTANT_CONTACT_ACTIONS, COMMERCE_LAYER_ACTIONS, LIGHTSPEED_ACTIONS,
  WOOCOMMERCE_ACTIONS, WALMART_COMMON_ACTIONS, WALMART_RETURN_ACTIONS,
  EBAY_ACTIONS, ETSY_ACTIONS, AMAZON_ACTIONS, MERCADO_LIBRE_ACTIONS,
  TAOBAO_ACTIONS, ALIBABA_1688_ACTIONS, JD_ACTIONS, PINDUODUO_ACTIONS,
  DOUYIN_SHOP_ACTIONS, KUAISHOU_SHOP_ACTIONS, YOUZAN_ACTIONS, WEIMOB_WOS_ACTIONS,
  XIAOHONGSHU_ARK_ACTIONS,
  RELOADLY_ACTIONS, SQUARE_ACTIONS, INSTACART_ACTIONS, SQUARE_API_VERSION, configured, actionsFor,
  validateParameters, validateActionParameters, validateReloadlyPurchase, validateSquareMutation, validateInstacartPage,
  validateWalmartMutation,
  safeId, safeNumericId, queryString, redact, shopifyToken, constantContactToken, reloadlyBase, reloadlyToken,
  commerceLayerBase, commerceLayerToken, commerceLayerQuery, commerceLayerRequest, executeCommerceLayer,
  squareBase, squareRequest, executeSquare, instacartBase, instacartMcpEndpoint, callToolResult,
  instacartMcpCapabilities, instacartRequest, executeInstacart, execute, verifyIdentity, callTool,
  woocommerceBase, woocommerceRequest, executeWooCommerce, woocommerceIdentity,
  walmartBase, walmartToken, walmartTokenDetails, walmartRequest, executeWalmart,
  ebayBase, ebayToken, ebayRequest, validateEbayMutation, executeEbay,
  etsyToken, etsyFormBody, etsyRequest, executeEtsy,
  amazonBase, amazonToken, amazonRequest, amazonCatalogQuery, executeAmazon,
  mercadoLibreToken, mercadoLibreRequest, executeMercadoLibre,
  chinaTimestamp, signTaobao, taobaoToken, taobaoRequest, executeTaobao,
  sign1688, alibaba1688Token, alibaba1688Request, minimizeAlibaba1688OrderData, executeAlibaba1688,
  signJd, jdToken, jdRequest, executeJd, signPinduoduo, pinduoduoToken, pinduoduoRequest,
  minimizeCommerceSensitiveData, executePinduoduo,
  stableCommerceJson, signDouyin, douyinToken, douyinRequest, executeDouyinShop,
  signKuaishou, kuaishouToken, kuaishouRequest, assertKuaishouWindow, executeKuaishouShop,
  youzanExpiresAt, youzanToken, youzanRequest, executeYouzan,
  weimobToken, weimobRequest, executeWeimobWos,
  signXiaohongshu, xiaohongshuRequest, executeXiaohongshuArk,
};

if (require.main === module) {
  main().catch(() => {
    process.stderr.write('direct-commerce-mcp-server fatal: startup failed\n');
    process.exit(1);
  });
}
