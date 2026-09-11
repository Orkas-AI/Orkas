<!-- setup-guide: {"auth_modes":["local_api"],"provider":"shopify","catalog_reviewed_at":"2026-09-08","entry_url":"https://dev.shopify.com/dashboard/","sources":["https://shopify.dev/docs/apps/build/authentication-authorization/client-credentials-grant"]} -->
# shopify-admin

## Entry
Shopify Dev Dashboard for the organization owning the target store.

## Configure
Inspect the existing app, released version and target-store installation. Versions must include the exact Admin API scopes in the [[field:client_id]] help: all required scopes plus one applicable fulfillment scope. Release the version and install the app on the target store via Home → Install app. Changed scopes on an installed app require merchant approval in Shopify admin; a release alone does not update its grant. Protected customer data may require separate approval.

## Credentials
Use [[field:shop_domain]] and the app Settings' [[field:client_id]] / [[field:client_secret]]. The app and store must share an organization; Orkas obtains the access token through client credentials. A public app or Storefront token is not a substitute.

## Verify
Read shop identity and a bounded catalog result. Scope failures require correcting the existing app grant, not inventing missing tokens.
