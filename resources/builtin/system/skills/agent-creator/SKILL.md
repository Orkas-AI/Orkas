---
name: agent-creator
description: "Author or edit a custom agent via the `<agent>` container; For: 'crystallize this conversation into an agent', 'make me an agent that does X', 'change X's workflow to ...', 'tighten this agent description'; Triggers: create agent, make an agent, crystallize, edit workflow, adjust description, agent editing, new agent, modify agent."
---

# agent-creator

Authoring rules for creating or editing a custom agent via the `<agent>...</agent>` container. Used by group-chat commander and per-agent inline edit chats. The container is parsed post-stream by `bus.ts`; the LLM does not call any tool — it embeds the container in its final reply text and ends the turn.

## When to consult this skill

`read_file <ROOT>/agent-creator/SKILL.md` whenever you're about to:

- Create a new agent (user says "crystallize / make me an agent / 沉淀这次对话 / 帮我做个 agent").
- Edit an existing agent (user says "改 X 的 workflow / 给 X 加输入 / X 的 description 太啰嗦").

You **must** consult before emitting any `<agent>` container. The protocol below skips silently if you guess fields from training priors.

## Hard rules (non-negotiable)

- **Mutation only via `<agent>` container.** Do NOT use `edit_file` / `write_file` / `bash` to mutate `agent.json` directly. Read for inspection is allowed; every write goes through the container — the sandbox physically blocks direct writes, the rule here keeps you from wasting tool calls probing it.
- **Do NOT dump the container as a workspace file** (e.g. `<name>-agent-definition.xml`). The container is a contract between the LLM and the server; the server parses it inline. An extra `write_file` only leaks an unused XML file.
- **One container per agent being created/edited this turn.** Several containers in one turn are legal only when the user's request spans distinct agents ("tighten the workflow on A and B"). Each container is parsed and applied independently. End the turn after — do NOT call `dispatch_to`.
- **Source-preservation default.** When the user supplies existing source content as the reference (pasted prompt, source `agent.json`, YAML/JSON agent spec, README, workflow, examples, or an agent directory), treat the source as canonical. Preserve the agent's core prompt, role/persona, goals, step order, tool rules, input/output contract, examples, safety rules, and stop/confirmation points. Only adapt it to Orkas container fields, valid tool/skill names, category, and editable `agent.json` shape. Do NOT replace a detailed source prompt with a generic newly invented workflow unless the user explicitly asks for a rewrite.
- **No silent category defaults.** Before the final reply for any create / edit / import, run the category sanity pass below. Do not say "done" while `<category>` is missing, invalid, inherited from an invalid source value such as `code`, or merely the fallback `general` without evidence.
- **Output language follows the user's UI language** — `<name>`, `<description>`, `<workflow>` step titles + body, `<inputs>` `label` values, `<knowhow>` / `<standards>` string values, and the prose around the container all go in the user's current UI language (per the "User language" directive in the system prompt; that directive's coverage applies even though this file reaches you as a `read_file` result). Use `<description_zh>` / `<description_en>` only when the user explicitly asks for multilingual/bilingual descriptions. XML tag names, backticked tool / skill names, JSON keys, file paths, and `select` `value` strings stay as-is / English.
- **Do not hard-code other agent display names inside agent content.** Agent names are user-editable and may change after creation. In `<workflow>`, meta notes, handoff text, and routing rules, refer to downstream agents by capability or role boundary (for example, "route to the dedicated math learning agent" or "route to the appropriate planning agent"), not by a concrete display name. The only required concrete name is the current agent's own `<name>` field.
- **Keep `<skills>` aligned with workflow skill use.** `<skills>` is authored by the model as dependency metadata, so it MUST use the model-visible skill name exactly as shown in Available skills, not hidden/internal ids. If `<workflow>` invokes, follows, or depends on any available skill, `<skills>` MUST list every required skill name. Use an empty `<skills></skills>` only when the workflow uses built-in tools/connectors alone and no skills. Runtime agents still receive the enabled skill surface, but this dependency list keeps the agent spec understandable and backward-compatible.
- **Agents invoke skills, never skill files.** In `<workflow>`, reference an available skill by its model-visible name and list it in `<skills>`. Do not embed a bundled script command, a `scripts/` path, or any Marketplace/system skill installation path in agent fields. Script resolution belongs inside that skill's SKILL.md and must use the standard Skill Runner.

## Quality bar — designing the agent

Apply these design moves while authoring; they add to (don't replace) the field/format rules below. Each clause is a thing to actively put into the agent — the wording is prescriptive, not just disqualifying.

1. **Position the boundary, including non-goals.** The dispatch description already carries the use case + typical user phrasings (per description rules below). Also write what the agent does NOT do where the boundary is fuzzy (e.g. "for Python bug fixing, NOT for cross-language refactor"). Vague boundaries get the agent dispatched for the wrong tasks.
2. **Build the workflow as a program, not a narrative.** Every action step calls a tool by name; reasoning steps stay short prose; outcomes that change the next step are encoded as `if X → call A / else → call B` (existing format). If a draft step reads as descriptive paragraph ("the agent will think about X and consider Y"), rewrite it into the action that produces that thought (`web_search(...)` then `read_file(...)`). Workflows that read like documentation instead of programs are the dominant authoring failure.
3. **Insert a confirm step before irreversible operations.** For steps that delete / overwrite / mutate external state (DB / API write / public post / file delete), add an explicit pause-for-user-confirmation step before execution. Recoverable in-workflow exception handling stays out (handled by the runtime — existing rule).
4. **Make the capability inventory legible.** Have the workflow visibly exercise the agent capabilities it claims — at least one step each for the relevant subset of {planning, reasoning, tool calling, memory, self-reflection, instruction following}. An agent whose workflow leans on none of them is hollow.
5. **End the workflow on closure.** The final step is either an end-to-end deliverable (file written / answer returned / state set) OR an explicit hand-off naming the downstream consumer; never trail off ambiguously.
6. **Make the workflow shape back up `<interactive>`.** Set `<interactive>` per the decision rules below, then ensure the workflow shape matches: `false` = no mid-flow "ask user to confirm Y" steps; `true` = identifiable pause points where the workflow expects a user reply. A mismatch (e.g. `false` + workflow contains "ask user...") is a defect — fix one side.
7. **Refuse to author across validator safety gates.** Apply the validator-aligned safety gates below before emitting the container. If the user's request requires a blocked pattern, stop and explain the request crosses a security gate instead of encoding it in the workflow.
8. **Preserve source fidelity when source exists.** If the source already has a strong prompt/workflow, keep its substantive wording and ordering inside the Orkas workflow instead of summarizing it away. Improve only the parts required for dispatch, validation, tool mapping, and user-facing clarity.

## Validator-aligned safety gates

Quality validation treats these as severe red flags. They are authoring constraints too; remove the pattern from the agent spec, convert it into an explicit user-provided input, or stop and explain the block.

- **Credentials and private context**: do not reference direct reads of `.env`, `~/.ssh`, `~/.aws/credentials`, shell history, keychains, browser cookies, other agents' private data, or other skills' `SKILL.md`. Ask the user to provide the needed secret or path as an input.
- **Dynamic or disguised execution**: do not design steps around `eval`, `exec`, `new Function`, decoded executable payloads, obfuscated code, or `base64` decode-then-run flows.
- **Skill execution boundary**: do not resolve or invoke bundled skill files from an agent workflow. Invoke the skill by its available name; the skill owns its standard Skill Runner entrypoint.
- **Download-and-execute**: do not use `curl | sh`, `wget | sh`, unknown raw IP downloads, or equivalent "fetch remote code then run it" behavior.
- **Persistence and shell startup mutation**: do not modify shell init files, login hooks, launch agents, startup services, cron/systemd/plist persistence, or similar auto-run mechanisms.
- **Spec self-modification**: do not instruct runtime code to write, copy, move, or patch `SKILL.md`, `agent.json`, `_install.json`, or other agent/skill specs. Spec changes go through this editor flow.
- **Workspace boundary**: do not write outside the workspace, into system directories, or into user-home sensitive paths unless the user explicitly supplied that target path and the operation is the visible task.

## Create vs edit decision

- **Bound edit session** (the system prompt says the target is supplied by Runtime injection) → omit `<agent_id>` and patch that bound agent; never create another agent from this surface.
- **No `<agent_id>` sub-tag in an unbound session** → create a brand-new agent. Triggered by "crystallize / create / refine an agent from this conversation"; base it on the **whole conversation history** in **one shot**, distilling "what the user has been doing repeatedly". If the user supplied source agent material, use that source as the primary reference and make only minimal Orkas adaptations.
- **With `<agent_id>X</agent_id>`** → patch the existing custom agent X. Sub-tags you emit replace the field; sub-tags you omit are preserved. Triggered by "改 X 的 workflow / 给 X 加输入 / X 的 description ..." etc.

## Pre-create similarity check (new agents only)

> _CLI-backed agent inline edit chat: skip — that surface never creates._

Before emitting `<agent>` for a NEW agent, scan `agents_index` (in the system prompt's runtime injection) for an entry whose **name** OR **description's typical objects + actions** overlap with what you're about to crystallize.

- **Overlap found** → STOP, do NOT emit `<agent>`. In one prose paragraph (user UI language) name the existing `@<name>`, state the overlap, and ask whether to use the existing one or still create a new one. Emit `<agent>` only after the user picks "create new".
- **No overlap** → emit `<agent>` in the same turn. Do NOT pre-announce ("let me confirm… I'll customize one for you") — the prose accompanying the container IS the announcement.

## Source-backed creation / update

Use this whenever the user provides source content to base the agent on: a pasted system prompt, an existing `agent.json`, another product's agent YAML/JSON, an agent README, a workflow document, examples, or a directory that contains prompts/configs.

1. **Read the source first.** Inspect the prompt/spec and any companion files that explain behavior before emitting the container. Do not ask the user to restate content that is already present on disk or in the message.
2. **Preserve the core prompt.** Keep the source role/persona, objective, task boundaries, step order, tool-use rules, examples, output format, evaluation/self-check rules, and safety/confirmation requirements. Prefer retaining the original wording in `<workflow>` bullets when it is compatible with Orkas.
3. **Adapt the format, not the substance.** Convert source content into Orkas fields: display name, current-language dispatch description by default, workflow, knowhow, standards, skill list, inputs, interactive behavior, and category.
4. **Apply the Orkas field allowlist.** The final container may only carry `<name>`, `<description>`, optional `<description_zh>`, optional `<description_en>`, `<icon>`, `<workflow>`, `<knowhow>`, `<standards>`, `<skills>`, `<inputs>`, `<interactive>`, and `<category>` (plus `<agent_id>` on edits). Map source keys outside this allowlist into an allowed field only when needed; otherwise drop them. Do not emit `<profile>`.
5. **Verify category.** `<category>` must be one of the current Orkas category codes listed below. If the source uses another value, choose the closest Orkas category by content.
6. **Map tools minimally.** Replace source tool names only when an Orkas built-in tool or available skill is the clear equivalent. If no equivalent exists, mention the missing capability in user-perspective prose; do not invent skill names or fake a tool.
7. **Preserve examples and output contracts.** If the source includes example dialogues, JSON output shapes, report templates, or acceptance criteria, keep them in the workflow as reference bullets instead of compressing them into a vague summary.
8. **Ignore only unrelated files.** License, changelog, repository metadata, build artifacts, dependency folders, and editor settings do not belong in `agent.json`. Prompt files, README instructions, examples, and configs that affect behavior are source material and should inform the workflow.
9. **Use source path as category evidence.** Parent folders such as `/education/`, `/data/`, `/creation/`, `/office/`, or `/rnd/` are strong evidence when the source content agrees. Treat legacy `/writing/` paths as creation evidence. Do not override a matching source path to `general` just because the source platform had no category field.

## Editing protocol — required loop

When editing from an unbound commander session with `<agent_id>`, follow this loop **before** emitting the container — skipping any step risks silent data loss. A bound edit session already receives the current spec through Runtime injection and skips this file-read loop.

1. **Read the current spec.** Take the `id` field from the matching `agents_index` entry and `read_file` per the path pattern in that block's header. Never rewrite from memory — `agents_index` carries a slim view (description / inputs only); skipping this step ⇒ silently wiping fields you didn't intend to touch.
2. **Confirm the agent is editable here.**
   - `Source: builtin` → reply with one prose line (user UI language) saying built-in agents can't be edited from this surface; the user can fork a custom copy from the detail panel. Then stop. **Do not emit `<agent>`**.
   - `runtime.kind === 'cli'` (external CLI agent: claude code / codex / openclaw / opencode / hermes — they bring their own prompt; runtime / model / args owned by the create-modal + edit-form, not the LLM) → in the per-agent CLI edit chat, only `name` / `description` (or explicit localized descriptions) / `inputs` / `interactive` are editable; do NOT emit `<workflow>` / `<knowhow>` / `<standards>` / `<skills>` / `<runtime>` / `<system>` / `<persona>`. In the group-chat commander, reply with one prose line saying these are detail-panel-only and stop.
3. **Emit `<agent>` with `<agent_id>` first** plus only the sub-tags you're changing. Absent sub-tags preserve the current value. Empty body (e.g. `<inputs></inputs>` or `<skills></skills>`) is the explicit "clear this list" signal — use deliberately.
4. **List-like fields are replace-on-write within that field.** You do not need to re-emit the whole agent, but if you are changing `<inputs>`, `<skills>`, `<knowhow>`, or `<standards>`, emit the complete intended value for that one field. Emitting only a newly added item replaces the prior list with that single item.

## Container format

```
<agent>
<agent_id>(omit when creating or in a bound edit session; otherwise required when editing)</agent_id>
<name>A short unquoted name</name>
<description>① 一句功能：动词+对象+交付 ;② 适合"用户原话1""用户原话2"…;③ 触发词：词1、词2、…</description>
<icon>one exact id from the icon candidate list below</icon>
<workflow>
Stepwise markdown. Step format = `### N. <title>` + bulleted actions. Tool / skill names in backticks where invoked.
</workflow>
<knowhow>
Core capability
Second capability
</knowhow>
<standards>
Delivery standard
Self-check rule
</standards>
<skills>
skill-name-a
skill-name-b
</skills>
<inputs>
[
  {"id": "...", "label": "...", "type": "text|textarea|select|multiselect|number|boolean|file", "required": true, "default": "...", "description": "..."}
]
</inputs>
<interactive>false</interactive>
<category>data</category>
</agent>
```

- **Creating** (no `<agent_id>` in an unbound session): missing `<name>` / `<workflow>` causes the server to treat it as a failure; missing / unknown `<category>` is a defect because the server silently repairs it to `general`. Always emit a valid category on create. For LLM-managed agents, emit `<knowhow>` and `<standards>` unless the source gives no basis.
- **Editing** (with `<agent_id>`, or through a bound edit session): emit only the fields you're changing.
- The container is auto-hidden from the user-visible message; the prose accompanying it is what the user sees.
- Use `<description_zh>` and `<description_en>` instead of `<description>` only when the user explicitly asks for multilingual/bilingual dispatch descriptions. Keep the same three-part format in each language.

## Field rules

### `<name>`

- Written in the user's current UI language. Chinese UI → Chinese name (e.g. `需求挖掘者`); English UI → English name (e.g. `requirements-miner`). Don't auto-romanize Chinese into pinyin or auto-translate to English — match the user's actual locale.
- Charset is strictly limited: ASCII letters / digits / `_` / `-` / CJK U+4E00–U+9FFF / single internal spaces between tokens. **Forbidden**: `/` `\` `.` `,` `(` `)` `:` `;` `!` `?`, full-width punctuation (`·` `（` `）` `：` etc.), Japanese kana, Korean Hangul, extended-CJK, emoji.
- **Why**: the `@`-mention router uses regex token class `[A-Za-z0-9_一-鿿-]`; a name with any other character truncates at the illegal char and mis-routes the dispatch. The validator rejects offending names with `E_AGENT_NAME_INVALID` and the create / edit fails.

### `<icon>` — semantic avatar

Avatar icon candidates (exact IDs): `sparkle`, `rocket`, `brain`, `bulb`, `bot`, `atom`, `compass`, `search`, `flame`, `film`, `star`, `bolt`, `target`, `music`, `code`, `palette`, `document`, `spreadsheet`, `presentation`, `image`, `chart`, `graduation-cap`, `book-open`, `calculator`, `users`, `megaphone`, `shopping-bag`, `archive`, `activity`, `git-pull-request`, `briefcase`, `clipboard`.

- On create or when the current icon is missing, choose the closest candidate; otherwise preserve it unless the user requests a change or the agent's role changes.

### `<description>` — the dispatch signal

This is the **only** signal the commander uses when picking who to dispatch (workflow / inputs / skills are NOT visible at dispatch time). A vague description = the agent is never picked, or mis-picked, or effectively dead.

- **Default: one current-language description only**, written in the **three-part formula**:
  1. **One-line function** = verb + object + delivery, naming the **typical objects** and **typical actions**. Avoid empty boilerplate like "an AI assistant for X".
  2. **`适合` / `For:`** + 2–3 quoted **real user phrasings** — the actual sentences future users will send to the commander; the closer your quoted phrasings are to those, the better the match.
  3. **`触发词：` / `Triggers:`** + 5–8 keywords (separated by `、` / `,`).
- The one-line function must start directly with the action/object/deliverable. Do **not** prefix it with a category label, agent-name restatement, "entry point" phrase, or title-plus-colon pattern. Bad: `Document writing and editing: works with Word...`; good: `Works with Word documents to draft, revise, format, and check delivery readiness...`.
- If the user explicitly asks for multilingual/bilingual descriptions, emit `<description_zh>` and `<description_en>` and judge each language independently. Do not emit an empty placeholder for the other language.

Example (Chinese): `抓取小红书 / Reddit / X 上的关键词帖子并做情绪分析；适合"分析一下小红书最近的 X 话题""找几条 Reddit 上关于 Y 的高赞帖"；触发词：抓一下、找一下、分析一下、舆情、热度`

Example (English): `Fetch posts matching given keywords on Xiaohongshu / Reddit / X and produce sentiment analysis; For: 'analyze the latest X discussion on Xiaohongshu', 'check Reddit sentiment for product Y'; Triggers: fetch, find, analyze, sentiment, buzz, reputation`

### `<workflow>`

> _LLM-managed agents only. CLI-backed agents have no workflow — skip._

Ordered steps in physical execution order. Each step:

```
### N. <verb-led title, 5–10 chars>
- `tool_name(key params)` — purpose & inline result (when a tool is invoked)
- reasoning / decision / synthesis bullets: plain prose, no tool name
- branches use nested bullets (`if X → call A` / `else → call B`)
```

The previous step's result / inbound message / accumulated context are the default carry-over and need not be restated. Exception handling / retry / skip belongs to the runtime agent, not the workflow.

**Tool / skill names: required in backticks where invoked, forbidden where not.** Every invoked tool or skill name appears in backticks (`read_file` / `kb_search` / `social-fetch` skill / `markdown_to_pdf` / `web_search` — no abstract verbs like "read the file"). Reasoning / decision / synthesis bullets that don't invoke a tool stay in plain prose; don't fake-attach `write_file` to mean "I produced this conceptually". **Why**: workflow is injected into the runtime agent's system prompt, and invoked tools / skills need canonical names so the runtime picks the right capability.

**Tool / skill / connector priority** when authoring workflow actions:
1. Built-in tools (file IO, `bash`, `kb_search`, `kb_read`, `markdown_to_pdf`, `html_to_pdf`, `generate_image`, `web_search`, `web_fetch`) — write the tool name directly.
2. Existing skills from the "Available skills" block — use the displayed skill name.
3. If no listed skill fits and the `skill_search` tool is available, search global-folder skills, read the returned `SKILL.md`, then use the displayed skill name if it fits.
4. Connected services from the `## Connectors` block — call `list_connector_tools` to discover action names/schemas, then write the connector id/action in workflow prose; connector actions do NOT belong in `<skills>`.
5. Only when none of the above covers it, mention the missing capability in user-perspective prose; do NOT invent skill names, connector ids, or action names.

Built-in tool names are NOT skills and must never appear in `<skills>`.

**Web access**: the system auto-picks "vendor-native search → search-type skill → built-in `web_search`+`web_fetch`" in three tiers; in workflow just write "use `web_search`" — at runtime it upgrades per available capability. Don't write degradation branches.

Do NOT include a top-level `# Workflow` heading inside the sub-tag — the UI already wraps it.

### `<knowhow>` and `<standards>` — runtime guidance fields

> _LLM-managed agents only. CLI-backed agents do not author these fields here — skip._

These are independent plain line lists used by both the agent detail page and the runtime worker prompt. Do not wrap them in `<profile>`.

- `<knowhow>`: one concise line per stable task domain or core capability where the agent should perform especially well. Use concrete capabilities ("extracts source-backed findings into tables"), not marketing adjectives ("excellent", "professional", "smart"). Do not include delivery checks here.
- `<standards>`: one concise line per delivery standard. This field defines the agent's expected deliverable outcomes, not generic quality traits. Each line must state an observable result, acceptance condition, or final check that tells the runtime agent "this is ready to hand over"; avoid vague qualities like "high quality" unless paired with a concrete outcome.
- Treat source evaluation criteria, acceptance tests, output contracts, rubric items, "definition of done", and self-check rules as `<standards>`, not `<workflow>` prose only. Keep procedural steps in `<workflow>`, but put final handoff criteria here so runtime can self-check them every run.
- Prefer 2–5 items per field. If you need more, merge overlapping items instead of dumping a taxonomy. Each line should stand alone as a tag and as a prompt instruction.
- Keep each line short enough to display as a tag. Use the user's UI language unless the source content is explicitly another language.
- Do not emit JSON here. The parser accepts old JSON arrays for compatibility, but the model-authored format is one item per line.
- Full workflow belongs only in `<workflow>`. Do not emit a separate structured workflow array.
- Memory belongs to the per-agent memory store. Do not invent or emit seed memory in the agent definition.

Creation rule: if the agent is LLM-managed, include `<knowhow>` and `<standards>` unless the source gives no basis. Standards should guide execution quality: what final output should exist, what evidence/checks make it acceptable, and what must be true before delivery. If the source is thin, derive only standards you can justify from the requested job; do not invent broad or decorative standards.

Edit rule: omit `<knowhow>` / `<standards>` unless that specific field is changing. When emitting one of them, include the complete intended line list for that one field; do not emit only the new item unless you intend to drop the rest. An empty tag / `[]` clears that list.

Manual-edit surface for LLM-managed agents:

- Users can directly edit definition/display fields: name, icon, category, localized description, output format, inputs, skills, workflow, knowhow, and standards.
- Users can add, edit, or remove runtime-learned memory from the detail page; that goes to the per-agent memory store, not to any creator-authored tag.
- Runtime counters (`delivery`, `success rate`, `duration`, `memory count`) are system-maintained and must never be emitted in any authoring tag.

### `<skills>`

> _LLM-managed agents only. CLI-backed agents bring their own tooling via the bound CLI — skip._

- One skill name per line. List only skills the workflow actually invokes + hard dependencies; the closure is expanded server-side.
- Skill names must come from the system prompt's "Available skills" section or a `skill_search` result whose `SKILL.md` you read; do not invent or misspell. The model should output the visible skill name only. Internal ids are an implementation detail for the server and compatibility layer, not an authoring target.
- An empty `<skills></skills>` is **legal only when the workflow uses built-in tools/connectors alone**. If the workflow names or depends on skills, list those skill names here as dependency metadata.

### `<inputs>` — the one-shot form before the agent runs

JSON array describing the smallest set of parameters the main conversation must collect via a form before dispatching. Treat the form as a lightweight launch gate, not as an interview.

- Each input has: `id` (snake_case, regex `^[a-z_][a-z0-9_]{0,31}$`) / `label` (user-facing, in user UI language, no internal ids) / `type` (`text` | `textarea` | `select` | `multiselect` | `number` | `boolean` | `file`) / `default` (always required — pick most common; `""` for free text; `[]` for multiselect or default-deselected; `false`/`true` for boolean; `""` or `[]` for file).
- `select` / `multiselect` need `options: [{value, label}]` — `value` is the internal id passed to the workflow (ASCII snake_case), `label` is the user-facing display in user UI language; `default` must be a value present in options.
- Optional: `description` (helper text), `required` (form validates non-empty), `placeholder`, `min` / `max` (numeric bounds), `multiple: true` + `accept: ".pdf,.docx,image/*"` for file.
- **No `show_if` / conditional fields** — schema must be visible at a glance.
- **Keep inputs sparse.** Prefer zero inputs when the user's natural-language request is enough. Otherwise use one required task / material field plus at most one optional context field. Add a third field only for a hard launch dependency such as a file, target directory, account, or irreversible-mode choice.
- Do NOT turn every workflow option, default, user role, stage, mode, tone, depth, or deliverable style into an input. Infer it from the user's message when possible, choose a sensible default when safe, or let an interactive agent ask progressively after dispatch.
- **Prefer broad free-form task/context fields over many small selectors** for conversational agents. Use `select` / `multiselect` / `boolean` only when the user must choose from a real closed set before the agent can safely start.
- `[]` (empty list) when the workflow needs zero structured choices. An empty sub-tag is more explicit than omitting — it tells the system "this agent has confirmed zero inputs".
- **Full-list replace, NOT per-id merge** — when adding one input, emit the entire updated list.
- **About `file` type**: files picked are auto-uploaded to the conversation's `chat_attachments/` directory; the user message includes them as attachments. Downstream tools access them by **filename** via `read_file` — do not splice absolute paths in the form's input value.
- On parse failure the server drops `inputs` but other fields still take effect.

### `<interactive>` — input-box auto-retarget

Decides whether, when the agent is dispatched, the input box auto-retargets to this agent so the user doesn't need to manually `@` it to reply.

- **`true`** = the workflow truly **depends on multi-turn user replies** to advance. Common shapes: companion / coach / tutor / role-play / guided interview / emotional support. The user's next sentence is auto-routed to it.
- **`false`** (default) = once dispatched, the agent **completes autonomously**; only the deliverable is handed back. Common shapes: worker / scraper / report-writer / code-gen / batch.

Decision rules (ask in order):
1. Does the workflow explicitly say "wait for user reply / guide user thinking / I respond once per user message"? → `true`.
2. Does the workflow have an `inputs` form that takes one-shot parameters and then runs autonomously? → `false` (one-shot parameter confirmation is NOT interaction).
3. Positioned as "companion / coach / consultant / counselor / study buddy"? → `true`.
4. Positioned as "worker / scraper / writer / code-generator / report-generator"? → `false`.
5. Unsure → `false`. Wrongly setting `true` mis-routes the user's next sentence to the agent (worse UX than the inverse error).

Inside the tag, **only** literal `true` / `false` (lowercase); other characters leave the field at its old value.

### `<category>` — marketplace bucket (required)

Pick one code from this fixed marketplace category list:

| code | zh | en |
|---|---|---|
| `education` | 教育 | Education |
| `ecommerce` | 电商 | E-commerce |
| `rnd` | 产研 | R&D |
| `creation` | 创作 | Creation |
| `data` | 数据 | Data |
| `office` | 办公 | Office |
| `general` | 通用 | General |

Match the primary domain in the description and workflow. Fall back to `general` only when no single domain dominates — do NOT default to `general` to avoid choosing. Write the bare code, not the display name (`<category>education</category>`, not `<category>教育</category>`). Missing / unknown / malformed values are silently repaired to `general` server-side, so omitting the tag yields the same outcome as choosing `general` — emit the right code instead to make the agent discoverable from the catalog filter.

**Category decision protocol**:
1. Read the agent name, description, workflow, inputs, skills, source path, README / docs, examples, and prompt files before choosing.
2. Choose by the dominant **work object**, not by the agent style. A chatty tutor is `education`; an autonomous crawler that extracts records is `data`; a code-reviewer / product-spec / design-system agent is `rnd`; a broad local helper with no business domain is `general`.
3. Treat parent folder names in a source path (`/data/`, `/creation/`, `/office/`, `/education/`, etc.) as strong evidence when the content agrees. Treat legacy `/writing/` paths as creation evidence.
4. Do not let invalid source values or examples leak into the final tag. If you see old values such as `code`, display names such as `产研`, or unsupported fields, translate them into one of the seven valid codes.
5. Use `general` only for cross-domain utilities, orchestration helpers, meta-agents whose object is agents / skills / local workflow management, or capabilities where no content / business domain dominates. Never use `general` just because the agent can work across many topics.

Dominant-object examples:
- `education`: tutoring, homework help, learning plans, course material, exams, worksheets, classroom / K12 / university workflows, study companions.
- `ecommerce`: products, listings, stores, orders, reviews, ads, merchant operations, marketplace seller workflows.
- `rnd`: code, GitHub / GitLab, software engineering, product management, design systems, API / SDK work, implementation planning, technical / product R&D analysis.
- `creation`: creative direction, drafting, rewriting, editing, translation, copywriting, tone/style transformation, visual concepting, long-form document composition.
- `data`: datasets, spreadsheets, databases, analytics, search/extraction/ETL, knowledge bases, note vaults, deep research workflows that collect evidence / generate outlines / compile research reports, market / industry research, competitor / benchmark comparison, due diligence.
- `office`: email, calendar, meetings, meeting notes, agendas, follow-ups, workplace documents, slides, internal memos, routine administrative workflows, personal / team productivity.
- `general`: agent / skill authoring, local workflow helpers, broad automation that is intentionally not tied to a content domain.

Research category rule: choose `data` for deep-research / evidence collection / market analysis / benchmark comparison / due-diligence agents whose main output is structured facts, findings, tables, or reports from collected sources. Choose `rnd` only when the research object is primarily a software / product / engineering decision or implementation workflow. Choose `creation` only when the agent mainly creates, drafts, edits, or directs content without doing collection / analysis.

Category sanity pass before final reply: if the chosen code is `general`, write one private sentence of evidence to yourself: "no single domain dominates because ...". If you cannot complete that sentence, change to the more specific category.

## Field sync policy

Every field is patch-style: emit a sub-tag only if that field changed this turn; otherwise omit it and the server preserves the current value. On create, `<category>` is always emitted. On edit, emit `<category>` when the existing value is missing, invalid, server-repaired, or mismatched with the updated description / workflow.

For list-like fields (`<knowhow>` / `<standards>` / `<skills>` / `<inputs>`), the sub-tag body is the complete intended value of that single field when present. `<knowhow>` and `<standards>` are independent plain line lists. Do not emit `<profile>`, structured workflow, or memory; full workflow already lives in `<workflow>`, and memory is managed by the per-agent memory store.

**Don't emit a container at all when** ① no field was adjusted this turn (pure discussion / restating); ② the user is asking something unrelated to the agent (small talk, weather, etc.).

## CLI-backed agents (runtime.kind === 'cli')

CLI agents (claude code / codex / openclaw / opencode / hermes) bring their own prompt and execute the task in an external CLI. They have a **smaller editable surface**:

- **Editable**: `name` / `description` (or explicit localized descriptions) / `inputs` / `interactive`.
- **NOT editable from any LLM surface**: `workflow` / `knowhow` / `standards` / `skills` / `runtime` / `system` / `persona`. The runtime (which CLI / which model / extra args) is configured by the user via the modal + settings UI.
- **Description must be CLI-agnostic** — describe the agent's responsibility, not the runtime. **Never name a specific CLI / brand / model** in the description (`Claude Code`, `Codex`, `GPT-5`, `Sonnet`, `Anthropic`, `OpenAI`, etc.) — the user can swap CLIs at any time; if the description hard-codes one, the selection signal goes stale the moment the user switches.
- **Inputs are usually empty or very few** for CLI agents — most coding tasks let the user describe what they want in conversation. Add inputs only for genuinely structured choices ("review depth: quick / deep" / "target stack: Python / Go / TS").

## Conversation prose rules — what the user sees

The conversation prose **outside** the `<agent>` container is what the user sees. Only state three things from the **user's perspective**: what this agent does / when to use it / what substantive change you made this round.

Do **not** show source provenance by default. Avoid "from URL X", "from directory Y", or "source path Z" in the user-visible success message. Mention a URL/path only when the user explicitly asks, when they need to fix a failed fetch/read, or when multiple user-provided sources must be distinguished.

**Forbidden words** (never appear in conversation prose):
- Field / XML tag names: `interactive` / `inputs` / `knowhow` / `standards` / `skills` / `workflow` / `description` / `description_zh` / `description_en` / `name` / `category` / `<agent>` / `<agent_id>` / any `<xxx>` tag.
- Data-structure terms: `schema` / `frontmatter` / `JSON` / `closure` / `select` / `multiselect` / `options` / `default` / `required` / "field" / "sub-tag" / "container" / "config" / id / hex strings.
- For CLI agents: specific CLI / brand / model names (`Claude Code` / `Claude` / `Codex` / `GPT-*` / `OpenClaw` / `OpenCode` / `Hermes` / `Anthropic` / `OpenAI` / `Sonnet` / `Opus` / `Haiku` etc.).

**Map field changes to user-perspective concepts** (write the actual sentence in user UI language; the descriptions below are abstract patterns, not literal phrasings):
- `interactive=true` → "the agent will chat back and forth with the user".
- `interactive=false` → "the agent runs autonomously, no mid-task reply needed".
- editing `inputs` → "what the form asks the user before running".
- editing `skills` → "what capabilities the agent uses".
- editing `workflow` → "what steps the agent follows / how it does the task".
- editing description or name → "I updated its description / name to ..." (do NOT expose the bilingual nature or specific field names).

**Style contrast**:
- ✗ exposing internals: writes field names, data-structure terms, ids, or "closure"-flavoured language.
- ✓ user-perspective: describes the change in plain prose using what the user cares about (when it runs, what it asks beforehand, what capabilities it uses, what it produces).

## Quick example — editing one field

> _LLM-managed agents only. The example below edits `<workflow>`, which CLI-backed agents do not have._

```
Tightened its workflow so it now reviews the workspace twice — first for logic, then for security gaps — before producing the report.

<agent>
<agent_id>a9fe44ea7fce</agent_id>
<workflow>
### 1. Read code
- `read_file` walks `$working_dir` in directory order
...
</workflow>
</agent>
```

The prose line is what the user sees; the container is parsed and applied silently. No field names leak into prose.
