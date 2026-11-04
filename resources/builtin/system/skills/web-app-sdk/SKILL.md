---
name: web-app-sdk
description: "Build, change or debug local apps and publishable web apps, using the matching browser, common data or host contract. Not product help or System Skill editing; grants no execution authority."
---

# Application development

Use the creation task's selected type or the original app's type when editing.
Omit `create_artifact.appType` to inherit that platform binding. In ordinary
conversations, new apps default to local; use web only when the user requests it.
Editing retains the original type. Converting requires a new app identity.

Read [the common data contract](references/common.md), then the appropriate
reference before choosing APIs:

- Local: [local guidance](references/local.md), [API contract](references/api.json)
  and [starter](assets/starter/index.html). Local host JSON/files retain their
  200 MiB ceiling and account-sync meaning.
- Web: [web guidance](references/web.md), [API contract](references/web-api.json)
  and [starter](assets/web/index.html). Apply this contract during generation,
  preview, unpublished desktop use and online use.

Build through `create_artifact` with a complete top-level index.html and relative
bundled paths. Include `orkas-app.json` in that same call, declaring every SDK
capability the app uses and, for data, its definition: a local app without it gets
no SDK, and a web app without it gets no data access. Read generated schemas for exact arguments and supported methods;
model tools are not application APIs. Do not invent unavailable interfaces.

Verify visible actions, empty/error states, cancellation, close/reopen and isolation.
Previews use temporary data and cannot prove formal or online persistence.
Preserve the existing save-new/update-original workflow. Publishing requires an
explicit user action through My Apps; saving or updating locally does not publish.
Use fixtures for engineering checks; paid generation needs separate spending authority.
