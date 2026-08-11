import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  chatMediaLocalPathFromUrl,
  unresolvedChatMediaLocalUrls,
  chatMediaLocalUrl,
  versionChatMediaLocalUrlsInText,
  versionedChatMediaLocalUrl,
} from '../../../src/main/util/chat-media-url';

describe('util/chat-media-url', () => {
  it('encodes every filename segment without encoding path separators', () => {
    expect(chatMediaLocalUrl('/Users/user/frames/hero #1?.png')).toBe(
      'chat-media://local/Users/user/frames/hero%20%231%3F.png',
    );
    expect(chatMediaLocalUrl('/Users/user/100%/中文 图.png')).toBe(
      'chat-media://local/Users/user/100%25/%E4%B8%AD%E6%96%87%20%E5%9B%BE.png',
    );
  });

  it('normalizes Windows separators while preserving the drive prefix', () => {
    expect(chatMediaLocalUrl('C:\\Users\\user\\frame #1.png')).toBe(
      'chat-media://local/C:/Users/user/frame%20%231.png',
    );
  });

  it('escapes Markdown delimiter characters inside path segments', () => {
    expect(chatMediaLocalUrl('/Users/user/final (approved)!*.png')).toBe(
      'chat-media://local/Users/user/final%20%28approved%29%21%2A.png',
    );
  });

  it('decodes only local media URLs without exposing attachment routes', () => {
    expect(chatMediaLocalPathFromUrl(
      'chat-media://local/Users/user/hero%20%231%3F.png',
      'darwin',
    )).toBe('/Users/user/hero #1?.png');
    expect(chatMediaLocalPathFromUrl(
      'chat-media://local/C:/Users/user/frame.png',
      'win32',
    )).toBe('C:/Users/user/frame.png');
    expect(chatMediaLocalPathFromUrl('chat-media://cid/c1/frame.png')).toBe('');
  });

  it('changes generated-media URLs when the file at the same path changes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-chat-media-version-'));
    const file = path.join(dir, 'preview.png');
    try {
      fs.writeFileSync(file, 'old');
      const oldUrl = versionedChatMediaLocalUrl(file);
      fs.writeFileSync(file, 'new-preview-bytes');
      const newUrl = versionedChatMediaLocalUrl(file);

      expect(oldUrl).toMatch(/\?v=\d+-\d+-3$/);
      expect(newUrl).toMatch(/\?v=\d+-\d+-17$/);
      expect(newUrl).not.toBe(oldUrl);
      expect(path.normalize(chatMediaLocalPathFromUrl(newUrl, process.platform))).toBe(path.normalize(file));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('versions unversioned local URLs embedded in Markdown', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-chat-media-text-'));
    const file = path.join(dir, 'poster.png');
    try {
      fs.writeFileSync(file, 'poster');
      const base = chatMediaLocalUrl(file);
      const normalized = versionChatMediaLocalUrlsInText(`Here: ![poster](${base}).`);

      expect(normalized).toMatch(/!\[poster\]\(chat-media:\/\/local\/.+\?v=\d+-\d+-6\)\.$/);
      expect(normalized).not.toContain(`(${base})`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refreshes an older version while preserving other query parameters and fragments', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-chat-media-refresh-'));
    const file = path.join(dir, 'poster.png');
    try {
      fs.writeFileSync(file, 'new-poster');
      const base = chatMediaLocalUrl(file);
      const normalized = versionChatMediaLocalUrlsInText(
        `[poster](${base}?download=1&v=old#preview)`,
      );

      expect(normalized).toContain('download=1');
      expect(normalized).toMatch(/v=\d+-\d+-10/);
      expect(normalized).toContain('#preview');
      expect(normalized).not.toContain('v=old');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves missing local files and non-local media URLs unchanged', () => {
    const missing = chatMediaLocalUrl(path.join(os.tmpdir(), 'orkas-missing-poster.png'));
    const text = `${missing} chat-media://cid/c1/poster.png https://example.test/poster.png`;
    expect(versionChatMediaLocalUrlsInText(text)).toBe(text);
  });
});

describe('unresolvedChatMediaLocalUrls', () => {
  it('reports links whose file does not exist and stays silent on ones that do', () => {
    // 2026-08-07: a run closed with `<agent-result status="success" />`, a
    // 成片确认, and a [video](chat-media://local/…/orkas-promo-v1.mp4) link.
    // That turn made no tool calls at all and the file never existed; the host
    // resolved the same link ~300ms later and logged not_found. Every fact
    // needed to catch it was already in its hands.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-unresolved-media-'));
    try {
      const real = path.join(dir, 'draft.mp4');
      fs.writeFileSync(real, 'x'.repeat(10));
      const missing = path.join(dir, 'orkas-promo-v1.mp4');

      const fabricated = `[video](${chatMediaLocalUrl(missing)}?v=1786100441742726914)`;
      expect(unresolvedChatMediaLocalUrls(fabricated)).toHaveLength(1);
      expect(unresolvedChatMediaLocalUrls(fabricated)[0]).toContain('orkas-promo-v1.mp4');

      // Negative control 1: a real produced file must never be reported —
      // every delivery in a healthy run links one of these.
      expect(unresolvedChatMediaLocalUrls(`![draft](${chatMediaLocalUrl(real)})`)).toEqual([]);
      expect(unresolvedChatMediaLocalUrls(`![draft](${versionedChatMediaLocalUrl(real)})`)).toEqual([]);

      // Negative control 2: the Markdown closing paren is not part of the
      // path. Peeling has to match the versioner's, or a checker with its own
      // rules reports links the versioner already resolved.
      expect(unresolvedChatMediaLocalUrls(`see [it](${chatMediaLocalUrl(real)}).`)).toEqual([]);
      expect(unresolvedChatMediaLocalUrls(`试听旁白：![audio](${chatMediaLocalUrl(real)})。`)).toEqual([]);
      expect(unresolvedChatMediaLocalUrls(`试听旁白：![audio](${chatMediaLocalUrl(real)})，继续。`)).toEqual([]);
      expect(unresolvedChatMediaLocalUrls(`试听旁白：![audio](${chatMediaLocalUrl(real)})！`)).toEqual([]);

      // Negative control 3: other media routes are not this check's business.
      expect(unresolvedChatMediaLocalUrls(
        'chat-media://cid/c1/poster.png https://example.test/poster.png',
      )).toEqual([]);

      // Negative control 4: prose with no media links at all.
      expect(unresolvedChatMediaLocalUrls('成片确认：60 秒宣传视频已完成渲染。')).toEqual([]);

      // One report per distinct target, however many times it is linked.
      const twice = `${chatMediaLocalUrl(missing)} and again ${chatMediaLocalUrl(missing)}`;
      expect(unresolvedChatMediaLocalUrls(twice)).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
