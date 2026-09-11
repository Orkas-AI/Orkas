<!-- setup-guide: {"auth_modes":["local_cli"],"provider":"dingtalk","catalog_reviewed_at":"2026-09-08","sources":[]} -->
# DingTalk CLI

## Entry
Start DingTalk from the protected connector configuration flow; the host prepares its own CLI runtime/profile and authorization surface.

## Configure
Complete the provider-requested login/QR for the intended organization. Do not substitute a separately installed DWS profile or a developer app for the selected built-in connector route.

## Credentials
No app key or secret fields are declared here. Keep authorization in the host-managed local profile.

## Verify
Discover available capabilities and run a bounded organization/resource read. Login success does not establish access to all products; inspect the failed capability's permission requirements.
