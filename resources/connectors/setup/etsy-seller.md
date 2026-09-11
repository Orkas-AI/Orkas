<!-- setup-guide: {"auth_modes":["local_api"],"provider":"etsy","catalog_reviewed_at":"2026-09-08","sources":[]} -->
# etsy-seller

## Entry
Etsy Developers → Your Apps → the approved Seller API app.

## Configure
Inspect Seller API approval and configure the supplied callback. Resolve the numeric shop identity through the official documented shop lookup when needed; never use a secret-bearing URL or chat message.

## Credentials
Use [[field:shop_id]], [[field:keystring]] and [[field:shared_secret]] as described by the protected field help.

## Verify
Read the authorized shop identity. App approval, user authorization and a matching numeric shop are separate prerequisites.
