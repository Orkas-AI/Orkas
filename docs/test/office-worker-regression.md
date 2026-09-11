# OfficeWorker Regression

Run this checklist when the Office agent, Office skills, built-in Office tools, or OfficeCLI pin changes.

## Dependency Contract

- `OfficeWorker` and its five shared knowledge skills are platform-builtin resources compatible with Orkas 1.6.1 or later. They are not Resource marketplace overlays.
- The shared skills cover Word, Excel, PowerPoint, WPS compatibility, and PDF editing. They contain preservation/QA guidance, not duplicate runtimes.
- Resource-to-builtin takeover removes files tracked by the old Resource manifest that are absent from the packaged builtin, while preserving unmanaged local runtime files.
- Office file execution uses bundled tools backed by the checksum-pinned OfficeCLI binary. Users and agents do not install or invoke the binary directly.
- No OfficeWorker path requires `nano-pdf`, `python-pptx`, `openpyxl`, `pandas`, Microsoft Office, LibreOffice, or WPS at runtime. PDF structural editing uses packaged `pdf-lib`; PDF rendering uses the already-packaged PDF.js canvas runtime.
- Word/Excel/PowerPoint/WPS applications remain optional final-review targets for fidelity-sensitive documents.
- `.doc`, `.xls`, `.ppt`, `.wps`, `.et`, and `.dps` require conversion or manual target-application work.
- `.xlsm` may be attached for broad read-only inspection but must not be passed
  to the `.xlsx`-only Office tools; macro/link/signature-preserving edits require
  target Excel or another explicitly approved workflow.
- `edit_office` edits a validated temporary copy. A pre-existing source defaults
  to a collision-safe `-edited` output; only files already produced by the
  conversation may be refined at the same path.
- File-bearing edit properties are sandboxed before OfficeCLI runs. Local paths
  outside the workspace/attachment roots and URI-based media sources are
  rejected.
- PDF inputs are limited to 128 MiB and 2,000 pages; PDF rendering is capped at
  4,096 pixels per dimension and roughly 8 million pixels total.

## Deterministic checks

Run from the repository root:

```bash
npm run test:js -- test/main/model/core-agent/office-tools.test.ts test/main/model/core-agent/pdf-tools.test.ts test/main/model/core-agent/office-batch.test.ts test/main/model/core-agent/office-arg.test.ts test/main/features/office/office_engine.test.ts
npm run test:office-artifacts
```

## Real Binary Smoke

`npm run test:office-artifacts` automates steps 1-6, verifies real HTML-path
PNG renders, and generates the seven production-evaluation input fixtures on
the current macOS/Windows host. It checks every fixture source hash before
cleanup. It is a required cross-platform CI gate. Set
`ORKAS_KEEP_OFFICE_SMOKE_ARTIFACTS=1` to retain successful output for manual
visual review.

Use a temporary directory and the current-platform binary.

1. Confirm `--version` matches the pin.
2. Create one Chinese DOCX, XLSX, and PPTX through `create` plus a batch file.
3. Read each through `view text` or `view outline` and confirm Chinese text and element paths.
4. Run a successful multi-operation batch and confirm every change.
5. Run a batch containing one invalid operation and confirm v1.0.139 atomic rollback leaves the file byte-identical.
6. Run `validate` and `view issues --json` on every output.
7. Render representative pages/slides with `view ... screenshot`; inspect for missing CJK glyphs, clipping, and obvious overlap.
8. Seed the reviewed DOCX, identifier CSV, XLSM boundary package, reviewed
   PPTX, mixed-delivery CSV, WPS boundary file, and four-page PDF used by
   Production E2E; verify that integrity inspection leaves every source
   byte-identical.
9. Repeat the artifact and render checks on macOS and Windows before a release that changes the OfficeCLI pin.

Do not use a successful process exit as the only delivery signal. Preserve validation/issue output and visually inspect the rendered image.

## Source-Safety And Fault Cases

The focused Office tool suite must prove all of the following independently:

1. Editing a pre-existing DOCX/XLSX/PPTX leaves its bytes unchanged and emits a
   separately validated working copy.
2. An explicit source-equals-output request fails before OfficeCLI runs.
3. Batch failure or post-edit validation failure leaves no partial working copy
   and does not register an output.
4. A conversation-produced artifact can still be refined at its path, but the
   edit is built and validated in a temporary file before atomic replacement.
5. Sandboxed image paths are normalized; out-of-scope paths, URI media sources,
   and active link schemes are rejected before editing.
6. Invalid OpenXML is a fatal `office_review` structural result while warning-only issue
   findings remain publishable with disclosure.
7. Successful create results report logical paragraphs, cells, or slides from
   the caller input; extra batch operations for styles, shapes, charts, tables,
   or pictures never inflate those user-visible counts.

## PDF Smoke

1. Create two PDFs and merge them in the requested order.
2. Extract, delete, reorder, and rotate 1-based pages; verify page dimensions/order from the saved files.
3. Add a Chinese watermark and a PNG overlay without modifying the source.
4. Fill text and checkbox form fields.
5. Render every changed page through `pdf_render` and inspect for missing CJK glyphs, clipping, wrong rotation, and misplaced overlays.
6. Confirm source-overwrite and delete-all-pages requests fail without changing the input.
7. Confirm a sparse file over 128 MiB and a PDF over 2,000 pages fail without an
   output, and a pathological square page is reduced below both render budgets.

### Ambiguous resident delivery during creation

Create a workbook while a fault fixture applies its first batch but loses the reply. One bounded recovery must close the old resident and recreate in a new private path before applying the batch. Verify exactly one sheet/content change, one final write event, and cleanup. If recovery fails or is cancelled, preserve any prior owned final file and publish nothing. Ordinary batch validation errors and edits to existing files must not acquire retries. `office-tools.test.ts` covers these outcomes; `test:office-artifacts` checks native charts, readback, source preservation and atomic rollback with the pinned CLI.
