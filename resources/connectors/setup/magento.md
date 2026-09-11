<!-- setup-guide: {"auth_modes":["local_api"],"provider":"magento","catalog_reviewed_at":"2026-09-08","sources":[]} -->
# magento

## Entry
The target installation admin, System → Extensions → Integrations.

## Configure
Prepare Custom API access using the supplied requirements; Catalog access is broader than Products alone. Activation/Allow exposes a four-part credential set, not a standalone bearer token.

## Credentials
Use [[field:store_url]], [[field:consumer_key]], [[field:consumer_secret]], [[field:access_token]] and [[field:token_secret]] from one integration.

## Verify
Read store/catalog information. Confirm the installation subdirectory and integration permissions before replacing credentials.
