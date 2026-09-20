<!-- setup-guide: {"auth_modes":["local_api"],"provider":"base_shop","catalog_reviewed_at":"2026-09-16","sources":["https://docs.thebase.in/api/","https://docs.thebase.in/api/oauth/authorize/","https://docs.thebase.in/api/oauth/refresh_token/","https://help.thebase.in/hc/ja/articles/9811168821017"]} -->
# BASE shop

## Entry
The Japanese BASE developer API requires an approved application. It is separate from Base.com and the Base blockchain.

## Configure
The developer application uses the callback displayed by Orkas. This connection requests shop, product and order reads plus product writes for stock changes. It does not request buyer email, savings or order-write scopes.

## Credentials
[[field:client_id]] and [[field:client_secret]] belong to the approved developer application. Browser authorization selects the shop. Credentials and rotating tokens remain encrypted on this device. Expired or revoked authorization requires reconnecting.

## Verify
Connection verifies the shop identifier and performs small product/order reads. Stock updates target one item or one existing variation and pass through the sensitive-action permission gate. Platform application approval and a real merchant authorization remain necessary.

BASE has no dedicated API sandbox. Its official test method uses a real shop protected with Secret EC (シークレットEC App). Test writes still modify that shop.
