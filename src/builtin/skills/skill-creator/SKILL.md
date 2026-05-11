---
name: skill-creator
description_zh: "用 `<skill>` 容器 + `<<<skill-file>>>` 块创建或编辑一个自定义 skill —— frontmatter 三字段、name 字符集、guide-type vs script-type 决策、相似度自查、编辑前置 read 协议。适合\"做一个 skill 处理 X\"\"把 X 这个 skill 改一下\"\"装一下这个 URL 的 skill\"；触发词：创建 skill、做一个 skill、写个技能、修改技能、装 skill、import skill"
description_en: "Author or edit a custom skill via `<skill>` container + `<<<skill-file>>>` blocks — frontmatter 3-field rule, name charset, guide-type vs script-type decision, similarity check, and the read-before-write edit protocol. For: 'make a skill that does X', 'tweak the X skill', 'install this skill from URL'. Triggers: create skill, make a skill, write a skill, edit skill, install skill, import skill."
---

# skill-creator

Authoring rules for creating or editing a custom skill via the `<skill>...</skill>` container with `<<<skill-file>>>` blocks. Used by group-chat commander and per-skill inline edit chats. The container is parsed post-stream by `bus.ts` (commander surface) or `features/skills.ts` (per-skill chat); the LLM does not call any tool — it embeds the container in its final reply text and ends the turn.

## When to consult this skill

`read_file <ROOT>/skill-creator/SKILL.md` whenever you're about to:

- Create a new skill (user says "做一个 skill / make me a skill that does X / 把这个能力封装成 skill").
- Edit an existing skill (user says "改一下 X skill / X 的 SKILL.md 写得不清楚 / 给 X skill 加一个脚本").
- Install / import a skill from a URL or directory.

You **must** consult before emitting any `<skill>` container. The `<<<skill-file>>>` block is whole-file replacement — guessing the format from training priors will silently overwrite the user's existing content.

## Mental model

A skill is **an independent tool capability**, not a tutorial. When the LLM sees a matching user request, it picks the skill, invokes it once or a few times per the SKILL.md interface, takes the result, and folds it into its answer. Anchors:

- **Single responsibility**: one skill does one clear thing. "Analyze + write report + send email" is three things — split into three skills.
- **Self-contained / no inter-dependencies**: each skill stands alone — no references to / calls into other skills. External dependencies (runtime, CLIs, API keys) are stated plainly in the SKILL.md body.
- **SKILL.md is the interface description for the LLM**, not user documentation. Capability language describing "what to do".
- **Prefer guide-type, scripts as fallback**: if generic tools (file IO / `kb_search` / `web_fetch` / `bash` / etc.) suffice, don't write a script.

## Hard rules (non-negotiable)

- **Mutation only via `<<<skill-file>>>` blocks inside the `<skill>` container.** Do NOT use `edit_file` / `write_file` / `bash` (with redirects) to mutate any file under the skill directory. Read for inspection is allowed; every write goes through the block — bypassing skips skill rename / registry invalidation / progress events, and the filename will not match runtime expectations. The sandbox physically blocks direct writes; the rule here keeps you from wasting tool calls probing it.
- **Do NOT dump the container or any inner block as a workspace file.** The server parses them inline and persists to `<skill_dir>/<path>`.
- **Cross-skill writes are no longer supported.** Inside an inline edit chat, only the current skill's directory is writable. Do not try `<<<skill-file skill=...>>>` (deprecated).
- **One `<skill>` container per skill being created/edited this turn.** Several only when the user's request spans distinct skills. End the turn after — do NOT call `dispatch_to`.
- **Output language follows the user's UI language** — every human-readable part of the SKILL.md you author (section titles, body prose, example labels, `## When to use` / `## How to call` / etc. — write them in the user's UI language, e.g. `## 何时使用` / `## 如何调用` for Chinese UI) plus the conversation prose around the `<skill>` container all go in the user's current UI language (per the "User language" directive in the system prompt; that directive's coverage applies even though this file reaches you as a `read_file` result). `description_zh` / `description_en` frontmatter fields are pinned by suffix. Code blocks, file paths, frontmatter field names (`name` / `description_zh` / `description_en`), `<<<skill-file>>>` syntax, and skill_id strings stay as-is. The English used in this file (including the section names listed in "Quality bar — SKILL.md body" below) is illustrative shape, not literal text to copy.

