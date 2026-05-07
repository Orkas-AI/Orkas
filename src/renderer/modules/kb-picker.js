// ─── KB picker ─────────────────────────────────────────────────────────────
// A small modal for "pick a knowledge-base directory + filename, then confirm".
// Used by the chat-archive flow (conversation.js) and any future caller that
// needs to drop a file into the KB at a user-chosen location.
//
// Public API:
//   pickKbLocation({ defaultName, defaultDir?, title? })
//     → Promise<{ path: string } | null>  // null = user cancelled
//
// Persistence: the last-selected directory is remembered in localStorage so
// the next archive starts where the user left off. Keyed globally since the
// app currently has a single active uid.
const _kbPickerLog = createLogger('kb-picker');
const KB_PICKER_LAST_DIR_KEY = 'kb-picker.last-dir';

let _kbPickerResolve = null;
let _kbPickerCurrentDir = '';     // '' = root
let _kbPickerExpanded = new Set();
let _kbPickerTree = [];

/**
 * Open the picker. Resolves with `{ path }` where `path` is KB-relative
 * (e.g. "notes/meeting.md"); resolves with `null` on cancel or background
 * click.
 */
async function pickKbLocation(opts = {}) {
  if (_kbPickerResolve) {
    // Only one picker at a time — reject older callers.
    _kbPickerResolve(null);
    _kbPickerResolve = null;
  }
  await _kbPickerLoadTree();

  const defaultDir = opts.defaultDir != null
    ? String(opts.defaultDir)
    : (localStorage.getItem(KB_PICKER_LAST_DIR_KEY) || '');
  _kbPickerCurrentDir = _kbPickerDirExists(defaultDir) ? defaultDir : '';

  // Expand the path down to the default dir so the user sees the selection.
  _kbPickerExpanded = new Set();
  if (_kbPickerCurrentDir) {
    const parts = _kbPickerCurrentDir.split('/');
    for (let i = 1; i <= parts.length; i++) {
      _kbPickerExpanded.add(parts.slice(0, i).join('/'));
    }
  }

  const modal = document.getElementById('kb-picker-modal');
  document.getElementById('kb-picker-title').textContent =
    opts.title || t('kb_picker.title');
  document.getElementById('kb-picker-name').value = opts.defaultName || '';
  document.getElementById('kb-picker-msg').textContent = '';
  _kbPickerRenderTree();
  _kbPickerRenderTarget();
  modal.classList.add('open');
  setTimeout(() => document.getElementById('kb-picker-name')?.focus(), 40);

  return new Promise((resolve) => { _kbPickerResolve = resolve; });
}
window.pickKbLocation = pickKbLocation;

async function _kbPickerLoadTree() {
  try {
    const res = await apiFetch('/api/contexts/tree');
    const data = await res.json();
    _kbPickerTree = data.ok ? (data.tree || []) : [];
  } catch (e) {
    _kbPickerLog.warn('tree fetch failed', e);
    _kbPickerTree = [];
  }
}

function _kbPickerDirExists(rel) {
  if (!rel) return true;   // root always exists
  const parts = rel.split('/');
  let level = _kbPickerTree;
  for (const p of parts) {
    const node = (level || []).find((n) => n.type === 'dir' && n.name === p);
    if (!node) return false;
    level = node.children || [];
  }
  return true;
}

function _kbPickerRenderTree() {
  const container = document.getElementById('kb-picker-tree');
  if (!container) return;
  const rootClass = _kbPickerCurrentDir === '' ? 'kb-picker-row active' : 'kb-picker-row';
  let html = `
    <div class="${rootClass}" data-kb-picker-dir="">
      <span class="kb-picker-caret kb-picker-caret-empty"></span>
      <span class="kb-picker-icon">${ICON_FOLDER_OPEN}</span>
      <span class="kb-picker-label">${escapeHtml(t('contexts.root_label'))}</span>
    </div>
  `;
  html += _kbPickerRenderNodes(_kbPickerTree, 0);
  container.innerHTML = html;
  _kbPickerBindTreeHandlers(container);
}

function _kbPickerRenderNodes(nodes, depth) {
  const indent = 18 + depth * 14;
  return nodes
    .filter((n) => n.type === 'dir')    // files aren't selectable here
    .map((n) => {
      const open = _kbPickerExpanded.has(n.path);
      const active = _kbPickerCurrentDir === n.path ? ' active' : '';
      const icon = open ? ICON_FOLDER_OPEN : ICON_FOLDER_CLOSED;
      const childrenHtml = open
        ? _kbPickerRenderNodes(n.children || [], depth + 1)
        : '';
      return `
        <div class="kb-picker-row${active}" data-kb-picker-dir="${escapeHtml(n.path)}" style="padding-left:${indent}px">
          <span class="kb-picker-caret"></span>
          <span class="kb-picker-icon">${icon}</span>
          <span class="kb-picker-label">${escapeHtml(n.name)}</span>
        </div>
        ${childrenHtml}
      `;
    }).join('');
}

function _kbPickerBindTreeHandlers(container) {
  container.querySelectorAll('.kb-picker-row').forEach((row) => {
    const rel = row.getAttribute('data-kb-picker-dir');
    row.addEventListener('click', (e) => {
      if (e.target.closest('.kb-picker-caret') && !e.target.classList.contains('kb-picker-caret-empty')) {
        e.stopPropagation();
        if (rel && _kbPickerExpanded.has(rel)) _kbPickerExpanded.delete(rel);
        else if (rel) _kbPickerExpanded.add(rel);
        _kbPickerRenderTree();
        return;
      }
      _kbPickerCurrentDir = rel || '';
      _kbPickerRenderTree();
      _kbPickerRenderTarget();
    });
  });
}

