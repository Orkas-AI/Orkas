# Application regression

Use temporary local user data and synthetic inputs. Confirm visible outcomes,
retained file/database bytes and absence of refused side effects. A successful
fixture does not establish model output quality or live third-party availability.

## Automated entry points

- `npm run test:js -- test/main/features/saved_apps.test.ts test/main/features/chat_artifacts.test.ts test/main/features/saved-app-type-recovery.test.ts test/main/features/web-app-commercial-entry.test.ts test/main/features/web_apps.test.ts test/renderer/saved-apps-journeys.test.ts test/renderer/commercial-entry.test.ts` covers feature, SDK and interaction contracts.
- Run `npm run test:e2e:typecheck` before `npm run test:e2e -- test/e2e/saved_apps_e2e_lifecycle.spec.ts`.
- Run `npm run test:apps:e2e` for the selected local application journeys.
- Review the actual logs, warnings, fallback and cleanup failures. Intentional
  damaged-metadata, interrupted-write and denied-capability cases are negative
  controls; an unrelated warning remains a failure to investigate.

## Unified apps and publication guidance

1. Local, web and legacy cloud apps share one Apps list and creation dialog.
   Create, save, update, edit, open, preview and local execution remain available
   without a commercial-version dialog. Legacy metadata preserves its capability
   identity; a web app still cannot invoke host-only SDK methods.
2. Publish remains in every custom app menu and as a direct card action. Built-in cards retain their edit-copy menu. Invoking it opens the standard localized
   Cancel / Download commercial version dialog. Cancellation preserves the app,
   draft and invoking focus. Check English, Chinese and Arabic at normal and narrow sizes. Refresh preserves the focused direct action; cancelling guidance restores that same action.
3. Only an explicit Download action opens the official download page with the
   current supported Web language. An opener failure presents localized recovery
   and preserves the app. Page load, creation and ordinary app errors never open
   the browser or start publication.
4. Direct existing publication IPC returns the explicit
   `E_COMMERCIAL_REQUIRED` / `web_apps` failure before preparing a snapshot,
   uploading or changing local state. Ordinary artifact tools remain usable;
   no new model-visible publication tool is introduced.
5. Corrupt or unreadable metadata cannot become local SDK permission. Reject
   conflicting types on a bound editing source before writes. Genuine legacy
   local fallback and ordinary local HTML remain compatible.

## Local creation, list and save

- Create from an idea or template once, preserving literal user text. A second
  click does not duplicate the task. Sending failure keeps the recoverable draft.
  Cancel/backdrop/Escape retain a session draft; a reset clears it.
- The list uses local metadata, preserves cards after a failed/malformed refresh,
  rejects a late stale listing after deletion, and confirms a genuine empty list.
  Counts include installed built-in apps and custom apps. Deleting the final custom
  app removes only its section; installed built-ins remain. One creation entry,
  menus and long titles remain stable at narrow widths.
- Save an artifact and a complete file bundle, including a non-index entry,
  CSS/module/JSON/font/audio assets, binary content and ordinary long paths.
  Reject traversal, hidden/managed paths, symlinks, invalid encoding and oversized
  input before changing the destination. A workspace-root entry requires its own
  folder. Show one toast after an actual successful save.
- Omitted or null type in an ordinary task retains local compatibility; conflicting
  types in a bound edit fail before writes. Saving a valid independent local copy
  must not overwrite its original or silently change identity.

## Open, edit and recovery

- Open a card of any retained app type with mouse, Enter and Space. One action opens one preview;
  rename preserves identity and icon. Refresh/restart retain the saved result.
- Editing creates a source-attached task with the exact original identity and
  capability identity. The composer starts empty with the localized edit hint.
  The selected source attachment supplies the existing framing only through
  invisible `model_text`; the visible and persisted authored requirement stays
  unchanged. Reload retains the source and draft; later turns use the normal or
  busy hint. Preparation shows immediate feedback, prevents duplicate requests
  and restores retry after failure. Updating retains its ID and compatible records. Saving a new
  app binds this source to an independent copy; a deleted destination creates a
  new ID. Repeated or interrupted commits do not lose the original or duplicate data.
- Exercise each save-journal crash point and cleanup failure. Recovery retains a
  usable source and only commits a complete replacement. Missing/damaged edit
  context produces a recoverable failure rather than an invented local binding.
- File/Artifacts views and chat cards navigate to the correct artifact and user.
  Source attachments, generated files and current composer state remain isolated.

## Shared local SDK and SQLite

