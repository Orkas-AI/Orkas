// Chat bubble input-form widget.
//
// Renders an assistant-emitted `ChatFormPayload` as an interactive form
// (dropdowns / checkboxes / text inputs / etc.) inside the chat bubble.
// On submit, composes a user message (human-readable summary + machine
// tag) and hands it to `opts.onSubmit(encodedText, values)`. The caller
// wires that to `markFormSubmitted` + `streamSend`.
//
// Classic script — no import/export; globals `renderChatInputForm`,
// `encodeChatFormSubmission` are exposed to other modules.

(function () {
  // In-progress (un-submitted) field values, keyed by `${cid}::${form_id}`.
  // Hydrated back when re-rendering an unsubmitted form so switching
  // conversations and coming back doesn't wipe what the user already typed.
  // Cleared on successful submit, on reset, and whenever the form re-renders
  // as already-submitted (server-side values are authoritative then).
  const _formDrafts = new Map();
  function _draftKey(cid, formId) {
    return `${cid || ''}::${formId || ''}`;
  }

  // Build DOM for a single field. Returns { el, read, isReady, field }.
  //
  // `opts.presetValue` overrides `field.default` for the initial control
  // value — used so submitted forms re-render with the user's values
  // pre-filled. `opts.disabled` renders the control non-editable (used
  // for submitted / readonly forms — kept visually identical to the
  // editable form so the bubble layout stays stable across submission).
  function _buildField(field, ctx, opts) {
    opts = opts || {};
    const hasPreset = Object.prototype.hasOwnProperty.call(opts, 'presetValue');
    const initial = hasPreset ? opts.presetValue : field.default;
    const disabled = !!opts.disabled;

    const row = document.createElement('div');
    row.className = 'form-field';
    const label = document.createElement('label');
    label.className = 'form-field-label';
    label.textContent = field.label || field.id;
    if (field.required) {
      const star = document.createElement('span');
      star.className = 'form-field-required';
      star.textContent = ' *';
      label.appendChild(star);
    }
    row.appendChild(label);
    if (field.description) {
      const desc = document.createElement('div');
      desc.className = 'form-field-desc';
      desc.textContent = field.description;
      row.appendChild(desc);
    }

    let read;
    let isReady;
    const ctrlWrap = document.createElement('div');
    ctrlWrap.className = 'form-field-ctrl';

    if (field.type === 'text' || field.type === 'number') {
      const input = document.createElement('input');
      input.type = field.type === 'number' ? 'number' : 'text';
      input.className = 'form-field-input';
      if (field.placeholder) input.placeholder = field.placeholder;
      if (field.type === 'number') {
        if (typeof field.min === 'number') input.min = String(field.min);
        if (typeof field.max === 'number') input.max = String(field.max);
      }
      input.value = initial === undefined || initial === null ? '' : String(initial);
      if (disabled) input.disabled = true;
      input.addEventListener('input', () => {
        if (ctx && typeof ctx.onChange === 'function') ctx.onChange();
      });
      ctrlWrap.appendChild(input);
      read = () => {
        if (field.type === 'number') {
          const n = Number(input.value);
          return Number.isFinite(n) ? n : (typeof field.default === 'number' ? field.default : 0);
        }
        return input.value;
      };
    } else if (field.type === 'textarea') {
      const ta = document.createElement('textarea');
      ta.className = 'form-field-input form-field-textarea';
      if (field.placeholder) ta.placeholder = field.placeholder;
      ta.rows = 3;
      ta.value = typeof initial === 'string' ? initial : '';
      if (disabled) ta.disabled = true;
      ta.addEventListener('input', () => {
        if (ctx && typeof ctx.onChange === 'function') ctx.onChange();
      });
      ctrlWrap.appendChild(ta);
      read = () => ta.value;
    } else if (field.type === 'select') {
      // Use the shared `_aiSelectMount` widget instead of native <select>.
      // Native chrome looks dated next to the rest of the app, and the
      // settings/agent-edit pages already standardised on AiSelect.
      // The submit-time form lock (`f.el.querySelectorAll('button')` →
      // `disabled = true`) catches the trigger button, so no extra
      // disabled wiring is needed beyond the initial-state branch below.
      const sel = document.createElement('div');
      ctrlWrap.appendChild(sel);
      const aiSel = _aiSelectMount(sel, {
        placeholder: field.placeholder || undefined,
      });
      const options = (field.options || []).map((o) => ({
        value: o.value,
        label: o.label || o.value,
      }));
      aiSel.setOptions(options, {
        value: typeof initial === 'string' ? initial : '',
      });
      if (disabled) {
        const trigger = sel.querySelector('.ai-select-trigger');
        if (trigger) trigger.disabled = true;
      }
      aiSel.onChange(() => {
        if (ctx && typeof ctx.onChange === 'function') ctx.onChange();
      });
      read = () => aiSel.getValue();
    } else if (field.type === 'multiselect') {
      // Checkbox group — clearer than <select multiple>, also better on mobile.
      const wrap = document.createElement('div');
      wrap.className = 'form-field-checkgroup';
      const initialSet = new Set(Array.isArray(initial) ? initial : []);
      const checks = [];
      for (const opt of (field.options || [])) {
        const labelEl = document.createElement('label');
        labelEl.className = 'form-field-check';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.value = opt.value;
        if (initialSet.has(opt.value)) box.checked = true;
        if (disabled) box.disabled = true;
        box.addEventListener('change', () => {
          if (ctx && typeof ctx.onChange === 'function') ctx.onChange();
        });
        checks.push(box);
        labelEl.appendChild(box);
        const text = document.createElement('span');
        text.textContent = opt.label || opt.value;
        labelEl.appendChild(text);
        wrap.appendChild(labelEl);
      }
      ctrlWrap.appendChild(wrap);
      read = () => checks.filter((c) => c.checked).map((c) => c.value);
    } else if (field.type === 'boolean') {
      const labelEl = document.createElement('label');
      labelEl.className = 'form-field-check';
      const box = document.createElement('input');
      box.type = 'checkbox';
      if (initial === true) box.checked = true;
      if (disabled) box.disabled = true;
      box.addEventListener('change', () => {
        if (ctx && typeof ctx.onChange === 'function') ctx.onChange();
      });
      labelEl.appendChild(box);
      const text = document.createElement('span');
      text.textContent = ' ' + t('chat.form.boolean_on');
      labelEl.appendChild(text);
      ctrlWrap.appendChild(labelEl);
      read = () => !!box.checked;
    } else if (field.type === 'file') {
      const fileWidget = _buildFileWidget(field, ctx, { presetValue: initial, disabled });
      ctrlWrap.appendChild(fileWidget.el);
      read = fileWidget.read;
      isReady = fileWidget.isReady;
    } else if (field.type === 'directory') {
      // Card-style directory picker: a single clickable surface with a
      // folder icon + path / hint + a "Change" pill in the filled
      // state. Whole card is the affordance — Enter / Space activate
      // the native `common.pickDirectory` dialog the same as a click.
      // No "Clear" control: the field is `required` in practice (the
      // only consumer is the coding-agent `project_dir` schema), and
      // re-picking is one click vs clear-then-pick = two clicks.
      const card = document.createElement('div');
      card.className = 'form-field-dir-card';
      card.setAttribute('role', 'button');
      card.tabIndex = disabled ? -1 : 0;

      // Inline SVG folder icon — no dependency on a sprite or icon font.
      const SVG_NS = 'http://www.w3.org/2000/svg';
      const icon = document.createElementNS(SVG_NS, 'svg');
      icon.setAttribute('class', 'form-field-dir-icon');
      icon.setAttribute('viewBox', '0 0 24 24');
      icon.setAttribute('fill', 'none');
      icon.setAttribute('stroke', 'currentColor');
      icon.setAttribute('stroke-width', '1.5');
      icon.setAttribute('stroke-linejoin', 'round');
      const iconPath = document.createElementNS(SVG_NS, 'path');
      iconPath.setAttribute('d', 'M3 7.5a2 2 0 012-2h3.586a1 1 0 01.707.293l1.414 1.414a1 1 0 00.707.293H19a2 2 0 012 2V18a2 2 0 01-2 2H5a2 2 0 01-2-2V7.5z');
      icon.appendChild(iconPath);
      card.appendChild(icon);

      const pathLabel = document.createElement('span');
      pathLabel.className = 'form-field-dir-path';
      card.appendChild(pathLabel);

      const changePill = document.createElement('span');
      changePill.className = 'form-field-dir-change';
      changePill.textContent = t('input.dir.change') || 'Change';
      card.appendChild(changePill);

      let value = (typeof initial === 'string' && initial) ? initial : '';
      const renderPath = () => {
        if (value) {
          pathLabel.textContent = value;
          pathLabel.title = value;
          pathLabel.classList.remove('is-empty');
          changePill.style.display = '';
          card.classList.remove('is-empty');
        } else {
          pathLabel.textContent = t('input.dir.pick') || 'Pick directory…';
          pathLabel.removeAttribute('title');
          pathLabel.classList.add('is-empty');
          changePill.style.display = 'none';
          card.classList.add('is-empty');
        }
      };
      renderPath();
      if (disabled) card.classList.add('is-disabled');

      const pick = async () => {
        if (disabled) return;
        try {
          const res = await window.orkas.invoke('common.pickDirectory', {
            title: field.label || 'Choose a directory',
          });
          if (res && !res.cancelled && res.path) {
            value = String(res.path);
            renderPath();
            // Re-evaluate `isReady` so the submit button enables / the
            // "please wait" hint clears immediately after a pick.
            if (ctx && typeof ctx.onChange === 'function') ctx.onChange();
          }
        } catch (_) { /* user cancelled or no permission */ }
      };
      card.addEventListener('click', pick);
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          pick();
        }
      });

      ctrlWrap.appendChild(card);
      read = () => value;
      // No `isReady` override: `isReady` is reserved for "in-flight"
      // states (e.g. file upload still going) which gate the submit
      // button + show the "please wait for upload to finish" hint.
      // Required-empty for a directory is reported by `_validate` on
      // submit click, matching text / number / select.
    } else {
      // Unknown type — shouldn't happen (main validated) but degrade gracefully.
      const note = document.createElement('div');
      note.className = 'form-field-desc';
      note.textContent = t('chat.form.unknown_type', { type: String(field.type) });
      ctrlWrap.appendChild(note);
      read = () => field.default;
    }

    row.appendChild(ctrlWrap);
    return {
      el: row,
      read,
      isReady: typeof isReady === 'function' ? isReady : () => true,
      field,
    };
  }

  // Build the file-picker sub-widget. Uploads files immediately to the
  // conversation's chat_attachments dir via the existing
  // `/api/conversations/<cid>/attachments/upload` endpoint, tracks per-file
  // status, and exposes `read()` returning the canonical filename(s)
  // accepted by the server (server-side may rename for collision).
  // `ctx.cid` is required; `ctx.onChange()` notifies the parent so the
  // submit button can flip disabled state while uploads are in flight.
  // `opts.presetValue` seeds the chip list with already-uploaded names
  // (used when re-rendering a submitted form). `opts.disabled` hides the
  // picker and the per-chip × so the widget stays visually identical
  // but non-editable.
  function _buildFileWidget(field, ctx, opts) {
    opts = opts || {};
    const wrap = document.createElement('div');
    wrap.className = 'form-field-file';
    const cid = ctx && ctx.cid;
    const multiple = field.multiple === true;
    const disabled = !!opts.disabled;

    // chips area
    const chips = document.createElement('div');
    chips.className = 'form-field-file-chips';
    wrap.appendChild(chips);

    // pick button + hidden input
    const picker = document.createElement('label');
    picker.className = 'btn btn-sm form-field-file-picker';
    picker.textContent = t(multiple ? 'chat.form.file_pick_multi' : 'chat.form.file_pick');
    const input = document.createElement('input');
    input.type = 'file';
    input.style.display = 'none';
    if (multiple) input.multiple = true;
    if (field.accept) input.accept = field.accept;
    picker.appendChild(input);
    wrap.appendChild(picker);

    // entries: [{ tempId, name?, status: 'uploading'|'ready'|'failed' }]
    const entries = [];

    // Seed from preset (already-uploaded filenames recorded in form.values).
    if (opts.presetValue !== undefined && opts.presetValue !== null) {
      const names = Array.isArray(opts.presetValue)
        ? opts.presetValue.filter((x) => typeof x === 'string' && x)
        : (typeof opts.presetValue === 'string' && opts.presetValue ? [opts.presetValue] : []);
      for (const name of names) {
        entries.push({
          tempId: 'fp-preset-' + Math.random().toString(36).slice(2, 8),
          name, localName: name, status: 'ready',
        });
      }
    }

    function _renderChips() {
      chips.innerHTML = '';
      for (const ent of entries) {
        const chip = document.createElement('span');
        chip.className = 'form-field-file-chip is-' + ent.status;
        const label = document.createElement('span');
        label.className = 'form-field-file-chip-name';
        label.textContent = ent.name || ent.localName || '';
        chip.appendChild(label);
        if (ent.status === 'uploading') {
          const tag = document.createElement('span');
          tag.className = 'form-field-file-chip-tag';
          tag.textContent = t('chat.form.file_uploading');
          chip.appendChild(tag);
        } else if (ent.status === 'failed') {
          const tag = document.createElement('span');
          tag.className = 'form-field-file-chip-tag';
          tag.textContent = t('chat.form.file_failed');
          chip.appendChild(tag);
        }
        if (!disabled) {
          const x = document.createElement('button');
          x.type = 'button';
          x.className = 'form-field-file-chip-x';
          x.textContent = '×';
          x.addEventListener('click', () => {
            const i = entries.indexOf(ent);
            if (i >= 0) entries.splice(i, 1);
            _renderChips();
            if (ctx && typeof ctx.onChange === 'function') ctx.onChange();
          });
          chip.appendChild(x);
        }
        chips.appendChild(chip);
      }
      // disabled (submitted): never show the picker.
      // single-file mode: hide picker once we have a ready/uploading file.
      picker.style.display = disabled
        ? 'none'
        : ((!multiple && entries.length > 0) ? 'none' : '');
    }

    async function _uploadFile(ent, file) {
      try {
        const buf = await file.arrayBuffer();
        const res = await apiFetch(`/api/conversations/${encodeURIComponent(cid)}/attachments/upload`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-Filename': encodeURIComponent(file.name),
          },
          body: buf,
        });
        const data = await res.json();
        if (!data.ok || !data.info || !data.info.name) {
          ent.status = 'failed';
        } else {
          ent.name = data.info.name;
          ent.status = 'ready';
        }
      } catch (_err) {
        ent.status = 'failed';
      }
      _renderChips();
      if (ctx && typeof ctx.onChange === 'function') ctx.onChange();
    }

    input.addEventListener('change', () => {
      const picked = Array.from(input.files || []);
      if (!picked.length) return;
      // single-file mode: replace any prior selection
      if (!multiple) entries.length = 0;
      for (const file of picked) {
        const ent = {
          tempId: 'fp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
          localName: file.name,
          status: 'uploading',
        };
        entries.push(ent);
        _uploadFile(ent, file);
      }
      // reset input so re-picking the same file fires `change` again
      input.value = '';
      _renderChips();
      if (ctx && typeof ctx.onChange === 'function') ctx.onChange();
    });

    // Initial paint — covers the case where presetValue seeded entries.
    _renderChips();

    return {
      el: wrap,
      read: () => {
        const ready = entries.filter((e) => e.status === 'ready').map((e) => e.name);
        return multiple ? ready : (ready[0] || '');
      },
      isReady: () => entries.every((e) => e.status !== 'uploading'),
    };
  }

  function _validate(field, value) {
    if (field.required) {
      if (field.type === 'text' || field.type === 'textarea') {
        if (!String(value || '').trim()) return t('chat.form.required_text');
      } else if (field.type === 'multiselect') {
        if (!Array.isArray(value) || value.length === 0) return t('chat.form.required_multiselect');
      } else if (field.type === 'select') {
        if (!value) return t('chat.form.required_select');
      } else if (field.type === 'file') {
        const empty = field.multiple
          ? !Array.isArray(value) || value.length === 0
          : !value;
        if (empty) return t('chat.form.required_file');
      } else if (field.type === 'directory') {
        if (!String(value || '').trim()) return t('chat.form.required_directory');
      }
    }
    if (field.type === 'number' && typeof value === 'number') {
      if (typeof field.min === 'number' && value < field.min) return t('chat.form.num_min', { min: field.min });
      if (typeof field.max === 'number' && value > field.max) return t('chat.form.num_max', { max: field.max });
    }
    return null;
  }

  function _formatSummaryLine(field, value) {
    const fallback = t('chat.form.empty_value');
    if (value === undefined || value === null) return fallback;
    if (field.type === 'boolean') return value === true ? 'yes' : 'no';
    if (field.type === 'select') {
      const opt = (field.options || []).find((o) => o.value === value);
      return opt ? (opt.label || opt.value) : String(value);
    }
    if (field.type === 'multiselect') {
      const arr = Array.isArray(value) ? value : [];
      if (!arr.length) return fallback;
      const opts = field.options || [];
      return arr.map((v) => {
        const m = opts.find((o) => o.value === v);
        return m ? (m.label || m.value) : String(v);
      }).join('、');
    }
    if (field.type === 'file') {
      if (Array.isArray(value)) {
        const names = value.filter((x) => typeof x === 'string' && x);
        return names.length ? names.join('、') : fallback;
      }
      const s = typeof value === 'string' ? value : '';
      return s ? s : fallback;
    }
    if (field.type === 'number') return String(value);
    const s = String(value);
    return s.trim() ? s : fallback;
  }

  // Build the human-readable bullet list + <agent-input-submission> tag the
  // user message will carry. Kept in sync with main's `encodeSubmission`.
  // The tag is hidden from display at render time (see conversation.js
  // `_stripSubmissionTagForDisplay`); only the bullet list is user-visible.
  function encodeChatFormSubmission(form, values) {
    const lines = form.fields.map((f) => {
      const v = Object.prototype.hasOwnProperty.call(values, f.id) ? values[f.id] : f.default;
      return `- ${f.label || f.id}：${_formatSummaryLine(f, v)}`;
    });
    const tag = `<agent-input-submission form_id="${form.form_id}" agent_id="${form.agent_id}">\n${JSON.stringify(values)}\n</agent-input-submission>`;
    return `${lines.join('\n')}\n\n${tag}`;
  }

  // container: the element we append the form widget into.
  // message:   the full MessageRecord (must have `form` set).
  // opts:
  //   readonly?: boolean
  //   cid?: string                                 — required for file fields (upload target)
  //   onSubmit(encodedText, values, attachments)   — attachments = uploaded filenames
  //
  // Submitted/readonly forms render *the same* widget — same fields, same
  // controls, same layout — just with every input disabled and the
  // submit/reset buttons replaced by a "submitted · time" stamp. This way the
  // bubble looks identical before and after submit, and the user always
  // sees the structured form (not a degraded text summary) on refresh.
  function renderChatInputForm(container, message, opts = {}) {
    if (!message || !message.form || !Array.isArray(message.form.fields)) return;
    const form = message.form;
    const submitted = !!(opts.readonly || form.submitted);

    // Draft hydration: an unsubmitted form re-rendered after a tab switch
    // pulls the user's in-progress values out of `_formDrafts` so they
    // don't lose their typing. A submitted form drops any stale draft —
    // server-side `form.values` is authoritative now.
    const draftKey = _draftKey(opts.cid, form.form_id);
    const draftValues = !submitted ? _formDrafts.get(draftKey) : null;
    if (submitted) _formDrafts.delete(draftKey);

    container.classList.add('chat-input-form');
    if (submitted) container.classList.add('is-submitted');
    const title = document.createElement('div');
    title.className = 'form-title';
    title.textContent = t(submitted ? 'chat.form.readonly_title' : 'chat.form.title');
    container.appendChild(title);

    const bodyEl = document.createElement('div');
    bodyEl.className = 'form-body';
    const fields = [];
    const fieldCtx = {
      cid: opts.cid,
      onChange: () => {
        _refreshSubmitState();
        if (submitted) return;
        const snap = {};
        for (const f of fields) {
          try { snap[f.field.id] = f.read(); } catch (_) { /* skip */ }
        }
        _formDrafts.set(draftKey, snap);
      },
    };
    for (const f of form.fields) {
      // Only attach `presetValue` when we actually have one — `_buildField`
      // checks `hasOwnProperty('presetValue')` to distinguish "user explicitly
      // cleared this field" (preset = '' / 0 / false / []) from "no preset,
      // fall back to field.default". Passing the key with value `undefined`
      // would defeat that and hide the schema-defined defaults.
      const buildOpts = { disabled: submitted };
      if (submitted && form.values
          && Object.prototype.hasOwnProperty.call(form.values, f.id)) {
        buildOpts.presetValue = form.values[f.id];
      } else if (!submitted && draftValues
          && Object.prototype.hasOwnProperty.call(draftValues, f.id)) {
        buildOpts.presetValue = draftValues[f.id];
      }
      const built = _buildField(f, fieldCtx, buildOpts);
      fields.push(built);
      bodyEl.appendChild(built.el);
    }
    container.appendChild(bodyEl);

    // Submitted forms get a "submitted · time" stamp instead of action buttons.
    if (submitted) {
      const stamp = document.createElement('div');
      stamp.className = 'form-submitted-stamp';
      const at = form.submitted_at ? new Date(form.submitted_at).toLocaleString() : '';
      stamp.textContent = at
        ? t('chat.form.submitted_at', { time: at })
        : t('chat.form.submitted_no_time');
      container.appendChild(stamp);
      return;
    }

    const errEl = document.createElement('div');
    errEl.className = 'form-error';
    container.appendChild(errEl);

    const actions = document.createElement('div');
    actions.className = 'form-actions';
    const submitBtn = document.createElement('button');
    submitBtn.type = 'button';
    submitBtn.className = 'btn btn-sm btn-primary';
    submitBtn.textContent = t('chat.form.submit');
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'btn btn-sm';
    resetBtn.textContent = t('chat.form.reset');
    actions.appendChild(resetBtn);
    actions.appendChild(submitBtn);
    container.appendChild(actions);

    function _refreshSubmitState() {
      const allReady = fields.every((f) => f.isReady());
      if (!submitBtn.dataset.locked) {
        submitBtn.disabled = !allReady;
        submitBtn.title = allReady ? '' : t('chat.form.file_uploading_wait');
      }
    }
    _refreshSubmitState();

    resetBtn.addEventListener('click', () => {
      // Clear the draft so re-render falls back to schema defaults rather
      // than re-hydrating the in-progress values we just wiped from the DOM.
      _formDrafts.delete(draftKey);
      container.innerHTML = '';
      renderChatInputForm(container, message, opts);
    });

    submitBtn.addEventListener('click', () => {
      errEl.textContent = '';
      // Block while any file field is still uploading.
      if (fields.some((f) => !f.isReady())) {
        errEl.textContent = t('chat.form.file_uploading_wait');
        return;
      }
      const values = {};
      const errors = [];
      const attachmentNames = [];
      for (const f of fields) {
        const v = f.read();
        values[f.field.id] = v;
        if (f.field.type === 'file') {
          if (Array.isArray(v)) attachmentNames.push(...v.filter((x) => typeof x === 'string' && x));
          else if (typeof v === 'string' && v) attachmentNames.push(v);
        }
        const err = _validate(f.field, v);
        if (err) errors.push({ id: f.field.id, label: f.field.label, msg: err });
      }
      if (errors.length) {
        errEl.textContent = errors
          .map((e) => t('chat.form.errors_prefix', { label: e.label || e.id, msg: e.msg }))
          .join(' · ');
        return;
      }
      // Lock the form immediately so the user can't double-click.
      submitBtn.dataset.locked = '1';
      submitBtn.disabled = true;
      resetBtn.disabled = true;
      fields.forEach((f) => {
        const inputs = f.el.querySelectorAll('input, textarea, select, button');
        inputs.forEach((el) => { el.disabled = true; });
      });
      const encoded = encodeChatFormSubmission(form, values);
      // De-dupe attachment names (a file dropped into both the form and the
      // composer would otherwise appear twice on the user message).
      const dedupAttachments = Array.from(new Set(attachmentNames));
      try {
        opts.onSubmit && opts.onSubmit(encoded, values, dedupAttachments);
        // Submission left our hands; once the bubble re-renders as
        // submitted the draft is moot anyway, but drop it now so a fast
        // tab switch before the re-render arrives doesn't re-hydrate the
        // already-sent values into a stale form.
        _formDrafts.delete(draftKey);
      } catch (err) {
        delete submitBtn.dataset.locked;
        submitBtn.disabled = false;
        resetBtn.disabled = false;
        fields.forEach((f) => {
          const inputs = f.el.querySelectorAll('input, textarea, select, button');
          inputs.forEach((el) => { el.disabled = false; });
        });
        errEl.textContent = (err && err.message) ? err.message : t('chat.form.submit_failed');
      }
    });
  }

  // Expose via classic-script globals (no ES module here).
  window.renderChatInputForm = renderChatInputForm;
  window.encodeChatFormSubmission = encodeChatFormSubmission;
})();
