<!-- setup-guide: {"auth_modes":["local_api"],"provider":"tiktok_shop","catalog_reviewed_at":"2026-09-23","sources":[]} -->
# tiktok-shop

## Entry
TikTok Shop Partner Center, App & Service; match [[field:region]] to the shop.

## Configure
Inspect the approved seller Custom App and required seller permissions. Locate its authorization link/service before connecting; content-app developer credentials are a different integration.

## Credentials
Use [[field:service_id]], [[field:app_key]] and [[field:app_secret]] from the seller app. Leave [[field:shop_id]] blank to choose an authorized shop in the selected market after login. An optional known shop code or ID restricts the connection. Reconnecting without an ID retains the existing shop binding.

## Verify
Read the authorized seller/shop identity. If seller-development access is absent, identify the account-manager approval dependency before asking for credentials.
