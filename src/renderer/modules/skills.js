const _skillsLog = createLogger('skills');
// ─── Skills ───

let _skillsCache = null;
// Read-only open-tier entries. External packages render as package cards,
// while machine-global folders still render their individual skills. Package
// SKILL.md files remain available to the agent layer, but are not expanded into
// a wall of user-facing recipe cards.
let _openSkillsCache = [];
let _packagesCache = [];
let _skillsLoadInFlight = null;
let _selectedSkill = null;    // { source, id }
let _expandedGlobalSkillGroups = new Set();
const _GLOBAL_SKILL_GROUP_MIN = 2;

function _skillSource(source) {
  return (typeof normalizeCatalogSource === 'function')
    ? normalizeCatalogSource(source)
    : String(source || '');
}

function _isSkillPlatformSource(source) {
  return (typeof isMarketplaceCatalogSource === 'function')
    ? isMarketplaceCatalogSource(source)
    : _skillSource(source) === 'marketplace';
}

function _skillUiIconHtml(name, className) {
  if (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function') {
    return window.uiIconHtml(name, className);
  }
  return '';
}

function _skillCardChipsHtml(s) {
  const lang = getLang();
  const parts = [];
  const isPlatform = _isSkillPlatformSource(s && s.source);
  if (isPlatform && s.version) {
    const versionLabel = t('marketplace.version').replace('{version}', String(s.version));
    parts.push(`<span class="skill-card-chip is-version">${escapeHtml(versionLabel)}</span>`);
  }
  const catLabel = _resolveCategoryLabel(s && s.category, lang);
  if (catLabel) parts.push(`<span class="skill-card-chip">${escapeHtml(catLabel)}</span>`);
  return parts.join('');
}

// Re-render the skill grid + currently selected detail page when the UI
// language changes — descriptions are bilingual now and `pickDesc` returns
// a different string after the locale flip. Detail re-render goes through
// `selectSkillFile` so the SKILL.md frontmatter re-parses and the description picks the
// right locale via `_renderSkillSections`.
window.addEventListener('i18n-change', () => {
  refreshChatUseChips();
  if (_skillsCache) renderSkillsGrid(_skillsCache);
  if (_selectedSkill?.id && _selectedSkill?.source) {
    // Re-read the same file the user was viewing; null nodeEl preserves
    // the current tree highlight (selectSkillFile is tolerant of null).
    selectSkillFile(_selectedSkill.source, _selectedSkill.id, 'SKILL.md', null)
      .catch(() => { /* ignore */ });
  }
});
let _expandedDirs = new Set(); // keys like "source:id" or "source:id/subdir"
let _skillTreeCache = new Map(); // key: "source:id" → tree array

// Cross-module hook (renderer is classic scripts — top-level let/const are
// visible across files per PC/CLAUDE.md §8). Called from
// `conversation.js::_mountCreatedSkillChip` whenever the commander writes
// `<<<skill-file>>>` blocks into a skill the user might be viewing in the
// detail panel. Without this, the file tree on the detail page keeps showing
// the pre-edit set of files until the user navigates away and back.
// `id` matches any source (custom + marketplace) — commander writes flow
// through `updateAgentSpec` / `_applySkillContainerEdit` for both sources,
// so we don't filter by source here. If the user is currently viewing the
// affected skill AND the source panel is expanded, also re-fetch the tree
// so the new files appear without a manual refresh.
async function invalidateSkillTreeCacheFor(skillId) {
  if (!skillId) { _skillTreeCache.clear(); return; }
  for (const key of Array.from(_skillTreeCache.keys())) {
    if (key.endsWith(`:${skillId}`)) _skillTreeCache.delete(key);
  }
  if (_selectedSkill?.id !== skillId) return;
  const toggle = document.getElementById('skills-source-toggle');
  const treeEl = document.getElementById('skills-source-tree');
  if (toggle?.getAttribute('aria-expanded') === 'true' && treeEl) {
    await expandSkillTree(_selectedSkill.source, _selectedSkill.id, treeEl);
    _markActiveSkillFileInTree(_selectedSkill.filepath || 'SKILL.md');
  }
}

async function refreshSkillsAfterMarketplaceReconcile() {
  _skillTreeCache.clear();
  await loadSkills(true);
  if (_skillEditMode) return;
  if (_selectedSkill?.id && _isSkillPlatformSource(_selectedSkill.source)) {
    const source = _selectedSkill.source;
    const id = _selectedSkill.id;
    const filepath = _selectedSkill.filepath || 'SKILL.md';
    await selectSkillFile(source, id, filepath, null);
    const toggle = document.getElementById('skills-source-toggle');
    const treeEl = document.getElementById('skills-source-tree');
    if (toggle?.getAttribute('aria-expanded') === 'true' && treeEl) {
      await expandSkillTree(source, id, treeEl);
      _markActiveSkillFileInTree(filepath);
    }
  }
}

async function _refreshOpenSkillsCache() {
  try {
    const openRes = await window.orkas.invoke('skills.listOpen');
    _openSkillsCache = (openRes && openRes.ok && Array.isArray(openRes.skills)) ? openRes.skills : [];
  } catch { _openSkillsCache = []; }
}

async function _refreshPackagesCache() {
  try {
    const res = await window.orkas.invoke('packages.list');
    _packagesCache = (res && res.ok && Array.isArray(res.packages)) ? res.packages : [];
  } catch (err) {
    _skillsLog.warn('packages load failed', err);
    _packagesCache = [];
  }
}

// Dev-only: agent-private (`ownerAgent`) skills are hidden from the normal
// list. In dev mode fetch them and merge into the cache (deduped by id+source)
// so the panel can show a separate inspection section grouped by owning agent.
// No-op in production — the IPC is dev-gated and returns nothing there.
async function _mergeAgentPrivateSkills() {
  if (typeof isDevMode !== 'function' || !false || !Array.isArray(_skillsCache)) return;
  try {
    const res = await window.orkas.invoke('skills.listPrivate');
    const priv = (res && res.ok && Array.isArray(res.skills)) ? res.skills : [];
    if (!priv.length) return;
    const key = (s) => `${s.id} ${s.source}`;
    const seen = new Set(_skillsCache.map(key));
    const merged = priv
      .map((s) => ({ ...s, source: _skillSource(s.source) }))
      .filter((s) => !seen.has(key(s)));
    if (merged.length) _skillsCache = _skillsCache.concat(merged);
  } catch { /* dev-only tab; ignore */ }
}

async function loadSkills(forceRefresh) {
  if (_skillsLoadInFlight) {
    if (!forceRefresh) return _skillsLoadInFlight;
    await _skillsLoadInFlight.catch(() => {});
  }
  if (_skillsCache && !forceRefresh) {
    // External packages are installed by an out-of-process CLI, so the
    // trusted skills cache can still be current while the open-tier list has
    // changed underneath us. Refresh it whenever the Skills page is revisited.
    await _refreshOpenSkillsCache();
    await _refreshPackagesCache();
    renderSkillsList(_skillsCache);
    return;
  }
  _skillsLoadInFlight = (async () => {
    try {
      const res = await apiFetch(forceRefresh ? '/api/skills/list?force=1' : '/api/skills/list');
      const data = await res.json();
      // Open-tier skills (from external packages + global folders) are
      // read-only and live in a separate listing; fetched alongside so the
      // panel can show them under their own group with a source badge.
      await _refreshOpenSkillsCache();
      await _refreshPackagesCache();
      if (data.ok) {
        _skillsCache = (data.skills || []).map((s) => ({
          ...s,
          source: _skillSource(s.source),
        })).sort((a, b) => {
          const ka = _skillNameSortKey(a);
          const kb = _skillNameSortKey(b);
          if (ka < kb) return -1;
          if (ka > kb) return 1;
          return String(a.id || '').localeCompare(String(b.id || ''), undefined, { numeric: true, sensitivity: 'base' });
        });
        await _mergeAgentPrivateSkills();
        renderSkillsList(_skillsCache);
      }
    } catch (e) {
      _skillsLog.error('load skills failed', e);
    } finally {
      _skillsLoadInFlight = null;
    }
  })();
  return _skillsLoadInFlight;
}

function _skillNameSortKey(skill) {
  const name = String(skill?.name || skill?.id || '');
  return (typeof pinyinSortKey === 'function') ? pinyinSortKey(name) : name.toLowerCase();
}

// ─── Chat-input inline use chips ──────────────────────────────────────────
//
// Skills and connectors are stored directly in the textarea as compact tokens
// and rendered by the conversation mirror as inline chips. The textarea stays
// the source of truth, so native selection / IME / undo keep working while the
// send path can expand tokens into localized plain text.

