---
name: office-excel
description_zh: 使用内置 Office 工具创建、读取、编辑和检查 Excel / XLSX 工作簿，可靠处理公式、日期、数据类型、格式、验证规则、模板、图表和打印设置。适合“做一个 Excel 报表”“把 CSV 整理成带公式的 XLSX”“修改工作簿并保留格式”；触发词：Excel、XLSX、XLS、CSV、TSV、表格、工作簿、公式、数据验证、打印区域
description_en: Use the built-in Office tools to create, read, edit, and check Excel/XLSX workbooks while protecting formulas, dates, data types, formatting, validations, templates, charts, and print settings. Use for spreadsheet deliverables, workbook cleanup, CSV-to-XLSX conversion, formula models, and Excel-compatible reporting.
category: office
min_app_version: 1.6.1
---

# Office Excel

## Tool Route

Use the bundled Office tools as the default artifact path. Do not install OfficeCLI, pandas, or openpyxl when the built-in tools cover the task.

- Use `stat_file` before `read_file` for a broad workbook read.
- Use `create_xlsx` for a new `.xlsx`, including multiple sheets, live formulas, number formats, widths, common cell styling, and native editable charts in each sheet's `charts` array.
- Calling `create_xlsx` is mandatory for a supported new workbook. Bash or local code may prepare input rows or perform calculations that the tool cannot express, but must not construct, rewrite, or patch the final `.xlsx` package.
- Call `create_xlsx` exactly once for one requested workbook. Include the complete initial workbook and chart plan in that call. If QA finds a correction, use `office_read` and `edit_office` on the exact returned path; a file created in this conversation is refined in place. Do not restart with a second `create_xlsx`, create a “可编辑” duplicate, or publish an intermediate workbook.
- Use `office_read` to inspect sheet/cell paths before editing an existing `.xlsx` workbook.
- Use `edit_office` for `.xlsx`; it creates a separate working copy when the source was not already produced by this conversation.
- Run `office_check` after every create or edit, then use `office_render` when visible layout matters. For XLSX, first use `office_read` with `mode:"outline"` to map worksheet names to workbook order, then pass the worksheet's one-based numeric position as `office_render.page`; never pass a worksheet name or cell range as `page`.

Use existing local compute only for transformations the Office tools do not express; do not add package dependencies during a workbook task. The built-in engine supports `.xlsx`, not legacy `.xls`, macro-enabled `.xlsm` editing, or macro execution. Require conversion for `.xls`. An `.xlsm` may be attached for broad read-only inspection through `stat_file`/`read_file` only, but do not pass it to `office_read`, `edit_office`, `office_check`, or `office_render`; preserve the source, never execute its macros, and require target-Excel editing/review with macros disabled when its VBA project, external links, or signature must remain intact.

For an attached `.xlsm` capability-boundary request, first call `stat_file` on the actual supplied workspace path. Then give the complete user-visible boundary result: name the untouched source, state explicitly that no VBA or macro was executed, and require target-Excel editing plus external-link and digital-signature review. End with the group protocol's required capability-boundary handback. Do not publish outputs, convert or copy the package, run shell/process tools, create an `.xlsx` substitute, or ask another actor to retry the unsupported edit.

## Integrity Rules

1. Inspect sheet order, formulas, cached values, data types, named ranges, hidden rows/columns, merges, freezes, filters, validations, conditional formatting, charts, and print settings before editing.
2. Preserve identifiers, phone numbers, ZIP codes, account codes, leading zeros, and numbers longer than 15 digits as text when appropriate.
3. Keep derived values as formulas when the recipient must audit or update the workbook. Do not replace formulas with cached values.
4. Match an existing template's conventions and edit only the requested cells or ranges.
5. Treat external links, pivots, macros, dynamic arrays, and newer formula functions as fidelity-sensitive. If calculation or preservation cannot be verified, say so explicitly.

## Delivery Check

Check representative formulas and ranges, error cells, data/number formats, widths, wrapped labels, hidden logic, validation rules, print areas, issue output, and the final path. A clean formula evaluation does not prove business correctness; verify assumptions and sample results separately.

## Analytical Report Contract

For KPI reports, monthly reports, dashboards, or sample-driven workbooks:

- Use editable sample/source data with enough periods and categories to support the requested trend and comparison; label synthetic data clearly.
- Put a visible editable `假设与参数` block or sheet inside the workbook; at minimum include reporting period, currency/units, a sample-data label, metric definitions, and editable targets or thresholds. Make target/comparison formulas reference those cells, and never leave assumptions only in the chat handoff.
- Keep derived metrics as live formulas. Document units and denominators, and spot-check representative calculations against source rows.
- Make the summary decision-ready: show the reporting period, KPI actuals, prior-period or target comparisons, the main driver or exception, and a next action.
- Give every chart an explicit source table or named range, category field, value series, title, axis labels and units, intentional category order, and a truthful scale. Use native editable chart objects when `create_xlsx` supports them; a source table, text bar, screenshot, or “insert this chart later” instruction does not satisfy a chart request. In a tools-off specification, name these bindings before execution. Bar charts start at zero unless the exception is explained; avoid pie charts when exact comparison matters.
- Never plot measures with different units or materially different scales on the same primary axis. Prefer separate charts; otherwise use a documented combo/secondary axis and label both axes. For the ecommerce monthly-report default, a single-series sales trend plus a separate channel-sales bar chart is clearer than putting sales and order count on one axis.
- Bind time trends to a complete ordered period range and category comparisons to a clearly sorted range. After creation, use `office_read` to confirm chart nodes and source bindings, then render every chart-bearing worksheet by its one-based numeric page position.
- Complete the artifact loop with `create_xlsx` or `edit_office`, `office_check`, representative `office_render`, and `publish_outputs`, including a single final workbook. If a tool is unavailable, name the missing check instead of implying it ran.

Return the final `.xlsx` path, the untouched source or backup path, sheet structure, formula/data checks, assumptions, and any Excel/WPS recalculation or visual review still required. For every requested chart, also report its native chart type, title, category/value source ranges, axis labels/units, and scale or secondary-axis choice so delivery quality is evidenced rather than merely claimed.
