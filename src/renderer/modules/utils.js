// ─── Utilities ───

function _baseLang(lang) {
  return (lang || '').split(/[-_]/)[0] || 'en';
}

function descriptionLocale(lang) {
  return _baseLang(lang) === 'zh' ? 'zh' : 'en';
}

function normalizeDisplayText(value) {
  return String(value || '')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\{2,}/g, '\\')
    .replace(/\s+/g, ' ')
    .trim();
}

function pickLocalizedField(obj, base, lang, fallbackLang = 'en') {
  if (!obj || !base) return '';
  const cur = _baseLang(lang);
  const candidates = [
    `${base}_${cur}`,
    `${base}_${fallbackLang}`,
    `${base}_en`,
    `${base}_zh`,
    base,
  ];
  const seen = new Set();
  for (const key of candidates) {
    if (seen.has(key)) continue;
    seen.add(key);
    const v = obj[key];
    if (v !== null && v !== undefined && String(v).trim()) return normalizeDisplayText(v);
  }
  return '';
}

function pickLocalizedName(obj, lang) {
  return pickLocalizedField(obj, 'name', lang);
}

/** Pick a skill / agent description for the active UI language with cross-
 *  language fallback. Mirrors `pickDescription` in core-agent's skills/types
 *  — keep these two in sync if the fallback rule changes.
 *
 *  Description storage is intentionally still zh/en only: non-Chinese UI
 *  languages use the English description first. Cross-fallback guarantees a
 *  non-empty string whenever any side is filled. */
function pickDesc(spec, lang) {
  if (!spec) return '';
  const primary = pickLocalizedField(spec, 'description', descriptionLocale(lang));
  if (primary) return primary;
  return pickLocalizedField(spec, 'description', lang);
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// Safe-URI allow-list. Mirrors DOMPurify's default scheme regex plus the
// app's own privileged schemes (chat-media / chat-app / kb-file, registered
// in main/index.ts) and blob: (attachment object URLs), so media / artifact /
// KB links survive sanitization. Scheme-less (relative / anchor / path) refs
// pass via the `[^a-z]` / trailing-non-scheme-char branches; javascript: /
// data: / vbscript: / file: do NOT match and are dropped.
const _SAFE_URI_RE = /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|chat-media|chat-app|kb-file|blob):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

// Return the href if it is a safe URI, else '' (dropped). Used by the link
// builders below so a `javascript:`/`data:` href never reaches the DOM even
// before DOMPurify runs; callers still escapeHtml() the result into the
// attribute to prevent quote breakout on otherwise-allowed schemes.
function _safeHref(url) {
  const u = String(url === null || url === undefined ? '' : url).trim();
  return _SAFE_URI_RE.test(u) ? u : '';
}

// XSS sanitizer for HTML that ends up in innerHTML and may carry untrusted
// text (chat message bodies, LLM / relay / marketplace / skill / KB content).
// DOMPurify (vendored, loaded before this module) strips scripts, event
// handlers, and dangerous URL schemes while preserving the markdown
// renderer's legitimate output: tables, lists, code, links, images, the
// :::chart-bar / :::dashboard SVG, and the MathJax delimiters (typeset later
// on the live DOM). In the Node test env DOMPurify is absent (no DOM) so this
// returns the input unchanged — the pure `_safeHref` / escaping in the link
// builders is the node-tested layer; DOMPurify is the authoritative backstop
// in the real renderer.
let _sanitizeHookInstalled = false;
let _sanitizeMissingWarned = false;
function _domPurify() {
  if (typeof window !== 'undefined' && window.DOMPurify) return window.DOMPurify;
  if (typeof DOMPurify !== 'undefined') return DOMPurify; // eslint-disable-line no-undef
  return null;
}
function sanitizeHtml(html) {
  const s = (html === null || html === undefined) ? '' : String(html);
  const DP = _domPurify();
  if (!DP || typeof DP.sanitize !== 'function') {
    if (typeof window !== 'undefined' && !_sanitizeMissingWarned) {
      _sanitizeMissingWarned = true;
      try { console.error('[security] DOMPurify unavailable — HTML sanitization is OFF'); } catch (_) {}
    }
    return s;
  }
  if (!_sanitizeHookInstalled && typeof DP.addHook === 'function') {
    // Any link opening a new browsing context must carry rel=noopener noreferrer.
    DP.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A' && node.getAttribute && node.getAttribute('target')) {
        node.setAttribute('rel', 'noopener noreferrer');
      }
    });
    _sanitizeHookInstalled = true;
  }
  return DP.sanitize(s, { ADD_ATTR: ['target'], ALLOWED_URI_REGEXP: _SAFE_URI_RE });
}

function normalizeCatalogSource(source) {
  const s = String(source || '').trim().toLowerCase();
  if (s === 'builtin' || s === 'platform') return 'marketplace';
  if (s === 'custom') return 'custom';
  return s;
}

function isCustomCatalogSource(source) {
  return normalizeCatalogSource(source) === 'custom';
}

function isMarketplaceCatalogSource(source) {
  return normalizeCatalogSource(source) === 'marketplace';
}

function sanitizeMathExpressionForMathJax(expr) {
  return String(expr || '')
    // `\boldsymbol` lives in a MathJax extension that our offline vendor
    // bundle cannot lazy-load. Use base TeX bold instead so one macro does
    // not make the whole bubble fall back to raw TeX.
    .replace(/\\boldsymbol\b/g, '\\mathbf')
    .replace(/(^|[^\\])_{2,}/g, (match, prefix) => {
      const len = match.length - prefix.length;
      const em = Math.max(1.5, Math.min(4, len * 0.5));
      return `${prefix}\\underline{\\hspace{${em}em}}`;
    });
}

function catalogSourceLabel(source, kind = 'agents') {
  const normalized = normalizeCatalogSource(source);
  const base = kind === 'skills' ? 'skills' : 'agents';
  if (normalized === 'custom') return t(`${base}.source_custom`);
  if (normalized === 'marketplace') return t(`${base}.source_marketplace`);
  return source ? String(source) : '';
}