const _chatUse = { 'new-chat': null, 'conversation': null, project: null };
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
  ['new-chat-input', 'chat-input', 'project-chat-input'].forEach((id) => {
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
    : (target === 'project' ? 'project-chat-input' : 'chat-input');
  return document.getElementById(id);
}

function _chatUseAutoGrowMax(target) {
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
    : (target === 'project' ? document.getElementById('project-chat-input') : document.getElementById('chat-input'));
  if (typeof focusChatRichComposer === 'function' && focusChatRichComposer(input)) return;
  input?.focus();
}

function setChatSkill(target, name) {
  setChatUseSelection(target, name ? { kind: 'skill', id: name, name } : null);
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
  const target = input.id === 'new-chat-input' ? 'new-chat' : (input.id === 'project-chat-input' ? 'project' : 'conversation');
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

function renderSkillsList(skills) { renderSkillsGrid(skills); }

// Active category-chip selection for the Skills page. Empty string = "All";
// matches `_mpState.category` semantics in marketplace.js.
let _skillsActiveCategory = '';

function renderSkillsGrid(skills) {
  const emptyEl = document.getElementById('skills-empty');
  const chipsHost = document.getElementById('skills-categories');
  const gridEl = document.getElementById('skills-grid');
  if (!gridEl) return;

  if (!skills.length) {
    if (chipsHost) chipsHost.innerHTML = '';
    // Even with no editable skills, open-tier skills (packages/global) may
    // exist — render them so they're visible + togglable.
    const openHtml = _openSkillsSectionHtml();
    if (openHtml) {
      gridEl.classList.add('is-sectioned');
      gridEl.innerHTML = openHtml;
      _wireOpenSkillCards(gridEl);
      if (emptyEl) emptyEl.style.display = 'none';
      return;
    }
    gridEl.classList.remove('is-sectioned');
    gridEl.innerHTML = '';
    if (emptyEl) {
      if (typeof _mpUpdateInstallingEmptyStates === 'function') _mpUpdateInstallingEmptyStates();
      else emptyEl.textContent = t('skills.empty');
      emptyEl.style.display = '';
    }
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';

  const useTitle = escapeHtml(t('skills.use_tooltip'));
  const moreTitle = escapeHtml(t('skills.more_actions'));
  const lang = getLang();
  const customChipLabel = t('skills.custom_group');
  const marketplaceGroupLabel = (() => {
    const raw = t('skills.builtin_group');
    return (raw && raw !== 'skills.builtin_group') ? raw : t('skills.source_marketplace');
  })();
  const allLabel = (() => {
    const raw = t('marketplace.all');
    return (raw && raw !== 'marketplace.all') ? raw : 'All';
  })();

  // Chip strip — `_mpCategoriesCache` is defined in marketplace.js (flat top-level scope).
  // Missing categories and non-registry category codes are treated as General.
  const canonicalCategoryCode = (code) => {
    return typeof _mpCanonicalCategoryCode === 'function'
      ? _mpCanonicalCategoryCode(code)
      : String(code || '').trim();
  };
  const cats = (typeof _mpCategoriesCache !== 'undefined' && _mpCategoriesCache) || [];
  const knownCodes = _knownCategoryCodes(cats);
  const rawCodesPresent = new Set(skills.map((s) => canonicalCategoryCode(s && s.category)));
  const unknownCodes = [...rawCodesPresent].filter((c) => c && !knownCodes.has(c)).sort();
  if (unknownCodes.length && typeof _mpMaybeRefreshCategoriesForCodes === 'function') {
    _mpMaybeRefreshCategoriesForCodes(unknownCodes);
  }
  const codesPresent = new Set([...rawCodesPresent].map((c) => _effectiveCategoryCode(c, knownCodes)));
  const chipCodes = [];
  const chipCodeSeen = new Set();
  for (const c of cats) {
    const code = canonicalCategoryCode(c && c.code);
    if (!code || !codesPresent.has(code) || chipCodeSeen.has(code)) continue;
    chipCodes.push({ code, label: pickLocalizedName(c, lang) || code });
    chipCodeSeen.add(code);
  }
  if (codesPresent.has('general') && !chipCodeSeen.has('general')) {
    chipCodes.push({ code: 'general', label: _generalCategoryLabel(lang) });
    chipCodeSeen.add('general');
  }
  if (_skillsActiveCategory === '__uncategorized__' || _skillsActiveCategory === '__unknown__') {
    _skillsActiveCategory = codesPresent.has('general') ? 'general' : '';
  }
  if (_skillsActiveCategory && !chipCodes.some((c) => c.code === _skillsActiveCategory)) {
    _skillsActiveCategory = '';
  }

  if (chipsHost) {
    const allActive = _skillsActiveCategory === '' ? ' is-active' : '';
    const chipsHtml = [
      `<button type="button" class="marketplace-chip${allActive}" data-skills-cat="">${escapeHtml(allLabel)}</button>`,
      ...chipCodes.map((c) => {
        const active = _skillsActiveCategory === c.code ? ' is-active' : '';
        return `<button type="button" class="marketplace-chip${active}" data-skills-cat="${escapeHtml(c.code)}">${escapeHtml(c.label)}</button>`;
      }),
    ].join('');
    chipsHost.innerHTML = chipsHtml;
    chipsHost.querySelectorAll('[data-skills-cat]').forEach((btn) => {
      btn.addEventListener('click', () => {
        _skillsActiveCategory = btn.dataset.skillsCat || '';
        if (_skillsCache) renderSkillsGrid(_skillsCache);
      });
    });
  }

  const filtered = skills.filter((s) => {
    if (_skillsActiveCategory === '') return true;
    return _effectiveCategoryCode(s && s.category, knownCodes) === _skillsActiveCategory;
  });

  const cardHtml = (s) => {
    const desc = pickDesc(s, lang).trim();
    const descClass = desc ? 'skill-card-desc' : 'skill-card-desc is-empty';
    const descText = desc || t('skills.no_desc');
    const moreBtn = `<button type="button" class="skill-card-more" data-skill-more title="${moreTitle}" aria-label="${moreTitle}">⋯</button>`;
    const enabled = s.enabled !== false;
    const cardChips = _skillCardChipsHtml(s);
    return `
      <div class="skill-card${enabled ? '' : ' is-disabled'}" data-id="${escapeHtml(s.id)}" data-source="${escapeHtml(s.source || '')}">
        <div class="skill-card-header">
          <span class="skill-card-name">${escapeHtml(s.name)}</span>
          ${moreBtn}
        </div>
        <div class="${descClass}">${escapeHtml(descText)}</div>
        <div class="skill-card-actions">
          ${cardChips}
          <button type="button" class="skill-card-use" data-skill-use title="${useTitle}" aria-label="${useTitle}" ${enabled ? '' : 'disabled aria-disabled="true" tabindex="-1"'}>
            ${escapeHtml(t('skills.use'))}
          </button>
        </div>
      </div>
    `;
  };

  const groups = { custom: [], marketplace: [], private: [] };
  for (const s of filtered) {
    // Agent-private skills (dev-only, merged in `_mergeAgentPrivateSkills`)
    // get their own per-owner sections below; never folded into custom.
    if (s.ownerAgent) { groups.private.push(s); continue; }
    const source = _skillSource(s?.source);
    if (source === 'marketplace') groups.marketplace.push(s);
    else groups.custom.push(s);
  }
  const sectionHtml = (label, list) => {
    if (!list.length) return '';
    return `
      <section class="skills-source-section">
        <div class="skills-source-section-head">
          <span>${escapeHtml(label)}</span>
          <span class="skills-source-section-count">${list.length}</span>
        </div>
        <div class="skills-source-section-grid">
          ${list.map(cardHtml).join('')}
        </div>
      </section>
    `;
  };
  // Dev-only inspection sections — one per owning agent, reusing the same card
  // and section markup. Empty (so absent) in production: the source IPC is
  // dev-gated, so `groups.private` is always empty there.
  let privateHtml = '';
  if (groups.private.length) {
    const baseLabel = t('skills.agent_private_group');
    const byOwner = new Map();
    for (const s of groups.private) {
      const owner = s.ownerAgent || '?';
      if (!byOwner.has(owner)) byOwner.set(owner, []);
      byOwner.get(owner).push(s);
    }
    for (const [owner, list] of byOwner) privateHtml += sectionHtml(`${baseLabel} · ${owner}`, list);
  }
  gridEl.classList.add('is-sectioned');
  gridEl.innerHTML = sectionHtml(customChipLabel, groups.custom)
    + sectionHtml(marketplaceGroupLabel, groups.marketplace)
    + privateHtml
    + _openSkillsSectionHtml();
  _wireOpenSkillCards(gridEl);

  // Wire card / ▶ / ⋯ click handlers. (Enable/disable lives in the ⋯ menu now.)
  // Scope to editable-tier cards (`data-id`): open-tier cards (`data-open-id`,
  // external/global) are read-only and intentionally not navigable to a detail
  // view — they only carry an enable/disable toggle, wired by
  // `_wireOpenSkillCards`. Binding them here would open a broken detail page
  // (no `data-id`/`data-source` → `invalid source` read).
  for (const card of gridEl.querySelectorAll('.skill-card[data-id]')) {
    const id = card.dataset.id;
    const source = card.dataset.source;
    card.addEventListener('click', (e) => {
      if (e.target.closest('[data-skill-use]')) {
        e.stopPropagation();
        if (!card.classList.contains('is-disabled')) {
          const skill = _skillsCache?.find(s => s.id === id && s.source === source);
          useSkill(id, skill?.name || id);
        }
        return;
      }
      if (e.target.closest('[data-skill-more]')) {
        e.stopPropagation();
        _openSkillRowMenu(e.target.closest('[data-skill-more]'), id, source);
        return;
      }
      _showSkillsDetailView(source, id);
    });
  }
}

function _externalPackageRows(openRows) {
  const byName = new Map();
  for (const p of (_packagesCache || [])) {
    if (!p || !p.name) continue;
    byName.set(String(p.name), {
      ...p,
      display_name: String(p.display_name || p.name),
      enabled: p.enabled !== false,
      bin_names: Array.isArray(p.bin_names) ? p.bin_names : [],
    });
  }
  const fallbackCounts = new Map();
  for (const s of (openRows || [])) {
    if (!s || s.source !== 'external' || !s.package_name) continue;
    const packageName = String(s.package_name);
    fallbackCounts.set(packageName, (fallbackCounts.get(packageName) || 0) + 1);
    if (!byName.has(packageName)) {
      byName.set(packageName, {
        name: packageName,
        display_name: packageName,
        kind: s.package_kind || 'skill',
        enabled: s.package_enabled !== false,
        skill_count: 0,
        bin_names: [],
      });
    }
  }
  for (const [name, count] of fallbackCounts.entries()) {
    const row = byName.get(name);
    if (row && !row.skill_count) row.skill_count = count;
  }
  return Array.from(byName.values());
}

function _globalSkillNamespace(row) {
  const id = String(row && row.id || '').trim().toLowerCase();
  if (!id) return '';
  const m = /^([a-z0-9]+)-[a-z0-9]/.exec(id);
  return m ? m[1] : id;
}

function _globalSkillGroupLabel(key) {
  return key || t('skills.global_group');
}

function _globalSkillGroupRows(key) {
  return (_openSkillsCache || []).filter((row) => (
    row
    && row.source === 'global'
    && _globalSkillNamespace(row) === key
  ));
}

function _globalSkillGroupSummary(group) {
  const rows = Array.isArray(group?.rows) ? group.rows : [];
  const names = rows
    .map((row) => String(row?.name || row?.id || '').trim())
    .filter(Boolean)
    .sort((a, b) => _skillNameSortKey({ name: a }).localeCompare(_skillNameSortKey({ name: b })));
  const lang = String(typeof getLang === 'function' ? getLang() : '').toLowerCase();
  const cjk = lang.startsWith('zh') || lang.startsWith('ja');
  const countLabel = t('settings.packages.skills_count', { count: rows.length });
  const separator = cjk ? '、' : ', ';
  const colon = cjk ? '：' : ': ';
  return names.length ? `${countLabel}${colon}${names.join(separator)}` : countLabel;
}

function _groupGlobalSkills(rows) {
  const buckets = new Map();
  for (const row of (rows || [])) {
    const key = _globalSkillNamespace(row);
    if (!key) continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }
  const entries = [];
  const groupedKeys = new Set();
  for (const [key, list] of buckets) {
    if (list.length >= _GLOBAL_SKILL_GROUP_MIN) {
      groupedKeys.add(key);
      entries.push({ kind: 'group', key, rows: list });
    }
  }
  for (const row of (rows || [])) {
    if (!groupedKeys.has(_globalSkillNamespace(row))) entries.push({ kind: 'skill', row });
  }
  entries.sort((a, b) => {
    const an = a.kind === 'group' ? _globalSkillGroupLabel(a.key) : (a.row.name || a.row.id || '');
    const bn = b.kind === 'group' ? _globalSkillGroupLabel(b.key) : (b.row.name || b.row.id || '');
    return _skillNameSortKey({ name: an }).localeCompare(_skillNameSortKey({ name: bn }));
  });
  return entries;
}

/** Read-only section for open-tier entries. External packages are package
 *  cards. Global folders auto-aggregate skills by the prefix before the first
 *  dash (`lark-*` → `lark`) so machine-shared roots don't become a wall of
 *  one-card-per-recipe rows. Management lives in per-card menus. Returns ''
 *  when none. */
function _openSkillsSectionHtml() {
  const rows = _openSkillsCache || [];
  const externalPackageRows = _externalPackageRows(rows);
  const globalSkillRows = rows.filter((s) => s.source === 'global');
  if (!externalPackageRows.length && !globalSkillRows.length) return '';
  const card = (s) => {
    // Same desc treatment as trusted/platform cards (flex:1, 3-line clamp,
    // empty placeholder) so open-tier cards match them in size and pin the
    // play button to the bottom regardless of description length.
    const descText = String(s.description || '').trim();
    const desc = `<div class="skill-card-desc${descText ? '' : ' is-empty'}">${escapeHtml(descText || t('skills.no_desc'))}</div>`;
    const packageName = s.source === 'external' ? String(s.package_name || '') : '';
    const displayName = String(s.name || s.id || '');
    const kindLabel = packageName ? _packageKindLabel(s.package_kind) : '';
    const packageMetaBits = [];
    if (packageName && packageName !== displayName) packageMetaBits.push(packageName);
    if (kindLabel) packageMetaBits.push(kindLabel);
    const packageMeta = packageMetaBits.length
      ? `<div class="skill-card-meta">${escapeHtml(packageMetaBits.join(' · '))}</div>`
      : '';
    const moreTitle = escapeHtml(t('skills.more_actions'));
    const useTitle = escapeHtml(t('skills.use_tooltip'));
    const enabled = s.enabled !== false;
    const moreAttr = packageName ? 'data-open-more data-open-package-more' : 'data-open-more';
    const moreBtn = `<button type="button" class="skill-card-more" ${moreAttr} title="${moreTitle}" aria-label="${moreTitle}">⋯</button>`;
    const packageAttr = packageName ? ` data-open-package-name="${escapeHtml(packageName)}"` : '';
    const sourceAttr = ` data-open-source="${escapeHtml(s.source || '')}"`;
    // "Use" selects the skill in the Commander composer. Disabled when the
    // skill is turned off, mirroring trusted cards.
    const useBtn = `<button type="button" class="skill-card-use" data-open-use title="${useTitle}" aria-label="${useTitle}" ${enabled ? '' : 'disabled aria-disabled="true" tabindex="-1"'}>${escapeHtml(t('skills.use'))}</button>`;
    return `
      <div class="skill-card is-readonly${enabled ? '' : ' is-disabled'}" data-open-id="${escapeHtml(s.id)}"${sourceAttr}${packageAttr}>
        <div class="skill-card-header">
          <span class="skill-card-name">${escapeHtml(displayName)}</span>
          ${moreBtn}
        </div>
        ${packageMeta}
        ${desc}
        <div class="skill-card-actions">
          ${useBtn}
        </div>
      </div>`;
  };
  const packageCard = (p) => {
    const packageName = String(p.name || '');
    const packageDisplayName = String(p.display_name || packageName);
    const kindLabel = _packageKindLabel(p.kind);
    const metaBits = [];
    if (kindLabel) metaBits.push(kindLabel);
    if (p.skill_count) metaBits.push(t('settings.packages.skills_count', { count: p.skill_count }));
    if (p.bin_names && p.bin_names.length) metaBits.push(p.bin_names.map((b) => `\`${b}\``).join(' '));
    const meta = metaBits.length
      ? `<div class="skill-card-meta">${escapeHtml(metaBits.join(' · '))}</div>`
      : '';
    const moreTitle = escapeHtml(t('skills.more_actions'));
    return `
      <div class="skill-card is-readonly${p.enabled ? '' : ' is-disabled'}" data-open-package-card="1" data-open-package-name="${escapeHtml(packageName)}">
        <div class="skill-card-header">
          <span class="skill-card-name">${escapeHtml(packageDisplayName)}</span>
          <button type="button" class="skill-card-more" data-open-package-more title="${moreTitle}" aria-label="${moreTitle}">⋯</button>
        </div>
        ${meta}
      </div>`;
  };
  const globalGroupCard = (group) => {
    const name = _globalSkillGroupLabel(group.key);
    const expanded = _expandedGlobalSkillGroups.has(group.key);
    const enabled = (group.rows || []).some((row) => row.enabled !== false);
    const label = expanded ? t('skills.global_group_collapse') : t('skills.global_group_expand');
    const icon = _skillUiIconHtml(expanded ? 'chevron-down' : 'chevron-right', 'skill-card-disclosure-icon');
    const moreTitle = escapeHtml(t('skills.more_actions'));
    const summary = _globalSkillGroupSummary(group);
    return `
      <div class="skill-card is-readonly${enabled ? '' : ' is-disabled'} skill-card--global-group" data-global-skill-group="${escapeHtml(group.key)}">
        <div class="skill-card-header">
          <span class="skill-card-name">${escapeHtml(name)}</span>
          <button type="button" class="skill-card-more" data-global-skill-group-more="${escapeHtml(group.key)}" title="${moreTitle}" aria-label="${moreTitle}">⋯</button>
        </div>
        <div class="skill-card-desc skill-card-desc--global-summary">${escapeHtml(summary)}</div>
        <div class="skill-card-actions">
          <button type="button" class="skill-card-disclosure" data-global-skill-group-toggle="${escapeHtml(group.key)}" aria-expanded="${expanded ? 'true' : 'false'}">
            ${icon}
            <span>${escapeHtml(label)}</span>
          </button>
        </div>
      </div>`;
  };
  // Split external packages and global folders into their own sections so
  // user-installed packages read distinctly from machine-global skill dirs
  // (both are open-tier, but they have different provenance/management). A
  // short hint next to each title explains the provenance to the user.
  const globalSection = (list) => {
    if (!list.length) return '';
    const hint = t('skills.global_group_hint');
    const hintHtml = hint ? `<span class="skills-source-section-hint">${escapeHtml(hint)}</span>` : '';
    const grouped = _groupGlobalSkills(list);
    const tiles = [];
    for (const item of grouped) {
      if (item.kind === 'skill') {
        tiles.push(card(item.row));
        continue;
      }
      tiles.push(globalGroupCard(item));
      if (_expandedGlobalSkillGroups.has(item.key)) {
        for (const row of item.rows) tiles.push(card(row));
      }
    }
    return `
    <section class="skills-source-section skills-source-section--global">
      <div class="skills-source-section-head">
        <span>${escapeHtml(t('skills.global_group'))}</span>
        <span class="skills-source-section-count">${list.length}</span>
        ${hintHtml}
      </div>
      <div class="skills-source-section-grid">${tiles.join('')}</div>
    </section>`;
  };
  const externalHtml = externalPackageRows.length
    ? `
    <section class="skills-source-section">
      <div class="skills-source-section-head">
        <span>${escapeHtml(t('skills.external_group'))}</span>
        <span class="skills-source-section-count">${externalPackageRows.length}</span>
        <span class="skills-source-section-hint">${escapeHtml(t('skills.external_group_hint'))}</span>
      </div>
      <div class="skills-source-section-grid">${externalPackageRows.map(packageCard).join('')}</div>
    </section>`
    : '';
  return externalHtml
    + globalSection(globalSkillRows);
}

function _wireOpenSkillCards(gridEl) {
  for (const btn of gridEl.querySelectorAll('[data-global-skill-group-toggle]')) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const key = btn.dataset.globalSkillGroupToggle || '';
      if (!key) return;
      if (_expandedGlobalSkillGroups.has(key)) _expandedGlobalSkillGroups.delete(key);
      else _expandedGlobalSkillGroups.add(key);
      renderSkillsList(_skillsCache || []);
    });
  }
  for (const btn of gridEl.querySelectorAll('[data-global-skill-group-more]')) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const key = btn.dataset.globalSkillGroupMore || '';
      if (key) _openGlobalSkillGroupMenu(btn, key);
    });
  }
  for (const card of gridEl.querySelectorAll('.skill-card[data-open-id], .skill-card[data-open-package-card]')) {
    const id = card.dataset.openId;
    const source = card.dataset.openSource || '';
    const useBtn = card.querySelector('[data-open-use]');
    if (useBtn) {
      useBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (card.classList.contains('is-disabled')) return;
        const packageName = card.dataset.openPackageName || '';
        const row = _openSkillsCache.find((s) => (
          s.id === id
          && (s.source || '') === source
          && (source !== 'external' || String(s.package_name || '') === packageName)
        ));
        useSkill(id, (row && row.name) || id);
      });
    }
    const menuBtn = card.querySelector('[data-open-more]');
    const packageOnlyMenuBtn = card.querySelector('[data-open-package-more]');
    if (packageOnlyMenuBtn && card.dataset.openPackageCard === '1') {
      packageOnlyMenuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const packageName = card.dataset.openPackageName || '';
        const pkg = (_packagesCache || []).find((p) => String(p.name || '') === packageName);
        if (pkg) {
          const packageDisplayName = String(pkg.display_name || packageName);
          _openExternalPackageMenu(packageOnlyMenuBtn, {
            id: packageName,
            package_name: packageName,
            package_display_name: packageDisplayName,
            package_kind: pkg.kind,
            package_enabled: pkg.enabled !== false,
            enabled: pkg.enabled !== false,
          });
        }
      });
    } else if (menuBtn) {
      menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (source === 'external') {
          const packageName = card.dataset.openPackageName || '';
          const row = _openSkillsCache.find((s) => (
            s.id === id
            && s.source === 'external'
            && String(s.package_name || '') === packageName
          ));
          if (row) _openExternalPackageMenu(menuBtn, row);
          return;
        }
        if (source === 'global') _openSkillRowMenu(menuBtn, id, source);
      });
    }
  }
}