## Quality bar — designing the skill

Apply these design moves while authoring; they apply on top of the dedicated `Quality bar — frontmatter` and `Quality bar — SKILL.md body` sections below. Each clause is a thing to actively put into the skill — the wording is prescriptive, not just disqualifying.

1. **Hold the single-task boundary; split rather than expand.** Already a hard rule (Mental model + "Skills are mutually independent"). At design time: a skill that bundles "analyze + report + email" splits into three. Empirical finding from skill benchmarks: 2–3 focused skills outperform a single-everything skill — when in doubt, split.
2. **State the boundary AND the non-goals.** `description_*` already carries what the skill does (existing rules); also state what the skill explicitly does NOT do where the boundary is fuzzy (e.g. "fetches X but does NOT cache or rate-limit; caller handles those") so the dispatch LLM doesn't pick the skill for the wrong job.
3. **Write the body as actionable steps, not narrative.** Body's "How to call" lists steps the LLM can execute (existing rule). If a draft section reads as documentation prose ("this skill helps with X by considering Y"), rewrite it into the steps the LLM actually runs. Bodies that read like marketing copy instead of an interface are the dominant authoring failure.
4. **Stabilize the return schema for executable skills.** Body's "Return format" gives the same key set on success and failure, with `ok` as the discriminator. Stability lets the caller pattern-match without runtime sniffing — and makes the skill verifier-friendly.
5. **Require a confirm step before irreversible operations.** For skill operations that delete / overwrite / mutate external state (DB / API write / public post), the body's "How to call" instructs the caller to confirm before execution.
6. **Refuse to author scripts across security gates.** Do NOT put any of the following into a skill script — if the source material requires them, stop and explain the request crosses a security gate: ① `curl` / `wget` to unknown URLs or raw IPs; ② reading `~/.ssh` / `~/.aws` / `~/.config` or browser cookies without explicit user grant + reason; ③ touching `MEMORY.md` / `USER.md` / `SOUL.md` / `IDENTITY.md` / `CLAUDE.md`; ④ `eval` / `exec` on external input or any `base64` decode-then-execute; ⑤ modifying system files outside workspace, installing packages without listing them, or requesting sudo.

## Create vs edit decision

- **No `<skill_id>` sub-tag** → create a brand-new skill. The new skill's id comes from the SKILL.md frontmatter `name` field; you choose it.
- **With `<skill_id>X</skill_id>`** → patch an existing custom skill X. `X` MUST come from the `## Available skills` block; do NOT invent.

## Pre-create similarity check (new skills only)

Before emitting `<skill>` for a NEW skill, scan the `## Available skills` block for an entry whose **name** OR **description's typical objects + actions** overlap with what you're about to create.

- **Overlap found** → STOP, do NOT emit `<skill>`. In one prose paragraph (user UI language) name the existing skill, state the overlap, and ask whether to use the existing one or still create a new one. Emit `<skill>` only after the user picks "create new".
- **No overlap** → emit `<skill>` in the same turn. Do NOT pre-announce ("let me confirm… I'll create one for you") — the prose accompanying the container IS the announcement.

## Editing protocol — required loop

1. **Read the current SKILL.md** via `read_file(<ROOT>/<id>/SKILL.md)` — the path pattern is in the `## Available skills` block header. Never rewrite from memory — `<<<skill-file>>>` is whole-file replacement; emitting a partial SKILL.md wipes the rest of the body.
2. **If `Source: builtin`** → reply with one prose line (user UI language) saying built-in skills can't be edited from this surface; the user can fork a custom copy from the detail panel. Then stop. **Do not emit `<skill>`**.
3. **Emit `<skill>` with `<skill_id>` first**, then only the `<<<skill-file>>>` blocks you're changing. SKILL.md edits may change `name`; the system auto-renames the directory to match.

