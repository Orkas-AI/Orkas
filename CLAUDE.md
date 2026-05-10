# Orkas architecture and layering

Only contents the LLM cannot derive from the source — hard constraints / the Why behind counter-intuitive decisions / pitfalls already hit. Architecture descriptions point at source, they do not restate the implementation.

---

## 1. Project shape

Single-process Electron desktop app: main = Node backend, renderer = vanilla HTML/CSS/JS, IPC for communication, local file storage. Startup: `bootstrap.cjs` → tsx loader → `src/main/index.ts`; no build step.

**Hard constraints**:
- main runs no HTTP / occupies no port / has no auth.
- The renderer talks through the `contextBridge`-exposed `window.orkas.{invoke, stream}` allow-list API; **do not introduce** TS / JSX / webpack / vite.
- Preload **must be `.js`** (the preload loader does not run the tsx hook); path is `src/main/preload.js`.
- All LLM calls go through the in-process `core-agent` (`import('#core-agent')` dynamic load); no subprocesses. **Why:** avoid IPC serialization; locks / cancellation / event streams share memory.
- **Local CLI agents are the one explicit exception** — agents whose spec carries `runtime.kind === 'cli'` (claude code / codex / openclaw / opencode / hermes) are spawned as child processes by `features/local_agents/runner.ts`. **`features/local_agents/` is the sole `child_process.spawn` entry point for CLI dispatches**; `bus.ts` routes here, every other `features/*` module is forbidden from spawning these CLIs directly. **Why:** a single spawn entry guarantees uniform persistence (`<uid>/local/file_cache/local-agent-runs/<runId>/`), cancellation (AbortSignal → SIGTERM → 10s grace → SIGKILL), and 5-CLI fanout discipline — bypassing it leaks zombies and forks the run-history schema.
- Storage is JSON / JSONL primarily; sqlite is used in exactly one place — the KB vector store. **Why:** user data must stay readable, portable, and friendly to cloud sync (single file = single sync unit).
- **skill / agent / contexts are three first-class citizens**; multi-agent collaboration follows the §5 group-chat architecture, with **no more "main agent calls subagent over RPC"**.
- npm dependency allow-list is in `PC/package.json` (key entries: `electron / pi-ai / better-sqlite3 / sqlite-vec / fastembed / onnxruntime-node / pdfjs-dist / pdf-lib / mammoth / jimp`). **New dependencies require a discussion first.**
- Renderer-side third-party JS/CSS goes through static assets at `src/renderer/vendor/<name>/`; not via npm. **Why:** `require` is unavailable inside the contextBridge sandbox; routing through npm is actually a detour.
- **Cross-platform**: macOS + Windows are both primary (Linux is community-grade). New code prefers cross-platform implementations (Node stdlib); platform branches must be verified on real machines for each branch — getting one platform working is not enough.

---

## 2. Directory layout

```
PC/                          Electron project root, sole dev and packaging entry
├── bootstrap.cjs            Registers the tsx loader → require('./src/main')
├── data/                    Runtime data (gitignored, see §4)
├── userWorkSpace/           Default workspace for the main conversation (gitignored)
├── src/main/                Node backend (TS, transpiled at runtime by tsx)
│   ├── index.ts             Electron lifecycle + IPC registration
│   ├── preload.js           contextBridge → window.orkas (must be .js)
│   ├── paths.ts             **Single source of truth for paths**; never scatter hard-coded paths
│   ├── ipc/                 IPC handlers (see §3)
│   ├── features/            Business layer (users / chats / group_chat / skills / agents / contexts / kb_* / auth / permissions / ...)
│   ├── model/               Model-call layer (in-process core-agent)
│   ├── prompts/             *.md templates
│   └── util/                Pure functions (locks / path-sandbox / extract-* / file_to_chunks / ...)
├── src/renderer/            Frontend UI (vanilla, see §8)
├── src/core-agent/          AgentRunner / providers / PersistentSession / SkillLoader
└── src/builtin/skills/      Built-in skill source (synced by hash to data/builtin/skills/ on startup)
```