async function _setOpenSkillEnabled(id, nextEnabled) {
  try {
    const res = await window.orkas.invoke('skills.setEnabled', { id, enabled: nextEnabled });
    if (!res || !res.ok) { await uiAlert(t('component.toggle_failed')); return false; }
    // enable/disable is keyed by id; the same skill can appear under both
    // external and global, so flip every matching row's optimistic state.
    for (const r of _openSkillsCache) if (r.id === id) r.enabled = nextEnabled;
    renderSkillsList(_skillsCache || []);
    return true;
  } catch {
    await uiAlert(t('component.toggle_failed'));
    return false;
  }
}

async function _setGlobalSkillGroupEnabled(key, nextEnabled) {
  const rows = _globalSkillGroupRows(key);
  const targetIds = new Set(rows
    .filter((row) => (row.enabled !== false) !== nextEnabled)
    .map((row) => row.id));
  if (!targetIds.size) return true;
  try {
    const results = await Promise.allSettled(Array.from(targetIds).map((id) => (
      window.orkas.invoke('skills.setEnabled', { id, enabled: nextEnabled })
    )));
    if (results.some((res) => res.status === 'rejected' || !res.value || !res.value.ok)) {
      await loadSkills(true);
      await uiAlert(t('component.toggle_failed'));
      return false;
    }
    for (const row of (_openSkillsCache || [])) {
      if (targetIds.has(row.id)) row.enabled = nextEnabled;
    }
    renderSkillsList(_skillsCache || []);
    return true;
  } catch {
    await loadSkills(true);
    await uiAlert(t('component.toggle_failed'));
    return false;
  }
}

function _packageKindLabel(kind) {
  if (kind === 'skill' || kind === 'cli' || kind === 'both') {
    const label = t(`settings.packages.kind_${kind}`);
    return label && label !== `settings.packages.kind_${kind}` ? label : kind;
  }
  return '';
}

function _packageActionBusyLabel(command) {
  if (command === 'update') return t('settings.packages.updating');
  if (command === 'enable') return t('settings.packages.enabling');
  if (command === 'disable') return t('settings.packages.disabling');
  if (command === 'remove') return t('settings.packages.removing');
  return t('common.loading');
}

// Per-card busy overlay shown while an external-package action (update /
// enable / disable / remove) runs — these spawn orkas-pkg.cjs (git pull +
// optional dep install) and can take several seconds. Without it the card
// sits inert with no feedback. Cleared by the post-action re-render on
// success, or in `_runOpenPackageAction`'s finally on the error path.
function _setSkillCardBusy(card, command) {
  if (!card) return;
  card.classList.add('is-busy');
  card.setAttribute('aria-busy', 'true');
  if (card.querySelector('.skill-card-busy')) return;
  const overlay = document.createElement('div');
  overlay.className = 'skill-card-busy';
  overlay.innerHTML = `<span class="skill-card-busy-spinner" aria-hidden="true"></span>`
    + `<span class="skill-card-busy-label">${escapeHtml(_packageActionBusyLabel(command))}</span>`;
  card.appendChild(overlay);
}

function _clearSkillCardBusy(card) {
  if (!card) return;
  card.classList.remove('is-busy');
  card.removeAttribute('aria-busy');
  card.querySelector('.skill-card-busy')?.remove();
}

function _openExternalPackageMenu(anchorBtn, row) {
  const packageName = String(row?.package_name || '');
  if (!packageName) return;
  const packageDisplayName = String(row?.package_display_name || packageName);
  const card = anchorBtn.closest('.skill-card');
  let menu = document.getElementById('skill-row-menu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'skill-row-menu';
    menu.className = 'skill-row-menu';
    menu.style.display = 'none';
    document.body.appendChild(menu);
  }
  const sameAnchor = menu.dataset.packageName === packageName
    && menu.dataset.openSkillId === row.id
    && menu.style.display !== 'none';
  if (sameAnchor) { _closeSkillRowMenu(); return; }
  _closeSkillRowMenu();
  menu.dataset.packageName = packageName;
  menu.dataset.openSkillId = row.id;
  menu.dataset.source = 'external';
  const packageEnabled = row.package_enabled !== false;
  const toggleLabel = packageEnabled ? t('component.disable') : t('component.enable');
  menu.innerHTML = [
    `<div class="skill-row-menu-item" data-action="update-package">${escapeHtml(t('settings.packages.update'))}</div>`,
    `<div class="skill-row-menu-item" data-action="toggle-package">${escapeHtml(toggleLabel)}</div>`,
    `<div class="skill-row-menu-item is-danger" data-action="remove-package">${escapeHtml(t('settings.packages.remove'))}</div>`,
  ].join('');
  for (const c of document.querySelectorAll('.skill-card.is-menu-open')) c.classList.remove('is-menu-open');
  anchorBtn.closest('.skill-card')?.classList.add('is-menu-open');
  _positionSkillRowMenu(menu, anchorBtn);
  for (const item of menu.querySelectorAll('.skill-row-menu-item')) {
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = item.dataset.action;
      _closeSkillRowMenu();
      if (action === 'update-package') {
        await _runOpenPackageAction('update', packageName, card, packageDisplayName);
      } else if (action === 'toggle-package') {
        await _runOpenPackageAction(packageEnabled ? 'disable' : 'enable', packageName, card, packageDisplayName);
      } else if (action === 'remove-package') {
        const ok = await uiConfirmDanger({
          title: t('settings.packages.remove_title', { name: packageDisplayName }),
          message: t('settings.packages.remove_msg'),
          dangerLabel: t('settings.packages.remove'),
        });
        if (ok) await _runOpenPackageAction('remove', packageName, card, packageDisplayName);
      }
    });
  }
}

function _openGlobalSkillGroupMenu(anchorBtn, key) {
  const rows = _globalSkillGroupRows(key);
  if (!rows.length) return;
  let menu = document.getElementById('skill-row-menu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'skill-row-menu';
    menu.className = 'skill-row-menu';
    menu.style.display = 'none';
    document.body.appendChild(menu);
  }
  const sameAnchor = menu.dataset.globalSkillGroup === key
    && menu.style.display !== 'none';
  if (sameAnchor) { _closeSkillRowMenu(); return; }
  _closeSkillRowMenu();
  menu.dataset.globalSkillGroup = key;
  menu.dataset.source = 'global-group';
  const enabled = rows.some((row) => row.enabled !== false);
  const toggleLabel = enabled ? t('component.disable') : t('component.enable');
  menu.innerHTML = `<div class="skill-row-menu-item" data-action="toggle-global-group">${escapeHtml(toggleLabel)}</div>`;
  for (const c of document.querySelectorAll('.skill-card.is-menu-open')) c.classList.remove('is-menu-open');
  anchorBtn.closest('.skill-card')?.classList.add('is-menu-open');
  _positionSkillRowMenu(menu, anchorBtn);
  for (const item of menu.querySelectorAll('.skill-row-menu-item')) {
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = item.dataset.action;
      _closeSkillRowMenu();
      if (action === 'toggle-global-group') {
        await _setGlobalSkillGroupEnabled(key, !enabled);
      }
    });
  }
}

async function _runOpenPackageAction(command, packageName, cardEl, packageDisplayName) {
  const card = cardEl && cardEl.isConnected ? cardEl : null;
  const displayName = String(packageDisplayName || packageName);
  if (card) _setSkillCardBusy(card, command);
  const startedAt = Date.now();
  if (window.Monitor) (() => {})('package_action', { surface: 'skills', command });
  try {
    const res = await window.orkas.invoke('packages.action', { command, name: packageName });
    if (!res || res.ok === false) {
      const errorMessage = (res && res.error) || t('settings.packages.action_failed');
      if (window.Monitor) {
        (() => {})('package_action_result', {
          surface: 'skills',
          command,
          result: 'failure',
          duration_ms: Date.now() - startedAt,
        });
        (() => {})('package_action', {
          surface: 'skills',
          command,
          error_type: 'runtime',
          error_message: errorMessage,
        });
      }
      await uiAlert((res && res.error) || t('settings.packages.action_failed'));
      return;
    }
    if (window.Monitor) {
      (() => {})('package_action_result', {
        surface: 'skills',
        command,
        result: 'success',
        duration_ms: Date.now() - startedAt,
      });
    }
    if (command === 'update' && typeof uiToast === 'function') {
      uiToast(t('settings.packages.updated', { name: displayName }), { variant: 'success' });
    }
    await loadSkills(true);
  } catch (err) {
    if (window.Monitor) {
      (() => {})('package_action_result', {
        surface: 'skills',
        command,
        result: 'failure',
        duration_ms: Date.now() - startedAt,
      });
      (() => {})('package_action', {
        surface: 'skills',
        command,
        error_type: 'ipc',
        error_message: (err && err.message) || String(err || 'unknown'),
      });
    }
    _skillsLog.warn('package action failed', err);
    await uiAlert(t('settings.packages.action_failed'));
  } finally {
    // Success re-renders the grid (card replaced), so this only fires on the
    // failure path where the original card is still mounted.
    if (card && card.isConnected) _clearSkillCardBusy(card);
  }
}

async function _flipOpenSkillEnabled(id) {
  const row = (_openSkillsCache || []).find((s) => s.id === id);
  return _setOpenSkillEnabled(id, !(row && row.enabled));
}

/** Flip a skill's enabled override (used by both the ⋯ menu's toggle item
 *  and the detail-page enable/disable button). On failure, alerts and does
 *  not mutate UI state; on success, refreshes the grid + detail page. */
async function _flipSkillEnabled(skillId, nextEnabled) {
  try {
    const res = await window.orkas.invoke('skills.setEnabled', { id: skillId, enabled: nextEnabled });
    if (!res || !res.ok) {
      await uiAlert(t('component.toggle_failed'));
      return false;
    }
    const cached = _skillsCache?.find((s) => s.id === skillId);
    if (cached) cached.enabled = nextEnabled;
    await loadSkills();
    if (_selectedSkill?.id === skillId) {
      _renderSkillEnabledButton({ id: skillId, enabled: nextEnabled });
    }
    return true;
  } catch (err) {
    await uiAlert(t('component.toggle_failed'));
    return false;
  }
}

// ─── View switching: grid ↔ detail ─────────────────────────────────────

// Back from the skill detail/edit view. An unconfirmed URL-import draft (a
// placeholder that was never authored — set in `_saveSkillFromUrl`, cleared
// once real content is written or the user clicks Done) prompts before
// leaving: the user explicitly chooses to discard the half-finished import or
// keep working. Authored/committed skills and ordinary edits just leave.
async function _onSkillsBack() {
  if (_importDraftId) {
    const discard = await uiConfirm({
      message: t('skills.import.back_confirm'),
      okLabel: t('skills.import.back_discard'),
      cancelLabel: t('skills.import.back_continue'),
    });
    if (!discard) return; // "keep editing" — stay in the edit chat
    const draftId = _importDraftId;
    _importDraftId = null;
    try {
      const r = await window.orkas.invoke('skills.discardImportDraft', { id: draftId });
      if (r && r.discarded) { _skillsCache = null; await loadSkills(); }
    } catch (_) { /* best effort — a leftover empty draft is non-fatal */ }
  }
  _showSkillsGridView();
}

function _showSkillsGridView() {
  const grid = document.getElementById('skills-grid-view');
  const detail = document.getElementById('skills-detail-view');
  // Exit edit mode if active so chat panel is hidden too.
  if (_skillEditMode) {
    // Abort any in-flight reply (same reason as toggleSkillEditMode exit
    // branch — singleton controller, leaving pending leaks streaming UI).
    try { _skillChatCtrl?.abort(); } catch (_) { /* ignore */ }
    _skillEditMode = false;
    _skillEditSkillId = null;
    const chatCol = document.getElementById('skills-chat-col');
    if (chatCol) chatCol.style.display = 'none';
    _updateEditButtonLabel();
  }
  if (grid) grid.style.display = 'flex';
  if (detail) detail.style.display = 'none';
  // Collapse source tree so next detail open starts clean.
  const panel = document.getElementById('skills-source-panel');
  const toggle = document.getElementById('skills-source-toggle');
  if (panel) panel.style.display = 'none';
  if (toggle) toggle.setAttribute('aria-expanded', 'false');
  // Drop any pinned body min-height from the previous session.
  const body = document.getElementById('skills-detail-body');
  if (body) body.style.minHeight = '';
  _selectedSkill = null;
  _closeSkillRowMenu();
}

