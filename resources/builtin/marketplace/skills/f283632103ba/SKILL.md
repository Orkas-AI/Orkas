---
name: office-ppt
description_zh: 使用内置 Office 工具创建、读取、轻量编辑和检查 PowerPoint / PPTX 演示文稿，覆盖结构、文本、备注、模板残留、图片、表格和可见版式。适合“检查 PPT 模板残留”“替换公司名”“修改备注”“生成一份简单 PPTX”；触发词：PPT、PPTX、PowerPoint、幻灯片、占位符、模板、备注、deck、演示文稿
description_en: Use the built-in Office tools to create, read, lightly edit, and check PowerPoint/PPTX presentations, including structure, text, notes, template residue, images, tables, and visible layout. Use for existing-deck QA, safe small edits, and straightforward PPTX creation.
category: office
min_app_version: 1.6.1
---

# Office PowerPoint

## Tool Route

Use the bundled Office tools as the default path. Do not install OfficeCLI or `python-pptx` when these tools are available.

- Use `stat_file` before `read_file` for broad content inspection.
- Use `create_pptx` for a straightforward new deck. Route a high-design presentation or full narrative strategy to the presentation-making workflow.
- Use `office_read` with `outline`, `get`, or `query` to identify slides and shapes before editing.
- Pass the pre-existing source directly to `edit_office`; it creates the
  separate working copy. Use `output_path` in that one edit call when a
  human-facing final name is desired.
- Run `office_check` after every create or edit, then use `office_render` on every changed slide and representative unchanged slides.

The built-in engine supports `.pptx`, not legacy `.ppt`. Require conversion before editing a legacy file.

`edit_office.operations` accepts only `set`, `add`, and `remove`. After
`office_read` returns the exact stale shape path, remove it with this shape:

```json
{
  "path": "annual-review.pptx",
  "output_path": "annual-review-cleaned.pptx",
  "operations": [
    {
      "action": "remove",
      "path": "/slide[4]/shape[3]"
    }
  ]
}
```

Do not create the automatic `-edited` output and then copy or rename it with
`bash`, `write_file`, or another file tool. One requested final deck means one
new PPTX in the workspace and one published PPTX path.

## Preservation Rules

1. Inspect slide order, layouts, placeholders, masters, theme fonts/colors, notes, comments, charts, media, and transitions before editing an existing deck.
2. Prefer stable element paths returned by `office_read`; do not guess shape indices when a stable id or name is available.
3. Preserve masters, layouts, relationships, notes, animations, media, and embedded data unless the user explicitly asks to change them.
4. Treat global replacement as high impact. Use a precise target whenever possible and verify every changed slide.
5. If the exposed tools cannot safely express a master, animation, embedded-object, or complex chart edit, report the limitation rather than silently flattening it.

## Delivery Check

Check structure, issue output, template residue, slide text, notes, fonts, contrast, overflow, image quality, changed-slide renders, and the final path. A PNG preview does not prove animation, media playback, or exact PowerPoint/WPS fidelity.

Return the final `.pptx` path, the untouched source or backup path, changed slides, checks performed, and any target-viewer review still required.
