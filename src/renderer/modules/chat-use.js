// ─── Chat-input inline use chips ──────────────────────────────────────────
//
// Skills and connectors are stored directly in the textarea as compact tokens
// and rendered by the conversation mirror as inline chips. The textarea stays
// the source of truth, so native selection / IME / undo keep working while the
// send path can expand tokens into localized plain text.

const _chatUse = { 'new-chat': null, 'conversation': null, project: null, auto: null };
const _CHAT_USE_TOKEN_OPEN = '@{';
const _CHAT_USE_TOKEN_KINDS = new Set(['skill', 'connector']);
const _CHAT_USE_TOKEN_START = '\u2063';
const _CHAT_USE_TOKEN_META = '\u2062';
const _CHAT_USE_TOKEN_END = '\u2064';
const _CHAT_USE_TOKEN_ZERO = '\u200B';
const _CHAT_USE_TOKEN_ONE = '\u200C';
const _CHAT_USE_TOKEN_PAD = '  ';

function bindSkillPicker() {
  // Chip remove (×)
  document.querySelectorAll('.chat-skill-chip .chip-close').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const chip = el.closest('.chat-skill-chip');
      if (chip) setChatUseSelection(chip.dataset.target, null);
    });
  });
  ['new-chat-input', 'chat-input', 'project-chat-input', 'auto-task-input'].forEach((id) => {
    const input = document.getElementById(id);
    if (!input || input.dataset.chatUseTokenBound === '1') return;
    input.dataset.chatUseTokenBound = '1';
    input.addEventListener('keydown', _onChatUseTokenKeydown);
  });
}

function _normalizeChatUseSelection(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const name = value.trim();
    return name ? { kind: 'skill', id: name, name } : null;
  }
  if (typeof value !== 'object') return null;
  const kind = value.kind === 'connector' ? 'connector' : (value.kind === 'skill' ? 'skill' : '');
  if (!kind) return null;
  const name = String(value.name || value.id || '').trim();
  const id = String(value.id || name).trim();
  if (!name && !id) return null;
  return { kind, id: id || name, name: name || id };
}

