# Connector Regression

Use isolated local data and authorized test accounts. Deterministic fixtures establish local contracts; live provider authorization and external writes require separate test-account authority and do not follow from a passing fixture.

## Catalog, setup and recovery

- In Chinese, English, Japanese and Portuguese, search and category-filter the available catalog, open setup, and switch language while editing. Labels change; entered values, masked secrets and selected region remain unchanged. Cancellation creates no grant.
- Setup and credit badges remain compact metadata. Setup uses neutral colors; credit uses gold text, border and background. The badge stays left and the action stays right at desktop and narrow widths.
- Required inputs, credential fields, enum choices, prerequisites and callback ownership follow the catalog. Reject malformed keys, arbitrary callback destinations and hidden environment overrides before authorization.
- Custom MCP setup validates transport, headers and environment, establishes a real initialize/tools-list handshake, and exposes the connector only after successful connection. Disable, reconnect and disconnect must update actual tool availability, not only the card.
- The public API Key path uses a user-configured encrypted key and the locally held connection credential. Missing credentials require configuration or reconnect. It must not restore official-account login or subscription behavior.
- OAuth/DCR checks reject stale or replayed state, wrong device, denied consent and late completion after cancellation. Keep rotating grants in the local encrypted store; no account-side DCR storage or cross-device secret synchronization.
- A failure in one connector must not block unrelated connectors. Cancellation terminates the owned call without opening a transport circuit breaker. Distinguish remote operation failure from network/process failure.
- Log review covers warnings, retries, timeouts and cleanup. Credentials, callback codes, raw provider text and private user data must remain absent.

## eBay user-owned refund signing

1. Enter Production App ID, Cert ID and RuName with the displayed HTTPS accepted redirect URL registered for that RuName. Verify random state, exchange tokens, then verify seller privilege. Secrets must not enter plaintext registry, rendered errors or logs.
2. Optional signing private key and JWE are a pair. Reject an incomplete pair, malformed PKCS#8, non-Ed25519 keys other than RSA of at least 2048 bits, or malformed JWE. With both fields empty, retain existing-account compatibility.
3. Store signing credentials only in the device-encrypted credential file. OAuth exchange and privilege requests must never carry them. Token refresh retains them.
4. With signing configured, only issue_refund adds Signature, Signature-Input, Content-Digest and x-ebay-signature-key. Verify the signature independently against the actual UTF-8 body, method, encoded path and authority. Ordinary reads remain unsigned. Invalid keys prevent the refund request.
5. Seller domicile and selected marketplace are distinct. Keep existing environment/marketplace binding and operation-level approval. Test fixtures must reject malformed credentials and unauthorized writes without side effects. A real refund is outside deterministic verification and requires explicit test-store authorization.

## Shared runtime and manual canaries

- Packaged connector entrypoints must initialize without source-tree dependencies in both direct and explicit-proxy modes. Missing SDK, proxy-only dependency, or newly imported helper must fail before release.
- Official CLI connectors use managed per-connector installations, bounded authentication and cleanup. A stale remote record cannot manufacture a local installation. Invalid auth stays unavailable; a successful retry restores tools.
- Seller APIs preserve shop identity, environment and risk lanes. Unknown actions, arbitrary URLs/headers, credential-shaped arguments, oversized writes and partial failures must not become successful receipts.
- For each available provider, use its own approved test account for a safe read, denied permission, revoked grant and successful reconnect. A reversible write additionally requires explicit authorization and readback; preserve and restore the original value.
- Inspect local registry and encrypted grants after restart and disconnect. Disconnected/disabled tools stay absent from both discovery and execution, including external CLI access through the governed bridge.

## Owning evidence

Run the existing connector catalog, local API, direct-commerce adapter, manager, registry, OAuth and renderer suites through `npm run test:js`. Run `npm run test:e2e:typecheck` before `npm run test:e2e -- test/e2e/connectors_e2e_validation.spec.ts`. These checks use local fixtures and do not claim all remote services are currently reachable.

## September 10 shared connector update

### Partial-permission acceptance matrix

The oracle is usable granted operations plus accurate recovery state, not merely
a successful login or a green transport. Exercise these journeys independently:

| Journey / initial state | Stimulus and required observation | Owning evidence |
| --- | --- | --- |
| First connection, verified identity with partial business access | Keep Use and Reauthorize together; an unverified/expired identity cannot establish a new connection. | `manager.test.ts`, `local-cli-files.test.ts`, `connectors-degraded-card.test.ts` |
| Connected account, one operation denied | Preserve the failed operation's error, expose only validated scope identifiers, then complete a different granted read on the same connection; no login or replay. Cover Feishu user/bot, DingTalk OAuth/PAT/admin, WeCom and Xero. | `local-cli-files.test.ts`, `manager.test.ts`, `local-cli_e2e_permissions.test.ts`, `local-cli_e2e_attachment.test.ts` |
| Error-shaped business data or unavailable provider | Success payloads, nested permission text, local-file errors, malformed JSON and timeouts must not manufacture a permission request. | `local-cli-files.test.ts` |
| Lark incremental consent | Request old grants plus missing user scopes; cancellation, absent grant, unknown resource/bot access and a newer denial retain recovery. A successful scope check clears only proven scope deficiencies. | `local-cli-files.test.ts` |
| DingTalk PAT incremental consent | Cover new/already-granted receipts, partial grants followed by retry, malformed/failed receipts, case-sensitive identifiers, mixed OAuth/PAT and changed administrator policy. Only acknowledged PAT scopes disappear. | `local-cli-files.test.ts` |
| WeCom or DingTalk identity-only login | Do not equate identity success with business access. Preserve the existing connection and permission notice after cancellation or unverifiable recovery. | `local-cli-files.test.ts`, `manager.test.ts` |
| Concurrent recovery and device-local persistence | An old check/grant cannot clear a newer denial, including the same scope denied again; profiles and providers remain isolated. Malformed/oversized/symlink state and failed writes do not leak or replace provider errors. | `local-cli-files.test.ts`, `local-cli.test.ts` |
| Page entry, refresh, account switch | Listing is read-only; page checks coalesce for one minute; explicit refresh/consent completion rechecks. Switching accounts/disconnecting aborts pending checks. No startup/timer login. | `local-cli.test.ts`, `ipc/connectors.test.ts`, `connectors-render-cache.test.ts` |
| Card action and recovery | Use stays available, Reauthorize is explicit, known names are localized, unknown identifiers render as text, and the notice disappears only after verified recovery. Preserve selected tools. | `connectors-degraded-card.test.ts`, `manager.test.ts` |

