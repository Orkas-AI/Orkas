// Shared inline SVG icons for the PC renderer.
// Keep all reusable app icons here; call sites render by name instead of
// hardcoding SVG paths or using emoji.
(function () {
  const root = typeof window !== 'undefined' ? window : globalThis;

  const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'bmp', 'ico']);
  const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv', 'avi', 'mkv']);
  const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac']);
  const TEXT_EXTS = new Set(['md', 'markdown', 'txt', 'log', 'rst', 'tex']);
  const DATA_EXTS = new Set(['json', 'yaml', 'yml', 'toml', 'csv', 'tsv', 'xlsx', 'xls', 'xml', 'ini', 'conf']);
  const ARCHIVE_EXTS = new Set(['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar']);
  const CODE_EXTS = new Set([
    'py', 'pyi', 'ipynb',
    'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
    'html', 'htm', 'css', 'scss', 'sass', 'less',
    'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
    'rb', 'go', 'rs', 'java', 'kt', 'kts', 'scala',
    'c', 'cpp', 'cc', 'cxx', 'h', 'hpp', 'hxx',
    'php', 'swift', 'lua', 'pl', 'pm', 'r', 'dart',
    'sql', 'graphql', 'gql', 'proto',
  ]);

  function wrapUiIcon(name, inner, className) {
    const cls = `${className || 'ui-icon'} is-${name}`;
    return `<svg class="${cls}" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
  }

  function wrapFileIcon(kind, inner) {
    return `<svg class="chat-file-kind-icon is-${kind}" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
  }

  const UI_ICONS = {
    search: '<circle cx="11" cy="11" r="7"></circle><path d="m21 21-4.3-4.3"></path>',
    'message-square': '<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"></path>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M22 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path>',
    sparkles: '<path d="M12 3l1.4 3.6L17 8l-3.6 1.4L12 13l-1.4-3.6L7 8l3.6-1.4z"></path><path d="M19 13l.9 2.1L22 16l-2.1.9L19 19l-.9-2.1L16 16l2.1-.9z"></path><path d="M5 14l.8 1.7L7.5 16.5l-1.7.8L5 19l-.8-1.7-1.7-.8 1.7-.8z"></path>',
    plug: '<path d="M12 22v-5"></path><path d="M9 8V2"></path><path d="M15 8V2"></path><path d="M6 8h12v4a6 6 0 0 1-12 0z"></path>',
    'book-open': '<path d="M12 7v14"></path><path d="M3 5.5A3.5 3.5 0 0 1 6.5 2H12v19H6.5A3.5 3.5 0 0 1 3 17.5z"></path><path d="M21 5.5A3.5 3.5 0 0 0 17.5 2H12v19h5.5a3.5 3.5 0 0 0 3.5-3.5z"></path>',
    database: '<ellipse cx="12" cy="5" rx="8" ry="3"></ellipse><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"></path><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"></path>',
    'layout-grid': '<rect x="3" y="3" width="7" height="7" rx="1.5"></rect><rect x="14" y="3" width="7" height="7" rx="1.5"></rect><rect x="3" y="14" width="7" height="7" rx="1.5"></rect><rect x="14" y="14" width="7" height="7" rx="1.5"></rect>',
    settings: '<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3 1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8 1.7 1.7 0 0 0 1.5 1h.1a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"></path>',
    terminal: '<path d="m8 8 4 4-4 4"></path><path d="M14 16h4"></path><rect x="3" y="4" width="18" height="16" rx="3"></rect>',
    x: '<path d="M18 6 6 18M6 6l12 12"></path>',
    trash: '<path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 15H6L5 6"></path><path d="M10 11v6M14 11v6"></path>',
    pin: '<path d="M12 17v5"></path><path d="M5 17h14"></path><path d="M7 3h10l-1 8 3 6H5l3-6z"></path>',
    'pin-off': '<path d="M12 17v5"></path><path d="M5 17h12"></path><path d="M7 3h7"></path><path d="M16 11l3 6"></path><path d="M8 11l.6-4.8"></path><path d="M3 3l18 18"></path>',
    mic: '<path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z"></path><path d="M19 11a7 7 0 0 1-14 0"></path><path d="M12 18v3"></path><path d="M8 21h8"></path>',
    send: '<path d="M22 2 11 13"></path><path d="m22 2-7 20-4-9-9-4 20-7z"></path>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"></rect>',
    'chevron-down': '<path d="m6 9 6 6 6-6"></path>',
    'chevron-right': '<path d="m9 6 6 6-6 6"></path>',
    'chevron-left': '<path d="m15 6-6 6 6 6"></path>',
    plus: '<path d="M12 5v14M5 12h14"></path>',
    'file-text': '<path d="M7 3.5h7l4 4v13H7z"></path><path d="M14 3.5v4h4"></path><path d="M9.5 11h5"></path><path d="M9.5 14h5"></path><path d="M9.5 17h3"></path>',
    'arrow-right': '<path d="M5 12h14"></path><path d="m13 6 6 6-6 6"></path>',
    zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"></path>',
    external: '<path d="M14 4h6v6"></path><path d="M20 4 10 14"></path><path d="M19 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h6"></path>',
    'more-horizontal': '<circle cx="6" cy="12" r="1.4" fill="currentColor" stroke="none"></circle><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"></circle><circle cx="18" cy="12" r="1.4" fill="currentColor" stroke="none"></circle>',
    'panel-list': '<rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M15 4v16"></path><path d="M7 8h4"></path><path d="M7 12h4"></path><path d="M7 16h4"></path>',
    panel: '<rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M15 4v16"></path>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>',
    'folder-open': '<path d="M3 8V6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1"></path><path d="M3.2 10.5A2 2 0 0 1 5.1 9h14.2a1.5 1.5 0 0 1 1.4 1.9l-1.5 5.7A3 3 0 0 1 16.3 19H5.2a2 2 0 0 1-2-1.6L2 12.4a1.6 1.6 0 0 1 1.2-1.9z"></path>',
    file: '<path d="M7 3.5h7l4 4v13H7z"></path><path d="M14 3.5v4h4"></path>',
    'clipboard-list': '<rect x="4" y="4" width="16" height="18" rx="2"></rect><path d="M9 4h6M9 8h6M8 12h8M8 16h8M8 20h5"></path><path d="M9 2h6v4H9z"></path>',
    hourglass: '<path d="M7 3h10M7 21h10M8 3c0 5 8 5 8 9s-8 4-8 9M16 3c0 5-8 5-8 9s8 4 8 9"></path>',
    clock: '<circle cx="12" cy="12" r="9"></circle><polyline points="12 7 12 12 16 14"></polyline>',
    play: '<circle cx="12" cy="12" r="9"></circle><path d="M10 8l6 4-6 4z"></path>',
    'play-triangle': '<path d="M8 5v14l11-7z" fill="currentColor" stroke="none"></path>',
    check: '<path d="M5 12l4 4L19 6"></path>',
    'check-circle': '<circle cx="12" cy="12" r="9"></circle><path d="M8 12.5l2.6 2.6L16.5 9"></path>',
    'x-circle': '<circle cx="12" cy="12" r="9"></circle><path d="M9 9l6 6M15 9l-6 6"></path>',
    'skip-forward': '<path d="M5 7l6 5-6 5z"></path><path d="M13 7l6 5-6 5z"></path><path d="M21 6v12"></path>',
    'document-pencil': '<path d="M7 3.5h7l4 4v13H7z"></path><path d="M14 3.5v4h4"></path><path d="M9 17l1-3 5.5-5.5 2 2L12 16l-3 1z"></path>',
    'edit-pencil': '<path d="M4 20h4.2L19.1 9.1a2.2 2.2 0 0 0 0-3.1L18 4.9a2.2 2.2 0 0 0-3.1 0L4 15.8V20z"></path><path d="M13.7 6.1l4.2 4.2"></path><path d="M4 20l4.2-1.1"></path>',
    refresh: '<path d="M20 12a8 8 0 0 1-13.7 5.7"></path><path d="M4 12A8 8 0 0 1 17.7 6.3"></path><path d="M17 3v4h-4M7 21v-4h4"></path>',
    warning: '<path d="M12 3l10 18H2z"></path><path d="M12 9v5"></path><path d="M12 18h.01"></path>',
    square: '<rect x="5" y="5" width="14" height="14" rx="3"></rect>',
    eye: '<path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"></path><circle cx="12" cy="12" r="2.5"></circle>',
    command: '<path d="M9 9H6.5a3 3 0 1 1 3-3V18a3 3 0 1 1-3-3H18a3 3 0 1 1-3 3V6a3 3 0 1 1 3 3H9z"></path>',
    link: '<path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1"></path><path d="M14 11a5 5 0 0 0-7.1 0l-2 2a5 5 0 0 0 7.1 7.1l1.1-1.1"></path>',
    image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"></rect><circle cx="8.5" cy="9" r="1.6"></circle><path d="M5 17l4.4-4.4a1.5 1.5 0 0 1 2.1 0L14 15l2-2a1.5 1.5 0 0 1 2.1 0L20 14.9"></path>',
    list: '<path d="M9 6h11M9 12h11M9 18h11"></path><path d="M4 6h.01M4 12h.01M4 18h.01"></path>',
    'list-ordered': '<path d="M10 6h10M10 12h10M10 18h10"></path><path d="M4 5h1v3M4 8h2"></path><path d="M4 11.5h2L4 14h2"></path><path d="M4 17h2v3H4"></path>',
    quote: '<path d="M9 7H5v5h4v5H4"></path><path d="M20 7h-4v5h4v5h-5"></path>',
    code: '<path d="m9 8-4 4 4 4"></path><path d="m15 8 4 4-4 4"></path>',
    'code-block': '<path d="M8 9l-3 3 3 3"></path><path d="M16 9l3 3-3 3"></path><path d="M12 6l-2 12"></path><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"></rect>',
    circle: '<circle cx="12" cy="12" r="7"></circle>',
    squareFilled: '<rect x="6" y="6" width="12" height="12" rx="2"></rect>',
    diamond: '<path d="M12 4l8 8-8 8-8-8z"></path>',
    dot: '<circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"></circle>',
    output: '<path d="M5 7l6 5-6 5z"></path><path d="M13 7h6"></path><path d="M13 12h6"></path><path d="M13 17h6"></path>',
    info: '<circle cx="12" cy="12" r="9"></circle><path d="M12 11v5"></path><path d="M12 8h.01"></path>',
    paperclip: '<path d="M21 11.5 12.5 20a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 1 1-3-3L16 7"></path>',
    live: '<path d="M12 4a8 8 0 1 1-8 8"></path><path d="M12 4v8h8"></path>',
  };

  const FILE_ICONS = {
    image: wrapFileIcon('image', '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"></rect><circle cx="8.5" cy="9" r="1.6"></circle><path d="M5 17l4.4-4.4a1.5 1.5 0 0 1 2.1 0L14 15l2-2a1.5 1.5 0 0 1 2.1 0L20 14.9"></path>'),
    video: wrapFileIcon('video', '<rect x="3.5" y="5.5" width="17" height="13" rx="2.5"></rect><path d="M10 9.2v5.6l5-2.8-5-2.8z"></path>'),
    audio: wrapFileIcon('audio', '<path d="M9 18V6l9-2v12"></path><circle cx="6.5" cy="18" r="2.5"></circle><circle cx="15.5" cy="16" r="2.5"></circle>'),
    pdf: wrapFileIcon('pdf', '<path d="M7 3.5h7l4 4v13H7z"></path><path d="M14 3.5v4h4"></path><path d="M8.8 15.5h6.4"></path><path d="M9.8 12h4.4"></path>'),
    doc: wrapFileIcon('doc', '<path d="M7 3.5h7l4 4v13H7z"></path><path d="M14 3.5v4h4"></path><path d="M9.5 11h5"></path><path d="M9.5 14h5"></path><path d="M9.5 17h3.5"></path>'),
    text: wrapFileIcon('text', '<path d="M6.5 4.5h11v15h-11z"></path><path d="M9 9h6"></path><path d="M9 12h6"></path><path d="M9 15h4"></path>'),
    data: wrapFileIcon('data', '<rect x="4.5" y="5.5" width="15" height="13" rx="2"></rect><path d="M4.5 10h15"></path><path d="M9.5 5.5v13"></path><path d="M14.5 5.5v13"></path>'),
    archive: wrapFileIcon('archive', '<path d="M5 8.5 12 5l7 3.5-7 3.5L5 8.5z"></path><path d="M5 8.5v7L12 19l7-3.5v-7"></path><path d="M12 12v7"></path>'),
    code: wrapFileIcon('code', '<path d="m9 8-4 4 4 4"></path><path d="m15 8 4 4-4 4"></path><path d="m13 6-2 12"></path>'),
    file: wrapFileIcon('file', '<path d="M7 3.5h7l4 4v13H7z"></path><path d="M14 3.5v4h4"></path>'),
  };

  function extOf(name) {
    const base = String(name || '').split(/[\\/]/).pop() || '';
    const idx = base.lastIndexOf('.');
    return idx >= 0 ? base.slice(idx + 1).toLowerCase() : '';
  }

  function normalizeFileKind(kind, ext) {
    const raw = String(kind || '').toLowerCase();
    if (raw === 'docx' || raw === 'doc') return 'doc';
    if (raw === 'spreadsheet') return 'data';
    if (raw === 'binary') return 'file';
    if (['image', 'video', 'audio', 'pdf', 'doc', 'text', 'data', 'archive', 'code', 'file'].includes(raw)) return raw;
    if (IMAGE_EXTS.has(ext)) return 'image';
    if (VIDEO_EXTS.has(ext)) return 'video';
    if (AUDIO_EXTS.has(ext)) return 'audio';
    if (ext === 'pdf') return 'pdf';
    if (ext === 'docx' || ext === 'doc') return 'doc';
    if (TEXT_EXTS.has(ext)) return 'text';
    if (DATA_EXTS.has(ext)) return 'data';
    if (ARCHIVE_EXTS.has(ext)) return 'archive';
    if (CODE_EXTS.has(ext)) return 'code';
    return 'file';
  }

  function uiIconHtml(name, className) {
    const key = String(name || 'info');
    return wrapUiIcon(key, UI_ICONS[key] || UI_ICONS.info, className);
  }

  function fileKindForName(name, kind) {
    return normalizeFileKind(kind, extOf(name));
  }

  function fileKindIconHtml(name, kind) {
    const normalized = fileKindForName(name, kind);
    return FILE_ICONS[normalized] || FILE_ICONS.file;
  }

  function hydrateUiIcons(rootEl) {
    if (typeof document === 'undefined') return;
    const scope = rootEl || document;
    const nodes = scope.querySelectorAll ? scope.querySelectorAll('[data-ui-icon]') : [];
    nodes.forEach((node) => {
      const name = node.getAttribute('data-ui-icon');
      const className = node.getAttribute('data-ui-icon-class') || 'ui-icon';
      node.innerHTML = uiIconHtml(name, className);
      node.setAttribute('aria-hidden', 'true');
      // Wrapper must be a flex item so the inner SVG sits at the visual center
      // (not the text baseline) of its host — without this, every hydrated
      // icon drifts upward by descender space.
      node.style.display = 'inline-flex';
      node.style.alignItems = 'center';
    });
  }

  root.uiIconHtml = uiIconHtml;
  root.hydrateUiIcons = hydrateUiIcons;
  root.fileKindForName = fileKindForName;
  root.fileKindIconHtml = fileKindIconHtml;

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => hydrateUiIcons(), { once: true });
    } else {
      hydrateUiIcons();
    }
  }
})();