// Full markdown renderer (used for skill detail view and chat)
function renderMarkdownFull(md) {
  if (!md) return '';

  // Strip YAML frontmatter
  md = md.replace(/^---[\s\S]*?---\n?/, '');

  // ── Phase 1: protect code blocks & :::chart-bar directives ──
  const protectedBlocks = [];
  const protect = (html) => {
    const idx = protectedBlocks.length;
    protectedBlocks.push(html);
    return `\x00BLOCK${idx}\x00`;
  };

  // Code blocks
  md = md.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) =>
    protect(`<pre><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`)
  );

  // :::chart-bar directives
  md = md.replace(/:::chart-bar\s*\n([\s\S]*?)\n\s*:::/g, (_, body) => {
    try {
      const data = JSON.parse(body.trim());
      return protect(renderChartBar(data));
    } catch (e) {
      return protect(`<pre class="code-view"><code>${escapeHtml(body.trim())}</code></pre>`);
    }
  });

  // :::dashboard directives — JSON component tree → recursive HTML render.
  // `_parseDashboardSpec` is strict-first, then attempts bounded repairs for
  // the brace miscounts LLMs reliably produce. Anything it still can't parse
  // falls back to a code-view block so the user sees the raw body instead of
  // a silently-dropped section.
  md = md.replace(/:::dashboard\s*\n([\s\S]*?)\n\s*:::/g, (_, body) => {
    const spec = _parseDashboardSpec(body);
    if (spec !== undefined) return protect(renderDashboard(spec));
    return protect(`<pre class="code-view dashboard-parse-error"><code>${escapeHtml(body.trim())}</code></pre>`);
  });

  // Math blocks — protect so markdown phase 2 (emphasis, autolinking, html
  // escapes) doesn't mangle LaTeX before MathJax sees it. Order matters:
  //   1. `$$...$$` and `\[...\]` (display) — multi-line, must match first
  //   2. `\(...\)` (inline, latex-native) — unambiguous, no `$` collision
  //   3. `$...$` (inline, markdown-style) — single line, no nested `$`,
  //      and we skip the case where the `$` is followed by a digit without
  //      a space to avoid eating "$50 / $100" currency mentions. MathJax's
  //      `processEscapes: true` also lets authors write `\$` for literal.
  // We wrap the preserved delimiters in the output so MathJax can still
  // locate them — we're only shielding the inner characters from markdown.
  md = md.replace(/\$\$([\s\S]+?)\$\$/g, (_, expr) => protect(`$$${sanitizeMathExpressionForMathJax(expr)}$$`));
  md = md.replace(/\\\[([\s\S]+?)\\\]/g, (_, expr) => protect(`\\[${sanitizeMathExpressionForMathJax(expr)}\\]`));
  md = md.replace(/\\\(([\s\S]+?)\\\)/g, (_, expr) => protect(`\\(${sanitizeMathExpressionForMathJax(expr)}\\)`));
  md = md.replace(/(^|[^\\$])\$(?!\s|\d)([^\$\n]+?)\$(?!\d)/g,
    (_, pre, expr) => pre + protect(`$${sanitizeMathExpressionForMathJax(expr)}$`));

  // Inline code — protect from phase 2 transforms so autolinking / emphasis
  // don't touch its contents.
  md = md.replace(/`([^`]+)`/g, (_, c) => protect(`<code>${escapeHtml(c)}</code>`));

  // ── Phase 2: line-by-line parsing ──
  const lines = md.split('\n');
  const out = [];
  // Stack of open lists: { type:'ul'|'ol', indent:number, count:number,
  //   siblingOpen:boolean }. Indent is measured in spaces (tabs → 2 spaces).
  const listStack = [];
  // Remember the last count seen at a given indent so that `<ol>` numbering
  // resumes if broken by a paragraph / hr / heading.
  const olCounts = {};
  let inBlockquote = false;
  let tableRows = [];

  const closeList = (top) => {
    if (top.siblingOpen) out.push('</li>');
    out.push(`</${top.type}>`);
    if (top.type === 'ol') olCounts[top.indent] = top.count;
  };
  const flushList = () => {
    while (listStack.length) {
      const top = listStack.pop();
      closeList(top);
      if (listStack.length) {
        out.push('</li>');
        listStack[listStack.length - 1].siblingOpen = false;
      }
    }
  };
  const flushBQ = () => { if (inBlockquote) { out.push('</blockquote>'); inBlockquote = false; } };
  const flushTable = () => {
    if (!tableRows.length) return;
    out.push(buildTable(tableRows));
    tableRows = [];
  };
  const resetOl = () => { for (const k of Object.keys(olCounts)) delete olCounts[k]; };

  const openList = (type, indent) => {
    const resume = type === 'ol' ? (olCounts[indent] || 0) : 0;
    out.push(resume > 0 ? `<ol start="${resume + 1}">` : `<${type}>`);
    listStack.push({ type, indent, count: resume, siblingOpen: false });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Table: detect rows starting and ending with |
    if (/^\|(.+)\|$/.test(line.trim())) {
      flushList(); flushBQ();
      tableRows.push(line.trim());
      continue;
    } else {
      flushTable();
    }

    // Headings
    const hm = line.match(/^(#{1,6})\s+(.*)/);
    if (hm) {
      flushList(); flushBQ();
      resetOl();
      out.push(`<h${hm[1].length}>${inlineFormat(hm[2])}</h${hm[1].length}>`);
      continue;
    }
    // Horizontal rule
    if (/^[-*_]{3,}\s*$/.test(line)) {
      flushList(); flushBQ();
      resetOl();
      out.push('<hr>');
      continue;
    }
    // Blockquote
    const bqm = line.match(/^>\s?(.*)/);
    if (bqm) {
      flushList();
      if (!inBlockquote) { out.push('<blockquote>'); inBlockquote = true; }
      out.push(`<p>${inlineFormat(bqm[1])}</p>`);
      continue;
    } else { flushBQ(); }

    // List line (ul or ol) — indent-aware, nested
    const ulm = line.match(/^(\s*)[-*+]\s+(.*)$/);
    const olm = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (ulm || olm) {
      const raw = ulm || olm;
      const indent = raw[1].replace(/\t/g, '  ').length;
      const type = ulm ? 'ul' : 'ol';
      let content = ulm ? ulm[2] : olm[3];

      // Task list checkbox prefix
      const tm = content.match(/^\[([ xX])\]\s+(.*)$/);
      let taskHtml = '';
      let liClass = '';
      if (tm) {
        const checked = tm[1].toLowerCase() === 'x';
        taskHtml = `<input type="checkbox" disabled${checked ? ' checked' : ''}> `;
        liClass = ' class="task-item"';
        content = tm[2];
      }

      // Close any lists that are deeper than this line's indent
      while (listStack.length && listStack[listStack.length - 1].indent > indent) {
        const top = listStack.pop();
        closeList(top);
        if (listStack.length) {
          out.push('</li>');
          listStack[listStack.length - 1].siblingOpen = false;
        }
      }
      // Same indent but different list type → close and reopen
      if (listStack.length &&
          listStack[listStack.length - 1].indent === indent &&
          listStack[listStack.length - 1].type !== type) {
        const top = listStack.pop();
        closeList(top);
      }
      // Open a new list if none at this indent
      if (!listStack.length || listStack[listStack.length - 1].indent < indent) {
        openList(type, indent);
      }

      // Close previous sibling <li> at this level before starting new one
      const top = listStack[listStack.length - 1];
      if (top.siblingOpen) out.push('</li>');
      if (type === 'ol') top.count++;

      out.push(`<li${liClass}>${taskHtml}${inlineFormat(content)}`);
      top.siblingOpen = true;
      continue;
    }

    // Blank line inside a list: treat as soft break — keep list open but
    // close the current item so the next sibling starts cleanly.
    if (!line.trim() && listStack.length) {
      out.push('');
      continue;
    }

    flushList();
    if (!line.trim()) { out.push(''); continue; }
    out.push(`<p>${inlineFormat(line)}</p>`);
  }
  flushList(); flushBQ(); flushTable();

  let html = out.join('\n');
  // Restore protected blocks
  // Loop until all placeholders are resolved. A placeholder created late
  // can wrap an earlier-created one (e.g. inline code `$y$` wraps the math
  // placeholder for $y$); a single forward pass would miss the inner. Also
  // use function replacement so `$$` / `$1` / `$&` in the replacement string
  // aren't interpreted (breaks `$$...$$` display math otherwise).
  for (let guard = 0; guard < 16 && html.includes('\x00BLOCK'); guard++) {
    let changed = false;
    protectedBlocks.forEach((block, idx) => {
      const tok = `\x00BLOCK${idx}\x00`;
      if (html.includes(tok)) {
        html = html.replace(tok, () => block);
        changed = true;
      }
    });
    if (!changed) break;
  }
  // Single sanitize chokepoint: every renderMarkdown caller (chat bubbles,
  // skill detail, KB viewer, agent workflow, streaming finals) gets XSS-safe
  // HTML. Runs after block restore so code/chart/math placeholders are intact.
  return sanitizeHtml(html);
}

// ── Table builder ──
function buildTable(rows) {
  // rows[0] = header, rows[1] = separator (---|---), rows[2..] = data
  const parseCells = (row) =>
    row.replace(/^\||\|$/g, '').split('|').map(c => c.trim());

  if (rows.length < 2) {
    return rows.map(r => `<p>${inlineFormat(escapeHtml(r))}</p>`).join('\n');
  }

  const headerCells = parseCells(rows[0]);

  // Check if rows[1] is a separator line (all cells are dashes/colons)
  const sep = parseCells(rows[1]);
  const isSep = sep.every(c => /^:?-+:?$/.test(c));
  const dataStart = isSep ? 2 : 1;

  // Detect alignment from separator
  const aligns = isSep ? sep.map(c => {
    if (c.startsWith(':') && c.endsWith(':')) return 'center';
    if (c.endsWith(':')) return 'right';
    return 'left';
  }) : [];

  let html = '<table><thead><tr>';
  headerCells.forEach((cell, ci) => {
    const a = aligns[ci] ? ` style="text-align:${aligns[ci]}"` : '';
    html += `<th${a}>${inlineFormat(cell)}</th>`;
  });
  html += '</tr></thead><tbody>';

  for (let i = dataStart; i < rows.length; i++) {
    const cells = parseCells(rows[i]);
    html += '<tr>';
    cells.forEach((cell, ci) => {
      const a = aligns[ci] ? ` style="text-align:${aligns[ci]}"` : '';
      html += `<td${a}>${inlineFormat(cell)}</td>`;
    });
    html += '</tr>';
  }
  html += '</tbody></table>';
  return html;
}

// ── Chart bar renderer ──
function renderChartBar(data) {
  if (!Array.isArray(data) || !data.length) return '';
  const maxVal = Math.max(...data.map(d => d.value || 0), 1);
  let html = '<div class="chart-bar-container">';
  for (const item of data) {
    const pct = Math.round(((item.value || 0) / maxVal) * 100);
    const label = escapeHtml(item.label || '');
    const val = item.value ?? '';
    const unit = escapeHtml(item.unit || '');
    html += `<div class="chart-bar-row">
      <div class="chart-bar-label">${label}</div>
      <div class="chart-bar-track"><div class="chart-bar-fill" style="width:${pct}%"></div></div>
      <div class="chart-bar-value">${val}${unit}</div>
    </div>`;
  }
  html += '</div>';
  return html;
}

// ─── Dashboard renderer (`:::dashboard` directive) ────────────────────────
// Recursive component tree → HTML. Components live in two tiers:
//   • Layout primitives  : Stack / Grid / Card / Separator (no semantics)
//   • Content components : Metric / Chart / Table / Alert / Timeline /
//                          Code / Markdown / Image
// Unknown `type` and missing props render an empty container instead of
// throwing — keeps the surrounding bubble alive when the model produces a
// partially-formed tree. Props are enum-coerced via _dbEnum(); raw px / hex
// values are intentionally NOT accepted (consistency over flexibility).
//
// Cross-file note: the model-facing schema reference lives in
// `chat_shared_rules.md` "Output formats". Component names and enum values
// must match that doc — adding a component or a new prop value requires
// updating both sides in the same patch.

const _DB_GAP = { sm: 'sm', md: 'md', lg: 'lg' };
const _DB_TONE = { positive: 'positive', negative: 'negative', neutral: 'neutral', warning: 'warning' };
const _DB_LEVEL = { info: 'info', success: 'success', warning: 'warning', error: 'error' };
const _DB_CHART_KIND = { line: 'line', bar: 'bar', area: 'area', pie: 'pie' };

function _dbEnum(table, val, dflt) {
  return (val && Object.prototype.hasOwnProperty.call(table, val)) ? table[val] : dflt;
}

function _tryParseDashboardJson(text) {
  try { return JSON.parse(text); } catch (_) { return undefined; }
}

function _escapeLikelyUnescapedStringQuotes(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  let changed = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (!inString) {
      out += c;
      if (c === '"') { inString = true; escaped = false; }
      continue;
    }
    if (escaped) {
      out += c;
      escaped = false;
      continue;
    }
    if (c === '\\') {
      out += c;
      escaped = true;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      const next = text[j] || '';
      if (next === ':' || next === ',' || next === '}' || next === ']' || next === '') {
        out += c;
        inString = false;
      } else {
        out += '\\"';
        changed = true;
      }
      continue;
    }
    out += c;
  }
  return changed ? out : text;
}

function _repairDashboardJsonTail(text) {
  let inString = false;
  let escaped = false;
  let opened = false;
  let balancedEnd = -1;
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{' || c === '[') { stack.push(c); opened = true; }
    else if (c === '}' || c === ']') {
      if (stack.length) stack.pop();
      // First time the root value closes: everything after is trailing tail.
      if (opened && stack.length === 0) { balancedEnd = i + 1; break; }
    }
  }

  // Repair 1: a complete root value followed by trailing garbage (extra `}`).
  if (balancedEnd > 0 && balancedEnd < text.length) {
    const parsed = _tryParseDashboardJson(text.slice(0, balancedEnd));
    if (parsed !== undefined) return parsed;
  }
  // Repair 2: unclosed tree — append the closers it still needs, innermost first.
  if (opened && stack.length && !inString) {
    const closers = stack.reverse().map((c) => (c === '{' ? '}' : ']')).join('');
    const parsed = _tryParseDashboardJson(text + closers);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

// Tolerant parse for a `:::dashboard` JSON body. LLMs (DeepSeek especially,
// when hand-writing a deeply-nested tree) reliably produce small JSON defects:
// unescaped double quotes inside string values, a single extra `}` after the
// root close, trailing prose, or a truncated tail with closers missing. Strict
// `JSON.parse` rejects all of these and the whole dashboard collapses to a raw
// code-view block. We retry with bounded repairs before giving up:
//   1. escape likely-unescaped `"` characters inside string values
//   2. drop trailing garbage after the root value's balanced close
//      (the common "one extra }" / trailing-prose case)
//   3. append the missing closers for an unclosed (truncated) tree
// Returns the parsed spec, or `undefined` if nothing parses — the caller then
// shows the parse-error fallback so the raw body is never silently dropped.
// The scan is string-aware: brackets inside string values (e.g. an Alert body
// containing `}`) never shift the depth count, and we never trim leading
// garbage (over-repair risk) — only the trailing tail is dropped.
function _parseDashboardSpec(body) {
  const text = String(body == null ? '' : body).trim();
  if (!text) return undefined;
  const strict = _tryParseDashboardJson(text);
  if (strict !== undefined) return strict;

  const quoteRepaired = _escapeLikelyUnescapedStringQuotes(text);
  if (quoteRepaired !== text) {
    const parsed = _tryParseDashboardJson(quoteRepaired);
    if (parsed !== undefined) return parsed;
  }

  const tailRepaired = _repairDashboardJsonTail(text);
  if (tailRepaired !== undefined) return tailRepaired;
  return quoteRepaired !== text ? _repairDashboardJsonTail(quoteRepaired) : undefined;
}

