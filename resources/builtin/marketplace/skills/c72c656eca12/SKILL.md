---
name: office-word
description_zh: 使用内置 Office 工具创建、读取、编辑和检查 Word / DOCX 文档，重点保护样式、编号、修订、批注、字段、表格、分节和页眉页脚。适合“做一份 Word 报告”“修改这份 DOCX 并保留格式”“检查长文档编号和版式”；触发词：Word、DOCX、文档、修订、批注、字段、模板、排版、编号、页眉页脚
description_en: Use the built-in Office tools to create, read, edit, and check Word/DOCX documents while protecting styles, numbering, revisions, comments, fields, tables, sections, headers, and footers. Use for Word reports, DOCX edits, redlines, comments, templates, numbering cleanup, and layout-safe delivery.
category: office
min_app_version: 1.6.1
---

# Office Word

## Tool Route

Use the bundled Office tools as the default path. Do not install OfficeCLI or document libraries when these tools are available.

- Use `stat_file` before `read_file` for broad text inspection.
- Use `create_docx` for a new `.docx`.
- Use `office_read` to discover stable element paths before a precise edit.
- Pass the pre-existing source to `edit_office`; it creates the separate
  `-edited` working copy automatically. Never copy or edit the user's only
  source yourself.
- Run `office_check` after every create or edit, then use `office_render` on representative pages when layout matters.

The built-in engine supports `.docx`, not legacy `.doc`. Require conversion before editing a legacy file. Do not execute macros or embedded code.

`edit_office.operations` accepts only `set`, `add`, and `remove`. For a
path-targeted text replacement, use this exact shape after `office_read`:

```json
{
  "path": "contract-reviewed.docx",
  "operations": [
    {
      "action": "set",
      "path": "/body/p[2]",
      "props": {
        "find": "旧辰科技有限公司",
        "replace": "星河科技有限公司"
      }
    }
  ]
}
```

Do not invent a `replace` action, an `edits` field, or top-level `find` /
`replace` fields. Omit `output_path` when the automatic `-edited` name is
acceptable.

## Preservation Rules

1. Inspect styles, numbering, relationships, sections, headers/footers, fields, comments, and revisions before editing an existing document.
2. Change the smallest safe element. Preserve bookmarks, comment anchors, revision blocks, numbering definitions, fields, section settings, and relationship files unless the user requests otherwise.
3. For new documents, use named heading/body styles and explicit page size, margins, table widths, and section settings.
   For documents containing CJK text, explicitly name CJK-capable fonts for those styles; do not rely on an unspecified “Chinese font” or renderer fallback.
4. Treat tracked changes, comments, fields, and complex layout as fidelity-sensitive. If the exposed tool contract cannot express the requested operation safely, report the limitation instead of falling back to an unreviewed package or raw XML rewrite.

## Delivery Check

Check content completeness, schema/issue results, numbering stability, stale fields, revision/comment integrity, headers/footers, table overflow, pagination, fonts, and the final output path. A rendered preview is evidence for visible layout, not proof of identical behavior in every Word or WPS version.

Return the final `.docx` path, the untouched source or backup path, a short change summary, checks performed, and any target-application review still required.
