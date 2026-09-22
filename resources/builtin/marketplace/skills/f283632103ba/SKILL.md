---
name: office-ppt
description_zh: "创建简单 PowerPoint/PPTX 演示，对已有演示进行读取、安全小改和质量检查，保留结构、文本、备注及可见版式。"
description_en: "Create straightforward PowerPoint/PPTX decks, read or safely make small edits to existing presentations, and check content, notes, structure and visible layout."
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
