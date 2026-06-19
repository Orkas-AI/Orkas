---
name: skill-creator
description: "Author or edit a user-explicit custom skill via `<skill>` containers, metadata tags, and `<<<skill-file>>>` blocks; For: 'make a skill that does X', 'tweak the X skill', 'import this existing SKILL.md / skill package as a custom skill'; Triggers: create skill, make a skill, write a skill, edit skill, import existing skill."
---

# skill-creator

Authoring rules for creating or editing a custom skill via the `<skill>...</skill>` container, lightweight metadata tags, and `<<<skill-file>>>` blocks. Used by group-chat commander and per-skill inline edit chats. The container is parsed post-stream by `bus.ts` (commander surface) or `features/skills.ts` (per-skill chat); the LLM does not call any tool — it embeds the container in its final reply text and ends the turn.

## When to consult this skill

`read_file <ROOT>/skill-creator/SKILL.md` whenever you're about to:

- Create a new skill (user says "做一个 skill / make me a skill that does X / 把这个能力封装成 skill").
- Edit an existing skill (user says "改一下 X skill / X 的 SKILL.md 写得不清楚 / 给 X skill 加一个脚本").
- Import an existing skill from a URL, attachment, or directory **only when the user explicitly asks to create/import/add it as a skill**.

Do **not** consult this skill for a plain "install this URL / install this GitHub repo / add this project" request. That is an external-package install unless the user explicitly says the target is a skill or asks to create a custom skill from it; use `package-installer` for plain installs.

You **must** consult before emitting any `<skill>` container, `<skill-meta>` block, or `<<<skill-file>>>` block. The `<<<skill-file>>>` block is whole-file replacement; metadata tags are field-level updates for frontmatter-only changes.

## Mental model

A skill is **an independent tool capability**, not a tutorial. When the LLM sees a matching user request, it picks the skill, invokes it once or a few times per the SKILL.md interface, takes the result, and folds it into its answer. Anchors:

- **Single responsibility**: one skill does one clear thing. "Analyze + write report + send email" is three things — split into three skills.
- **Self-contained / no inter-dependencies**: each skill stands alone — no references to / calls into other skills. External dependencies (runtime, CLIs, API keys) are stated plainly in the SKILL.md body.
- **SKILL.md is the interface description for the LLM**, not user documentation. Capability language describing "what to do".
- **Prefer guide-type, scripts as fallback**: if generic tools (file IO / `kb_search` / `web_fetch` / `bash` / etc.) suffice, don't write a script.

## Hard rules (non-negotiable)

- **Mutation only via lightweight metadata tags or `<<<skill-file>>>` blocks.** Use metadata tags for metadata-only changes (`name`, `description`, optional `description_zh`, optional `description_en`, `category`, and routing hints). Use `<<<skill-file>>>` for file content changes. Do NOT use `edit_file` / `write_file` / `bash` (with redirects) to mutate any file under the skill directory. Read for inspection is allowed; every write goes through the parsed protocol so skill rename / registry invalidation / progress events run correctly.
- **Do NOT dump the container or any inner block as a workspace file.** The server parses them inline and persists to `<skill_dir>/<path>`.
- **Explicit creation intent required.** Do not create a custom skill merely because the user provided a URL, file, repo, README, or tool docs. Create/import only when the user's wording names skill creation/import, asks to convert material into a skill, or is already inside a per-skill creation/edit flow. If intent is ambiguous, ask one short clarification or use the package installer for a plain install.
- **Cross-skill writes are no longer supported.** Inside an inline edit chat, only the current skill's directory is writable. Do not try `<<<skill-file skill=...>>>` (deprecated).
- **Do not hard-code other skill names inside skill content.** Skills are independent and names may change. In `SKILL.md`, references, scripts, examples, boundary text, and routing notes, do not tell the caller to invoke another skill by display name, directory name, or internal id. Describe only this skill's own capability and non-goals; put multi-skill routing in the main conversation LLM or an agent workflow.
- **One `<skill>` container per skill being created/edited this turn.** Several are allowed when the user requested multiple distinct skills or when the source contains multiple existing `SKILL.md` files. Do not merge multiple source skills into one Orkas skill. End the turn after — do NOT call `dispatch_to`.
- **Source-preservation default.** When the user supplies existing source content as the reference (URL, directory, attachment, pasted `SKILL.md`, scripts, references, examples, or a prior skill package), treat it as an already-working skill and preserve its core content. If the source clearly contains a `SKILL.md`, restore that skill as faithfully as possible. Only adapt Orkas-required metadata, command/tool compatibility, and obvious non-runtime clutter. Do NOT replace the source body, scripts, or reference files with a generic template unless the user explicitly asks for a rewrite.
- **No silent defaults, no silent residue.** Before the final reply for any create / edit / import, run the category sanity pass and final resource audit below. Do not say "done" while the category is merely the fallback `general` or while unrelated installer / repository files remain in the skill directory.
- **Output language follows the user's UI language** — every human-readable part of the SKILL.md you author (section titles, body prose, example labels, `## When to use` / `## How to call` / etc. — write them in the user's UI language, e.g. `## 何时使用` / `## 如何调用` for Chinese UI) plus the conversation prose around the `<skill>` container all go in the user's current UI language (per the "User language" directive in the system prompt; that directive's coverage applies even though this file reaches you as a `read_file` result). The SKILL.md `description` uses the same current UI language by default and keeps the three-part dispatch format. Only emit both `description_zh` and `description_en` when the user explicitly asks for multilingual/bilingual support. Code blocks, file paths, frontmatter field names (`name` / `description`), `<<<skill-file>>>` syntax, and skill_id strings stay as-is. The English used in this file (including the section names listed in "Quality bar — SKILL.md body" below) is illustrative shape, not literal text to copy.

