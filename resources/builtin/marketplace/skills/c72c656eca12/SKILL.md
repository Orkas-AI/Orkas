---
name: office-word
description_zh: "创建、读取、编辑和检查 Word/DOCX 文档，并保护样式、编号、修订、批注、字段、表格、分节和页眉页脚；用于 Word 报告、保格式修改、红线批注、模板套用、编号清理和版式安全交付。"
description_en: "Create, read, edit, and check Word/DOCX reports and templates: preserve styles, numbering, revisions, comments, fields, tables, sections, headers, footers, and layout."
---

# Office Word

## Tool Route

Use the bundled Office tools as the default path. Do not install OfficeCLI or document libraries when these tools are available.

- Use `read_files` with one `paths` item for broad text inspection; use `metadata_only:true` when only prepared metadata is needed.
- Use `create_docx` for a new `.docx`.
- Use `office_read` to discover stable element paths before a precise edit.
- Pass the pre-existing source to `edit_office`; it creates the separate
  `-edited` working copy automatically. Never copy or edit the user's only
  source yourself.
- After every create or edit, use `office_review` with `action:"check_and_render"` on representative pages when layout matters, or `action:"check"` for structural-only validation.

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