function _kbPickerRenderTarget() {
  const el = document.getElementById('kb-picker-target');
  if (!el) return;
  const label = _kbPickerCurrentDir
    ? `${_kbPickerCurrentDir}/`
    : t('contexts.root_label');
  el.textContent = t('kb_picker.target', { rel: label });
}

function closeKbPicker() {
  document.getElementById('kb-picker-modal').classList.remove('open');
  if (_kbPickerResolve) {
    const resolve = _kbPickerResolve;
    _kbPickerResolve = null;
    resolve(null);
  }
}
window.closeKbPicker = closeKbPicker;

// Mirror of `features/contexts.ts::MAX_BASENAME_WEIGHT` + `_filenameWeight`.
// Re-implemented in JS because main and renderer don't share modules; the
// values must stay in lockstep — bump together. CJK / Hangul / Kana are
// double-weight so a single budget gives ~50 chars to Chinese filenames and
// ~100 chars to English filenames.
const _KB_NAME_MAX_WEIGHT = 100;
const _KB_NAME_DOUBLE_WIDTH_RE = /[㐀-鿿가-힯぀-ゟ゠-ヿ]/;
function _kbNameWeight(s) {
  let w = 0;
  for (const ch of s) {
    w += _KB_NAME_DOUBLE_WIDTH_RE.test(ch) ? 2 : 1;
  }
  return w;
}

async function confirmKbPicker() {
  const rawName = (document.getElementById('kb-picker-name').value || '').trim();
  const msg = document.getElementById('kb-picker-msg');
  msg.className = 'form-msg';
  if (!rawName) {
    msg.textContent = t('kb_picker.name_needed');
    msg.className = 'form-msg err';
    return;
  }
  if (rawName.includes('/') || rawName.includes('\\') || rawName.includes('..')) {
    msg.textContent = t('kb_picker.name_bad_chars');
    msg.className = 'form-msg err';
    return;
  }
  let name = rawName;
  if (!/\.[a-z0-9]+$/i.test(name)) name += '.md';
  // Length cap (post-extension). Server enforces the same rule via
  // resolvePath; this branch is the early-feedback for the user so we
  // don't burn a network round-trip on a guaranteed-fail case.
  if (_kbNameWeight(name) > _KB_NAME_MAX_WEIGHT) {
    msg.textContent = t('kb_picker.name_too_long', { name });
    msg.className = 'form-msg err';
    return;
  }
  const fullPath = _kbPickerCurrentDir ? `${_kbPickerCurrentDir}/${name}` : name;

  try {
    localStorage.setItem(KB_PICKER_LAST_DIR_KEY, _kbPickerCurrentDir);
  } catch { /* private-mode / quota — non-fatal */ }

  document.getElementById('kb-picker-modal').classList.remove('open');
  if (_kbPickerResolve) {
    const resolve = _kbPickerResolve;
    _kbPickerResolve = null;
    resolve({ path: fullPath });
  }
}
window.confirmKbPicker = confirmKbPicker;

/**
 * Derive a default filename stem from message content. Strips markdown
 * decorations + path-hostile characters so the result is filesystem-safe,
 * then truncates by **weight** (CJK = 2, others = 1) so Chinese gets ~30
 * chars and English gets ~60 chars from the same budget. Without the
 * weight split, "first N code points" gives English a useless prefix
 * like "This is the way to" (20 chars ≈ 3-4 words). Caller seeds the
 * picker input; the user can edit before confirm. Final length is
 * server-validated against `MAX_BASENAME_WEIGHT` (=100), so the seed
 * always fits with headroom for edits.
 */
const _KB_DEFAULT_NAME_WEIGHT = 60;

function deriveKbArchiveName(text) {
  const cleaned = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[#*_`>\-]+/g, ' ')
    .replace(/\[(.+?)\]\([^)]*\)/g, '$1')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Walk by code point so emoji / surrogate pairs aren't split mid-glyph.
  let w = 0;
  let out = '';
  for (const ch of cleaned) {
    const cw = _KB_NAME_DOUBLE_WIDTH_RE.test(ch) ? 2 : 1;
    if (w + cw > _KB_DEFAULT_NAME_WEIGHT) break;
    w += cw;
    out += ch;
  }
  // For ASCII text we likely cut mid-word; round back to the last space if
  // it's within 12 chars (= one short word's worth) so the seed reads
  // naturally instead of "the meet" → "the". CJK has no word boundaries,
  // so skip the rounding (the last space might be 30+ chars back).
  const lastSpace = out.lastIndexOf(' ');
  const tailHasNoCjk = lastSpace > 0 && !_KB_NAME_DOUBLE_WIDTH_RE.test(out);
  if (tailHasNoCjk && out.length - lastSpace <= 12 && out.length - lastSpace > 0) {
    out = out.slice(0, lastSpace);
  }
  out = out.trim();
  if (out) return out;
  const n = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `archive-${n.getFullYear()}${p(n.getMonth() + 1)}${p(n.getDate())}-${p(n.getHours())}${p(n.getMinutes())}`;
}
window.deriveKbArchiveName = deriveKbArchiveName;