## Quality bar — designing the skill

Apply these design moves while authoring; they apply on top of the dedicated `Quality bar — frontmatter` and `Quality bar — SKILL.md body` sections below. Each clause is a thing to actively put into the skill — the wording is prescriptive, not just disqualifying.

1. **Hold the single-task boundary; split rather than expand.** Already a hard rule (Mental model + "Skills are mutually independent"). At design time: a skill that bundles "analyze + report + email" splits into three. Empirical finding from skill benchmarks: 2–3 focused skills outperform a single-everything skill — when in doubt, split.
2. **State the boundary AND the non-goals.** The dispatch description already carries what the skill does (existing rules); also state what the skill explicitly does NOT do where the boundary is fuzzy (e.g. "fetches X but does NOT cache or rate-limit; caller handles those") so the dispatch LLM doesn't pick the skill for the wrong job.
3. **Write the body as actionable steps, not narrative.** Body's "How to call" lists steps the LLM can execute (existing rule). If a draft section reads as documentation prose ("this skill helps with X by considering Y"), rewrite it into the steps the LLM actually runs. Bodies that read like marketing copy instead of an interface are the dominant authoring failure.
4. **Stabilize the return schema for executable skills.** Body's "Return format" gives the same key set on success and failure, with `ok` as the discriminator. Stability lets the caller pattern-match without runtime sniffing — and makes the skill verifier-friendly.
5. **Require a confirm step before irreversible operations.** For skill operations that delete / overwrite / mutate external state (DB / API write / public post), the body's "How to call" instructs the caller to confirm before execution.
6. **Refuse to author across validator safety gates.** Apply the validator-aligned safety gates below to `SKILL.md`, scripts, references, and imported source. If the source material requires a blocked pattern, stop and explain the request crosses a security gate instead of preserving it.
7. **Preserve source fidelity when source exists.** If source material already provides `SKILL.md`, `scripts/`, `references/`, `assets/`, `examples/`, tests, configs, prompts, or templates, keep their meaning, order, filenames, and directory layout. Apply the scratch-authoring template only to brand-new skills without source material.

## Validator-aligned safety gates

Quality validation treats these as severe red flags. They are authoring constraints too; remove the pattern from the skill, convert it into an explicit user-provided input, or stop and explain the block.

- **Credentials and private context**: do not read `.env`, `~/.ssh`, `~/.aws/credentials`, shell history, keychains, browser cookies, other agents' private data, or other skills' `SKILL.md`. Ask the user to provide the needed secret or path as an input.
- **Dynamic or disguised execution**: do not use `eval`, `exec`, `new Function`, decoded executable payloads, obfuscated code, or `base64` decode-then-run flows.
- **Download-and-execute**: do not use `curl | sh`, `wget | sh`, unknown raw IP downloads, or equivalent "fetch remote code then run it" behavior.
- **Persistence and shell startup mutation**: do not modify shell init files, login hooks, launch agents, startup services, cron/systemd/plist persistence, or similar auto-run mechanisms.
- **Spec self-modification**: do not write, copy, move, or patch `SKILL.md`, `agent.json`, `_install.json`, or other agent/skill specs from runtime code. Spec changes go through the editor protocol.
- **Workspace boundary**: do not write outside the workspace, into system directories, or into user-home sensitive paths unless the user explicitly supplied that target path and the operation is the visible task.

## Create vs edit decision

- **No `<skill_id>` sub-tag** → create a brand-new skill. The new skill's id comes from the SKILL.md frontmatter `name` field; you choose it.
- **With `<skill_id>X</skill_id>`** → patch an existing custom skill X. `X` MUST come from the `## Available skills` block; do NOT invent.

