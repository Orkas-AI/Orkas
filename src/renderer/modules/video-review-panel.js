// Host-owned VideoStudio review panel (P2).
//
// Renders what the production state proves — where the production got to,
// the rendered frames, narration audio, and the scene list — in a right-side
// drawer, so reviewing a production stops depending on the model describing
// its own artifacts.
// Read-only by design: every modification entry only PREFILLS the composer
// with a scoped instruction; the user reviews and sends it through the
// normal conversation path. No agent id is hard-coded and nothing here
// mutates production state.
//
// Layout follows one reading order: what was asked for -> how far it got ->
// the evidence. Older productions in the same conversation collapse to one
// row each, so a conversation with several videos still opens on the one
// that changed last.
//
// Data: `window.orkas.invoke('videoStudio.reviewPanel', { cid })`.
// Media: `chat-media://local/<abs>` (same URL rules as chat-file-viewer).

// ── Pure view model ────────────────────────────────────────────────────
// How production state reads as a review surface, with no DOM, i18n, or IPC
// so it can be tested directly (test/renderer/video-review-panel.test.ts).
(function (global) {
  // Path segments that name the production scaffold rather than the video.
  const GENERIC_PATH_SEGMENTS = new Set(['composition', 'compositions', 'project', 'render']);

  /** The four production steps and the state each one is in.
   *
   * A step is either a decision the user makes or evidence the host produced,
   * and only decisions may read as "waiting on you". The keyframe preview is a
   * decision: the run stops on the complete frame set before assembly, so
   * frames present with no draft yet is genuinely waiting on the user. The
   * go-ahead is a chat reply with nothing for this panel to read, so passage
   * is evidenced by what only starts after it — any draft. On an assembled
   * production the aggregate preview appears with the FIRST captured segment,
   * so waiting additionally requires every composition segment to hold frames;
   * before that the frames on screen are progress, not a question. The final
   * cut is a decision only on a standalone composition, where
   * `composition.approve_draft` records it; an assembled production's
   * confirmation happens in chat too, so its assembled file is evidence.
   *
   * Only one step may ask the user for something, so any later step that has
   * not happened yet reads as "not started" instead of competing for
   * attention. Steps that DID complete keep saying so: narration is
   * materialized before the visuals are captured, and calling a finished
   * narration "not started" would contradict the player rendered below it. */
  function compositionSteps(comp) {
    const production = comp || {};
    const assembled = Array.isArray(production.segments) && production.segments.length > 0;
    const compositionSegments = assembled
      ? production.segments.filter((segment) => segment && segment.kind === 'composition')
      : [];
    // Candidate-tier evidence (status 'candidate' / 'qa_blocked') is work the
    // host recorded from an op whose QA did not pass. The drawer displays it,
    // but no progress reading may count it: frames that never passed capture
    // are not the preview stop, and a blocked render is not a draft.
    const passingPreview = (preview) => !!preview
      && (preview.status === 'ready' || preview.status === 'approved');
    const passingDraft = (draft) => !!draft
      && (draft.status === 'ready' || draft.status === 'approved');
    const framesComplete = assembled
      ? compositionSegments.length > 0
        && compositionSegments.every((segment) => passingPreview(segment.preview))
      : passingPreview(production.preview);
    const previewPassed = passingDraft(production.draft)
      || !!production.final
      || !!(production.preview && production.preview.status === 'approved');
    const raw = [
      { id: 'plan', kind: 'decision', state: production.plan_approved ? 'done' : 'wait' },
      {
        id: 'preview',
        kind: 'decision',
        state: previewPassed ? 'done' : framesComplete ? 'wait' : 'todo',
      },
      {
        id: 'narration',
        kind: 'evidence',
        // `partial` is an assembly that produced some of its planned lines and
        // stopped — real audio, unfinished step. It renders as its own state
        // with the counts, because showing "not started" over produced work
        // is the original defect this panel had, and this surface re-created
        // it once already by mapping partial onto todo (2026-08-08).
        state: !production.narration ? 'todo'
          : production.narration.status !== 'partial' ? 'done'
            : typeof production.narration.produced_lines === 'number'
              && typeof production.narration.planned_lines === 'number'
              ? 'partial'
              : 'todo',
        ...(production.narration && production.narration.status === 'partial'
          && typeof production.narration.produced_lines === 'number'
          && typeof production.narration.planned_lines === 'number'
          ? { detail: { n: production.narration.produced_lines, m: production.narration.planned_lines } }
          : {}),
      },
      {
        id: 'draft',
        kind: assembled ? 'evidence' : 'decision',
        state: !passingDraft(production.draft) ? 'todo'
          : (assembled || production.draft.status === 'approved') ? 'done' : 'wait',
      },
    ];
    let waiting = false;
    return raw.map((step) => {
      if (step.state !== 'wait') return step;
      if (waiting) return { id: step.id, kind: step.kind, state: 'todo' };
      waiting = true;
      return step;
    });
  }

  /** The one status a collapsed production shows: what it needs from the
   * user, or — when it needs nothing — how far it got. */
  function compositionPill(steps) {
    const wait = steps.find((step) => step.state === 'wait');
    if (wait) return { tone: 'wait', step: wait.id, kind: wait.kind, state: 'wait' };
    const done = steps.filter((step) => step.state === 'done');
    const last = done[done.length - 1];
    return last ? { tone: 'ok', step: last.id, kind: last.kind, state: 'done' } : null;
  }

  function pendingCount(compositions) {
    return (compositions || []).filter(
      (comp) => compositionSteps(comp).some((step) => step.state === 'wait'),
    ).length;
  }

  function compositionKey(comp) {
    return String((comp && (comp.state_key || comp.composition_dir || comp.display_name)) || '');
  }

  /** Whether an async panel response still belongs to the conversation that
   * requested it. Conversation navigation can overtake IPC, so accepting a
   * late response by arrival order would put the previous conversation's
   * productions into the current drawer. */
  function acceptsPanelResponse(activeCid, requestedCid) {
    return !!requestedCid && String(activeCid || '') === String(requestedCid);
  }

  /** The production's own name for the work. Older productions recorded no
   * title, so fall back to the video directory rather than showing the user
   * a composition path they cannot read. */
  function compositionTitle(comp) {
    const title = String((comp && comp.task_title) || '').trim();
    if (title) return title;
    const displayName = String((comp && comp.display_name) || '');
    const parts = displayName.split('/').filter(Boolean);
    while (parts.length && GENERIC_PATH_SEGMENTS.has(parts[parts.length - 1])) parts.pop();
    return parts[parts.length - 1] || displayName;
  }

  /** How an instruction names a production.
   *
   * The panel titles a production with what the user asked for; quoting a
   * workspace path instead left the composer holding
   * `videos/x/project/compositions/s2_definition`, which the user cannot check
   * against anything they can see. The title is that check. Two productions
   * can share a title, though, and an instruction naming both is worse than a
   * long one — those get the path appended to stay unambiguous. */
  function productionRef(comp, all) {
    const title = compositionTitle(comp);
    const displayName = String((comp && comp.display_name) || '');
    if (!title) return displayName;
    const key = compositionKey(comp);
    const ambiguous = (all || []).some((other) => other
      && compositionKey(other) !== key
      && compositionTitle(other) === title);
    return ambiguous && displayName ? `${title} (${displayName})` : title;
  }

  /** End offset of the first line already carrying `instruction`, else -1.
   *  Prefix match, so a line the user has since completed still counts. */
  function instructionLineEnd(text, instruction) {
    if (!instruction) return -1;
    let offset = 0;
    for (const line of text.split('\n')) {
      if (line.startsWith(instruction)) return offset + line.length;
      offset += line.length + 1;
    }
    return -1;
  }

  /** Where a panel instruction lands in the composer, and where the caret goes.
   *
   * Edit entries prefill the composer instead of submitting, so a user
   * reviewing several scenes clicks several entries before sending one
   * message. Overwriting on each click discarded the earlier entries along
   * with whatever the user had typed after them, which made the panel usable
   * for exactly one change per message. Clicks now accumulate.
   *
   * `full` names the production and `short` omits it: a run of edits to one
   * video reads as a list instead of repeating the same identifier on every
   * line. The short form is only safe while the message is still talking
   * about that production, so it is used only when no OTHER production the
   * panel is showing has been named more recently — otherwise an unqualified
   * "scene s5" would attach to the wrong video. Clicking one entry twice
   * moves the caret to the line it already wrote instead of duplicating it.
   */
  function mergeComposerInstruction(input) {
    const current = String((input && input.current) || '');
    const full = String((input && input.full) || '').trim();
    const short = String((input && input.short) || '').trim();
    const production = String((input && input.production) || '').trim();
    const others = Array.isArray(input && input.otherProductions) ? input.otherProductions : [];
    if (!full) return { value: current, selectionStart: current.length };
    const base = current.replace(/\s+$/, '');
    if (!base) return { value: full, selectionStart: full.length };
    for (const existing of [full, short]) {
      const end = instructionLineEnd(base, existing);
      if (end >= 0) return { value: current, selectionStart: end };
    }
    const namedAt = production ? base.lastIndexOf(production) : -1;
    const anotherNamedLater = namedAt >= 0 && others.some((other) => {
      const name = String(other || '').trim();
      return !!name && name !== production && base.lastIndexOf(name) > namedAt;
    });
    const line = short && namedAt >= 0 && !anotherNamedLater ? short : full;
    const value = `${base}\n${line}`;
    return { value, selectionStart: value.length };
  }

  global.VideoReviewViewModel = {
    compositionSteps,
    compositionPill,
    pendingCount,
    compositionKey,
    acceptsPanelResponse,
    compositionTitle,
    productionRef,
    mergeComposerInstruction,
  };

  // Test bridge: pure functions only, no DOM/i18n/IPC (see PC/CLAUDE.md).
  if (typeof module !== 'undefined' && typeof module.exports === 'object') {
    module.exports = global.VideoReviewViewModel;
  }
}(typeof window !== 'undefined' ? window : globalThis));

