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
