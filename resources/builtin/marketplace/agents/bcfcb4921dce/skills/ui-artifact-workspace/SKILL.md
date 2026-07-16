---
ownerAgent: bcfcb4921dce
name: ui-artifact-workspace
description_zh: "管理 UIDesigner 独立产物的固定目录、artifact.json、默认 HTML/显式其他格式、原位增量修改、相对资源与按需 ZIP 打包，确保后续对话能快速找到并继续同一份设计。"
description_en: "Manage UIDesigner standalone artifacts through stable per-artifact directories, artifact.json, HTML-default or explicit alternate formats, in-place iteration, relative assets, and on-demand ZIP packaging so later turns can quickly resume the same design."
category: rnd
---

# ui-artifact-workspace

Use this skill for every standalone UIDesigner artifact, regardless of final format, and for every follow-up that revises a previously created artifact. It is the continuity and packaging contract around the visual skills; it does not decide the visual direction itself.

The goal is one canonical artifact, one stable directory, and small traceable revisions. Do not scatter HTML, images, notes, and data across the workspace root. Do not make the user identify the same artifact again on every turn.

## Follow-Up Non-Negotiable

Every revision response must preserve all three proof groups together; missing any group blocks delivery:

1. **Canonical reuse**: read the current manifest/entry/assets and patch the same directory in place.
2. **Preservation**: explicitly say `fork/v2: forbidden` and preserve named user edits plus unrelated hooks, interactions, tokens, and asset paths.
3. **Revision acceptance**: requested-change result plus non-blank first render, primary workflow, responsive behavior, and local asset/reference resolution; increment the manifest once only after all pass.

When tools are off, emit the Revision Executor Contract near the start of the response. Every check remains `not run` but still includes its future action and concrete pass criterion. Do not output a replacement manifest with guessed fields or a reduced `files` list; describe the pending revision delta until the existing manifest has been read.

## Choose The Canonical Workspace

Resolve the mode before editing:

1. **Follow-up to an existing artifact**: reuse the exact artifact directory from the user's path, the current conversation, or its `artifact.json`. Inspect it before changing anything.
2. **Implementation inside an existing app repo**: the real app source remains canonical. Edit the existing components, tokens, and routes in place; do not create a parallel copy that can drift. Create a standalone `ui-artifacts/<task-slug>/` preview only when the user also asks for a shareable design artifact.
3. **New standalone artifact**: create `ui-artifacts/<task-slug>/` under the current writable workspace or supplied repo root. Use a short stable kebab-case slug derived from the product or feature, not a timestamp.

Never put a new standalone artifact directly in the workspace root. Never create `-v2`, `-final`, `-final-final`, or a timestamped sibling for an ordinary revision. A new sibling is valid only when the user explicitly asks to preserve the old version, compare alternatives, or fork the direction.

If several plausible prior artifact directories exist and the conversation does not identify one, inspect their manifests first. Ask one focused question only when the choice remains genuinely ambiguous.

## Resolve The Final Format

- Default to `html` when the user does not specify a format.
- Honor an explicit alternate format such as SVG, PDF, React, Vue, PNG, or Markdown instead of forcing an HTML final.
- The independent directory rule still applies to alternate formats.
- For target-repo implementation, follow the existing framework and file types. Do not wrap a requested React/Vue implementation in a separate HTML export unless the user also wants a standalone preview.

The manifest `format` and `entry` must match the actual deliverable. Supporting HTML previews may accompany an explicitly requested non-HTML final, but must not silently replace it.

## Minimal Directory Contract

For a default standalone HTML artifact:

```text
ui-artifacts/<task-slug>/
  index.html
  artifact.json
  assets/              # only when local assets exist
```

Add files only when the task needs them:

- `DESIGN.md` for reusable multi-screen/system/brand work, formal handoff, or an explicit user request. Do not create it for an ordinary single-screen fast-path artifact.
- `data/` and provenance files for a live-ready artifact, following `ui-live-artifact`.
- Local CSS/JavaScript modules when a self-contained `index.html` would become fragile or hard to edit.
- Source-specific entry files for an explicit alternate format.

Prefer a self-contained `index.html` for small and medium one-off designs. Split files when doing so materially improves maintainability, multi-screen structure, or incremental edits. Do not add a build system, dependency lockfile, or package manager just to render a standalone artifact.

## Artifact Manifest

Every standalone artifact directory must contain valid `artifact.json`. Keep it compact and machine-readable:

```json
{
  "schema_version": 1,
  "artifact_id": "ui-renewal-risk-workbench",
  "title": "Renewal risk workbench",
  "format": "html",
  "entry": "index.html",
  "revision": 1,
  "created_at": "<ISO-8601>",
  "updated_at": "<ISO-8601>",
  "design": {
    "system_source": "existing-repo | supplied-reference | contract | one-off",
    "direction": "<short visual thesis>",
    "fixed_decisions": ["<decisions later revisions should preserve>"]
  },
  "files": ["artifact.json", "index.html"]
}
```

Keep the fenced manifest strict JSON. Put a path label before the fence; never put `// path`, comments, trailing commas, or Markdown inside the JSON block.

Rules:

