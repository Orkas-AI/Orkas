'use strict';

// Shared by catalog field help and the Shopify adapter's token validation.
module.exports = Object.freeze({
  required_scopes: Object.freeze([
    'read_products', 'write_products', 'read_orders', 'write_orders',
    'read_customers', 'write_customers', 'read_inventory', 'write_inventory',
    'read_locations', 'read_draft_orders', 'write_draft_orders',
    'read_returns', 'write_returns', 'read_discounts', 'write_discounts',
    'read_publications', 'write_publications',
  ]),
  fulfillment_scopes_any_of: Object.freeze([
    'write_assigned_fulfillment_orders',
    'write_merchant_managed_fulfillment_orders',
    'write_third_party_fulfillment_orders',
  ]),
});
