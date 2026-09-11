<!-- setup-guide: {"auth_modes":["local_api"],"provider":"temu","catalog_reviewed_at":"2026-09-08","sources":[]} -->
# temu-seller

## Entry
Partner Platform → App Management, then the matching Seller Center authorization management.

## Configure
Inspect the approved Seller in House app and its Basic, Product and Order permissions. Obtain the seller authorization for the app, not just its app credentials.

## Credentials
Use [[field:region]], [[field:app_key]], [[field:app_secret]] and seller-issued [[field:access_token]].

## Verify
Read shop identity or a bounded product list. Fully managed stores are outside this adapter; expired tokens require reauthorization.
