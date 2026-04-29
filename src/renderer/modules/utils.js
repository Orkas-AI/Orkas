// ─── Utilities ───

/** Pick a skill / agent description for the active UI language with cross-
 *  language fallback. Mirrors `pickDescription` in core-agent's skills/types
 *  — keep these two in sync if the fallback rule changes.
 *
 *  `lang === 'zh'`: description_zh || description_en || ''. Mirror for 'en'.
 *  Cross-fallback guarantees a non-empty string whenever any side is filled,
 *  so users never see blank entries when only one locale was authored. */
function pickDesc(spec, lang) {
  if (!spec) return '';
  const zh = (spec.description_zh || '').trim();
  const en = (spec.description_en || '').trim();
  if (lang === 'zh') return zh || en || '';
  return en || zh || '';
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
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
  md = md.replace(/\$\$([\s\S]+?)\$\$/g, (_, expr) => protect(`$$${expr}$$`));
  md = md.replace(/\\\[([\s\S]+?)\\\]/g, (_, expr) => protect(`\\[${expr}\\]`));
  md = md.replace(/\\\(([\s\S]+?)\\\)/g, (_, expr) => protect(`\\(${expr}\\)`));
  md = md.replace(/(^|[^\\$])\$(?!\s|\d)([^\$\n]+?)\$(?!\d)/g,
    (_, pre, expr) => pre + protect(`$${expr}$`));

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
  return html;
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

// Detect video src by extension. Dispatches markdown ![](src) to <video>
// instead of <img> — covers chat-media://local/...mp4, https://..../clip.webm,
// and any user-authored markdown pointing at a video file. The match is
// against the last extension-looking segment so query strings / fragments
// don't defeat it.
const _VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v|ogv)(?:[?#].*)?$/i;
function _isVideoSrc(src) {
  return _VIDEO_EXT_RE.test(String(src || ''));
}

function inlineFormat(text) {
  return text
    // Media: ![alt](src) — dispatch to <video> when src looks like a video
    // file, else <img>. Must run before link syntax.
    .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
      (_, alt, src, title) => {
        const t = title ? ` title="${escapeHtml(title)}"` : '';
        if (_isVideoSrc(src)) {
          // `preload=metadata` so listings don't auto-fetch the whole file;
          // controls visible so user can play/seek.
          return `<video class="chat-md-video" controls preload="metadata" src="${src}"${t} aria-label="${escapeHtml(alt)}"></video>`;
        }
        return `<img class="chat-md-img" src="${src}" alt="${escapeHtml(alt)}"${t}>`;
      })
    // Markdown links: [text](url "title")
    .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
      (_, txt, url, title) =>
        `<a href="${url}" target="_blank" rel="noopener"${title ? ` title="${escapeHtml(title)}"` : ''}>${txt}</a>`)
    // <url> and <email> autolinks
    .replace(/<((?:https?:\/\/|mailto:)[^>\s]+)>/g,
      (_, u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`)
    .replace(/<([\w.+-]+@[\w.-]+\.[A-Za-z]{2,})>/g,
      (_, e) => `<a href="mailto:${e}">${e}</a>`)
    // Emphasis
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    // Bare URL autolink — negative lookbehind keeps us out of two cases:
    //   1) the URL is already inside an HTML attr (preceded by `"`/`'`/`=`)
    //      from earlier phases (markdown links, image src, etc.) — must NOT
    //      double-wrap;
    //   2) the URL is mid-string (preceded by URL-internal chars) — looks
    //      like the tail of a longer URL, skip to avoid splicing.
    // Everything else (CJK punctuation like `：`/`，`/`（`, ASCII letters,
    // line start) is allowed — the old `[\s([]` whitelist missed CJK
    // punctuation which is the most common case in Chinese chat output.
    .replace(/(?<![a-zA-Z0-9._\-:\/?=&#%+"'>])(https?:\/\/[^\s<>"'`)\]]+)/g, (_, url) => {
      const trail = (url.match(/[.,;:!?)]+$/) || [''])[0];
      const clean = trail ? url.slice(0, -trail.length) : url;
      return `<a href="${clean}" target="_blank" rel="noopener">${clean}</a>${trail}`;
    })
    // Bare email autolink — uses the same exclusion set as bare URL so that
    // an email already wrapped in an earlier `<a href="mailto:...">` (where
    // the address is preceded by `:`) doesn't get re-wrapped, and that an
    // address sitting inside a URL query like `?email=x@y.com` (preceded by
    // `=`) is left alone too.
    .replace(/(?<![a-zA-Z0-9._\-:\/?=&#%+"'>])([\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/g,
      (_, email) => `<a href="mailto:${email}">${email}</a>`);
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
document.addEventListener('click', (e) => {
  const a = e.target && e.target.closest && e.target.closest('a[href]');
  if (!a) return;
  const href = a.getAttribute('href');
  if (!/^https?:\/\//i.test(href || '')) return;
  if (!window.orkas || typeof window.orkas.invoke !== 'function') return;
  e.preventDefault();
  window.orkas.invoke('auth.openExternal', { url: href }).catch(() => {});
});

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

function _aiSelectMount(el, config) {
  if (!el) return null;
  const state = {
    options: [],        // [{value, label, hint?}]
    value: '',
    placeholder: (typeof t === 'function' ? t('ai_select.placeholder') : '— 请选择 —'),
    onChange: () => {},
    open: false,
    activeIdx: -1,
  };
  Object.assign(state, config || {});

  el.classList.add('ai-select');
  el.innerHTML = `
    <button type="button" class="ai-select-trigger" aria-haspopup="listbox">
      <span class="ai-select-label"></span>
      <svg class="ai-select-caret" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8">
        <path d="m4 6 4 4 4-4"></path>
      </svg>
    </button>
    <div class="ai-select-popover" role="listbox" hidden></div>
  `;

  const trigger = el.querySelector('.ai-select-trigger');
  const labelEl = el.querySelector('.ai-select-label');
  const popover = el.querySelector('.ai-select-popover');

  const renderTrigger = () => {
    const opt = state.options.find(o => o.value === state.value);
    if (opt) {
      labelEl.textContent = opt.label;
      labelEl.classList.remove('placeholder');
    } else {
      labelEl.textContent = state.placeholder;
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
      main.textContent = opt.label;
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

  const open = () => {
    if (state.open) return;
    state.open = true;
    el.classList.add('open');
    popover.hidden = false;
    state.activeIdx = Math.max(0, state.options.findIndex(o => o.value === state.value));
    renderPopover();
    setTimeout(() => document.addEventListener('mousedown', onDocDown, true), 0);
    document.addEventListener('keydown', onKey, true);
  };

  const close = () => {
    if (!state.open) return;
    state.open = false;
    el.classList.remove('open');
    popover.hidden = true;
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onKey, true);
  };

  const onDocDown = (e) => { if (!el.contains(e.target)) close(); };
  const onKey = (e) => {
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

