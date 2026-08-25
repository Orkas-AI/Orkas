---
name: office-ppt
description_zh: "创建、读取、轻量编辑和检查 PowerPoint/PPTX 演示文稿，覆盖结构、文本、备注、模板残留、图片、表格和可见版式；用于已有演示的质量检查、安全小改和简单 PPTX 创建。"
description_en: "Create, read, lightly edit, and check PowerPoint/PPTX presentations, including structure, text, notes, template residue, images, tables, and visible layout. Use for existing-deck QA, safe small edits, and straightforward PPTX creation."
---

# Office PowerPoint

## Tool Route

Use the bundled Office tools as the default path. Do not install OfficeCLI or `python-pptx` when these tools are available.

- Use `read_files` with one `paths` item for broad content inspection; use `metadata_only:true` when only prepared metadata is needed.
- Use `create_pptx` for a straightforward new deck. Route a high-design presentation or full narrative strategy to the presentation-making workflow.
- Use `office_read` with `outline`, `get`, or `query` to identify slides and shapes before editing.
- Pass the pre-existing source directly to `edit_office`; it creates the
  separate working copy. Use `output_path` in that one edit call when a
  human-facing final name is desired.
- After every create or edit, use `office_review` with `action:"check_and_render"` on every changed slide and representative unchanged slides.

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