async function _showSkillsDetailView(source, id, opts = {}) {
  source = _skillSource(source);
  const grid = document.getElementById('skills-grid-view');
  const detail = document.getElementById('skills-detail-view');
  if (grid) grid.style.display = 'none';
  if (detail) detail.style.display = 'flex';
  await loadSkills(true);
  _dropSkillTreeCache(source, id);
  // Reset scroll only on initial detail entry — file switching inside the
  // tree (handled by selectSkillFile) preserves position.
  const detailContent = document.getElementById('skills-detail-content');
  if (detailContent) detailContent.scrollTop = 0;
  // Clear stale body min-height pin from a previous detail session so the
  // body can shrink/grow naturally for the fresh skill.
  const body = document.getElementById('skills-detail-body');
  if (body) body.style.minHeight = '';
  await selectSkillFile(source, id, 'SKILL.md', null);
  // Every fresh detail entry starts with source visible; the toggle's
  // collapsed state is local to the current view and is not remembered.
  if (opts.expandSource !== false) await _ensureSkillsSourceExpanded();
}

// Switch the detail pane to the "installed as an external package" state.
// A URL import can resolve to a verbatim package (in the per-user packages
// tree) rather than an editable skill; main already removed the placeholder
// skill, so there is no skill content to render. Point the user to package
// management instead.
function _showSkillAsPackageState(name) {
  _skillEditMode = false;
  _skillEditSkillId = null;
  _selectedSkill = null;
  _skillsCache = null;
  const grid = document.getElementById('skills-grid-view');
  const detail = document.getElementById('skills-detail-view');
  if (grid) grid.style.display = 'none';
  if (detail) detail.style.display = 'flex';
  const detailCol = document.getElementById('skills-detail-col');
  if (detailCol) detailCol.style.display = 'none';
  const chatCol = document.getElementById('skills-chat-col');
  if (chatCol) chatCol.style.display = 'none';
  const panel = document.getElementById('skills-as-package');
  if (panel) panel.style.display = '';
  const nameEl = document.getElementById('skills-as-package-name');
  if (nameEl) nameEl.textContent = name || t('skills.as_package.title');
  const descEl = document.getElementById('skills-as-package-desc');
  if (descEl) descEl.textContent = t('skills.as_package.desc');
  const manageBtn = document.getElementById('skills-as-package-manage');
  if (manageBtn) manageBtn.onclick = () => {
    _showSkillsGridView();
    Promise.resolve(loadSkills(true)).finally(() => {
      _scrollPackageCardIntoView(name);
    });
  };
  const backBtn = document.getElementById('skills-as-package-back');
  if (backBtn) backBtn.onclick = () => _onSkillsBack();
  // Placeholder skill is gone and a package may now contribute skills —
  // refresh the grid in the background so a later "Back" shows fresh state.
  Promise.resolve().then(() => loadSkills()).catch(() => {});
}

function _scrollPackageCardIntoView(packageName) {
  const wanted = String(packageName || '');
  const cards = document.querySelectorAll('.skill-card[data-open-package-name]');
  for (const card of cards) {
    if (String(card.dataset.openPackageName || '') !== wanted) continue;
    card.scrollIntoView({ block: 'center' });
    card.classList.add('is-menu-open');
    setTimeout(() => card.classList.remove('is-menu-open'), 1200);
    return;
  }
  document.querySelector('.skills-source-section')?.scrollIntoView({ block: 'start' });
}

function _dropSkillTreeCache(source, id) {
  const key = `${_skillSource(source)}:${id}`;
  _skillTreeCache.delete(key);
}

async function refreshSelectedSkillDetail() {
  if (_skillEditMode || !_selectedSkill?.id || !_selectedSkill?.source) return;
  const detail = document.getElementById('skills-detail-view');
  if (!detail || detail.style.display === 'none') return;
  const source = _selectedSkill.source;
  const id = _selectedSkill.id;
  const filepath = _selectedSkill.filepath || 'SKILL.md';
  _dropSkillTreeCache(source, id);
  await selectSkillFile(source, id, filepath, null);
  const toggle = document.getElementById('skills-source-toggle');
  if (toggle?.getAttribute('aria-expanded') === 'true') {
    await _ensureSkillsSourceExpanded();
  }
}

async function _ensureSkillsSourceExpanded() {
  const toggle = document.getElementById('skills-source-toggle');
  const panel = document.getElementById('skills-source-panel');
  const treeEl = document.getElementById('skills-source-tree');
  if (!toggle || !panel || !treeEl || !_selectedSkill) return;
  panel.style.display = '';
  toggle.setAttribute('aria-expanded', 'true');
  treeEl.innerHTML = `<div style="color:#94a3b8;padding:8px 12px">${escapeHtml(t('skills.loading'))}</div>`;
  await expandSkillTree(_selectedSkill.source, _selectedSkill.id, treeEl);
  _markActiveSkillFileInTree(_selectedSkill.filepath || 'SKILL.md');
}

// Highlight whichever file row in the source tree corresponds to the file
// currently rendered in the body — initial load points at SKILL.md, later
// changes track user clicks via `selectSkillFile`'s nodeEl path.
function _markActiveSkillFileInTree(filepath) {
  const treeEl = document.getElementById('skills-source-tree');
  if (!treeEl) return;
  treeEl.querySelectorAll('.skill-tree-node').forEach(n => n.classList.remove('active'));
  // Use attribute selector with quoted value — file paths can contain `.`,
  // `/` etc. that confuse class-based selectors.
  const safe = String(filepath).replace(/(["\\])/g, '\\$1');
  const target = treeEl.querySelector(`.skill-tree-file[data-path="${safe}"]`);
  if (target) target.classList.add('active');
}

// ─── Per-card ⋯ popover menu (custom / platform / open-tier) ──────────

function _openSkillRowMenu(anchorBtn, id, source) {
  let menu = document.getElementById('skill-row-menu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'skill-row-menu';
    menu.className = 'skill-row-menu';
    menu.style.display = 'none';
    document.body.appendChild(menu);
  }
  const sameAnchor = menu.dataset.skillId === id
    && menu.dataset.source === source
    && menu.style.display !== 'none';
  if (sameAnchor) { _closeSkillRowMenu(); return; }
  _closeSkillRowMenu();
  menu.dataset.skillId = id;
  menu.dataset.source = source;
  // Edit/delete are gated: custom always allowed; built-in only in dev mode.
  // Enable/disable is always shown (lives in this menu now since cards no
  // longer carry a toggle).
  // Open-tier (external package / global folder): package/filesystem managed —
  // enable/disable only, no edit/delete/upload. Its rows live in a separate
  // cache.
  const isOpenTier = source === 'external' || source === 'global';
  const cached = isOpenTier
    ? (_openSkillsCache || []).find((s) => s.id === id)
    : _skillsCache?.find((s) => s.id === id && s.source === source);
  const enabled = cached ? cached.enabled !== false : true;
  const canEdit = !isOpenTier && (source === 'custom' || (_isSkillPlatformSource(source) && false));
  // Dev-only entry on marketplace items: tag the label so the user knows this isn't a
  // normal user capability (mirrors marketplace.upload's "(dev)" treatment).
  const editLabelSuffix = (_isSkillPlatformSource(source) && false) ? t('common.dev_suffix') : '';
  const items = [];
  if (canEdit) {
    items.push(`<div class="skill-row-menu-item" data-action="edit">${escapeHtml(t('skills.edit') + editLabelSuffix)}</div>`);
  }
  items.push(
    `<div class="skill-row-menu-item" data-action="toggle-enabled">${escapeHtml(enabled ? t('component.disable') : t('component.enable'))}</div>`,
  );
  // Upload-to-marketplace owned by marketplace_dev.js (absent in the open-source build). typeof check
  // naturally hides the entry on builds that don't ship the dev module.
  if (!isOpenTier && typeof openMarketplaceUpload === 'function') {
    items.push(
      `<div class="skill-row-menu-item" data-action="upload-marketplace">${escapeHtml(t('marketplace.upload'))}</div>`,
    );
  }
  if (canEdit) {
    items.push(`<div class="skill-row-menu-item is-danger" data-action="delete">${escapeHtml(t('skills.delete'))}</div>`);
  }
  menu.innerHTML = items.join('');
  // While menu open, force the source card's ⋯ visible.
  for (const c of document.querySelectorAll('.skill-card.is-menu-open')) c.classList.remove('is-menu-open');
  anchorBtn.closest('.skill-card')?.classList.add('is-menu-open');
  _positionSkillRowMenu(menu, anchorBtn);
  for (const item of menu.querySelectorAll('.skill-row-menu-item')) {
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = item.dataset.action;
      _closeSkillRowMenu();
      if (action === 'edit') {
        await _showSkillsDetailView(source, id);
        if (_selectedSkill && _selectedSkill.id === id && _selectedSkill.source === source) {
          await toggleSkillEditMode();
        }
      } else if (action === 'delete') {
        // Mimic the existing delete flow (from detail page) but for any card.
        _selectedSkill = { source, id, filepath: 'SKILL.md', name: '' };
        await deleteSelectedSkill();
      } else if (action === 'upload-marketplace') {
        if (typeof openMarketplaceUpload === 'function') await openMarketplaceUpload('skill', id, source);
      } else if (action === 'toggle-enabled') {
        if (isOpenTier) {
          await _flipOpenSkillEnabled(id);
        } else {
          const cur = _skillsCache?.find((s) => s.id === id && s.source === source);
          const nextEnabled = !(cur ? cur.enabled !== false : true);
          await _flipSkillEnabled(id, nextEnabled);
        }
      }
    });
  }
}

function _closeSkillRowMenu() {
  const menu = document.getElementById('skill-row-menu');
  if (menu) {
    menu.style.display = 'none';
    delete menu.dataset.skillId;
    delete menu.dataset.openSkillId;
    delete menu.dataset.packageName;
    delete menu.dataset.globalSkillGroup;
    delete menu.dataset.source;
  }
  for (const c of document.querySelectorAll('.skill-card.is-menu-open')) c.classList.remove('is-menu-open');
}

function _positionSkillRowMenu(menuEl, anchorEl) {
  menuEl.style.display = 'block';
  menuEl.style.left = '-9999px';
  menuEl.style.top = '-9999px';
  const rect = anchorEl.getBoundingClientRect();
  const menuRect = menuEl.getBoundingClientRect();
  const margin = 8;
  const gap = 4;
  let left = rect.right - menuRect.width;
  if (left < margin) left = margin;
  if (left + menuRect.width > window.innerWidth - margin) {
    left = window.innerWidth - menuRect.width - margin;
  }
  const below = rect.bottom + gap + menuRect.height <= window.innerHeight - margin;
  const top = below ? rect.bottom + gap : Math.max(margin, rect.top - menuRect.height - gap);
  menuEl.style.left = left + 'px';
  menuEl.style.top = top + 'px';
}

// ─── "View source" collapsible (detail page bottom) ─────────────────

async function _toggleSkillsSource() {
  const toggle = document.getElementById('skills-source-toggle');
  const panel = document.getElementById('skills-source-panel');
  if (!toggle || !panel || !_selectedSkill) return;
  const expanded = toggle.getAttribute('aria-expanded') === 'true';
  if (expanded) {
    panel.style.display = 'none';
    toggle.setAttribute('aria-expanded', 'false');
    return;
  }
  await _ensureSkillsSourceExpanded();
}

async function expandSkillTree(source, id, childrenEl) {
  source = _skillSource(source);
  const key = `${source}:${id}`;
  let tree = _skillTreeCache.get(key);
  if (!tree) {
    try {
      const res = await apiFetch(`/api/skills/tree?source=${source}&id=${encodeURIComponent(id)}`);
      const data = await res.json();
      if (!data.ok) return;
      tree = data.tree || [];
      _skillTreeCache.set(key, tree);
    } catch (e) {
      _skillsLog.error('skill tree failed', e);
      return;
    }
  }
  childrenEl.innerHTML = renderTreeNodes(tree, source, id, 1);
  bindTreeNodes(childrenEl, source, id);
}

// Tree icons are centralized in modules/icons.js; classes here only control sizing/color.
const ICON_FOLDER_CLOSED = _skillUiIconHtml('folder', 'skill-tree-node-svg');
const ICON_FOLDER_OPEN = _skillUiIconHtml('folder-open', 'skill-tree-node-svg');
const ICON_FILE = _skillUiIconHtml('file', 'skill-tree-node-svg');

function fileIconSvg(ext) {
  // Generic file icon; color is differentiated via data-ext
  return ICON_FILE;
}

function _setDirIcon(nodeEl, open) {
  const caret = nodeEl.querySelector('.skill-tree-caret');
  if (caret) {
    caret.classList.toggle('collapsed', !open);
  }
  const icon = nodeEl.querySelector('.skill-tree-icon');
  if (icon) icon.innerHTML = open ? ICON_FOLDER_OPEN : ICON_FOLDER_CLOSED;
}

function renderTreeNodes(nodes, source, id, depth) {
  const indent = depth * 18;
  return nodes.map(n => {
    if (n.type === 'dir') {
      const childrenHtml = `<div class="skill-tree-children" data-dir-path="${escapeHtml(n.path)}" style="display:none"></div>`;
      return `
        <div class="skill-tree-node skill-tree-dir" data-type="dir" data-path="${escapeHtml(n.path)}" style="padding-left:${indent}px">
          <span class="skill-tree-caret collapsed"></span>
          <span class="skill-tree-icon icon-folder">${ICON_FOLDER_CLOSED}</span>
          <span class="skill-tree-label">${escapeHtml(n.name)}</span>
        </div>
        ${childrenHtml}
      `;
    }
    return `
      <div class="skill-tree-node skill-tree-file" data-type="file" data-path="${escapeHtml(n.path)}" data-ext="${n.ext || ''}" style="padding-left:${indent}px">
        <span class="skill-tree-caret skill-tree-caret-empty"></span>
        <span class="skill-tree-icon icon-file" data-ext="${n.ext || ''}">${fileIconSvg(n.ext)}</span>
        <span class="skill-tree-label">${escapeHtml(n.name)}</span>
      </div>
    `;
  }).join('');
}

function bindTreeNodes(containerEl, source, id) {
  // File nodes
  containerEl.querySelectorAll(':scope > .skill-tree-file').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      selectSkillFile(source, id, el.dataset.path, el);
    });
  });
  // Directory nodes (direct children)
  const dirs = containerEl.querySelectorAll(':scope > .skill-tree-dir');
  dirs.forEach(dirEl => {
    const dirPath = dirEl.dataset.path;
    const childrenEl = dirEl.nextElementSibling;
    if (!childrenEl || !childrenEl.classList.contains('skill-tree-children')) return;
    dirEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const key = `${source}:${id}/${dirPath}`;
      const isExpanded = _expandedDirs.has(key);
      if (isExpanded) {
        _expandedDirs.delete(key);
        childrenEl.style.display = 'none';
        _setDirIcon(dirEl, false);
      } else {
        _expandedDirs.add(key);
        const tree = _skillTreeCache.get(`${source}:${id}`);
        if (tree) {
          const dirNode = findDirInTree(tree, dirPath);
          if (dirNode && dirNode.children) {
            const depth = dirPath.split('/').length + 1;
            childrenEl.innerHTML = renderTreeNodes(dirNode.children, source, id, depth);
            bindTreeNodes(childrenEl, source, id);
          }
        }
        childrenEl.style.display = '';
        _setDirIcon(dirEl, true);
      }
    });
    if (_expandedDirs.has(`${source}:${id}/${dirPath}`)) {
      const tree = _skillTreeCache.get(`${source}:${id}`);
      if (tree) {
        const dirNode = findDirInTree(tree, dirPath);
        if (dirNode && dirNode.children) {
          const depth = dirPath.split('/').length + 1;
          childrenEl.innerHTML = renderTreeNodes(dirNode.children, source, id, depth);
          bindTreeNodes(childrenEl, source, id);
          childrenEl.style.display = '';
          _setDirIcon(dirEl, true);
        }
      }
    }
  });
}

