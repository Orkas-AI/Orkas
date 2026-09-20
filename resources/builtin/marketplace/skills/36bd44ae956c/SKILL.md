---
name: pdf-editing
description_zh: "读取、创建和编辑 PDF，包括扫描页读取、页面整理、水印与文字/图片覆盖、表单填写及交付前版式检查。"
description_en: "Read, create and edit PDFs, including scanned-page reading, page organization, watermarks, text/image overlays, form filling and layout checks."
---

# PDF Editing

## Tool Route

Use the bundled tools; do not install `nano-pdf`, pypdf, qpdf, Poppler, or another PDF package during a task.

- Call `read_files` with one `paths` item for a normal PDF; extraction is prepared in the same call.
- For scanned or image-only pages, call `pdf_render` only on needed pages and read the returned images with the current model. If it cannot read images, ask for readable text or a vision-capable model; do not install a recognition engine. Mark unreadable fields instead of guessing.
- Use `create_pdf` with `source_type:"markdown"` for a text-first new PDF or `source_type:"html"` for tables and custom layout.
- Use `edit_pdf` for deterministic edits to an existing PDF: merge, extract, delete, reorder, rotate, watermark, visible text/image overlay, and form filling.
- Use `pdf_render` on every changed page and representative unchanged pages before delivery.
- Every `edit_pdf` output is a new path. Read that new output with `read_files`;
  its first call prepares extraction before returning content.

## Editing Rules

1. Work from the user's source but always write `edit_pdf` output to a separate `.pdf`; never overwrite the only source.
2. Page numbers passed to `edit_pdf` and `pdf_render` are 1-based. Inspect page count/content before destructive page operations.
3. Use `extract_pages` to split or select pages. Use `merge` with `input_paths` in the exact desired order.
4. Treat `overlay_text` as visible annotation/replacement artwork only. It does not remove underlying text and is not secure redaction.
5. Arbitrary replacement of existing PDF text is not structurally reliable. Prefer editing the source DOCX/XLSX/PPTX and regenerating the PDF; otherwise use a disclosed visual overlay and inspect it.
6. Do not claim legal-grade redaction, digital signing, encryption, or password removal: these are not part of the current built-in contract.
7. For forms, use exact field names. Render the result and confirm values, checkboxes, and flattening behavior in a PDF viewer when fidelity matters.

## Delivery Check

Check page count and order, rotations, changed-page renders, clipping,
watermark placement, form values, extracted or visually read text, output path, and source
preservation. For a watermark or overlay, explicitly confirm from the rendered
pages that it is legible, positioned as intended, and not clipped. Return the
final PDF path, untouched source path, actions performed, pages affected, and
any remaining viewer-specific review.