Real-account canaries (macOS and Windows) remain required for each provider:
start with verified identity plus one denied capability; perform one allowed read,
cancel reauthorization, repeat the allowed read, then grant the capability and
explicitly retry the denied operation once. Verify old grants and tool selections
survive, other accounts/devices are untouched, and inspect logs for duplicate
operations, unexpected browsers, sensitive output and leftover CLI processes.
Use test recipients and reversible writes only. Repeat administrator/visibility
denials before and after the administrator changes access; never report a user
login alone as proof of that change.

DingTalk OAuth incremental consent is an **open implementation and acceptance
gap**: require a real scope-bearing request, provider-confirmed union of old/new
grants, cancellation/partial-consent recovery, and a successful explicit operation
retry. The pinned DWS 1.0.61 login does not implement that request. Local identity
fixtures and PAT grant tests do not satisfy this gate. WeCom business-permission
verification likewise needs provider evidence beyond `identity whoami`.


| Confirm a high-impact/destructive operation | The existing title is retained; the visible body shows the connector and operation identifier. First-party CLI/direct API execution lanes use the singular `action` parameter; other tools use their actual tool name. Only redacted parameters appear in the expandable details, collapsed by default; account, risk, tool metadata and explanatory notes are omitted. Allow once affects only that call. Allow for this task covers every action for the same connector account, including deletion, without changing global permissions; other tasks/accounts/connectors still ask. Concurrent prompts covered by the grant close as approved. Completion, stop, account switch and connector replacement/removal revoke the grant. | `action-confirm.test.ts`, `registry.test.ts`, `bash-permission.test.ts`, `bus-integration.test.ts`, `connectors_e2e_validation.spec.ts` |

6. Feishu/Lark authorization opens only structurally validated HTTPS URLs on exact official hosts and authorization routes; provider prose does not determine success. A successful automatic browser launch keeps the interactive terminal hidden; show manual recovery only if opening fails, the CLI requests input, or authorization fails. Fixed domains must remain a subset accepted by the pinned CLI auth login command. Reuse a pending attempt for the same account and catalog id. Any confirmed permission failure from an official CLI offers **Reauthorize**, regardless of business operation, identity or availability of scope metadata. Structured failure envelopes and pinned provider status protocols drive this state; successful business data, arbitrary prose and transport failures do not. Clicking starts the applicable authorization flow even with a valid old login. DingTalk retains structured missing OAuth and PAT scope identifiers. PAT recovery grants only the missing scopes and requires a structured granted/already-granted receipt; plain login success never clears PAT, unknown-access or administrator denials. WeCom identity-only reauthorization also retains the permission notice; it must not imply that business access was restored. Known DingTalk PAT scopes may be retried after an administrator changes policy; cached policy denials must not permanently block recovery. The pinned DWS 1.0.61 login does not implement incremental OAuth scope requests, so those deficiencies remain visible after login. Lark requests confirmed missing user scopes explicitly and retains existing granted scopes (including unprefixed OAuth scopes); unknown or bot scopes use the normal provider flow without inventing user scopes. Selected tools remain unchanged. On Connectors-page entry, inspect verified Lark user scopes for message sending and previously reported missing scopes, even when its transport is live. Repeated opens within one minute reuse the check; explicit refresh and completed authorization check again. There is no startup or timer scan. For Feishu/Lark, DingTalk and WeCom, a failed business operation or a cancelled/failed reauthorization leaves other authorized operations usable without replaying the failure. A missing scope adds a concise advisory card notice (localized names for known scopes, identifiers for other reported scopes, a generic notice if absent) and Reauthorize alongside Use; it never disables the whole connector. Unavailable checks retain prior evidence, confirmed grants clear only scope deficiencies, and resource/admin denials remain unresolved. Disconnect or account switch cancels an in-flight check. Cancellation or failed grant verification retains recovery; success clears only the request handled by that attempt. Newer denials remain recoverable. Bot visibility and administrator-owned permission failures also offer reauthorization, without claiming user consent can grant administrator access. No failed business action is replayed automatically.

11. Reject credentials, config/profile overrides, output paths, raw flags, excess parameters, outside files and symlink escapes. Approved local inputs must exist as absolute paths with a realpath inside Orkas-approved roots. Identify file carriers from the pinned provider parameter contract, preserving literal text and file arrays. Prepare private, per-call copies for CLI uploads and declared @file inputs, preserving bytes and filenames; serialize Lark native binary carriers as key=value and preserve WeCom media_id objects. Clean staging after success, failure or cancellation, and reject changed/non-regular sources before sending. Preserve Xero full-JSON destructive-status inspection. Use 60s execution deadlines for ordinary commands and 10min for transfers including staging; only active transfers emit periodic progress to extend the 90s MCP inactivity window, with a 13min total bound. Cancellation must stop descendant processes and must not replay an operation. Network file inputs require HTTPS; bound and sanitize provider output.
