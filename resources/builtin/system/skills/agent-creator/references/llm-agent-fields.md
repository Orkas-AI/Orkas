# LLM-managed Agent fields

Read this file for every new LLM-managed Agent and whenever one of these fields changes. CLI-backed Agents use `cli-and-prose.md` instead.

## Container contract

```text
<agent>
<operation>(required in an unbound session: create or edit; omit in a bound editor)</operation>
<agent_id>(required for unbound edit; forbidden on create; omit in a bound editor)</agent_id>
<name>valid-name</name>
<description>current-language routing description</description>
<icon>known-icon-id</icon>
<workflow>stepwise Markdown</workflow>
<knowhow>one item per line</knowhow>
<standards>one item per line</standards>
<skills>one visible Skill name per line</skills>
<tools>one Agent-dependency group id per line</tools>
<inputs>[]</inputs>
<interactive>false</interactive>
<category>data</category>
</agent>
```

Creating in an unbound session requires `<name>`, `<workflow>`, `<tools>` even when intentionally empty, and a valid `<category>`. Include `<knowhow>` and `<standards>` unless the source gives no basis. Editing is patch-style: emit only changed fields. A present list-like field is full replacement; an empty tag deliberately clears it.

Mutation controls are a closed contract:

- Unbound create: `<operation>create</operation>` with no `<agent_id>`.
- Unbound edit: `<operation>edit</operation>` with the canonical id of an existing Agent in `<agent_id>`.
- Bound edit: omit both fields; the host supplies and locks the target.
- During a host correction, preserve the rejected operation. Never turn edit into create or create into edit. If an edit target is unresolved, ask the user and emit no replacement create.

Do not emit `<profile>`, structured workflow arrays, runtime counters, seed memory, `tool_list`, or unknown fields.

## Design quality

1. Position the responsibility and a meaningful non-goal where adjacent capabilities could collide.
2. Build the workflow as an executable program: ordered actions, named tools/Skills where invoked, and explicit branches only when outcomes change the next action.
3. Preserve authority: a current user request authorizes that exact action. Distinguish an unresolved target from a scope expansion; ask only for the missing target, and pause only for a materially different action/target or a platform-required confirmation.
4. Make claimed capabilities visible in the workflow rather than decorative.
5. End with a concrete deliverable or an explicit handoff boundary.
6. Match the workflow to `<interactive>`: autonomous flows contain no mid-task user pause; conversational flows contain identifiable reply points.
7. Preserve supplied source wording and order wherever it is compatible with Orkas.

## `<name>`

- Use the user's UI language. Preserve a valid user-supplied spelling exactly.
- Allowed characters: ASCII letters/digits, `_`, `-`, and CJK U+4E00–U+9FFF. Whitespace is forbidden, including internal spaces. Punctuation, emoji, kana, Hangul, and extended CJK are invalid.
- Join invented multi-token ASCII names with `-` or `_`; preserve user-supplied `-` and `_`.

## `<icon>`

Avatar icon candidates (exact IDs): `sparkle`, `rocket`, `brain`, `bulb`, `bot`, `atom`, `compass`, `search`, `flame`, `film`, `star`, `bolt`, `target`, `music`, `code`, `palette`, `document`, `spreadsheet`, `presentation`, `image`, `chart`, `graduation-cap`, `book-open`, `calculator`, `users`, `megaphone`, `shopping-bag`, `archive`, `activity`, `git-pull-request`, `briefcase`, `clipboard`.

On create or when the current icon is missing, choose the closest candidate. Otherwise preserve it unless the user asks for a change or the role changes materially.

## `<description>`

This is the Commander's dispatch signal; workflow, inputs, and Skills are not visible at dispatch time.

- Default: one current-language description only. Use `<description_zh>` / `<description_en>` only when the user explicitly asks for multilingual/bilingual descriptions.
- Write three compact parts: (1) verb + typical objects/actions + deliverable; (2) `适合` / `For:` plus 2–3 quoted real user phrasings; (3) `触发词：` / `Triggers:` plus 5–8 natural keywords.
- Start with the action and object, not a title, category label, Agent-name restatement, or “AI assistant” boilerplate.
- Include a non-goal only when it prevents a likely routing collision.

## `<workflow>`

Use ordered steps in physical execution order:

```markdown
### N. Verb-led title
- `tool_name(key params)` — purpose and result when a tool is invoked
- reasoning or synthesis in plain prose
  - if X → call A
  - else → call B
```