## Pre-create similarity check (new skills only)

Before emitting `<skill>` for a NEW skill, scan the `## Available skills` block for an entry whose **name** OR **description's typical objects + actions** overlap with what you're about to create.

- **Overlap found** → STOP, do NOT emit `<skill>`. In one prose paragraph (user UI language) name the existing skill, state the overlap, and ask whether to use the existing one or still create a new one. Emit `<skill>` only after the user picks "create new".
- **No overlap** → emit `<skill>` in the same turn. Do NOT pre-announce ("let me confirm… I'll create one for you") — the prose accompanying the container IS the announcement.

## Editing protocol — required loop

1. **Read the current SKILL.md** via `read_file(<ROOT>/<id>/SKILL.md)` — the path pattern is in the `## Available skills` block header. Never rewrite from memory. For a frontmatter-only change, emit only metadata tags; for a file-body change, `<<<skill-file>>>` is whole-file replacement and a partial SKILL.md wipes the rest of the body.
2. **If `Source: builtin`** → reply with one prose line (user UI language) saying built-in skills can't be edited from this surface; the user can fork a custom copy from the detail panel. Then stop. **Do not emit `<skill>`**.
3. **Emit `<skill>` with `<skill_id>` first**, then only the metadata tags or `<<<skill-file>>>` blocks you're changing. SKILL.md edits may change `name`; the system auto-renames the directory to match.

## Lightweight metadata edits

Use this path when only `name`, the dispatch description, `category`, or routing hints change. Do NOT rewrite the full SKILL.md for a category-only, routing-only, or description-only edit.

Commander / group chat shape:

```
<skill>
<skill_id>existing-skill-id</skill_id>
<category>data</category>
</skill>
```

Per-skill inline edit chat shape (no outer `<skill>` wrapper because the current skill is already known):

```
<skill-meta>
<category>data</category>
<negative_examples>
- user asks for unrelated work
</negative_examples>
<applicable_domain>research notes and evidence collection</applicable_domain>
<prerequisites>
- source files are available to read
</prerequisites>
</skill-meta>
```

Allowed metadata tags: `<name>`, `<description>`, `<description_zh>`, `<description_en>`, `<category>`, `<negative_examples>`, `<applicable_domain>`, `<prerequisites>`. Omit unchanged fields. The routing tags are stored under `_meta.json.routing`; write list values as newline bullets. If file content changes too, combine metadata tags with the relevant `<<<skill-file>>>` blocks; metadata tags win for those fields.

Default metadata tags for descriptions:
- Use `<description>` for the current UI language.
- Use `<description_zh>` and `<description_en>` only when the user explicitly asks for multilingual/bilingual skill descriptions.
- Keep the old three-part dispatch format in every description you write: one-line function; suitable user phrasings; trigger words.

## `<<<skill-file>>>` block format

Each file under the skill directory is written via this whole-file replacement block:

```
<<<skill-file path=<rel-path>
…full file content…
>>>
```

- `path=` is **relative to the skill directory** (e.g. `SKILL.md` / `scripts/fetch.py`); `..` and absolute paths are rejected.
- Each block is a **whole-file replacement** of `path`; partial edits → read the file first, then write the full new version.
- A single `<skill>` container may contain metadata tags plus multiple file blocks (SKILL.md + scripts + examples). Failures within one block do not roll back earlier successful writes; rejected paths surface as an error pill.
- **Deleting** a file is not done through this block — use the `delete_file` tool. See "Deleting a file from a skill" below.

## Deleting a file from a skill

Use the `delete_file` tool (NOT a `<<<skill-file>>>` block) — two-step token flow:

1. **Step 1: ask** — `delete_file({ path: "<abs path>" })` without a token. Tool returns immediately with `requires_user_confirmation: true` + a `confirmation_token`, and the path is added to an inline confirmation card for the user. For multiple intended deletes, issue one Step 1 call per file in the same turn, then stop. Do NOT call delete_file with any token again this turn. In your reply prose, tell the user what file(s) you're about to delete and ask them to click the card. End the turn.
2. **Step 2: complete** — after the user's next reply (which can be anything: "yes", "go ahead", silence, or unrelated chat — the card click is what matters), call `delete_file({ path, confirmation_token: "<token from step 1>" })`. Tool checks the card state:
   - `granted` → file is unlinked.
   - `pending` (`E_AWAITING_USER`) → user hasn't clicked yet; stop and wait for the next reply, then retry with the same token.
   - `denied` (`E_USER_DENIED`) → user declined; do not retry, treat the file as kept.
   - `invalid` (`E_INVALID_TOKEN`) → token expired or path changed; call Step 1 again to mint a fresh card.

