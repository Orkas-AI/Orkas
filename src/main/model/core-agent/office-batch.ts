/**
 * Pure builders that translate structured tool input into OfficeCLI `batch`
 * command arrays. Kept dependency-free so they are unit-testable without
 * dragging in the heavy tool/feature graph. The array is serialized to JSON
 * and piped to `officecli batch <file>` over stdin (one open/save cycle).
 *
 * Op shapes are exactly what `officecli` consumes (verified via `dump` and live
 * runs against v1.0.131):
 *   - docx / pptx body content → `add` ops: {command,parent,type,props}
 *   - xlsx cells               → `set` ops: {command,path,props}
 */

export type OfficeBatchOp =
  | { command: 'add'; parent: string; type: string; props: Record<string, string> }
  | { command: 'set'; path: string; props: Record<string, string> }
  | { command: 'remove'; path: string };

/**
 * Copy every key of `src` not in `skip` into `props`, coercing the value to
 * OfficeCLI's on-the-wire string form: drops null / undefined / '' (an empty
 * value is never meaningful at create time), bools → "true"/"false", numbers →
 * decimal string, and a leading '=' on `formula` is stripped (OfficeCLI wants
 * it without). A key already present in `props` is left untouched, so the
 * structural fields each builder sets explicitly win over a passthrough of the
 * same name. This is what lets `create_*` reach the engine's full property
 * surface (fill / color / font / size / borders / shape geometry …) instead of
 * the narrow placeholder subset the structural fields cover.
 */
function addPassthrough(
  props: Record<string, string>,
  src: Record<string, unknown>,
  skip: ReadonlySet<string>,
): void {
  for (const [k, v] of Object.entries(src)) {
    if (skip.has(k) || k in props) continue;
    if (v === null || v === undefined || v === '') continue;
    props[k] = k === 'formula' ? String(v).replace(/^=/, '') : String(v);
  }
}

/** A shared empty skip-set: pass every key straight through. Used where a spec
 *  has no structural fields of its own — shapes, pictures, columns. */
const PASS_ALL: ReadonlySet<string> = new Set();

/** Dimensions of a cell grid: row count + the widest row's column count.
 *  Non-array rows count as empty (0 columns). */
function gridDims(rows: readonly unknown[]): { rowCount: number; colCount: number } {
  let colCount = 0;
  for (const row of rows) if (Array.isArray(row) && row.length > colCount) colCount = row.length;
  return { rowCount: rows.length, colCount };
}

// ── Word ────────────────────────────────────────────────────────────────

/** One body paragraph for a Word document. Beyond the structural fields, any
 *  extra key is passed straight through to OfficeCLI's `add p` as a
 *  run/paragraph property (`bold`, `italic`, `font`, `size`, `color`,
 *  `underline`, `highlight`, …), so styled text is expressible at create time. */
export type DocxParagraphSpec = {
  /** Paragraph text. Required; entries without a string `text` are dropped. */
  text: string;
  /** Paragraph style id, e.g. `Heading1`, `Heading2`, `Normal`, `Quote`. */
  style?: string;
  /** Horizontal alignment. */
  align?: 'left' | 'center' | 'right' | 'justify';
  /** Turn the paragraph into a list item. */
  list?: 'bullet' | 'ordered';
  /** Passthrough OfficeCLI run/paragraph props (bold, font, size, color, …). */
  [key: string]: unknown;
};

/** Structural docx keys handled explicitly below — excluded from passthrough so
 *  `list` (→ `listStyle`) isn't also forwarded verbatim. */
const DOCX_STRUCTURAL = new Set(['text', 'style', 'align', 'list']);

/** A docx body table: a grid of cell text plus optional table props. `rows` is
 *  a grid of cells; any extra key (`colWidths`, `align`, `layout`, …) is passed
 *  through to OfficeCLI's `add table`. */
export type DocxTableSpec = {
  rows: readonly (readonly (string | number | null | undefined)[])[];
  colWidths?: string;
  [key: string]: unknown;
};

