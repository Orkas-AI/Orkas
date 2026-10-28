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
2. Publish remains in every app menu. Invoking it opens the standard localized
   Cancel / Download commercial version dialog. Cancellation preserves the app,
   draft and invoking focus. Check English and Chinese at normal and narrow sizes.
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
  Counts, one creation entry, menus and long titles remain stable at narrow widths.
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
  capability identity. Updating retains its ID and compatible records. Saving a new
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
