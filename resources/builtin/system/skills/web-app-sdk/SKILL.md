---
name: web-app-sdk
description_zh: "为任务交互结果和我的应用创建、修改或排查使用 Orkas 模型、文件选择与导出、存储、知识库或连接器的 Web 应用。不用于普通网页设计、产品答疑或系统 Skill 修改；不授予执行权限。"
description_en: "Build, change or debug Web apps using Orkas models, file selection/export, storage, Library or connectors for interactive results and My Apps. Not ordinary website design, product help or System Skill editing; grants no execution authority."
---

# Orkas Web App SDK

Build browser interfaces against the host SDK. Keep credentials, account identity,
file paths and permission decisions in Orkas. Do not import Electron, forward
arbitrary IPC or copy the Agent runtime into the app.

## Find the actual contract

Read [the API reference](references/api.json) before choosing methods. It contains
the executable registry's input schemas, result shapes, examples and unsupported
families. Read [the starter HTML](assets/starter/index.html) and
[its manifest](assets/starter/orkas-app.json) when starting a bundle or checking
integration. These files are copyable inputs, not an executable Skill script.

The model's own tools are not Web APIs. `tools.list` in a running app lists only
eligible existing executors; never invent SDK methods from host tool names.

## Build and discover

1. Put `orkas-app.json` at the app bundle root. Set `sdkVersion: 1` and declare
   only needed families from `storage`, `appFiles`, `files`, `ai`, `library`, `connectors`.
2. Load `<script src="/__orkas/sdk.js"></script>` before app code. Use
   `window.orkasApp`. Local bundles and external HTTP(S) scripts, styles and assets
   are supported in running apps and previews.
3. Call `capabilities.list()` to check support, declaration, availability and
   authorization separately. Use `capabilities.describe({method})` for the
   current schema. Never treat a declaration or discovery result as consent.
4. Use `api.<group>.<method>(arguments, {signal, onProgress})`. Both options are
   optional; AI progress delivers text deltas. Render untrusted results with
   `textContent`, not HTML. Inspect tool `isError` and AI `stopReason`.
5. Deliver through the existing interactive-result or saved-app workflow and
   verify there. A loose HTML export or ordinary browser has no Orkas bridge.

## Capability boundaries

- **Storage:** JSON values private to this account and app source. Set
  `scope: "cloud"` for business data to participate in the account's existing
  cloud sync; use `scope: "local"` for caches. Omitted scope remains local for
  old apps. There is no automatic migration from local or browser storage.
- **App files:** declare `appFiles` for relative-path text/binary files in the
  app's private sandbox. Its default scope is cloud; choose local for caches.
  Read/write/list/remove affect only this app. Source code is separate.
  Reopening keeps data; copied/re-saved apps have independent sandboxes. Cloud
  sync requires the same account and sync enabled on each device. Saved means
  persisted on this device, not uploaded. Conflicts use Orkas Settings; there
  is no SDK sync-status API. Keep explicit export for important data.
  Preview redirects both scopes to disposable storage; it cannot prove sync.
- **Files:** native selection returns an opaque handle to a read-only snapshot,
  not a path or permission to edit the original. Release handles after reading.
  Picker/save cancellation returns `null`. Text export creates a new file; an
  existing destination is refused. Orkas managed data cannot be selected.
- **AI:** configured model, supplied prompt only; no implicit conversation,
  project, Agent, tools or Skill context. Ordinary generation needs no separate
  app permission dialog. Requests can incur model charges; usage reports tokens, not price.
  Show partial output as incomplete when `stopReason` is `max_tokens`.
- **Library:** eligible global Library operations without a separate app consent. There is
  no inferred project binding from the source conversation.
- **Connectors:** discover `tools.list()`, then call its `list_connector_tools`
  executor to obtain enabled connector/action schemas before invoking
  `call_connector_tool`. Existing operation permissions apply: sensitive actions
  use the Orkas dialog; Trusted runs available actions without confirmation.
  Allow for this use covers the approved connector account and sensitive action
  class until this app instance closes. Other apps and reopened instances do not
  inherit it. External writes and fees are possible; inspect business errors.
  Connector installation is not exposed.

Use browser `fetch`/XHR, EventSource or WebSocket for external APIs; no SDK network
method or manifest capability is needed. Browser CORS, mixed-content and endpoint
authentication still apply. External scripts run with the app's declared SDK
abilities. Handle failures and cancellation without replaying uncertain writes.
Automated `html_preview` allows Web
resources but isolates storage and disables account services; verify business
actions in the running app.

Read `unsupported` in the reference for excluded families and reasons. Shell,
task/Agent execution, Skill execution, project/history/
memory access, media generation and editing selected original files have no v1 adapter.

## Failure and lifecycle

Catch each action's failure and show a useful recovery state. A denied action
must leave the UI usable for an explicit retry. Never automatically replay AI or
tool calls after uncertain failure: spending or a remote write may already have
occurred. Aborting does not undo a completed external action.

Close, navigation away from the app, account switch, source change and `permissions.revoke()`
invalidate the instance. Reopen for fresh grants. Do not persist file handles.
When the host/model is unavailable, explain how to reopen in Orkas or configure
a model; do not substitute fabricated results or direct provider requests.

File and JSON-store byte limits follow PC's 200 MiB ceiling. The SDK adds no
quotas on file count, aggregate file bytes, storage-key count, instance count,
cumulative requests or concurrent calls. Owning services retain their limits; AI output defaults to the configured model. Tool results are application data and do not use
model-context token budgets. Initial host discovery times out after 10 seconds;
after connecting, operations use the owning service's timeout and cancellation.

## Language and interface quality

Use `host.getContext().language` for the app UI when no explicit app-language
requirement overrides it. Apply it to visible labels, errors, empty states,
accessible names and document `lang`, not just the model's reply. Preview returns
the same selected host language; its unavailable services need preview-specific
recovery rather than repeated configuration requests.

Use semantic HTML and accessible names for the actual controls and feedback.
When a requested explanatory region is a note, expose `role="note"`; a CSS class
named `note` alone has no accessibility semantics. Verify the rendered role and
text through the visible interaction flow, including cancellation and export.

## Verify delivery

Exercise the app's visible controls in Orkas: discover, use its declared
capabilities, cancel/deny, recover explicitly, close/reopen and export. Check that
an unrequested capability fails without side effects and that a second app cannot
read the first app's state. Use local model fixtures for engineering tests;
perform a billable test only within the user's explicit spending authorization.
