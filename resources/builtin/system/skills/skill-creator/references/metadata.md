# Skill metadata and routing

Read this file before changing Skill identity, description, category, routing hints, or SKILL.md frontmatter.

## Portable frontmatter

SKILL.md frontmatter has exactly two portable fields, both required: `name` and `description`. Do not put `description_zh`, `description_en`, `category`, `requires`, `external_deps`, `tags`, or `version` in SKILL.md. Orkas-only metadata is emitted through metadata tags and stored in `_meta.json`; external dependencies belong in the body.

### `name`

- The Skill identifier and directory name.
- Use a short English slug containing only ASCII letters, digits, `_`, and `-`. Single internal spaces remain accepted for compatibility, but prefer a hyphenated slug.
- Do not translate the identifier. Do not use Chinese, pinyin substitutions, `.`, `/`, full-width punctuation, or emoji.

### `description`

The current-language description is the routing index that decides whether the model reads SKILL.md. Write normally one or two sentences containing:

1. **Core capability and delivery** — verb + typical objects + typical actions/output.
2. **Typical user intent** — natural task vocabulary and useful synonyms, without quoting sample requests or adding a separate keyword list.
3. **Necessary boundary** — only when it distinguishes a likely adjacent capability or ordinary task execution.

Do not include execution steps, tool names, implementation details, marketing claims, or exhaustive format lists unless they materially affect selection. Put essential routing signal first.

When authoring or repairing a description, use the same compact routing index as SKILL.md frontmatter; aim for 100–300 characters without padding and keep it at or below 512 characters. A shorter complete description is better than filler. Runtime will preserve the complete description up to that boundary and mark an omitted tail with `…`; do not depend on truncation. Preserve faithful imported descriptions unless the user asks for a rewrite.

Use `<description>` for the current UI language. Emit `<description_zh>` and `<description_en>` only when the user explicitly asks for multilingual/bilingual descriptions; write each independently with equivalent routing signal.

## Routing metadata tags

Metadata-only edits do not rewrite SKILL.md. Allowed tags:

- `<name>`
- `<description>` / explicit localized descriptions
- `<category>`
- `<negative_examples>` as newline bullets
- `<applicable_domain>`
- `<prerequisites>` as newline bullets

In a bound editor, wrap them in `<skill-meta>`. In Commander, place them inside `<skill>` and include `<skill_id>` for an edit. If metadata and file content change together, metadata tags win for those fields.

## Category

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

Match the primary domain by the dominant work object after reading the name, description, body, source path, documentation, scripts, and examples. A data-store/research/reporting capability is normally `data`; code/product/engineering is `rnd`; drafting/editing/creative direction is `creation`; meetings, slides, and workplace documents are `office`. Matching source folders are strong evidence. Use `general` only for truly cross-domain or meta capabilities.

Category sanity pass before final reply: if the chosen code is `general`, privately complete “no single domain dominates because …”. If that is not defensible, use the more specific category.

## Final metadata audit

- SKILL.md begins with one YAML block containing only `name` and `description`.
- The description contains capability, intent vocabulary, and only a necessary boundary.
- New/repaired descriptions are concise and never rely on runtime truncation.
- Orkas category/routing hints are tags, not frontmatter keys.
- Imported descriptions remain faithful unless the user requested a rewrite.
