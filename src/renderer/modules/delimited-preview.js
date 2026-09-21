// Bounded RFC 4180 field parsing shared by task and Library previews. Values
// stay strings: identifiers, formulas and markup are never coerced or executed.
(function (root) {
  const MAX_ROWS = 200;
  const MAX_COLUMNS = 100;
  const MAX_CELL_CHARS = 4000;

  function parse(text, delimiter, partial = false) {
    const input = String(text || '').replace(/^\uFEFF/, '');
    const rows = [];
    let row = [], cell = '', quoted = false, closed = false;
    let limited = false, fieldStarted = false;
    const append = char => {
      if (cell.length < MAX_CELL_CHARS) cell += char;
      else limited = true;
    };
    const finishCell = () => {
      if (row.length < MAX_COLUMNS) row.push(cell);
      else limited = true;
      cell = ''; closed = false; fieldStarted = false;
    };
    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      if (quoted) {
        if (ch === '"') {
          if (input[i + 1] === '"') { append('"'); i++; }
          else { quoted = false; closed = true; }
        } else append(ch);
        continue;
      }
      if (ch === delimiter) { finishCell(); continue; }
      if (ch === '\n' || ch === '\r') {
        finishCell(); rows.push(row); row = [];
        if (ch === '\r' && input[i + 1] === '\n') i++;
        if (rows.length === MAX_ROWS) return { rows, limited: limited || partial || i + 1 < input.length, malformed: false };
        continue;
      }
      if (closed) return { rows: [], limited, malformed: true };
      if (ch === '"') {
        if (fieldStarted) return { rows: [], limited, malformed: true };
        quoted = true; fieldStarted = true;
      } else { append(ch); fieldStarted = true; }
    }
    // A byte-limited prefix is not an entire final record. Do not present an
    // incomplete cell/row as complete or enable editing of the prefix.
    if (partial) return { rows, limited: true, malformed: false };
    if (quoted) return { rows: [], limited, malformed: true };
    if (fieldStarted || closed || row.length) { finishCell(); rows.push(row); }
    return { rows, limited, malformed: false };
  }

  function isDelimited(name) { return /\.(csv|tsv)$/i.test(String(name || '')); }

  function mount(body, text, name, partial = false) {
    const result = parse(text, /\.tsv$/i.test(name) ? '\t' : ',', partial);
    const label = key => t(`files.delimited.${key}`);
    let source = result.malformed;
    const paint = () => {
      const notice = result.malformed ? label('invalid') : (result.limited ? label('limited') : '');
      body.innerHTML = `<div class="delimited-preview">
        <div class="delimited-preview-toolbar">
          <button type="button" class="btn btn-sm" data-delimited-toggle>${escapeHtml(label(source ? 'table' : 'source'))}</button>
          ${notice ? `<span role="status">${escapeHtml(notice)}</span>` : ''}
        </div>
        ${source ? `<pre class="chat-file-viewer-text">${escapeHtml(text)}</pre>` : `<div class="delimited-preview-scroll"><table><tbody>${result.rows.map((row, index) => `<tr><th scope="row">${index + 1}</th>${row.map(cell => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`}
      </div>`;
      const button = body.querySelector('[data-delimited-toggle]');
      button.disabled = result.malformed;
      button.addEventListener('click', () => { source = !source; paint(); });
    };
    paint();
  }
  if (root) root.DelimitedPreview = { isDelimited, mount };
  if (typeof module !== 'undefined' && module.exports) module.exports = { parse, isDelimited };
})(typeof window !== 'undefined' ? window : null);