/** A docx body image. `src` is the file path (the tool layer resolves it to an
 *  absolute, sandbox-checked path before this runs); `align` styles the host
 *  paragraph, every other key (`width`, `height`, `crop`, …) goes to the
 *  picture. */
export type DocxImageSpec = {
  src: string;
  width?: string | number;
  height?: string | number;
  align?: string;
  [key: string]: unknown;
};

/** `rows` is the grid (not the engine's int `rows` prop) and `align` lands on
 *  the host paragraph — both excluded from the respective passthrough. */
const DOCX_TABLE_STRUCTURAL = new Set(['rows']);
const DOCX_IMAGE_STRUCTURAL = new Set(['src', 'align']);

/**
 * Build the `batch` ops for a docx body, in order: `paragraphs`, then `tables`,
 * then `images`. Non-object entries and paragraphs without a string `text` are
 * skipped (the LLM occasionally emits a stray null / wrong-typed item). `align`
 * maps to the paragraph `align` prop and `list` to `listStyle`; every other
 * paragraph key is passed through as a run/paragraph style prop.
 *
 * A table emits `add table {rows,cols}` then one `set` per non-empty cell at
 * `/body/table[K]/tr[i]/tc[j]/p[1]` (K = 1-based table index — `table[N]` counts
 * only tables). An image emits a host `add p` then `add picture` under it; the
 * paragraph index is tracked across paragraphs + image hosts (a fresh docx has
 * zero body paragraphs, and `p[N]` counts only paragraphs, so tables in between
 * don't shift it).
 */
export function buildDocxBatch(
  paragraphs: readonly DocxParagraphSpec[],
  tables: readonly DocxTableSpec[] = [],
  images: readonly DocxImageSpec[] = [],
): OfficeBatchOp[] {
  const ops: OfficeBatchOp[] = [];
  let paraCount = 0;
  let tableCount = 0;

  for (const p of paragraphs) {
    if (!p || typeof p.text !== 'string') continue;
    const props: Record<string, string> = { text: p.text };
    if (typeof p.style === 'string' && p.style) props.style = p.style;
    if (typeof p.align === 'string' && p.align) props.align = p.align;
    if (p.list === 'bullet' || p.list === 'ordered') props.listStyle = p.list;
    addPassthrough(props, p, DOCX_STRUCTURAL);
    ops.push({ command: 'add', parent: '/body', type: 'p', props });
    paraCount += 1;
  }

  for (const t of tables) {
    if (!t || !Array.isArray(t.rows)) continue;
    const { rowCount, colCount } = gridDims(t.rows);
    if (!rowCount || !colCount) continue;
    const tProps: Record<string, string> = { rows: String(rowCount), cols: String(colCount) };
    addPassthrough(tProps, t, DOCX_TABLE_STRUCTURAL);
    ops.push({ command: 'add', parent: '/body', type: 'table', props: tProps });
    tableCount += 1;
    t.rows.forEach((row, i) => {
      if (!Array.isArray(row)) return;
      row.forEach((cell, j) => {
        if (cell === null || cell === undefined || cell === '') return;
        ops.push({ command: 'set', path: `/body/table[${tableCount}]/tr[${i + 1}]/tc[${j + 1}]/p[1]`, props: { text: String(cell) } });
      });
    });
  }

  for (const img of images) {
    if (!img || typeof img.src !== 'string' || !img.src) continue;
    const hostProps: Record<string, string> = {};
    if (typeof img.align === 'string' && img.align) hostProps.align = img.align;
    ops.push({ command: 'add', parent: '/body', type: 'p', props: hostProps });
    paraCount += 1;
    const picProps: Record<string, string> = { src: img.src };
    addPassthrough(picProps, img, DOCX_IMAGE_STRUCTURAL);
    ops.push({ command: 'add', parent: `/body/p[${paraCount}]`, type: 'picture', props: picProps });
  }

  return ops;
}

// ── Excel ───────────────────────────────────────────────────────────────

