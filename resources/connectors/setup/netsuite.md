<!-- setup-guide: {"auth_modes":["mcp_dcr"],"catalog_reviewed_at":"2026-09-08","sources":["https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_0714080625.html","https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_157771733782.html"]} -->
# NetSuite MCP Standard Tools

## Entry
Use the target NetSuite account; Setup → Company → Company Information provides [[field:account_id]].

## Configure
An administrator enables Server SuiteScript, OAuth 2.0 and REST Web Services under Setup → Company → Enable Features → SuiteCloud, installs MCP Standard Tools SuiteApp, and configures a DCR Public Client integration with Client Name: Orkas. The authorization role needs MCP Server Connection and Log in using OAuth 2.0 Access Tokens (not Log in using Access Tokens), plus REST Web Services and the relevant record permissions for record operations.

## Credentials
Enter only the account identifier in the protected form, then authorize a scoped non-Administrator role in the app-owned provider flow. Administrator and full-permission roles cannot use this service. Production and sandbox identifiers are distinct.

## Verify
Discover the role-visible tools and perform a small available record/metadata read. A successful MCP handshake does not establish permission to every record type.
