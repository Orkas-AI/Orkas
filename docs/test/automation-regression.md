# Automation regression

Use isolated local data and user-owned provider credentials. Account login, cloud
synchronization, hosted membership and analytics are outside this build. This
matrix states required outcomes; it does not certify every case as executed.

| Journey | Observable outcome | Owning evidence |
| --- | --- | --- |
| Create/edit/enable/disable/delete | Current content and schedule survive full relaunch; cancellation preserves data | `test/e2e/automation_e2e_crud.spec.ts`, `test/main/features/auto_tasks.test.ts` |
| Local project scope | Reject nonexistent projects before writing; moving to Global migrates config and attachments without restoring old membership after restart | Same suites |
| Dispatch and history | Due execution creates exactly one conversation with inline Skill/Connector chips and original attachments; UI receives its real notification without manual refresh | CRUD suite, `test/renderer/auto-events.test.ts` |
| Agent recipient | Stable Agent identity survives rename/relaunch; later messages retain the chosen recipient until explicitly changed | CRUD suite |
| Manual run | Opens a run without changing enabled state, device binding, last scheduled boundary or scheduled-run count | CRUD and scheduler suites |
| Partial update | Change only the requested fields; retain content, attachments and project scope; ambiguous deletion cannot guess an id | `test/main/features/auto_tasks_tool.test.ts` |
| Failed operation | Preserve retriable state, show the owning failure, and do not claim durable success after a failed save | Scheduler and CRUD suites |

## Calendar selection and device time

Weekly/monthly dropdowns default to single selection with no checks. The header
switch enables multiple selection and right-side checks; picking does not close
the menu. Labels join in the existing trigger. Workdays means Monday-Friday and
has no subtitle; it is disabled in multi-mode. Enabling multi-mode expands that
shortcut to five explicit days. Returning several days to single mode clears
selection and disables Save until the user chooses again. Monthly dates may be
non-contiguous. Old scalar records retain their editor mode. New array/Workdays
records have no scalar fallback: update the execution device before using them.

- Persist weekly/monthly selections and Workdays through IPC, editing and full
  relaunch. Verify keyboard, IME, Tab/Escape, focus recovery and Chinese separators
  in `test/e2e/automation_e2e_calendar_multiselect.spec.ts`.
- Reject empty, duplicate, conflicting, out-of-range and nonnumeric selectors
  before writes. Preserve weekly rollover, weekends, leap/short months and
  date/count cutoffs. Coincident clamped month-end dates execute once and consume
  one scheduled run. Content edits and reordered sets preserve an armed occurrence.
- Device-local timezone/offset and wall-clock corrections rebuild timers through
  existing restore/catch-up ownership, running only the latest eligible missed
  occurrence. One 30-second scheduler sample performs no I/O when unchanged.
  Stopping cancels monitoring; stale epochs cannot re-arm superseded timers.
- `test/main/features/auto_tasks.test.ts` owns calculations, persisted outcomes,
  clock simulation and duplicate-execution rejection. Real Windows/macOS timezone,
  sleep/wake and native background verification remain separate platform checks.

## Cards, localization and interaction

Keep title and compact menu together, message preview below, the complete calendar
summary on its own full-width row, then recipient/device/enabled/attachment facts.
Untitled cards use the message as their heading. Do not display last-run or
never-run metadata, and do not alter persisted run boundaries for presentation.

`test/e2e/automation_e2e_schedule_summary.spec.ts` checks all registered locales,
long selections, month-end meaning, 1280x800 and selected 900x650/RTL layouts,
wrapping, menu overlap, hover stability and keyboard dismissal/focus. The CRUD
suite covers the project entry too. Inspect actual screenshots, including long
names and inline resources. Preserve collapsed groups, expanded history and full
message readability across save, enable/disable, rename and language refresh.
Projects use sidebar order after Global; unavailable project metadata cannot hide
or relabel an automation. Deleting a run refreshes its history and counts.

## Recovery and native checks

Verify one-time real due execution, daily/weekly/monthly boundaries, background
execution and restoration without duplicate sends. A long timer checkpoint must
not become an occurrence. Missed occurrences outside the catch-up contract stay
skipped. Failed model dispatch retains diagnostic recovery or rolls back an empty
conversation. Editing a past time cannot backfill the same day; editing a future
time preserves that future boundary. Explicit pending-work protection applies
on exit; window close and system Quit retain their distinct ownership.

Verify assigned-device identity across network changes/relaunch and preserve
legacy ownership migration only when local evidence authorizes it. Unowned remote
records cannot be adopted automatically. Restore from Recycle Bin keeps id,
attachments, schedule and project. Failed cascade deletion must restore the same
bytes or retain a recoverable batch and return an explicit incomplete-recovery
failure. The deletion integration backlog must close before claiming that whole
journey verified; this document does not waive it.

Natural-language automation quality needs separately authorized production model
verification with independent persisted-state oracles for exact creation,
partial update and ambiguous deletion. Deterministic parser/fixture execution is
not real model quality or native Windows acceptance. No historical model score
is promoted to a current result.