**Runtime data location**: dev = `PC/data/` + `PC/userWorkSpace/`; packaged = `<container>/{data,userWorkSpace}/`, where the container is chosen as macOS/Linux → `~/.orkas/`, Windows → the lowest-letter non-system fixed drive `<drive>:\.orkas\` (falling back to `C:\` if none). Full drive selection logic lives in `src/main/packaged-data-root.ts`.

---

## 3. Layering constraints

```
ipc/                IPC handlers: arg validation + call into features; no IO, no business logic
features/           Business layer: orchestrates storage + model + prompts; knows nothing about IPC
model/              Model-call layer; client.ts re-exports, implementation in model/core-agent/
model/core-agent/   Local adapters + tool overrides
storage.ts          File IO helpers (stdlib only)
prompts/            Template loader (stdlib only)
i18n.ts             UI language table lookup (stdlib + locales/*.json only; never imports features / model)
util/               Pure-function utilities (stdlib only or single third-party dep; **never reverse-import features/model**)
```

**Require rules**:
- `index.ts` / `ipc/` → `features/` / `storage` / `paths` / `prompts`
- `features/` → `storage` / `paths` / `prompts` / `model` / `util` / sibling features
- `model/core-agent/` → dynamic `import('#core-agent')`; locks via `util/locks`; **never read or write business data under data/** (only session jsonl). **Why:** the model layer is stateless; orchestration of business state lives only in features. The model layer touching business data = double-write = state desync.
- `features/local_agents/` is the **only feature module allowed to import `child_process`**. Other features must call `local_agents/runner.run(...)` for CLI dispatches; never spawn a coding CLI from anywhere else.

**Key model/core-agent constraints** (each *-tool.ts has a header comment with the implementation details):
- **Adding a new tool** = entry in `tool-catalog.ts::TOOL_CATALOG` (the anti-drift test relies on this) + register with the runner; system-prompt order is fixed `[systemPrompt → skillsBlock]` (KV-cache stable prefix first). **Tool descriptions go only through the SDK tool-use protocol's API tools field** (full description + JSON schema); **do not inject a "## Available tools" block into the prompt** — that's both duplication and a variable prefix that pollutes the cache.
- **File-class tools** must funnel through `util/path-sandbox.isPathAllowed` at the entrypoint.
- **`sdk-timeout-patch.ts`** must be invoked in `index.ts` after logger init and before any feature import; the order cannot change.
- **`#core-agent` may only be loaded with dynamic `await import('#core-agent')`, never with top-level `import { x } from '#core-agent'`** — a top-level static import would synchronously load core-agent + its `pi-ai` dependency early in main startup, before `sdk-timeout-patch` runs; and the pi-ai package.json lacks an `exports` field, so ESM resolution dies with `ERR_PACKAGE_PATH_NOT_EXPORTED`. Every place that pulls a value from `#core-agent` follows the lazy singleton pattern of `getLoader()` / `getPickDescription()` — `await import` on first use, then cache.
- **Tool output** is wrapped through `util/tool-result-cap.ts::wrapToolWithCap` enforcing per-tool caps (default 100K; `read_file`/`kb_read` exempted; over 50K spills to disk under `tool-results/<sid>/`).

**features function conventions**: return objects + represent errors as `{ok:false, error}` or throw (the IPC handler unifies wrapping); for any function dealing with user-private data, `userId` must be the first argument.

**IPC channels**: `orkas.invoke` (request/response) / `orkas.streamStart` (event stream `stream:<requestId>`, terminated by `{type:'done'}`) / `orkas.streamCancel`.

**Prompt-md content hygiene** (`src/main/prompts/*.md` is injected into the LLM, **prohibited**):
1. Project name / brand strings (`Orkas` etc.; replace with neutral wording such as "this system").
2. Real OS path literals (`/Users/...` / `C:\Users\...`; replace with abstract descriptions or the `<abs-path>` placeholder; `$variable` placeholders injected via `prompts.load(name, vars)` are allowed).
3. Project-specific directory names (`PC/data` / `userWorkSpace`).

Exception: env-var names with the project prefix (`ORKAS_NODE` / `ORKAS_PC_DIR`) are allowed when actually referenced in bash. Before adding/changing a prompt, `grep "Orkas\|/Users/\|/home/\|PC/data\|PC/src" src/main/prompts/*.md` should come back clean.

**Authoring rules live in builtin skills, not in `chat_*.md`**: the canonical authoring rules for agents (`<agent>` container) and skills (`<skill>` container + `<<<skill-file>>>` blocks) live in two builtin skills — `src/builtin/skills/agent-creator/SKILL.md` and `src/builtin/skills/skill-creator/SKILL.md`. The four prompts that previously copy-pasted these rules (`chat_commander.md`, `chat_agent_setup.md`, `chat_agent_setup_cli.md`, `chat_skill_setup.md`) now carry only a session-shell + `read_file <ROOT>/agent-creator/SKILL.md` (or skill-creator) pointer. **Why:** the rules are ~200 lines each and were duplicated across four prompts (~600 lines drift surface), kept in sync only by reviewer attention; the duplication caused the commander prompt to balloon past 460 lines, putting the rules in the lost-in-the-middle band. Moving them to builtin skills cuts the always-loaded system prompt by ~590 lines and gives every authoring surface a single source of truth — the LLM `read_file`s the skill on demand. **When changing authoring semantics**: update `agent-creator/SKILL.md` or `skill-creator/SKILL.md` only; `grep -E "<agent>|<<<skill-file>>>|agent-creator|skill-creator" src/main/prompts/*.md src/builtin/skills/*-creator/SKILL.md` to confirm the four chat prompts still just point at the skill (no copy-back drift). The loader does not do template composition (only `$variable` substitution), so the on-demand read is the natural sync mechanism — every fresh authoring session re-reads the skill body.

**Cross-prompt sync constraint for residual shared rules**: a few smaller cross-prompt concepts still live inline (`<agent-input-form>` / `<agent-input-submission>` extract-first protocol in `chat_agent_in_group.md`, the `chat_shared_rules.md` web/PDF/file-output block injected by `bus.ts::concatSharedRules`). For those, the historical principle stands: pick one authoritative prompt as truth, downstream sites carry only the principle (no field detail / schema tables / full translation tables). Before touching the truth source, run `grep -E "<agent-input-form>|<agent-input-submission>" src/main/prompts/*.md` to reconcile downstream.

**Adding prompt text**: lean-prompt discipline applies to **every LLM-facing prompt** — `prompts/*.md`, SKILL.md bodies, agent / skill specs, and CLAUDE.md itself. Before adding any new clause, run two checks:

1. **Is each clause necessary?** Cut narrative filler ("…and is what users complain about most"), redundant cross-references to globally-declared rules ("(in the user's UI language — the trailing language directive sets that)"), and double-emphasis ("even one token, even one field"). Keep the rule, the *Why* for counter-intuitive choices, and a concrete example when the rule is structural. **The test:** delete the clause; if the model behaves the same, drop it.

2. **Does it conflict with or duplicate existing content?** Grep the same prompt md and its peers (`chat_*.md` share a domain; `chat_shared_rules.md` is injected into multiple roles — see the cross-prompt sync constraint above). Partial overlap → **merge** into one tighter rule, don't ship a parallel paragraph (parallel rules dilute each other; the model honours neither cleanly). Contradiction → **fix one to match the other**, don't ship both.

3. **Show the audit (process enforcement)**: any response that submits a prompt-md edit MUST contain a visible per-clause audit — one row per newly added clause marked ✅ (necessary; which Keep category) or ❌ (cut; which redundancy reason from check 1). Without the audit in the response, treat the edit as incomplete. This binds checks 1 and 2 to a concrete moment so they aren't silently skipped.

**Why:** prompt text sits in the cached prefix and shapes every turn. We shipped "don't paste absolute paths" + "don't enumerate bash scratch" as two parallel paragraphs in `chat_shared_rules.md` and watched the model honour neither until the merge. We also shipped this rule itself as advisory at first and watched the audit get skipped on every subsequent prompt-md edit until the audit-as-artifact step made skipping visible. Merge first, write second; show the audit.

**Prompt-md cache layout** (KV-cache prefix discipline): every `src/main/prompts/<name>.md` is split into two halves — **static rules first, then a single trailing `## Runtime injection` section that collects every `$variable` substitution** (with the most volatile field at the bottom of that section). Final assembled order = `<role>.md` static body → `chat_shared_rules.md` (when applicable) → `<role>.md` `## Runtime injection` → `buildLanguageDirective()`. The shared block is wedged in front of the runtime block by `bus.ts::concatSharedRules`; the language directive is appended last by `appendLanguageDirective`. **No `## Current xxx` / "current state" block at the top of the file** — anything the LLM itself rewrites mid-session (`<agent>` writeback / `<<<skill-file>>>` / `plan_set` / form submissions: `$name` / `$description*` / `$workflow` / `$skill_dir` / `$skill_files` / `$plan_state` / `$agents_index` / `$inputs_schema` / `$interactive`) goes only into the trailing runtime section. **Why:** putting volatile fields up front means the very next turn rewrites the cache prefix and we eat a full re-prefill; `chat_agent_setup.md` / `chat_agent_setup_cli.md` / `chat_skill_setup.md` shipped with a top-of-file `## Current agent` / `## Current skill` block, every edit turn invalidated the cache, and the fix was to consolidate those into the trailing `## Runtime injection` section. Same applies to any new prompt md added under `src/main/prompts/`. Path-constants that are fixed for the lifetime of a session (`$builtin_*_dir` / `$custom_*_dir` / `$working_dir`) are session-stable and may stay inline in the body; only fields that the LLM or bus mutate within a session are forbidden in the prefix.

---

## 4. data sync domains

Top-level three-way split: **☁️ cloud** (user-private, synced across devices) / **🔒 local** (machine-private, never synced) / **🌐 top-level** (globally shared).

```
PC/data/
├── users.json                 🌐 Local uid registry + current_user_id
├── logs/                      🌐 Local logs (rolled daily, shared across uids)
├── builtin/{agents,skills}/   🌐 Synced by hash from src/builtin/ at startup (runtime copy; manual edits get overwritten)
└── <user_id>/
    ├── cloud/                 ☁️ Cloud-sync domain
    │   ├── chats/<cid>.jsonl  + chats/<cid>/{members,state,plan,visibility/}  group-chat runtime state (see §5)
    │   ├── chats/{skill,agent}/<id>/chat.{json,jsonl}                          edit sessions
    │   ├── chat_attachments/<cid>/    Main-conversation attachment pool (zero pre-processing)
    │   ├── sessions/<sid>.jsonl       core-agent PersistentSession
    │   ├── contexts/                  KB user-managed directory tree + .kb/vector.db (see §7)
    │   ├── memory/MEMORY.md + USER.md
    │   ├── agents/<aid>/              Custom agent: agent.json (spec) + meta/ (metacognition) + skills/ (self-evolved SkillStore)
    │   ├── skills/<sid>/              Custom skills (System A, scanned by SkillLoader)
    │   ├── projects/<pid>/{project.json, bindings.json}  Logical groups of conversations + per-project agent/skill scope (no aggregate index — list = directory scan)
    │   └── config/{preferences,component-enabled}.json
    └── local/                 🔒 Machine-private domain (never synced)
        ├── config/            auth-profiles / permissions / reflection-state / web-search-cache
        ├── search/            Derived indexes (contexts / chats / skill_chats / agent_chats)
        ├── workspace.json     Scoped workspace selection: `{default, projects:{<pid>:…}}` (legacy flat shape auto-promoted on first read)
        ├── file_cache/<hash>/ Lazy cache for all files (see features/file_indexer.ts)
        └── tool-results/<sid>/ Spill for oversized tool outputs
```

**Five hard constraints**:
1. **At top level**, only `users.json` / `logs/` / `builtin/` / `<uid>/` are allowed; per-user data must land under `<uid>/{cloud,local}/`.
2. **`data/builtin/{agents,skills}/` is a runtime copy**: synced by hash from `src/builtin/` at startup. Agents are directories (`<aid>/agent.json`); skills are directories (`<sid>/SKILL.md`). The loader scans `[<uid>/cloud/, data/builtin/]`; custom takes precedence over a builtin with the same id. `kind` is decided by the spec's root (there is **no** `custom/` / `builtin/` layer inside the directory).
3. **Agent directory shape (per-agent asset aggregation)**: `<uid>/cloud/agents/<aid>/` contains `agent.json` (the sole UI display source — pure spec) + `meta/` (metacognition: COMPETENCE.md + LEARNING_STRATEGIES.md) + `skills/` (SkillStore self-evolved skills, visible only to this agent, not injected into the SkillLoader system-prompt block). Deleting an agent = `rm -rf <aid>/`, no cascade. See `docs/plans/agent-as-directory.md`. **Do not** revert to the old top-level `meta/` or `PC/skills/` (the SkillStore default cwd).
4. **`search/` indexes are purely derived**: never synced; mtime+size reconcile self-heals before each query; 1-second debounced flush + force flush on `before-quit`; rebuild automatically on schema change or corruption.
5. **The KB vector store is part of cloud sync**: on conflict take the newer mtime; the loser's startup `kb_indexer.reconcile(uid)` reconciles by sha1. **Journal mode is DELETE, not WAL** (avoiding `.db-wal` / `.db-shm` sidecar files that would themselves need syncing — empirically that tears).

**uid lifecycle** (`features/users.ts`): on startup, `initActiveUser()` reads or creates `users.json` (8-digit numeric uids); `activateUser(uid)` is responsible for skeleton mkdir + injecting `process.env.CORE_AGENT_AUTH_DIR` + clearing caches. All user-scoped features get the uid via `getActiveUserId()` (throws if not activated). One active uid at a time for now.

---

## 5. Conversation / session isolation (core security invariant)

| Conversation type | UI message list | session_id |
|---|---|---|
| Main conversation (group chat) — commander | `<uid>/cloud/chats/<cid>.jsonl` | `<uid>-gconv-<cid>` |
| Main conversation (group chat) — agent worker | `<uid>/cloud/chats/<cid>/visibility/<aid>.jsonl` | `<uid>-gmember-<cid>-<aid>` |
| Skill editing | `<uid>/cloud/chats/skill/<sid>/chat.jsonl` | `<uid>-skill-<sid>` |
| Agent editing | `<uid>/cloud/chats/agent/<aid>/chat.jsonl` | `<uid>-agent-<aid>` |
| KB image understanding | (no UI) | `<uid>-extract-img-<hex>` |
| CLI agent dispatch | (no jsonl — per-run files only) | `<uid>-cli-<cli>-<runId>` |

session jsonl files land at `<uid>/cloud/sessions/<session_id>.jsonl` — they are **two independent files** from the UI message list.

**Project membership** is an index-level field on the conv record (`Conversation.project_id`), **not** part of any path or session_id. cid stays globally unique; `<cid>.jsonl` / `groupChatDir` / `chat_attachments/<cid>/` / `session_id = <uid>-gconv-<cid>` paths are independent of project membership. Project membership has effect in two places, both resolved once at the top of `runTurn` and threaded through `ChatOptions`: (1) **workspace** — `getWorkspacePath(uid, projectId?)` (sync) picks the project-scoped selection from `<uid>/local/workspace.json::projects[pid]` when set, falling through to `default.selectedPath` then `DEFAULT_USER_WORKSPACE`; (2) **agent/skill scope** — `projects.resolveProjectScope(uid, projectId)` returns the project's `bindings.json` (`{agents, skills}`), which restricts the commander's agents-index render and the System A skill render to those ids only. Orphan conversations (no `project_id`) keep legacy global visibility. group_chat threads `projectId` + `projectAllowedSkillIds` through `ChatOptions` → `LocalToolsOpts` / `FileToolsOpts` / `ImageGenToolOpts` / `getSystemPromptBlock`. **Do not** re-read the conv index or bindings per tool call — the resolved values travel with the turn.

**Security invariant**: `session_id` must be `<uid>-<kind>-<tail>`, with the uid in the first segment, and `<kind>` ∈ `gconv | gmember | skill | agent | extract-img | reflect | memory-extract | anon | cli` (`sub` / `organizer` / `conv` are legacy kinds; new code does not generate them, but `migrate-session-ids` preserves these older files). `session-store.ts::sessionFileFor()` enforces this with hard assertions to prevent cross-uid leakage. **Do not** encode brand names (`orkas-` / `aiteam-` / any app name) into session_id — we hit the renaming-breaks-history pitfall once, the startup `migrateLegacySessionIds(uid)` strips legacy prefixes once, and new code never adds them again. Adding a new kind requires extending this table. The `cli` kind has no `sessions/*.jsonl` (CLI dispatches do not run through core-agent); the id exists purely to give per-run records a stable, kind-tagged identifier.

**Skill injection policy**: edit conversations + group-chat commander = no filtering (inject all); group-chat agent worker = filter by `agent.skill_list` three-state (see §6).

**Prompt-cache convention**: continuous sessions (`gconv-* / gmember-* / skill-* / agent-*`) default to `cacheRetention: 'short'`; one-shot calls (memory / reflection / KB image) do not pass it. pi-ai already abstracts provider differences (the features layer does no branching). `'long'` is off by default (Anthropic's 1h has a 2× write surcharge).

**Adding a new conversation type**: UI path must contain a `user_id` segment + session_id uses the `<uid>-<kind>-<tail>` three-segment format (uid first segment, **no brand prefix**) + conversation-level rules go through `ChatOptions.systemPrompt` (rebuilt every time, **don't splice them into the first user message as a prefix**) + update this table.

### Group-chat architecture (`features/group_chat/`)

Members = `commander` + `user` + N `agent` actors (any agent first targeted by `dispatch_to` / `plan_set` is auto-added to the group). Each actor runs an independent worker loop, **no RPC**.

**Dispatch channels** (LLM → system control flow always goes through structured channels, consistent with the `<agent>` / `agent-input-form` style):
- Single agent → `dispatch_to({to, message})` tool (usable by both commander and agents).
- Multi-actor coordination → `plan_set({steps})` tool.
- User-sent messages → text `@<name>` is still parsed (user UX unchanged).
- **`@<name>` written into prose by commander / agents is NOT recognized as a dispatch signal** (LLM training tends to use `@` as markdown decoration; this used to mis-trigger and produced recurring bugs).
- `dispatch_to` calls only stage; the recipient worker is woken up only after the commander turn fully wraps up (avoiding races; same `pendingPlanAnnouncement` + delayed reconcile pattern as `plan_set`).

**Single dispatch primitive**: `bus.ts::enqueue(uid, cid, fromActorId, text, [forceTo], ...)` is the only external control-flow entry point for group_chat. `dispatch_to` / `plan_executor` / text @ (user only) / **CLI-backed agent worker turns** (their post-CLI reply still goes back through `bus.enqueue`, no shortcut) all funnel into this single enqueue. **Do not** introduce parallel enqueue functions; new dispatch paths must go through it. **`groupChat.retryStep / skipStep` are not exceptions** — they only mutate plan state, never enqueue directly; redispatch happens via `planExecutor.reconcileAfterStepTransition → dispatchReady → enqueue`.

**Plan rail (user-facing visualization)**: `<cid>/plan.json` is rendered as a sticky-top rail above `#chat-history` (renderer `modules/plan-rail.js`). The rail is the SOLE frontend display for plan state (the legacy `📋 执行计划` bubble label is just a one-line announcement, not a view of step status). Failed steps surface 重试/跳过/放弃 buttons that route to `groupChat.retryStep / skipStep / abort` IPC. Action buttons hide whenever `state.in_flight` is non-empty to avoid racing user actions against an in-progress turn. Status icon set is FIXED in `plan-rail.js::STATUS_ICON` — single source of truth, no LLM input, no backend / locale duplicates.

**Plan-level transient retry**: `PlanStep.transient_attempts` + `TRANSIENT_ERR_PATTERNS` (in `plan_executor.ts`) form a 2-tier retry stack with core-agent's `maxRetries=3` inner stream-level retry. Pattern matches undici `terminated` / `ECONNRESET` / `ETIMEDOUT` etc.; on hit, the failed step is folded back to `pending` + `transient_attempts++` + immediately redispatched via reconcile. Cap = `MAX_TRANSIENT_RETRIES` (2). **Never include `aborted` / `cancelled` in the pattern** — user-initiated abort must not be silently retried; the literal `'aborted by user'` string is also explicitly excluded by the guard. The plan layer only does state recovery — do NOT add sleep / backoff / socket-reconnect logic here (that's core-agent's job).

**Key constraints**:
- **Visibility slice** (security invariant): agent X sees only messages where `from==X ∨ to∋X ∨ mentions∋X`; workers must go through `visibility.readSlice` and **never read the full `<cid>.jsonl`** (which would leak other actors' private context).
- **plan**: the commander writes `<cid>/plan.md` only via the `plan_set` tool; **no out-of-tool hand edits** (which would break the first-announcement semantics + UI `plan_changed` event chain). User-initiated `retryStep` / `skipStep` go through `plan_executor` (which `updateStep`s + reconciles), NOT through hand-editing `plan.json`.
- **abort**: `groupChat.abort(cid)` is the sole group-level stop (clears every actor queue + aborts in-flight + sets `state.json.status='aborted'`; plan.md is preserved as a progress record); **no per-stream stop button**.
- **Infinite-loop guard**: `MAX_WORKER_TURNS=100` (turns dimension, **not time**); paired with the outer `idleTimeout=600s`, two independent fallbacks.
- **Structured outputs**: the commander's `<agent>...</agent>` container (create/edit agent), and the agent's ```agent-input-form``` fenced block (forms); format and pipeline details are in `bus.ts::runTurn` + `prompts/chat_*.md`.
- **Delete cascade**: `chats.deleteConversation` → `groupChat.dropConv` is the one-stop call.

### Attachments (main conversation only)

Stored at `<uid>/cloud/chat_attachments/<cid>/<file>`, **zero pre-processing**; extract / compression are lazy under `<uid>/local/file_cache/<hash>/` (see `features/file_indexer.ts`).

**Key constraints**:
- file-tools scope = active workspace ∪ the attachment dir of the current cid; out-of-bounds → `E_PATH_OUT_OF_SCOPE`.
- For pdf/docx, **`stat_file` must run before `read_file`** (read_file returns `E_NEED_STAT` — single responsibility, see §9 Don't do).
- `chat-media://cid/<encCid>/<encName>` is a per-conv attachment URL; `chat-media://local/<abs>` references arbitrary local media (extension allow-list + size cap; **no directory allow-list** — the threat model is "users running their own LLM").
- Video allow-list is `.mp4/.webm/.mov/.m4v/.ogv` (200 MB cap), **for display only, not fed to the model**.

### Local execution tools

`bash / write_file / edit_file / markdown_to_pdf / html_to_pdf / generate_image` share the `localExec.granted` permission gate (grant/revoke from the settings page, re-read on every `execute()` so it takes effect mid-conversation); unauthorized → `isError=true`. `web_search` goes through `searchProfiles[0]` → paid API → fallback built-in. Outputs are collected via `ChatOptions.onFileWritten` (also fires for `edit_file` so in-place modifications surface as green chips); the renderer shows green chips → IPC `workspace.revealPath` (strictly validated to stay inside the workspace). See `model/core-agent/{local-tools, image-gen-tool, search-tools}.ts`.

**Write-file conflict avoidance** (`util/uniquify-path.ts`): `write_file / markdown_to_pdf / html_to_pdf / generate_image` write to the path the model gives by default; **on conflict, uniquify** (insert `-N` before the basename suffix) and pass it back explicitly via the `<file-renamed>` block in the tool result. "Mine vs not mine" is decided by the caller-injected `ChatOptions.hasProducedPath` (group_chat uses producedSet at turn granularity) — paths this turn already wrote are treated as refinement (overwrite); other pre-existing files are external conflicts. **`bash` is not in the protected scope** (shell redirection is a black box). **`edit_file` is also not in this scope** by design — its semantics is "modify an existing file in place" (not "create a new artefact"), so uniquify would be wrong; it instead enforces sandbox-membership (workspace + current attachment dir + extraRoots, same set as the file-tools read side) and rejects pdf/docx/image kinds, so the LLM can only mutate text files the conversation can already see. When `read_file` hits ENOENT, it scans sibling `<name>-N<ext>` files in the same directory; on a hit it appends a `<file-renamed-earlier>` hint as a second layer of defense.

---

## 6. Skills

Sources = `src/builtin/skills/` (git-tracked, hash-synced into `data/builtin/skills/` at startup) + `<uid>/cloud/skills/`. `SkillLoader` scans `[user, builtin]` and injects them into the system prompt; **custom takes precedence over a builtin with the same id**. Built-ins are not editable.

**Authoring rules are themselves builtin skills**: `src/builtin/skills/agent-creator/SKILL.md` and `src/builtin/skills/skill-creator/SKILL.md` carry the canonical authoring rules for `<agent>` and `<skill>` containers. The four chat prompts (`chat_commander.md` + the three inline edit chats) point at them via `read_file <ROOT>/agent-creator/SKILL.md`. When changing authoring semantics — field shapes, validation rules, similarity-check protocol, edit-loop, prose forbidden words — update **only** the matching `*-creator/SKILL.md`; the chat prompts already reference it on demand. See §3 "Authoring rules live in builtin skills" for the cross-prompt sync convention.

**Built-in skill / agent source files keep their primary text in English** (SKILL.md body / examples under `src/builtin/`, and the system / persona / workflow of built-in agent specs): they ship to a multilingual user base, the LLM auto-replies in the conversation language, and there is no need for a Chinese fallback in the source files; mixing in Chinese makes English-speaking users see half-translated content. Custom skills / agents are user-authored and have no language restriction.

**Exception: `description` must be bilingual** — SKILL.md frontmatter uses both `description_zh` + `description_en` (the legacy single `description` field is migrated by CJK heuristic in the loader / normalizeAgent buckets, but **new entries always use both fields**); agent spec JSON likewise uses `description_zh` + `description_en`. **Why:** the description is the selection signal seen by the commander / main-conversation LLM (`chat_commander.md:91/96/325`); built-in skills / agents are distributed globally, and an English-only description means a Chinese UI user sees an English description in the list, leading to mis-matches. At runtime, `getSystemPromptBlock` / `_buildAgentsIndexBlock` / UI rendering all pick the right one based on `getCurrentLang()` (the `pickDescription` resolver lives in core-agent + renderer utils, kept in sync). **Pre-translated, not at runtime** — description quality must be controllable, and runtime translation has both quality variance and latency cost.

**SKILL.md frontmatter has only two fields**: `name` + `description`. **No** `requires` / `external_deps` / `tags` / any other field. Skills have no hard inter-dependencies (no transitive closure, no cross-skill writes); external deps are stated in the body's "External dependencies" section as plain text — runtime does not pre-check or auto-install.

**`agent.skill_list` three-state**: `undefined` = no filtering (legacy compatibility) / `[]` = zero skills / non-empty = a strict subset. `updateCustomAgent` only does "filter unknown ids" before saving; it does not expand a closure. The field is auto-maintained by the agent-edit LLM via the `<agent><skills>` sub-tag; **the frontend does not expose hand-editing**.

**CLI-backed agents (`runtime.kind === 'cli'`) bypass SkillLoader entirely** — `skill_list` is ignored at dispatch time, the system prompt isn't built (the CLI brings its own prompt), and the edit chat uses `chat_agent_setup_cli.md` which forbids the LLM from authoring `<workflow>` / `<skills>` / `<runtime>` sub-tags. The runtime itself (cli + model + custom_args) is owned by the create modal + edit-form, not by the LLM.

**Skill scripts default to `.py`** (Python 3, broadest coverage); also allowed: `.ts / .mjs / .js` (via tsx + Node), `.sh` (bash), `.rb` (ruby). **Why:** the vast majority of external-ecosystem skills are written in py; forcing rewrites is a high bar and bug-prone; py ships with macOS/Linux and Windows installs once. **All invocation goes through** `bin/run-skill.cjs <id> <basename>` (no extension); the runner dispatches by extension: `.py` → `python3` (Win: `py -3` → `python`); `.ts/.mjs/.js` → require + default export; `.sh` → `bash`; `.rb` → `ruby`. The subprocess gets `ORKAS_SKILL_ID` / `ORKAS_SKILL_DIR` env injected; stdio passthrough; exit code propagated. Skill directories must not contain `node_modules / package.json / requirements.txt / Gemfile` or other package-manager artifacts; `.ts` may use the existing PC npm allow-list (new deps follow §1), other languages use only the corresponding runtime stdlib.

**Per-user enable/disable** (shared by agent + skill, stored at `<uid>/cloud/config/component-enabled.json`, **only `false` is recorded**): the single resolver entrypoint is `features/component_enabled.ts::isAgentEnabled / isSkillEnabled`. **Only 4 filter application sites** (do not add filtering elsewhere):
1. `listAgents() / listSkills()` attaches `enabled` for the UI (no filtering — let the UI render the toggle).
2. `group_chat/bus.ts::buildAgentsIndexBlock` — commander's agent picker list.
3. `chats.ts::stream/sendToConversation` — bound disabled agents return `errors.agent_disabled` directly.
4. `skill-registry.getSystemPromptBlock({disabledIds})` — render-stage filtering.

**Project scope** is the OUTER intersection — applied BEFORE the 4 enable filters above, NOT a 5th site. The two existing render entry points (`buildAgentsIndexBlock` for agents, `getSystemPromptBlock` for skills) accept an `allowedIds` / `allowlist` parameter; group_chat resolves `projects.resolveProjectScope(uid, projectId)` once at the top of `runTurn` and threads `bindings.agents` into the agent picker call and `bindings.skills` (intersected with `agent.skill_list` for the System A render only) via `ChatOptions.projectAllowedSkillIds`. SkillStore (System B, agent self-evolved skills) is gated by `skillList` alone — project bindings must NOT block an agent from accessing its own evolved skills. Order: `project bindings ∩ skill_list ∩ enabled` for System A; `skill_list ∩ enabled` for System B. Orphan conversations (no `project_id`) skip the project step entirely (legacy behavior).

**Write entry points** (rename / URL/dir import): see `features/skills.ts`. Every write entry must call `invalidateSkills()`. The `<<<skill-file>>>` block can only write into the current skill directory (no cross-skill `skill=Y` attribute).

**Two system boundaries (skills have two sets)**:
- **System A — user/UI-managed skills**: `<uid>/cloud/skills/<sid>/` + `data/builtin/skills/<sid>/`, scanned by `SkillLoader` and injected into the system prompt's "## Available skills" block; SKILL.md frontmatter is `name + description` only; this is the set the UI / skill-edit chat / import flow change.
- **System B — agent self-evolved skills**: `<uid>/cloud/agents/<aid>/skills/<sid>/`, written by core-agent SDK's `SkillStore`, managed via the `skill_manage` tool (create / read / patch / list / delete); **visible only to the owning agent** (fetched via `skill_manage(list/read)`), NOT injected into the SkillLoader system-prompt block. The frontmatter contains runtime fields like `id / patchCount / createdAt / updatedAt / tags`.
- runner.ts explicitly points the `evolution.skillsDir` of the `createConfig` call at `agentEvolvedSkillsDir(uid, agentId)`; **never** let SkillStore fall back to the cwd default and land under `PC/skills/` (we already added that to `.gitignore` as a defense).

---

## 7. Knowledge base (contexts)

`<uid>/cloud/contexts/` is the user-managed directory tree (mixed md/txt/pdf/docx/image, cloud-synced) + `.kb/vector.db` (derived vector store, also cloud-synced). See `features/{contexts, kb_indexer, vec_store, kb_vector}.ts`.

**Key constraints**:
- **Embedder is fixed at `bge-small-zh-v1.5`, 512 dims**; switching models requires a full rebuild (`config.json` lock prevents accidental swaps). The model is ~95 MB and ships via the installer's `extraResources`, so zero download / zero network at runtime.
- **Journal mode is DELETE, not WAL** (the `.db-wal/.db-shm` sidecar files would tear cloud sync — see §4).
- **No `worker_threads` for multiple ONNX sessions**: empirically the native layer SIGSEGVs (OpenMP threadpool + concurrent allocator init is a known dangerous combination); for true parallelism use `child_process`.
- The model side may use only `kb_search` / `kb_read` tools; **`cat` / `rg` access to `$contexts_dir/` is forbidden** (stated in `chat_core.md`).
- Chunk cap is `EMBED_MAX_CHARS=400` chars (matching the 512-token window); no overlap across segments to avoid topic pollution.
- `_INDEX.md` is generated only at the root of contexts for users browsing in Finder; **the model does not read it**.
- Cloud-sync conflicts take the newer mtime; the loser runs `reconcile` at startup to backfill via sha1; the `kb_files` table is the manifest, no separate manifest file is needed.

**Reusable vector-store utilities** (good for new scenarios; each file's header has the details): `util/file_to_chunks.ts` (pure function chunker) + `features/vec_store.ts` (`openVecStore(dbDir)` factory, both high- and low-level APIs) + `features/kb_vector.ts` (uid → dbDir adapter).

---

## 8. Frontend (`src/renderer/`)

Vanilla HTML/CSS/JS, classic `<script>` multi-file (no ESM, no build). Cross-file symbols share top-level `let/const`; **don't use** `export/import`; don't hang things on `window.*` (unless an HTML `onclick` requires it).

**Key constraints**:
- Adding a new file → also insert it into `index.html`'s `<script>` list (most additions go after `ipc-shim`).
- Adding `window.orkas.*` API → must add a handler in `ipc/index.ts`; new `/api/*` → only added to `modules/ipc-shim.js::_IPC_ROUTES` (no real HTTP).
- Markdown rendering has a single interface, `renderMarkdown(str)` (`modules/utils.js`); **don't write a "lite version"**. LaTeX is typeset asynchronously by `modules/math.js::typesetMath`; **no typesetting of streaming deltas** (avoids half-formed LaTeX flickering). Placeholder/regex specifics live in those two files' headers.
- `index.html` resources **don't carry `?v=`**: dev `Cmd/Ctrl+R` goes through `reloadIgnoringCache()`; reload is disabled in prod.
- `src/renderer/` **does not participate in typecheck** (vanilla + DOM gives too many checkJs false positives); main/ stays at `checkJs: true`.
- Process-info-row icons use only Unicode Geometric Shapes (`▶ ● ◆ ◇ ■ ▣ ▷ ◐ ◉ ○ ◯ ▪`); **no colored emoji**.
- The UI shares one set of classes (`.btn / .btn-sm / .btn-primary / .btn-danger / .detail-actions / .empty / .muted`); differences are expressed via `.is-*` modifiers; **don't open near-duplicate classes**.
- **IME composition guard on Enter / Arrow shortcuts**: every keydown handler on an `<input>` / `<textarea>` that triggers an action (Enter→submit / search-jump / form-confirm; Arrow→list selection) **must early-return when `e.isComposing || e.keyCode === 229`**. **Why:** Chinese / Japanese / Korean IMEs use Enter to commit a composition candidate; without this guard, "Enter to confirm an English candidate when the primary suggestion is already English" silently fires the action and the user navigates away mid-typing. We've already hit this on the global search overlay; the chat input (`modules/conversation.js`) and the new-chat input (`modules/state.js`) had it from the start, the search input was missing it. Pattern to copy: `if (e.isComposing || e.keyCode === 229) return;` at the top of the handler. The `keyCode === 229` arm covers older Electron / Safari builds where `isComposing` is occasionally inaccurate.

### i18n (zh / en)

Strings live in `src/{renderer,main}/locales/{zh,en}.json`; lookup goes through `i18n.{js,ts}::t(key, vars?)` (flat dot-separated keys, fallback `en` → raw key on miss). Language preference is stored in `<uid>/cloud/config/preferences.json`; runtime switches dispatch the `i18n-change` event.

**Hard requirements**:
- All user-visible strings (button / title / status / placeholder / tooltip / empty state / toast / dialog) **must go through i18n** with both zh and en keys.
- Static HTML uses `data-i18n*` (`applyDomI18n()` auto-fills); **JS-injected text must subscribe to `i18n-change` and re-render** — common misses: sidebar lists / settings dynamic rows / status-toggle buttons.
- Decide the i18n key first, then write the code; **no hard-coded Chinese with "I'll backfill later"**.
- **Not i18n-ed**: LLM prompts (`prompts/*.md` — the source language IS the prompt), logs, user content.

---

## 9. Dev workflow

### Startup

`cd PC && ./run.sh` (sole entry, kills the old instance + foreground start). F12 opens renderer DevTools (Chromium-built-in, available in non-dev too).

### Git commit

Commit messages **must be in English** — title + body + any footer — **no exceptions**. **Why:** the open-source repo has a global audience; Chinese commits read incoherently in GitHub history and break traceability for contributors writing release notes / running automation.

The commit message is **about the change**, not about how it got here. Sync provenance (e.g. "this came from a PC commit") belongs in `OpenSource/SyncCode/sync-state.json`, **not** in the commit body. Write the message exactly as you would for a fresh OrkasOpen-native change.

### After a change

- main TS / core-agent → `./run.sh` restart (<1s, tsx transpile).
- renderer → `Cmd+R` refresh (cache automatically ignored).
- Storage paths / session_id / layering responsibilities / external deps changed → update this file as well.

### Unit tests

**Sole purpose**: lock down behavior that is easy to break by accident — **not** to chase coverage, **not** to function as docs, **not** to act as a confidence blanket.

**Tests must be run via `npm test`**, **never** `npx vitest` / IDE right-click Run. `scripts/run-tests.mjs` swaps `better-sqlite3` to the Node ABI before tests, and unconditionally swaps it back to Electron afterwards. **Recovery** (MODULE_VERSION mismatch / startup SIGKILL with no stack): run `npm run rebuild:sqlite:electron`. Diagnostic one-liner and full causation are documented in `scripts/swap-sqlite-abi.mjs` headers.

**Test triage**:
- **Must write**: business invariants (uid isolation / session_id prefixes / path traversal / domain boundaries), recovery paths (corruption / concurrency / index mismatch → rebuild, rollback), multi-branch decision functions, cross-layer contracts, text trap spots.
- **Don't write**: functions that are correct by typing alone, thin wrappers, UI/DOM, getter/setter, library-guaranteed behavior.
- **Forbidden**: same-branch repeat assertions with different data, asserting internals, tautologies, just-change-args-not-branches, "type/signature/existence" tests, all-happy-path.

**Organization**: `test/main/` mirrors `src/main/`; `test/renderer/` mirrors `src/renderer/modules/` for the small set of pure renderer-side functions that have fixture coverage (see below). One file per module under test; one level of nested `describe`.

**Hard rule for LLM-output text munging** (regex / parser / classifier / segmenter / sanitizer that consumes streamed or final assistant text — `<agent>` strippers, `<agent-input-form>` strippers, prose/code splitters, mention parsers, code-fence handlers, etc.): these MUST have fixture tests pinning **set A (real shapes the matcher must handle)** AND **set B (look-alike shapes the matcher must NOT handle)**. Adding a guard / branch / segmentation step requires extending the fixture set with the new motivating shape — the patch isn't done until the new fixture is green AND every previous fixture still passes. Reason: this category is whack-a-mole prone — fixing one shape silently breaks another via guard granularity mismatch (we have shipped the same `<agent>` stripper regression three rounds in a row because each round only verified the new case). Typecheck and review can't catch granularity mismatches; only fixtures can.

To make pure renderer-side functions testable under vitest without violating §8's "no export/import" rule, extract them into a standalone `src/renderer/modules/<name>.js` and end the file with a guarded CommonJS bridge:

```js
if (typeof module !== 'undefined' && typeof module.exports === 'object') {
  module.exports = { _fnA, _fnB };
}
```

The renderer evaluates `<script>`-loaded files where `module` is undefined, so the guard is a no-op there. Test side `require()`s the file. **This is the only allowed escape from §8's no-import/export rule, and only for pure functions** — anything that touches `window` / DOM / i18n / IPC stays inline.

**Modifying existing code: existing behavior is the spec.** Adding a guard / branch / segmentation to existing code reorders its matrix of accepted inputs. If the previously-accepted shapes aren't actively re-checked, the change silently breaks them — this is the failure mode behind "fix here, break there" cycles. Before changing existing code: read recent `fix` commits on the file (they encode invariants nothing else documents), grep callers, run existing tests; for text-processing functions in particular, "mentally trace" is not enough — extend the fixture set first, then change the code.

### Don't do

**Layering / paths**:
- Write business in `ipc/` (skipping a layer); call core-agent directly / spawn processes from `features/`.
- Storage paths missing the `<uid>` segment; session_id where the second segment isn't the uid.
- Cache uid paths as a module-level `const` in a feature module (must call `getActiveUserId()` each time).
- Add `window.orkas.*` in the renderer without adding a handler in `ipc/index.ts`.
- Bypass `util/locks.ts` / `util/path-sandbox.isPathAllowed` / `features/file_indexer.ts`.
- Add eager pre-processing (extract / preview / chunking) to `chat_attachments.uploadAttachment`.
- Treat `<uid>/local/workspace.json` as a flat `{selectedPath, recentPaths}` after the projects scope upgrade — the file is now `{default, projects:{<pid>:…}, updatedAt}`. Always go through `getWorkspacePath(uid, projectId?)` / `setWorkspacePath` / `resetWorkspacePath`; reading the JSON directly skips legacy-shape promotion + project-scope fallback.
- Encode `project_id` into a path / cid / session_id segment. Project membership is an index-level field on the conv record only — see §5.
- Reintroduce an aggregate `projects/_index.json`. Project existence is the set of `projects/<pid>/project.json` files on disk; listing scans the directory. **Why:** an aggregate index re-creates the multi-device sync conflict surface this round was designed to avoid (every membership change becomes a multi-file transactional write), and once a server-mediated collab story lands, server-side sync of project directories is a directory-level operation — clients only ever scan. See `features/projects.ts` header.
- Apply the project agent/skill scope as a 5th `component_enabled` filter site. Project scope is an OUTER intersection plumbed through the existing render entry points (`buildAgentsIndexBlock` `allowedIds` / `getSystemPromptBlock` `allowlist`) — see §6.

**Timeouts / locks**:
- Add a "total wall-clock timeout" to LLM calls (`timeout: N` / `setTimeout→abort`). The single application-layer watchdog is `client.ts::streamChatWithModel`'s `idleTimeout=600s` (true idle); the SDK 1h limit is backstopped by `sdk-timeout-patch.ts`; group-chat infinite-loop protection is `bus.ts::MAX_WORKER_TURNS=100` (**turns, do not change to a timeout**).
- Add a wait timeout to `sessionLock.acquire()` / `globalSlots.acquire()`. Long LLM tasks should queue indefinitely; adding a timeout = fake failures.

**Tests / sqlite ABI**:
- `npx vitest` / `vitest run` / IDE right-click Run / call `scripts/swap-sqlite-abi.mjs node` directly (no failure rollback; if the network drops mid-way you end up with a half-overwritten `.node`, and Electron silently SIGKILLs). Always `npm test`; on failure run `npm run rebuild:sqlite:electron`.

**Dependencies / config**:
- Add an npm dep (see §1 allow-list).
- Hand-edit `data/builtin/{agents,skills}/` (overwritten by hash on startup).
- Hand-edit `<uid>/local/config/*.json` (go through the settings UI; `auth-profiles.json` write-entry triggers runner invalidation).

**file-tools misuse**:
- `read_file` doing automatic fallback extraction for pdf/docx (single responsibility — `stat_file` first, see `NeedStatError` for the forced throw).
- `search_files` / manifest triggering extraction (must `getCachedMeta` peek).
- `bash grep -r` scanning pdf/docx (use `grep_files`).

**Prompt md / tool listing**:
- Write project name / real OS path / project source-dir literals into `prompts/*.md` (see §3 "content hygiene").
- Hard-code tool names in `chat_*.md`; new tool descriptions go to `tool-catalog.ts::TOOL_CATALOG.summary` — only "when to use X / X-specific constraint" belongs in the prompt.

**Skill / agent enabled**:
- Check `isAgentEnabled / isSkillEnabled` outside the 4 filter sites in §6; write disabled into spec JSON / SKILL.md frontmatter (violates "user preferences must not overwrite spec"); filter disabled inside `expandSkillClosure` early.

**Group chat**:
- Bypass `bus.enqueue` and write `<cid>.jsonl` or `visibility/<aid>.jsonl` directly (message routing / slicing / worker wake are bundled together).
- Read full `<cid>.jsonl` from inside an agent worker (must use `visibility.readSlice`, otherwise other actors' private context leaks across).
- Re-introduce `call_subagent` / `subagents.ts` (deprecated; LLM dispatch is `dispatch_to` (single) / `plan_set` (multi-actor) tools, no RPC).
- Write `@<X>` in commander/agent prose expecting a dispatch — it's no longer recognized; the user just sees text nobody picked up.
- Build a new enqueue / scheduling function in parallel to `bus.enqueue` — single-primitive principle, every dispatch path must go through it.
- Hand-edit `<cid>/plan.md` outside the `plan.ts` tools.
- Make `retryStep` / `skipStep` enqueue directly (must go through reconcile so the dispatch primitive stays singular).
- Wire the rail's "重试" button to "send the user message again" — that double-writes user history; the action must go through the dedicated IPC (`groupChat.retryStep`) which only mutates plan state.
- Add `aborted` / `cancelled` / `Run aborted` to `TRANSIENT_ERR_PATTERNS` — silently retrying user-initiated abort is the wrong behavior. Net new patterns must come from the network layer (undici / fetch / DNS / socket), not from intent layers.
- Duplicate the plan rail status icon set (`plan-rail.js::STATUS_ICON`) into prompts / locales / backend. Single source of truth; downstream surfaces just read the rendered output.

---

## 10. Logging

**Logging** is `src/main/logger.ts` (a thin wrapper over electron-log): main + renderer both write `data/logs/YYYY-MM-DD.log` (rolls to `.old.log` past 10 MB; startup `sweepLogs()` cleans up by ≥7 days / ≤100 MB; today's file is never deleted). The renderer forwards via IPC and lands as `renderer/<module>` scope. Redaction hook + `REDACT_KEYS` list live in `logger.ts`. Set log level via `ORKAS_LOG_LEVEL=debug`.

**New code must**: use `createLogger('<module>')` instead of `console.log`; key entry points in main flows emit `log.info` (start + key fields userId/path/ms); **before catch / failure return, you must `log.warn` (recoverable) or `log.error` (invariant broken)** — only returning `{ok:false}` without a log = the upstream can't locate the issue; sensitive fields go through `REDACT_KEYS`. The local CLI agent stack uses `local-agents` for the registry / runner and per-backend scopes (`local-agents:claude` / `:codex` / `:openclaw` / `:opencode` / `:hermes`); spawn failures, missing-CLI hits, non-zero exit codes, and ACP parse errors must each emit a `log.warn` so dispatched-task issues are diagnosable from `data/logs/` alone.

The open-source build has **no built-in remote telemetry / third-party analytics, and no in-app debug panel**; diagnose via logs + Chromium DevTools (F12).