/** A spreadsheet cell: a bare value, or an object for formulas / formatting.
 *  The object form passes any extra key straight through to OfficeCLI's cell
 *  `set` (`fill`, `font.color`, `font.size`, `italic`, `underline`, `halign`,
 *  `valign`, `wrap`, `border`, `merge`, …), so styled cells are expressible at
 *  create time. */
export type XlsxCell =
  | string
  | number
  | { value?: string | number; formula?: string; format?: string; bold?: boolean; [key: string]: unknown };

/** Structural xlsx cell keys handled explicitly below — excluded from
 *  passthrough (`format` → `numberformat`). */
const XLSX_STRUCTURAL = new Set(['value', 'formula', 'format', 'bold']);

/** 0-based column index → Excel column letters (0→A, 25→Z, 26→AA). */
export function columnLetter(index: number): string {
  let s = '';
  let n = index;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/**
 * Build `set` ops writing `rows` into `sheet`, addressing cells by their A1
 * position (row 0 col 0 → A1). Empty cells (null / undefined / '') are skipped
 * so a ragged grid leaves gaps rather than blanking cells. A `formula` wins
 * over `value`; a leading `=` on the formula is stripped (OfficeCLI wants it
 * without).
 */
export function buildXlsxBatch(sheet: string, rows: readonly (readonly XlsxCell[])[]): OfficeBatchOp[] {
  const ops: OfficeBatchOp[] = [];
  rows.forEach((row, r) => {
    if (!Array.isArray(row)) return;
    row.forEach((cell, c) => {
      if (cell === null || cell === undefined || cell === '') return;
      const props: Record<string, string> = {};
      if (typeof cell === 'object') {
        if (typeof cell.formula === 'string' && cell.formula) {
          props.formula = cell.formula.replace(/^=/, '');
        } else if (cell.value !== undefined && cell.value !== null && cell.value !== '') {
          props.value = String(cell.value);
        }
        if (typeof cell.format === 'string' && cell.format) props.numberformat = cell.format;
        if (cell.bold) props.bold = 'true';
        addPassthrough(props, cell, XLSX_STRUCTURAL);
      } else {
        props.value = String(cell);
      }
      if (!Object.keys(props).length) return;
      ops.push({ command: 'set', path: `/${sheet}/${columnLetter(c)}${r + 1}`, props });
    });
  });
  return ops;
}

/** One column's width/visibility. `name` is the column letter (e.g. "A"); any
 *  extra key is passed through to `add column`. */
export type XlsxColumnSpec = { name?: string; width?: string | number; hidden?: boolean; [key: string]: unknown };

/** One worksheet: a tab `name`, its cell `rows`, and optional `columns` widths. */
export type XlsxSheetSpec = {
  name?: string;
  rows?: readonly (readonly XlsxCell[])[];
  columns?: readonly XlsxColumnSpec[];
};

/**
 * Build the `batch` ops for a multi-sheet workbook. A freshly created xlsx has
 * exactly one sheet, `Sheet1`; the first spec reuses it (renamed via `set` when
 * its `name` differs), and each later spec is `add`ed. Per sheet: column widths
 * first (`add column`), then cells (delegated to `buildXlsxBatch`, which targets
 * `/<name>/A1`). Renames are emitted before any write so the new tab name
 * resolves.
 */
export function buildXlsxWorkbookBatch(sheets: readonly XlsxSheetSpec[]): OfficeBatchOp[] {
  const ops: OfficeBatchOp[] = [];
  sheets.forEach((sheet, idx) => {
    if (!sheet || typeof sheet !== 'object') return;
    const name = typeof sheet.name === 'string' && sheet.name ? sheet.name : (idx === 0 ? 'Sheet1' : `Sheet${idx + 1}`);
    if (idx === 0) {
      if (name !== 'Sheet1') ops.push({ command: 'set', path: '/Sheet1', props: { name } });
    } else {
      ops.push({ command: 'add', parent: '/', type: 'sheet', props: { name } });
    }
    if (Array.isArray(sheet.columns)) {
      for (const col of sheet.columns) {
        if (!col || typeof col !== 'object') continue;
        const colProps: Record<string, string> = {};
        addPassthrough(colProps, col, PASS_ALL);
        if (!colProps.name) continue; // a column add needs at least its letter
        ops.push({ command: 'add', parent: `/${name}`, type: 'column', props: colProps });
      }
    }
    if (Array.isArray(sheet.rows)) ops.push(...buildXlsxBatch(name, sheet.rows));
  });
  return ops;
}

// ── PowerPoint ────────────────────────────────────────────────────────────

/** A free-positioned shape (text box) on a slide. `x`/`y`/`width`/`height` take
 *  OfficeCLI length units (e.g. "1in", "2.5cm", "120pt"). Every key is passed
 *  through to `add shape` — position plus style (`text`, `fill`, `color`,
 *  `size`, `bold`, `align`, `font`, `geometry`, `opacity`, …) — so a designed
 *  slide is expressible at create time. */
export type PptxShapeSpec = {
  text?: string;
  x?: string | number;
  y?: string | number;
  width?: string | number;
  height?: string | number;
  fill?: string;
  color?: string;
  [key: string]: unknown;
};

/** A picture on a slide. `src` is the file path (the tool layer resolves it to
 *  an absolute, sandbox-checked path first); position via `x`/`y`/`width`/
 *  `height`. */
export type PptxImageSpec = {
  src?: string;
  x?: string | number;
  y?: string | number;
  width?: string | number;
  height?: string | number;
  [key: string]: unknown;
};

/** A table on a slide: a grid of cell text plus optional position / props.
 *  `rows` is the grid; extra keys (`x`, `y`, `width`, `colWidths`, `firstRow`,
 *  …) pass through to `add table`. */
export type PptxTableSpec = {
  rows: readonly (readonly (string | number | null | undefined)[])[];
  x?: string | number;
  y?: string | number;
  [key: string]: unknown;
};

/** One slide. `title`/`body` auto-emit the title/body placeholder shapes;
 *  `shapes` add free-positioned text boxes; `images`/`tables` add pictures and
 *  grids; `background`/`transition` style the slide itself. */
export type PptxSlideSpec = {
  title?: string;
  body?: string;
  layout?: string;
  background?: string;
  transition?: string;
  shapes?: PptxShapeSpec[];
  images?: PptxImageSpec[];
  tables?: PptxTableSpec[];
};

/** `rows` is the grid (not the engine's int `rows` prop) — excluded from a
 *  table's passthrough. */
const PPTX_TABLE_STRUCTURAL = new Set(['rows']);

/**
 * Build `add slide` ops, in order, each optionally followed by `add shape`
 * (text boxes), `add picture`, and `add table` ops. A slide with no fields still
 * produces a blank slide. `body` maps to OfficeCLI's `text` prop (newlines
 * become separate body lines); `background`/`transition` style the slide.
 * Shapes/pictures/tables are added under `/slide[N]` where N is the slide's
 * 1-based position (OfficeCLI numbers slides from 1 in add-order). A table emits
 * `add table {rows,cols}` then one `set` per non-empty cell at
 * `/slide[N]/table[K]/tr[i]/tc[j]` (K = 1-based table index on that slide;
 * pptx table cells hold text directly, with no `/p[1]`). Shapes/pictures that
 * coerce to no props are skipped.
 */
export function buildPptxBatch(slides: readonly PptxSlideSpec[]): OfficeBatchOp[] {
  const ops: OfficeBatchOp[] = [];
  let slideNo = 0;
  for (const s of slides) {
    if (!s || typeof s !== 'object') continue;
    slideNo += 1;
    const props: Record<string, string> = {};
    if (typeof s.title === 'string' && s.title) props.title = s.title;
    if (typeof s.body === 'string' && s.body) props.text = s.body;
    if (typeof s.layout === 'string' && s.layout) props.layout = s.layout;
    if (typeof s.background === 'string' && s.background) props.background = s.background;
    if (typeof s.transition === 'string' && s.transition) props.transition = s.transition;
    ops.push({ command: 'add', parent: '/', type: 'slide', props });

    if (Array.isArray(s.shapes)) {
      for (const shape of s.shapes) {
        if (!shape || typeof shape !== 'object') continue;
        const shapeProps: Record<string, string> = {};
        addPassthrough(shapeProps, shape, PASS_ALL);
        if (!Object.keys(shapeProps).length) continue;
        ops.push({ command: 'add', parent: `/slide[${slideNo}]`, type: 'shape', props: shapeProps });
      }
    }

    if (Array.isArray(s.images)) {
      for (const img of s.images) {
        if (!img || typeof img !== 'object') continue;
        const picProps: Record<string, string> = {};
        addPassthrough(picProps, img, PASS_ALL);
        if (!picProps.src) continue; // a picture needs a source path
        ops.push({ command: 'add', parent: `/slide[${slideNo}]`, type: 'picture', props: picProps });
      }
    }

    if (Array.isArray(s.tables)) {
      let tableNo = 0;
      for (const t of s.tables) {
        if (!t || !Array.isArray(t.rows)) continue;
        const { rowCount, colCount } = gridDims(t.rows);
        if (!rowCount || !colCount) continue;
        const tProps: Record<string, string> = { rows: String(rowCount), cols: String(colCount) };
        addPassthrough(tProps, t, PPTX_TABLE_STRUCTURAL);
        ops.push({ command: 'add', parent: `/slide[${slideNo}]`, type: 'table', props: tProps });
        tableNo += 1;
        t.rows.forEach((row, i) => {
          if (!Array.isArray(row)) return;
          row.forEach((cell, j) => {
            if (cell === null || cell === undefined || cell === '') return;
            ops.push({ command: 'set', path: `/slide[${slideNo}]/table[${tableNo}]/tr[${i + 1}]/tc[${j + 1}]`, props: { text: String(cell) } });
          });
        });
      }
    }
  }
  return ops;
}

// ── In-place edit (any format) ──────────────────────────────────────────────

/** A single in-place edit on an existing document. `set`/`remove` target an
 *  element by `path` (from `office_read`); `add` inserts under `parent`. */
export type EditOp =
  | { action: 'set'; path: string; props?: Record<string, unknown> }
  | { action: 'add'; parent: string; type: string; props?: Record<string, unknown> }
  | { action: 'remove'; path: string };

/** OfficeCLI props are all strings on the wire. Coerce, dropping null/undefined.
 *  A `formula` value's leading `=` is stripped (OfficeCLI wants it without) so a
 *  model that includes the `=` out of habit still works. */
function normProps(props?: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  if (props && typeof props === 'object') {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined) continue;
      const s = String(v);
      out[k] = k === 'formula' ? s.replace(/^=/, '') : s;
    }
  }
  return out;
}

/**
 * Translate high-level edit operations into OfficeCLI `batch` ops. Malformed
 * entries (missing path/parent/type, unknown action) are dropped so one bad
 * item from the model doesn't abort the whole edit at build time — the caller
 * runs the batch with `--stop-on-error` to surface per-op engine failures.
 */
export function buildEditBatch(ops: readonly EditOp[]): OfficeBatchOp[] {
  const out: OfficeBatchOp[] = [];
  for (const op of ops) {
    if (!op || typeof op !== 'object') continue;
    if (op.action === 'set' && typeof op.path === 'string' && op.path) {
      out.push({ command: 'set', path: op.path, props: normProps(op.props) });
    } else if (op.action === 'add' && typeof op.parent === 'string' && op.parent && typeof op.type === 'string' && op.type) {
      out.push({ command: 'add', parent: op.parent, type: op.type, props: normProps(op.props) });
    } else if (op.action === 'remove' && typeof op.path === 'string' && op.path) {
      out.push({ command: 'remove', path: op.path });
    }
  }
  return out;
}
