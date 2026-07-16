// Shared renderer policy for actions offered on produced/workspace files.
// Main-process handlers still validate every request; this module keeps the
// Files tab, produced-file footer, and preview header from advertising actions
// that the matching backend contract will reject.
(function initFileOperationPolicy(root) {
  const textExts = new Set([
    '.md', '.markdown', '.txt', '.csv', '.tsv', '.json', '.yaml', '.yml', '.log',
    '.html', '.htm', '.xml', '.toml', '.ini', '.conf',
    '.py', '.pyi', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.sh', '.bash', '.zsh', '.ps1', '.cmd', '.bat', '.rb', '.go', '.rs', '.java', '.kt',
    '.c', '.cpp', '.cc', '.h', '.hpp', '.css', '.scss', '.less',
    '.sql', '.graphql', '.gql',
  ]);
  const chatTextExts = new Set([
    '.md', '.markdown', '.txt', '.csv', '.tsv', '.json', '.yaml', '.yml', '.log',
  ]);
  const imageExts = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
  const videoExts = new Set(['.mp4', '.webm', '.mov', '.m4v', '.ogv']);
  const audioExts = new Set(['.mp3', '.wav', '.ogg', '.opus', '.m4a', '.aac', '.flac']);
  const officeExts = new Set(['.docx', '.docm', '.xlsx', '.xlsm', '.pptx', '.pptm']);
  const libraryExts = new Set([...textExts, ...imageExts, ...officeExts, '.pdf']);
  const chatExts = new Set([
    ...chatTextExts, ...imageExts, ...videoExts, ...audioExts, ...officeExts, '.pdf',
  ]);

  function extensionOf(name) {
    const base = String(name || '').split(/[\\/]/).pop() || '';
    const index = base.lastIndexOf('.');
    return index >= 0 ? base.slice(index).toLowerCase() : '';
  }

  function canAddToChat(name) {
    return chatExts.has(extensionOf(name));
  }

  function canAddToLibrary(name, options = {}) {
    const ext = extensionOf(name);
    return libraryExts.has(ext) || (options.projectScoped === true && videoExts.has(ext));
  }

  function canShare(name) {
    return textExts.has(extensionOf(name));
  }

  const policy = Object.freeze({ extensionOf, canAddToChat, canAddToLibrary, canShare });
  if (root) root.FileOperationPolicy = policy;
  if (typeof module !== 'undefined' && module.exports) module.exports = policy;
})(typeof window !== 'undefined' ? window : null);
