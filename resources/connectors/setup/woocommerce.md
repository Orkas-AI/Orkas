<!-- setup-guide: {"auth_modes":["local_api"],"provider":"woocommerce","catalog_reviewed_at":"2026-09-08","sources":[]} -->
# woocommerce

## Entry
The target WordPress store admin → WooCommerce → Settings → Advanced → REST API.

## Configure
Inspect or prepare a key for a store user with the required capabilities and Read/Write access. Preserve the one-time secret in the protected form; no separate provider OAuth app is needed.

## Credentials
Use [[field:store_url]], [[field:consumer_key]] and [[field:consumer_secret]]; the URL is the store root, not an API endpoint.

## Verify
Read a bounded product list. On failure, check store URL, HTTPS reachability, key permissions and the issuing user before regenerating keys.