function findDirInTree(tree, targetPath) {
  for (const n of tree) {
    if (n.type === 'dir' && n.path === targetPath) return n;
    if (n.type === 'dir' && n.children) {
      const found = findDirInTree(n.children, targetPath);
      if (found) return found;
    }
  }
  return null;
}

async function selectSkillFile(source, id, filepath, nodeEl) {
  source = _skillSource(source);
  const skill = _skillsCache?.find(s => s.id === id && s.source === source);
  // Detect "same-skill file switch" vs initial / cross-skill load — only the
  // former needs scroll preservation (user is mid-page browsing source files).
  // Capture this BEFORE _selectedSkill is overwritten.
  const sameSkill = _selectedSkill?.id === id && _selectedSkill?.source === source;
  _selectedSkill = { source, id, filepath, name: skill?.name || id };
  // Clear previous active state across all tree nodes (in source-wrap)
  document.querySelectorAll('.skill-tree-node').forEach(n => n.classList.remove('active'));
  if (nodeEl) nodeEl.classList.add('active');
  const content = document.getElementById('skills-detail-content');
  // Defer to CSS — was 'flex' from the old 3-column layout, which now
  // overrides `display: block` and forces sections into horizontal flex.
  if (content) content.style.display = '';
  // Leaving any external-package result state: restore the normal columns.
  const asPkgPanel = document.getElementById('skills-as-package');
  if (asPkgPanel) asPkgPanel.style.display = 'none';
  const detailCol = document.getElementById('skills-detail-col');
  if (detailCol) detailCol.style.display = '';

  const nameEl = document.getElementById('skills-detail-name');
  nameEl.textContent = skill?.name || id;
  nameEl.dataset.skillId = id;
  nameEl.dataset.source = source;
  // Name is editable ONLY in edit mode (req: "非编辑状态不能修改名称").
  // Editability is wired below alongside the description-section toggle —
  // both depend on `editingThis` which is computed a few lines down.
  nameEl.classList.remove('editable');
  nameEl.removeAttribute('title');

  // Header chips: custom = "自定义"; marketplace-installed = category only.
  // Same `_renderSourceMetaHtml` helper as the agent detail page (defined in agents.js,
  // shared via the renderer's flat top-level scope per CLAUDE.md §8).
  const sourceEl = document.getElementById('skills-detail-source');
  sourceEl.className = 'skills-doc-source-row';
  sourceEl.innerHTML = _renderSourceMetaHtml({
    source,
    version: skill?.version || '',
    category: skill?.category || '',
  });
  _renderSkillDetailCategory(skill, source);

  // Doc sections (description / external dependencies / dependent
  // skills / other attributes) — seed with the cached description so
  // the page isn't blank on first paint; refined once SKILL.md
  // frontmatter parses.
  const seedDesc = pickDesc(skill, getLang()).trim();
  _renderSkillSections(seedDesc ? [['description', seedDesc]] : []);

  // Actions bar: visible when a skill is selected.
  // Order: use (icon) / edit / enable-disable / delete.
  // In edit mode only the "done" button (the relabeled "edit") is
  // shown; everything else hides.
  const canEditThisSkill = source === 'custom' || (_isSkillPlatformSource(source) && false);
  const editingThis = _skillEditMode && _skillEditSkillId === id && canEditThisSkill;
  const actions = document.getElementById('skills-detail-actions');
  if (actions) {
    actions.classList.remove('is-hidden');
    const useBtn = document.getElementById('skill-use-btn');
    const editBtn = document.getElementById('skill-edit-btn');
    const enableBtn = document.getElementById('skill-enabled-btn');
    const uploadBtn = document.getElementById('skill-upload-marketplace-btn');
    const delBtn = document.getElementById('skill-delete-btn');
    if (useBtn) {
      useBtn.style.display = editingThis ? 'none' : '';
      useBtn.disabled = skill?.enabled === false;
      useBtn.setAttribute('aria-disabled', skill?.enabled === false ? 'true' : 'false');
    }
    if (editBtn) editBtn.style.display = canEditThisSkill ? '' : 'none';
    if (enableBtn) enableBtn.style.display = editingThis ? 'none' : '';
    // Upload button visibility: gated by marketplace_dev.js's presence (the open-source build lacks it).
    if (uploadBtn) uploadBtn.style.display = (typeof openMarketplaceUpload === 'function' && !editingThis) ? '' : 'none';
    if (delBtn) delBtn.style.display = (canEditThisSkill && !editingThis) ? '' : 'none';
  }

  // Wire name editability and hide the
  // description section while editing (req #3: edit description by editing
  // the `description_*:` frontmatter in SKILL.md, not via a separate UI
  // block). In dev mode, marketplace skill names are display metadata only:
  // saving writes SKILL.md frontmatter without renaming the marketplace id dir.
  const nameEditable = editingThis && (source === 'custom' || (_isSkillPlatformSource(source) && false));
  _toggleSkillNameEditable(nameEl, nameEditable);
  const summarySection = document.getElementById('skills-section-summary');
  if (summarySection) summarySection.style.display = editingThis ? 'none' : '';

  // Refresh the per-skill enable/disable button label + click handler.
  _renderSkillEnabledButton({ id, enabled: skill?.enabled !== false });

  const body = document.getElementById('skills-detail-body');
  // Don't show a loading placeholder — it would collapse body height
  // before the new content arrives. Keep the previous content visible.
  // For same-skill file switches, pin body's min-height to its current
  // rendered height ONLY for the duration of the fetch + render so the
  // body doesn't visibly collapse while the network call is in flight.
  // The pin is cleared right after render so the body resettles to the
  // new file's natural height — otherwise switching from a long source
  // (e.g. SKILL.md) back to a short script leaves the body padded to
  // the previous height and a large blank area appears below the new
  // content. `_showSkillsGridView` / `_showSkillsDetailView` also reset
  // minHeight on grid return / skill switch as a defensive backstop.
  const detailContent = document.getElementById('skills-detail-content');
  const savedScroll = detailContent ? detailContent.scrollTop : 0;
  if (sameSkill) {
    const oldBodyHeight = body.offsetHeight || 0;
    if (oldBodyHeight) body.style.minHeight = oldBodyHeight + 'px';
  }

  // Kick off the current-file read and (if we aren't already reading it) a
  // parallel SKILL.md read to populate header metadata. The extra fetch is
  // ~1 round-trip on a sub-KB file, and lets the header stay accurate when
  // the user is browsing `scripts/*.ts` inside a skill.
  const mainPromise = apiFetch(`/api/skills/read?source=${source}&id=${encodeURIComponent(id)}&file=${encodeURIComponent(filepath)}`)
    .then((r) => r.json());
  const skillMdPromise = filepath === 'SKILL.md'
    ? mainPromise
    : apiFetch(`/api/skills/read?source=${source}&id=${encodeURIComponent(id)}&file=SKILL.md`)
        .then((r) => r.json())
        .catch(() => null);

  // Render the doc sections as soon as SKILL.md comes back — don't block
  // on the main file body.
  skillMdPromise.then((md) => {
    // Guard: selection may have changed while we were awaiting.
    if (_selectedSkill?.id !== id || _selectedSkill?.source !== source) return;
    const content = md && md.ok ? (md.content || '') : '';
    const pairs = _parseSkillFrontmatterPairs(content);
    const fallbackDesc = pickDesc(skill, getLang()).trim();
    _renderSkillSections(pairs.length
      ? pairs
      : (fallbackDesc ? [['description', fallbackDesc]] : []));
  });

  try {
    const data = await mainPromise;
    if (data.ok) {
      const editable = _skillEditMode && _skillEditSkillId === id && canEditThisSkill;
      if (editable) _renderSkillFileEditor(body, data.content || '', data.ext);
      else _renderSkillFileView(body, data.content || '', data.ext);
    } else {
      body.innerHTML = `<span style="color:var(--danger)">${escapeHtml(data.error)}</span>`;
    }
  } catch (e) {
    body.innerHTML = `<span style="color:var(--danger)">${escapeHtml(t('skills.load_failed'))}</span>`;
  }
  // Release the loading-time minHeight pin so the body collapses to the
  // new file's natural height. Without this, switching from a long file
  // back to a short one leaves a blank area below the new content (the
  // pin was kept monotonically across same-skill file switches).
  if (sameSkill) body.style.minHeight = '';
  // Restore scroll defensively. innerHTML swaps + section re-renders can
  // shift scrollHeight before the new content settles; clamping pulls
  // scrollTop unexpectedly. Setting it back is cheap and idempotent — the
  // browser will clamp scrollTop to the new (possibly smaller) scrollHeight
  // when the new file is shorter, which is the right outcome now that the
  // body height honestly reflects the new content.
  if (detailContent) detailContent.scrollTop = savedScroll;

  // Chat column visibility is driven by edit-mode toggle.
  // Selecting a different skill resets edit mode off.
  const chatCol = document.getElementById('skills-chat-col');
  if (_skillEditMode && _skillEditSkillId === id && canEditThisSkill) {
    chatCol.style.display = 'flex';
  } else {
    // Switching skill mid-stream needs to abort, otherwise the singleton
    // controller's pending state bleeds into the next skill's edit panel
    // (the send button shows streaming for a fresh chat).
    if (_skillEditMode) {
      try { _skillChatCtrl?.abort(); } catch (_) { /* ignore */ }
    }
    _skillEditMode = false;
    _skillEditSkillId = null;
    chatCol.style.display = 'none';
  }
  _updateEditButtonLabel();
}

// Parse SKILL.md YAML frontmatter into ordered [key, value] pairs.
// Mirrors the server-side parser in `core-agent/src/skills/frontmatter.ts`
// but also collects indented block values (`key:` followed by `  - item`
// or `  text`) so multi-line fields like `read_when:` render correctly.
function _normalizeSkillFrontmatterDisplayValue(value) {
  if (typeof normalizeDisplayText === 'function') return normalizeDisplayText(value);
  return String(value || '')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\{2,}/g, '\\')
    .replace(/\s+/g, ' ')
    .trim();
}

function _parseSkillFrontmatterPairs(content) {
  if (!content) return [];
  const first = content.indexOf('\n');
  const head = (first >= 0 ? content.slice(0, first) : content).trim();
  if (head !== '---') return [];
  const lines = content.split('\n');
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { close = i; break; }
  }
  if (close < 0) return [];

  const pairs = [];
  let i = 1;
  while (i < close) {
    const line = lines[i];
    const trimmed = line.trim();
    i++;
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    if (!key) continue;
    let value = line.slice(colon + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
        (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
      value = value.slice(1, -1);
    }
    value = _normalizeSkillFrontmatterDisplayValue(value);
    if (!value) {
      // Collect indented continuation (block list or folded scalar).
      const block = [];
      while (i < close) {
        const next = lines[i];
        if (!next.trim() || /^\s+\S/.test(next)) {
          if (next.trim()) block.push(next.replace(/^\s+/, '').replace(/^-\s*/, ''));
          i++;
        } else break;
      }
      value = block.join('\n');
    }
    pairs.push([key, value]);
  }
  return pairs;
}

function _renderSkillDetailCategory(skill, source) {
  const section = document.getElementById('skills-section-category');
  const slot = document.getElementById('skills-detail-category');
  if (section) section.style.display = 'none';
  if (slot) slot.innerHTML = '';
  const isCustom = source === 'custom';
  if (!isCustom) return;
  const sourceEl = document.getElementById('skills-detail-source');
  if (!sourceEl) return;
  const skillId = skill?.id || _selectedSkill?.id;
  _mountDetailCategorySelect(sourceEl, {
    value: skill?.category || 'general',
    onChange: async (category, api) => {
      try {
        const res = await window.orkas.invoke('skills.update', {
          id: skillId,
          updates: { category: category || 'general' },
          skipRename: true,
        });
        if (!res || res.ok === false || !res.skill) {
          api.setValue(skill?.category || 'general');
          uiAlert((res && res.error) || t('skills.save_failed'));
          return;
        }
        skill.category = res.skill.category || category || 'general';
        _skillsCache = null;
        await loadSkills(true);
        if (_selectedSkill?.id === skillId) {
          await selectSkillFile('custom', skillId, _selectedSkill.filepath || 'SKILL.md', null);
        }
      } catch (err) {
        api.setValue(skill?.category || 'general');
        uiAlert((err && err.message) || t('skills.save_failed'));
      }
    },
  }).catch((err) => _skillsLog.warn('render category select failed', err));
}

// Single source of truth for rendering frontmatter fields into the
// document. Splits known fields into their own dedicated sections (with
// labels) and tucks any unknown leftover keys under "other
// attributes". Hides any section whose content is empty (except the
// description, which always renders so the reader sees a placeholder
// when missing).
function _renderSkillSections(pairs) {
  const map = new Map();
  for (const [k, v] of (pairs || [])) {
    if (k && k !== 'name') map.set(k, v);
  }
  // — Description — pick by current UI language with cross-language fallback (so a
  // single-language skill still shows something instead of going blank).
  const summaryEl = document.getElementById('skills-detail-summary');
  if (summaryEl) {
    const desc = pickDesc({
      description_zh: map.get('description_zh'),
      description_en: map.get('description_en'),
    }, getLang()).trim() || (map.get('description') || '').trim();
    if (desc) {
      summaryEl.classList.remove('is-empty');
      summaryEl.textContent = desc;
    } else {
      summaryEl.classList.add('is-empty');
      summaryEl.textContent = _selectedSkill?.source === 'custom'
        ? t('skills.no_desc') : '';
    }
  }

  // — Other attributes —
  // Orkas skill frontmatter is intentionally tiny: name, bilingual
  // description, and category. Unknown/external metadata has no runtime
  // effect, so authoring writes strip it and the read-only view hides any
  // legacy leftovers instead of presenting them as meaningful properties.
  const extraSection = document.getElementById('skills-section-extra');
  const extraBody = document.getElementById('skills-detail-extra');
  if (extraSection && extraBody) {
    extraSection.style.display = 'none';
    extraBody.innerHTML = '';
  }
}

