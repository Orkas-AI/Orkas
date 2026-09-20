<!-- setup-guide: {"auth_modes":["local_api"],"provider":"rakuten_rms","catalog_reviewed_at":"2026-09-16","sources":["https://webservice.faq.rakuten.net/hc/ja/articles/37599235125913","https://webservice.rms.rakuten.co.jp/"]} -->
## Entry
Merchant RMS > WEB API service. The merchant manages API enrollment and shop permissions. The public Rakuten affiliate API is a different service.

## Configure
This adapter uses Item API 2.0 `items.search`/`items.get`, Inventory API 2.1 `inventories.variants.get`/`inventories.variants.upsert`, and Rakuten Pay Order API `searchOrder`/`getOrder` (SKU response version 7). Enable the operations needed for the intended shop. Stock changes use one existing SKU and absolute quantity.

## Credentials
[[field:service_secret]] maps to RMS `serviceSecret`; [[field:license_key]] maps to RMS `licenseKey`. Both take original values. Orkas constructs ESA authentication. Shop login passwords and affiliate application credentials are not substitutes. Expired or rotated keys require reconnection.

## Verify
Connection checks one product-read page; an empty shop is valid. It does not establish order access, write permission or shop identity. Separate bounded reads check those permissions when used. A stock update is reported complete only after matching readback; concurrent orders can affect it. An uncertain update requires checking the shop before another attempt.
