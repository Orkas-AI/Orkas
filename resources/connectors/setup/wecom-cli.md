<!-- setup-guide: {"auth_modes":["local_cli"],"provider":"wecom","catalog_reviewed_at":"2026-09-08","sources":[]} -->
# WeCom CLI

## Entry
Start WeCom from the protected connector configuration flow, using the host-managed CLI and interactive authorization surface.

## Configure
Complete the provider-requested login for the intended organization. App creation, raw CLI installation and manual cookie extraction are not prerequisites declared by this route.

## Credentials
Authorization belongs to the host's per-user local profile; no secret values belong in the conversation.

## Verify
Discover the connector capabilities and perform a bounded available account/resource read. Report the actual login or organization-permission failure rather than recreating configuration.
