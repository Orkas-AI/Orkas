---
name: wps
description_zh: "处理 WPS 兼容的 DOCX、XLSX、PPTX 和 PDF 交付，并检查中文字体、A4 版式、编号、打印设置和兼容风险；用于 WPS 文字、表格、演示、中文办公排版、打印和 PDF 导出。"
description_en: "Prepare WPS-compatible DOCX, XLSX, PPTX, and PDF deliverables with checks for Chinese fonts, A4 layout, numbering, print settings, and compatibility risks. Use for WPS Writer, Spreadsheets, Presentation, Chinese-office formatting, printing, and PDF export."
---

# WPS Compatibility

## Capability Boundary

Use `office-word`, `office-excel`, or `office-ppt` for the artifact-specific workflow, and apply the WPS compatibility checks in this skill.

The built-in engine directly reads, creates, edits, checks, and renders `.docx`, `.xlsx`, and `.pptx`. It does not automate the WPS desktop UI and does not directly edit proprietary `.wps`, `.et`, or `.dps` files. Require a converted modern-Office working copy for those formats, and never report a WPS GUI action or export as completed unless it was actually performed and verified.

For an attached proprietary `.wps`, `.et`, or `.dps` capability-boundary request, first call `read_files` with the actual supplied workspace path and `metadata_only:true`. If no converted modern-Office copy exists, preserve the source and give the complete user-visible boundary result with the required converted copy or target-WPS action and review needs. End with the group protocol's required capability-boundary handback. Do not request file content from the proprietary binary, publish an empty output set, search for or run shell/process conversion, create a placeholder, ask another actor to retry the unsupported edit, or claim that anything was edited or saved.

Use `create_pdf` with `source_type:"markdown"` or `source_type:"html"` for a new PDF. For a PDF derived from an Office source, prefer editing the source file and regenerating the PDF. Exact WPS export behavior still requires review in the target WPS version.

## Workflow

1. Confirm the artifact type, target WPS version/operating system when fidelity matters, and whether the deliverable is editable, print-ready, or PDF.
2. Work on a copy. Inspect the modern Office file with `office_read`, edit with `edit_office`, then call `office_review` with `action:"check_and_render"` and representative pages or slides.
3. Stabilize global settings before local formatting: page size, margins, orientation, fonts, theme/master, headers/footers, print area, and scaling.
4. Check Chinese-office conventions such as A4 layout, CJK font fallback, heading hierarchy, paragraph spacing, numbering, page breaks, tables, signatures, seals, and print pagination.
5. State every item that still requires manual confirmation in WPS, especially font substitution, formulas, charts, animations, embedded media, print layout, and PDF export.

Read the [WPS compatibility reference](references/wps-reference.md) when troubleshooting compatibility or preparing a print/PDF delivery checklist.

## Handoff

Return the final and backup paths, compatibility checks performed, export status, and the exact WPS-version checks still outstanding. Do not present a rendered OfficeCLI preview as proof of identical WPS output.
