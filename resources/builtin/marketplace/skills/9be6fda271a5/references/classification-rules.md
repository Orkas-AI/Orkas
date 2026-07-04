# Classification Rules

## Classification Priority

1. Classification dimensions specified by the user.
2. Content type and real use.
3. Shared tags and similarity between core points.
4. Source, author, project, or time.
5. Place items in the inbox when they cannot be judged.

## User-Specified Classification

Examples:

| User Request | Classification Method |
|---|---|
| Classify by tech stack | frontend / backend / AI / database / DevOps |
| Organize by timeline | year / month / stage |
| Classify by importance | must read / reference / archive |
| Classify by project | project A / project B / shared |
| Classify by content type | tutorial / paper / tool / dataset / report |

## Automatic Clustering

When no classification method is specified:

- First merge similar entries based on tags.
- Then cluster by core points and use.
- Finally use source or time as auxiliary classification signals.

Recommended number of categories:

| Material Count | Recommended Topics |
|---:|---:|
| 1-5 | 1-2 |
| 6-15 | 2-4 |
| 16-30 | 3-6 |

If automatic classification produces more than 8 topics, merge similar topics to avoid fragmentation.

## Common Topic Dimensions

- Academic fields: computer science, economics, psychology, medicine, education.
- Content types: research reports, tutorial guides, tool resources, datasets, case studies.
- Use cases: learning materials, work references, project research, competitor analysis.
- Tech stacks: Python, JavaScript, AI/ML, cloud computing, databases.
- Timeliness: latest, classic, outdated, unknown timeliness.

## Inbox

Place entries that cannot be classified into the inbox and explain why:

```markdown
## Inbox

### [N]. Entry Title
- **Source**:
- **Suggested classification**:
- **Reason pending classification**: content too short / topic too unique / access failed / insufficient source
```
