// Application layer ownership is declared by CSS, not browser-specific names.
// A new instance of a shared floating style automatically participates. Custom
// inline surfaces use .ui-overlay or data-ui-overlay. Only trusted app DOM is
// inspected; remote pages/frames cannot acquire application layer ownership.
(function () {
  const log = createLogger('overlay-manager');
  const candidates = new Set();
  const listeners = new Set();
  const semanticRoots = '[role="dialog"], [role="alertdialog"], [role="menu"], [aria-modal="true"], [popover], dialog[open]';
  let selector = semanticRoots + ', .ui-overlay, [data-ui-overlay], [style*="--orkas-ui-layer"]';
  let active = new Set();
  let browserOpen = false;
  let revision = 0;
  let epoch = 0;
  let sentBlocked = null;
  let acknowledgedBlocked = false;
  let pending = Promise.resolve(true);
  let scheduled = false;

  function readStyles() {
    const selectors = new Set([semanticRoots, '.ui-overlay', '[data-ui-overlay]', '[style*="--orkas-ui-layer"]']);
    const visited = new Set();
    const readSheet = (sheet) => {
      if (visited.has(sheet)) return;
      visited.add(sheet);
      try { visit(sheet.cssRules); } catch (_) {}
    };
    const visit = (rules) => {
      for (const rule of rules) {
        if (rule.selectorText && rule.style?.getPropertyValue('--orkas-ui-layer').trim() === 'overlay') {
          selectors.add(rule.selectorText);
        }
        if (rule.cssRules) visit(rule.cssRules);
        if (rule.styleSheet) readSheet(rule.styleSheet);
      }
    };
    for (const sheet of document.styleSheets) {
      // Third-party sheet contents are not an app layer declaration.
      readSheet(sheet);
    }
    selector = [...selectors].join(', ');
  }

  function discover(root) {
    if (root.nodeType !== 1) return;
    if (root.matches(selector)) candidates.add(root);
    for (const element of root.querySelectorAll(selector)) candidates.add(element);
  }

  function displayed(element) {
    if (!element.isConnected || element.hidden) return false;
    const style = window.getComputedStyle(element);
    const kind = style.getPropertyValue('--orkas-ui-layer').trim();
    // Standards-based third-party menus/dialogs also participate, without a
    // vendor-name inventory. Inline ARIA regions are not floating surfaces.
    const semantic = kind !== 'chrome' && element.matches(semanticRoots)
      && (['absolute', 'fixed'].includes(style.position) || element.matches('[popover], dialog[open]'));
    const declared = element.matches('.ui-overlay, [data-ui-overlay]')
      || kind === 'overlay' || semantic;
    return declared && style.display !== 'none' && style.visibility !== 'hidden'
      && style.visibility !== 'collapse'
      && [...element.getClientRects()].some(rect => rect.width > 0 && rect.height > 0);
  }

  function setWaiting(element, waiting) {
    if (element.classList.contains('ui-overlay-waiting') !== waiting) {
      element.classList.toggle('ui-overlay-waiting', waiting);
    }
  }

  function gatePendingLayers() {
    // Keep a newly opened surface unpainted until main has removed the native
    // pixels. Opacity does not change its geometry or the detection above.
    for (const element of candidates) {
      setWaiting(element, browserOpen && active.has(element) && !acknowledgedBlocked);
    }
  }

  function synchronize(force = false) {
    const blocked = active.size > 0;
    if (!browserOpen) {
      sentBlocked = null;
      acknowledgedBlocked = false;
      gatePendingLayers();
      return pending = Promise.resolve(true);
    }
    if (!force && sentBlocked === blocked) {
      gatePendingLayers();
      return pending;
    }
    sentBlocked = blocked;
    const request = ++revision;
    const documentEpoch = epoch;
    if (!blocked) acknowledgedBlocked = false;
    gatePendingLayers();
    pending = window.orkas.invoke('webAssist.overlayState', { blocked, revision: request, epoch: documentEpoch }).then(result => {
      if (documentEpoch !== epoch || request !== revision || !browserOpen) return true;
      if (!result?.ok) throw new Error('overlay presentation unavailable');
      acknowledgedBlocked = result.blocked === true;
      gatePendingLayers();
      return true;
    }).catch(() => {
      if (documentEpoch === epoch && request === revision && browserOpen) {
        // Permit a later state change/explicit refresh to retry; never display
        // a floating control underneath a native page after an IPC failure.
        sentBlocked = null;
        log.warn('overlay presentation update failed');
      }
      return false;
    });
    return pending;
  }

  function refresh() {
    const next = new Set();
    for (const element of candidates) {
      if (!element.isConnected || !element.matches(selector)) {
        // Gating only revisits candidates. A page that drops its overlay
        // modifier before acknowledgement must not stay unpainted.
        candidates.delete(element);
        setWaiting(element, false);
      } else if (displayed(element)) next.add(element);
    }
    const changed = next.size !== active.size || [...next].some(element => !active.has(element));
    active = next;
    synchronize();
    if (changed) for (const listener of listeners) listener();
    return active.size;
  }

  function scheduleRefresh() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; refresh(); });
  }

  function setBrowserOpen(open, documentEpoch = epoch) {
    const next = !!open;
    if (browserOpen === next && epoch === documentEpoch) return;
    browserOpen = next;
    epoch = documentEpoch;
    // Invalidate old acknowledgements across close/reopen of the browser.
    revision += 1;
    sentBlocked = null;
    acknowledgedBlocked = false;
    refresh();
  }

  readStyles();
  discover(document.body);
  refresh();
  new MutationObserver(records => {
    let relevant = false;
    let stylesChanged = false;
    for (const record of records) {
      const target = record.target;
      if (target.nodeType === 1 && target.matches('style')) stylesChanged = true;
      if (record.type === 'childList') {
        for (const node of record.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.matches('style, link[rel="stylesheet"]') || node.querySelector('style, link[rel="stylesheet"]')) stylesChanged = true;
          const size = candidates.size;
          discover(node);
          if (size !== candidates.size) relevant = true;
        }
        if (record.removedNodes.length && [...candidates].some(element => !element.isConnected)) relevant = true;
      } else if (target.nodeType === 1 && target.matches(selector)) {
        candidates.add(target);
        relevant = true;
      }
      // Changes in a floating root or its ancestors can alter layout/visibility.
      // Ordinary transcript mutations do not scan the body or every message.
      if (!relevant && target.nodeType === 1) {
        relevant = [...candidates].some(element => element.contains(target) || target.contains(element));
      }
    }
    if (stylesChanged) { readStyles(); discover(document.body); relevant = true; }
    if (relevant) scheduleRefresh();
  }).observe(document.documentElement, {
    subtree: true, childList: true, attributes: true,
    attributeFilter: ['hidden', 'class', 'style', 'data-ui-overlay', 'role', 'aria-modal', 'open', 'popover'],
  });
  window.addEventListener('resize', scheduleRefresh);
  document.addEventListener('toggle', scheduleRefresh, true);
  // CSS-driven popovers can change without a DOM mutation. Refresh only the
  // recorded roots on hover/focus transitions, never on every pointer move.
  for (const event of ['pointerover', 'pointerout', 'focusin', 'focusout']) {
    document.addEventListener(event, scheduleRefresh, true);
  }
  document.addEventListener('load', event => {
    if (event.target?.matches?.('link[rel="stylesheet"]')) {
      readStyles(); discover(document.body); scheduleRefresh();
    }
  }, true);

  window.OverlayManager = {
    hasOpenLayers: () => active.size > 0,
    count: () => active.size,
    refresh,
    setBrowserOpen,
    settled: () => pending,
    version: () => revision,
    epoch: () => epoch,
    hasModalLayers: () => [...active].some(element => element.matches('[aria-modal="true"]')
      || !!element.querySelector('[aria-modal="true"]')),
    layerForEvent(event) {
      // composedPath survives removal by an earlier Escape handler.
      return (event.composedPath?.() || [event.target]).find(element => (
        element?.nodeType === 1 && element.matches(selector)
        && window.getComputedStyle(element).getPropertyValue('--orkas-ui-layer').trim() !== 'chrome'
      )) || null;
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
})();
