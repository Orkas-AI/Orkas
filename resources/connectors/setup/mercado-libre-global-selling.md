<!-- setup-guide: {"auth_modes":["local_api"],"provider":"mercado_libre","catalog_reviewed_at":"2026-09-08","sources":[]} -->
# mercado-libre-global-selling

## Entry
Global Selling → Developer Center → My applications.

## Configure
Inspect the KYC-approved owner app; enable the required access and PKCE and set the supplied callback. Continue through the owner authorization, not a collaborator/operator account.

## Credentials
Use [[field:user_id]], [[field:client_id]] and [[field:client_secret]]; owner CBT identity is not a child-marketplace Seller ID.

## Verify
Read the authorized owner identity and compare the binding before checking business data.
