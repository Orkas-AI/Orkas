// Shared naming length limit.
// Rule: ASCII / half-width counts as 1; CJK, Japanese kana, full-width
// punctuation, and emoji count as 2. Max 60 units = 60 English chars or
// about 30 Chinese/Japanese chars. IME composition is never interrupted;
// enforcement runs after the final composed text is committed.

const NAME_DISPLAY_MAX_UNITS = 60;

function _nameGraphemes(text) {
  const s = String(text || '');
  try {
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
      return Array.from(seg.segment(s), (part) => part.segment);
    }
  } catch (_) { /* fall through */ }
  return Array.from(s);
}

function _nameCodePointWidth(cp) {
  if (!Number.isFinite(cp)) return 1;
  if ((cp >= 0x0300 && cp <= 0x036f) || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x11ff) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xffef) ||
    (cp >= 0x1f300 && cp <= 0x1faff)
  ) return 2;
  return 1;
}

function nameDisplayWidth(text) {
  let total = 0;
  for (const cluster of _nameGraphemes(text)) {
    let w = 0;
    for (const ch of Array.from(cluster)) {
      w = Math.max(w, _nameCodePointWidth(ch.codePointAt(0)));
    }
    total += w || 1;
  }
  return total;
}

function limitNameDisplayText(text, maxUnits = NAME_DISPLAY_MAX_UNITS) {
  let total = 0;
  let out = '';
  for (const cluster of _nameGraphemes(text)) {
    let w = 0;
    for (const ch of Array.from(cluster)) {
      w = Math.max(w, _nameCodePointWidth(ch.codePointAt(0)));
    }
    w = w || 1;
    if (total + w > maxUnits) break;
    out += cluster;
    total += w;
  }
  return out;
}

function _setEditableCaretToEnd(el) {
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  } catch (_) { /* best effort */ }
}

function enforceNameLimitOnControl(el, maxUnits = NAME_DISPLAY_MAX_UNITS) {
  if (!el) return '';
  const isEditable = !!el.isContentEditable;
  const raw = isEditable ? el.innerText : el.value;
  const limited = limitNameDisplayText(raw, maxUnits);
  if (limited !== raw) {
    if (isEditable) {
      el.innerText = limited;
      _setEditableCaretToEnd(el);
    } else {
      el.value = limited;
      try { el.setSelectionRange(limited.length, limited.length); } catch (_) {}
    }
  }
  return limited;
}

function bindNameLimitControl(el, maxUnits = NAME_DISPLAY_MAX_UNITS) {
  if (!el || el.dataset.nameLimitBound === '1') return;
  el.dataset.nameLimitBound = '1';
  let composing = false;
  el.addEventListener('compositionstart', () => { composing = true; });
  el.addEventListener('compositionend', () => {
    composing = false;
    enforceNameLimitOnControl(el, maxUnits);
  });
  el.addEventListener('input', () => {
    if (composing) return;
    enforceNameLimitOnControl(el, maxUnits);
  });
  enforceNameLimitOnControl(el, maxUnits);
}

window.NAME_DISPLAY_MAX_UNITS = NAME_DISPLAY_MAX_UNITS;
window.nameDisplayWidth = nameDisplayWidth;
window.limitNameDisplayText = limitNameDisplayText;
window.enforceNameLimitOnControl = enforceNameLimitOnControl;
window.bindNameLimitControl = bindNameLimitControl;
