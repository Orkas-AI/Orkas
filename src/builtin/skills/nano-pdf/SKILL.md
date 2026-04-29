---
name: nano-pdf
description_zh: "用自然语言指令编辑 PDF——nano-pdf CLI 在指定页执行修改。适合\"把这份 PDF 第 3 页的标题改成 X\"\"给这个 PDF 加水印\"\"删掉某页的某段文字\"；触发词：pdf 编辑、改 pdf、nano-pdf、修改 pdf、pdf 改写、pdf 加水印"
description_en: "Edit PDFs with natural-language instructions using the nano-pdf CLI. For: 'change the heading on page 3 to X', 'add a watermark to this PDF', 'delete a paragraph on a specific page'; Triggers: pdf edit, modify pdf, nano-pdf, watermark, redact, rewrite pdf"
---

# nano-pdf

Use `nano-pdf` to apply edits to a specific page in a PDF using a natural-language instruction.

## Quick start

```bash
nano-pdf edit deck.pdf 1 "Change the title to 'Q3 Results' and fix the typo in the subtitle"
```

Notes:
- Page numbers are 0-based or 1-based depending on the tool’s version/config; if the result looks off by one, retry with the other.
- Always sanity-check the output PDF before sending it out.