// Read-only view of a skill file. Markdown renders, other formats get a
// code block. Stores the raw content on the element so the editor variant
// can reset on "discard changes" without re-fetching.
function _renderSkillFileView(body, content, ext) {
  body.className = 'skills-detail-body';
  body.dataset.rawContent = content;
  if (ext === 'md') {
    body.classList.add('markdown-body');
    body.innerHTML = renderMarkdownFull(content);
  } else {
    body.innerHTML = `<pre class="code-view"><code>${escapeHtml(content)}</code></pre>`;
  }
}

// Editable textarea view with debounced auto-save. Shown when _skillEditMode
// is on for a custom skill. No explicit save button — edits flush to disk
// ~600ms after the user pauses typing. Target id/file are captured in the
// closure so a save in flight always targets the file it was scheduled for,
// even if the user navigates to another file meanwhile.
function _renderSkillFileEditor(body, content, _ext) {
  body.className = 'skills-detail-body skills-detail-editing';
  body.dataset.rawContent = content;
  body.innerHTML = `
    <div class="skill-file-toolbar">
      <span class="skill-file-status" data-role="status"></span>
    </div>
    <textarea class="skill-file-editor" spellcheck="false"></textarea>
  `;

  const ta = body.querySelector('.skill-file-editor');
  const statusEl = body.querySelector('[data-role="status"]');
  ta.value = content;

  const skillId = _selectedSkill?.id || '';
  const filepath = _selectedSkill?.filepath || 'SKILL.md';

  const setStatus = (text, kind = '') => {
    statusEl.textContent = text;
    statusEl.className = 'skill-file-status' + (kind ? ' is-' + kind : '');
  };

  let saveTimer = null;
  let saving = false;
  let queuedValue = null;

  const performSave = async (value) => {
    saving = true;
    setStatus(t('skills.saving'), 'saving');
    try {
      const res = await apiFetch('/api/skills/write', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: skillId, file: filepath, content: value }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || t('skills.unknown_error'));
      body.dataset.rawContent = value;
      setStatus(t('skills.saved'), 'ok');
      // SKILL.md edits change name/description/frontmatter — refresh side list.
      if (filepath === 'SKILL.md') {
        _skillsCache = null;
        await loadSkills();
      }
    } catch (e) {
      setStatus(t('skills.save_failed_with', { reason: e.message || e }), 'err');
    } finally {
      saving = false;
      if (queuedValue !== null) {
        const next = queuedValue;
        queuedValue = null;
        performSave(next);
      }
    }
  };

  const scheduleSave = () => {
    clearTimeout(saveTimer);
    setStatus(t('skills.editing'));
    saveTimer = setTimeout(() => {
      const value = ta.value;
      if (value === body.dataset.rawContent) { setStatus(''); return; }
      if (saving) { queuedValue = value; return; }
      performSave(value);
    }, 600);
  };

  ta.addEventListener('input', scheduleSave);
}

// ─── Skill name inline edit (mirrors agents.js's name editor) ───
//
// Replaces the older click-to-prompt rename path. The name field is now
// only editable inside Skill detail's edit mode (req: 非编辑状态不能修改名称).
// Wire-up:
//   - Enter edit  → contenteditable + bind input/blur (one-time per element)
//   - Type        → debounce 800ms → save SKILL.md frontmatter `name:`
//                   via `skipRename:true` (no dir rename mid-typing)
//   - Blur        → flush pending save
//   - Done click  → flush + validate; if invalid alert + revert DOM;
//                   if valid AND name actually changed, fire one final
//                   `skipRename:false` to commit the directory rename.

const SKILL_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
function _isValidSkillNameCharset(name) {
  if (typeof name !== 'string' || name.length <= 0) return false;
  if (typeof window.nameDisplayWidth === 'function' && window.nameDisplayWidth(name) > window.NAME_DISPLAY_MAX_UNITS) return false;
  return SKILL_NAME_RE.test(name);
}

function _isEditablePlatformSkill(skill) {
  return !!skill && _isSkillPlatformSource(skill.source) && false;
}

function _canEditSelectedSkillName() {
  return !!_selectedSkill && (_selectedSkill.source === 'custom' || _isEditablePlatformSkill(_selectedSkill));
}

function _selectedSkillNameFallback() {
  if (!_selectedSkill) return '';
  return String(_selectedSkill.source === 'custom'
    ? _selectedSkill.id
    : (_selectedSkill.name || _selectedSkill.id || '')).trim();
}

function _isValidSkillDisplayName(name) {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (!trimmed || trimmed.includes('\n') || trimmed.includes('\r')) return false;
  if (typeof window.nameDisplayWidth === 'function' && window.nameDisplayWidth(trimmed) > window.NAME_DISPLAY_MAX_UNITS) return false;
  return true;
}

function _isValidSkillNameForSelected(name) {
  return _isEditablePlatformSkill(_selectedSkill)
    ? _isValidSkillDisplayName(name)
    : _isValidSkillNameCharset(name);
}

function _toggleSkillNameEditable(nameEl, on) {
  if (!nameEl) return;
  nameEl.setAttribute('contenteditable', on ? 'plaintext-only' : 'false');
  nameEl.classList.toggle('is-editing', !!on);
  if (on) _bindSkillNameSave(nameEl);
}

function _bindSkillNameSave(nameEl) {
  if (nameEl.dataset.bound === '1') return;
  nameEl.dataset.bound = '1';
  if (typeof window.bindNameLimitControl === 'function') window.bindNameLimitControl(nameEl);
  nameEl.addEventListener('input', () => _scheduleSkillFieldSave('name', nameEl.innerText));
  nameEl.addEventListener('blur', () => _flushSkillFieldSave());
}

let _pendingSkillField = null;
let _skillFieldSaveTimer = null;
function _scheduleSkillFieldSave(field, value) {
  if (!_canEditSelectedSkillName()) return;
  _pendingSkillField = { field, value };
  clearTimeout(_skillFieldSaveTimer);
  _skillFieldSaveTimer = setTimeout(_flushSkillFieldSave, 800);
}

// `validate` is true ONLY when the user explicitly commits (clicks 完成);
// typing-debounced and blur-triggered flushes pass false — bad names
// silently skip the save (DOM keeps the in-progress text) instead of
// popping a uiAlert mid-keystroke. Mirrors agents.js::_flushAgentFieldSave.
//
// During typing we use `skipRename:true` so the directory id stays as the
// original until Done; that keeps the URL / cache keyed by the same id and
// avoids a flurry of dir renames per keystroke. The Done branch fires a
// final `skipRename:false` update to commit the directory rename when the
// new name passed validation and actually differs from the original id.
async function _flushSkillFieldSave({ validate = false } = {}) {
  clearTimeout(_skillFieldSaveTimer);
  _skillFieldSaveTimer = null;
  // Clicking Done blurs the contenteditable title before the click handler
  // runs. That blur autosave can clear `_pendingSkillField`; recover the
  // current DOM value so the explicit commit still performs the dir rename.
  if (!_pendingSkillField && validate && _canEditSelectedSkillName()) {
    const nameEl = document.getElementById('skills-detail-name');
    if (nameEl && String(nameEl.innerText || '').trim() !== _selectedSkillNameFallback()) {
      _pendingSkillField = { field: 'name', value: nameEl.innerText };
    }
  }
  if (!_pendingSkillField || !_selectedSkill) return true;
  const { field, value } = _pendingSkillField;
  if (field === 'name') {
    const invalid = !_isValidSkillNameForSelected(String(value || ''));
    if (invalid) {
      if (!validate) return false;
      _pendingSkillField = null;
      await uiAlert(t('skills.name_invalid'));
      const nameEl = document.getElementById('skills-detail-name');
      if (nameEl) nameEl.innerText = _selectedSkillNameFallback();
      if (_selectedSkill.source === 'custom') {
        // Roll the SKILL.md frontmatter back to the original id too — the
        // skipRename:true writes during typing left a possibly-invalid name
        // on disk; revert so the next listSkills auto-heal doesn't misfire.
        try {
          await apiFetch(`/api/skills/${encodeURIComponent(_selectedSkill.id)}/update?skipRename=1`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: _selectedSkill.id }),
          });
        } catch (_) { /* best-effort revert */ }
      }
      return false;
    }
  }
  _pendingSkillField = null;
  const currentId = _selectedSkill.id;
  const newName = String(value || '').trim();
  if (_isEditablePlatformSkill(_selectedSkill)) {
    try {
      const data = await window.orkas.invoke('skills.updateForEdit', {
        id: currentId,
        updates: { [field]: value },
      });
      if (!data || data.ok === false) {
        throw new Error(data?.error || 'save failed');
      }
      if (field === 'name') {
        const nextName = data.skill?.name || newName || currentId;
        _skillsCache = null;
        _skillTreeCache.clear();
        await loadSkills();
        _selectedSkill = { ..._selectedSkill, name: nextName };
        const nameEl = document.getElementById('skills-detail-name');
        if (nameEl) nameEl.innerText = nextName;
      }
      return true;
    } catch (e) {
      if (validate && field === 'name') {
        await uiAlert(t('skills.rename_failed', { reason: e.message || e }));
        const nameEl = document.getElementById('skills-detail-name');
        if (nameEl) nameEl.innerText = _selectedSkillNameFallback();
      }
      return false;
    }
  }
  const skipRename = !validate || newName === currentId;
  // ipc-shim's `wrapAsUpdates` wraps the body under `updates`, so the
  // request body holds only field values; `skipRename` rides on the URL
  // query string so it lands as a sibling of `updates` in the IPC payload.
  const url = `/api/skills/${encodeURIComponent(currentId)}/update${skipRename ? '?skipRename=1' : ''}`;
  try {
    const res = await apiFetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: value }),
    });
    const data = await res.json();
    if (!data.ok) {
      throw new Error(data.error || 'save failed');
    }
    if (validate && field === 'name' && !skipRename) {
      // Directory was renamed — refresh caches + update _selectedSkill.id
      // so subsequent calls (selectSkillFile / chat dir lookup) hit the
      // new id, not the stale one.
      const resultId = data.skill?.id || newName;
      _skillsCache = null;
      _skillTreeCache.clear();
      _expandedDirs.delete(`custom:${currentId}`);
      await loadSkills();
      _selectedSkill = { ..._selectedSkill, id: resultId };
      _skillEditSkillId = resultId;
    }
    return true;
  } catch (e) {
    if (validate && field === 'name') {
      await uiAlert(t('skills.rename_failed', { reason: e.message || e }));
      const nameEl = document.getElementById('skills-detail-name');
      if (nameEl) nameEl.innerText = _selectedSkill.id;
    }
    return false;
  }
}

// ─── Inline skill chat (edit-mode only, per-skill storage) ───

let _skillEditMode = false;
let _skillEditSkillId = null;
// Id of an unconfirmed URL-import placeholder skill. While set, leaving the
// import chat discards the draft if it was never authored (e.g. the source was
// installed as an external package, or the install failed). Cleared once the
// import produces real content or finalizes as a package.
let _importDraftId = null;

function _updateEditButtonLabel() {
  const btn = document.getElementById('skill-edit-btn');
  if (!btn) return;
  if (_skillEditMode) {
    btn.textContent = t('skills.edit_btn_done');
    return;
  }
  // Tag the "Edit" label on marketplace skills (dev-only entry); the "Done"
  // branch above stays bare — in edit mode the marker is redundant.
  const suffix = (_isSkillPlatformSource(_selectedSkill?.source) && false) ? t('common.dev_suffix') : '';
  btn.textContent = t('skills.edit_btn_edit') + suffix;
}

function _skillImportAutoSeedFromResponse(data) {
  if (data?.seedModelText === false || data?.seedMessage === false) return false;
  const modelText = typeof data?.seedModelText === 'string' && data.seedModelText.trim()
    ? data.seedModelText.trim()
    : (typeof data?.seedMessage === 'string' ? data.seedMessage.trim() : '');
  if (!modelText) return true;
  const displayText = typeof data?.seedDisplayText === 'string' && data.seedDisplayText.trim()
    ? data.seedDisplayText.trim()
    : t('skills.import_seed_display');
  return { displayText, modelText, force: true };
}

function _skillAutoSeedHasModelText(autoSeed) {
  if (typeof autoSeed === 'string') return !!autoSeed.trim();
  return !!(autoSeed && typeof autoSeed === 'object' && typeof autoSeed.modelText === 'string' && autoSeed.modelText.trim());
}

// When called with {autoSeed: true} (e.g. right after skill creation), sends
// a short "help me refine this skill" message to kick off the LLM. Import
// flows pass {displayText, modelText}: the chat bubble stays concise, while
// model_text carries the full source-inspection instructions. In plain edit
// mode (user clicks "edit" on an existing skill) no message is sent
// automatically — the user drives the conversation from a blank input.
async function toggleSkillEditMode(opts = {}) {
  if (!_selectedSkill) return;
  // Marketplace editing is dev-only; lift the source guard accordingly.
  if (_selectedSkill.source !== 'custom'
      && !(_isSkillPlatformSource(_selectedSkill.source) && false)) return;
  if (_skillEditMode && _skillEditSkillId === _selectedSkill.id) {
    // Abort any in-flight reply so "done" means "stop + exit", not
    // "exit but keep streaming". The chat controller is a singleton;
    // leaving it pending also leaks the streaming-button state into
    // the next skill's edit panel when the user clicks "edit"
    // elsewhere.
    try { _skillChatCtrl?.abort(); } catch (_) { /* ignore */ }
    // Done click is the explicit commit point: flush any pending name
    // edit + validate. Invalid name → alert + revert DOM (and roll the
    // SKILL.md frontmatter back to the original id, see the validate
    // branch in `_flushSkillFieldSave`). Valid + actually-changed name
    // → fires a `skipRename:false` update which commits the directory
    // rename + refreshes caches before we re-render readonly view.
    const committed = await _flushSkillFieldSave({ validate: true });
    if (committed === false) return;
    // Explicit "Done" is a commit: keep the skill (even an empty import draft
    // the user chose to finalize) and stop the back-prompt from firing.
    _importDraftId = null;
    _skillEditMode = false;
    _skillEditSkillId = null;
    document.getElementById('skills-chat-col').style.display = 'none';
    _updateEditButtonLabel();
    // Swap the body back to read-only view of the current file. Use the
    // _selectedSkill.id snapshot — flush may have rotated it if the
    // directory got renamed.
    await selectSkillFile(_selectedSkill.source, _selectedSkill.id,
      _selectedSkill.filepath || 'SKILL.md', null);
    return;
  }
  _skillEditMode = true;
  _skillEditSkillId = _selectedSkill.id;
  document.getElementById('skills-chat-col').style.display = 'flex';
  _updateEditButtonLabel();
  // Re-render the currently selected file as an editor.
  await selectSkillFile(_selectedSkill.source, _selectedSkill.id,
    _selectedSkill.filepath || 'SKILL.md', null);
  _ensureSkillChatController();
  await _skillChatCtrl.loadHistory();
  await _chatAttachRefreshFromServer(_skillEditAttachmentCid(_skillEditSkillId));
  if (opts.autoSeed) {
    const existing = document.querySelectorAll('#skills-chat-messages .chat-message');
    const forceAutoSeed = !!(opts.autoSeed && typeof opts.autoSeed === 'object' && opts.autoSeed.force === true);
    if (forceAutoSeed || existing.length === 0) {
      const baseSeed = t('skills.help_finish_seed_model');
      const importSeed = typeof opts.autoSeed === 'string'
        ? opts.autoSeed.trim()
        : (opts.autoSeed && typeof opts.autoSeed === 'object' && typeof opts.autoSeed.modelText === 'string'
            ? opts.autoSeed.modelText.trim()
            : '');
      const seed = importSeed
        ? [baseSeed, importSeed].filter(Boolean).join('\n\n')
        : baseSeed;
      const displayText = importSeed
        ? (opts.autoSeed && typeof opts.autoSeed === 'object' && typeof opts.autoSeed.displayText === 'string' && opts.autoSeed.displayText.trim()
            ? opts.autoSeed.displayText.trim()
            : t('skills.import_seed_display'))
        : t('skills.help_finish_seed');
      await _skillChatCtrl.send(displayText, { model_text: seed });
    }
  }
}

