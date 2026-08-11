---
name: pdf-editing
description_zh: 使用内置 PDF 工具读取、OCR、创建和编辑 PDF，支持合并、提取、删除、重排、旋转页面，添加中文水印、文字或图片覆盖层，填写表单并逐页渲染检查。适合“合并这些 PDF”“删除第 3 页”“加中文水印”“填写 PDF 表单”“修改后检查页面”；触发词：PDF、编辑PDF、合并PDF、拆分PDF、旋转页面、水印、表单、PDF检查
description_en: Use the built-in PDF tools to read, OCR, create, and edit PDFs, including merge, extract, delete, reorder, and rotate pages; add CJK watermarks, text or image overlays; fill forms; and render changed pages for review. Use for PDF editing, page operations, watermarks, forms, OCR, and delivery QA.
category: office
min_app_version: 1.6.1
---

# PDF Editing

## Tool Route

Use the bundled tools; do not install `nano-pdf`, pypdf, qpdf, Poppler, or another PDF package during a task.

- Call `stat_file` before `read_file` for a normal PDF.
- Use `ocr_file` only for scanned or image-only pages whose text cannot be extracted.
- Use `markdown_to_pdf` for a text-first new PDF and `html_to_pdf` for tables or custom layout.
- Use `edit_pdf` for deterministic edits to an existing PDF: merge, extract, delete, reorder, rotate, watermark, visible text/image overlay, and form filling.
- Use `pdf_render` on every changed page and representative unchanged pages before delivery.
- Every `edit_pdf` output is a new path. Call `stat_file` on that new output
  before any `read_file`; do not launch a first read of the output in parallel
  with its initial stat.

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
watermark placement, form values, extracted/OCR text, output path, and source
preservation. For a watermark or overlay, explicitly confirm from the rendered
pages that it is legible, positioned as intended, and not clipped. Return the
final PDF path, untouched source path, actions performed, pages affected, and
any remaining viewer-specific review.
