<!-- setup-guide: {"auth_modes":["server_bridge","mcp_dcr","composio"],"catalog_reviewed_at":"2026-09-08","sources":[]} -->
# Hosted OAuth or MCP authorization

## Entry
Use the protected connector configuration card to start the app-owned authorization flow. No developer application or API token is required unless the connector requirements explicitly say so.

## Configure
Select the intended account/workspace and review the requested access on the provider page. Existing account login and the connector grant are separate.

## Credentials
The app receives the authorization callback. No token belongs in chat.

## Verify
Refresh stored connection facts, then use an available described read operation for the intended account/resource. Login, consent, connection discovery and usable resource permissions are different evidence.
