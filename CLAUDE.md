# PC

Prompt context only: keep hard constraints, short rationale, and traps already hit. Implementation details belong in source headers and tests.

## Boundary

Single-process Electron app. Main is a Node backend, renderer is vanilla HTML/CSS/JS, and IPC is the only app communication path.

- No HTTP server, no occupied port, and no local auth layer in main.
- Renderer access goes through the `contextBridge` allow-list API `window.orkas.{invoke, stream}`.
- No TypeScript/JSX/bundler in the renderer; classic scripts only.
- `src/main/preload.js` must remain `.js`; preload does not run the tsx hook.
- LLM calls use the in-process `core-agent` loaded dynamically through `import('#core-agent')`.
- Local CLI agents are the explicit child-process exception. `features/local_agents/runner.ts` is the only CLI dispatch spawn path.
- MCP stdio connectors spawn only through `features/connectors/mcp-client.ts`.
- User data is mostly JSON/JSONL for readability and sync friendliness; sqlite is reserved for the KB vector store.
- macOS and Windows are primary. Platform branches need platform-specific verification.
- New npm dependencies require prior discussion; renderer third-party JS/CSS goes under `src/renderer/vendor/`, not npm.
- API profile routing goes through existing account/marketplace API-base helpers. Do not hard-code production domains.

## Layering

- `ipc/`: validate args and call features; no business logic.
- `features/`: business workflows; may use storage, paths, prompts, model, util, and sibling features.
- `model/` and `model/core-agent/`: model-call adapters and tool plumbing; do not read/write business data under `data/`.
- `util/`: pure/foundational helpers; never reverse-import features/model.
- `storage.ts`, `paths.ts`, and path sandbox helpers are the storage/path choke points.
- `i18n.ts` may read locales but must not import features/model.

Additional rules:

- Feature functions handling user-private data take `userId` as the first argument.
- Boot-time async work registers through `util/boot_init.ts`, not raw startup timers or async IIFEs.
- `#core-agent` is dynamic-import only. Static import loads dependencies before the SDK timeout patch and can break ESM resolution.
- `sdk-timeout-patch.ts` must run in `index.ts` after logger init and before feature imports.
- New core-agent tools must be registered in `tool-catalog.ts::TOOL_CATALOG` and runner wiring. Tool descriptions live in SDK `tools[]`, not in a duplicated prompt tool list.
- File-class tools must check `util/path-sandbox.isPathAllowed` at entry.
- Tool results go through `util/tool-result-cap.ts`.

## Prompt Files

`src/main/prompts/*.md` is LLM-facing source. It must not contain:

- Product/brand names.
- Real OS paths.
- Project source/data directory literals.
- Hard-coded tool catalogs.

Runtime-volatile prompt fields go in one trailing `## Runtime injection` section. Static rules stay first so cache prefixes remain stable. Chat prompts must point to platform creator skills for agent/skill authoring details; do not duplicate field schemas or category tables inline.

Residual shared prompt rules should have one canonical source, with downstream prompts carrying only a short reference.

## Data Domains

All user-scoped data lives under `<container>/data/<uid>/{cloud,local}/`.

- Top-level data may contain only `users.json`, `logs/`, and user directories.
- Hosted builds use `anonymous` while logged out and the Server account uid while logged in. The open-source build first boot keeps the legacy generated local id.
- `uid` is an opaque single path segment. Do not parse it or embed it into session ids.
- `cloud/` is syncable user-private state: chats, resumable sessions, attachments, artifacts, saved apps, contexts source files, memory, custom agents/skills, projects, marketplace install manifest, auto tasks, and user config.
- `local/` is machine-private state: account/session cache, marketplace installed content, caches, indexes, vector DB, workspace selection, tool-result spills, local-agent archives, and dev archives.
- Never cache uid-derived paths as module-level constants. Get the active uid at use time.
- Platform agents/skills are marketplace installs in `local/marketplace/...`, reconciled from the cloud install manifest. Hand edits are overwritten unless made through dev-mode platform editing and republished.
- Project membership is an index field on a conversation. Do not encode `project_id` into paths, cids, or session ids.
- Project lists are directory scans; do not restore an aggregate `projects/_index.json`.

## Account, Sync, And Open-Source Builds