function renderDashboard(spec) {
  if (!spec || typeof spec !== 'object') return '';
  const theme = spec.theme || {};
  const themeColor = _dbEnum({ neutral: 'neutral', brand: 'brand', success: 'success', warning: 'warning', danger: 'danger' }, theme.color, 'neutral');
  const themeStyle = _dbEnum({ minimal: 'minimal', card: 'card' }, theme.style, 'minimal');
  const inner = _renderDbNode(spec.root);
  return `<div class="dashboard" data-theme-color="${themeColor}" data-theme-style="${themeStyle}">${inner}</div>`;
}

function _renderDbNode(node) {
  if (!node || typeof node !== 'object') return '';
  const props = (node.props && typeof node.props === 'object') ? node.props : {};
  // Children belong at the node level (sibling of `props`), but many models
  // nest them React-style under `props.children`. Without this fallback those
  // subtrees vanish and the container renders empty — accept either shape.
  const children = Array.isArray(node.children)
    ? node.children
    : (Array.isArray(props.children) ? props.children : []);
  switch (node.type) {
    // ── Layout ────────────────────────────────────────────────────────
    case 'Stack':     return _dbStack(props, children);
    case 'Grid':      return _dbGrid(props, children);
    case 'Card':      return _dbCard(props, children);
    case 'Separator': return '<hr class="db-separator">';
    // ── Content ───────────────────────────────────────────────────────
    case 'Metric':    return _dbMetric(props);
    case 'Chart':     return _dbChart(props);
    case 'Table':     return _dbTable(props);
    case 'Alert':     return _dbAlert(props, children);
    case 'Timeline':  return _dbTimeline(props);
    case 'Code':      return _dbCode(props);
    case 'Markdown':  return _dbMarkdown(props);
    case 'Image':     return _dbImage(props);
    default:          return `<div class="db-unknown" data-type="${escapeHtml(String(node.type || ''))}"></div>`;
  }
}

