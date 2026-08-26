# Importing an existing Skill

Read this file for a URL, local directory, ZIP, attachment, pasted existing SKILL.md, or any source-backed restoration. Always read the relevant source contents before authoring; a filename plus a short request is not enough. Importing is minimum-invasive restoration, not scratch authoring.

## Route before importing

- Explicit custom-Skill creation/import intent or a source whose payload is Skill content → use this protocol.
- Plain install request for a runnable repo/CLI/package → use the package installer.
- If the outcome is genuinely ambiguous and changes portability versus machine-local execution, explain the tradeoff in one line and ask one focused question.

## Native local package import in Commander

When `import_skill_package` is available and the current user explicitly supplies an absolute local Skill directory or ZIP in text or as a current-turn attachment:

1. Copy that exact path into `source_path`; never infer a parent, sibling, remembered, or discovered path.
2. Call `import_skill_package` once. It discovers every SKILL.md, enforces archive/path limits, copies unchanged files, validates each Skill, rolls back rejected siblings, refreshes the registry, and binds successful Skills when applicable.
3. Do not re-emit unchanged package files or pass them through model output.
4. Report rejected siblings with their reason; do not retry by silently renaming or overriding them. Successful siblings remain installed.
5. After success, use only a small metadata edit when category/routing clearly needs correction. Do not rewrite source files for review alone.
6. If no SKILL.md exists, explain that the source is not an existing Skill package. Convert it from scratch only when the user separately asked for that outcome.

## Bound editor modes

### Manual creation from materials

If files besides `SKILL.md` are present, inspect the file tree and read the likely source docs first. Treat imported docs, references, scripts, or examples as sufficient context when they reveal the intended capability. Do **not** ask the user whether the imported document should be used as a reference or merged into the skill. Ask 1–3 key questions only when no usable source exists and the capability cannot be inferred.

This is scratch authoring, so follow `authoring.md` after understanding the material.

### URL import

1. Enter only on explicit Skill import/create intent.
2. Fetch every SKILL.md, script, configuration, reference, and asset required to restore behavior. State any source file that cannot be fetched.
3. One source SKILL.md becomes one Skill. For multiple source files, emit one `<skill>` container per source skill, make the first source skill become the current import draft, and keep siblings separate. Do not merge multiple source skills into one Orkas skill.
4. If the page contains no clear SKILL.md, do not invent a Skill unless the user explicitly asked to convert the page into one.

### Directory or attachment fallback

Use this only when the native Commander importer is unavailable and files have already been copied into the draft.

1. Inventory the tree with the available search/list operation; do not ask where the supplied files are.
2. Read every visible SKILL.md first, then the scripts/config/references needed for each Skill.
3. Keep multiple source Skills separate. The directory containing each SKILL.md is its root unless the source documents another root.
4. Perform the final resource audit below and use `file-deletion.md` for proposed cleanup.

## Preservation rules

- Existing SKILL.md is canonical. Preserve body wording, section order, examples, relative links, and references.
- Do not force imported Skills into the scratch template, shorten a long body, change script languages, refactor implementation, move files, or drop features merely for style.
- If a source root has both a package-level SKILL.md and nested Skills, import the top-level file only when it is actually invokable rather than package documentation.
- If source Skills share runtime files, copy what each needs rather than making one Skill call another.
- Preserve scripts, references, assets, examples, prompts, templates, and tests that support runtime or model understanding.
- Preserve directory layout and filenames. Make only necessary Orkas compatibility changes.
- Rewrite bundled-script calls to the standard Skill Runner. JS/MJS/TS entry scripts expose the required default function while preserving useful direct-CLI behavior behind a main-module guard; subprocess languages keep argv/stdout/exit-code behavior.
- Keep configuration only when the body/scripts read it, it is a user-editable runtime template, or it documents required environment.
- Preserve the full source feature set unless the user explicitly requested a subset.

## Imported metadata

Read `metadata.md` and normalize only the opening YAML block:

- Keep `name` and `description` in SKILL.md.
- Preserve a single source description unless empty/unusable. When localized source descriptions exist, use the current UI language as portable `description`; preserve both through metadata tags only when the user explicitly requested multilingual support.
- Move Orkas-only category/routing data to metadata tags and drop source marketplace/install bookkeeping from frontmatter.
- Remove other frontmatter keys unless the source runtime explicitly requires them and no safer location exists.

After changing frontmatter, reread SKILL.md and verify the first YAML block contains only `name` and `description`. Outside that block, keep imported body content verbatim except necessary command/tool compatibility changes.

## Final resource audit

Inventory the full Skill tree and classify every non-SKILL.md file:

- `keep-runtime`: read or executed by the body/scripts.
- `keep-reference`: useful concise documentation, example, prompt, template, asset, test, or domain knowledge.
- `delete-unneeded`: unrelated to being invoked by the model.

Evidence, not filename alone, determines the result. Typical unneeded items are marketplace/install metadata, `.git`/`.github`, dependency trees, virtual environments, caches, build/coverage output, logs, release/contribution docs, copied workspace notes, prompt drafts, and one-off evaluation output. Source marketplace metadata remains unneeded even when faithfully copied.

Do not use source/current identity as cleanup proof. Do not say “no cleanup needed” until every file has a reason. Keep an uncertain file only when it plausibly provides domain knowledge, a template, example, test, or required asset, and state why. Deletions follow `file-deletion.md`; never claim the directory is clean while a proposed deletion is still pending.

## Completion report

Tell the user which Skill(s) were added, what each does, what meaningful files were preserved or minimally adapted, and any missing source/risk. Do **not** show a source URL or path by default unless requested or needed to diagnose failure.
