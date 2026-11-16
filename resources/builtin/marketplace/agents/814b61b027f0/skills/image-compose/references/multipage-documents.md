# Fixed-page documents

Use this extension for a booklet or catalogue with an explicit page order. It supports 1–32 local HTML pages on one shared fixed canvas. It does not implement flowing text across pages, INDD, or print-production color management.

## Source

Start with the canonical manifest in `image-router`. For a document, replace `schema_version` with `2`, retain the root brief, canvas and art direction, set `route:"compose"` and `generation_budget.max_calls:0`, and omit both root `entry` and `raster_source`. Add:

```json
{
  "document": {
    "pages": [
      { "id": "cover", "entry": "pages/cover.html", "required_copy": ["Autumn collection"] },
      { "id": "products", "entry": "pages/products.html", "required_copy": ["Products", "$49"] }
    ],
    "page_numbers": { "start": 1 }
  }
}
```

This fragment extends the canonical manifest; it is not a complete manifest. Root `brief.required_copy` applies to every page; put page-specific words in that page's `required_copy`. Each page id is a unique stable identifier beginning with a letter, followed by letters, digits, `_` or `-`, at most 64 characters. Array order controls delivery order; keep ids when moving pages.

Each entry is a project-relative HTML file. Use the fixed-canvas viewer attributes and local-only HTML/SVG authoring contract on every page. Share styles through relative local CSS links and reuse local assets inside the document directory. Preserve existing sources and structures when revising a supplied document.

Page numbering is optional. With `page_numbers`, each page must contain a visible element with `data-image-page-number`; the host fills it at capture and export. An optional `data-image-page-count` element receives the page count. Author their placement and styling in HTML/CSS. Omit `page_numbers` when no page numbers are wanted; do not add numbering markers in that case.

## Native operations

- `project.status` or `project.inspect` without `page_id` returns the ordered page inventory, blockers and current evidence/review states. It attaches no page images.
- Select one stable `page_id` for `project.inspect`, `project.snapshot`, `project.submit_design_review` and per-page `project.export`. Snapshot attaches that page's current evidence. Inspect and review each page through the existing native workflow.
- After each page passes review, export its PNG with the same `page_id` and an explicit workspace-relative path ending in `.png`. Deliver individual PNGs when requested. The existing first-PNG rule applies per page.
- Only when the user requests PDF, call `project.export` with `format:"pdf"`, the document directory and a workspace-relative PDF output path, omitting `page_id`. This prints every currently approved page from its HTML/SVG source and merges them in manifest order. Text and supported shapes remain PDF objects; photos and some effects remain raster. A photo-only or intentional blank page is valid; it is not evidence of vector content.
- A selected-page PDF uses that page's `page_id`. PSD remains a separate verified layered-source delivery; a document manifest does not establish PSD layers.

For example, page capture uses `{"op":"project.snapshot","project_dir":"catalogue","page_id":"cover","output_path":"catalogue/previews/cover.png"}`. Whole-document delivery uses `{"op":"project.export","project_dir":"catalogue","format":"pdf","output_path":"out/catalogue.pdf"}` after current page reviews and PNG exports.

## Revisions and recovery

Edit the requested page or shared CSS, then inspect whole-document status. A page edit invalidates that page's evidence; a shared style edit invalidates every page using it. Reordering numbered pages invalidates pages whose displayed numbers change. Recapture and review affected pages; reuse still-current reviews. Old delivered versions remain on disk.

Whole-document PDF export refuses missing or stale page evidence. Cancellation, changed inputs or printing failure leaves sources, previews and reviews available and publishes no partial PDF. Inspect status, repair the cause and explicitly export again. Completed page reviews can be reused; temporary PDF pages are cleaned and printing restarts on retry. Do not claim cached-print continuation or a finished PDF before export succeeds.
