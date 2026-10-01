<!-- setup-guide: {"auth_modes":["local_api"],"provider":"woocommerce","catalog_reviewed_at":"2026-09-23","sources":["https://developer.woocommerce.com/docs/apis/rest-api/authentication/"]} -->
# woocommerce

## Entry
Enter the target store root in [[field:store_url]] and connect. Orkas opens that store's WooCommerce authorization page; no separate provider application is needed.

## Configure
Sign in as a store user with the required capabilities and approve Read/Write access for Orkas. WooCommerce generates the keys and sends them through the short-lived Orkas relay; the desktop verifies the store before saving the keys encrypted locally.

## Credentials
Leave [[field:consumer_key]] and [[field:consumer_secret]] empty for browser authorization. Existing Read/Write keys can still be entered together in the protected form. Keep any WordPress subdirectory in the store URL; do not enter an API endpoint.

## Verify
Read a bounded product list. On failure, check the store URL, HTTPS reachability and the authorizing user's permissions. Keys can be revoked under WooCommerce → Settings → Advanced → REST API.
