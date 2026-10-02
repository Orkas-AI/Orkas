<!-- setup-guide: {"auth_modes":["local_api"],"provider":"amazon_seller","catalog_reviewed_at":"2026-09-30","sources":["https://developer-docs.amazon/sp-api/docs/sp-api-models","https://developer-docs.amazon/sp-api/docs/orders-api-migration-guide"]} -->
# amazon-seller-central

## Entry
Seller Central / Solution Provider Portal for the merchant's approved private SP-API app.

## Configure
Requires Professional Selling eligibility, an approved developer profile and the required business roles. Complete private-app self-authorization in Seller Central. Availability depends on roles, country and programs; setup never probes a write.

## Credentials
Use [[field:marketplace_id]], [[field:seller_id]], [[field:client_id]], [[field:client_secret]] and self-authorization [[field:refresh_token]]. Requests remain bound to this seller, marketplace and environment.

## Business operations
267 native merchant operations are reviewed against the official 2026-09-30 model snapshot, plus 17 compatible actions. New operations retain full typed fields, pagination, approved order contacts and amounts. Orders 2026 PII requires Amazon-approved roles, without RDT. Legacy order actions keep their original limited data. Publishing, shipment and payout submissions use the existing high-impact/destructive confirmation lanes. An acknowledgement is not completion; uncertain writes are not automatically replayed.

## Limits
No vendor, removed, sandbox-only, grantless, RDT, carrier-credential or third-party signature operations. Signed document uploads/downloads stay excluded; feed/report metadata can use existing document ids. Host batch limits stay 100 reads, 25 ordinary writes and 10 high-impact/destructive items; total inputs are capped at 256 KiB and responses at 1 MiB. This is currently usable merchant scope, not every platform API or a live-shop acceptance result.

## Verify
Read seller participation or a bounded catalog/order result in the bound marketplace. Missing business roles require review in the provider's developer profile, not automatic permission expansion.