(function (global) {
  // Guarded like chat-file-viewer's logger so requiring this file for the
  // view-model bridge never depends on the renderer's script order.
  const _log = typeof createLogger === 'function'
    ? createLogger('video-review-panel')
    : { debug() {}, info() {}, warn() {}, error() {} };
  let _cid = '';
  let _panelData = null;
  // Explicit user toggles only, so a refresh keeps whatever the user opened
  // or closed by hand while everything else follows the fresh payload.
  const _compToggles = new Map();
  const _sectionToggles = new Map();

  const SECTIONS = { final: 'final', narration: 'narration', scenes: 'scenes' };
  const SECTION_DEFAULT_OPEN = { final: true, narration: true, scenes: true };
  const {
    compositionSteps: _compositionSteps,
    compositionPill: _compositionPill,
    pendingCount: _pendingCount,
    compositionKey: _compositionKey,
    acceptsPanelResponse: _acceptsPanelResponse,
    compositionTitle: _compositionTitle,
    productionRef: _productionRef,
    mergeComposerInstruction: _mergeComposerInstruction,
  } = global.VideoReviewViewModel;

  function _el(id) { return document.getElementById(id); }

  // Mirrors chat-file-viewer's URL builder: strip the single leading slash on
  // Unix (URL pathname re-adds it), forward-slash Windows drive paths.
  function _mediaUrl(absPath) {
    let p = String(absPath || '');
    if (!p) return '';
    if (p.includes('\\')) p = p.replace(/\\/g, '/');
    if (p.startsWith('/')) p = p.slice(1);
    return `chat-media://local/${encodeURI(p)}`;
  }

  function _productionName(comp) {
    return _productionRef(comp, (_panelData && _panelData.compositions) || []);
  }

  /** The other productions this panel is showing, so a merged message never
   *  drops the identifier while another video is the one last named. */
  function _otherProductionNames(production) {
    const compositions = (_panelData && _panelData.compositions) || [];
    return compositions
      .map((comp) => _productionRef(comp, compositions))
      .filter((name) => name && name !== production);
  }

  function _prefillComposer(spec) {
    const input = _el('chat-input');
    if (!input) return;
    const merged = _mergeComposerInstruction({
      current: input.value,
      full: spec.full,
      short: spec.short,
      production: spec.production,
      otherProductions: _otherProductionNames(spec.production),
    });
    input.value = merged.value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
    // After focus, so the caret lands on the line this click owns rather than
    // wherever the composer last left it.
    if (typeof input.setSelectionRange === 'function') {
      input.setSelectionRange(merged.selectionStart, merged.selectionStart);
    }
  }

  function _isCompOpen(comp) {
    return !!_compToggles.get(_compositionKey(comp));
  }

  function _isSectionOpen(comp, section) {
    const key = `${_compositionKey(comp)}::${section}`;
    if (_sectionToggles.has(key)) return !!_sectionToggles.get(key);
    return !!SECTION_DEFAULT_OPEN[section];
  }

  // ── Formatting ───────────────────────────────────────────────────────

  function _oneDecimal(value) {
    return Number(value).toFixed(1);
  }

  function _relativeTime(value, unit) {
    try {
      return new Intl.RelativeTimeFormat(getLang(), { numeric: 'auto' }).format(value, unit);
    } catch (_) {
      return `${Math.abs(value)} ${unit}`;
    }
  }

  function _formatUpdated(ms) {
    const at = Number(ms);
    if (!Number.isFinite(at) || at <= 0) return '';
    const diffMs = Date.now() - at;
    if (diffMs < 60_000) return t('common.just_now');
    if (diffMs < 3_600_000) return _relativeTime(-Math.floor(diffMs / 60_000), 'minute');
    if (diffMs < 86_400_000) return _relativeTime(-Math.floor(diffMs / 3_600_000), 'hour');
    const days = Math.floor(diffMs / 86_400_000);
    if (days < 7) return _relativeTime(-Math.max(1, days), 'day');
    const date = new Date(at);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function _stepLabel(step) { return t(`video_review.step_${step}`); }

  function _stateLabel(step) {
    if (step.state === 'wait') return t('video_review.state_pending');
    if (step.state === 'todo') return t('video_review.state_todo');
    if (step.state === 'partial') return t('video_review.state_partial', step.detail);
    // "Confirmed" is reserved for decisions the user actually made; evidence
    // the host produced reads as generated, because nobody was asked.
    return t(step.kind === 'evidence' ? 'video_review.state_generated' : 'video_review.state_confirmed');
  }

  // ── DOM building ─────────────────────────────────────────────────────

  function _node(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function _chevron() {
    const span = _node('span', 'video-review-chevron');
    span.innerHTML = uiIconHtml('chevron-right', 'ui-icon video-review-chevron-icon');
    return span;
  }

  function _actionButton(label, spec) {
    const btn = _node('button', 'btn btn-sm video-review-action', label);
    btn.type = 'button';
    btn.addEventListener('click', () => _prefillComposer(spec));
    return btn;
  }

  function _metaRow(parts) {
    const row = _node('div', 'video-review-comp-meta');
    parts.filter(Boolean).forEach((part, index) => {
      if (index) row.appendChild(_node('i', 'video-review-meta-sep', '·'));
      row.appendChild(_node('span', null, part));
    });
    return row;
  }

  function _renderRail(comp) {
    const rail = _node('div', 'video-review-rail');
    for (const step of _compositionSteps(comp)) {
      const card = _node('div', `video-review-step is-${step.state}`);
      const key = _node('div', 'video-review-step-name');
      key.appendChild(_node('span', 'video-review-step-dot'));
      key.appendChild(_node('span', null, _stepLabel(step.id)));
      card.appendChild(key);
      card.appendChild(_node('div', 'video-review-step-state', _stateLabel(step)));
      rail.appendChild(card);
    }
    return rail;
  }

  /** A block that opens and closes in place. `build` runs on first open, so a
   * collapsed contact sheet costs no image load, and toggling never rebuilds
   * the panel — narration playing in another block keeps playing. */
  function _collapsible(spec) {
    const box = _node(spec.tag, spec.boxClass);
    let body = null;
    const apply = (open) => {
      box.classList.toggle('is-open', open);
      spec.head.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open && !body) {
        body = _node('div', spec.bodyClass);
        spec.build(body);
        box.appendChild(body);
      }
      if (body) body.hidden = !open;
    };
    spec.head.addEventListener('click', () => {
      const next = !spec.isOpen();
      spec.setOpen(next);
      apply(next);
    });
    box.appendChild(spec.head);
    apply(spec.isOpen());
    return box;
  }

  function _renderSection(comp, id, title, subtitle, build) {
    const head = _node('button', 'video-review-section-head');
    head.type = 'button';
    head.appendChild(_chevron());
    head.appendChild(_node('span', 'video-review-section-title', title));
    if (subtitle) head.appendChild(_node('span', 'video-review-section-sub', subtitle));
    return _collapsible({
      tag: 'div',
      boxClass: 'video-review-section',
      bodyClass: 'video-review-section-body',
      head,
      isOpen: () => _isSectionOpen(comp, id),
      setOpen: (open) => _sectionToggles.set(`${_compositionKey(comp)}::${id}`, open),
      build,
    });
  }

  /** Expand a panel media element into the shared file viewer (images
   * delegate to the chat lightbox, videos get the full player). The panel's
   * inline elements stay small previews; the click is the way to look. */
  function _expandMedia(absPath) {
    if (!absPath || typeof openChatFileViewer !== 'function') return;
    openChatFileViewer(absPath, undefined, { cid: _cid, autoplay: true });
  }

  function _clickableMedia(el, absPath, label) {
    el.classList.add('is-expandable');
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    if (label) el.setAttribute('aria-label', label);
    el.addEventListener('click', () => _expandMedia(absPath));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _expandMedia(absPath); }
    });
    return el;
  }

  function _renderNarrationSection(comp) {
    const narration = comp.narration;
    const subtitle = [
      narration.status === 'partial'
        && typeof narration.produced_lines === 'number'
        && typeof narration.planned_lines === 'number'
        ? t('video_review.state_partial', { n: narration.produced_lines, m: narration.planned_lines })
        : '',
      narration.language || '',
      typeof narration.speed === 'number'
        ? t('video_review.narration_speed', { speed: _oneDecimal(narration.speed) })
        : '',
    ].filter(Boolean).join(' · ');
    return _renderSection(comp, SECTIONS.narration, t('video_review.narration_title'), subtitle, (body) => {
      const row = _node('div', 'video-review-narration');
      // An assembled production narrates per segment, so it reports the
      // combined language, speed and duration but has no single track to
      // play. The entry to redo it still belongs here.
      if (narration.audio_path) {
        const audio = document.createElement('audio');
        audio.controls = true;
        audio.preload = 'none';
        audio.src = _mediaUrl(narration.audio_path);
        row.appendChild(audio);
      } else {
        row.appendChild(_node('div', 'video-review-narration-note', t('video_review.narration_per_segment')));
      }
      if (typeof narration.duration_sec === 'number') {
        row.appendChild(_node(
          'div',
          'video-review-narration-meta',
          t('video_review.narration_duration', { s: _oneDecimal(narration.duration_sec) }),
        ));
      }
      row.appendChild(_actionButton(t('video_review.action_redo_narration'), {
        full: t('video_review.instr_redo_narration', { name: _productionName(comp) }),
        short: t('video_review.instr_redo_narration_short'),
        production: _productionName(comp),
      }));
      body.appendChild(row);
    });
  }

  function _renderSceneRow(comp, scene, position) {
    const row = _node('div', 'video-review-scene');
    // Inline elements are small previews; clicking expands into the shared
    // viewer (lightbox for stills, full player for clips). Metadata-only
    // preload keeps a timeline of clips from fetching every file on open.
    if (scene.media_path) {
      const clip = _node('video', 'video-review-scene-frame');
      clip.src = _mediaUrl(scene.media_path);
      clip.preload = 'metadata';
      clip.muted = true;
      clip.playsInline = true;
      row.appendChild(_clickableMedia(clip, scene.media_path, t('video_review.scene_ordinal', { n: position })));
    } else if (scene.frame_path) {
      const thumb = _node('img', 'video-review-scene-frame');
      thumb.src = _mediaUrl(scene.frame_path);
      thumb.alt = '';
      thumb.loading = 'lazy';
      row.appendChild(_clickableMedia(thumb, scene.frame_path, t('video_review.scene_ordinal', { n: position })));
    } else {
      row.appendChild(_node('div', 'video-review-scene-frame is-empty', t('video_review.scene_no_frame')));
    }
    const body = _node('div', 'video-review-scene-body');
    // Scenes are labelled by their position in the video. `scene.id` is an
    // authoring handle (`s2_body`, `src_clip`) that means nothing to the
    // person watching — it stays in the prefilled instruction, where it
    // binds the edit to the right scene even if positions shift, but it is
    // not what the drawer calls a scene.
    body.appendChild(_node('span', 'video-review-scene-id', t('video_review.scene_ordinal', { n: position })));
    if (scene.approved_copy && scene.approved_copy.length) {
      body.appendChild(_node('div', 'video-review-scene-copy', scene.approved_copy.join(' / ')));
    }
    if (scene.narration_text) {
      body.appendChild(_node('div', 'video-review-scene-narration', scene.narration_text));
    }
    const actions = _node('div', 'video-review-scene-actions');
    actions.appendChild(_actionButton(t('video_review.action_edit_visual'), {
      full: t('video_review.instr_edit_visual', { n: position, id: scene.id, name: _productionName(comp) }),
      short: t('video_review.instr_edit_visual_short', { n: position, id: scene.id }),
      production: _productionName(comp),
    }));
    // A cut carries no authored copy, so offering to change it would prefill an
    // instruction with nothing to act on.
    if (!scene.media_path) {
      actions.appendChild(_actionButton(t('video_review.action_edit_copy'), {
        full: t('video_review.instr_edit_copy', { n: position, id: scene.id, name: _productionName(comp) }),
        short: t('video_review.instr_edit_copy_short', { n: position, id: scene.id }),
        production: _productionName(comp),
      }));
    }
    body.appendChild(actions);
    row.appendChild(body);
    return row;
  }

  function _renderScenesSection(comp) {
    const subtitle = t('video_review.scenes_subtitle', { n: comp.scenes.length });
    return _renderSection(comp, SECTIONS.scenes, t('video_review.scenes_title'), subtitle, (body) => {
      const list = _node('div', 'video-review-scenes');
      comp.scenes.forEach((scene, index) => {
        list.appendChild(_renderSceneRow(comp, scene, index + 1));
      });
      body.appendChild(list);
    });
  }

  /** Meta + progress + evidence. Identical whether the production is the
   * open one or an expanded older row, so comparing two is comparing the
   * same thing. */
  function _renderCompositionBody(host, comp, withTitle) {
    const head = _node('div', 'video-review-comp-head');
    if (withTitle) head.appendChild(_node('div', 'video-review-comp-name', _compositionTitle(comp)));
    head.appendChild(_metaRow([
      comp.scenes.length ? t('video_review.meta_scenes', { n: comp.scenes.length }) : '',
      comp.narration && typeof comp.narration.duration_sec === 'number'
        ? t('video_review.narration_duration', { s: _oneDecimal(comp.narration.duration_sec) })
        : '',
      _formatUpdated(comp.updated_at_ms)
        ? t('video_review.meta_updated', { time: _formatUpdated(comp.updated_at_ms) })
        : '',
    ]));
    head.appendChild(_renderRail(comp));
    host.appendChild(head);

    const reviewVideoPath = (comp.final && comp.final.path) || (comp.draft && comp.draft.path);
    if (reviewVideoPath) host.appendChild(_renderFinalSection(comp, reviewVideoPath));
    if (comp.narration) host.appendChild(_renderNarrationSection(comp));
    if (comp.scenes.length) host.appendChild(_renderScenesSection(comp));
  }

  /** The delivered video, as a click-to-expand preview. Only an assembled
   * production carries this record — a standalone composition's final
   * travels through its draft entry. */
  function _renderFinalSection(comp, videoPath) {
    return _renderSection(comp, SECTIONS.final, t('video_review.final_title'), '', (body) => {
      const clip = _node('video', 'video-review-final-video');
      clip.src = _mediaUrl(videoPath);
      clip.preload = 'metadata';
      clip.muted = true;
      clip.playsInline = true;
      body.appendChild(_clickableMedia(clip, videoPath, t('video_review.final_title')));
    });
  }

  function _renderPill(steps) {
    const pill = _compositionPill(steps);
    if (!pill) return null;
    return _node('span', `video-review-pill is-${pill.tone}`, t('video_review.pill', {
      step: _stepLabel(pill.step),
      state: _stateLabel({ id: pill.step, kind: pill.kind, state: pill.state }),
    }));
  }

  /** Productions arrive newest-first. The newest one reads as the page; the
   * rest read as rows that open in place, so several can be compared without
   * losing the one that just changed. */
  function _renderComposition(host, comp, index) {
    if (index === 0) {
      const page = _node('section', 'video-review-composition is-open');
      _renderCompositionBody(page, comp, true);
      host.appendChild(page);
      return;
    }
    const fold = _node('button', 'video-review-comp-fold');
    fold.type = 'button';
    fold.appendChild(_chevron());
    fold.appendChild(_node('span', 'video-review-fold-name', _compositionTitle(comp)));
    const pill = _renderPill(_compositionSteps(comp));
    if (pill) fold.appendChild(pill);
    host.appendChild(_collapsible({
      tag: 'section',
      boxClass: 'video-review-composition is-folded',
      bodyClass: 'video-review-fold-body',
      head: fold,
      isOpen: () => _isCompOpen(comp),
      setOpen: (open) => _compToggles.set(_compositionKey(comp), open),
      build: (body) => _renderCompositionBody(body, comp, false),
    }));
  }

  function _renderSummary(host, compositions) {
    const summary = _node('div', 'video-review-summary');
    summary.appendChild(_node('b', null, t('video_review.summary_count', { n: compositions.length })));
    const pending = _pendingCount(compositions);
    if (pending) {
      summary.appendChild(_node('i', 'video-review-meta-sep', '·'));
      summary.appendChild(_node('span', null, t('video_review.summary_pending', { n: pending })));
    }
    host.appendChild(summary);
  }

  function _renderEmpty(host) {
    const empty = _node('div', 'video-review-empty');
    empty.appendChild(_node('b', null, t('video_review.empty')));
    empty.appendChild(_node('span', null, t('video_review.empty_hint')));
    host.appendChild(empty);
  }

  function _render() {
    const body = _el('video-review-panel-body');
    if (!body) return;
    body.innerHTML = '';
    const compositions = (_panelData && _panelData.compositions) || [];
    if (!compositions.length) {
      _renderEmpty(body);
      return;
    }
    if (compositions.length > 1) _renderSummary(body, compositions);
    compositions.forEach((comp, index) => _renderComposition(body, comp, index));
  }

  async function _fetch(cid) {
    try {
      const res = await global.orkas.invoke('videoStudio.reviewPanel', { cid });
      if (!res || res.ok === false) return null;
      return res.panel || null;
    } catch (err) {
      _log.warn('review panel fetch failed', {
        error_type: err && err.name ? String(err.name) : typeof err,
      });
      return null;
    }
  }

  function _setOpen(open) {
    const panel = _el('video-review-panel');
    const toggle = _el('video-review-toggle');
    if (!panel) return;
    panel.hidden = !open;
    if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  async function refresh() {
    const requestedCid = _cid;
    if (!requestedCid) return;
    const panel = await _fetch(requestedCid);
    if (!_acceptsPanelResponse(_cid, requestedCid)) return;
    _panelData = panel;
    _render();
  }

  async function open(cid) {
    _cid = cid;
    // Fetch BEFORE revealing. `_setOpen(true)` only unhides the panel; the body
    // still holds whatever was rendered last, so showing first flashed the
    // previous conversation's productions until the round trip landed.
    await refresh();
    _setOpen(true);
  }

  function close() {
    _setOpen(false);
  }

  // Turn-end refresh: production state changes only through agent turns, so
  // an end-of-turn message is the natural staleness signal. Trailing debounce
  // absorbs clustered turn ends (commander + agent finishing together).
  let _turnEndTimer = 0;
  function notifyTurnEnd(cid) {
    if (!cid || cid !== _cid) return;
    clearTimeout(_turnEndTimer);
    _turnEndTimer = setTimeout(() => {
      const panel = _el('video-review-panel');
      if (panel && !panel.hidden) refresh();
      else probe(_cid);
    }, 600);
  }

  // Called on conversation detail open: shows the toolbar button only for
  // conversations that actually have production state, and hides the panel
  // when switching conversations.
  async function probe(cid) {
    if (_cid && _cid !== cid) close();
    if (_cid !== cid) {
      // Expansion choices belong to the conversation that was reviewed.
      _compToggles.clear();
      _sectionToggles.clear();
    }
    _cid = cid;
    const toggle = _el('video-review-toggle');
    if (!toggle) return;
    const panel = await _fetch(cid);
    if (!_acceptsPanelResponse(_cid, cid)) return;
    const hasState = !!(panel && panel.compositions && panel.compositions.length);
    toggle.hidden = !hasState;
    // Assign either way. Keeping the previous payload when the new conversation
    // has no production state left the drawer holding another conversation's
    // work, one `_render()` away from showing it.
    _panelData = hasState ? panel : null;
    if (hasState) {
      if (!_el('video-review-panel').hidden) _render();
    } else {
      close();
    }
  }

  function _bind() {
    const toggle = _el('video-review-toggle');
    if (toggle) {
      toggle.addEventListener('click', () => {
        const panel = _el('video-review-panel');
        if (!panel) return;
        if (panel.hidden) open(_cid);
        else close();
      });
    }
    const closeBtn = _el('video-review-panel-close');
    if (closeBtn) closeBtn.addEventListener('click', close);
    const refreshBtn = _el('video-review-panel-refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', refresh);
    global.addEventListener('i18n-change', () => {
      const panel = _el('video-review-panel');
      if (panel && !panel.hidden) _render();
    });
  }

  // Outside the renderer (the view-model test bridge requires this file)
  // there is no drawer to bind or expose.
  if (typeof document === 'undefined') return;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _bind);
  else _bind();

  global.VideoReviewPanel = { probe, open, close, refresh, notifyTurnEnd };
}(typeof window !== 'undefined' ? window : globalThis));