function _dbChildren(children) {
  return children.map(_renderDbNode).join('');
}

// ── Layout primitives ──────────────────────────────────────────────────

function _dbStack(props, children) {
  const dir = props.direction === 'horizontal' ? 'horizontal' : 'vertical';
  const gap = _dbEnum(_DB_GAP, props.gap, 'md');
  return `<div class="db-stack" data-direction="${dir}" data-gap="${gap}">${_dbChildren(children)}</div>`;
}

function _dbGrid(props, children) {
  const cols = Math.min(4, Math.max(1, Number(props.columns) || 2));
  const gap = _dbEnum(_DB_GAP, props.gap, 'md');
  return `<div class="db-grid" data-columns="${cols}" data-gap="${gap}">${_dbChildren(children)}</div>`;
}

function _dbCard(props, children) {
  const tone = _dbEnum(_DB_TONE, props.tone, 'neutral');
  const title = props.title ? `<div class="db-card-title">${escapeHtml(props.title)}</div>` : '';
  return `<section class="db-card" data-tone="${tone}">${title}<div class="db-card-body">${_dbChildren(children)}</div></section>`;
}

// ── Content components ────────────────────────────────────────────────

function _dbMetric(props) {
  const label = escapeHtml(props.label || '');
  const value = escapeHtml(String(props.value == null ? '' : props.value));
  const tone = _dbEnum(_DB_TONE, props.tone, 'neutral');
  const delta = props.delta != null
    ? `<div class="db-metric-delta" data-tone="${tone}">${escapeHtml(String(props.delta))}</div>` : '';
  return `<div class="db-metric" data-tone="${tone}">
    <div class="db-metric-label">${label}</div>
    <div class="db-metric-value">${value}</div>
    ${delta}
  </div>`;
}

function _dbAlert(props, children = []) {
  const level = _dbEnum(_DB_LEVEL, props.level, 'info');
  const titleRaw = props.title ?? props.heading ?? props.label ?? props.name;
  const bodyRaw = props.body ?? props.message ?? props.text ?? props.content ?? props.description;
  const titleText = String(titleRaw == null ? '' : titleRaw);
  const bodyText = String(bodyRaw == null ? '' : bodyRaw);
  // Fallback: some models put the alert copy in child nodes (e.g. a nested
  // Markdown) instead of a text prop. Render those as the body so the alert
  // is not silently dropped to an empty string.
  const childHtml = (!titleText && !bodyText && children.length) ? _dbChildren(children) : '';
  if (!titleText && !bodyText && !childHtml) return '';
  const content = childHtml
    ? `<div class="db-alert-body">${childHtml}</div>`
    : `<div class="db-alert-title">${escapeHtml(titleText || bodyText)}</div>${
        titleText && bodyText ? `<div class="db-alert-body">${escapeHtml(bodyText)}</div>` : ''}`;
  return `<div class="db-alert" data-level="${level}" role="status">
    <span class="db-alert-icon" aria-hidden="true"></span>
    <div class="db-alert-content">${content}</div>
  </div>`;
}