## `<<<skill-file>>>` block format

Each file under the skill directory is written via:

```
<<<skill-file path=<rel-path>
…full file content…
>>>
```

- `path=` is **relative to the skill directory** (e.g. `SKILL.md` / `scripts/fetch.py`); `..` and absolute paths are rejected.
- Each block is a **whole-file replacement** of `path`; partial edits → read the file first, then write the full new version.
- A single `<skill>` container may contain multiple blocks (SKILL.md + scripts + examples). Failures within one block do not roll back earlier successful writes; rejected paths surface as an error pill.

## Container shape

```
<skill>
<skill_id>(omit when creating; required when editing)</skill_id>
<<<skill-file path=SKILL.md
---
name: short-ascii-id
description_zh: ① 一句功能 ;② 适合"用户原话1""用户原话2";③ 触发词:词1、词2、…
description_en: ① one-line function ; ② For: "user phrasing 1", "user phrasing 2" ; ③ Triggers: word1, word2, …
---

# Body sections per the Quality bar below
>>>
<<<skill-file path=scripts/<basename>.py
…optional implementation script…
>>>
</skill>
```

## Quality bar — frontmatter

**Frontmatter has exactly three fields, all required**: `name` + `description_zh` + `description_en`. **No** `requires` / `external_deps` / `tags` / `version` / single-language `description`. External dependencies go in the body's "External dependencies" section as plain text.

### `name`

- The skill id AND the directory name.
- **Strict ASCII charset**: letters / digits / `_` / `-`. Single internal spaces between word groups allowed. **No** Chinese / pinyin / `.` / `/` / full-width punctuation / emoji.
- Pick a short descriptive English slug (e.g. `social-fetch`, `code-reviewer`).
- The validator rejects any other charset and the create fails with `E_SKILL_NAME_INVALID`.
- **`name` is NOT translated to the user's UI language** — it's an identifier, not display copy. (The `description_*` fields carry the user-facing display text.)

### `description_zh` + `description_en` — the dispatch signal

This is the **only** signal that decides whether the LLM picks the skill at runtime — at runtime the version matching the user's current UI language is injected into the main conversation's system prompt.

