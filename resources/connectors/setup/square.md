<!-- setup-guide: {"auth_modes":["local_api"],"provider":"square","catalog_reviewed_at":"2026-09-08","entry_url":"https://developer.squareup.com/apps","sources":[]} -->
# square

## Entry
Square Developer Console; use the official access-token guide to locate the production application credentials.

## Configure
For the user's own Square account, select the application → Credentials → Production access token, not Sandbox. Personal tokens have full account access, not selectable least-privilege scopes. Access to another seller's account requires its scoped OAuth authorization, not the developer's personal token. Token entry stays in the protected form.

## Credentials
Use [[field:access_token]]; this connector does not ask for an app secret or callback.

## Verify
Read an available merchant/location resource. Do not create a charge to verify connectivity.
