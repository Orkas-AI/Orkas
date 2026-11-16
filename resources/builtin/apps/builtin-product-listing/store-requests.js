/* On-demand user request for a selected connector, never a system instruction. */
(function (root) {
    'use strict';
    const request = 'Carry out the selected store operation in the attached store request using only its connectorId. Discover the connector\'s actual tools, permissions and required fields; do not assume Shopify or invent endpoints. For import, read at most 20 products and return a JSON object with a products array; each product has id, name, sku, price, currency, facts, title and description, with unavailable fields empty. Import and verify are read-only. For draft, save an unpublished draft only; ask if the connector cannot support drafts. For publish, use only the frozen reviewed product and the user-selected destination; ask for missing requirements before writing. Never delete records or modify unrelated products. For existing products, inspect current data and ask before overwriting a conflicting change. Read back the remote product after a write, distinguishing accepted, processing and verified results. Do not repeat an uncertain write; inspect it first. Report missing permissions or unsupported operations explicitly. Return remote identifiers and evidence when available.';
    if (typeof module === 'object' && module.exports)
        module.exports = request;
    else
        root.ListingStoreRequest = request;
})(typeof window === 'object' ? window : globalThis);