- Discover actual schemas, enforce manifest declarations and reject undeclared
  capabilities before native, model or connector execution. Ordinary local calls
  remain available without introducing additional paid routing or approvals.
- Preserve record values, not just counts, through reopen. Preview records are
  temporary and never overwrite formal data. App copies and local users remain
  isolated. Concurrent startup, timeout and worker closure permit later recovery.
- Run the independent common-data fixtures: field/type/size constraints, read
  filters, stable pages, aggregation, relations, capacity and idempotent insert.
  Reusing an operation ID with different data fails without corrupting records.
- Cancellation, frame removal, account change, stream-consumer departure and
  revocation terminate the owned request. Late results cannot write or publish
  into a replacement frame; an explicit new request can succeed. Completed
  external effects are not undone or replayed automatically.
- Exercise partial reads, binary exports, create-only writes, storage aliases,
  denied path access, deep paths, long keys and exhaustion/reopen boundaries.

## Rename, delete, localization and privacy

- Rename changes only the display name; original/source identity survives.
  Delete confirmation names the app and irreversible local records/private files.
  Cancel has initial focus and preserves data; success removes the card only
  after backend confirmation. Failure keeps the card and permits retry.
- Check card dates, exact edit draft, unified icons and failure copy in every
  registered language. No untranslated key, private path or backend text appears
  in alerts. Long names and RTL layouts retain accessible buttons and local scroll.
- Hosted publication, online data management and personal synchronization are
  unavailable. Their execution/recovery journeys are outside this build; the
  retained entry only explains how to obtain the commercial version.

## Revision and save-destination continuity

- Correcting an artifact retains its ID, saved destination, type and records.
  Streamed and restored history refresh one existing card. Failed preparation
  keeps the previous bundle; independent creations remain independent. An open
  native preview follows only a newer revision of that same artifact.
- After saving an artifact or workspace bundle, each source exposes Update
  original app / Save new app. Reopening and sibling JS/CSS/directory discovery
  recover the same destination. An explicit Save new changes only that source's
  destination; a deleted destination never falls back to an unrelated original.
- Simultaneous automatic saves and symlink aliases create one destination.
  Canonical directory identity owns the save queue and binding. Conflicting old
  lexical bindings require an explicit new copy; do not guess between old copies.
- Saving a non-index HTML and later updating from sibling JS/CSS retains its
  selected entry and title. A missing selected entry fails without replacing the
  saved version. Explicit HTML selection may change the entry.
- Both artifact and file save entries use the same record migration recovery.
  Export failure/cancellation, clear cancellation, user change, stale data/code
  and changed destination never clear records or replace code. Confirmed recovery
  updates the same app and an exported SQLite file retains the original values.
- Application shutdown closes data owners and waits for their SQLite checkpoints.
  A compatible update and complete application restart retain formal records.
  Preview records stay temporary.

Owning evidence: `chat-artifact-revisions.test.ts`, `saved_apps.test.ts`,
`web_apps.test.ts`, `preview-windows.test.ts`, `app-save-recovery.test.ts`,
`artifact-revisions.test.ts`, `artifact_revisions_e2e_lifecycle.spec.ts`,
`saved_apps_e2e_lifecycle.spec.ts` and `web_app_sdk_e2e_lifecycle.spec.ts`.


## Built-in Content and Commerce journeys

Content and composed Commerce share creation, parameters, draft/reopen, task
history, result actions and the material library. Changes to those shared flows
must assess both actual packaged workspaces. App data stays isolated. Content
retains Images, Video and Audio; Commerce adds Copy before Images and Video.
Both packaged apps are mandatory resources. Engineering cases stay outside
release bundles.

- Exercise sticky tabs, inline History, Show more/reopen, per-record deletion,
  cancellation and failed-delete retry. Preserve independent authored drafts,
  immutable selected source/settings identities, bounded file snapshots, exact
  authored requests, durable records and explicit result acceptance.
- Use real SDK/native admission with controlled models and services. Cover lost
  admission replies, unavailable initial storage, failed saves, missing Studio,
  explicit Stop, questions and approvals, delayed or failed output retrieval
  across work switches. Retain one admission, original-work ownership, no
  invented media success and no redispatch during storage recovery.
- Cover selected file attachments, PDF/PSD, image/video/audio/subtitle retrieval,
  binary export, text-reply saving and result reuse without replacing the draft.
  Reset includes settings-only changes, references and resized inputs, durable
  reopen and failed-save recovery. It does not archive seeded old drafts or stop
  already admitted tasks.