function _dbTable(props) {
  const cols = Array.isArray(props.columns) ? props.columns : [];
  const rows = Array.isArray(props.rows) ? props.rows : [];
  if (!cols.length) return '<div class="db-table-empty"></div>';
  const head = cols.map(c => {
    const numeric = c && c.numeric ? ' data-numeric="1"' : '';
    return `<th${numeric}>${escapeHtml((c && (c.label || c.key)) || '')}</th>`;
  }).join('');
  const body = rows.map(r => {
    const cells = cols.map(c => {
      const k = c && c.key;
      const v = (k && r && Object.prototype.hasOwnProperty.call(r, k)) ? r[k] : '';
      const numeric = c && c.numeric ? ' data-numeric="1"' : '';
      return `<td${numeric}>${escapeHtml(String(v == null ? '' : v))}</td>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }).join('');
  return `<div class="db-table-wrap"><table class="db-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function _dbTimeline(props) {
  const items = Array.isArray(props.items) ? props.items : [];
  if (!items.length) return '<div class="db-timeline-empty"></div>';
  const lis = items.map(it => {
    const time = escapeHtml((it && it.time) || '');
    const label = escapeHtml((it && it.label) || '');
    const body = it && it.body ? `<div class="db-timeline-body">${escapeHtml(it.body)}</div>` : '';
    return `<li class="db-timeline-item">
      <div class="db-timeline-time">${time}</div>
      <div class="db-timeline-label">${label}</div>
      ${body}
    </li>`;
  }).join('');
  return `<ol class="db-timeline">${lis}</ol>`;
}

function _dbCode(props) {
  const lang = escapeHtml(props.lang || '');
  const code = escapeHtml(String(props.code == null ? '' : props.code));
  const langAttr = lang ? ` data-lang="${lang}"` : '';
  return `<pre class="db-code"${langAttr}><code>${code}</code></pre>`;
}

function _dbMarkdown(props) {
  // Accept `text` (schema name) or `content` (common model guess) — without
  // this alias the model's `{ Markdown: { content: "..." } }` silently
  // collapses to an empty bubble and the section disappears.
  const raw = props.text != null ? props.text : props.content;
  const text = String(raw == null ? '' : raw);
  // Recursive call back into renderMarkdownFull keeps the same feature set
  // (tables / lists / inline code / autolinks); strip leading `:::dashboard`
  // re-entry to prevent an infinite-render loop if the model nests one.
  const cleaned = text.replace(/:::dashboard[\s\S]*?:::/g, '');
  return `<div class="db-markdown">${renderMarkdownFull(cleaned)}</div>`;
}

function _dbImage(props) {
  const src = String(props.src || '');
  if (!src) return '';
  const alt = escapeHtml(props.alt || '');
  const caption = props.caption
    ? `<figcaption class="db-image-caption">${escapeHtml(props.caption)}</figcaption>` : '';
  return `<figure class="db-image"><img src="${escapeHtml(src)}" alt="${alt}">${caption}</figure>`;
}

// ── Chart (minimal inline SVG; line/bar/area/pie) ─────────────────────

function _dbChart(props) {
  const kind = _dbEnum(_DB_CHART_KIND, props.kind, 'bar');
  const data = Array.isArray(props.data) ? props.data : [];
  if (!data.length) return '<div class="db-chart-empty"></div>';
  if (kind === 'pie') return _dbPie(data);
  return _dbXyChart(kind, data);
}

function _dbPie(data) {
  // data: [{label, value}, ...]
  const items = data.filter(d => d && Number.isFinite(Number(d.value)) && Number(d.value) > 0);
  const total = items.reduce((a, d) => a + Number(d.value), 0);
  if (!total) return '<div class="db-chart-empty"></div>';
  const cx = 50, cy = 50, r = 45;
  let acc = 0;
  const segs = items.map((d, i) => {
    const v = Number(d.value);
    const startAngle = (acc / total) * Math.PI * 2 - Math.PI / 2;
    acc += v;
    const endAngle = (acc / total) * Math.PI * 2 - Math.PI / 2;
    const large = (v / total) > 0.5 ? 1 : 0;
    const x1 = cx + r * Math.cos(startAngle), y1 = cy + r * Math.sin(startAngle);
    const x2 = cx + r * Math.cos(endAngle),   y2 = cy + r * Math.sin(endAngle);
    return `<path d="M${cx},${cy} L${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 ${large} 1 ${x2.toFixed(2)},${y2.toFixed(2)} Z" class="db-chart-slice" data-idx="${i % 6}"></path>`;
  }).join('');
  const legend = items.map((d, i) =>
    `<li data-idx="${i % 6}"><span class="db-chart-swatch"></span>${escapeHtml(d.label || '')} <span class="db-chart-val">${escapeHtml(String(d.value))}</span></li>`
  ).join('');
  return `<div class="db-chart" data-kind="pie">
    <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" class="db-chart-svg">${segs}</svg>
    <ol class="db-chart-legend">${legend}</ol>
  </div>`;
}

function _dbXyChart(kind, data) {
  // data: [{x, y}, ...] — x is label (string), y is numeric.
  const points = data.map(d => ({ x: String((d && d.x) ?? ''), y: Number((d && d.y) ?? 0) }))
    .filter(p => Number.isFinite(p.y));
  if (!points.length) return '<div class="db-chart-empty"></div>';
  const W = 320, H = 140, padL = 32, padR = 8, padT = 8, padB = 22;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const maxY = Math.max(...points.map(p => p.y), 0);
  const minY = Math.min(...points.map(p => p.y), 0);
  const span = (maxY - minY) || 1;
  const xOf = (i) => padL + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const yOf = (y) => padT + innerH - ((y - minY) / span) * innerH;
  const yTicks = [0, 0.5, 1].map((ratio) => {
    const y = padT + innerH - ratio * innerH;
    const val = minY + ratio * span;
    const label = Math.abs(val) >= 10 ? Math.round(val) : Number(val.toFixed(1));
    return `<line x1="${padL}" y1="${y.toFixed(2)}" x2="${W - padR}" y2="${y.toFixed(2)}" class="db-chart-gridline"></line>` +
      `<text x="${(padL - 6).toFixed(2)}" y="${(y + 3).toFixed(2)}" class="db-chart-ylabel" text-anchor="end">${escapeHtml(String(label))}</text>`;
  }).join('');
  const axis = `<line x1="${padL}" y1="${padT + innerH}" x2="${W - padR}" y2="${padT + innerH}" class="db-chart-axis"></line>`;
  let body = '';
  if (kind === 'bar') {
    const barW = innerW / points.length * 0.6;
    body = points.map((p, i) => {
      const x = xOf(i) - barW / 2;
      const y = yOf(Math.max(p.y, 0));
      const h = Math.abs(yOf(p.y) - yOf(0));
      return `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barW.toFixed(2)}" height="${h.toFixed(2)}" rx="3" class="db-chart-bar-rect" data-idx="${i % 6}"></rect>`;
    }).join('');
  } else {
    const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(2)},${yOf(p.y).toFixed(2)}`).join(' ');
    if (kind === 'area') {
      const area = `M${xOf(0).toFixed(2)},${yOf(minY).toFixed(2)} ` +
        points.map((p, i) => `L${xOf(i).toFixed(2)},${yOf(p.y).toFixed(2)}`).join(' ') +
        ` L${xOf(points.length - 1).toFixed(2)},${yOf(minY).toFixed(2)} Z`;
      body = `<path d="${area}" class="db-chart-area"></path><path d="${path}" class="db-chart-line"></path>`;
    } else {
      body = `<path d="${path}" class="db-chart-line"></path>` +
        points.map((p, i) => `<circle cx="${xOf(i).toFixed(2)}" cy="${yOf(p.y).toFixed(2)}" r="2.5" class="db-chart-dot" data-idx="${i % 6}"></circle>`).join('');
    }
  }
  const labels = points.map((p, i) => {
    if (points.length > 8 && i % Math.ceil(points.length / 6) !== 0 && i !== points.length - 1) return '';
    return `<text x="${xOf(i).toFixed(2)}" y="${(H - 6).toFixed(2)}" class="db-chart-xlabel" text-anchor="middle">${escapeHtml(p.x)}</text>`;
  }).join('');
  return `<div class="db-chart" data-kind="${kind}">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" class="db-chart-svg">
      ${yTicks}${axis}${body}${labels}
    </svg>
  </div>`;
}

// Detect video src by extension. Dispatches markdown ![](src) to <video>
// instead of <img> — covers chat-media://local/...mp4, https://..../clip.webm,
// and any user-authored markdown pointing at a video file. The match is
// against the last extension-looking segment so query strings / fragments
// don't defeat it.
const _VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v|ogv)(?:[?#].*)?$/i;
function _isVideoSrc(src) {
  return _VIDEO_EXT_RE.test(String(src || ''));
}

function _markdownVideoHtml(src, label, title) {
  const t = title ? ` title="${escapeHtml(title)}"` : '';
  return `<video class="chat-md-video" controls controlslist="nodownload nofullscreen noremoteplayback" disablepictureinpicture disableremoteplayback playsinline preload="metadata" src="${escapeHtml(src)}"${t} aria-label="${escapeHtml(label || 'video')}"></video>`;
}

function _markdownImageHtml(src, alt, title) {
  const t = title ? ` title="${escapeHtml(title)}"` : '';
  return `<img class="chat-md-img" src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"${t}>`;
}

function _missingMarkdownImageLabel() {
  const key = 'chat.image_missing_placeholder';
  try {
    if (typeof t === 'function') {
      const val = t(key);
      if (val && val !== key) return val;
    }
  } catch (_) { /* fall through */ }
  return 'Image missing';
}

function _missingMarkdownVideoLabel() {
  const key = 'chat.video_missing_placeholder';
  try {
    if (typeof t === 'function') {
      const val = t(key);
      if (val && val !== key) return val;
    }
  } catch (_) { /* fall through */ }
  return 'Video missing';
}

function _replaceMissingMarkdownImage(img) {
  if (!img || !img.parentNode || img.dataset?.missingImageHandled === '1') return;
  if (img.dataset) img.dataset.missingImageHandled = '1';
  const label = _missingMarkdownImageLabel();
  const alt = String(img.getAttribute('alt') || '').trim();
  const title = alt ? `${label}: ${alt}` : label;
  const chip = document.createElement('span');
  chip.className = 'chat-md-img-missing';
  chip.setAttribute('role', 'img');
  chip.setAttribute('aria-label', title);
  chip.setAttribute('title', title);

  const icon = document.createElement('span');
  icon.className = 'chat-md-img-missing-icon';
  icon.setAttribute('aria-hidden', 'true');
  if (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function') {
    icon.innerHTML = window.uiIconHtml('image', 'ui-icon chat-md-img-missing-svg');
  }

  const text = document.createElement('span');
  text.className = 'chat-md-img-missing-text';
  text.textContent = label;

  chip.appendChild(icon);
  chip.appendChild(text);
  img.replaceWith(chip);
}

function _replaceMissingMarkdownVideo(video) {
  if (!video || !video.parentNode || video.dataset?.missingVideoHandled === '1') return;
  if (video.dataset) video.dataset.missingVideoHandled = '1';
  const label = _missingMarkdownVideoLabel();
  const alt = String(video.getAttribute('aria-label') || '').trim();
  const title = alt ? `${label}: ${alt}` : label;
  const chip = document.createElement('span');
  chip.className = 'chat-md-video-missing';
  chip.setAttribute('role', 'img');
  chip.setAttribute('aria-label', title);
  chip.setAttribute('title', title);

  const icon = document.createElement('span');
  icon.className = 'chat-md-video-missing-icon';
  icon.setAttribute('aria-hidden', 'true');
  if (typeof window !== 'undefined' && typeof window.fileKindIconHtml === 'function') {
    icon.innerHTML = window.fileKindIconHtml('video.mp4', 'video');
  } else if (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function') {
    icon.innerHTML = window.uiIconHtml('play-triangle', 'ui-icon chat-md-video-missing-svg');
  }

  const text = document.createElement('span');
  text.className = 'chat-md-video-missing-text';
  text.textContent = label;

  chip.appendChild(icon);
  chip.appendChild(text);
  video.replaceWith(chip);
}

if (typeof document !== 'undefined') document.addEventListener('error', (e) => {
  const target = e.target;
  if (!target || target.nodeType !== 1) return;
  if (target.tagName === 'IMG' && target.classList?.contains('chat-md-img')) {
    _replaceMissingMarkdownImage(target);
    return;
  }
  if (target.tagName === 'VIDEO' && target.classList?.contains('chat-md-video')) {
    _replaceMissingMarkdownVideo(target);
  }
}, true);

// Bare URL autolink termination set. URLs per RFC 3986 are ASCII; CJK
// ideographs / kana / hangul / CJK punctuation never appear in a real URL
// (IRIs encode the host as punycode and the path as percent-encoded UTF-8).
// Without these ranges in the regex's negated char class, a URL embedded
// in a CJK sentence is matched through the trailing CJK run and the link
// visually swallows the prose. Reported case: a fullwidth comma after a
// URL pulled the rest of the Chinese sentence into the anchor.
const _URL_NON_TERMINATOR =
  '\u4e00-\u9fff' +   // CJK Unified Ideographs
  '\u3000-\u303f' +   // CJK Symbols and Punctuation
  '\uff00-\uffef' +   // Halfwidth and Fullwidth Forms (incl. fullwidth ASCII punct)
  '\u3040-\u309f' +   // Hiragana
  '\u30a0-\u30ff' +   // Katakana
  '\uac00-\ud7af';    // Hangul Syllables

// Bare URL autolink. Negative lookbehind keeps us out of:
//   1) URLs already inside an HTML attr (preceded by `"` / `'` / `=`) from
//      earlier phases (markdown links / image src / `<url>` autolinks) —
//      must NOT double-wrap;
//   2) mid-string positions (preceded by URL-internal chars) that look
//      like the tail of a longer URL.
// Termination set excludes ASCII URL-incompatible chars + the CJK ranges
// so the URL ends at the first non-URL boundary.
const _BARE_URL_RE = new RegExp(
  '(?<![a-zA-Z0-9._\\-:/?=&#%+"\'>])' +
  '(https?:\\/\\/[^\\s<>"\'`)\\]' + _URL_NON_TERMINATOR + ']+)',
  'g'
);

const _BARE_EMAIL_RE = new RegExp(
  '(?<![a-zA-Z0-9._\\-:/?=&#%+"\'>])' +
  '([\\w.+-]+@[\\w.-]+\\.[A-Za-z]{2,})',
  'g'
);

// Replace bare http(s) URLs with `<a>` tags. Trailing ASCII sentence punct
// (`.,;:!?)`) is trimmed off the link and emitted as plain text after it,
// so "see https://x.com." renders with the period outside the link.
function _linkifyBareUrls(text) {
  return text.replace(_BARE_URL_RE, (_, url) => {
    const trail = (url.match(/[.,;:!?)]+$/) || [''])[0];
    const clean = trail ? url.slice(0, -trail.length) : url;
    return `<a href="${clean}" target="_blank" rel="noopener">${clean}</a>${trail}`;
  });
}

function _linkifyBareEmails(text) {
  return text.replace(_BARE_EMAIL_RE, (_, email) => `<a href="mailto:${email}">${email}</a>`);
}

function inlineFormat(text) {
  // Phase 1: media + markdown links + `<url>` / `<email>` autolinks + emphasis.
  const phase1 = text
    // Media: ![alt](src) — dispatch to <video> when src looks like a video
    // file, else <img>. Must run before link syntax.
    .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
      (_, alt, src, title) => {
        if (_isVideoSrc(src)) {
          // `preload=metadata` so listings don't auto-fetch the whole file;
          // controls visible so user can play/seek.
          return _markdownVideoHtml(src, alt, title);
        }
        return _markdownImageHtml(src, alt, title);
      })
    // Markdown links: [text](url "title")
    .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
      (_, txt, url, title) => {
        if (_isVideoSrc(url)) return _markdownVideoHtml(url, txt, title);
        // href: scheme-checked + escaped (blocks javascript:/data: and quote
        // breakout). text stays raw so nested image/emphasis still render;
        // DOMPurify scrubs any raw HTML in the text at the output layer.
        return `<a href="${escapeHtml(_safeHref(url))}" target="_blank" rel="noopener"${title ? ` title="${escapeHtml(title)}"` : ''}>${txt}</a>`;
      })
    // <url> and <email> autolinks
    .replace(/<((?:https?:\/\/|mailto:)[^>\s]+)>/g,
      (_, u) => `<a href="${escapeHtml(u)}" target="_blank" rel="noopener">${escapeHtml(u)}</a>`)
    .replace(/<([\w.+-]+@[\w.-]+\.[A-Za-z]{2,})>/g,
      (_, e) => `<a href="mailto:${e}">${e}</a>`)
    // Emphasis
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
  // Phase 2: bare URL + bare email autolinks. Split out so set-A
  // (real URLs in CJK / ASCII contexts must end at the right boundary) and
  // set-B (URLs inside attrs / already-wrapped links must not be re-wrapped)
  // are pinned by `test/renderer/utils-autolink.test.ts`.
  return _linkifyBareEmails(_linkifyBareUrls(phase1));
}

// Unified entrypoint: all chat bubbles, skill detail pages, streaming finals
// share the same full-featured Markdown renderer (tables, lists, code blocks,
// :::chart-bar directives, etc). Call sites use `renderMarkdown(str)` without
// caring about the level of support.
const renderMarkdown = renderMarkdownFull;

// Route http(s) link clicks through main's shell.openExternal so they always
// land in the system browser regardless of `target=` / Electron version /
// rel=noopener quirks. Covers chat bubbles, KB viewer, skill detail, agent
// workflow — anywhere renderMarkdown emits `<a href="http...">`. Main's
// setWindowOpenHandler / will-navigate (see main/index.ts) is the safety net
// for clicks that arrive before this script evaluates or when window.orkas
// hasn't been wired yet (then we don't preventDefault and let main handle it).
// Guarded for Node test env where `document` is undefined; the click router
// is a renderer-only side effect and irrelevant to the autolink fixtures.
if (typeof document !== 'undefined') document.addEventListener('click', (e) => {
  const a = e.target && e.target.closest && e.target.closest('a[href]');
  if (!a) return;
  const href = a.getAttribute('href');
  if (!/^https?:\/\//i.test(href || '')) return;
  if (!window.orkas || typeof window.orkas.invoke !== 'function') return;
  e.preventDefault();
  window.orkas.invoke('auth.openExternal', { url: href }).catch(() => {});
});

/** Renderer-side mirror of `storage.ts::nowIso()` — local-time ISO8601
 *  truncated to seconds, no TZ suffix. Optimistic / placeholder timestamps
 *  must use this format so they sort identically with persisted ts strings
 *  produced server-side. Mixing `new Date().toISOString()` (UTC + ms) with
 *  the server's second-precision local-time string parses to a 0–999ms
 *  drift that makes a same-second user msg test as "later than" the agent
 *  reply, flipping bubble order in the chat (CLAUDE.md §8). */
function nowIsoLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Compose a sidebar title from arbitrary user-message text. Mirrors
 *  backend `chats.ts::autoTitle` so the optimistic renderer-side title
 *  and the backend-persisted title agree — without this match the new
 *  conv first paints the optimistic value, then `loadConversations`
 *  refreshes with backend's value and the sidebar entry visibly flips.
 *  Empty input returns '' so the caller can fall back to its own
 *  placeholder (`t('chat.new_conv_title')` for the conv list). */
// `_autoTitle` + its regex constants live in `modules/auto-title.js` so the
// regex set has a single renderer-side home and a clean target for the
// `test/renderer/auto-title-parity.test.ts` parity check against
// `src/main/util/auto-title.ts`. The new file is loaded before consumers
// via `<script src="./modules/auto-title.js">` in index.html.

function formatTime(iso) {
  if (!iso) return '-';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso).replace('T', ' ').substring(0, 16);
    const formatter = new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
      timeZone: 'Asia/Shanghai'
    });
    const parts = formatter.formatToParts(d);
    const map = {};
    parts.forEach(p => map[p.type] = p.value);
    return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}`;
  } catch (e) {
    return String(iso).replace('T', ' ').substring(0, 16);
  }
}

// ─── Custom dropdown (AiSelect) ───────────────────────────────────────────
// Native <select> renders OS-default chrome that looks dated next to the
// rest of the app. AiSelect is a minimal styled replacement:
//   - mount point: <div class="ai-select" id="...">
//   - set options via _aiSelectMount(el, { options, value, placeholder,
//                                          onChange })
//   - reads current value via el.dataset.value (string)
// Keyboard: Enter/Space toggles the popover, arrow keys to nav, Esc to close.

const AI_SELECT_BASE_POPOVER_Z_INDEX = 14000;

function _aiSelectNextZIndex(values, fallback = AI_SELECT_BASE_POPOVER_Z_INDEX) {
  let z = fallback;
  for (const raw of values || []) {
    const n = Number.parseInt(String(raw || ''), 10);
    if (Number.isFinite(n)) z = Math.max(z, n + 1);
  }
  return z;
}

function _aiSelectPopoverZIndexFor(el) {
  const values = [];
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    const raw = window.getComputedStyle(n).zIndex;
    if (raw && raw !== 'auto') values.push(raw);
  }
  // Some modal systems put the high z-index on a sibling/backdrop instead
  // of an ancestor of the select. Include visible app overlays so a body-
  // portaled dropdown still paints above the current dialog layer.
  if (typeof document !== 'undefined' && document.body) {
    const layerSelector = [
      '.modal-overlay.open',
      '.ui-dialog-overlay.open',
      '.account-login-overlay.open',
      '[role="dialog"][aria-modal="true"]',
    ].join(',');
    for (const n of document.querySelectorAll(layerSelector)) {
      if (!n || n === el || n.hidden) continue;
      const style = window.getComputedStyle(n);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (style.zIndex && style.zIndex !== 'auto') values.push(style.zIndex);
    }
  }
  return _aiSelectNextZIndex(values);
}

function _aiSelectMount(el, config) {
  if (!el) return null;
  const state = {
    options: [],        // [{value, label, hint?, iconName?}]
    value: '',
    placeholder: (t('ai_select.placeholder')),
    onChange: () => {},
    open: false,
    activeIdx: -1,
  };
  Object.assign(state, config || {});

  const caretIcon = (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function')
    ? window.uiIconHtml('chevron-down', 'ai-select-caret')
    : '';

  el.classList.add('ai-select');
  el.innerHTML = `
    <button type="button" class="ai-select-trigger" aria-haspopup="listbox">
      <span class="ai-select-label"></span>
      ${caretIcon}
    </button>
    <div class="ai-select-popover" role="listbox" hidden></div>
  `;

  const trigger = el.querySelector('.ai-select-trigger');
  const labelEl = el.querySelector('.ai-select-label');
  const popover = el.querySelector('.ai-select-popover');

  const renderOptionLabel = (target, opt) => {
    target.innerHTML = '';
    if (opt && opt.iconName && typeof window !== 'undefined' && typeof window.uiIconHtml === 'function') {
      const iconWrap = document.createElement('span');
      iconWrap.className = 'ai-select-option-icon';
      iconWrap.innerHTML = window.uiIconHtml(opt.iconName, 'ui-icon ai-select-svg-icon');
      target.appendChild(iconWrap);
    }
    const text = document.createElement('span');
    text.textContent = opt ? opt.label : state.placeholder;
    target.appendChild(text);
  };

  const renderTrigger = () => {
    const opt = state.options.find(o => o.value === state.value);
    if (opt) {
      renderOptionLabel(labelEl, opt);
      labelEl.classList.remove('placeholder');
    } else {
      renderOptionLabel(labelEl, null);
      labelEl.classList.add('placeholder');
    }
    el.dataset.value = state.value || '';
  };

  const renderPopover = () => {
    popover.innerHTML = '';
    if (state.options.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ai-select-empty';
      empty.textContent = t('ai_select.empty');
      popover.appendChild(empty);
      return;
    }
    state.options.forEach((opt, idx) => {
      const item = document.createElement('div');
      item.className = 'ai-select-item';
      item.setAttribute('role', 'option');
      if (opt.value === state.value) item.classList.add('active');
      if (idx === state.activeIdx) item.classList.add('hover');
      const main = document.createElement('div');
      main.className = 'ai-select-item-label';
      renderOptionLabel(main, opt);
      item.appendChild(main);
      if (opt.hint) {
        const hint = document.createElement('div');
        hint.className = 'ai-select-item-hint';
        hint.textContent = opt.hint;
        item.appendChild(hint);
      }
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        _aiSelectPick(api, opt.value);
      });
      item.addEventListener('mouseenter', () => {
        state.activeIdx = idx;
        popover.querySelectorAll('.ai-select-item').forEach((n, i) => n.classList.toggle('hover', i === idx));
      });
      popover.appendChild(item);
    });
  };

  // Portal the popover to <body> while open so an ancestor with
  // `overflow: auto / hidden` (modals, settings panes) can't clip it.
  // We set `position: fixed` + viewport coords from the trigger's
  // bounding rect; on scroll/resize we re-measure. This replaces the
  // earlier "popover lives inside .ai-select" layout — the markup
  // still renders the popover inside .ai-select for first paint, but
  // open/close moves it back and forth.
  let portalParent = null;
  let portalNextSibling = null;
  const reposition = () => {
    if (!state.open) return;
    const rect = trigger.getBoundingClientRect();
    popover.style.position = 'fixed';
    popover.style.left = rect.left + 'px';
    popover.style.top = (rect.bottom + 4) + 'px';
    popover.style.width = rect.width + 'px';
    // Flip up if the popover would overflow the viewport bottom.
    const popH = popover.offsetHeight || 260;
    if (rect.bottom + 4 + popH > window.innerHeight - 8 && rect.top - 4 - popH > 8) {
      popover.style.top = (rect.top - 4 - popH) + 'px';
    }
    popover.style.zIndex = String(_aiSelectPopoverZIndexFor(el));
  };
  const open = () => {
    if (state.open) return;
    state.open = true;
    el.classList.add('open');
    popover.hidden = false;
    portalParent = popover.parentNode;
    portalNextSibling = popover.nextSibling;
    document.body.appendChild(popover);
    state.activeIdx = Math.max(0, state.options.findIndex(o => o.value === state.value));
    renderPopover();
    reposition();
    setTimeout(() => document.addEventListener('mousedown', onDocDown, true), 0);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition, true);
  };

  const close = () => {
    if (!state.open) return;
    state.open = false;
    el.classList.remove('open');
    popover.hidden = true;
    popover.style.position = '';
    popover.style.left = '';
    popover.style.top = '';
    popover.style.width = '';
    popover.style.zIndex = '';
    // Restore popover to its original parent if that parent is still
    // attached to the document. If the host widget got removed mid-open
    // (e.g., the detail page re-rendered and replaced our slot), just
    // detach the popover so it doesn't dangle on document.body.
    if (portalParent) {
      if (portalParent.isConnected) {
        portalParent.insertBefore(popover, portalNextSibling);
      } else if (popover.parentNode) {
        popover.parentNode.removeChild(popover);
      }
      portalParent = null;
      portalNextSibling = null;
    }
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', reposition, true);
    window.removeEventListener('resize', reposition, true);
  };

  const onDocDown = (e) => {
    if (!el.contains(e.target) && !popover.contains(e.target)) close();
  };
  const onKey = (e) => {
    // IME composition guard (CLAUDE.md §8): the popover keydown listener
    // is on `document`, so a Chinese / Japanese / Korean composition in an
    // adjacent input would otherwise commit its Enter into "pick the
    // active option" of this select.
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') { close(); e.preventDefault(); }
    else if (e.key === 'ArrowDown') {
      state.activeIdx = Math.min(state.options.length - 1, state.activeIdx + 1);
      renderPopover();
      e.preventDefault();
    } else if (e.key === 'ArrowUp') {
      state.activeIdx = Math.max(0, state.activeIdx - 1);
      renderPopover();
      e.preventDefault();
    } else if (e.key === 'Enter') {
      if (state.activeIdx >= 0 && state.activeIdx < state.options.length) {
        _aiSelectPick(api, state.options[state.activeIdx].value);
        e.preventDefault();
      }
    }
  };

  trigger.addEventListener('click', () => state.open ? close() : open());

  const api = {
    el,
    state,
    setOptions(options, { value, placeholder } = {}) {
      state.options = options || [];
      if (typeof value === 'string') state.value = value;
      if (typeof placeholder === 'string') state.placeholder = placeholder;
      // Normalize value if not in options
      if (state.value && !state.options.some(o => o.value === state.value)) state.value = '';
      renderTrigger();
      if (state.open) renderPopover();
    },
    setValue(value) {
      state.value = value || '';
      renderTrigger();
    },
    getValue() { return state.value; },
    onChange(fn) { state.onChange = typeof fn === 'function' ? fn : () => {}; },
    close,
  };

  renderTrigger();
  return api;
}

function _aiSelectPick(api, value) {
  const prev = api.state.value;
  api.state.value = value || '';
  api.el.dataset.value = api.state.value;
  api.close();
  if (prev !== api.state.value) {
    try { api.state.onChange(api.state.value); } catch (_) {}
  }
  const labelEl = api.el.querySelector('.ai-select-label');
  const opt = api.state.options.find(o => o.value === api.state.value);
  if (labelEl) {
    if (opt) {
      labelEl.textContent = opt.label;
      labelEl.classList.remove('placeholder');
    } else {
      labelEl.textContent = api.state.placeholder;
      labelEl.classList.add('placeholder');
    }
  }
}

// Test bridge — guarded CommonJS export of pure helpers. No-op in the
// browser (`module` undefined). Per PC/CLAUDE.md §9 only pure functions go
// through this bridge; the rest of utils.js (DOM-coupled helpers like
// `_aiSelectMount`) stays unexported.
// Matching tests: `utils-autolink.test.ts`, `utils-ai-select.test.ts`.
if (typeof module !== 'undefined' && typeof module.exports === 'object') {
  module.exports = {
    _BARE_URL_RE,
    _BARE_EMAIL_RE,
    _linkifyBareUrls,
    _linkifyBareEmails,
    normalizeDisplayText,
    pickDesc,
    inlineFormat,
    _markdownImageHtml,
    _markdownVideoHtml,
    escapeHtml,
    sanitizeHtml,
    _safeHref,
    _SAFE_URI_RE,
    renderMarkdown,
    renderDashboard,
    _parseDashboardSpec,
    sanitizeMathExpressionForMathJax,
    _aiSelectNextZIndex,
  };
}