**Only call `delete_file` for files inside the current skill directory.** If the user explicitly names files, delete only those. If the user asked to import / create / clean up a skill, that request implicitly authorizes you to propose cleanup for unrelated files you found inside the copied skill directory; still use the two-step confirmation card and name the evidence for each proposed deletion. Bundle multiple deletes by issuing one Step 1 call per file in the same turn; each call gets its own token, and the UI groups pending paths into one confirmation card when possible. After the user confirms, complete each file on the next turn with its matching token.

## Container shape

```
<skill>
<skill_id>(omit when creating; required when editing)</skill_id>
<category>data</category>
<<<skill-file path=SKILL.md
---
name: short-ascii-id
description: ① 一句功能 ;② 适合"用户原话1""用户原话2";③ 触发词:词1、词2、…
---

# Body sections per the Quality bar below
>>>
<<<skill-file path=scripts/<basename>.py
…optional implementation script…
>>>
</skill>
```

For metadata-only edits, omit all `<<<skill-file>>>` blocks and emit only the changed metadata tags. For new skill creation, still include a full `SKILL.md` block because `name`, description, and body must be initialized together; emit `<category>` beside it so Orkas can store category in `_meta.json`.

## Quality bar — frontmatter

**SKILL.md frontmatter has exactly two portable fields, both required**: `name` + `description`. **No** `description_zh` / `description_en` / `category` / `requires` / `external_deps` / `tags` / `version` in SKILL.md. Orkas-only metadata is emitted through metadata tags and stored in `_meta.json`; external dependencies go in the body's "External dependencies" section as plain text.

### `name`

- The skill id AND the directory name.
- **Strict ASCII charset**: letters / digits / `_` / `-`. Single internal spaces between word groups allowed. **No** Chinese / pinyin / `.` / `/` / full-width punctuation / emoji.
- Pick a short descriptive English slug (e.g. `social-fetch`, `code-reviewer`).
- The validator rejects any other charset and the create fails with `E_SKILL_NAME_INVALID`.
- **`name` is NOT translated to the user's UI language** — it's an identifier, not display copy. The dispatch description carries the user-facing display text.

### `description` — the dispatch signal

This is the **only** signal that decides whether the LLM picks the skill at runtime — at runtime the version matching the user's current UI language is injected into the main conversation's system prompt.

- **Default: one current-language description only**, written in the **three-part formula**:
  1. **One-line function** = verb + object + delivery, naming the **typical objects** and **typical actions**. Avoid empty boilerplate.
  2. **`适合` / `For:`** + 2–3 quoted **real user phrasings**.
  3. **`触发词：` / `Triggers:`** + 5–8 keywords (separated by `、` / `,`).
- If the user explicitly asks for multilingual/bilingual descriptions, emit `<description_zh>` and `<description_en>` metadata tags as well. Write them independently in the same three-part format; don't direct-translate if better real user phrasings exist.

Example (Chinese): `抓取小红书 / Reddit / X / Bilibili / YouTube 上指定关键词的帖子并做情绪/趋势分析；适合"分析一下小红书最近的 X 话题""找几条 Reddit 上关于 Y 的高赞帖"；触发词：抓一下、找一下、分析一下、舆情、热度`

Example (English): `Fetch posts matching given keywords on Xiaohongshu / Reddit / X / Bilibili / YouTube and produce sentiment/trend analysis; For: 'analyze the latest X discussion on Xiaohongshu', 'check Reddit sentiment for product Y'; Triggers: fetch, find, analyze, sentiment, buzz`

### `category` — Orkas metadata bucket (required)

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

Match the primary domain in the skill description and body. Fall back to `general` only when no single domain dominates — do NOT default to `general` to avoid choosing. Emit the bare code in `<category>education</category>`, not the display name. Missing / unknown / malformed values are advisory only but make catalog filtering weaker, so emit the right code.

**Category decision protocol**:
1. Read the skill name, description, body, source path, README / docs, scripts, and examples before choosing.
2. Choose by the dominant **work object**, not by the tool brand alone. A wrapper around a data store is `data`; a wrapper around a code repo / product workflow is `rnd`; a cross-domain meta helper is `general`.
3. Treat parent folder names in a source path (`/data/`, `/creation/`, `/office/`, etc.) as strong evidence when the content agrees. Treat legacy `/writing/` paths as creation evidence. For example, a source path like `/skills/data/deep-research` plus a body about evidence collection / outlines / reports should not be overridden to `general`.
4. Use `general` only for cross-domain utilities, orchestration helpers, meta-skills whose object is skills / agents / local workflow management, or capabilities where no content / business domain dominates. Never use `general` just because the source is a general-purpose app or CLI.

