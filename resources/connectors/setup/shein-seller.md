<!-- setup-guide: {"auth_modes":["local_api"],"provider":"shein","catalog_reviewed_at":"2026-09-30","sources":["https://open.sheincorp.com/documents/apidoc/detail/3002018","https://open.sheincorp.com/documents/apidoc/detail/3001924","https://open.sheincorp.com/documents/apidoc/detail/3001738"]} -->
# shein-seller

## Entry
SHEIN Open Platform → Console → App Management.

## Configure
Use an approved self-operated/semi-managed app. Enable the needed product, price,
order, merchant inventory, fulfillment, returns and finance APIs. Set the supplied
callback and authorize the main shop account. New actions do not expand the grant;
permission denial requires the corresponding provider approval. Fully managed,
factory and logistics-provider identities are not interchangeable with this grant.

## Credentials
Use [[field:app_id]] and [[field:app_secret]] from that app.

## Verify
Read merchant identity or warehouse/product data. Physical-stock writes are not a
verification step. Native fulfillment can return recipient names, addresses,
phones and order amounts; older order aliases keep their minimized responses.

## Business operations
Native actions use exact HTTP method/path names and `body`, `query`, `path` fields.
Read eligibility, category/attribute rules and quota before publishing. Omitted
full-edit fields can clear data. Product, price, deletion and shipment submissions
may await review/processing: inspect the matching status action. `acknowledged`
means accepted; `partial_or_failed` retains reconciliation data. Never replay an
uncertain write automatically. Reserved/occupied stock may prevent an overwrite.
The v1 inventory API permits zero saleable stock and retires on December 31, 2026.

## Remaining gaps
Complete API coverage is not claimed. Large uploads exceed the 256 KiB inline
limit. Feed documents need a host upload/download workflow. Other app modes and
provider webhook delivery remain outside this seller integration.