- **Both required**, written **independently** in the **three-part formula** (don't direct-translate; appeal to the real phrasings of users in each language):
  1. **One-line function** = verb + object + delivery, naming the **typical objects** and **typical actions**. Avoid empty boilerplate.
  2. **`适合` / `For:`** + 2–3 quoted **real user phrasings**.
  3. **`触发词：` / `Triggers:`** + 5–8 keywords (separated by `、` / `,`).
- Writing only one = blank for users in the other UI language; the skill will never be invoked there.

Example (Chinese): `抓取小红书 / Reddit / X / Bilibili / YouTube 上指定关键词的帖子并做情绪/趋势分析；适合"分析一下小红书最近的 X 话题""找几条 Reddit 上关于 Y 的高赞帖"；触发词：抓一下、找一下、分析一下、舆情、热度`

Example (English): `Fetch posts matching given keywords on Xiaohongshu / Reddit / X / Bilibili / YouTube and produce sentiment/trend analysis; For: 'analyze the latest X discussion on Xiaohongshu', 'check Reddit sentiment for product Y'; Triggers: fetch, find, analyze, sentiment, buzz`

## Quality bar — SKILL.md body

API-doc style, not a product brochure. Short sentences, lists, code blocks. Six sections:

1. **When to use**: 2–3 concrete user phrasings / task shapes. Stronger than "Use for X".
2. **How to call** — two flavors:
   - **Executable** (has `scripts/*`): the unified bash command template (see "Script invocation" below), parameter explanations, prerequisites.
   - **Guide** (only SKILL.md, no scripts): list 3–7 **actionable steps**, each describing "what to do" (e.g. "fetch the page body", "find related news from the last 7 days", "write the result to a file in the workspace") — **do not write specific tool names** — the main conversation LLM picks paths using whatever tools it has loaded.
3. **Return format**: success / failure JSON shape (executable); or output shape the main conversation LLM should give back to the user (guide).
4. **External dependencies**: runtime (Python 3 / Node), CLIs, network services, API keys, login state. One per line: dep name + what fails when missing + how to obtain. **Do not use frontmatter fields**; this is a body section.
5. **Limits / known issues**: timeouts, platform differences, login-state dependencies.
6. **Full examples**: one or two of the most typical "input → invocation → output" snippets.

## Guide-type vs script-type — decision

**Default preference: guide-type (no script)**.

- If the task can be done with main-conversation generic tools (file IO / `kb_search` / `web_fetch` / `bash` / etc.), the body lists 3–7 actionable steps and `scripts/` is empty.
- Add `scripts/<basename>.<ext>` ONLY when the task needs dedicated code (complex parsing, local state, third-party API state, signature verification). **No placeholder skeletons** — `{"ok": true}` + empty data is not an implementation; if you can't write the real thing this turn, fall back to guide-type and tell the user "the interface is in place; once we agree on the implementation direction, I'll add the script next message".

## Script invocation (when there is a script)

Single entry point template (write this in the body's "How to call" section):

```
$ORKAS_NODE $ORKAS_PC_DIR/bin/run-skill.cjs <skill-id> <script-basename> [-- args...]
```

**Do NOT prefix with `bash`** — the bash tool runs `command` itself as a shell command; a `bash` prefix tells the shell to execute the Electron binary as a script and produces "cannot execute binary file". The command starts with `$ORKAS_NODE`. The `<script-basename>` does NOT include the extension — only one file per basename per directory.

The runner picks the runtime by file extension:
- `.py` → `python3` (Windows automatically tries `py -3` → `python`). **Default language; broadest coverage**.
- `.ts` / `.mjs` / `.js` → require + default export. **`.ts` scripts MUST `export default async function(args)`**, return JSON-serializable result, runner auto-`JSON.stringify`s it to stdout.
- `.sh` → `bash`.
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

If the source material the user gives is a multi-skill package with mutual dependencies: install each sub-skill as an independent skill, **make it self-contained** — implement what it needs itself, do not retain references to other skills.

## Three creation modes (per-skill inline edit chat)

When the user opens an inline edit chat, the first message lands in one of three modes:

### Mode A — "Help me complete this skill" (manual creation)

The user filled in name + description, hit enter; the skill directory has only a placeholder `SKILL.md`. Flow:

1. Restate your understanding in one sentence: when to use, what the input is, what the output is.
2. List 1–3 **key uncertainties** for the user to clarify in one go (don't ask one at a time); skip if info is enough. **This is the only point in the session where you may proactively clarify; Modes B / C do NOT proactively clarify.**
3. Write SKILL.md per the Quality bar above; tell the user in one or two sentences (user-perspective language; see "Conversation prose rules" below): what this skill does, when it would be invoked.
4. **Decide implementation** per "Guide-type vs script-type" above.

### Mode B — "Help me install this skill: <URL>"

URL might be GitHub / a skill-introduction blog post / raw SKILL.md / a release zip. Flow:

1. **Fetch all source material**: starting from the URL entry, obtain every SKILL.md / script / config (multiple `web_fetch` calls if needed). For anything you can't fetch, tell the user explicitly what's missing.
2. Follow "Import optimization rules" below.
3. When done, tell the user: URL source, the capability you identified, what you rewrote, any risks.

### Mode C — "Help me install this skill: <directory path>"

All files in the directory have already been copied into this skill's directory. Flow:

1. First do `bash ls -R` or `search_files` to inspect — don't ask the user "where is that file?".
2. Read the main files (SKILL.md, scripts, config) to understand the capability.
3. Follow "Import optimization rules" below.
4. When done, summarize: source dir, files kept / rewrote / deleted, what SKILL.md says.

### Modes B / C — Import optimization rules (NOT applicable to Mode A)

**Mental model**: importing is **minimum-invasive installation** — the original skill is already a working tool; keep it as the author wrote it. Only do two things: ① trim extraneous fields from the SKILL.md frontmatter; ② delete obvious meta-files unrelated to "being invoked by the LLM". **Forbidden**: rewriting the SKILL.md body / refactoring script skeletons / changing languages / moving file paths.

**Frontmatter uses an allowlist — keep only these 3 fields, delete everything else**:
- `name` (required; if missing, use the current skill directory name).
- `description_zh` + `description_en`:
  - If the original is single-language `description`, identify its language, fill the matching field, **add the other one in the three-part formula** (a direct translation is acceptable, but better to rewrite per the target-language users' real phrasings).
  - If both are present, keep each as written; if one is too short / clearly marketing prose, **only that one** may be rewritten.

The body outside the frontmatter is **kept verbatim** — don't rearrange or restate the author's "When to use / How to call / Return format / External dependencies / Examples" sections. Even if the original is tutorial-style or a long README, do NOT compress it into the 6-section structure — that's the template for writing from scratch in Mode A; it does NOT apply to imports.

**Scripts, configs, directory structure = completely untouched**:
- Scripts keep their original language, original filename, original path. Don't move them, don't rewrite cross-platform branches, don't wrap them into `bin/run-skill.cjs`-compatible shape, don't change languages.
- Config files (`config.json` / `.env.example` / any toml/yaml/ini) kept as-is.
- Directory structure (`src/` / `lib/` / `assets/` / sub-dir organization) kept as-is — do NOT consolidate everything into `scripts/`.

**Deletion list**: `LICENSE*` / `COPYING` / `CHANGELOG*` / `CONTRIBUTING*` / `CODE_OF_CONDUCT*` / `AUTHORS` / `MAINTAINERS` / `.git/` / `.github/` / `.gitignore` / `.gitattributes` / `.editorconfig` / `node_modules/` / `__pycache__/` / `.venv/` / `dist/` / `build/` / standalone `docs/` directories. **Keep** `README*` (many skills put usage notes there) and `tests/` / `test/` (may be sample data the script depends on). Files outside this list **must not be deleted**; once done, list everything you removed without asking.

**Scope = the original skill's full feature set**: by default migrate everything. If the original has 20 commands, migrate 20. Do NOT present "option A vs B" choices; do NOT drop features citing "less code / no new dependencies". If the source is a multi-skill package with internal dependencies → install each sub-skill as an independent skill (multiple Mode B passes); don't try to preserve the original's dependency graph. **Exception**: if the user explicitly requests a subset ("I only want the search capability"), follow what the user said.

## Conversation prose rules — what the user sees

The conversation prose **outside** `<<<skill-file>>>` blocks is what the user sees. Only state user-perspective facts: which files you wrote / changed, what this skill does / when it gets invoked, what the user's next step is. Do NOT expose internal decision process / session terminology / frontmatter field names / design-pattern names.

**Forbidden words** (never appear in conversation prose):
- Field / metadata terms: `frontmatter` / `description` field / `description_zh` / `description_en` / `name` field / `requires` / `external_deps` / `tags` / `slug` / `version` / id.
- Design-pattern terms: `<skill>` / `<skill_id>` / `<<<skill-file>>>` / `guide-type` / `executable` / "three-part formula" / "selection trigger" / "skeleton" / "closure" / "generic style" / "allowlist".
- Process terms: `Mode A` / `Mode B` / `Mode C` / "import optimization rules" / section numbers.

**Translation table** (write the actual sentence in user UI language):
- Editing frontmatter description_zh / description_en → "I updated its description to ..." (don't expose bilingual nature).
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
