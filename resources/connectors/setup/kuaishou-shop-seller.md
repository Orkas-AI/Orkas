<!-- setup-guide: {"auth_modes":["local_api"],"provider":"kuaishou_shop","catalog_reviewed_at":"2026-09-08","sources":[]} -->
# kuaishou-shop-seller

## Entry
Kuaishou Shop Open Platform → app management → app details/key settings.

## Configure
Inspect the merchant app and required APIs; configure the supplied callback and continue through merchant authorization. A shop account alone is not an app credential.

## Credentials
Use [[field:app_key]], [[field:app_secret]] and the separate [[field:sign_secret]] from that app.

## Verify
Read an available seller/product resource. On signing failure, distinguish Sign Secret from App Secret before replacing either.
