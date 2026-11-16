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

function mountedLightbox() {
  const context = loadLightbox();
  context.t = (key: string) => key;
  context.document.removeEventListener = vi.fn();
  const elements = new Map<string, any>();
  const element = (key: string) => {
    if (!elements.has(key)) {
      const classes = new Set<string>();
      elements.set(key, { style: {}, hidden: false,
        classList: { contains: (name: string) => classes.has(name),
          add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name), toggle: vi.fn() },
        setAttribute: vi.fn(), removeAttribute: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), focus: vi.fn() });
    }
    return elements.get(key);
  };
  context.element = element;
  vm.runInContext(`
    _lightboxEl = element('root'); _lightboxEl.querySelector = element;
    _lightboxImg = element('image');
    _lightboxAddLibraryBtn = element('library'); _lightboxRevealBtn = element('reveal');
  `, context);
  const visibility = () => ['library', 'reveal'].map(key => !element(key).hidden);
  return { context, element, visibility };
}

describe('attachment image action recovery', () => {
  it('resolves the image owner on first open and reveals the resolved file', async () => {
    const { context, visibility } = mountedLightbox();
    const invoke = vi.fn(async () => ({ ok: true, path: '/fixtures/cover art.png' }));
    context.window.orkas = { invoke };
    context.openChatImageLightbox('chat-media://cid/source-chat/cover%20art.png', 'generated image', { cid: 'current-chat' });
    await vi.waitFor(() => expect(visibility()).toEqual([true, true]));
    expect(invoke).toHaveBeenCalledExactlyOnceWith('attachments.absPath', { cid: 'source-chat', name: 'cover art.png' });
    await context._onLightboxReveal({ stopPropagation: vi.fn() });
    expect(invoke).toHaveBeenLastCalledWith('workspace.revealPath', { path: '/fixtures/cover art.png', cid: 'source-chat' });
  });

  it.each(['replace', 'close'])('ignores resolution after %s and never transfers file ownership', async (action) => {
    const { context, visibility } = mountedLightbox();
    let finish!: (value: any) => void;
    context.window.orkas = { invoke: vi.fn(() => new Promise(resolve => { finish = resolve; })) };
    context.openChatImageLightbox('chat-media://cid/old/old.png', 'old');
    expect(context.window.orkas.invoke).toHaveBeenCalledOnce();
    if (action === 'close') context.closeChatImageLightbox();
    else context.openChatImageLightbox('https://example.com/new.png', 'new');
    finish({ ok: true, path: '/fixtures/old.png' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(visibility()).toEqual([false, false]);
    await context._onLightboxReveal({ stopPropagation: vi.fn() });
    expect(context.window.orkas.invoke).toHaveBeenCalledTimes(1);
  });

  it('keeps the image open on lookup failure and retries when reopened', async () => {
    const { context, visibility, element } = mountedLightbox();
    context.window.orkas = { invoke: vi.fn().mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true, path: '/fixtures/retry.png' }) };
    for (let attempt = 0; attempt < 3; attempt++) {
      context.openChatImageLightbox('chat-media://cid/task/retry.png', 'retry');
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(visibility()).toEqual(Array(2).fill(attempt === 2));
      expect(element('image').src).toBe('chat-media://cid/task/retry.png');
      expect(context._isOpen()).toBe(true);
    }
    expect(context.window.orkas.invoke).toHaveBeenCalledTimes(3);
  });

  it('does not resolve remote, malformed, or already-owned image sources', () => {
    const { context, visibility } = mountedLightbox();
    context.window.orkas = { invoke: vi.fn() };
    for (const src of ['https://example.com/cover.png', 'chat-media://cid/task/%E0%A4%A.png',
      'chat-media://cid/task/folder%2Fcover.png', 'chat-media://cid/task/']) {
      context.openChatImageLightbox(src, 'image');
      expect(visibility()).toEqual([false, false]);
    }
    context.openChatImageLightbox('chat-media://cid/task/cover.png', 'image', { absPath: '/fixtures/cover.png', cid: 'task' });
    expect(visibility()).toEqual([true, true]);
    context.openChatImageLightbox('chat-media://local/fixtures/cover.png', 'image', { cid: 'task' });
    expect(visibility()).toEqual([true, true]);
    expect(context.window.orkas.invoke).not.toHaveBeenCalled();
  });
});

describe('chat image lightbox file ownership', () => {
  it('labels zoom controls in every registered product locale without fallback', () => {
    const renderer = path.join(__dirname, '../../src/renderer');
    const supported = vm.runInNewContext(fs.readFileSync(path.join(renderer, 'modules/i18n.js'), 'utf8')
      + '; getSupportedLanguages()', { createLogger: () => ({ warn() {} }), window: {} }) as Array<{ code: string }>;
    expect(supported.length).toBeGreaterThan(0);
    for (const { code } of supported) {
      const table = JSON.parse(fs.readFileSync(path.join(renderer, `locales/${code}.json`), 'utf8'));
      for (const action of ['in', 'out', 'reset']) {
        const key = `chat.lightbox_zoom_${action}`;
        expect(typeof table[key], `${code}: ${key}`).toBe('string');
        expect(table[key].trim(), `${code}: ${key}`).not.toBe('');
        expect(table[key], code).not.toBe(key);
      }
    }
  });

  it('forwards an outside image path when the user clicks reveal and re-enables the button', async () => {
    const context = loadLightbox();
    const invoke = vi.fn(async () => ({ ok: true }));
    context.window.orkas = { invoke };
    vm.runInContext(`
      _lightboxCurrentFile = { absPath: '/external project/封面.png', cid: 'image-chat' };
      _lightboxRevealBtn = { disabled: false };
    `, context);
    await context._onLightboxReveal({ stopPropagation: vi.fn() });
    expect(invoke).toHaveBeenCalledExactlyOnceWith('workspace.revealPath', {
      path: '/external project/封面.png', cid: 'image-chat',
    });
    expect(vm.runInContext('_lightboxRevealBtn.disabled', context)).toBe(false);
  });

  it('releases the preview source without resolving an empty URL to the current page', () => {
    const context = loadLightbox();
    let emptyAssignmentResolvedCurrentPage = false;
    const image = {
      removeAttribute: vi.fn(),
      set src(value: string) {
        if (value === '') emptyAssignmentResolvedCurrentPage = true;
      },
    };

    context._releaseLightboxImage(image);

    expect(image.removeAttribute).toHaveBeenCalledWith('src');
    expect(emptyAssignmentResolvedCurrentPage).toBe(false);
  });

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

  it('does not expose a hosted share action', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../src/renderer/modules/chat-lightbox.js'),
      'utf8',
    );
    expect(source).not.toContain('class="chat-lightbox-share"');
  });

  it('compacts every visible preview action when any sibling is hidden', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../src/renderer/modules/chat-lightbox.js'),
      'utf8',
    );
    const styles = fs.readFileSync(
      path.join(__dirname, '../../src/renderer/style.css'),
      'utf8',
    );
    expect(source).toContain('<div class="chat-lightbox-actions">');
    expect(styles).toMatch(/\.chat-lightbox-actions\s*\{[\s\S]*?display:\s*flex;[\s\S]*?gap:\s*8px;/);
    expect(styles).toContain('.chat-lightbox-actions > button[hidden] { display: none; }');
    expect(styles).not.toMatch(/\.chat-lightbox-(?:share|add-library|reveal)\s*\{\s*right:/);
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
