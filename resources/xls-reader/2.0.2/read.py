"""Read legacy XLS data offline; no macros, formula evaluation or source writes."""
import contextlib
import json
import math
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).with_name("xlrd-2.0.2-py2.py3-none-any.whl")))
import xlrd

MAX_INPUT = 50 * 1024 * 1024
MAX_OUTPUT = 16 * 1024 * 1024
MAX_CELLS = 2_000_000


def extract():
    data = sys.stdin.buffer.read(MAX_INPUT + 1)
    if len(data) > MAX_INPUT:
        return {"error": "limit"}
    sheets = []
    cells = 0
    output_bytes = 0
    with open(os.devnull, "w") as quiet, contextlib.redirect_stdout(quiet):
        with xlrd.open_workbook(file_contents=data, logfile=quiet, on_demand=True,
                                ragged_rows=True, formatting_info=False) as book:
            for index in range(book.nsheets):
                sheet = book.sheet_by_index(index)
                rows = []
                for r in range(sheet.nrows):
                    cells += sheet.row_len(r)
                    if cells > MAX_CELLS:
                        return {"error": "limit"}
                    values = []
                    for cell in sheet.row(r):
                        value = cell.value
                        if cell.ctype == xlrd.XL_CELL_DATE:
                            dt = xlrd.xldate_as_datetime(value, book.datemode)
                            value = (dt.time().isoformat() if 0 <= value < 1 else
                                     dt.date().isoformat() if dt.time().isoformat() == "00:00:00" else
                                     dt.isoformat())
                        elif cell.ctype == xlrd.XL_CELL_BOOLEAN:
                            value = "TRUE" if value else "FALSE"
                        elif cell.ctype == xlrd.XL_CELL_ERROR:
                            value = xlrd.error_text_from_code.get(value, "#ERROR!")
                        elif cell.ctype == xlrd.XL_CELL_NUMBER:
                            if not math.isfinite(value):
                                return {"error": "format"}
                            value = format(value, ".15g")
                        value = str(value)
                        # Include JSON escaping/structure in the bound before buffering.
                        output_bytes += len(json.dumps(value, ensure_ascii=False).encode("utf-8")) + 4
                        if output_bytes > MAX_OUTPUT - 65536:
                            return {"error": "limit"}
                        values.append(value)
                    if any(value for value in values):
                        rows.append({"number": r + 1, "values": values})
                sheets.append({"name": sheet.name, "rows": rows})
                book.unload_sheet(index)
    return {"sheets": sheets}


try:
    result = extract()
except Exception as error:
    # Never return parser diagnostics containing document data or host paths.
    result = {"error": "encrypted" if isinstance(error, xlrd.XLRDError)
              and "encrypt" in str(error).lower() else "format"}
payload = json.dumps(result, ensure_ascii=False).encode("utf-8")
sys.stdout.buffer.write(payload if len(payload) <= MAX_OUTPUT else b'{"error":"limit"}')