// Lazy singleton — created once, driven by `_skillEditSkillId` via the id
// resolver so it follows the currently active skill.
let _skillChatCtrl = null;
let _skillEditAttachmentsBound = false;
let _pendingSkillImportReplacementId = null;

function _skillEditAttachmentCid(skillId) {
  return skillId ? `skill-edit-${skillId}` : '';
}

function _bindSkillEditAttachments() {
  if (_skillEditAttachmentsBound) return;
  _skillEditAttachmentsBound = true;
  const btn = document.getElementById('skills-chat-attach-btn');
  const area = document.querySelector('.skills-chat-input-area');
  const input = document.getElementById('skills-chat-input');
  const currentCid = () => _skillEditAttachmentCid(_skillEditSkillId || '');
  if (btn) {
    btn.addEventListener('click', async () => {
      const cid = currentCid();
      if (cid) await _chatAttachPickAndUpload(cid, 'picker');
    });
  }
  if (area) {
    area.addEventListener('dragover', (e) => {
      const hasFiles = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length;
      const hasInternal = e.dataTransfer && Array.from(e.dataTransfer.types || []).includes(ORKAS_FILE_DRAG_MIME);
      if (!hasFiles && !hasInternal) return;
      e.preventDefault();
      area.classList.add('drag-over');
    });
    area.addEventListener('dragleave', () => area.classList.remove('drag-over'));
    area.addEventListener('drop', async (e) => {
      const cid = currentCid();
      if (!cid) return;
      const internal = _chatAttachInternalDragItems(e.dataTransfer);
      if (internal.length) {
        e.preventDefault();
        area.classList.remove('drag-over');
        await _chatAttachImportPaths(cid, internal, 'internal_drop');
        return;
      }
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        e.preventDefault();
        area.classList.remove('drag-over');
        await _chatAttachUpload(cid, e.dataTransfer.files, 'drop');
      }
    });
  }
  if (input) {
    input.addEventListener('paste', async (e) => {
      if (!e.clipboardData || !e.clipboardData.files || !e.clipboardData.files.length) return;
      const cid = currentCid();
      if (!cid) return;
      e.preventDefault();
      await _chatAttachUpload(cid, e.clipboardData.files, 'paste');
    });
  }
}

async function _buildSkillEditChatExtraBody(_content, skillId, state) {
  const cid = _skillEditAttachmentCid(skillId);
  const items = _chatAttachList(cid);
  if (!items.length) return undefined;
  if (items.some((a) => a.status === 'uploading')) {
    await uiAlert(t('chat.attach_still_uploading'));
    return null;
  }
  const attachments = items.filter((a) => a.status !== 'error').map((a) => a.name);
  if (!attachments.length) return undefined;
  if (state && (state.pending || state.hasQueue)) {
    await uiAlert(t('chat.attach_queue_blocked'));
    return null;
  }
  _chatAttachClear(cid);
  return { attachments, attachment_cid: cid };
}

function _ensureSkillChatController() {
  if (_skillChatCtrl) return _skillChatCtrl;
  _bindSkillEditAttachments();
  _skillChatCtrl = createChatController({
    historyEl: 'skills-chat-messages',
    inputEl: 'skills-chat-input',
    sendBtnEl: 'skills-chat-send-btn',
    getCurrentId: () => _skillEditSkillId,
    historyEndpoint: (id) => `/api/skills/${encodeURIComponent(id)}/chat`,
    streamEndpoint: (id) => `/api/skills/${encodeURIComponent(id)}/chat/send/stream`,
    clearEndpoint: (id) => `/api/skills/${encodeURIComponent(id)}/chat`,
    features: { archive: false, scrollPin: true, queue: true },
    queue: {
      keyPrefix: 'skill',
      panelId: 'skills-chat-queue',
      listId: 'skills-chat-queue-list',
      countId: 'skills-chat-queue-count',
    },
    hooks: {
      buildExtraBody: _buildSkillEditChatExtraBody,
      async onFinal(ev, msgEl, id) {
        // Authoring wrote real files → this import produced a genuine custom
        // skill; commit it so backing out no longer prompts/discards.
        if (ev?.written?.length || ev?.created?.length) _importDraftId = null;
        if (_pendingSkillImportReplacementId) {
          const nextId = _pendingSkillImportReplacementId;
          _pendingSkillImportReplacementId = null;
          _importDraftId = null;
          _skillEditSkillId = nextId;
          _selectedSkill = { source: 'custom', id: nextId, filepath: 'SKILL.md' };
          _skillsCache = null;
          await _showSkillsDetailView('custom', nextId);
          await _skillChatCtrl.loadHistory();
          return;
        }
        // Skill chat may rewrite files on disk; refresh the detail pane so
        // the tree and SKILL.md display reflect the new state.
        await _refreshSkillView();
      },
      onStreamEvent(ev, msgEl, id) {
        const inner = ev?.event;
        if (!inner) return;
        // `skill_as_package`: the URL import was installed as an external
        // package and main deleted the placeholder skill. Switch the detail
        // pane to the package result state (no skill content to show).
        if (inner.stream === 'skill_as_package') {
          // Placeholder already deleted by main; clear the draft guard so the
          // grid-view exit doesn't try to re-discard a gone id.
          _importDraftId = null;
          _showSkillAsPackageState(inner.data?.name || '');
          return;
        }
        if (inner.stream === 'skill_import_replaced') {
          const nextId = inner.data?.skillId || inner.data?.skills?.[0]?.skill_id || '';
          if (nextId) {
            _pendingSkillImportReplacementId = nextId;
            _importDraftId = null;
            _skillsCache = null;
          }
          return;
        }
        // Auto-rename on `skill_renamed` event from main: the skill's
        // SKILL.md `name:` differs from its dir id, so main moved the dir
        // (and its chat dir + session id) to the new id. Switch the
        // active edit chat to the new id transparently.
        if (inner.stream !== 'skill_renamed') return;
        const { oldId, newId } = inner.data || {};
        if (!oldId || !newId || oldId === newId) return;
        if (id !== oldId && _skillEditSkillId !== oldId) return;
        // A rename means real content was authored — commit the import draft.
        _importDraftId = null;
        // Update active selection / id-resolver target
        _skillEditSkillId = newId;
        if (_selectedSkill && _selectedSkill.id === oldId) {
          _selectedSkill = { ..._selectedSkill, id: newId };
        }
        _skillsCache = null;
        // Refresh list + detail pane lazily — avoid blocking the stream
        // reader. If the user is mid-stream we can't reload mid-flight, so
        // fire-and-forget; the stream reader will keep yielding into the
        // (still attached) msgEl.
        Promise.resolve().then(() => loadSkills()).catch(() => {});
      },
    },
  });
  return _skillChatCtrl;
}

async function clearSkillChat() {
  if (!_skillEditSkillId) return;
  if (!(await uiConfirm(t('skills.clear_confirm')))) return;
  _ensureSkillChatController();
  await _skillChatCtrl.clear();
}

async function _refreshSkillView() {
  if (!_skillEditSkillId) return;
  const sid = _skillEditSkillId;
  // Source must come from the active selection, not be hardcoded — dev-mode
  // built-in editing reuses this same path and was previously bailing here
  // because of a 'custom'-only equality check.
  const source = _selectedSkill?.source || 'custom';

  // Refresh the skill list cache (in case name/description in SKILL.md changed)
  _skillsCache = null;
  await loadSkills();

  // Refresh the tree cache so subsequent expansion sees the latest files
  const treeKey = `${source}:${sid}`;
  _skillTreeCache.delete(treeKey);

  // Bail if user navigated away while we were awaiting above.
  if (!_selectedSkill || _selectedSkill.id !== sid || _selectedSkill.source !== source) return;

  // Re-render the whole detail page via selectSkillFile so the header
  // (name) and the doc sections (description / external deps /
  // dependent skills / ...) pick up SKILL.md frontmatter changes the
  // LLM just made — without this, the description chip stayed on the
  // pre-edit value until the user clicked "done". selectSkillFile
  // also re-reads the body, so we
  // don't need a separate body refetch here.
  const filepath = _selectedSkill.filepath || 'SKILL.md';
  await selectSkillFile(source, sid, filepath, null);

  // selectSkillFile clears tree active state. If the source panel is
  // expanded, refresh it in case files were added/removed (e.g. the LLM
  // wrote a new script) and re-mark the active file.
  const sourceToggle = document.getElementById('skills-source-toggle');
  const sourcePanel = document.getElementById('skills-source-panel');
  const sourceTreeEl = document.getElementById('skills-source-tree');
  const expanded = sourceToggle?.getAttribute('aria-expanded') === 'true';
  if (expanded && sourcePanel && sourceTreeEl) {
    await expandSkillTree(source, sid, sourceTreeEl);
  }
  _markActiveSkillFileInTree(filepath);
}

// ─── Custom skill CRUD ───

let _skillModalBusy = false;

function _setSkillModalBusy(busy) {
  _skillModalBusy = !!busy;
  const modal = document.getElementById('skill-modal');
  if (modal) modal.setAttribute('aria-busy', _skillModalBusy ? 'true' : 'false');
  const ids = [
    'skill-save-btn',
    'skill-dir-pick-btn',
    'skill-url-input',
    'skill-name',
    'skill-description',
  ];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) el.disabled = _skillModalBusy;
  }
  document.querySelectorAll('#skill-modal .modal-actions .btn, #skill-modal .skill-modal-tab')
    .forEach((el) => { el.disabled = _skillModalBusy; });
}

function _waitForSkillModalBusyPaint() {
  return new Promise((resolve) => {
    const raf = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (cb) => setTimeout(cb, 0);
    raf(() => resolve());
  });
}

function _switchSkillTab(tab) {
  if (_skillModalBusy) return;
  const tabs = document.querySelectorAll('.skill-modal-tab');
  tabs.forEach((el) => el.classList.toggle('is-active', el.dataset.skillTab === tab));
  const panels = document.querySelectorAll('.skill-modal-panel');
  panels.forEach((el) => el.classList.toggle('is-active', el.dataset.skillPanel === tab));
  // Clear error msg when switching tabs
  const msgEl = document.getElementById('skill-form-msg');
  if (msgEl) { msgEl.textContent = ''; msgEl.className = 'form-msg'; }
  // Focus primary input of the new tab
  setTimeout(() => {
    const focusId = tab === 'url' ? 'skill-url-input'
                  : tab === 'dir' ? 'skill-dir-pick-btn'
                  : 'skill-name';
    const el = document.getElementById(focusId);
    if (el) el.focus();
  }, 30);
}
window._switchSkillTab = _switchSkillTab;

async function openSkillModal(editId) {
  const modal = document.getElementById('skill-modal');
  const title = document.getElementById('skill-modal-title');
  const editIdInput = document.getElementById('skill-edit-id');
  const msgEl = document.getElementById('skill-form-msg');
  const saveBtn = document.getElementById('skill-save-btn');
  const tabBar = document.getElementById('skill-modal-tabs');
  _setSkillModalBusy(false);
  msgEl.textContent = '';
  msgEl.className = 'form-msg';

  // Reset all inputs across all panels
  for (const id of [
    'skill-name', 'skill-description',
    'skill-url-input',
    'skill-dir-path',
  ]) {
    const el = document.getElementById(id);
    if (el) el.value = '';
  }
  const sel = document.getElementById('skill-dir-selected');
  if (sel) sel.textContent = t('skill_modal.dir_none');

  if (editId) {
    title.textContent = t('skills.modal_edit_title');
    saveBtn.textContent = t('common.confirm');
    editIdInput.value = editId;
    if (tabBar) tabBar.style.display = 'none'; // edit mode: no tabs, manual only
    _switchSkillTab('manual');
    const cached = _skillsCache?.find(s => s.id === editId && s.source === 'custom');
    if (cached) {
      document.getElementById('skill-name').value = cached.name || '';
      // Edit modal keeps a single description field for now (UX kept simple);
      // form input is merely a seed — the full bilingual pair is authored
      // through the inline edit-chat. Show whichever locale matches the
      // active UI language with cross-fallback.
      document.getElementById('skill-description').value = pickDesc(cached, getLang()) || '';
    }
  } else {
    title.textContent = t('skills.modal_new_title');
    saveBtn.textContent = t('common.confirm');
    editIdInput.value = '';
    if (tabBar) tabBar.style.display = '';
    _switchSkillTab('manual');
  }

  // Wire tab buttons (idempotent — checks a flag)
  if (tabBar && !tabBar.dataset.wired) {
    tabBar.querySelectorAll('.skill-modal-tab').forEach((btn) => {
      btn.addEventListener('click', () => _switchSkillTab(btn.dataset.skillTab));
    });
    tabBar.dataset.wired = '1';
  }

  modal.classList.add('open');
  if (typeof window.bindNameLimitControl === 'function') {
    window.bindNameLimitControl(document.getElementById('skill-name'));
  }
}
window.openSkillModal = openSkillModal;

function closeSkillModal() {
  document.getElementById('skill-modal').classList.remove('open');
}
window.closeSkillModal = closeSkillModal;

