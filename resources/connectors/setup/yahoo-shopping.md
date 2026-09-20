<!-- setup-guide: {"auth_modes":["local_api"],"provider":"yahoo_shopping","catalog_reviewed_at":"2026-09-16","sources":["https://developer.yahoo.co.jp/webapi/shopping/introduction.html","https://developer.yahoo.co.jp/webapi/shopping/help/","https://developer.yahoo.co.jp/webapi/shopping/help/application.html","https://developer.yahoo.co.jp/webapi/shopping/help/sandbox.html"]} -->
# Yahoo! Shopping Japan

## Entry
This is the merchant Shopping API, separate from public product search and Yahoo global OAuth. The developer app needs the restricted store-operation scope. In production, the authorizing Yahoo! JAPAN ID must link to a Business ID registered as shop staff.

## Configure
[[field:seller_id]] is the production store account. The application uses the callback displayed by Orkas. Production order API access requires a separate application and registered outbound IP; product and inventory access do not imply order permission.

## Credentials
[[field:client_id]] and [[field:client_secret]] belong to the Shopping app. Optional [[field:public_key]] and [[field:key_version]] come together from Store Creator Pro's encryption-key management. Public-key authentication can extend order-API reauthorization from 12 hours to four weeks; expired public keys need replacement. Tokens stay encrypted on this device.

## Verify
Connection reads seller-authorized categories. Order results report whether public-key authentication succeeded. Stock writes verify an existing inventory record and preserve overselling and stock-close settings.

Official sandbox approval takes about five business days and supplies a test app/store. It needs no Business ID or separate order-API approval. Sandbox verification is developer-only; ordinary Orkas connections use production.
