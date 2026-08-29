# Authoring a self-contained Skill

Read this file for a new Skill, a substantive SKILL.md rewrite, a reference file, or a bundled script.

## Mental model

A Skill is an independent reusable capability, not a tutorial or an Agent.

- One clear responsibility. Split “analyze + report + email” into separate capabilities.
- No dependencies on other Skills by name, id, file, or script. The caller orchestrates.
- SKILL.md is the model-facing interface: actionable, concise, and specific only where reliability requires it.
- Prefer a guide using existing tools. Add a script only for deterministic repeated logic or a real integration boundary.
- Keep the root SKILL.md as the routing and common execution spine. Move conditional variants, long schemas, detailed examples, and deep domain material into one-level `references/` files. In the root, retain only each branch's discriminator/read condition; do not repeat branch checklists, branch schemas, or empty branch templates there.
- Aim to keep a newly authored root comfortably below 12,000 characters. This is a context budget, not a reason to omit required safety or execution rules; move conditional depth rather than compressing it into ambiguity.
- A straightforward single-path guide should be much shorter than that ceiling. Do not expand a compact request into a tutorial: cover the required boundaries, preconditions, 3–7 execution steps, and output shape once, then stop.

## Design workflow

1. Identify 2–3 concrete user task shapes and one or two adjacent non-goals.
2. Decide inputs, preconditions, action authority, and expected output.
3. Choose guide-type or script-type.
4. Write the shortest root workflow that executes the common path.
5. Put optional variants/reference data into separate files. Link each one directly from SKILL.md with an explicit Markdown link in the same sentence as its read condition, for example: `When the request involves privacy, read [Privacy review](references/privacy-review.md).`
6. Validate safety, commands, links, outputs, and realistic usage.

## New SKILL.md body

Use short sentences, lists, and code blocks. Write newly authored human-readable content in the user's UI language. Include:

1. **When to use** — 2–3 concrete task shapes.
2. **When not to use** — boundaries that prevent wrong selection.
3. **Preconditions** — required files, runtime, account/login, API key provided by the user, network, and any platform confirmation.
4. **Steps** for a guide or **How to call** for a script.
5. **Expected output** — stable success/failure keys for executable Skills, or the user-facing output shape for guide Skills.

Add examples only when they materially improve invocation accuracy. Do not repeat generic model knowledge or write marketing prose.

Preserve authority across irreversible operations: a current user request authorizes that exact action. Distinguish an unresolved target from a scope expansion; ask only for the missing target, and pause only for a materially different action/target or a platform-required confirmation.

## Guide versus script

Default to a guide with 3–7 actionable steps when existing file, Library, web, or command tools can perform the work.

Add `scripts/<basename>.<ext>` only for dedicated parsing, stable local state, third-party API behavior, signature verification, or logic otherwise rewritten repeatedly. Do not create placeholder scripts. Prefer Python, JavaScript/MJS, or TypeScript for new portable scripts; preserve another language when importing existing source. Do not author new shell scripts as the default portable path.

## Standard Skill Runner

Every SKILL.md command that executes a bundled script uses:

```text
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" <skill-id-or-name> <script-basename> -- [args...]
```

- Do not prefix with `bash`.
- Keep both runtime/runner paths quoted.
- Use the script basename without extension and retain `--` before script arguments.
- Never expose or construct the Skill installation path or rely on the caller's current working directory.
- The runner injects `ORKAS_SKILL_ID` and `ORKAS_SKILL_DIR` for bundled resources.

Runtime selection:

- `.py`: `python3`, with Windows fallback.
- `.js` / `.mjs` / `.ts`: require a default async function that returns JSON-serializable data; retain direct CLI behavior only behind an explicit main-module guard.
- `.ps1`, `.cmd`, `.bat`: Windows-native flows.
- `.sh`: requires a compatible shell and is not the default for new portable Skills.
- `.rb`: Ruby.

Subprocess scripts read argv, write structured JSON/text to stdout, send failure detail to stderr, and exit non-zero on failure. Keep success and failure output keys stable, with `ok` as the discriminator where JSON is appropriate.

Ask before installing any dependency. State package, purpose, and exact install command; install only after agreement. List every third-party dependency in an `External dependencies` body section. Never bundle `node_modules`, virtual environments, caches, or build output.

## Safety gates

Do not author or preserve:

- direct reads of `.env`, SSH/cloud credentials, shell history, keychains, browser cookies, other Agents' private data, or other Skills' SKILL.md;
- `eval`, `exec`, `new Function`, decoded/obfuscated execution, or base64 decode-then-run;
- `curl | sh`, `wget | sh`, raw-IP download-and-execute, or equivalent pipelines;
- shell startup changes, launch agents, scheduled persistence, or auto-run hooks;
- runtime code that mutates Skill/Agent/install specs;
- writes outside the authorized workspace unless the user explicitly supplied that target and it is the visible task.

Convert secrets and paths into explicit user-provided inputs. Stop and explain when the requested capability inherently crosses a gate.

## Independence and final check

- The root and every reference/script describe only this Skill; do not name another Skill as a dependency or workflow step.
- All relative links resolve within this Skill.
- Each reference has an explicit Markdown link directly from SKILL.md in the same sentence as a clear read condition; a bare or backticked path is not a link. Avoid chains of references.
- The common path is executable from the root without loading optional material.
- A script, if present, is real, tested, runner-compatible, and has stable output/error behavior.
- The final content matches the user's requested scope and does not silently expand it.
