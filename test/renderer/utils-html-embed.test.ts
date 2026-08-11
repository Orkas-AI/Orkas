import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const utilsSource = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/utils.js'),
  'utf8',
);
const styleSource = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/style.css'),
  'utf8',
);

class FakeClassList {
  values: Set<string>;

  constructor(initial = '') {
    this.values = new Set(initial.split(/\s+/).filter(Boolean));
  }

  add(...names: string[]) { names.forEach((name) => this.values.add(name)); }
  remove(...names: string[]) { names.forEach((name) => this.values.delete(name)); }
  contains(name: string) { return this.values.has(name); }
}

class FakeFrame {
  className = '';
  style: Record<string, string> = {};
  attributes = new Map<string, string>();
  listeners = new Map<string, () => void>();
  dispatched: Array<{ type: string }> = [];

  setAttribute(name: string, value: string) { this.attributes.set(name, String(value)); }
  getAttribute(name: string) { return this.attributes.get(name) || ''; }
  addEventListener(type: string, listener: () => void) { this.listeners.set(type, listener); }
  dispatchEvent(event: { type: string }) { this.dispatched.push(event); return true; }
  emit(type: string) { this.listeners.get(type)?.(); }
}

class FakeHost {
  dataset: Record<string, string> = {};
  classList = new FakeClassList('chat-md-html-embed is-loading');
  children: FakeFrame[] = [];
  attributes: Map<string, string>;
  clientWidth = 720;
  isConnected = true;
  style = {
    properties: new Map<string, string>(),
    setProperty(name: string, value: string) { this.properties.set(name, value); },
    getPropertyValue(name: string) { return this.properties.get(name) || ''; },
  };

  constructor(src: string, title = 'HTML preview') {
    this.attributes = new Map([
      ['data-html-src', src],
      ['data-html-title', title],
    ]);
  }

  matches(selector: string) { return selector === '[data-chat-md-html-embed="1"]'; }
  querySelectorAll() { return []; }
  getAttribute(name: string) { return this.attributes.get(name) || ''; }
  replaceChildren(...children: FakeFrame[]) { this.children = children; }
}

