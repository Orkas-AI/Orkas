<!-- setup-guide: {"auth_modes":["local_api"],"provider":"constant_contact","catalog_reviewed_at":"2026-09-08","entry_url":"https://v3.developer.constantcontact.com/login/index.html","sources":["https://developer.constantcontact.com/api_guide/getting_started.html"]} -->
# constant-contact

## Entry
Constant Contact Developer Portal; the official guide describes the private Device Flow route.

## Configure
In My Applications, inspect or prepare an app using Device Authorization Flow. New private apps initially authorize only the creating Constant Contact user; other users require platform approval. The protected connection flow starts device authorization; retain its page for the user login instead of requesting a secret.

## Credentials
Only [[field:client_id]] is required: the app Details' API Key. Device Flow does not require a client secret or callback URL.

## Verify
Read an available account/list resource after device authorization completes; opening the login page is not completion.
