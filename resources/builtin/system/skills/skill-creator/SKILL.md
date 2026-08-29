---
name: skill-creator
description_zh: "通过 `<skill>` 容器和文件块创建、编辑或忠实导入用户明确要求的自定义 Skill；用于新建、修改或导入 Skill，不用于普通任务执行或单纯安装外部包。"
description_en: "Author, edit, or faithfully import an explicitly requested custom Skill through `<skill>` containers and file blocks. Use when the user asks to create, revise, or import a Skill; not for ordinary task execution or plain external-package installation."
---

# skill-creator

Create, edit, or faithfully import a custom Skill through host-owned metadata tags, `<<<skill-file>>>` whole-file blocks, or the native package importer. Do not mutate the Skill directory with generic file or shell tools.

## Read only the reference needed for this request

Before authoring, read the matching reference through this Skill's read ref:

- New Skill, SKILL.md body rewrite, new reference, or bundled script → [authoring.md](references/authoring.md).
- Name, description, category, routing hints, or any SKILL.md frontmatter work → [metadata.md](references/metadata.md).
- URL, local directory, ZIP, attachment, pasted existing Skill, or any source-preserving import → [importing.md](references/importing.md) and [metadata.md](references/metadata.md).
- File deletion or imported-package cleanup → [file-deletion.md](references/file-deletion.md).

Do not read unrelated references. A category-only edit needs only `metadata.md`; a body-only guide edit normally needs only `authoring.md`; an import needs `importing.md` plus `metadata.md`.

## Routing gate

**Explicit creation intent required.** Use this Skill only when the user explicitly asks to create, edit, convert into, or import a Skill, or when already inside a bound Skill editor. Do **not** consult this skill for a plain "install this URL / install this GitHub repo / add this project" request. A runnable external package belongs to `package-installer` unless the user explicitly wants a portable custom Skill. If that outcome is genuinely ambiguous, ask one concise clarification.

## Non-negotiable protocol

- **Use host-owned mutation paths only.** Use `import_skill_package` for an explicitly supplied local Skill directory/ZIP when available, metadata tags for metadata-only changes, and `<<<skill-file>>>` for changed file content. Never use `edit_file`, `write_file`, or shell redirects under the Skill directory.
- **Whole-file replacement.** Every `<<<skill-file>>>` block replaces one complete relative file. Read an existing file before changing it; a partial body erases omitted content.
- **Protocol completeness beats prose depth.** Close every file block with `>>>` on its own line and close the outer `</skill>` before optional user-visible prose. If response space is tight, shorten the Skill body; never truncate or omit a protocol delimiter.
- **No protocol files.** Do not dump `<skill>`, `<skill-meta>`, or file blocks into the workspace. The host parses them inline.
- **One container per Skill.** Multiple containers are legal only when the request or source contains multiple distinct Skills. Never merge multiple source `SKILL.md` files into one Skill.
- **Skills are independent.** Do not name, invoke, or read another Skill from this Skill's body, references, scripts, or examples. Orchestration belongs to the caller.
- **Use the user's UI language** for newly authored human-readable instructions and user-visible prose. Keep frontmatter keys, identifiers, paths, commands, and code unchanged. Imported prose remains faithful by default.
- **The host owns completion.** A valid `<skill>` container or file block only requests a mutation. Only a successful host result proves it was applied; before that, or after a failed or omitted mutation, never say the Skill is created, updated, saved, ready, or available. If visible prose is useful, use pending wording such as “将创建” or “已提交，等待应用”.

## Decide create versus edit

- Bound Skill editor: mutate the current Skill without an outer `<skill>` wrapper for ordinary file/meta edits.
- Unbound create: omit `<skill_id>` and include a complete new `SKILL.md` plus category.
- Unbound edit: obtain `<skill_id>` from Available skills, read the current SKILL.md, and emit only changed metadata or whole files.
- Built-in Skill: explain that it cannot be edited from this surface and can be forked; emit no mutation protocol.
- Pure discussion or no actual change: emit no protocol.

Before a new Skill, compare its name and typical objects/actions with Available skills. If one substantially overlaps, stop and ask whether to use it or still create a new one. Otherwise create in the same turn.

## Metadata-only shape

Unbound Commander:

```text
<skill>
<skill_id>existing-id</skill_id>
<category>data</category>
</skill>
```

Bound Skill editor:

```text
<skill-meta>
<category>data</category>
<negative_examples>
- unrelated request
</negative_examples>
</skill-meta>
```

Allowed metadata tags are `<name>`, `<description>`, `<description_zh>`, `<description_en>`, `<category>`, `<negative_examples>`, `<applicable_domain>`, and `<prerequisites>`. Omit unchanged values. Read `metadata.md` before writing them.

## Whole-file shape

```text
<<<skill-file path=SKILL.md
---
name: short-ascii-id
description: compact current-language routing description
---

# Instructions
...
>>>
```

- `path` is relative to the current Skill root; absolute paths and `..` are rejected.
- The terminator is `>>>` alone on its own line.
- In Commander, wrap changed files for one Skill in `<skill>...</skill>` and add `<skill_id>` only for an edit.
- In a bound editor, emit file blocks directly with no outer wrapper.
- A new Skill requires a complete `SKILL.md` and category. A metadata-only edit requires no file block.
- File deletion uses the confirmation protocol in `file-deletion.md`, never an empty replacement block.

## Execution sequence

1. Confirm explicit Skill intent and classify create, edit, or import.
2. Read only the references required by the routing table.
3. Read the current Skill and any user-supplied source material.
4. Preserve source or design the smallest self-contained capability; choose guide versus script deliberately. For a straightforward guide, prefer the required use/non-use boundary, preconditions, 3–7 steps, and output shape over a long tutorial or repeated examples.
5. Validate metadata, category, runner commands, safety, relative links, and the final resource inventory.
6. Emit only the minimal metadata tags and complete changed files, then stop for the host result.

## Safety gate

Do not author credential-store reads, dynamic or decoded execution, download-and-execute pipelines, startup persistence, runtime self-modification of Agent/Skill specs, or writes outside the authorized workspace. Convert required values into explicit inputs or stop and explain the boundary.

## User-visible prose

State only what the Skill now does, when it is used, which meaningful files changed, and any required next step. Do not expose protocol tags, frontmatter mechanics, internal modes, ids, or design jargon. Do **not** show source provenance by default. Mention it only when asked or when a failed read/import needs repair.