function _normalizeChatUseSelections(value) {
  if (!value) return [];
  const raw = Array.isArray(value) ? value : [value];
  const out = [];
  const seen = new Set();
  raw.forEach((item) => {
    const sel = _normalizeChatUseSelection(item);
    if (!sel) return;
    const key = `${sel.kind}:${sel.id || sel.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(sel);
  });
  return out;
}

function _chatUseInputForTarget(target) {
  const id = target === 'new-chat'
    ? 'new-chat-input'
    : (target === 'project' ? 'project-chat-input' : (target === 'auto' ? 'auto-task-input' : 'chat-input'));
  return document.getElementById(id);
}

function _chatUseAutoGrowMax(target) {
  if (target === 'auto') return 220;
  return target === 'new-chat' ? 260 : (target === 'project' ? 180 : 200);
}

function _escapeChatUseTokenValue(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/\}/g, '\\}');
}

function _unescapeChatUseTokenValue(value) {
  let out = '';
  let escaped = false;
  for (const ch of String(value || '')) {
    if (escaped) {
      out += ch;
      escaped = false;
    } else if (ch === '\\') {
      escaped = true;
    } else {
      out += ch;
    }
  }
  if (escaped) out += '\\';
  return out;
}

function _chatUseTokenFor(selection) {
  const sel = _normalizeChatUseSelection(selection);
  if (!sel) return '';
  const visible = _chatUseVisibleTokenText(sel);
  const encoded = _encodeChatUseTokenMeta(sel);
  if (!visible || !encoded) return '';
  return `${_CHAT_USE_TOKEN_START}${visible}${_CHAT_USE_TOKEN_PAD}${_CHAT_USE_TOKEN_META}${encoded}${_CHAT_USE_TOKEN_END}`;
}

function _chatUseVisibleTokenText(selection) {
  const parts = _chatUseLabelParts(selection);
  if (parts && parts.label) return parts.label;
  return formatChatUseLabel(selection);
}

function _encodeChatUseTokenMeta(selection) {
  const sel = _normalizeChatUseSelection(selection);
  if (!sel) return '';
  const payload = encodeURIComponent(JSON.stringify(sel));
  let out = '';
  for (let i = 0; i < payload.length; i += 1) {
    const code = payload.charCodeAt(i);
    for (let bit = 7; bit >= 0; bit -= 1) {
      out += (code & (1 << bit)) ? _CHAT_USE_TOKEN_ONE : _CHAT_USE_TOKEN_ZERO;
    }
  }
  return out;
}

function _decodeChatUseTokenMeta(encoded) {
  const raw = String(encoded || '');
  if (!raw) return null;
  let payload = '';
  for (let i = 0; i + 7 < raw.length; i += 8) {
    let code = 0;
    for (let bit = 0; bit < 8; bit += 1) {
      const ch = raw.charAt(i + bit);
      if (ch !== _CHAT_USE_TOKEN_ZERO && ch !== _CHAT_USE_TOKEN_ONE) return null;
      code = (code << 1) | (ch === _CHAT_USE_TOKEN_ONE ? 1 : 0);
    }
    payload += String.fromCharCode(code);
  }
  try {
    return _normalizeChatUseSelection(JSON.parse(decodeURIComponent(payload)));
  } catch (_) {
    return null;
  }
}

function _findMarkedChatUseTokens(text) {
  const src = String(text || '');
  const tokens = [];
  let pos = 0;
  while (pos < src.length) {
    const start = src.indexOf(_CHAT_USE_TOKEN_START, pos);
    if (start < 0) break;
    const metaStart = src.indexOf(_CHAT_USE_TOKEN_META, start + _CHAT_USE_TOKEN_START.length);
    const end = metaStart >= 0 ? src.indexOf(_CHAT_USE_TOKEN_END, metaStart + _CHAT_USE_TOKEN_META.length) : -1;
    if (metaStart < 0 || end < 0) {
      pos = start + _CHAT_USE_TOKEN_START.length;
      continue;
    }
    const selection = _decodeChatUseTokenMeta(src.slice(metaStart + _CHAT_USE_TOKEN_META.length, end));
    if (selection) {
      tokens.push({
        start,
        end: end + _CHAT_USE_TOKEN_END.length,
        raw: src.slice(start, end + _CHAT_USE_TOKEN_END.length),
        selection,
      });
    }
    pos = end + _CHAT_USE_TOKEN_END.length;
  }
  return tokens;
}

function _findLegacyChatUseTokens(text) {
  const src = String(text || '');
  const tokens = [];
  let pos = 0;
  while (pos < src.length) {
    const start = src.indexOf(_CHAT_USE_TOKEN_OPEN, pos);
    if (start < 0) break;
    const kindStart = start + _CHAT_USE_TOKEN_OPEN.length;
    const colon = src.indexOf(':', kindStart);
    if (colon < 0) break;
    const kind = src.slice(kindStart, colon);
    if (!_CHAT_USE_TOKEN_KINDS.has(kind)) {
      pos = kindStart;
      continue;
    }
    let raw = '';
    let escaped = false;
    let end = -1;
    for (let i = colon + 1; i < src.length; i += 1) {
      const ch = src.charAt(i);
      if (escaped) {
        raw += '\\' + ch;
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '}') {
        end = i + 1;
        break;
      }
      raw += ch;
    }
    if (end < 0) {
      pos = kindStart;
      continue;
    }
    const name = _unescapeChatUseTokenValue(raw).trim();
    if (name) {
      tokens.push({
        start,
        end,
        raw: src.slice(start, end),
        selection: { kind, id: name, name },
      });
    }
    pos = end;
  }
  return tokens;
}

function _findChatUseTokens(text) {
  return _findMarkedChatUseTokens(text)
    .concat(_findLegacyChatUseTokens(text))
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

function _chatUseSelectionsFromText(text) {
  return _findChatUseTokens(text).map((token) => token.selection);
}

// Persistable representation for surfaces such as Automation that must retain
// the exact order of message text and multiple inline resource chips. Tokens
// remain a composer-only implementation detail; stored data uses plain JSON.
function chatUseMessagePartsFromText(text) {
  const src = String(text || '');
  const tokens = _findChatUseTokens(src);
  if (!tokens.length) return null;
  const parts = [];
  let last = 0;
  tokens.forEach((token) => {
    if (token.start > last) parts.push({ type: 'text', text: src.slice(last, token.start) });
    const selection = _normalizeChatUseSelection(token.selection);
    if (selection) {
      parts.push({
        type: 'use',
        kind: selection.kind,
        id: selection.id,
        name: selection.name,
      });
    }
    last = token.end;
  });
  if (last < src.length) parts.push({ type: 'text', text: src.slice(last) });
  return parts;
}

function chatUseTextFromMessageParts(parts) {
  if (!Array.isArray(parts) || !parts.length) return '';
  let out = '';
  let hasUse = false;
  for (const part of parts) {
    if (!part || typeof part !== 'object') return '';
    if (part.type === 'text') {
      if (typeof part.text !== 'string') return '';
      out += part.text;
      continue;
    }
    if (part.type !== 'use') return '';
    const selection = _normalizeChatUseSelection(part);
    if (!selection) return '';
    const token = _chatUseTokenFor(selection);
    if (!token) return '';
    out += token;
    hasUse = true;
  }
  return hasUse ? out : '';
}

function getChatUseSelections(target) {
  const input = _chatUseInputForTarget(target);
  const fromText = input ? _chatUseSelectionsFromText(input.value || '') : [];
  const legacy = _normalizeChatUseSelection(_chatUse[target]);
  return legacy ? fromText.concat([legacy]) : fromText;
}

function getChatUseSelection(target) {
  const cur = getChatUseSelections(target)[0] || null;
  return cur ? { ...cur } : null;
}

function formatChatUseLabel(selection) {
  const sel = _normalizeChatUseSelection(selection);
  if (!sel) return '';
  if (sel.kind === 'connector') return t('connectors.use_label', { connector: sel.name || sel.id });
  return t('skills.use_label', { skill: sel.name || sel.id });
}

function _chatUseLabelParts(selection) {
  const sel = _normalizeChatUseSelection(selection);
  if (!sel) return null;
  const name = sel.name || sel.id;
  const token = sel.kind === 'connector' ? 'connector' : 'skill';
  const key = sel.kind === 'connector' ? 'connectors.use_label' : 'skills.use_label';
  return {
    name,
    label: t(key, { [token]: name }),
    prefix: t(key, { [token]: '' }),
  };
}

function _renderChatUseChipLabel(labelEl, selection) {
  if (!labelEl) return;
  labelEl.textContent = '';
  labelEl.removeAttribute('title');
  const parts = _chatUseLabelParts(selection);
  if (!parts) return;

  const prefixEl = document.createElement('span');
  prefixEl.className = 'chip-label-prefix';
  prefixEl.textContent = parts.prefix;

  const nameEl = document.createElement('span');
  nameEl.className = 'chip-label-name';
  nameEl.textContent = parts.name;

  labelEl.append(prefixEl, nameEl);
  labelEl.title = parts.label;
}

function _renderChatUseChip(target) {
  if (target === 'auto') return;
  const next = _normalizeChatUseSelection(_chatUse[target]);
  const chipId = target === 'new-chat'
    ? 'new-chat-skill-chip'
    : (target === 'project' ? 'project-chat-skill-chip' : 'chat-skill-chip');
  const chip = document.getElementById(chipId);
  if (!chip) return;
  if (!next) {
    chip.style.display = 'none';
    chip.classList.remove('is-skill', 'is-connector');
    delete chip.dataset.kind;
    delete chip.dataset.itemId;
    const lbl = chip.querySelector('.chip-label');
    _renderChatUseChipLabel(lbl, null);
    return;
  }
  chip.style.display = 'inline-flex';
  chip.classList.toggle('is-skill', next.kind === 'skill');
  chip.classList.toggle('is-connector', next.kind === 'connector');
  chip.dataset.kind = next.kind;
  chip.dataset.itemId = next.id || '';
  const lbl = chip.querySelector('.chip-label');
  _renderChatUseChipLabel(lbl, next);
}

function refreshChatUseChips() {
  _renderChatUseChip('new-chat');
  _renderChatUseChip('conversation');
  _renderChatUseChip('project');
}

function isChatUseAllowedForTarget(target, kind) {
  if (!target || !kind) return false;
  // Commander and agent recipients now share the same skill/connector surface.
  // Live connector availability is still checked when the draft is consumed.
  return true;
}

function _chatUseDispatchInput(input, target) {
  if (typeof autoGrow === 'function') autoGrow(input, _chatUseAutoGrowMax(target));
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function _insertChatUseToken(target, selection) {
  const sel = _normalizeChatUseSelection(selection);
  if (!sel) return false;
  const input = _chatUseInputForTarget(target);
  if (!input) return false;
  if (typeof insertChatUseTokenIntoComposer === 'function' && insertChatUseTokenIntoComposer(input, sel)) {
    return true;
  }
  const token = _chatUseTokenFor(sel);
  if (!token) return false;
  const value = String(input.value || '');
  const start = typeof input.selectionStart === 'number' ? input.selectionStart : value.length;
  const end = typeof input.selectionEnd === 'number' ? input.selectionEnd : start;
  const before = value.slice(0, start);
  const after = value.slice(end);
  const leading = before && !/\s$/.test(before) ? ' ' : '';
  const trailing = after && /^\s/.test(after) ? '' : ' ';
  const replacement = `${leading}${token}${trailing}`;
  if (typeof input.setRangeText === 'function') {
    input.setRangeText(replacement, start, end, 'end');
  } else {
    input.value = `${before}${replacement}${after}`;
    input.selectionStart = input.selectionEnd = start + replacement.length;
  }
  _chatUseDispatchInput(input, target);
  return true;
}

function _removeChatUseTokensFromInput(target) {
  const input = _chatUseInputForTarget(target);
  if (!input) return false;
  const value = String(input.value || '');
  const tokens = _findChatUseTokens(value);
  if (!tokens.length) return false;
  let out = '';
  let last = 0;
  tokens.forEach((token) => {
    out += value.slice(last, token.start);
    last = token.end;
  });
  out += value.slice(last);
  input.value = out.replace(/[ \t]{2,}/g, ' ').trimStart();
  try {
    const caret = Math.min(input.value.length, tokens[0].start);
    input.setSelectionRange(caret, caret);
  } catch (_) {}
  _chatUseDispatchInput(input, target);
  return true;
}

function setChatUseSelection(target, selection, opts = {}) {
  const prev = JSON.stringify(_normalizeChatUseSelection(_chatUse[target]) || null);
  const normalized = _normalizeChatUseSelection(selection);
  const next = normalized && isChatUseAllowedForTarget(target, normalized.kind) ? normalized : null;
  _chatUse[target] = null;
  if (next) _insertChatUseToken(target, next);
  else _removeChatUseTokensFromInput(target);
  if (target === 'conversation' && prev !== JSON.stringify(next || null) && currentCid) {
    _saveDraft(currentCid);
  }
  _renderChatUseChip(target);
  // Return focus to the textarea after selection.
  if (opts && opts.focus === false) return;
  const input = target === 'new-chat'
    ? document.getElementById('new-chat-input')
    : (target === 'project' ? document.getElementById('project-chat-input') : (target === 'auto' ? document.getElementById('auto-task-input') : document.getElementById('chat-input')));
  if (typeof focusChatRichComposer === 'function' && focusChatRichComposer(input)) return;
  input?.focus();
}

function setChatSkill(target, idOrName, maybeName) {
  const id = String(idOrName || maybeName || '').trim();
  const name = String(maybeName || idOrName || '').trim();
  setChatUseSelection(target, id || name ? { kind: 'skill', id: id || name, name: name || id } : null);
}

function setChatConnector(target, connectorId, connectorName) {
  const id = String(connectorId || connectorName || '').trim();
  const name = String(connectorName || connectorId || '').trim();
  setChatUseSelection(target, id || name ? { kind: 'connector', id: id || name, name: name || id } : null);
}

function consumeChatSkill(target) {
  const sel = getChatUseSelection(target);
  return sel && sel.kind === 'skill' ? (sel.name || sel.id) : '';
}

function consumeChatUseSelection(target) {
  const sel = getChatUseSelection(target);
  return sel && isChatUseAllowedForTarget(target, sel.kind) ? sel : null;
}

function consumeChatUseSelections(target) {
  return getChatUseSelections(target).filter((sel) => sel && isChatUseAllowedForTarget(target, sel.kind));
}

function transformWithSkill(content, skill) {
  if (!skill) return content;
  return t('skills.use_prefix', { skill, content });
}

function _localizedChatUseText(key, params, fallback) {
  const text = (typeof t === 'function') ? t(key, params) : '';
  return text && text !== key ? text : fallback;
}

function _chatUseInlineText(selection) {
  const sel = _normalizeChatUseSelection(selection);
  if (!sel) return '';
  const name = sel.name || sel.id;
  if (sel.kind === 'connector') {
    return _localizedChatUseText('connectors.inline_text', { connector: name }, `${name} connector`);
  }
  return _localizedChatUseText('skills.inline_text', { skill: name }, `${name} skill`);
}

function _replaceChatUseTokens(content, mapper) {
  const text = String(content || '');
  const tokens = _findChatUseTokens(text);
  if (!tokens.length) return text;
  let out = '';
  let last = 0;
  tokens.forEach((token) => {
    out += text.slice(last, token.start);
    out += mapper(token.selection, token);
    last = token.end;
  });
  out += text.slice(last);
  return out;
}

function transformChatUseTokens(content) {
  return _replaceChatUseTokens(content, (selection) => _chatUseInlineText(selection));
}

function transformWithChatUse(content, selection) {
  let out = transformChatUseTokens(content);
  const selections = _normalizeChatUseSelections(selection);
  selections.forEach((sel) => {
    if (sel.kind === 'connector') {
      out = t('connectors.use_prefix', { connector: sel.name || sel.id, content: out });
    } else {
      out = transformWithSkill(out, sel.name || sel.id);
    }
  });
  return out;
}

function formatChatUseTextForDisplay(content) {
  return _replaceChatUseTokens(content, (selection) => formatChatUseLabel(selection));
}

function _renderChatUseMirrorHtml(text, renderPlainHtml) {
  const renderer = typeof renderPlainHtml === 'function'
    ? renderPlainHtml
    : ((value) => escapeHtml(value));
  const src = String(text || '');
  const tokens = _findChatUseTokens(src);
  if (!tokens.length) return renderer(src);
  let html = '';
  let last = 0;
  tokens.forEach((token) => {
    if (token.start > last) html += renderer(src.slice(last, token.start));
    const parts = _chatUseLabelParts(token.selection);
    const cls = token.selection.kind === 'connector' ? 'is-connector' : 'is-skill';
    const title = parts ? parts.label : formatChatUseLabel(token.selection);
    html += `<span class="chat-use-inline-chip ${cls}" title="${escapeHtml(title)}">`;
    if (parts) {
      html += `<span class="chat-use-inline-prefix">${escapeHtml(parts.prefix)}</span>`;
      html += `<span class="chat-use-inline-name">${escapeHtml(parts.name)}</span>`;
    } else {
      html += escapeHtml(title);
    }
    html += '</span>';
    last = token.end;
  });
  if (last < src.length) html += renderer(src.slice(last));
  return html;
}

function _chatUseTokenDeleteRange(input, direction) {
  if (!input || typeof input.selectionStart !== 'number') return false;
  const value = String(input.value || '');
  const tokens = _findChatUseTokens(value);
  if (!tokens.length) return false;

  if (input.selectionStart !== input.selectionEnd) {
    let start = input.selectionStart;
    let end = input.selectionEnd;
    let touched = false;
    tokens.forEach((token) => {
      if (token.start < end && start < token.end) {
        start = Math.min(start, token.start);
        end = Math.max(end, token.end);
        touched = true;
      }
    });
    return touched ? { start, end } : null;
  }

  const caret = input.selectionStart;
  const hit = tokens.find((token) => {
    if (caret > token.start && caret < token.end) return true;
    if (direction === 'forward') return token.start === caret;
    return token.end === caret || (caret === token.end + 1 && value.charAt(token.end) === ' ');
  });
  return hit ? { start: hit.start, end: hit.end } : null;
}

function _deleteChatUseTokenAtCaret(input, direction) {
  const range = _chatUseTokenDeleteRange(input, direction);
  if (!range) return false;
  const value = String(input.value || '');
  let { start, end } = range;
  if (value.charAt(end) === ' ') end += 1;
  else if (start > 0 && value.charAt(start - 1) === ' ') start -= 1;
  input.value = value.slice(0, start) + value.slice(end);
  try { input.setSelectionRange(start, start); } catch (_) {}
  const target = input.id === 'new-chat-input'
    ? 'new-chat'
    : (input.id === 'project-chat-input' ? 'project' : (input.id === 'auto-task-input' ? 'auto' : 'conversation'));
  _chatUseDispatchInput(input, target);
  return true;
}

function _chatUseTokenMoveTarget(text, caret, direction) {
  const value = String(text || '');
  const pos = Number(caret);
  if (!Number.isFinite(pos)) return null;
  const tokens = _findChatUseTokens(value);
  const hit = tokens.find((token) => {
    if (direction === 'forward') return pos >= token.start && pos < token.end;
    return (pos > token.start && pos <= token.end)
      || (pos === token.end + 1 && value.charAt(token.end) === ' ');
  });
  if (!hit) return null;
  return direction === 'forward' ? hit.end : hit.start;
}

function _moveChatUseTokenCaret(input, direction) {
  if (!input || typeof input.selectionStart !== 'number') return false;
  if (input.selectionStart !== input.selectionEnd) return false;
  const next = _chatUseTokenMoveTarget(input.value || '', input.selectionStart, direction);
  if (next === null || next === input.selectionStart) return false;
  try { input.setSelectionRange(next, next); } catch (_) {}
  return true;
}

function _onChatUseTokenKeydown(e) {
  if (e.key !== 'Backspace' && e.key !== 'Delete' && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    const direction = e.key === 'ArrowRight' ? 'forward' : 'backward';
    if (_moveChatUseTokenCaret(e.currentTarget, direction)) e.preventDefault();
    return;
  }
  const direction = e.key === 'Delete' ? 'forward' : 'backward';
  if (_deleteChatUseTokenAtCaret(e.currentTarget, direction)) e.preventDefault();
}


// Chat composers are part of the startup shell even though the Skills page is
// lazy. Bind token editing independently so opening Skills is never a
// prerequisite for sending, restoring drafts, or draining queued messages.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bindSkillPicker, { once: true });
} else {
  bindSkillPicker();
}
