// Minimal trusted renderer for native previews. No main-page boot, account
// navigation, conversation polling or task execution is mounted here.
let currentCid = null;
let currentView = 'preview';
let conversations = [];
const _convLog = createLogger('preview-host');

(function () {
  'use strict';
  let closing = false;
  let replacing = false;
  let refreshTimer = null;
  let projectScoped = false;
  async function close() {
    if (closing) return;
    closing = true;
    await window.orkas.invoke('previewWindows.close');
  }
  async function requestClose() {
    if (!(await _confirmDiscardViewerEdits())) return;
    await close();
  }
  function merge(gallery, items, prepend) {
    const seen = new Set(gallery.items.map(item => item.key));
    let fresh = [];
    let anchored = false;
    // The first refresh can include older images than the ten-row transcript
    // snapshot. Insert before shared anchors instead of appending those images.
    for (const item of items) {
      if (seen.has(item.key)) {
        const index = gallery.items.findIndex(existing => existing.key === item.key);
        gallery.items.splice(index, 0, ...fresh);
        fresh = [];
        anchored = true;
      } else { seen.add(item.key); fresh.push(item); }
    }
    if (prepend && !anchored) gallery.items.unshift(...fresh);
    else gallery.items.push(...fresh);
    _updateLightboxNavigation();
  }
  async function loadGalleryPage(gallery, before) {
    const response = await window.orkas.invoke('previewWindows.requestOwner', { kind: 'gallery', before });
    if (!response?.ok || !Array.isArray(response.items)) return;
    merge(gallery, response.items, before != null);
    if (before != null) gallery.nextCursor = response.nextCursor;
  }
  window.OrkasPreviewHost = { close, loadGalleryPage, projectScopedFor: cid => !!cid && cid === currentCid && projectScoped,
    setDirty: dirty => window.orkas.invoke('previewWindows.setDirty', { dirty }).catch(() => {}),
    filesChanged: () => window.orkas.invoke('previewWindows.report', { kind: 'files-changed' }).catch(() => {}) };
  window.orkas.onPushEvent('preview-windows:close-request', requestClose);
  window.orkas.onPushEvent('preview-windows:replace-request', async () => {
    if (replacing || closing) return;
    replacing = true;
    try {
      const accepted = await _confirmDiscardViewerEdits();
      await window.orkas.invoke('previewWindows.replace', { accepted });
    } finally { replacing = false; }
  });
  window.orkas.onPushEvent('preview-windows:gallery-refresh', () => {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      if (_lightboxGallery?.items) void loadGalleryPage(_lightboxGallery, null).catch(() => {});
    }, 250);
  });
  window.addEventListener('focus', () => { void refreshLangFromMain(); });
  window.sendInCurrentConversation = async text => {
    const result = await window.orkas.invoke('previewWindows.requestOwner', { kind: 'artifact-submit', text });
    if (!result?.ok) await uiAlert(t('artifact.open_failed'));
  };
  function setupVideoToolbar() {
    const viewer = document.querySelector('.chat-file-viewer');
    const video = viewer?.querySelector('video');
    if (!video) return;
    let idleTimer;
    const wake = () => {
      clearTimeout(idleTimer);
      viewer.classList.remove('is-video-idle');
      if (!video.paused && !video.ended) {
        idleTimer = setTimeout(() => viewer.classList.add('is-video-idle'), 2000);
      }
    };
    for (const event of ['pointermove', 'pointerdown', 'focusin', 'focusout']) viewer.addEventListener(event, wake);
    for (const event of ['play', 'pause', 'ended', 'error']) video.addEventListener(event, wake);
    window.addEventListener('pagehide', () => clearTimeout(idleTimer), { once: true });
    wake();
  }
  async function initialize() {
    await initI18n();
    const result = await window.orkas.invoke('previewWindows.initialize');
    if (!result?.ok || !result.source) throw new Error('preview_unavailable');
    const s = result.source;
    currentCid = s.options?.cid || s.cid || null;
    projectScoped = !!s.options?.projectScoped;
    document.title = s.title || 'Orkas';
    document.getElementById('preview-loading').hidden = true;
    if (s.kind === 'image') {
      const gallery = s.gallery ? { ...s.gallery, selectedKey: s.gallery.items[s.gallery.index]?.key, src: s.src, busy: false } : null;
      openChatImageLightbox(s.src, s.title, { ...s.options, gallery });
      if (gallery) void loadGalleryPage(gallery, null).catch(() => {});
    } else if (s.kind === 'file') {
      await openChatFileViewer(s.path, s.title, s.options);
      if (!_isViewerOpen() && !_isOpen()) { await close(); return; }
    }
    else if (s.kind === 'video') await openChatVideoUrlViewer(s.src, s.title, s.options);
    else if (s.kind === 'app') {
      const info = await window.orkas.invoke('savedApps.openInApp', { appId: s.appId });
      if (!info?.ok || !info.url) throw new Error('application_unavailable');
      window.openSavedAppPreview(info, s.title);
    } else if (s.kind === 'artifact') window.openChatArtifactViewer(s);
    setupVideoToolbar();
    await window.orkas.invoke('previewWindows.ready');
  }
  initialize().catch(async () => {
    document.getElementById('preview-loading').hidden = true;
    await uiAlert(t('chat.preview_window_failed'));
    await close();
  });
})();