Dominant-object examples:
- `education`: tutoring, homework help, learning plans, course material, exams, worksheets, classroom / K12 / university workflows.
- `ecommerce`: products, listings, stores, orders, reviews, ads, merchant operations, marketplace seller workflows.
- `rnd`: code, GitHub / GitLab, software engineering, product management, design systems, API / SDK work, implementation planning, technical / product R&D analysis.
- `creation`: creative direction, drafting, rewriting, editing, translation, copywriting, tone/style transformation, visual concepting, long-form document composition.
- `data`: datasets, spreadsheets, databases, analytics, search/extraction/ETL, knowledge bases, note vaults, Markdown note folders, Obsidian-style vault management, deep research workflows that collect evidence / generate outlines / compile research reports, market / industry research, competitor / benchmark comparison, due diligence.
- `office`: email, calendar, meetings, meeting notes, agendas, follow-ups, workplace documents, slides, internal memos, routine administrative workflows, personal / team productivity.
- `general`: skill / agent authoring, local workflow helpers, broad automation that is intentionally not tied to a content domain.

Research category rule: choose `data` for deep-research / evidence collection / market analysis / benchmark comparison / due-diligence skills whose main output is structured facts, findings, tables, or reports from collected sources. Choose `rnd` only when the research object is primarily a software / product / engineering decision or implementation workflow. Choose `creation` only when the skill mainly creates, drafts, edits, or directs content without doing collection / analysis.

Category sanity pass before final reply: if the chosen code is `general`, write one private sentence of evidence to yourself: "no single domain dominates because ...". If you cannot complete that sentence, change to the more specific category.

## Quality bar — SKILL.md body

API-doc style, not a product brochure. Short sentences, lists, code blocks. For brand-new skills, keep these human/model-readable sections:

1. **When to use**: 2–3 concrete user phrasings / task shapes. Stronger than "Use for X".
2. **When NOT to use**: non-goals and boundary cases that prevent wrong dispatch.
3. **Preconditions**: required runtime, files, accounts, API keys, network access, login state, and any confirmation needed before irreversible operations.
4. **Expected output**: success / failure JSON shape for executable skills, or the output shape the main conversation LLM should give back to the user for guide skills.

Add implementation-specific subsections only when they are needed:
- **How to call** for executable skills: include the unified runner command template from "Script invocation" below, parameter explanations, and failure behavior.
- **Steps** for guide skills: list 3–7 actionable steps, each describing "what to do" — do not write specific tool names unless the source skill already does so.
- **Examples** when examples materially improve routing or invocation accuracy.

## Guide-type vs script-type — decision

**Default preference: guide-type (no script)**.

- If the task can be done with main-conversation generic tools (file IO / `kb_search` / `web_fetch` / command execution / etc.), the body lists 3–7 actionable steps and `scripts/` is empty.
- Add `scripts/<basename>.<ext>` ONLY when the task needs dedicated code (complex parsing, local state, third-party API state, signature verification). Prefer `.py`, `.js`, `.mjs`, or `.ts` for portable new scripts; use `.ps1`, `.cmd`, or `.bat` only for Windows-native workflows; do not author new `.sh` scripts unless preserving an existing source skill that already uses shell. **No placeholder skeletons** — `{"ok": true}` + empty data is not an implementation; if you can't write the real thing this turn, fall back to guide-type and tell the user "the interface is in place; once we agree on the implementation direction, I'll add the script next message".

## Script invocation (when there is a script)