async function pickSkillImportDir() {
  const msgEl = document.getElementById('skill-form-msg');
  msgEl.textContent = '';
  try {
    const res = await apiFetch('/api/skills/pick-import-dir', { method: 'POST' });
    const data = await res.json();
    if (!data.ok) {
      msgEl.textContent = data.error || t('skill_modal.dir_pick_failed');
      msgEl.className = 'form-msg err';
      return;
    }
    if (data.cancelled) return;
    const p = String(data.path || '');
    document.getElementById('skill-dir-path').value = p;
    document.getElementById('skill-dir-selected').textContent = p;
  } catch (_) {
    msgEl.textContent = t('skills.network_error_plain');
    msgEl.className = 'form-msg err';
  }
}
window.pickSkillImportDir = pickSkillImportDir;

function _skillCreateNow() {
  if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function _skillCreateDuration(startedAt) {
  return Math.max(0, Math.round(_skillCreateNow() - Number(startedAt || 0)));
}

function _skillCreatePayload(creationMethod, data) {
  return Object.assign({ creation_method: creationMethod }, data || {});
}

function _skillCreateTrackClick(creationMethod, data) {
  try {
    const monitor = (typeof window !== 'undefined') ? window.Monitor : null;
    if (monitor && typeof monitor.click === 'function') {
      monitor.click('skill_create_submit', _skillCreatePayload(creationMethod, data));
    }
  } catch (_) {}
}

function _skillCreateTrackResult(tracking, result, data) {
  try {
    const monitor = (typeof window !== 'undefined') ? window.Monitor : null;
    if (monitor && typeof monitor.event === 'function') {
      monitor.event('skill_create_result', _skillCreatePayload(tracking.creationMethod, Object.assign({
        result,
        duration_ms: _skillCreateDuration(tracking.startedAt),
      }, data || {})));
    }
  } catch (_) {}
}

function _skillCreateTrackError(tracking, data) {
  try {
    const monitor = (typeof window !== 'undefined') ? window.Monitor : null;
    if (monitor && typeof monitor.error === 'function') {
      monitor.error('skill_create', _skillCreatePayload(tracking.creationMethod, data || {}));
    }
  } catch (_) {}
}

function _skillCreateTracking(creationMethod, clickData) {
  const tracking = {
    creationMethod,
    startedAt: _skillCreateNow(),
  };
  _skillCreateTrackClick(creationMethod, clickData);
  return tracking;
}

function _skillCreateIdFromResponse(data) {
  return data?.skill?.id || data?.skills?.[0]?.id || '';
}

function _skillCreateCountFromResponse(data) {
  if (Array.isArray(data?.skills)) return data.skills.length;
  return data?.skill ? 1 : 0;
}

async function saveSkill() {
  if (_skillModalBusy) return;
  const editId = document.getElementById('skill-edit-id').value;
  const msgEl = document.getElementById('skill-form-msg');

  // Edit mode: always manual path.
  if (editId) {
    return _saveSkillManual({ editId, msgEl });
  }

  const activeTab = document.querySelector('.skill-modal-tab.is-active')?.dataset.skillTab || 'manual';
  if (activeTab === 'url') return _saveSkillFromUrl({ msgEl });
  if (activeTab === 'dir') return _saveSkillFromDir({ msgEl });
  return _saveSkillManual({ editId: '', msgEl });
}
window.saveSkill = saveSkill;

async function _saveSkillManual({ editId, msgEl }) {
  const rawName = document.getElementById('skill-name').value;
  const name = rawName.trim();
  const description = document.getElementById('skill-description').value.trim();
  if (!name) {
    msgEl.textContent = t('skills.input_name_needed');
    msgEl.className = 'form-msg err';
    document.getElementById('skill-name').focus();
    return;
  }
  if (!_isValidSkillNameCharset(rawName)) {
    msgEl.textContent = t('skills.name_invalid');
    msgEl.className = 'form-msg err';
    document.getElementById('skill-name').focus();
    return;
  }
  if (!description) {
    msgEl.textContent = t('skills.input_desc_needed');
    msgEl.className = 'form-msg err';
    document.getElementById('skill-description').focus();
    return;
  }
  const tracking = editId ? null : _skillCreateTracking('manual', { category: 'general' });
  try {
    // Create: stamp the marketplace default since the modal has no category picker.
    // Edit: omit category so the on-disk frontmatter value is preserved (LLM-authored
    // edits via `skill-creator` are the only source of category mutation).
    const body = editId ? { name, description } : { name, description, category: 'general' };
    const res = editId
      ? await apiFetch(`/api/skills/${editId}/update`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      : await apiFetch('/api/skills/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
    const data = await res.json();
    if (!data.ok) {
      msgEl.textContent = data.error || t('skills.save_failed');
      msgEl.className = 'form-msg err';
      if (tracking) {
        _skillCreateTrackResult(tracking, 'failure', {
          category: 'general',
          error_code: data.code || '',
        });
        _skillCreateTrackError(tracking, {
          category: 'general',
          error_type: 'api',
          error_code: data.code || '',
          error_message: data.error || 'unknown',
        });
      }
      return;
    }
    if (tracking) {
      _skillCreateTrackResult(tracking, 'success', {
        skill_id: _skillCreateIdFromResponse(data),
        skill_count: _skillCreateCountFromResponse(data),
        category: 'general',
      });
    }
    await _afterSkillCreated(data.skill?.id || editId, !editId, null);
  } catch (e) {
    msgEl.textContent = t('skills.network_error_plain');
    msgEl.className = 'form-msg err';
    if (tracking) {
      _skillCreateTrackResult(tracking, 'failure', { category: 'general' });
      _skillCreateTrackError(tracking, {
        category: 'general',
        error_type: 'network',
        error_message: e && e.message ? e.message : String(e),
      });
    }
  }
}

async function _saveSkillFromUrl({ msgEl }) {
  const url = document.getElementById('skill-url-input').value.trim();
  if (!/^https?:\/\//i.test(url)) {
    msgEl.textContent = t('skill_modal.err_url_invalid');
    msgEl.className = 'form-msg err';
    document.getElementById('skill-url-input').focus();
    return;
  }
  const tracking = _skillCreateTracking('url');
  try {
    msgEl.textContent = t('skills.saving');
    msgEl.className = 'form-msg';
    _setSkillModalBusy(true);
    await _waitForSkillModalBusyPaint();
    const res = await apiFetch('/api/skills/create-from-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: null, description: null, url }),
    });
    const data = await res.json();
    if (!data.ok) {
      msgEl.textContent = data.error || t('skills.save_failed');
      msgEl.className = 'form-msg err';
      _setSkillModalBusy(false);
      _skillCreateTrackResult(tracking, 'failure', {
        error_code: data.code || '',
      });
      _skillCreateTrackError(tracking, {
        error_type: 'api',
        error_code: data.code || '',
        error_message: data.error || 'unknown',
      });
      return;
    }
    const createdId = _skillCreateIdFromResponse(data);
    const autoSeed = _skillImportAutoSeedFromResponse(data);
    // URL imports start as empty placeholders. If the user backs out before
    // the edit chat authors real content, offer to discard that placeholder.
    _importDraftId = data.skill?.id && _skillAutoSeedHasModelText(autoSeed) ? data.skill.id : null;
    _skillCreateTrackResult(tracking, 'success', {
      skill_id: createdId,
      skill_count: _skillCreateCountFromResponse(data),
    });
    await _afterSkillCreated(createdId, true, autoSeed);
  } catch (e) {
    msgEl.textContent = t('skills.network_error_plain');
    msgEl.className = 'form-msg err';
    _skillCreateTrackResult(tracking, 'failure');
    _skillCreateTrackError(tracking, {
      error_type: 'network',
      error_message: e && e.message ? e.message : String(e),
    });
  } finally {
    _setSkillModalBusy(false);
  }
}

async function _saveSkillFromDir({ msgEl }) {
  const srcDir = document.getElementById('skill-dir-path').value.trim();
  if (!srcDir) {
    msgEl.textContent = t('skill_modal.err_dir_missing');
    msgEl.className = 'form-msg err';
    return;
  }
  return _saveSkillFromDirWithQuality({
    msgEl,
    srcDir,
    force: false,
    tracking: _skillCreateTracking('dir', { forced: false }),
  });
}

function _qualityForceImportLabel() {
  const v = t('quality.force_import');
  return v === 'quality.force_import' ? 'Import anyway' : v;
}

function _qualityImportRejectedTitle(name) {
  const tmpl = t('quality.import_rejected_title');
  const fallback = `Import rejected by quality validator: ${name}`;
  return tmpl === 'quality.import_rejected_title'
    ? fallback
    : tmpl.replace('{name}', name);
}

async function _saveSkillFromDirWithQuality({ msgEl, srcDir, force, tracking }) {
  tracking = tracking || _skillCreateTracking('dir', { forced: !!force });
  try {
    msgEl.textContent = t('skills.saving');
    msgEl.className = 'form-msg';
    _setSkillModalBusy(true);
    await _waitForSkillModalBusyPaint();
    const res = await apiFetch('/api/skills/create-from-dir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: null, description: null, srcDir, ...(force ? { force: true } : {}) }),
    });
    const data = await res.json();
    if (!data.ok) {
      _setSkillModalBusy(false);
      if (!force && data.report && typeof showValidationReport === 'function') {
        const titleName = data.skillId || srcDir.split(/[\\/]/).filter(Boolean).pop() || srcDir;
        const action = await showValidationReport({
          title: _qualityImportRejectedTitle(titleName),
          report: data.report,
          forceLabel: _qualityForceImportLabel(),
        });
        if (action === 'force') {
          return await _saveSkillFromDirWithQuality({ msgEl, srcDir, force: true, tracking });
        }
        _skillCreateTrackResult(tracking, 'blocked', {
          forced: false,
          error_code: data.code || 'quality_validation',
        });
        _skillCreateTrackError(tracking, {
          forced: false,
          error_type: 'validation',
          error_code: data.code || 'quality_validation',
          error_message: data.error || 'quality validation failed',
        });
        msgEl.textContent = data.error || t('skills.save_failed');
        msgEl.className = 'form-msg err';
        return;
      }
      msgEl.textContent = data.error || t('skills.save_failed');
      msgEl.className = 'form-msg err';
      _skillCreateTrackResult(tracking, 'failure', {
        forced: !!force,
        error_code: data.code || '',
      });
      _skillCreateTrackError(tracking, {
        forced: !!force,
        error_type: data.report ? 'validation' : 'api',
        error_code: data.code || '',
        error_message: data.error || 'unknown',
      });
      return;
    }
    const createdId = _skillCreateIdFromResponse(data);
    _skillCreateTrackResult(tracking, 'success', {
      skill_id: createdId,
      skill_count: _skillCreateCountFromResponse(data),
      forced: !!force,
    });
    await _afterSkillCreated(createdId, true, _skillImportAutoSeedFromResponse(data));
  } catch (e) {
    msgEl.textContent = t('skills.network_error_plain');
    msgEl.className = 'form-msg err';
    _skillCreateTrackResult(tracking, 'failure', { forced: !!force });
    _skillCreateTrackError(tracking, {
      forced: !!force,
      error_type: 'network',
      error_message: e && e.message ? e.message : String(e),
    });
  } finally {
    _setSkillModalBusy(false);
  }
}

// Shared "after create" tail: close modal, refresh list, jump to edit view.
// `autoSeed` — optional first message descriptor for the skill edit chat.
//              Pass null to let toggleSkillEditMode use its default seed
//              ("help me refine this skill"). Pass false to skip entering
//              edit chat. Ignored in edit mode (isNew=false).
async function _afterSkillCreated(sid, isNew, autoSeed) {
  closeSkillModal();
  _skillsCache = null;
  await loadSkills();
  if (!sid) return;
  setView('skills');
  // Jump straight into detail view for the new skill (skipping the grid
  // landing) so the user can see what they just created and start editing.
  // This must finish before entering edit chat: selectSkillFile() owns the
  // detail/chat visibility state, so racing it against toggleSkillEditMode()
  // can leave imports on the readonly detail page.
  await _showSkillsDetailView('custom', sid, { expandSource: false });
  if (isNew) {
    if (!_selectedSkill || _selectedSkill.source !== 'custom' || _selectedSkill.id !== sid) {
      _selectedSkill = { source: 'custom', id: sid, filepath: 'SKILL.md' };
    }
    if (autoSeed === false) return;
    await toggleSkillEditMode({ autoSeed: autoSeed || true });
    Promise.resolve().then(() => {
      if (_selectedSkill?.source === 'custom' && _selectedSkill?.id === sid) {
        return _ensureSkillsSourceExpanded();
      }
    }).catch(() => {});
  }
}

function editSelectedSkill() {
  if (!_selectedSkill || _selectedSkill.source !== 'custom') return;
  // Custom skills are edited via the inline AI chat (already visible on the right)
  const input = document.getElementById('skills-chat-input');
  if (input) {
    input.focus();
    // Scroll chat into view if needed
    input.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }
}

async function deleteSelectedSkill() {
  if (!_selectedSkill) return;
  const src = _selectedSkill.source;
  if (src !== 'custom' && !(_isSkillPlatformSource(src) && false)) return;
  const sid = _selectedSkill.id;
  const cached = _skillsCache?.find(s => s.id === sid && s.source === src);
  if (!(await uiConfirm(t('skills.delete_confirm', { name: cached?.name || sid })))) return;
  try {
    const result = _isSkillPlatformSource(src)
      ? await window.orkas.invoke('skills.builtin.delete', { id: sid })
      : await (await apiFetch(`/api/skills/${sid}`, { method: 'DELETE' })).json();
    if (!result.ok) {
      await uiAlert(t('skills.delete_failed_with', { reason: result.error || '' }));
      return;
    }
    _selectedSkill = null;
    _skillsCache = null;
    _skillTreeCache.clear();
    await loadSkills();
    // Snap back to grid view (detail panel is for whole skills, the one
    // we just deleted no longer exists).
    _showSkillsGridView();
  } catch (e) {
    await uiAlert(t('skills.delete_failed_with', { reason: e.message || e }));
  }
}

/**
 * Per-skill enable / disable button in the detail header.
 * Clone-replace the node each render to drop any prior click handler
 * bound to a stale skill id. The button label flips between "enable"
 * and "disable" (whichever the click would do).
 */
function _renderSkillEnabledButton(skill) {
  const oldBtn = document.getElementById('skill-enabled-btn');
  if (!oldBtn) return;
  const enabled = skill.enabled !== false;
  const btn = oldBtn.cloneNode(true);
  oldBtn.parentNode.replaceChild(btn, oldBtn);
  btn.textContent = enabled ? t('component.disable') : t('component.enable');
  btn.title = enabled ? t('component.toggle_disable_hint') : t('component.toggle_enable_hint');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try { await _flipSkillEnabled(skill.id, !enabled); }
    finally { btn.disabled = false; }
  });
}
