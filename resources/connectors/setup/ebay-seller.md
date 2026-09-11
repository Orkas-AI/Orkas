<!-- setup-guide: {"auth_modes":["local_api"],"provider":"ebay","catalog_reviewed_at":"2026-09-08","sources":[]} -->
# ebay-seller

## Entry
eBay Developer Portal → My Account → Application Keys → Production Keyset.

## Configure
Inspect the seller app and permissions. Configure the supplied callback on the OAuth redirect entry; the resulting RuName is a separate value. Continue through the protected seller authorization.

## Credentials
Use [[field:marketplace_id]], [[field:content_language]], [[field:client_id]], [[field:client_secret]] and [[field:ru_name]]; the latter is not the callback URL.

## Verify
Read seller account/inventory data. Confirm marketplace and locale, and distinguish production keys from Sandbox keys.
