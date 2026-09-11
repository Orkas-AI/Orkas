<!-- setup-guide: {"auth_modes":["local_api"],"provider":"amazon_seller","catalog_reviewed_at":"2026-09-08","sources":[]} -->
# amazon-seller-central

## Entry
Seller Central / Solution Provider Portal for the approved private SP-API app.

## Configure
Inspect the developer profile, Professional Selling eligibility and required non-restricted roles. Complete private-app self-authorization at the required user confirmation point.

## Credentials
Use [[field:marketplace_id]], [[field:seller_id]], [[field:client_id]], [[field:client_secret]] and self-authorization [[field:refresh_token]].

## Verify
Read seller participation or a bounded catalog result in the bound marketplace. Do not request buyer PII/RDT access as a connectivity workaround.
