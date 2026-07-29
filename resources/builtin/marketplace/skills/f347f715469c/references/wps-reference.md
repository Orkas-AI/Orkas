# WPS Reference

## Compatibility Checklist

- Confirm target WPS version and operating system when layout fidelity matters.
- Check missing fonts before adjusting spacing. Font fallback is a common cause of pagination drift.
- Lock page size, margins, orientation, headers, footers, and print scaling before final polishing.
- For Writer documents, inspect heading styles, numbering definitions, table widths, page breaks, section breaks, comments, and revisions.
- For Spreadsheets, inspect formula compatibility, references, merged cells, filters, frozen panes, validations, charts, print area, and page breaks.
- For Presentation, inspect master/theme use, font replacement, alignment, image resolution, animations, embedded media, and PDF export.

## Troubleshooting Order

1. Work on a copy of the source file.
2. Identify whether the issue is content, style, layout, compatibility, or export.
3. Fix global settings first: page size, margins, fonts, theme, master, print settings.
4. Fix structural styles next: headings, numbering, tables, slide masters, chart ranges.
5. Fix local formatting last.
6. Export or preview only after structure is stable.

## Chinese Office Delivery Notes

- A4 is often expected unless the user says otherwise.
- Common Chinese font choices include SimSun, SimHei, Microsoft YaHei, FangSong, and KaiTi, but availability varies by system.
- Official documents often require stable title hierarchy, paragraph spacing, numbering, signatures, seals, and page breaks.
- PDF delivery should be checked for font embedding, image clarity, pagination, and clickable links when relevant.

## Safety Boundaries

- Never overwrite the only source file.
- Do not execute macros or install plugins without explicit user confirmation.
- For sensitive contracts, ID numbers, phone numbers, client names, or financial figures, avoid echoing raw data unless necessary for the task.
