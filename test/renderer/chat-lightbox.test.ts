import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

function loadLightbox() {
  const source = fs.readFileSync(
    path.join(__dirname, '../../src/renderer/modules/chat-lightbox.js'),
    'utf8',
  );
  const context: any = {
    URL,
    clearTimeout,
    setTimeout,
    document: {
      addEventListener: vi.fn(),
    },
    window: {
      addEventListener: vi.fn(),
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'chat-lightbox.js' });
  return context;
}

describe('chat image lightbox file ownership', () => {
  it('decodes only local chat-media paths on Unix and Windows', () => {
    const context = loadLightbox();

    expect(context._absPathFromChatMediaLocalUrl(
      'chat-media://local/Users/test/My%20Image.png',
    )).toBe('/Users/test/My Image.png');
    expect(context._absPathFromChatMediaLocalUrl(
      'chat-media://local/C:/Users/test/My%20Image.png',
    )).toBe('C:/Users/test/My Image.png');
    expect(context._absPathFromChatMediaLocalUrl('https://example.com/image.png')).toBe('');
  });

  it('fails closed for malformed percent encoding instead of breaking image preview', () => {
    const context = loadLightbox();

    expect(() => context._absPathFromChatMediaLocalUrl(
      'chat-media://local/Users/test/%E0%A4%A.png',
    )).not.toThrow();
    expect(context._absPathFromChatMediaLocalUrl(
      'chat-media://local/Users/test/%E0%A4%A.png',
    )).toBe('');
  });

  it('offers Library import only for owned, supported image files', () => {
    const context = loadLightbox();

    expect(context._lightboxCanAddToLibrary({
      absPath: '/tmp/PREVIEW.JPEG',
      cid: 'conversation-a',
    })).toBe(true);
    expect(context._lightboxCanAddToLibrary({
      absPath: '/tmp/vector.svg',
      cid: 'conversation-a',
    })).toBe(false);
    expect(context._lightboxCanAddToLibrary({
      absPath: '/tmp/orphan.png',
      cid: '',
    })).toBe(false);
  });
});
