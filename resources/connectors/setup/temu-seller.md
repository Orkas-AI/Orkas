<!-- setup-guide: {"auth_modes":["local_api"],"provider":"temu","catalog_reviewed_at":"2026-09-30","sources":["https://partner-us.temu.com/documentation?menu_code=fb16b05f7a904765aac4af3a24b87d4a"]} -->
# temu-seller

## Entry
Partner Platform → App Management, then the matching Seller Center authorization management.

## Configure
Inspect the approved Seller in House app and its Basic, Product and Order permissions. Grant the additional business permissions needed for pricing, shipment, after-sales, promotions or ads. Fulfillment permissions can disclose recipient names, addresses and phone numbers. Obtain the seller authorization for the app, not just its app credentials.

## Credentials
Use [[field:region]], [[field:app_key]], [[field:app_secret]] and seller-issued [[field:access_token]].

## Verify
Read shop identity or a bounded product list, then inspect the available actions and each action's required fields. APIs vary by region and seller grants. Fully managed stores, some warehouse authorization and upload workflows remain outside this adapter; large inline uploads are bounded by the connector input limit. Reauthorize and reconnect after expiry or permission changes.
