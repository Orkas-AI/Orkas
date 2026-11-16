import { describe, expect, it } from 'vitest';
import { armWebAssistMediaCapture, mediaTotalBytes } from '../../../src/main/features/web_assist_media_capture';

// The capture hangs on the task browser session's single onResponseStarted slot
// only while a save needs it. The session is a stand-in that records that slot.
function fakeSession() {
  const slot: { listener: ((details: any) => void) | null; registrations: number; clears: number } = { listener: null, registrations: 0, clears: 0 };
  const ses = {
    webRequest: {
      onResponseStarted(filterOrListener: unknown, maybeListener?: (details: any) => void) {
        if (filterOrListener === null) { slot.listener = null; slot.clears += 1; return; }
        slot.listener = maybeListener ?? filterOrListener as (details: any) => void;
        slot.registrations += 1;
      },
    },
  };
  const respond = (details: Partial<{ url: string; webContentsId: number; statusCode: number; responseHeaders: Record<string, string[]> }>) =>
    slot.listener?.({ url: 'https://cdn.test/a', webContentsId: 7, statusCode: 206, responseHeaders: {}, ...details });
  return { ses: ses as any, slot, respond };
}

describe('task browser media capture', () => {
  it('records only the video and audio files a page received, per page, with how often it asked', () => {
    const { ses, respond } = fakeSession();
    const capture = armWebAssistMediaCapture(ses);
    respond({ url: 'https://cdn.test/v', responseHeaders: { 'Content-Type': ['video/mp4'], 'Content-Range': ['bytes 0-99/5000'] } });
    respond({ url: 'https://cdn.test/v', responseHeaders: { 'content-type': ['video/mp4'], 'content-range': ['bytes 100-199/5000'] } });
    respond({ url: 'https://cdn.test/a', responseHeaders: { 'content-type': ['audio/mp4; codecs="mp4a.40.2"'] }, statusCode: 200 });
    respond({ url: 'https://cdn.test/page.js', responseHeaders: { 'content-type': ['text/javascript'] } });
    respond({ url: 'https://cdn.test/denied', responseHeaders: { 'content-type': ['video/mp4'] }, statusCode: 403 });
    respond({ url: 'https://cdn.test/other', webContentsId: 8, responseHeaders: { 'content-type': ['video/webm'], 'content-length': ['42'] }, statusCode: 200 });
    expect(capture.media(7)).toEqual([
      { url: 'https://cdn.test/v', contentType: 'video/mp4', totalBytes: 5000, hits: 2 },
      { url: 'https://cdn.test/a', contentType: 'audio/mp4', totalBytes: null, hits: 1 },
    ]);
    expect(capture.media(8)).toEqual([{ url: 'https://cdn.test/other', contentType: 'video/webm', totalBytes: 42, hits: 1 }]);
    capture.release();
  });

  it('holds the session slot while any save needs it and clears it, with what it saw, after the last', () => {
    const { ses, slot, respond } = fakeSession();
    const first = armWebAssistMediaCapture(ses);
    const second = armWebAssistMediaCapture(ses);
    expect(slot.registrations).toBe(1);
    respond({ responseHeaders: { 'content-type': ['video/mp4'] } });
    first.release();
    first.release();
    expect(slot.clears).toBe(0);
    expect(second.media(7)).toHaveLength(1);
    second.release();
    expect(slot).toMatchObject({ listener: null, clears: 1 });
    const again = armWebAssistMediaCapture(ses);
    expect(slot.registrations).toBe(2);
    expect(again.media(7)).toEqual([]);
    again.release();
  });

  it('stops growing at its page and file caps', () => {
    const { ses, respond } = fakeSession();
    const capture = armWebAssistMediaCapture(ses);
    for (let i = 0; i < 40; i += 1) respond({ url: `https://cdn.test/${i}`, responseHeaders: { 'content-type': ['video/mp4'] } });
    expect(capture.media(7)).toHaveLength(32);
    for (let page = 100; page < 120; page += 1) respond({ webContentsId: page, responseHeaders: { 'content-type': ['video/mp4'] } });
    expect(capture.media(114)).toHaveLength(1);
    expect(capture.media(115)).toEqual([]);
    capture.release();
  });

  it('reads the whole file size from a range or a complete response only', () => {
    expect(mediaTotalBytes(206, 'bytes 1761561-2257609/7133100', '496049')).toBe(7133100);
    expect(mediaTotalBytes(206, 'bytes 0-99/*', '100')).toBeNull();
    expect(mediaTotalBytes(200, '', '2048')).toBe(2048);
    expect(mediaTotalBytes(206, '', '2048')).toBeNull();
    expect(mediaTotalBytes(200, '', 'abc')).toBeNull();
  });
});
