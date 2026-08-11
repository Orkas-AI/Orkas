(function initConversationTurnNavModule(root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && typeof module.exports === 'object') {
    module.exports = api;
  }
  if (!root || !root.document) return;
  root.ConversationTurnNav = api;
  if (root.document.readyState === 'loading') {
    root.document.addEventListener('DOMContentLoaded', () => api.init(), { once: true });
  } else {
    api.init();
  }
}(typeof window !== 'undefined' ? window : null, (root) => {
  'use strict';

  const MIN_TURNS = 5;
  const PAGE_SIZE = 15;
  const VISIBLE_MARKERS = 12;
  const PREVIEW_TITLE_CHARS = 40;
  const PREVIEW_BODY_CHARS = 80;
  const LOAD_THRESHOLD = 18;
  const SCROLL_EDGE_EPSILON = 1;
  const OVERFLOW_EDGE_MARKERS = 3;
  const turnNavLog = typeof createLogger === 'function'
    ? createLogger('conversation-turn-nav')
    : null;

  function warnRecoverable(message, error) {
    if (!turnNavLog) return;
    turnNavLog.warn(message, {
      error_type: error && typeof error.name === 'string' ? error.name : 'unknown',
    });
  }

  const state = {
    cid: '',
    container: null,
    nav: null,
    markers: null,
    preview: null,
    previewTitle: null,
    previewBody: null,
    turns: [],
    total: 0,
    nextCursor: null,
    indexReady: false,
    activeKey: '',
    loadPage: null,
    onActivate: null,
    loadingInitial: null,
    loadingOlder: null,
    mutationObserver: null,
    intersectionObserver: null,
    refreshFrame: null,
    requestGeneration: 0,
    userIntentUntil: 0,
    liveSequence: 0,
    bound: false,
  };

  function shouldShowTurnNav(turnCount, minimum = MIN_TURNS) {
    return Math.max(0, Number(turnCount) || 0) >= Math.max(1, Number(minimum) || MIN_TURNS);
  }

  function normalizeSnippet(value, maximum) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    const cap = Math.max(1, Math.floor(Number(maximum) || text.length || 1));
    const chars = Array.from(text);
    return chars.length > cap
      ? `${chars.slice(0, Math.max(1, cap - 1)).join('')}…`
      : text;
  }

  function messageSnippet(message, maximum) {
    if (!message || typeof message.querySelector !== 'function') return '';
    const body = message.querySelector('.chat-bubble .markdown-body')
      || message.querySelector('.chat-bubble');
    return normalizeSnippet(body && body.textContent, maximum);
  }

  function previewForTurn(target, options = {}) {
    const titleMaximum = Number(options.titleMaximum) || PREVIEW_TITLE_CHARS;
    const bodyMaximum = Number(options.bodyMaximum) || PREVIEW_BODY_CHARS;
    const title = messageSnippet(target, titleMaximum);
    const replies = [];
    let sibling = target && target.nextElementSibling;
    while (sibling) {
      if (typeof sibling.matches === 'function' && sibling.matches('.chat-message.user')) break;
      if (typeof sibling.matches === 'function' && sibling.matches('.chat-message.assistant')) {
        const remaining = bodyMaximum - replies.join(' · ').length;
        if (remaining <= 1) break;
        const reply = messageSnippet(sibling, remaining);
        if (reply) replies.push(reply);
      }
      sibling = sibling.nextElementSibling;
    }
    return {
      title,
      body: normalizeSnippet(replies.join(' · '), bodyMaximum),
    };
  }

  function centeredMarkerScrollTop(metrics = {}) {
    const markerTop = Math.max(0, Number(metrics.markerTop) || 0);
    const markerHeight = Math.max(0, Number(metrics.markerHeight) || 0);
    const clientHeight = Math.max(0, Number(metrics.clientHeight) || 0);
    const scrollHeight = Math.max(clientHeight, Number(metrics.scrollHeight) || 0);
    const maximumTop = Math.max(0, scrollHeight - clientHeight);
    const centeredTop = markerTop - Math.max(0, clientHeight - markerHeight) / 2;
    return Math.min(maximumTop, Math.max(0, centeredTop));
  }

  function turnNavOverflowState(metrics = {}, hasOlderPage = false) {
    const clientHeight = Math.max(0, Number(metrics.clientHeight) || 0);
    const scrollHeight = Math.max(clientHeight, Number(metrics.scrollHeight) || 0);
    const maximumTop = Math.max(0, scrollHeight - clientHeight);
    const scrollTop = Math.min(maximumTop, Math.max(0, Number(metrics.scrollTop) || 0));
    return {
      before: Boolean(hasOlderPage) || scrollTop > SCROLL_EDGE_EPSILON,
      after: maximumTop - scrollTop > SCROLL_EDGE_EPSILON,
    };
  }

  function overflowEdgeRanks(markerMetrics = [], metrics = {}, overflow = {}) {
    const markers = Array.from(markerMetrics || []);
    const ranks = markers.map(() => 0);
    const scrollTop = Math.max(0, Number(metrics.scrollTop) || 0);
    const clientHeight = Math.max(0, Number(metrics.clientHeight) || 0);
    if (!clientHeight) return ranks;
    const viewportBottom = scrollTop + clientHeight;
    const visibleIndexes = markers.map((marker, index) => ({
      index,
      top: Number(marker?.offsetTop) || 0,
      height: Math.max(0, Number(marker?.offsetHeight) || 0),
    })).filter((marker) => (
      marker.top + marker.height > scrollTop + SCROLL_EDGE_EPSILON
      && marker.top < viewportBottom - SCROLL_EDGE_EPSILON
    )).map((marker) => marker.index);
    if (overflow.before) {
      visibleIndexes.slice(0, OVERFLOW_EDGE_MARKERS).forEach((index, rank) => {
        ranks[index] = rank + 1;
      });
    }
    if (overflow.after) {
      visibleIndexes.slice(-OVERFLOW_EDGE_MARKERS).reverse().forEach((index, rank) => {
        if (!ranks[index]) ranks[index] = rank + 1;
      });
    }
    return ranks;
  }

  function jumpToTurn(container, target, dependencies = {}) {
    if (!container || !target
        || typeof container.getBoundingClientRect !== 'function'
        || typeof target.getBoundingClientRect !== 'function') return false;
    const markProgrammatic = dependencies.markProgrammatic;
    const requestFrame = dependencies.requestFrame || ((callback) => callback());
    const setTimer = dependencies.setTimer || (() => {});
    const previousBehavior = container.style ? container.style.scrollBehavior || '' : '';
    if (container.style) container.style.scrollBehavior = 'auto';
    if (typeof markProgrammatic === 'function') markProgrammatic(container);
    else container._stickyProgrammaticUntil = Date.now() + 1000;

    const containerRect = container.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const centeredTop = Number(container.scrollTop || 0)
      + targetRect.top - containerRect.top
      - (Number(container.clientHeight || 0) - targetRect.height) / 2;
    container.scrollTop = Math.max(0, centeredTop);
    container._stickyEnabled = false;
    container._stickyUserPaused = true;
    requestFrame(() => {
      if (container.style) container.style.scrollBehavior = previousBehavior;
    });
    if (target.classList && typeof target.classList.add === 'function') {
      target.classList.add('turn-nav-flash');
      setTimer(() => target.classList.remove('turn-nav-flash'), 1000);
    }
    return true;
  }

  function translate(key, fallback, vars) {
    try {
      if (root && typeof root.t === 'function') {
        const translated = root.t(key, vars);
        if (translated && translated !== key) return translated;
      }
    } catch (error) {
      warnRecoverable('turn navigation translation failed', error);
    }
    return String(fallback || key).replace(/\{(\w+)\}/g, (_match, name) => (
      Object.prototype.hasOwnProperty.call(vars || {}, name) ? String(vars[name]) : ''
    ));
  }

  function normalizeTurnDescriptor(raw = {}) {
    const turnNo = Math.max(1, Math.floor(Number(raw.turnNo ?? raw.turn_no) || 1));
    const messageIndex = Number(raw.messageIndex ?? raw.message_index);
    const messageId = String(raw.messageId ?? raw.message_id ?? '');
    const clientMessageId = String(raw.clientMessageId ?? raw.client_message_id ?? '');
    const liveKey = String(raw.liveKey ?? raw.live_key ?? '');
    return {
      turnNo,
      messageId,
      clientMessageId,
      messageIndex: Number.isSafeInteger(messageIndex) && messageIndex >= 0 ? messageIndex : null,
      userPreview: normalizeSnippet(
        raw.userPreview ?? raw.user_preview,
        PREVIEW_TITLE_CHARS,
      ),
      assistantPreview: normalizeSnippet(
        raw.assistantPreview ?? raw.assistant_preview,
        PREVIEW_BODY_CHARS,
      ),
      liveKey,
      target: raw.target || null,
      provisional: raw.provisional === true,
    };
  }

  function turnKey(turn) {
    if (turn.messageId) return `m:${turn.messageId}`;
    if (turn.clientMessageId) return `c:${turn.clientMessageId}`;
    if (Number.isSafeInteger(turn.messageIndex)) return `i:${turn.messageIndex}`;
    return turn.liveKey ? `l:${turn.liveKey}` : `t:${turn.turnNo}`;
  }

  function mountedUserTurns(container) {
    return Array.from(container?.children || []).filter((node) => (
      typeof node.matches === 'function' && node.matches('.chat-message.user')
    ));
  }

  function targetForTurn(turn, mounted = mountedUserTurns(state.container)) {
    if (!turn) return null;
    if (turn.target && turn.target.parentElement) return turn.target;
    if (turn.messageId) {
      const byId = mounted.find((node) => String(node.dataset?.msgId || '') === turn.messageId);
      if (byId) return byId;
    }
    if (Number.isSafeInteger(turn.messageIndex)) {
      const byIndex = mounted.find((node) => Number(node.dataset?.msgIndex) === turn.messageIndex);
      if (byIndex) return byIndex;
    }
    const clientMessageId = turn.clientMessageId || turn.liveKey;
    if (clientMessageId) {
      return mounted.find((node) => (
        String(node.dataset?.clientMsgId || '') === clientMessageId
      )) || null;
    }
    return null;
  }

  function rebindMountedTargets() {
    const mounted = mountedUserTurns(state.container);
    state.turns.forEach((turn) => { turn.target = targetForTurn(turn, mounted); });
  }

  function mergeTurnPage(current, incoming) {
    const result = current.slice();
    for (const raw of incoming || []) {
      const next = normalizeTurnDescriptor(raw);
      let index = result.findIndex((turn) => turnKey(turn) === turnKey(next));
      if (index < 0 && next.messageId) {
        index = result.findIndex((turn) => (
          turn.target && String(turn.target.dataset?.msgId || '') === next.messageId
        ));
      }
      if (index < 0 && next.clientMessageId) {
        index = result.findIndex((turn) => (
          turn.clientMessageId === next.clientMessageId
          || turn.liveKey === next.clientMessageId
          || (turn.target
            && String(turn.target.dataset?.clientMsgId || '') === next.clientMessageId)
        ));
      }
      if (index < 0) {
        index = result.findIndex((turn) => turn.provisional && turn.turnNo === next.turnNo);
      }
      if (index >= 0) {
        result[index] = { ...result[index], ...next, target: result[index].target || next.target };
      } else {
        result.push(next);
      }
    }
    result.sort((left, right) => left.turnNo - right.turnNo);
    return result;
  }

  function rebaseProvisionalTurns(turns, persistedTotal) {
    let nextTurnNo = Math.max(0, Number(persistedTotal) || 0);
    turns.filter((turn) => turn.provisional).forEach((turn) => {
      nextTurnNo += 1;
      turn.turnNo = nextTurnNo;
    });
    turns.sort((left, right) => left.turnNo - right.turnNo);
    return nextTurnNo;
  }

  function markerFromEvent(event) {
    const marker = event.target?.closest?.('.chat-turn-nav-marker');
    return marker && state.nav?.contains(marker) ? marker : null;
  }

  function turnFromMarker(marker) {
    const key = String(marker?.dataset?.turnKey || '');
    return state.turns.find((turn) => turnKey(turn) === key) || null;
  }

  function hidePreview() {
    if (!state.nav || !state.preview) return;
    state.nav.classList.remove('is-previewing');
    state.preview.hidden = true;
  }

  function previewContentForTurn(turn) {
    if (turn?.target) {
      const mountedPreview = previewForTurn(turn.target);
      if (mountedPreview.title || mountedPreview.body) return mountedPreview;
    }
    return {
      title: normalizeSnippet(turn?.userPreview, PREVIEW_TITLE_CHARS),
      body: normalizeSnippet(turn?.assistantPreview, PREVIEW_BODY_CHARS),
    };
  }

  function showPreview(marker) {
    const turn = turnFromMarker(marker);
    if (!turn || !state.preview || !state.previewTitle || !state.previewBody) return;
    const content = previewContentForTurn(turn);
    state.previewTitle.textContent = content.title || translate(
      'chat.turn_nav_fallback', 'Turn {n}', { n: turn.turnNo },
    );
    state.previewBody.textContent = content.body;
    state.previewBody.hidden = !content.body;
    state.preview.style.setProperty(
      '--turn-nav-preview-y',
      `${Number(marker.offsetTop || 0) - Number(state.markers?.scrollTop || 0)
        + Number(marker.offsetHeight || 0) / 2}px`,
    );
    state.preview.hidden = false;
    state.nav.classList.add('is-previewing');
  }

  function updateOverflowIndicators() {
    if (!state.nav || !state.markers) return;
    const overflow = state.nav.hidden
      ? { before: false, after: false }
      : turnNavOverflowState(state.markers, state.nextCursor !== null);
    state.nav.classList.toggle('has-more-before', overflow.before);
    state.nav.classList.toggle('has-more-after', overflow.after);
    const markers = Array.from(state.markers.querySelectorAll('.chat-turn-nav-marker'));
    const edgeRanks = overflowEdgeRanks(markers, state.markers, overflow);
    markers.forEach((marker, index) => {
      marker.classList.remove(
        'is-overflow-edge-1',
        'is-overflow-edge-2',
        'is-overflow-edge-3',
      );
      if (edgeRanks[index]) marker.classList.add(`is-overflow-edge-${edgeRanks[index]}`);
    });
  }

  function centerMarker(marker) {
    if (!state.markers || !marker || Number(state.markers.clientHeight || 0) <= 0) {
      updateOverflowIndicators();
      return;
    }
    const nextTop = centeredMarkerScrollTop({
      markerTop: marker.offsetTop,
      markerHeight: marker.offsetHeight,
      clientHeight: state.markers.clientHeight,
      scrollHeight: state.markers.scrollHeight,
    });
    if (Math.abs(Number(state.markers.scrollTop || 0) - nextTop) > SCROLL_EDGE_EPSILON) {
      state.markers.scrollTop = nextTop;
    }
    updateOverflowIndicators();
  }

  function setActiveTurn(turn, options = {}) {
    if (!state.markers || !turn) return;
    const nextActiveKey = turnKey(turn);
    const activeChanged = nextActiveKey !== state.activeKey;
    state.activeKey = nextActiveKey;
    let activeMarker = null;
    state.markers.querySelectorAll('.chat-turn-nav-marker').forEach((marker) => {
      const active = marker.dataset.turnKey === state.activeKey;
      marker.classList.toggle('is-active', active);
      marker.tabIndex = active ? 0 : -1;
      if (active) {
        activeMarker = marker;
        marker.setAttribute('aria-current', 'location');
      }
      else marker.removeAttribute('aria-current');
    });
    if (activeMarker && (activeChanged || options.forceCenter === true)) {
      centerMarker(activeMarker);
    } else {
      updateOverflowIndicators();
    }
  }

  function bindIntersectionObserver() {
    if (state.intersectionObserver) state.intersectionObserver.disconnect();
    state.intersectionObserver = null;
    if (!root || typeof root.IntersectionObserver !== 'function' || !state.container) return;
    state.intersectionObserver = new root.IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting);
      if (!visible.length) return;
      visible.sort((left, right) => right.intersectionRatio - left.intersectionRatio);
      const target = visible[0].target;
      const turn = state.turns.find((entry) => entry.target === target);
      if (turn) setActiveTurn(turn);
    }, {
      root: state.container,
      rootMargin: '-18% 0px -68% 0px',
      threshold: [0, 0.25, 0.75],
    });
    state.turns.forEach((turn) => {
      if (turn.target) state.intersectionObserver.observe(turn.target);
    });
  }

  function renderMarkers() {
    if (!state.nav || !state.markers) return;
    hidePreview();
    rebindMountedTargets();
    if (!shouldShowTurnNav(state.total) || !state.turns.length) {
      state.markers.replaceChildren();
      state.nav.hidden = true;
      updateOverflowIndicators();
      if (state.intersectionObserver) state.intersectionObserver.disconnect();
      return;
    }
    const previousActive = state.turns.find((turn) => turnKey(turn) === state.activeKey)
      || state.turns[state.turns.length - 1];
    const fragment = state.nav.ownerDocument.createDocumentFragment();
    state.turns.forEach((turn) => {
      const marker = state.nav.ownerDocument.createElement('button');
      marker.type = 'button';
      marker.className = 'chat-turn-nav-marker';
      marker.dataset.turnKey = turnKey(turn);
      marker.setAttribute('aria-describedby', 'chat-turn-nav-preview');
      marker.setAttribute('aria-label', translate(
        'chat.turn_nav_item',
        'Go to turn {n} of {total}',
        { n: turn.turnNo, total: state.total },
      ));
      fragment.appendChild(marker);
    });
    state.markers.replaceChildren(fragment);
    state.nav.setAttribute('aria-label', translate(
      'chat.turn_nav_label', 'Conversation turns', {},
    ));
    state.nav.hidden = false;
    const activeChanged = turnKey(previousActive) !== state.activeKey;
    setActiveTurn(previousActive);
    bindIntersectionObserver();
    const requestFrame = root?.requestAnimationFrame || ((callback) => setTimeout(callback, 0));
    requestFrame(() => {
      const activeMarker = Array.from(
        state.markers?.querySelectorAll('.chat-turn-nav-marker') || [],
      ).find((marker) => marker.dataset.turnKey === state.activeKey);
      if (activeChanged && activeMarker) centerMarker(activeMarker);
      else updateOverflowIndicators();
    });
  }

  function fallbackToMountedTurns() {
    const mounted = mountedUserTurns(state.container);
    state.turns = mounted.map((target, index) => normalizeTurnDescriptor({
      turnNo: index + 1,
      messageId: target.dataset?.msgId || '',
      messageIndex: Number(target.dataset?.msgIndex),
      userPreview: messageSnippet(target, PREVIEW_TITLE_CHARS),
      target,
      liveKey: target.dataset?.clientMsgId || `fallback-${index}`,
    }));
    state.total = state.turns.length;
    state.nextCursor = null;
    state.indexReady = false;
    renderMarkers();
  }

  async function loadInitialPage() {
    if (!state.cid || typeof state.loadPage !== 'function') return;
    const generation = state.requestGeneration;
    const run = (async () => {
      try {
        const page = await state.loadPage(null);
        if (generation !== state.requestGeneration) return;
        state.turns = mergeTurnPage(state.turns, page?.turns || []);
        const persistedTotal = Math.max(0, Number(page?.total) || 0);
        const totalWithLiveTurns = rebaseProvisionalTurns(state.turns, persistedTotal);
        state.total = Math.max(persistedTotal, totalWithLiveTurns, state.turns.length);
        const cursor = Number(page?.nextCursor ?? page?.next_cursor);
        state.nextCursor = Number.isSafeInteger(cursor) && cursor > 0 ? cursor : null;
        state.indexReady = true;
        renderMarkers();
      } catch (error) {
        warnRecoverable('turn navigation initial page load failed', error);
        if (generation === state.requestGeneration) fallbackToMountedTurns();
      }
    })();
    state.loadingInitial = run;
    try { await run; } finally {
      if (state.loadingInitial === run) state.loadingInitial = null;
    }
  }

  async function loadOlderPage() {
    if (!state.cid || state.nextCursor === null || state.loadingOlder
        || typeof state.loadPage !== 'function') return state.loadingOlder;
    const generation = state.requestGeneration;
    const cursor = state.nextCursor;
    const previousHeight = Number(state.markers?.scrollHeight || 0);
    const previousTop = Number(state.markers?.scrollTop || 0);
    const run = (async () => {
      try {
        const page = await state.loadPage(cursor);
        if (generation !== state.requestGeneration) return;
        state.turns = mergeTurnPage(state.turns, page?.turns || []);
        state.total = Math.max(Number(page?.total) || 0, state.turns.length);
        const next = Number(page?.nextCursor ?? page?.next_cursor);
        state.nextCursor = Number.isSafeInteger(next) && next > 0 ? next : null;
        renderMarkers();
        const requestFrame = root?.requestAnimationFrame || ((callback) => setTimeout(callback, 0));
        requestFrame(() => {
          const nextHeight = Number(state.markers?.scrollHeight || 0);
          state.markers.scrollTop = Math.max(0, previousTop + nextHeight - previousHeight);
          updateOverflowIndicators();
        });
      } catch (error) {
        warnRecoverable('turn navigation older page load failed', error);
        // Keep the current page and allow the next user gesture to retry.
      }
    })();
    state.loadingOlder = run;
    try { await run; } finally {
      if (state.loadingOlder === run) state.loadingOlder = null;
    }
    return run;
  }

  function markUserIntent() {
    state.userIntentUntil = Date.now() + 1200;
  }

  function maybeLoadOlderFromScroll() {
    if (Date.now() > state.userIntentUntil) return;
    if (Number(state.markers?.scrollTop || 0) <= LOAD_THRESHOLD) void loadOlderPage();
  }

  function scheduleMountedRebind() {
    if (state.refreshFrame !== null) return;
    const requestFrame = root?.requestAnimationFrame || ((callback) => setTimeout(callback, 0));
    state.refreshFrame = requestFrame(() => {
      state.refreshFrame = null;
      rebindMountedTargets();
      bindIntersectionObserver();
    });
  }

  async function activateMarker(marker) {
    const turn = turnFromMarker(marker);
    if (!turn) return;
    setActiveTurn(turn, { forceCenter: true });
    if (turn.target) {
      jumpToTurn(state.container, turn.target, {
        markProgrammatic: root._markProgrammaticStickyScroll,
        requestFrame: root.requestAnimationFrame?.bind(root),
        setTimer: root.setTimeout?.bind(root),
      });
      return;
    }
    if (typeof state.onActivate !== 'function') return;
    marker.classList.add('is-loading');
    marker.disabled = true;
    try { await state.onActivate(turn); } finally {
      marker.classList.remove('is-loading');
      marker.disabled = false;
      scheduleMountedRebind();
    }
  }

  function bindEvents() {
    if (!state.nav || !state.markers || state.bound) return;
    state.bound = true;
    state.nav.addEventListener('pointerover', (event) => {
      const marker = markerFromEvent(event);
      if (marker) showPreview(marker);
    });
    state.nav.addEventListener('pointerleave', hidePreview);
    state.nav.addEventListener('focusin', (event) => {
      const marker = markerFromEvent(event);
      if (marker) showPreview(marker);
    });
    state.nav.addEventListener('focusout', (event) => {
      if (!state.nav.contains(event.relatedTarget)) hidePreview();
    });
    state.nav.addEventListener('click', (event) => {
      const marker = markerFromEvent(event);
      if (!marker) return;
      event.preventDefault();
      void activateMarker(marker);
    });
    state.nav.addEventListener('keydown', (event) => {
      const marker = markerFromEvent(event);
      if (!marker) return;
      const markers = Array.from(state.markers.querySelectorAll('.chat-turn-nav-marker'));
      const currentIndex = markers.indexOf(marker);
      let nextIndex = currentIndex;
      if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') nextIndex -= 1;
      else if (event.key === 'ArrowDown' || event.key === 'ArrowRight') nextIndex += 1;
      else if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = markers.length - 1;
      else if (event.key === 'Escape') {
        hidePreview();
        marker.blur();
        return;
      } else return;
      event.preventDefault();
      if (nextIndex < 0 && state.nextCursor !== null) {
        void loadOlderPage().then(() => {
          const refreshed = state.markers.querySelectorAll('.chat-turn-nav-marker');
          refreshed[Math.max(0, refreshed.length - markers.length - 1)]?.focus();
        });
        return;
      }
      markers[Math.max(0, Math.min(markers.length - 1, nextIndex))]?.focus();
    });
    state.markers.addEventListener('pointerdown', markUserIntent, { passive: true });
    state.markers.addEventListener('touchstart', markUserIntent, { passive: true });
    state.markers.addEventListener('touchmove', () => {
      markUserIntent();
      maybeLoadOlderFromScroll();
    }, { passive: true });
    state.markers.addEventListener('wheel', (event) => {
      markUserIntent();
      if (Number(event?.deltaY || 0) < 0) maybeLoadOlderFromScroll();
    }, { passive: true });
    state.markers.addEventListener('scroll', () => {
      updateOverflowIndicators();
      maybeLoadOlderFromScroll();
    }, { passive: true });
  }

  function init(options = {}) {
    if (!root && !options.document) return null;
    const documentRef = options.document || root.document;
    if (state.container && state.nav) return state;
    state.container = documentRef.getElementById('chat-history');
    state.nav = documentRef.getElementById('chat-turn-nav');
    state.markers = documentRef.getElementById('chat-turn-nav-markers');
    state.preview = documentRef.getElementById('chat-turn-nav-preview');
    state.previewTitle = documentRef.getElementById('chat-turn-nav-preview-title');
    state.previewBody = documentRef.getElementById('chat-turn-nav-preview-body');
    if (!state.container || !state.nav || !state.markers || !state.preview) return null;
    bindEvents();
    const MutationObserverRef = options.MutationObserver || root.MutationObserver;
    if (typeof MutationObserverRef === 'function') {
      state.mutationObserver = new MutationObserverRef(scheduleMountedRebind);
      state.mutationObserver.observe(state.container, {
        childList: true,
        attributes: true,
        attributeFilter: ['data-msg-id', 'data-msg-index'],
      });
    }
    root?.addEventListener?.('i18n-change', () => renderMarkers());
    state.nav.hidden = true;
    return state;
  }

  function open(options = {}) {
    init();
    const cid = String(options.cid || '');
    if (!cid) return null;
    if (state.cid === cid) {
      if (typeof options.loadPage === 'function') state.loadPage = options.loadPage;
      if (typeof options.onActivate === 'function') state.onActivate = options.onActivate;
      if (!state.loadingInitial && !state.indexReady) void loadInitialPage();
      return state.loadingInitial;
    }
    state.requestGeneration += 1;
    state.cid = cid;
    state.turns = [];
    state.total = 0;
    state.nextCursor = null;
    state.indexReady = false;
    state.activeKey = '';
    state.loadPage = typeof options.loadPage === 'function' ? options.loadPage : null;
    state.onActivate = typeof options.onActivate === 'function' ? options.onActivate : null;
    state.loadingInitial = null;
    state.loadingOlder = null;
    state.userIntentUntil = 0;
    hidePreview();
    state.markers?.replaceChildren();
    if (state.nav) {
      state.nav.hidden = true;
      updateOverflowIndicators();
    }
    void loadInitialPage();
    return state.loadingInitial;
  }

  function appendLiveTurn(cid, target, content = '') {
    if (!cid || cid !== state.cid || !target || !state.container?.contains(target)) return null;
    const messageId = String(target.dataset?.msgId || '');
    const messageIndex = Number(target.dataset?.msgIndex);
    const liveKey = String(target.dataset?.clientMsgId || `live-${++state.liveSequence}`);
    const existing = state.turns.find((turn) => (
      (messageId && turn.messageId === messageId)
      || (turn.liveKey && turn.liveKey === liveKey)
      || turn.target === target
    ));
    if (existing) {
      existing.target = target;
      return existing;
    }
    const turn = normalizeTurnDescriptor({
      turnNo: state.total + 1,
      messageId,
      clientMessageId: liveKey,
      messageIndex,
      userPreview: content || messageSnippet(target, PREVIEW_TITLE_CHARS),
      liveKey,
      target,
      provisional: true,
    });
    state.turns.push(turn);
    state.total += 1;
    renderMarkers();
    return turn;
  }

  return {
    MIN_TURNS,
    PAGE_SIZE,
    VISIBLE_MARKERS,
    PREVIEW_TITLE_CHARS,
    PREVIEW_BODY_CHARS,
    init,
    open,
    appendLiveTurn,
    loadOlderPage,
    shouldShowTurnNav,
    normalizeSnippet,
    normalizeTurnDescriptor,
    mergeTurnPage,
    rebaseProvisionalTurns,
    previewForTurn,
    centeredMarkerScrollTop,
    turnNavOverflowState,
    overflowEdgeRanks,
    jumpToTurn,
  };
}));
