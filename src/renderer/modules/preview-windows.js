// Main-window entry adapter. Preview renderers deliberately do not load this
// script: their existing viewers render locally inside the native window.
(function () {
  'use strict';
  async function open(source) {
    try {
      const result = await window.orkas.invoke('previewWindows.open', source);
      if (!result?.ok) throw new Error('preview_open_failed');
      return result;
    } catch (_) {
      if (typeof uiAlert === 'function') await uiAlert(t('chat.preview_window_failed'));
      return { ok: false };
    }
  }
  function options(opts) {
    const result = {};
    for (const key of ['cid', 'projectId', 'absPath', 'autoplay', 'startTime', 'duration', 'ended']) {
      const value = opts?.[key];
      if (value != null && (typeof value !== 'number' || Number.isFinite(value))) result[key] = value;
    }
    result.projectScoped = !!opts?.projectId || _viewerConversationIsProjectScoped(opts?.cid);
    return result;
  }
  function image(src, title, opts) {
    const root = opts?.sourceElement?.closest('.chat-history');
    const cid = opts?.cid || (typeof currentCid !== 'undefined' ? currentCid : null);
    let gallery = null;
    if (root && cid) {
      const nodes = _lightboxGalleryItems({ root, cid });
      const items = nodes.map(({ node, ...item }) => item);
      let index = nodes.findIndex(item => item.node === opts.sourceElement);
      if (index < 0) index = items.findIndex(item => item.src === src || (opts?.absPath && item.absPath === opts.absPath));
      if (index >= 0) {
        const cursor = root.querySelector('.chat-history-load-earlier')?.dataset.cursor;
        gallery = { items, index, cid, nextCursor: cursor == null ? null : Number(cursor) };
      }
    }
    return open({ kind: 'image', src, title: title || '', options: options({ ...opts, cid }), gallery });
  }
  window.OrkasPreviewWindows = { open, image, options };
  window.orkas.onPushEvent('preview-windows:files-changed', () => {
    if (currentView === 'contexts' && typeof loadContexts === 'function') loadContexts();
    if (currentView === 'apps' && typeof loadSavedApps === 'function') loadSavedApps(true);
    if (currentView === 'project' && typeof loadProjectDetail === 'function' && typeof _projectDetailPid !== 'undefined') void loadProjectDetail(_projectDetailPid);
  });
  window.orkas.onPushEvent('preview-windows:owner-request', async request => {
    let result = { ok: false };
    try {
      if (request.kind === 'gallery') result = await readConversationPreviewImages(request.source.cid, request.before);
      else if (request.kind === 'artifact-submit') {
        await setView('conversation', request.source.cid);
        if (currentCid !== request.source.cid) throw new Error('conversation_unavailable');
        // Acknowledge admission; model completion can outlive this window.
        result = await new Promise((resolve, reject) => {
          sendInCurrentConversation(request.text, undefined, { onStarted: () => resolve({ ok: true }) })
            .then(outcome => resolve({ ok: !!outcome?.started }), reject);
        });
      }
    } catch (_) { /* The requesting preview owns recovery feedback. */ }
    await window.orkas.invoke('previewWindows.resolveOwner', { requestId: request.requestId, result });
  });
})();