- Do not add a top-level `# Workflow` heading.
- Name each invoked tool or Skill in backticks; do not attach a fake tool name to reasoning-only prose.
- Carry prior step results implicitly instead of restating context.
- Runtime recovery owns ordinary retry/skip behavior; encode only domain branches that change the workflow.
- Prefer built-in tools, then listed Skills, then a discovered global Skill whose SKILL.md was read, then discovered connector actions. Never invent capability names.
- For web access, write `web_search`; runtime provider selection is host-owned.

## `<knowhow>` and `<standards>`

- `<knowhow>` is display-only: one concise line per stable domain/capability. It is not injected into the runtime prompt, so execution behavior belongs in `<workflow>` and final checks belong in `<standards>`.
- `<standards>` is display and runtime guidance: one observable delivery or valid-stop condition per line. Treat acceptance tests, output contracts, rubric items, and definition of done as standards.
- Use at most 5 items per field. The host rejects an explicit list over 5 instead of truncating it. Keep every line concise and independently meaningful.
- Do not emit JSON here. Use plain lines. Memory belongs to the per-Agent memory store.

## `<skills>`

- One model-visible Skill name per line. List exactly the Skills invoked by or required by the workflow; the host resolves these names to Skill ids but does not infer tool permissions from Skill prose.
- Names must come from Available skills or from a `skill_search` result whose SKILL.md was read. Never use an internal id or invent a name.
- Empty is legal only when the workflow uses built-in tools/connectors alone.

## `<tools>`

- One exact Agent-dependency group id per line from the host-generated `## Agent tool dependencies` directory. In Commander the directory precedes the root `agent-creator` Skill in the same read result; in a dedicated editor it is in the system prompt.
- Each leaf entry names the exact built-in tools it activates. Match every directly invoked built-in tool. Prefer a leaf; use a parent only when several children are required.
- If the workflow uses any Connector action, include `connectors`. On create, the host also runs the generic dependency resolver over explicit workflow tool calls and exact tool names from structured user selections; it may fill only a single unambiguous Agent-dependency group. This is a safety net, not permission to omit known dependencies.
- This is the Agent's default capability boundary. A user-explicit current-turn selection activates its known group first; `tool_load` may add only Agent-declarable groups as a lower-priority current-turn fallback. Neither path rewrites this list. Host-managed and runtime-only tools do not belong here.
- On create, always emit this tag. An empty `<tools></tools>` declares no authored groups; the create-time safety resolver may still add an exact, unambiguous dependency found in the workflow or a structured user selection.

## `<inputs>`

Use a JSON array for the smallest one-shot launch form.

- Each item has `id` (`^[a-z_][a-z0-9_]{0,31}$`), current-language `label`, `type`, and `default`.
- Types: `text`, `textarea`, `select`, `multiselect`, `number`, `boolean`, `file`.
- `select` / `multiselect` require `{value,label}` options and a valid default. Optional keys are `description`, `required`, `placeholder`, numeric `min`/`max`, and file `multiple`/`accept`. Do not use `show_if`.
- Keep inputs sparse. Prefer zero inputs when natural language is enough. Otherwise use one required task / material field plus at most one optional context field; add a third only for a hard launch dependency.
- Do not expose every mode, tone, stage, or default as a field. Infer safe choices or let an interactive Agent ask later.
- `[]` explicitly means no structured inputs. A present list replaces the full list.
- File values arrive as conversation attachments and are read by filename; do not bake absolute paths into defaults.

## `<interactive>`

- `true` only when progress genuinely depends on multi-turn user replies: coaching, tutoring, interviews, role-play, companionship, or guided diagnosis.
- `false` for autonomous workers, writers, scrapers, code generation, reports, and one-shot forms.
- A one-shot input form is not interaction. When uncertain, use `false`.
- Emit only literal lowercase `true` or `false`.

## `<category>`

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

Match the primary domain by the dominant work object, using the Agent's source, description, workflow, inputs, and examples as evidence. Research/evidence/reporting is normally `data`; software/product/engineering work is `rnd`; drafting/editing/creative direction is `creation`; workplace documents/slides/meetings are `office`. Use `general` only for truly cross-domain or meta capabilities.

Category sanity pass before final reply: if the chosen code is `general`, privately complete “no single domain dominates because …”. If that sentence is not defensible, use the more specific category.
