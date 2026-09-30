// A composer has one immutable editor document. Plain text is a boundary format
// (send, persisted draft, clipboard), never a second editable copy of that document.
const _composerInputs = new Map();
let _composerNavigationEpoch = 0;
const _composerBlockTextCache = new WeakMap();
const _composerDocumentTextCache = new WeakMap();
const _composerSchema = new OrkasEditor.Schema({ nodes: {
  doc: { content: 'paragraph+' },
  paragraph: { content: 'inline*', group: 'block', whitespace: 'pre',
    parseDOM: [{ tag: 'p' }, { tag: 'div' }], toDOM: () => ['p', 0] },
  text: { group: 'inline' },
  token: { inline: true, group: 'inline', atom: true, selectable: true,
    attrs: { raw: {}, selection: {} },
    // Clipboard HTML is deliberately not trusted as token metadata. Paste goes
    // through the established plain-text parser, scoped to the receiving task.
    toDOM: node => _chatRichCreateUseChip(node.attrs.selection, node.attrs.raw) },
} });

function _composerBlockText(block) {
  let text = _composerBlockTextCache.get(block);
  if (text !== undefined) return text;
  text = '';
  block.forEach(node => { text += node.isText ? node.text : node.attrs.raw; });
  _composerBlockTextCache.set(block, text);
  return text;
}
function _composerDocumentText(doc) {
  let text = _composerDocumentTextCache.get(doc);
  if (text !== undefined) return text;
  const lines = [];
  doc.forEach(block => lines.push(_composerBlockText(block)));
  text = lines.join('\n');
  _composerDocumentTextCache.set(doc, text);
  return text;
}
function _composerInline(text, id) {
  const nodes = [];
  let cursor = 0;
  for (const token of _findChatComposerTokens(text, id)) {
    if (token.start < cursor || token.end > text.length) continue;
    if (cursor < token.start) nodes.push(_composerSchema.text(text.slice(cursor, token.start)));
    nodes.push(_composerSchema.nodes.token.create({ raw: token.raw, selection: token.selection }));
    cursor = token.end;
  }
  if (cursor < text.length) nodes.push(_composerSchema.text(text.slice(cursor)));
  return nodes;
}
function _composerDocument(text, id) {
  const raw = String(text || '');
  const blocks = [], inline = [];
  const appendText = value => {
    const lines = value.split('\n');
    lines.forEach((line, index) => {
      if (index) { blocks.push(_composerSchema.nodes.paragraph.create(null, inline.splice(0))); }
      if (line) inline.push(_composerSchema.text(line));
    });
  };
  let cursor = 0;
  for (const token of _findChatComposerTokens(raw, id)) {
    if (token.start < cursor) continue;
    appendText(raw.slice(cursor, token.start));
    inline.push(_composerSchema.nodes.token.create({ raw: token.raw, selection: token.selection }));
    cursor = token.end;
  }
  appendText(raw.slice(cursor));
  blocks.push(_composerSchema.nodes.paragraph.create(null, inline));
  return _composerSchema.nodes.doc.create(null, blocks);
}
const _composerContextCache = new WeakMap();
function _composerHasCodeSyntax(doc) {
  let result = false;
  doc.forEach(block => {
    let syntax = _composerContextCache.get(block);
    if (syntax === undefined) {
      syntax = /[`~]/.test(_composerBlockText(block));
      block.forEach(node => {
        if (node.isText && (node.text.includes('@{') || node.text.includes('\u2063'))) syntax = true;
      });
      _composerContextCache.set(block, syntax);
    }
    result ||= syntax;
  });
  return result;
}

function _composerRawOffset(doc, pos) {
  let offset = 0;
  let done = false;
  doc.forEach((block, blockPos, index) => {
    if (done) return;
    if (index) offset++;
    const local = pos - blockPos - 1;
    if (local > block.content.size) { offset += _composerBlockText(block).length; return; }
    block.forEach((node, nodePos) => {
      if (nodePos >= local) return;
      offset += node.isText ? Math.min(node.nodeSize, local - nodePos) : node.attrs.raw.length;
    });
    done = true;
  });
  return offset;
}
function _composerPosition(doc, rawOffset, bias = 1) {
  let left = Math.max(0, Number(rawOffset) || 0);
  let found = null;
  doc.forEach((block, blockPos) => {
    if (found !== null) return;
    const length = _composerBlockText(block).length;
    if (left > length) { left -= length + 1; return; }
    let local = 0;
    block.forEach(node => {
      if (found !== null) return;
      const width = node.isText ? node.nodeSize : node.attrs.raw.length;
      if (left <= width) {
        found = blockPos + 1 + local + (node.isText ? left : left === 0 ? 0 : left === width ? 1 : bias < 0 ? 0 : 1);
      } else { left -= width; local += node.nodeSize; }
    });
    if (found === null) found = blockPos + 1 + block.content.size;
  });
  return found === null ? doc.content.size - 1 : found;
}
function _composerElement(input) { return typeof input === 'string' ? document.getElementById(input) : input; }
function _composerApi(input) {
  const el = _composerElement(input);
  if (!el?.matches?.('[data-composer]')) return null;
  return _composerInputs.get(el.id) || _initComposerInput(el);
}
function composerText(input) {
  const el = _composerElement(input);
  const api = _composerApi(el);
  return api ? _composerDocumentText(api.view.state.doc) : String(el?.value || '');
}
const _composerBlockContentCache = new WeakMap();
function composerHasText(input) {
  const api = _composerApi(input);
  if (!api) return !!composerText(input).trim();
  let hasText = false;
  api.view.state.doc.forEach(block => {
    if (hasText) return;
    let value = _composerBlockContentCache.get(block);
    if (value === undefined) {
      value = !!_composerBlockText(block).trim();
      _composerBlockContentCache.set(block, value);
    }
    hasText = value;
  });
  return hasText;
}
function composerIncludes(input, needle) {
  const api = _composerApi(input);
  if (!api || needle.includes('\n')) return composerText(input).includes(needle);
  let found = false;
  api.view.state.doc.forEach(block => { if (!found) found = _composerBlockText(block).includes(needle); });
  return found;
}
function composerSetText(input, text) {
  const el = _composerElement(input);
  const api = _composerApi(el);
  if (api) api.setText(text);
  else if (el) el.value = String(text || '');
}
function composerSelection(input) {
  const el = _composerElement(input);
  const api = _composerApi(el);
  if (!api) return { start: el?.selectionStart || 0, end: el?.selectionEnd || 0 };
  const { doc, selection } = api.view.state;
  return { start: _composerRawOffset(doc, selection.from), end: _composerRawOffset(doc, selection.to) };
}
function composerSetSelection(input, start, end = start) {
  const el = _composerElement(input);
  const api = _composerApi(el);
  if (!api) { el?.setSelectionRange(start, end); return; }
  const { doc } = api.view.state;
  api.view.dispatch(api.view.state.tr.setSelection(OrkasEditor.TextSelection.create(doc,
    _composerPosition(doc, start, -1), _composerPosition(doc, end, 1))));
}
function composerChangeEvent(input) { return _composerElement(input)?.matches?.('[data-composer]') ? 'composer-change' : 'input'; }
function composerNotify(input) {
  const el = _composerElement(input);
  el?.dispatchEvent(new Event(composerChangeEvent(el), { bubbles: true }));
}
function composerSnapshot(input) {
  const api = _composerApi(input);
  if (!api) { const text = composerText(input); return { stamp: text, text: () => text, matches: () => composerText(input) === text }; }
  const doc = api.view.state.doc, revision = api.revision, owner = api.owner, epoch = api.epoch;
  return { stamp: api.stamp, text: () => _composerDocumentText(doc), matches: () =>
    !api.view.composing && api.revision === revision && api.owner === owner && api.epoch === epoch };
}
function composerBindOwner(input, owner) {
  const api = _composerApi(input);
  if (!api || api.owner === owner) return;
  api.owner = owner;
  api.resetHistoryOnSet = true;
  api.epoch++;
  api.stamp = {};
  api.anchors.forEach(anchor => { anchor.valid = false; });
  api.anchors.clear();
  api.editor.dispatchEvent(new Event('composer-owner-change'));
  if (typeof _atKeyMark !== 'undefined' && _atKeyMark?.inputId === api.editor.id) {
    _atKeyMark = null;
    if (typeof _closeAgentPicker === 'function') _closeAgentPicker();
  }
  // Undo must never restore a different task's draft.
  api.view.updateState(OrkasEditor.EditorState.create({ schema: _composerSchema,
    doc: api.view.state.doc, plugins: api.plugins }));
}
function composerSetDisabled(input, disabled) {
  const el = _composerElement(input), api = _composerApi(el);
  if (!api) { if (el) el.disabled = disabled; return; }
  el.setAttribute('aria-disabled', String(!!disabled));
  api.view.setProps({ editable: () => !disabled });
}
function composerPlaceholder(input) {
  const el = _composerElement(input);
  return el?.matches?.('[data-composer]') ? el.getAttribute('placeholder') || '' : el?.placeholder || '';
}
function composerSetPlaceholder(input, text) {
  const el = _composerElement(input);
  if (el?.matches?.('[data-composer]')) el.setAttribute('placeholder', text);
  else if (el) el.placeholder = text;
}

// Voice owns an insertion range, not a saved copy of the whole draft. Maps keep
// unrelated typing intact; an edit through that range invalidates the attempt.
function composerInsertion(input) {
  const api = _composerApi(input);
  if (!api) return null;
  const { from, to } = api.view.state.selection;
  const anchor = { from, to, valid: true, owner: api.owner, epoch: api.epoch };
  api.anchors.add(anchor);
  return {
    valid: () => !api.view.composing && anchor.valid && api.owner === anchor.owner && api.epoch === anchor.epoch,
    replace(text) {
      if (api.view.composing || !anchor.valid || api.owner !== anchor.owner || api.epoch !== anchor.epoch) return false;
      const tr = api.view.state.tr.insertText(text, anchor.from, anchor.to).setMeta('composerVoice', anchor);
      anchor.to = anchor.from + text.length;
      api.view.dispatch(tr.scrollIntoView());
      return true;
    },
    dispose() { anchor.valid = false; api.anchors.delete(anchor); },
  };
}
function _composerTokenKey(view, event) {
  if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey || !view.state.selection.empty) return false;
  const backward = event.key === 'Backspace' || event.key === 'ArrowLeft';
  if (!backward && event.key !== 'Delete' && event.key !== 'ArrowRight') return false;
  const { doc, selection } = view.state;
  let pos = selection.from;
  const spaceBefore = backward && pos > selection.$from.start()
    && doc.textBetween(pos - 1, pos) === ' ';
  const boundary = doc.resolve(spaceBefore ? pos - 1 : pos);
  const token = backward ? boundary.nodeBefore : boundary.nodeAfter;
  if (token?.type !== _composerSchema.nodes.token) return false;
  const from = backward ? boundary.pos - token.nodeSize : boundary.pos;
  const to = from + token.nodeSize;
  const tr = view.state.tr;
  if (event.key.startsWith('Arrow')) {
    tr.setSelection(OrkasEditor.TextSelection.create(doc, backward ? from : to));
  } else {
    const trailing = doc.textBetween(to, Math.min(doc.content.size, to + 1)) === ' ';
    const leading = from > selection.$from.start() && doc.textBetween(from - 1, from) === ' ';
    tr.delete(trailing ? from : leading ? from - 1 : from, trailing ? to + 1 : to);
  }
  event.preventDefault();
  view.dispatch(tr.scrollIntoView());
  return true;
}
function _initComposerInput(el) {
  if (_composerInputs.has(el.id)) return _composerInputs.get(el.id);
  const PM = OrkasEditor;
  const api = { editor: el, revision: 0, epoch: 0, owner: null, anchors: new Set(), stamp: {}, frame: 0, view: null };
  const normalize = new PM.Plugin({ appendTransaction(transactions, oldState, state) {
    if (api.view?.composing || !transactions.some(tr => tr.docChanged || tr.getMeta('composerRefresh'))) return null;
    // Markdown fences can affect later paragraphs. Use the existing complete
    // parser for that context; ordinary line edits only normalize changed blocks.
    const all = transactions.some(tr => tr.getMeta('composerRefresh'))
      || _composerHasCodeSyntax(oldState.doc) || _composerHasCodeSyntax(state.doc);
    const start = all ? 0 : oldState.doc.content.findDiffStart(state.doc.content);
    if (start === null) return null;
    const end = all ? state.doc.content.size : (oldState.doc.content.findDiffEnd(state.doc.content)?.b ?? start);
    const complete = all ? _composerDocument(_composerDocumentText(state.doc), el.id) : null;
    const tr = state.tr;
    if (complete && complete.childCount !== state.doc.childCount) {
      // A structured resource token can span authored line breaks. Completing
      // it joins those display paragraphs without losing its wire newlines.
      const from = _composerRawOffset(state.doc, state.selection.from);
      const to = _composerRawOffset(state.doc, state.selection.to);
      tr.replaceWith(0, state.doc.content.size, complete.content);
      tr.setSelection(PM.TextSelection.create(tr.doc, _composerPosition(tr.doc, from, -1), _composerPosition(tr.doc, to, 1)));
      return tr;
    }
    let blockIndex = 0;
    state.doc.forEach((node, pos) => {
      const expected = complete?.child(blockIndex++);
      if (pos + node.nodeSize < start || pos > end) return;
      const next = expected ? expected.content : PM.Fragment.fromArray(_composerInline(_composerBlockText(node), el.id));
      const from = node.content.findDiffStart(next);
      if (from === null) return;
      const diff = node.content.findDiffEnd(next);
      const overlap = from - Math.min(diff.a, diff.b);
      const oldEnd = diff.a + Math.max(0, overlap), newEnd = diff.b + Math.max(0, overlap);
      tr.replaceWith(tr.mapping.map(pos + 1 + from), tr.mapping.map(pos + 1 + oldEnd), next.cut(from, newEnd));
    });
    return tr.docChanged ? tr : null;
  } });
  api.plugins = [normalize, PM.history(), PM.keymap({ 'Mod-z': PM.undo, 'Mod-Shift-z': PM.redo,
    'Mod-y': PM.redo, 'Enter': PM.splitBlock, 'Shift-Enter': PM.splitBlock,
    'Mod-Enter': PM.splitBlock }), PM.keymap(PM.baseKeymap)];
  api.autoGrow = max => {
    if (max) el.style.maxHeight = `${max}px`;
    if (api.frame) return;
    api.frame = requestAnimationFrame(() => {
      api.frame = 0;
      if (!el.isConnected) return;
      // CSS intrinsic block height does the growing. No height-reset/read/write
      // cycle, including during composition. The editor scrolls its own caret.
      el.classList.toggle('is-empty', api.view.state.doc.content.size === 2);
    });
  };
  api.view = new PM.EditorView({ mount: el }, {
    state: PM.EditorState.create({ schema: _composerSchema, doc: _composerDocument('', el.id), plugins: api.plugins }),
    attributes: { class: 'chat-rich-editor', role: 'textbox', 'aria-multiline': 'true',
      'data-rich-input-id': el.id },
    dispatchTransaction(tr) {
      const previous = api.view.state;
      const result = previous.applyTransaction(tr);
      for (const transaction of result.transactions) {
        for (const anchor of api.anchors) {
          if (transaction.getMeta('composerVoice') === anchor) continue;
          transaction.mapping.maps.forEach(map => {
            map.forEach((start, end) => {
              if (start < anchor.to && end > anchor.from || start === end && start > anchor.from && start < anchor.to) anchor.valid = false;
            });
            const empty = anchor.from === anchor.to;
            anchor.from = map.map(anchor.from, 1);
            anchor.to = map.map(anchor.to, empty ? 1 : -1);
            if (anchor.from > anchor.to) anchor.valid = false;
          });
        }
      }
      api.view.updateState(result.state);
      if (!previous.doc.eq(result.state.doc)) {
        api.revision++;
        api.resetHistoryOnSet = false;
        api.stamp = {};
        api.autoGrow();
        if (!tr.getMeta('composerSilent')) composerNotify(el);
      }
    },
    handleKeyDown(view, event) {
      if (!view.editable && (['Enter', 'Backspace', 'Delete'].includes(event.key)
        || (event.metaKey || event.ctrlKey) && /^[zy]$/i.test(event.key))) {
        event.preventDefault(); return true;
      }
      if (event.isComposing || event.keyCode === 229 || view.composing) return false;
      if (el.id === 'chat-input' && event.key === 'Escape' && _isQueueItemEditing(currentCid)) {
        event.preventDefault(); void _cancelQueueItemEdit(currentCid); return true;
      }
      if (_composerTokenKey(view, event)) return true;
      if (event.key !== 'Enter') return false;
      // Own Enter once; outer legacy form handlers cannot send twice.
      event.stopImmediatePropagation();
      if (el.id === 'auto-task-input' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) {
        event.preventDefault(); PM.splitBlock(view.state, view.dispatch); return true;
      }
      event.preventDefault();
      if (el.id === 'new-chat-input') void handleNewChatSubmit();
      else if (el.id === 'project-chat-input') void _submitProjectChat();
      else void handleChatSubmit();
      return true;
    },
    handleDOMEvents: {
      compositionend() {
        // Let the view finish observing the committed native mutation first.
        setTimeout(() => { if (!api.view.isDestroyed) api.view.dispatch(api.view.state.tr.setMeta('composerRefresh', true)); }, 0);
        return false;
      },
    },
    handlePaste(view, event) {
      const clipboard = event.clipboardData;
      if (clipboard?.files?.length && _chatRichUploadPasteFiles(el.id, clipboard.files)) return true;
      const text = clipboard?.getData('text/plain');
      if (text === undefined) return false;
      const doc = _composerDocument(text.replace(/\r\n?/g, '\n'), el.id);
      view.dispatch(view.state.tr.replaceSelection(new PM.Slice(doc.content, 1, 1)).scrollIntoView());
      return true;
    },
    clipboardTextSerializer: slice => {
      const lines = [];
      slice.content.forEach(node => lines.push(node.isTextblock ? _composerBlockText(node) : node.isText ? node.text : node.attrs.raw));
      return lines.join(slice.content.firstChild?.isInline ? '' : '\n');
    },
  });
  api.setText = text => {
    const doc = _composerDocument(text, el.id);
    if (api.resetHistoryOnSet) {
      api.resetHistoryOnSet = false;
      api.view.updateState(PM.EditorState.create({ schema: _composerSchema, doc, plugins: api.plugins }));
      api.revision++; api.stamp = {}; api.autoGrow();
      return;
    }
    if (api.view.state.doc.eq(doc)) return;
    const tr = PM.closeHistory(api.view.state.tr).replaceWith(0, api.view.state.doc.content.size, doc.content)
      .setMeta('composerSilent', true);
    api.view.dispatch(tr);
    api.view.dispatch(PM.closeHistory(api.view.state.tr));
  };
  api.focus = () => api.view.focus();
  api.refresh = () => api.view.dispatch(api.view.state.tr.setMeta('composerRefresh', true).setMeta('composerSilent', true).setMeta('addToHistory', false));
  api.insertUse = selection => {
    const token = _chatUseTokenFor(selection);
    if (!token) return false;
    const { start, end } = composerSelection(el), text = composerText(el);
    const leading = start && !/\s/.test(text[start - 1]) ? ' ' : '';
    const trailing = end < text.length && /\s/.test(text[end]) ? '' : ' ';
    const nodes = _composerInline(leading + token + trailing, el.id);
    api.view.dispatch(api.view.state.tr.replaceSelection(new PM.Slice(PM.Fragment.fromArray(nodes), 0, 0)).scrollIntoView());
    return true;
  };
  _composerInputs.set(el.id, api);
  api.autoGrow(_chatRichAutoGrowMax(el.id));
  return api;
}