- Hosted account login uses the Server `SessionMgr` pair (`user_id`, `session_id`), stored through `util/local-secret-store.ts`. There is no client refresh-token loop.
- Authenticated HTTP calls carry `user_id` + `session_id`; WebSocket URLs carry the same pair only where required.
- Optimistic login state may come from disk, but network revalidation must refresh or clear it.
- Private hosted secret backends stay behind the local-secret facade. Do not import `features/hosted_secrets/` outside that facade.
- Account, relay, voice, sync, billing, and marketplace-dev surfaces that depend on hosted Server features are stripped from the open-source build according to `OpenSource/SyncCode/strip-rules.json`. Do not add new hosted-only files without updating strip rules.
- PC never writes `private/<oauth_user_id>/manifest.json`; Server `/sync/manifest/commit` is the only writer.
- Cloud sync paths use OAuth `user_id`, not an unrelated local uid.
- Object transfers under the sync prefix go through `features/sync/transport.ts`.
- Manifest entry `size` is the COS-stored byte count. Do not treat it as plaintext bytes.
- New sync triggers funnel through the existing dirty/sync engine, never an ad-hoc uploader.
- Local data must not be marked dirty for cloud sync.
- Cloud sync and voice are entitlement-gated by Server. Renderer failures from subscription gating are expected UX states, not sync/voice bugs.

## Release Relay

This release branch uses the pre-main relay shape:

- iOS is a remote control. PC runs all agent work and delivers relayed commands through normal group-chat send/bus flow.
- `features/relay/commands.ts` long-polls Server and must not add a fixed inter-poll delay; Server controls cadence.
- `features/relay/sync.ts` mirrors relay-enabled conversations through bus events: messages, plan, state, and batched process events. Do not replace this with main's bounded conversation-list snapshot unless the matching Server/iOS code lands here.
- PC pushes agent/skill account-index snapshots for iOS pickers. This release does not push project/workspace state to iOS.
- No server-side agent execution and no cloud worker path. The iOS cloud option remains disabled until product/backend support exists.
- Keep PC sidebar updates for iOS-triggered activity on the normal conversation list path; do not add a parallel display path.

## Conversations And Group Chat

Session ids are `<kind>-<tail>`; user scoping comes from the path root, not the filename. Add new kinds by updating the session-store allowlist and all session-kind gates.

Main rules:

- Commander, agent-worker, skill-edit, agent-edit, and one-shot sessions are separate session files from UI message lists.
- Group chat dispatch goes through `features/group_chat/bus.ts::enqueue`. Do not create parallel enqueue/scheduling paths.
- Agent workers read only their visibility slice; never the full conversation jsonl.
- LLM dispatch is structured (`dispatch_to`, `plan_set`), not `@name` in prose.
- `plan_set` owns plan writes. Retry/skip mutates plan state and reconciles through the plan executor; it does not send the original user message again.
- User abort is never a transient retry. Network retry patterns must stay network-specific.
- Group abort is the single stop path for all actors.
- Infinite-loop protection is turn-count based, paired with idle timeout; do not replace it with total wall-clock timeout.
- Expert signals emit only from the established group-chat chokepoints or model callbacks drained by bus. Model code must not import signal emitters directly.

Attachments:

- Main conversation attachments are stored under the current cid with zero eager preprocessing.
- Read/edit tools are scoped to active workspace plus current attachment dir.
- `stat_file` precedes `read_file` for pdf/docx.
- Video attachments are display-only, not model input.

## Artifacts And Saved Apps

- `create_artifact` writes only to `<uid>/cloud/chat_artifacts/<cid>/<artifactId>/`.
- `chat-app://` serves only validated artifact files through `features/chat_artifacts.ts`; never expose `window.orkas` or IPC to the iframe.
- Artifact-to-app communication is the validated `postMessage` contract and routes back as a normal user message.
- Saved apps live only under `<uid>/cloud/saved_apps/<appId>/` and open through the saved-app resolver.
- Editing a saved app is fork-and-modify via a new conversation and attachment bundle; it is not in-place mutation.
- Do not widen artifact served extensions or iframe sandbox privileges without a security review.

## Skills, Agents, And Marketplace

- Skill sources are custom cloud skills plus platform local marketplace installs. Custom overrides platform by id.
- Agent/skill category belongs in the spec (`agent.json` or SKILL.md frontmatter); install freshness belongs in `_install.json` / install manifests.
- Creator skills (`agent-creator`, `skill-creator`) are the canonical source for authoring semantics, validation details, and category candidates.
- Creator skill paths under the PC data root: `<uid>/local/marketplace/skills/16e1bfcb3426/SKILL.md` (`agent-creator`) and `<uid>/local/marketplace/skills/efb0fe5d9664/SKILL.md` (`skill-creator`).
- Platform agent/skill primary text is English. Descriptions are bilingual (`description_zh`, `description_en`); other UI languages fall back to English.
- SKILL.md frontmatter allows only the approved spec fields. External dependencies are prose in the body, not runtime-managed metadata.
- Skill id is the directory name; display name is frontmatter `name`. Do not re-couple them.
- Same display-name marketplace/platform skills with different ids must stay visible by internal read id. Custom may shadow a same-name platform skill, but platform-platform duplicates must not be globally deduped.
- `agent.skill_list`: missing means legacy unfiltered, empty means no skills, non-empty means strict subset.
- CLI-backed agents ignore SkillLoader and own runtime settings through the create/edit form, not the LLM-authored workflow.
- Skill execution goes through `bin/run-skill.cjs`; do not bypass the runner.
- Component enabled/disabled state is user preference and must not be written into specs.

