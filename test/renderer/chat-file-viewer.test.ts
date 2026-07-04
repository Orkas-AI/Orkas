// Lock in the kind-classifier behaviour of chat-file-viewer.js. The viewer
// dispatches by `_kindOf(name)` — every misclassification surfaces as
// "I clicked a .md but it tried to load in an iframe" or vice versa, which
// is hard to spot in code review. This is the multi-branch decision
// function category from PC/CLAUDE.md §9.

import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const viewer = require('../../src/renderer/modules/chat-file-viewer.js');
const { _kindOf, _extOf, _chatMediaLocalUrl, _viewerAbsPathFromChatMediaLocalUrl, _viewerCanAddToLibrary, _viewerVideoPlaybackOptions } = viewer as {
  _kindOf: (name: string) => string;
  _extOf: (name: string) => string;
  _chatMediaLocalUrl: (abs: string) => string;
  _viewerAbsPathFromChatMediaLocalUrl: (src: string) => string;
  _viewerCanAddToLibrary: (nameOrKind: string) => boolean;
  _viewerVideoPlaybackOptions: (opts?: { autoplay?: boolean; startTime?: number }) => { autoplay: boolean; startTime: number };
};

describe('chat-file-viewer › _kindOf', () => {
  // Set A — known kinds. One representative per ext set; the lists in the
  // module are the contract, so coverage of one ext per kind is enough
  // (the Set membership check makes per-ext coverage redundant).
  it.each([
    ['photo.png', 'image'],
    ['art.jpg', 'image'],
    ['art.jpeg', 'image'],
    ['art.webp', 'image'],
    ['art.gif', 'image'],
    ['report.pdf', 'pdf'],
    ['doc.docx', 'office'],
    ['macro.docm', 'office'],
    ['workbook.xlsx', 'office'],
    ['sheet.xlsm', 'office'],
    ['slides.pptx', 'office'],
    ['deck.pptm', 'office'],
    ['page.html', 'html'],
    ['old.htm', 'html'],
    ['note.md', 'markdown'],
    ['old.markdown', 'markdown'],
    ['plain.txt', 'text'],
    ['data.json', 'text'],
    ['table.csv', 'text'],
    ['script.py', 'text'],
    ['app.ts', 'text'],
    ['style.css', 'text'],
    ['log.log', 'text'],
    ['video.mp4', 'video'],
    ['voice.mp3', 'audio'],
  ])('classifies "%s" as %s', (name, kind) => {
    expect(_kindOf(name)).toBe(kind);
  });

  // Set B — unsupported / look-alike shapes. These specifically check
  // that the classifier doesn't promote "looks like text" → text or
  // "html-ish" → html when the actual ext doesn't match.
  it.each([
    ['archive.zip', 'unsupported'],
    ['legacy.doc', 'unsupported'],
    ['legacy.xls', 'unsupported'],
    ['legacy.ppt', 'unsupported'],
    ['binary.exe', 'unsupported'],
    ['photo.heic', 'unsupported'], // image-ish but not in the allow-list
    ['no-extension', 'unsupported'],
    ['', 'unsupported'],
    ['file.', 'unsupported'],
    ['file.UPPER', 'unsupported'],
  ])('refuses "%s" → fallback dialog', (name, kind) => {
    expect(_kindOf(name)).toBe(kind);
  });

  it('is case-insensitive on the extension portion', () => {
    expect(_kindOf('REPORT.PDF')).toBe('pdf');
    expect(_kindOf('REPORT.XLSX')).toBe('office');
    expect(_kindOf('Note.MD')).toBe('markdown');
    expect(_kindOf('Page.Html')).toBe('html');
    expect(_kindOf('Voice.MP3')).toBe('audio');
  });

  it('handles paths with directories — only the basename ext matters', () => {
    expect(_kindOf('/Users/test/Documents/note.md')).toBe('markdown');
    expect(_kindOf('C:\\\\work\\\\report.pdf')).toBe('pdf');
  });
});