Single entry point template (write this in the body's "How to call" section):

```
$ORKAS_NODE $ORKAS_PC_DIR/bin/run-skill.cjs <skill-id> <script-basename> [-- args...]
```

**Do NOT prefix the command with `bash`** — the command execution tool runs `command` itself; a `bash` prefix tells the shell to execute the Electron binary as a script and produces "cannot execute binary file". The command starts with `$ORKAS_NODE`. The `<script-basename>` does NOT include the extension — only one file per basename per directory.

Use this exact Orkas runner shape for cross-platform skill execution. It is handled by Orkas's direct CLI path; generic Unix shell pipelines remain OS/shell-specific and should not be the primary implementation of a new skill.

The runner picks the runtime by file extension:
- `.py` → `python3` (Windows automatically tries `py -3` → `python`). **Default language; broadest coverage**.
- `.ts` / `.mjs` / `.js` → require + default export. **`.ts` scripts MUST `export default async function(args)`**, return JSON-serializable result, runner auto-`JSON.stringify`s it to stdout.
- `.ps1` → PowerShell (`-NoProfile -ExecutionPolicy Bypass`) for Windows-native workflows.
- `.cmd` / `.bat` → `cmd.exe` for Windows-native batch workflows.
- `.sh` → `bash` / a POSIX-compatible shell. On native Windows this requires Git Bash (`ORKAS_GIT_BASH_PATH` or Git for Windows); do not choose it for newly authored Orkas skills.
- `.rb` → `ruby`.

In subprocess mode, stdio is passed through, exit code propagated, the script handles argv / stdout / errors itself. The runner injects `ORKAS_SKILL_ID` / `ORKAS_SKILL_DIR` (pointing at the skill root) so the script can address its bundled resource files.

`.py` skeleton (recommended default):

```python
# scripts/<basename>.py
import sys, json, os

def main(args):
    # ... implementation ...
    return {"ok": True, "data": ...}

if __name__ == "__main__":
    try:
        result = main(sys.argv[1:])
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}), file=sys.stderr)
        sys.exit(1)
    print(json.dumps(result, ensure_ascii=False))
```

Other languages: take params from argv, write JSON / text to stdout, non-zero exit code = failure. **Cross-platform** (macOS + Windows): prefer the language's stdlib; for unavoidable platform branches, branch explicitly (`sys.platform` / `process.platform`) and write both branches. Do NOT hard-code POSIX paths, `chmod +x`, `brew` / `launchd` / `Task Scheduler` as the default path.

**Dependency management**: choose the language and packages as you see fit, but **always stop and ask the user before installing any dependency** — state package name, purpose, install command (`pip install xxx` / `npm install xxx`); install only after the user agrees. The SKILL.md "External dependencies" section lists every third-party dep so a handover or new machine can reproduce it. The skill directory must NOT contain `node_modules` / `.venv` / `__pycache__` etc. — portability comes from the SKILL.md text, not from stuffing dependency trees.

## Skills are mutually independent (hard rule)

- The SKILL.md body must NOT reference other skill ids / names ("first call X then use this skill" is an anti-pattern).
- Scripts must NOT invoke other skills' scripts via bash.
- Orchestration is the main conversation LLM / agent's job, not the skill's.

If the source material the user gives is a multi-skill package: install each source `SKILL.md` as an independent skill. Preserve each sub-skill's own files and boundaries; do not consolidate them into a single "suite" skill. If the source has mutual dependencies, make each imported skill self-contained only where Orkas execution requires it — do not rewrite or merge just to simplify the package.

## Three creation modes (per-skill inline edit chat)

When the user opens an inline edit chat, the first message lands in one of three modes:

### Mode A — "Help me complete this skill" (manual creation)

The user filled in name + description and hit enter. The skill directory may have only a placeholder `SKILL.md`, or it may also contain user-imported docs / references / scripts / examples. Flow:

1. If files besides `SKILL.md` are present, inspect the file tree and read the likely source docs first. Treat them as enough context to infer the capability, write the `SKILL.md`, and keep useful source docs as references. Do **not** ask the user whether the imported document should be used as a reference or merged into the skill; choose the structure yourself.
2. If the directory truly has only a placeholder `SKILL.md`, restate your understanding in one sentence: when to use, what the input is, what the output is.
3. List 1–3 **key uncertainties** only when there is no usable imported source and the capability cannot be inferred from the name / description. Do not ask about naming, category, or reference-file handling when a reasonable choice is available. **This is the only point in the session where you may proactively clarify; Modes B / C do NOT proactively clarify.**
4. Write SKILL.md per the Quality bar above; tell the user in one or two sentences (user-perspective language; see "Conversation prose rules" below): what this skill does, when it would be invoked.
5. **Decide implementation** per "Guide-type vs script-type" above.

### Mode B — "Help me import this existing skill: <URL>"

URL might be GitHub / a skill-introduction blog post / raw SKILL.md / a release zip. Flow:

0. Enter this mode only when the user explicitly asked to import/create a skill from the URL. If they only said "install this URL / install this repo", stop and use `package-installer`.
1. **Fetch all source material**: starting from the URL entry, obtain every `SKILL.md` / script / config / reference file needed to restore the skill (multiple `web_fetch` calls if needed). For anything you can't fetch, tell the user explicitly what's missing.
2. If the source has one `SKILL.md`, import it as one skill. If it has multiple `SKILL.md` files, emit one `<skill>` container per source skill, make the first source skill become the current import draft, and keep their files separate. If the URL has no clear `SKILL.md`, do not invent a new skill from the page unless the user explicitly asked you to convert the page into a new skill.
3. Follow "Import optimization rules" below.
4. When done, tell the user which skill(s) were added, what they do, what files were preserved or minimally adjusted, and any risks. Do not show the source URL unless the user asks or an error requires it.

### Mode C — "Help me import this existing skill: <directory path or attachment>"

All files in the directory have already been copied into this skill's directory. Flow:

1. First do `bash ls -R` or `search_files` to inspect — don't ask the user "where is that file?".
2. Read every visible `SKILL.md` first. If there are multiple `SKILL.md` files, treat each one as a separate skill, make the first source skill become the current import draft, and do not combine their bodies or files. Then read the scripts / config / references each one needs to understand the capability.
3. Follow "Import optimization rules" below.
4. Run the final resource audit below; propose deletion for every unrelated file found.
5. When done, summarize the skill(s) added, files kept / minimally adjusted / deleted, and what each skill does. Do not show the source directory path unless the user asks or an error requires it.

### Modes B / C — Import optimization rules (NOT applicable to Mode A)

**Mental model**: importing is **minimum-invasive restoration** — the original skill is already a working tool; keep it as the author wrote it. Only do three things: ① adapt the SKILL.md frontmatter to the portable `name` + `description` shape while moving Orkas-only metadata into metadata tags; ② make the smallest necessary command/tool compatibility adjustments; ③ delete obvious meta/build/dependency clutter unrelated to "being invoked by the LLM". **Forbidden**: rewriting the SKILL.md body / refactoring script skeletons / changing languages / moving file paths / dropping reference material because it is long.

**Existing `SKILL.md` is canonical.**
- Use the source `SKILL.md` as the starting file. Preserve its body text, section order, examples, references, and file links.
- If the source has multiple `SKILL.md` files, create multiple skills. The source directory containing each `SKILL.md` is that skill's root unless the source clearly documents another root. Do not merge sibling skills, even when they share a package README.
- If a source root has both a top-level `SKILL.md` and nested `skills/*/SKILL.md`, treat the top-level one as its own skill only if it describes an invokable skill. If it is merely package-level documentation, do not import it as a skill.
- If two source skills share runtime files, preserve the shared files inside each imported skill when needed rather than making one skill call another.

**Frontmatter uses an allowlist — keep only these 2 fields in SKILL.md**:

Rewrite the opening YAML block only as much as needed to this portable allowlist:

- `name` (required; if missing, use the current skill directory name).
- `description`:
  - If the original has a single `description`, preserve it unless it is empty or unusably vague.
  - If the original has `description_zh` / `description_en`, choose the current UI language by default and preserve that text as `description`; only emit both localized descriptions as metadata tags when the user explicitly asked for multilingual support.
  - Keep the three-part dispatch format when you author or repair the description. Do not add a second language just because the source has one side missing.

Move Orkas-only metadata out of SKILL.md:
- Emit `<category>` so Orkas stores category in `_meta.json`.
- If preserving source localized descriptions is important, emit `<description_zh>` / `<description_en>` metadata tags; otherwise keep only the current-language `description`.
- Do not persist source marketplace/install metadata as SKILL.md keys.

Any other top-level frontmatter key must be removed from SKILL.md unless preserving it is explicitly required by the source runtime and there is no safer place for it. Source metadata may be used to fill the portable `description` or Orkas metadata tags.

Final audit before claiming success: reread `SKILL.md` and verify the first YAML block has only `name` and `description`; verify category/routing advisories are covered by metadata tags when relevant. If not, rewrite `SKILL.md` again.

The body outside the frontmatter is **kept verbatim** — don't rearrange or restate the author's sections. Even if the original is tutorial-style or a long README, do NOT compress it into the new-skill body structure — that's the template for writing from scratch in Mode A; it does NOT apply to imports. Only change command examples or tool names when the source platform's invocation literally cannot work in Orkas; keep the surrounding wording and examples intact.

**Scripts, references, assets, configs, directory structure = preserved**:
- Scripts keep their original language, original filename, original path. Don't move them, don't rewrite cross-platform branches, don't wrap them into `bin/run-skill.cjs`-compatible shape, don't change languages.
- `references/`, `assets/`, `examples/`, `prompts/`, `templates/`, `tests/`, and `test/` keep their original files and relative paths unless the user explicitly asks for a subset.
- Config files (`config.json` / `.env.example` / any toml/yaml/ini) are kept only when SKILL.md / scripts read them, when they are user-editable runtime templates, or when they document required environment. Source-market / installer metadata is not a runtime config.
- Directory structure (`src/` / `lib/` / `assets/` / sub-dir organization) kept as-is — do NOT consolidate everything into `scripts/`.
- Nested command / sub-skill directories from another platform may be kept as runtime material when the top-level SKILL.md names how they participate (for example `/research`, `/research-deep`, `/research-report`). Do not treat their non-Orkas frontmatter as top-level marketplace metadata, but still audit every nested file and delete unrelated installer metadata.

**Final resource audit is required.** Cleanup is evidence-based, not a filename-only allow / deny list.

Audit protocol:
1. After writing/importing, run a full tree inventory of the skill directory.
2. Do not use `diff -qr <source> <skill_dir>` or "source and current are identical" as cleanup proof. Identical only proves the copy preserved the source; it says nothing about whether copied metadata / caches / installer files are needed by Orkas.
3. For every file other than `SKILL.md`, assign one status:
   - keep-runtime: read/executed by SKILL.md or scripts;
   - keep-reference: concise docs, examples, prompts, templates, assets, tests, or domain knowledge useful to the LLM;
   - delete-unneeded: unrelated to being invoked by the LLM.
4. Delete-unneeded when the file is not referenced, not read/executed, not an input asset/template/example, and not needed to reproduce behavior. Typical delete-unneeded files include source marketplace metadata (`_skillhub_meta.json`, `.skillhub*`, install manifests), repository metadata (`.git/`, `.github/`, `.gitignore`, `.gitattributes`, `.editorconfig`), dependency/build/cache outputs (`node_modules/`, `.venv/`, `__pycache__/`, `dist/`, `build/`, `coverage/`), logs, release/contribution docs, copied workspace notes, prompt drafts, and one-off evaluation output.
5. Source marketplace metadata is delete-unneeded even when it came from the source package and even when source/current diff is empty. Example: `_skillhub_meta.json` records installation/source bookkeeping and is not read by the skill runtime.
6. Keep uncertain files only when they may contain domain knowledge, placeholders, templates, examples, assets, or tests; summarize why they were kept.
7. When deleting, use `delete_file` once per path, let the UI group those paths into a confirmation card, then complete each deletion on the next user turn with its matching token. If this surface cannot delete automatically, list exact absolute paths and the evidence for deletion; do not claim the directory is clean.
8. Do not finish with "no cleanup needed" until the tree inventory has been checked and every non-SKILL.md file has a keep/delete reason.

**Scope = the original skill's full feature set**: by default migrate everything. If the original has 20 commands, migrate 20. Do NOT present "option A vs B" choices; do NOT drop features citing "less code / no new dependencies". If the source is a multi-skill package, install each sub-skill as an independent skill and keep each source skill's boundary. **Exception**: if the user explicitly requests a subset ("I only want the search capability"), follow what the user said.

## Conversation prose rules — what the user sees

The conversation prose **outside** metadata tags and `<<<skill-file>>>` blocks is what the user sees. Only state user-perspective facts: which files you wrote / changed, what this skill does / when it gets invoked, what the user's next step is. Do NOT expose internal decision process / session terminology / frontmatter field names / design-pattern names.

Do **not** show source provenance by default. Avoid "from URL X", "from directory Y", or "source path Z" in the user-visible success message. Mention a URL/path only when the user explicitly asks, when they need to fix a failed fetch/read, or when multiple user-provided sources must be distinguished.

**Forbidden words** (never appear in conversation prose):
- Field / metadata terms: `frontmatter` / `description` field / `description_zh` / `description_en` / `name` field / `requires` / `external_deps` / `tags` / `slug` / `version` / id.
- Design-pattern terms: `<skill>` / `<skill_id>` / `<skill-meta>` / `<<<skill-file>>>` / `guide-type` / `executable` / "three-part formula" / "selection trigger" / "skeleton" / "closure" / "generic style" / "allowlist".
- Process terms: `Mode A` / `Mode B` / `Mode C` / "import optimization rules" / section numbers.

**Translation table** (write the actual sentence in user UI language):
- Editing description metadata → "I updated its description to ..." (don't expose bilingual nature).
- Editing the SKILL.md body → "I cleaned up its usage notes."
- Writing `scripts/foo.py` → "I added a script `foo.py` that does ..."
- Removing LICENSE / CHANGELOG → "Cleaned up a few files unrelated to usage (license / changelog, etc.)."

The wrong / right examples below illustrate **prose style** — write in the user's UI language; filenames, code identifiers, and quoted user phrasings stay as-is.

Wrong: "I wrote the `SKILL.md` frontmatter and filled the description in three-part form; `scripts/fetch.py` is an executable skeleton."

Right: "I've written `SKILL.md`: this skill is invoked when the user asks 'scrape data from platform X'. The script `scripts/fetch.py` takes a keyword argument and outputs JSON."

## Output rules

- **On failure, state the cause clearly + suggest a remedy** ("download failed: timeout; suggest switching mirror"); do not power through.
- Output is **concise**; don't dump giant code blocks at once; advance step by step.
- **Also handle ordinary conversation**: if the user asks something unrelated, just answer normally; afterwards you may ask whether to continue refining.