Dev-mode marketplace editing/upload/delete is hosted/private tooling. Runtime gates and packaging strip rules must both protect it.

## Connectors

- Provider client credentials live on the Server. PC starts OAuth via Server and receives grants through the deep link callback.
- Connector metadata may remain plaintext, but token-bearing grant/DCR/transport data lives inside per-instance `secrets_enc`.
- `transport` is encrypted because resolved transport can contain access tokens.
- Do not reuse account-login modules/namespaces for connector authorization.
- Tool exposure uses the umbrella pattern: a `## Connectors` block plus `list_connector_tools` and `call_connector_tool` meta-tools.
- Never inject every MCP action as a flat SDK tool list.
- Connector visibility is live connected state, user enable toggle, and session-kind scope.
- Commander (`gconv`) gets block + list + call. Agent-edit gets block + list only. Agent workers, skill edit, one-shots, CLI, reflection, and memory extraction get none.
- Non-connected connectors are invisible to the LLM; do not add disconnected/error status hints to prompt blocks.
- No free-form custom MCP-server UI or API-key install path without a product/security plan.

## Knowledge Base

- User-managed context source files live in cloud; derived vector DB and model config live in local machine-private `.kb`.
- Embedder/model config is fixed unless a full rebuild/migration is designed.
- Do not use worker_threads for multiple ONNX sessions; use child-process isolation for true parallelism.
- The model may access contexts only through KB tools, not shell/file scans of the contexts dir.
- Chunking/search/vector-store shared logic should reuse the existing utilities instead of new bespoke parsers.

## Renderer

- Classic scripts only. Add new script files to `index.html`.
- New `window.orkas.*` APIs require a main IPC handler; renderer shim routes are centralized.
- Markdown rendering uses `renderMarkdown`; dashboard directives and schema references change together.
- Do not append cache-busting query strings to renderer resources.
- Renderer icons are centralized in `modules/icons.js`; do not hard-code SVG paths or use emoji icons.
- Reuse shared UI classes and modifiers. Do not create near-duplicate cards/buttons/chips.
- Before adding overlays/popovers/dialogs, check existing z-index tiers.
- Name-scanned inventory lists sort by display name unless the list's order is itself meaningful.
- Keydown action shortcuts in inputs/textareas must ignore IME composition (`e.isComposing || e.keyCode === 229`).
- Long-running user actions need visible progress; read-heavy network views should use stale-while-revalidate when staleness is acceptable.

## i18n

- Visible UI strings go through `src/{renderer,main}/locales/*.json` and `t(...)`.
- Main-generated text uses main locales; renderer chrome uses renderer locales. Shared surfaces may need both.
- Dynamic renderer text must re-render on `i18n-change`.
- Agent/skill descriptions use `description_zh` for Chinese and `description_en` otherwise.
- Prompts, logs, telemetry event names, and user content are not i18n-ed.

## Logging, Telemetry, Privacy

- Use `createLogger('<module>')`; do not use `console.log` for app logging.
- Recoverable failures log `warn`; broken invariants log `error`.
- Sensitive fields must be redacted before logs/telemetry.
- Telemetry goes through `Monitor.click/event/error/identify`; payloads contain only ids, types, counts, lengths, or coarse status.
- Expert-signal files are local-only and may contain raw excerpts. Never copy their content into logs, telemetry, or cross-machine channels.

## Tests And Dev Workflow

- Start PC with `cd PC && ./run.sh`.
- Run tests with `npm test`, not `npx vitest`; the test script manages sqlite ABI swapping and rollback.
- If sqlite ABI is broken, run `npm run rebuild:sqlite:electron`.
- Tests should cover business invariants, recovery paths, concurrency, cross-layer contracts, and text-processing traps.
- Do not test typing-only wrappers, trivial getters, happy-path-only cases, or implementation internals.
- LLM-output parsers/sanitizers need fixture sets for both accepted real shapes and rejected look-alikes.
- Pure renderer functions may expose a guarded CommonJS bridge for tests; DOM/i18n/IPC code should not.

## Do Not

- Put business logic in IPC handlers.
- Spawn CLI agents or MCP servers outside the approved choke points.
- Store user data outside `<uid>/{cloud,local}/`.
- Hand-edit local config/marketplace install files outside the owning UI/dev flow.
- Bypass path sandboxing, locks, file indexer, sync transport, or artifact/saved-app resolvers.
- Add eager attachment extraction or automatic pdf/docx fallback in `read_file`.
- Add LLM total wall-clock timeouts or lock wait timeouts; use the existing idle/watchdog semantics.
- Reintroduce aggregate project indexes, uid-bearing session ids, flat connector tool injection, server-side relay agent execution, or parallel group-chat dispatch paths.
