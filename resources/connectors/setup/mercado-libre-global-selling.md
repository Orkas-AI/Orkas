<!-- setup-guide: {"auth_modes":["local_api"],"provider":"mercado_libre","catalog_reviewed_at":"2026-09-23","sources":[]} -->
# mercado-libre-global-selling

## Entry
Global Selling → Developer Center → My applications.

## Configure
Inspect the KYC-approved owner app; enable the required access and PKCE and set the supplied callback. Continue through the owner authorization, not a collaborator/operator account.

## Credentials
Use [[field:client_id]] and [[field:client_secret]]. Leave [[field:user_id]] blank to confirm the verified owner after authorization. An optional known owner ID restricts the connection; a child-marketplace Seller ID is not the owner. Reconnecting without an ID retains the existing account binding.

## Verify
Read the authorized owner identity and compare the binding before checking business data.
