<!-- setup-guide: {"auth_modes":["local_api"],"provider":"alibaba_icbu","catalog_reviewed_at":"2026-09-08","sources":[]} -->
# alibaba-com-seller

## Entry
International Open Platform console → App Management → App Certificate.

## Configure
Inspect the approved Merchant Backend System app bound to the store. Check the listed ICBU APIs, set the supplied callback and authorize the main merchant account.

## Credentials
Use [[field:app_key]] and [[field:app_secret]] from that merchant app.

## Verify
Read merchant/product or trade-order data. A fixed-duration self-use authorization may need a new login on expiry; do not test unsupported writes.
