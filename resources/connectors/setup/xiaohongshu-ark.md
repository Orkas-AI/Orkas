<!-- setup-guide: {"auth_modes":["local_api"],"provider":"xiaohongshu_ark","catalog_reviewed_at":"2026-09-08","entry_url":"https://ark.xiaohongshu.com/","sources":["https://school.xiaohongshu.com/en/open/quick-start/introduction.html","https://school.xiaohongshu.com/en/open/quick-start/how-to-get-app-key.html"]} -->
# xiaohongshu-ark

## Entry
The official [Ark introduction](https://school.xiaohongshu.com/en/open/quick-start/introduction.html) publishes [the production host](https://ark.xiaohongshu.com/). Inspect its current page and confirm it is the issued partner-account route; the current merchant UI is not proof of legacy API compatibility.

## Configure
The legacy credential guide's Developer → App Key & Secret → Get credential path is sandbox-only evidence, not a verified production menu. This adapter accepts production Ark credentials only. The official integration guide includes platform-coordinated production testing before launch. Inspect the approved account's actual credential entry or platform-issued production credentials. A missing sandbox-style menu alone does not prove missing API approval; establish the specific account or integration gap from current evidence.

## Credentials
Use production [[field:app_key]] and [[field:app_secret]] only. No callback or shop ID is requested by this adapter.

## Verify
Use an available described, bounded catalog read. Neither a normal merchant login nor reading the documentation proves Ark API access. Do not send credentials to the HTTP sandbox.
