/**
 * Response headers of the video and audio files task-browser pages load, kept
 * only while a reference save needs them (web_assist_page_video). A stream
 * player shows a blob: address, so the files behind it are known only from the
 * responses the page received. Addresses stay in memory and are dropped when the
 * last save releases the capture; nothing is logged.
 */
import type { Session } from 'electron';
import type { PageMediaResponse } from './web_assist_page_video';

const MAX_PAGES = 16;
const MAX_FILES_PER_PAGE = 32;

type Capture = { users: number; pages: Map<number, Map<string, PageMediaResponse>> };
const captures = new WeakMap<Session, Capture>();

function header(headers: Record<string, string | string[]> | undefined, name: string): string {
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === name) return String(Array.isArray(value) ? value[0] ?? '' : value);
  }
  return '';
}

/** The whole file's size: a range response names it after the slash. */
export function mediaTotalBytes(status: number, contentRange: string, contentLength: string): number | null {
  const total = /\/(\d+)\s*$/.exec(contentRange)?.[1];
  if (total) return Number(total);
  return status === 200 && /^\d+$/.test(contentLength.trim()) ? Number(contentLength.trim()) : null;
}

export function armWebAssistMediaCapture(ses: Session): { media(webContentsId: number): PageMediaResponse[]; release(): void } {
  let capture = captures.get(ses);
  if (!capture) {
    capture = { users: 0, pages: new Map() };
    captures.set(ses, capture);
  }
  const current = capture;
  if (current.users === 0) {
    // An observer: it never holds a request, and it is the only one on this session.
    ses.webRequest.onResponseStarted({ urls: ['http://*/*', 'https://*/*'] }, (details) => {
      const type = header(details.responseHeaders, 'content-type').split(';')[0].trim().toLowerCase();
      if (!/^(video|audio)\//.test(type) || typeof details.webContentsId !== 'number') return;
      if (details.statusCode !== 200 && details.statusCode !== 206) return;
      let page = current.pages.get(details.webContentsId);
      if (!page) {
        if (current.pages.size >= MAX_PAGES) return;
        page = new Map();
        current.pages.set(details.webContentsId, page);
      }
      const known = page.get(details.url);
      if (known) { known.hits += 1; return; }
      if (page.size >= MAX_FILES_PER_PAGE) return;
      page.set(details.url, {
        url: details.url,
        contentType: type,
        totalBytes: mediaTotalBytes(details.statusCode, header(details.responseHeaders, 'content-range'), header(details.responseHeaders, 'content-length')),
        hits: 1,
      });
    });
  }
  current.users += 1;
  let released = false;
  return {
    media: (webContentsId) => [...(current.pages.get(webContentsId)?.values() ?? [])].map(item => ({ ...item })),
    release: () => {
      if (released) return;
      released = true;
      current.users -= 1;
      if (current.users > 0) return;
      ses.webRequest.onResponseStarted(null);
      current.pages.clear();
    },
  };
}
