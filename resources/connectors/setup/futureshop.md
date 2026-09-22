<!-- setup-guide: {"auth_modes":["local_api"],"provider":"futureshop","catalog_reviewed_at":"2026-09-16","sources":["https://manual.future-shop.jp/api/","https://manual.future-shop.jp/api/api-inventoryRefresh"]} -->
# futureshop

## Entry
API v2 requires developer registration and shop approval. Service-provider integrations require a futureshop alliance agreement. The official MCP is not used by this adapter.

## Configure
[[field:api_origin]] is the API domain issued with approval, not the public storefront address. The machine running Orkas must use the outbound IP registered with futureshop. This connector does not provision a fixed IP, proxy or cooperation agreement. The provider permits one request per second per client.

## Credentials
[[field:client_id]], [[field:client_secret]] and [[field:shop_key]] come from the same approved API connection. Secrets stay encrypted on this device. Access tokens last one hour and are reacquired automatically using these credentials.

## Verify
Connection acquires an access token and reads a product page. Order and inventory permissions depend on the shop's approved APIs. Stock writes replace regular stock for one existing product or variation; planned, preorder and physical-store stock are outside this connection's write scope.

Official verification uses an issued trial shop and test API credentials, normally supplied two to three business days after developer registration. The test grant supports all published APIs. Production requires a separate shop application and issued connection details.