describe('chat-file-viewer › _extOf', () => {
  it('returns lowercased trailing extension', () => {
    expect(_extOf('note.MD')).toBe('.md');
    expect(_extOf('report.pdf')).toBe('.pdf');
  });
  it('returns "" for names with no dot', () => {
    expect(_extOf('README')).toBe('');
  });
  it('uses the LAST dot, not the first', () => {
    expect(_extOf('a.b.tar.gz')).toBe('.gz');
  });
});

describe('chat-file-viewer › _chatMediaLocalUrl', () => {
  // The URL has to round-trip cleanly through new URL() + the main-side
  // `_pathnameToAbsPath`, so it must encode spaces / non-ASCII but
  // preserve `/` separators. encodeURI does both.
  it('builds chat-media://local/ + path for a unix abs path', () => {
    expect(_chatMediaLocalUrl('/Users/test/file.pdf')).toBe('chat-media://local/Users/test/file.pdf');
  });
  it('URL-encodes spaces in the path', () => {
    expect(_chatMediaLocalUrl('/Users/test/has space.pdf')).toBe('chat-media://local/Users/test/has%20space.pdf');
  });
  it('preserves "/" separators (doesn\'t use encodeURIComponent)', () => {
    const url = _chatMediaLocalUrl('/a/b/c/d.pdf');
    expect(url).not.toContain('%2F');
    expect(url).toContain('/a/b/c/d.pdf');
  });
  it('converts Windows-style "\\\\" to "/" so URL parsing stays well-formed', () => {
    expect(_chatMediaLocalUrl('C:\\Users\\test\\file.pdf')).toBe('chat-media://local/C:/Users/test/file.pdf');
  });
});

describe('chat-file-viewer › _viewerAbsPathFromChatMediaLocalUrl', () => {
  it('decodes local chat-media video URLs for file-backed preview actions', () => {
    expect(_viewerAbsPathFromChatMediaLocalUrl('chat-media://local/Users/test/has%20space.mp4')).toBe('/Users/test/has space.mp4');
    expect(_viewerAbsPathFromChatMediaLocalUrl('chat-media://local/C:/Users/test/clip.mp4')).toBe('C:/Users/test/clip.mp4');
  });

  it('refuses non-local media URLs', () => {
    expect(_viewerAbsPathFromChatMediaLocalUrl('chat-media://cid/main/clip.mp4')).toBe('');
    expect(_viewerAbsPathFromChatMediaLocalUrl('https://example.test/clip.mp4')).toBe('');
  });
});

describe('chat-file-viewer › _viewerCanAddToLibrary', () => {
  it('offers Add to Library only for Library-supported file extensions', () => {
    expect(_viewerCanAddToLibrary('/tmp/report.pdf')).toBe(true);
    expect(_viewerCanAddToLibrary('/tmp/scores.xlsx')).toBe(true);
    expect(_viewerCanAddToLibrary('/tmp/slides.pptx')).toBe(true);
    expect(_viewerCanAddToLibrary('/tmp/note.md')).toBe(true);
    expect(_viewerCanAddToLibrary('/tmp/page.html')).toBe(true);
    expect(_viewerCanAddToLibrary('/tmp/photo.png')).toBe(true);
    expect(_viewerCanAddToLibrary('/tmp/movie.mp4')).toBe(false);
    expect(_viewerCanAddToLibrary('/tmp/archive.zip')).toBe(false);
    expect(_viewerCanAddToLibrary('/tmp/no-extension')).toBe(false);
  });
});

describe('chat-file-viewer › _viewerVideoPlaybackOptions', () => {
  it('keeps explicit autoplay and a positive start time', () => {
    expect(_viewerVideoPlaybackOptions({ autoplay: true, startTime: 12.5 })).toEqual({ autoplay: true, startTime: 12.5 });
  });

  it('normalizes missing or invalid playback options', () => {
    expect(_viewerVideoPlaybackOptions()).toEqual({ autoplay: false, startTime: 0 });
    expect(_viewerVideoPlaybackOptions({ autoplay: false, startTime: -1 })).toEqual({ autoplay: false, startTime: 0 });
  });
});
