<!-- setup-guide: {"auth_modes":["local_api"],"provider":"lazada","catalog_reviewed_at":"2026-09-08","sources":[]} -->
# lazada-seller

## Entry
Lazada Open Platform → App Console → app details.

## Configure
Inspect the approved self-use ABA app, seller whitelist and required APIs. Set the supplied callback, then use the official main-shop-account authorization opened by the protected connection flow.

## Credentials
Use [[field:country]], [[field:app_key]] and [[field:app_secret]] from the matching seller app.

## Verify
Read the authorized seller/country. Cross-border countries need separate bindings; a successful login alone does not verify the selected country.