- Keep `artifact_id`, directory name, `created_at`, and entry path stable across normal revisions.
- Increment `revision`, update `updated_at`, and refresh `files` after every successful change.
- Treat `files` as the complete sorted package inventory. It must include `artifact.json` itself, the entry, and every shipped relative asset/source file; omit only generated ZIPs and temporary QA files.
- Record only compact design continuity facts. Do not store full prompts, chat transcripts, secrets, credentials, cookies, auth headers, or raw provider responses.
- Prefer relative paths. Do not embed machine-specific absolute paths in the deliverable or manifest when a workspace-relative reference is sufficient.
- `fixed_decisions` are commitments from the user, source, or accepted direction. Do not use them to freeze incidental implementation details.

## In-Place Iteration Protocol

When the user asks to adjust, polish, fix, restyle, extend, or review-and-apply a prior artifact:

1. Resolve and state the canonical artifact root internally.
2. Read `artifact.json`, the current entry file, referenced local assets/styles/scripts, and any `DESIGN.md`; do not rely only on the earlier chat summary.
3. Establish a baseline from the current artifact. If preview or screenshots are available, inspect the current render before editing.
4. Translate the request into a compact change set: requested changes, invariants to preserve, affected files, and acceptance checks.
5. Patch the smallest coherent set of existing files. Preserve unrelated user edits, content, interactions, stable DOM hooks, relative asset paths, design tokens, and accepted layout decisions.
6. Do not regenerate the whole artifact or reset it to a generic template for a local change. Broader restructuring is valid only when required by the request or by a blocking craft failure; state that reason.
7. Update `artifact.json` only after the artifact files are valid. Increment the revision exactly once per completed revision.
8. Re-run focused checks for the changed area plus four explicit smoke checks: non-blank first render, existing primary workflow, responsive behavior, and local asset/reference resolution.

Before completing a revision, record a compact revision proof with the baseline revision and files inspected, files changed, user/manual edits preserved, requested-change result, the four smoke-check results, and the resulting manifest revision. A generic sentence such as “verified successfully” is not sufficient evidence. If a check could not run, name it as unverified instead of implying success.

When tools are unavailable, do not drop this protocol. Provide the exact in-place executor plan against the canonical directory, including manifest read/increment, preserved manual edits, no-v2 rule, requested-change check, and all four regression checks. For every unexecuted check, state both the future action and its concrete pass criterion; a bare list of `not run` labels is not a sufficient executor plan. Mark every unexecuted step `not run`; future-tense plans are not claims of completed work.

Use this compact **Revision Executor Contract** so none of those invariants disappear in free-form prose:

- `Canonical directory:` the existing artifact root.
- `Baseline:` manifest revision and files to read; status `not run` until read.
- `Continuity:` patch in place; `fork/v2: forbidden`; preserve the named manual edits plus unrelated hooks, interactions, tokens, and asset paths.
- `Change set:` only requested files/regions.
- `Revision transition:` current → next, applied exactly once only after every acceptance check passes.
- `Acceptance checks:` requested change, non-blank first render, primary workflow, responsive behavior, and local asset/reference resolution. Give each future action, concrete pass criterion, and `not run` status.

If the prior artifact has no manifest, adopt it in place: create `artifact.json` beside the existing entry file and treat the current files as revision 1 before applying the requested revision. Do not move a user-owned artifact merely to satisfy the preferred folder name.

## Editability By Design

Make future changes cheap without turning the artifact into a framework:

- Put repeated visual values in CSS custom properties or the target repo's existing tokens.
- Keep major regions and components clearly named.
- Use stable IDs or `data-*` hooks only where interaction or host integration needs them.
- Separate sample data from presentation when the task is data-heavy or refreshable.
- Keep copy in coherent blocks instead of scattering words across pseudo-elements.
- Avoid generated hashes, opaque class names, base64 blobs, and unnecessary minification in source artifacts.
- When the user asks for tweakable controls, expose only a few high-impact choices and persist them safely; ordinary artifacts do not need an embedded control panel.

## Package-Ready Contract

The artifact directory itself is the package boundary:

- All internal links and assets must be relative and remain inside the directory unless the artifact intentionally targets an existing app repo.
- Default standalone HTML should open without a build step. Avoid CDN-only fonts, scripts, icons, or images when offline/shareable delivery is expected; use local assets and resilient font fallbacks.
- Do not include `node_modules`, caches, screenshots made only for QA, temporary files, credentials, raw source attachments, or unrelated workspace files.
- Check that `artifact.json` lists itself and every final package file, and that its `entry` exists.
- Check local references for missing files before delivery.

Do not create an archive on every run. When the user asks to package, export, download, share, or hand off the artifact, create a sibling archive named `<task-slug>.zip` from the contents of the canonical artifact directory. Keep `index.html` or the explicit entry file at the archive root, not behind an extra nested copy of the same directory. Rebuild the archive after later changes instead of accumulating numbered ZIPs.

## Verification And Delivery

Pair this skill with `ui-design-executor` by default. Load `ui-html-renderer` or `ui-craft-checks` only for their specialist triggers; ordinary single-screen HTML uses the executor's fast gate. For an explicit alternate format, use the relevant format checks and still verify the manifest, entry, local references, and package boundary.

Final delivery should lead with:

- Canonical artifact directory.
- Entry file or implemented app screen.
- Final format and revision.
- Files changed on a follow-up.
- Verification actually performed.
- ZIP path only when an archive was requested and created.

For an explicit alternate format, state the final format directly, for example `Final format: SVG; HTML intentionally absent per request`. Do not use ambiguous wording that makes the alternate format sound like a supporting asset.

Do not claim an artifact is package-ready if it still depends on missing local files, machine-specific absolute paths, undeclared secrets, or an unmentioned build/runtime.
