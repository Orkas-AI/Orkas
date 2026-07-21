import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  chatMediaLocalPathFromUrl,
  chatMediaLocalUrl,
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

      expect(oldUrl).toMatch(/\?v=\d+-3$/);
      expect(newUrl).toMatch(/\?v=\d+-17$/);
      expect(newUrl).not.toBe(oldUrl);
      expect(path.normalize(chatMediaLocalPathFromUrl(newUrl, process.platform))).toBe(path.normalize(file));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
