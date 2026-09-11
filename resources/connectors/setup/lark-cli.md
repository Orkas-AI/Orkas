<!-- setup-guide: {"auth_modes":["local_cli"],"provider":"lark","catalog_reviewed_at":"2026-09-08","sources":[]} -->
# Feishu / Lark CLI

## Entry
Start the selected connector's protected configuration flow. The host owns the installed CLI, its per-user profile and interactive authorization; a separately installed shell CLI is not the same session.

## Configure
Keep the selected Feishu/Lark brand and organization. Complete the provider login/QR step in the host-presented authorization surface. The two catalog entries share this procedure, not account grants.

## Credentials
No manually copied app secret or browser cookie is required by this catalog route.

## Verify
Use the connector's capability discovery and a bounded account/resource read. On failure, inspect the host authorization result and actual organization; do not invent an app-creation workflow.
