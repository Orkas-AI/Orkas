---
name: material-organizer
description_zh: "整理用户已提供的链接、PDF、Word、图片、文本片段或本地目录，做要点提取、来源溯源、知识卡沉淀、实体关系、去重归类、异常记录和关键词索引；适合\"整理这些链接\"\"把这些资料整理成研究笔记\"\"从这段内容提取知识卡\"\"帮我整理下载目录\"；触发词：资料整理、批量整理、研究笔记、知识卡、个人知识流、实体关系、关键词索引、目录整理"
description_en: "Organize user-provided URLs, PDFs, Word documents, images, text snippets, or local folders with extraction, source tracing, knowledge cards, entity links, deduplication, classification, exception logs, and keyword indexes; For: \"organize these links\", \"turn these materials into research notes\", \"extract knowledge cards from this\", \"organize my Downloads folder\"; Triggers: material organization, research notes, knowledge cards, personal knowledge flow, entity links, keyword index, folder cleanup"
description: "Organize user-provided materials or local folders into traceable notes, knowledge cards, categories, indexes, and cleanup plans. Use this skill whenever the user asks to organize multiple links, files, snippets, research materials, downloads, personal knowledge flow materials, or a local directory."
category: "data"
---

# Material Organizer

Organize only the materials the user has already provided or explicitly pointed to. The job is to make messy inputs easier to scan, reuse, archive, or continue from later while preserving source traceability.

## When To Use

- The user provides 2 or more materials and asks to organize, extract, classify, archive, generate research notes, or produce an organizing report.
- The user provides a local directory path and asks to scan files, analyze categories, identify duplicate/abnormal files, or generate archiving suggestions.
- The user wants mixed materials converted into a searchable Markdown/HTML/table-like structure: table of contents, sources, tags, keyword index, and exception log.
- The user wants webpages, notes, meeting minutes, emails, conversations, or research fragments turned into knowledge cards, entity relationships, tags, verification gaps, and review prompts.

Do not use for:

- Close reading of one article, standalone paper reading, or broad evidence synthesis.
- Translation, writing polish, resume optimization, or course knowledge-framework design.
- Searching for new materials unless the user explicitly provides search results or links to organize.
- Writing into an external knowledge base, editing a note vault, or changing files inside a directory without a confirmed plan.

## How To Call

1. Identify the mode:
   - `content_organizing`: links, PDFs, Word files, images, text snippets, notes, or mixed source materials.
   - `knowledge_flow`: user-provided materials that should become reusable knowledge cards, entity links, source records, verification gaps, and review prompts.
   - `directory_organizing`: a local folder that needs scanning, classification, deduplication review, or cleanup planning.

2. Decide whether clarification is needed:
   - 1-5 materials: organize directly with sensible defaults and state the classification method and detail level.
   - 6-30 materials: confirm classification method, detail level, report format, and whether to save files.
   - More than 30 materials: ask the user to submit batches or split by topic/folder.

3. Extract content:
   - Use `references/extraction-rules.md` for source fields, core points, excerpts, tags, evidence levels, and exception handling.
   - Preserve filenames, URLs, source titles, authors/organizations, dates, and access issues.
   - Mark unreadable or low-confidence inputs instead of filling gaps.

4. Build knowledge cards when needed:
   - Use `references/knowledge-flow.md` when the user asks for knowledge-base notes, personal knowledge flow, knowledge cards, entity relationships, review prompts, or reusable long-term notes.
   - Keep each knowledge card traceable to original material. Mark unsourced content as source not provided.
   - Suggest save locations or filenames only as recommendations unless the user has confirmed actual writing.

5. Deduplicate and classify:
   - Use `references/dedup-strategy.md` to merge duplicates only when the source relationship is clear.
   - Use `references/classification-rules.md`; user-specified dimensions come first.
   - Keep conflicting materials separate and log contradictions.

6. Handle directories safely:
   - First scan and report the directory. Do not move, rename, delete, or overwrite files during the first pass.
   - Use `references/directory-organizing.md` to identify type distribution, possible duplicates, sensitive files, and cleanup levels.
   - For any operation that changes files or generates an executable organizing script, show the exact plan and obtain explicit confirmation.

7. Return the report:
   - Use `references/output-schema.md`.
   - Write files only when the user explicitly requests or confirms saving.
   - If saving, return the output path and note what was not processed.

## Return Format

Content organizing report:

```markdown
**Organizing Scope**
- Material count:
- Classification method:
- Detail level:
- Processing basis:

**Extraction Overview**
- Successfully processed:
- Access failures:
- Deduplicated/merged:
- Topic categories:

**Topic Directory**
1. ...

**Entry Details**
...

**Keyword Index**
...

**Exception Log**
...
```

Knowledge flow report:

```markdown
**Knowledge Flow Scope**
- Material count:
- Processing basis:
- Intended destination:

**Knowledge Cards**
...

**Entity Links**
...

**Source Records**
...

**Verification Gaps**
...

**Review Prompts**
...
```

Directory organizing report:

```markdown
**Directory Overview**
- Path:
- File/directory count:
- Type distribution:
- Possible duplicates:
- Abnormal files:

**Suggested Classification**
...

**Cleanup Suggestions**
...

**Important Files Requiring Confirmation**
...

**Next Step**
...
```

If a material item cannot be read, preserve the source and record the exception. Do not fill missing content with guesses.

## External Dependencies

- The current environment must be able to read user-provided URLs, PDFs, Word documents, images, text, or local paths. If a file type cannot be read, ask the user to paste the text or provide the material in another format.
- Directory organizing requires read permission for the local path provided by the user.
- Generating HTML, Excel, or other file formats requires the current environment to support the corresponding file writing and format generation.
- No fixed third-party package, account, database, long-term memory, or background service is required.

## Limits And Known Issues

- Do not proactively search for new materials; organize only the inputs already provided by the user.
- Do not save files by default, move files by default, or delete duplicate files by default.
- Do not treat a directory report as permission to execute cleanup.
- OCR, scanned PDFs, and complex chart recognition may be unstable; low-confidence content must be marked and confirmed with the user.
- Paywalls, login pages, anti-scraping pages, or damaged files can only be recorded as exceptions; do not invent content.
- Excerpts must come from the original text. Numbers, dates, percentages, and author information must match the source.
- Before organizing a directory by execution, present a plan first. High-risk files such as IDs, contracts, certificates, graduation materials, keys, and config files must be marked as requiring user confirmation.

## Full Examples

User:

```text
Organize these 6 AI tool links, classify them automatically, and output Markdown.
```

Handling:

```markdown
**Organizing Scope**
- Material count: 6
- Classification method: automatic clustering
- Detail level: detailed
- Save file: not confirmed; output in the conversation first

**Extraction Overview**
- Successfully processed: 5
- Access failures: 1
- Deduplicated/merged: 1
- Topic categories: 2

**Topic Directory**
1. AI writing and content generation tools
2. AI coding assistant tools

...
```

User:

```text
Help me organize ~/Downloads. Do not move files yet; only generate a report.
```

Handling:

```markdown
**Directory Overview**
- Path: ~/Downloads
- File/directory count: ...
- Type distribution: ...

**Suggested Classification**
- Documents
- Images
- Archives
- Installers
- Projects

**Next Step**
- You can save the report, generate an organizing script, or continue refining a specific subdirectory.
```