function loadHydrator(options: { layout?: unknown } = {}) {
  const frames: FakeFrame[] = [];
  const invokeCalls: Array<{ channel: string; payload: Record<string, unknown> }> = [];
  const window = Object.prototype.hasOwnProperty.call(options, 'layout')
    ? {
        orkas: {
          async invoke(channel: string, payload: Record<string, unknown>) {
            invokeCalls.push({ channel, payload });
            return { ok: true, layout: options.layout };
          },
        },
      }
    : {};
  const sandbox: Record<string, unknown> = {
    URL,
    console,
    module: { exports: {} },
    window,
    currentCid: 'conversation-1',
    CustomEvent: class {
      type: string;
      constructor(type: string) { this.type = type; }
    },
    document: {
      addEventListener() {},
      createElement(tag: string) {
        if (tag !== 'iframe') throw new Error(`unexpected element: ${tag}`);
        const frame = new FakeFrame();
        frames.push(frame);
        return frame;
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(utilsSource, sandbox, { filename: 'utils.js' });
  const hydrate = vm.runInContext('_hydrateMarkdownHtmlEmbeds', sandbox) as (root: unknown) => void;
  return { hydrate, frames, invokeCalls };
}

function rootWith(hosts: FakeHost[]) {
  return {
    matches: () => false,
    querySelectorAll: (selector: string) => (
      selector === '[data-chat-md-html-embed="1"]' ? hosts : []
    ),
  };
}

describe('markdown HTML inline hydration', () => {
  it('mounts multiple local HTML outputs as independent lazy sandboxed frames', () => {
    const { hydrate, frames } = loadHydrator();
    const firstSrc = 'chat-media://local/Users/test/%E5%9F%8E%E5%B8%82%20%E6%B5%B7%E6%8A%A5%20%231%3F.html?v=123#preview';
    const secondSrc = 'chat-media://local/C:/Users/test/alternate.HTM';
    const first = new FakeHost(firstSrc, '城市海报');
    const second = new FakeHost(secondSrc, 'Alternate poster');

    hydrate(rootWith([first, second]));

    expect(frames).toHaveLength(2);
    expect(first.children).toEqual([frames[0]]);
    expect(second.children).toEqual([frames[1]]);
    expect(frames[0].attributes).toEqual(new Map([
      ['sandbox', 'allow-scripts'],
      ['loading', 'lazy'],
      ['referrerpolicy', 'no-referrer'],
      ['title', '城市海报'],
      ['src', firstSrc],
    ]));
    expect(frames[1].getAttribute('src')).toBe(secondSrc);
    expect(first.dataset.htmlEmbedHydrated).toBe('1');
    expect(second.dataset.htmlEmbedHydrated).toBe('1');
  });

  it.each([
    'https://example.test/page.html',
    'javascript:alert(1).html',
    'chat-media://cid/conversation/page.html',
    'chat-media://local/Users/test/poster.png?download=page.html',
    'chat-media://local/Users/test/poster.html.png',
  ])('rejects non-local or HTML-lookalike mount source %s', (src) => {
    const { hydrate, frames } = loadHydrator();
    const host = new FakeHost(src);

    hydrate(rootWith([host]));

    expect(frames).toHaveLength(0);
    expect(host.children).toHaveLength(0);
    expect(host.dataset.htmlEmbedHydrated).toBeUndefined();
    expect(host.classList.contains('is-loading')).toBe(false);
    expect(host.classList.contains('is-error')).toBe(true);
  });

  it('settles load/error state and does not remount an already hydrated frame', () => {
    const { hydrate, frames } = loadHydrator();
    const host = new FakeHost('chat-media://local/Users/test/poster.html');
    const root = rootWith([host]);

    hydrate(root);
    hydrate(root);
    expect(frames).toHaveLength(1);

    frames[0].emit('load');
    expect(host.classList.contains('is-loading')).toBe(false);
    expect(host.classList.contains('is-loaded')).toBe(true);
    expect(frames[0].dispatched).toEqual([{ type: 'chat-image-settled' }]);

    frames[0].emit('error');
    expect(host.classList.contains('is-loaded')).toBe(false);
    expect(host.classList.contains('is-error')).toBe(true);
    expect(frames[0].dispatched).toHaveLength(2);
  });

  it('keeps a fixed chat width and derives the complete height from the source canvas', async () => {
    const { hydrate, frames, invokeCalls } = loadHydrator({
      layout: { kind: 'fixed-canvas', width: 1080, height: 1350 },
    });
    const host = new FakeHost('chat-media://local/Users/test/poster.html');

    hydrate(rootWith([host]));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(invokeCalls).toEqual([{
      channel: 'produced.readText',
      payload: {
        path: '/Users/test/poster.html',
        htmlPreviewLayoutOnly: true,
        cid: 'conversation-1',
      },
    }]);
    expect(host.style.getPropertyValue('--chat-html-aspect-ratio')).toBe('1080 / 1350');
    expect(host.style.getPropertyValue('--chat-html-source-width')).toBe('1080px');
    expect(host.dataset.htmlEmbedLayout).toBe('1080x1350');
    expect(frames[0].style).toMatchObject({
      width: '1080px',
      height: '1350px',
      transformOrigin: 'top left',
      transform: `scale(${2 / 3})`,
    });
  });

  it('uses aspect-ratio sizing instead of a fixed or viewport-clamped frame height', () => {
    expect(styleSource).toMatch(/\.chat-md-html-embed\s*\{[\s\S]*?width:\s*min\(720px, 100%, var\(--chat-html-source-width\)\);/);
    expect(styleSource).toMatch(/\.chat-md-html-embed\s*\{[\s\S]*?height:\s*auto;[\s\S]*?aspect-ratio:\s*var\(--chat-html-aspect-ratio\);/);
    expect(styleSource).toMatch(/\.chat-md-html-frame\s*\{[\s\S]*?width:\s*100%;[\s\S]*?height:\s*100%;/);
    expect(styleSource).not.toMatch(/\.chat-md-html-frame\s*\{[\s\S]*?height:\s*clamp\(/);
  });

  it('accepts the mount node itself as the hydration root', () => {
    const { hydrate, frames } = loadHydrator();
    const host = new FakeHost('chat-media://local/Users/test/poster.htm');

    hydrate(host);

    expect(frames).toHaveLength(1);
    expect(host.children[0].getAttribute('sandbox')).toBe('allow-scripts');
  });
});
