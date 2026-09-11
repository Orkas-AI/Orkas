<!-- setup-guide: {"auth_modes":["local_api"],"provider":"taobao_top","catalog_reviewed_at":"2026-09-08","sources":[]} -->
# taobao-tmall-seller

## Entry
[Taobao Open Platform](https://open.taobao.com/) → console → app management.

## Configure
Inspect the app category, approval and required shop/product/order API access. Prepare the supplied callback in that app, then use the protected connection flow for seller authorization. A developer registration alone is not an approved merchant app.

## Credentials
Use [[field:app_key]] and [[field:app_secret]] from the selected app basic information.

## Verify
Read an available shop identity/resource. If app type or API permission is unavailable, identify that exact approval prerequisite; do not recreate an app or claim seller-write access from registration alone.
