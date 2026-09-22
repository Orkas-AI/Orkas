<!-- setup-guide: {"auth_modes":["mcp_dcr"],"entry_url":"https://app.shop-pro.jp/apps/956","catalog_reviewed_at":"2026-09-16","sources":["https://github.com/pepabo/colormeshop-mcp","https://app.shop-pro.jp/apps/956"]} -->
# Color Me Shop

## Entry
The official Color Me Shop AI Connector app is free and must be installed in the intended shop before connecting. The shop subscription is separate.

## Configure
The app-store page provides installation for the signed-in shop. Once installed, Orkas uses the official hosted MCP service and browser authorization. A merchant-created developer app, API key and custom callback configuration are unnecessary.

## Credentials
Provider login and consent take place on the official authorization page. Orkas requests product, sales and coupon read/write access, plus offline access. No credential fields are required in this setup panel.

## Verify
App installation alone does not establish an Orkas connection. Authorization and MCP tool discovery must succeed. The connector exposes only reviewed actions; sensitive changes follow the account’s operation permissions. Missing requested scopes require renewed authorization. A connected state does not prove that an inventory or order change was executed.
