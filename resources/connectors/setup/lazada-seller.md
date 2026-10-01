<!-- setup-guide: {"auth_modes":["local_api"],"provider":"lazada","catalog_reviewed_at":"2026-09-30","sources":["https://open.lazada.com/apps/doc/api"]} -->
# lazada-seller

## Entry
Lazada Open Platform → App Console → app details.

## Configure
Inspect the approved self-use ABA app, seller whitelist and required APIs. Set the supplied callback, then use the official main-shop-account authorization opened by the protected connection flow.

Enable the business APIs needed for products, stock, orders, shipment, returns, finance, FBL and ads. Approval/eligibility remains authoritative for the connected seller. Native queries can return recipient names, addresses, phone numbers and amounts. Existing aliases retain their narrower responses.

## Credentials
Use [[field:country]], [[field:app_key]] and [[field:app_secret]] from the matching seller app.

## Verify
Read the authorized seller/country. Cross-border countries need separate bindings; a successful login alone does not verify the selected country.

224 documented merchant operations are available behind the existing execution lanes. Describe a native `GET /path` or `POST /path` action to obtain its exact typed `parameters`. Use one explicit page and retain provider continuation fields. Dynamic category attributes and XML payload rules come from the official reference.

Writes use existing operation permissions. An acknowledgement is not completed publication, shipment or refund; inspect async identifiers and per-item results before retrying an uncertain write. Uploads accept bounded inline bytes; total parameters cannot exceed 256 KiB. Larger files, separate payment/partner identities, authorization administration and terms signing are not connected. This is not the complete platform API.
