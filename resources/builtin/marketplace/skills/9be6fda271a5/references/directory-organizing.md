# Directory Organizing

## Scan The Directory

After receiving a local directory path, read the directory overview first:

- Number of files and subdirectories.
- File type distribution.
- Total size and oversized files.
- Empty files, unfinished downloads, and temporary files.
- Duplicate naming patterns.
- Existing classification directories.
- Potentially sensitive or important files.

Do not move, delete, or rename files first.

## Initial Reply

Output first:

```markdown
**Directory Overview**
- Path:
- File/directory count:
- Type distribution:
- Initial categories:
- Possible duplicates:
- Abnormal files:

**Optional Organizing Methods**
1. Generate an organizing report only.
2. Generate an organizing script for user review before execution.
3. Organize directly, but confirm item by item before execution.
```

## Classification Dimensions

- By topic: projects, work, personal, tools, learning materials, archives.
- By file type: documents, images, videos, code, archives, installers, temporary files.
- By time: year, month, recent/old files.
- By project: based on filename prefixes, directories, README files, extensions, and content clues.

If the directory already has a structure such as `Documents`, `Images`, `Projects`, or `Archive`, prefer reusing the existing structure.

## Cleanup Suggestion Levels

- `High`: empty files, unfinished downloads, obvious duplicate copies, caches or temporary files that are safe to delete. User confirmation is still required.
- `Medium`: old installers, duplicate screenshots, outdated archives, large files suitable for archiving.
- `Low`: unclear names, vague topics, files recommended for manual confirmation.

## Important File Protection

The following files must be marked as requiring confirmation. Do not automatically move or delete them:

- Identity documents, certificates, contracts, invoices, graduation materials.
- Keys, configs, `.env`, certificate files.
- Financial, medical, legal, school, or work-sensitive files.
- User project source code, unbacked-up documents, files currently being downloaded.

## Output

The report must include:

- Statistical overview.
- Classification suggestions.
- Representative file examples.
- Duplicate/abnormal file list.
- Important files confirmation list.
- Suggested directory structure.
- Next action: save report, generate script, execute organizing, or continue refining.

## Execution Boundary

Before generating a script or directly organizing, show:

- Directories that will be created.
- Files that will be moved.
- Files that will be skipped.
- Risks and rollback suggestions.

Execute only after the user explicitly confirms.
