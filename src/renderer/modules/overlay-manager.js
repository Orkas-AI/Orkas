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
  let occluding = new Set();
  let browserTarget = null;
  let presentedBounds = null;
  let targetBounds = null;
  let geometryFrame = 0;
  const moving = new Set();
  let browserOpen = false;
  let revision = 0;
  let epoch = 0;
  let sentBlocked = null;
  let acknowledgedBlocked = false;
  let pending = Promise.resolve(true);
  let scheduled = false;
  const sizeObserver = new ResizeObserver(() => scheduleGeometry());

  function track(element) {
    if (candidates.has(element)) return;
    candidates.add(element);
    sizeObserver.observe(element);
  }

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
    if (root.matches(selector)) track(root);
    for (const element of root.querySelectorAll(selector)) track(element);
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
      && (element.checkVisibility?.({ visibilityProperty: true }) ?? true);
  }

  function rectangle(rect) {
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    const left = rect.left ?? rect.x, top = rect.top ?? rect.y;
    return { left, top, right: left + rect.width, bottom: top + rect.height };
  }

  function intersects(a, b) {
    return a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }

  function paintsBox(element, style) {
    const opaque = value => value && value !== 'none' && value !== 'transparent' && value !== 'rgba(0, 0, 0, 0)';
    return opaque(style.backgroundColor) || opaque(style.backgroundImage) || opaque(style.boxShadow)
      || opaque(style.backdropFilter)
      || ['Top', 'Right', 'Bottom', 'Left'].some(side => parseFloat(style['border' + side + 'Width']) > 0
        && opaque(style['border' + side + 'Color']))
      || ['IMG', 'SVG', 'CANVAS', 'VIDEO', 'IFRAME', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT'].includes((element.tagName || '').toUpperCase());
  }

  function paintedRects(element, measure = true) {
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return [];
    // Transparent positioning wrappers do not paint their entire bounding box.
    // Stop at painted surfaces, so a dialog's document is never walked per frame.
    if (paintsBox(element, style)) return measure ? [...element.getClientRects()].map(rectangle).filter(Boolean) : [null];
    const rects = [];
    for (const node of element.childNodes || []) {
      if (node.nodeType !== 3 || !node.textContent.trim()) continue;
      if (!measure) return [null];
      const range = document.createRange();
      range.selectNodeContents(node);
      rects.push(...[...range.getClientRects()].map(rectangle).filter(Boolean));
    }
    return rects.concat([...(element.children || [])].flatMap(child => paintedRects(child, measure)));
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
      setWaiting(element, browserOpen && occluding.has(element) && !acknowledgedBlocked);
    }
  }

  function synchronize(force = false) {
    const blocked = occluding.size > 0;
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
      if (acknowledgedBlocked && presentedBounds) {
        presentedBounds = null;
        scheduleGeometry();
      }
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
    const previousBlocked = occluding.size > 0;
    const overlaps = new Set();
    const target = browserOpen && browserTarget ? rectangle(browserTarget.getBoundingClientRect()) : null;
    const moved = JSON.stringify(target) !== JSON.stringify(targetBounds);
    targetBounds = target;
    for (const element of candidates) {
      if (!element.isConnected || !element.matches(selector)) {
        // Gating only revisits candidates. A page that drops its overlay
        // modifier before acknowledgement must not stay unpainted.
        candidates.delete(element);
        sizeObserver.unobserve(element);
        setWaiting(element, false);
      } else if (displayed(element)) {
        // Registration remains live off screen; geometry is read only while
        // a task page is requested, including when occlusion hides its pixels.
        if (!browserOpen || !browserTarget) {
          if (paintedRects(element, false).length) next.add(element);
        }
        else {
          const rects = paintedRects(element);
          if (rects.length) next.add(element);
          if (rects.some(rect => intersects(rect, target) || intersects(rect, presentedBounds))) overlaps.add(element);
        }
      }
    }
    const changed = next.size !== active.size || [...next].some(element => !active.has(element));
    active = next;
    occluding = overlaps;
    synchronize();
    if (changed || moved || previousBlocked !== (overlaps.size > 0)) for (const listener of listeners) listener();
    return active.size;
  }

  function scheduleGeometry() {
    if (!browserOpen || !browserTarget || geometryFrame) return;
    geometryFrame = window.requestAnimationFrame(() => {
      geometryFrame = 0;
      refresh();
      for (const element of moving) {
        if (!element.isConnected || (element.getAnimations
          && !element.getAnimations().some(animation => animation.playState === 'running' || animation.playState === 'pending'))) moving.delete(element);
      }
      if (moving.size) scheduleGeometry();
    });
  }

  function setBrowserTarget(element) {
    if (browserTarget === element) return;
    if (browserTarget) sizeObserver.unobserve(browserTarget);
    browserTarget = element;
    if (element) sizeObserver.observe(element);
    else {
      presentedBounds = null;
      if (geometryFrame) window.cancelAnimationFrame(geometryFrame);
      geometryFrame = 0;
    }
    refresh();
  }

  function setPresentedBounds(bounds) {
    const next = rectangle(bounds);
    if (JSON.stringify(next) === JSON.stringify(presentedBounds)) return;
    presentedBounds = next;
    scheduleGeometry();
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
    presentedBounds = null;
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
        if (record.removedNodes.length) {
          if ([...candidates].some(element => !element.isConnected)) relevant = true;
          // Removal may not deliver an animation-end event. Release motion
          // roots even while off-screen geometry work is intentionally idle.
          for (const element of moving) if (!element.isConnected) moving.delete(element);
        }
      } else if (target.nodeType === 1 && target.matches(selector)) {
        track(target);
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
  window.addEventListener('resize', scheduleGeometry);
  document.addEventListener('scroll', scheduleGeometry, true);
  // Layout can move a layer without changing its own size or attributes.
  // Track CSS motion on roots and their ancestors until its real completion.
    for (const event of ['transitionrun', 'animationstart', 'transitionend', 'transitioncancel', 'animationend', 'animationcancel']) {
    document.addEventListener(event, e => {
      const element = e.target;
      if (!element?.contains || !(element.contains(browserTarget)
        || [...candidates].some(root => {
          if (element.contains(root)) return true;
          if (!root.contains(element)) return false;
          // Motion inside a painted card does not move that card's rectangle.
          // Transparent wrappers instead expose their moving child surfaces.
          for (let parent = element.parentElement; parent; parent = parent.parentElement) {
            if (paintsBox(parent, window.getComputedStyle(parent))) return false;
            if (parent === root) return true;
          }
          return false;
        }))) return;
      if (event === 'transitionrun' || event === 'animationstart') moving.add(element);
      else if (!(element.getAnimations?.().some(animation => animation.playState === 'running') ?? false)) moving.delete(element);
      scheduleGeometry();
    }, true);
  }
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
    setBrowserTarget,
    setPresentedBounds,
    isBrowserOccluded: () => occluding.size > 0,
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