- Verify all registered locales, narrow English, Chinese and Arabic RTL,
  compact controls, numeric-input recovery and readable first-viewport entries.
  SDK failure and damaged app data preserve prior state; repair/reopen works.
  Controlled outputs establish these journeys, not live media quality or
  Windows-native rendering.
- Ordinary history access cannot expose app-private sessions. Archived results
  remain readable after context removal; a foreign host cannot settle an
  unarchived run. Retained turns, exact required-input continuation, native
  approval ownership, cleanup retry and uncertain/cancelled states remain
  covered by the app-session, task, private IPC and native owners.
- Commerce Copy retains authored input, applicable output parameters, private
  references and independent persisted drafts. Generate/read/reopen text,
  preview saved files, preserve separate image drafts, retry an explicit failed
  save and recover uncertain admission without dispatching twice. Controlled
  successful image fixtures contain actual bytes in the selected shape.
- Existing product facts, explicit references, filtered history and media
  adoption remain available without a product manager. Seed old files through
  the fixture, reopen and verify original facts/bytes. Failed adoption preserves
  selection and old media; retry adds one result without duplication or changes
  to copy/publication data. New accounts expose no product controls. Existing
  product records are neither deleted nor migrated.
- Stores distinguishes empty, failed and disconnected connector discovery.
  Connect store opens Connectors; Back reuses the live app window and refreshes
  discovery while retaining the draft. Cover legacy SDK recovery, failure/retry,
  in-flight return, bounded entry caching, manual refresh, reopen and identity
  changes. Old desktop hosts explain restart/main-window recovery. These reads
  never imply remote publication.
- Per-tab media choices remain independent across reopen. Text-only work omits
  media. The first configured service is selected initially and after reset;
  an explicit choice survives Settings reordering. Discovery changes never
  save/promote a service profile. Remove a configuration and verify recovery;
  retain failed replies. Service identities remain secret-free, disabled or
  deleted choices cannot run, and quotation/dispatch use the same choice.

Owning entries include `content-workbench.test.ts`, the media/recovery renderer
owners, `commerce-copy.test.ts`, `product-listing.test.ts`, `builtin-apps.test.ts`,
`web-app-tasks.test.ts`, `app-agent-sessions.test.ts`, `web-app-host.test.ts`,
`content_workbench_e2e_lifecycle.spec.ts`,
`content_workbench_e2e_recovery.spec.ts`,
`content_workbench_e2e_media.spec.ts` and `app_output_e2e_commerce.spec.ts`.
Listing a scenario is not a claim that it ran. Use the affected-case selector;
`test:apps:e2e` remains the public native application entry.

## Additional local compatibility and failure matrix

- Paint eleven untyped legacy local copies plus the installed built-ins without
  changing their metadata or sources. Failed local reads retain exact card IDs;
  a confirmed empty custom inventory removes its section. Local controls never
  need publication discovery.
- For an untyped original, displaying Update original app preserves its unknown
  type and changes no metadata. Explicit saving resolves its capability at the
  write boundary, updates the same ID and retains compatible records. Exercise
  both artifact and detached file previews.
- Preserve non-index nested entries, known binary digests, zero/false/null,
  Unicode and boundary timestamps. Isolate two app IDs and local users. Cancel
  a request before invocation, replay its completed ID, use malformed credentials
  or reuse the ID in a sibling app; each rejection invokes no adapter and leaks
  no token. A fresh authorized request still works.
- Inject association-write failure while saving a copy; the prior binding and
  app remain intact. Duplicate automatic requests share one destination.
  Changing the source after inspection or stopping its task rejects a guarded
  update without producing a replacement. Correcting an artifact refreshes one
  card and retains its data; independent creations remain independent.
- Check every save-journal crash point, code/schema consistency, failed cleanup,
  export record values, stale clear consent and account change. A restart chooses
  a consistent version and never clears newer records or automatically replays
  external work. Windows process/lock behavior remains a native-host canary.
- IME Escape cannot submit/cancel a creation dialog. Local and built-in long
  titles leave upper-right menus reachable, contain overflow, preserve focus
  through refresh and restore invoking focus after cancellation.
- Automatic conversation-card load failures stay inline with Reload, without
  stacked modal dialogs. Retry only that card and preserve siblings; explicit
  standalone-preview errors retain their feedback.

Record actual versions, selected cases, fault ordering, final rendered results,
record/digest comparisons and cleanup. Review attributed logs separately from
injected failures. A toast or successful API result alone never completes a
manual row. Live models, media services and paid settlement require their own
explicit execution authority and remain separate from deterministic evidence.
