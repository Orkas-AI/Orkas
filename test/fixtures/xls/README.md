# Legacy workbook fixture

`inventory.xls` is a real BIFF8/CFB workbook generated for this repository with
xlwt 1.3.0 (fixture authoring only, not installed or bundled with Orkas).
It contains two sheets: a Chinese equipment inventory with a text identifier
`00123`, quantity 7 and date 2026-09-18; a sparse fifth row with 12.5 and TRUE;
and a Summary sheet with a searchable sentinel, literal script-like cell text,
zero and -42. No private production data or macros are included.

The checked-in binary is the test input. Tests require only the production
xlrd reader and bundled Python, not the writer.
