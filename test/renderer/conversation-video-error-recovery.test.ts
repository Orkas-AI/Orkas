import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const utilsSource = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/utils.js'),
  'utf8',
);

class FakeClassList {
  private readonly values: Set<string>;

  constructor(initial = '') {
    this.values = new Set(initial.split(/\s+/).filter(Boolean));
  }

  add(...names: string[]) { names.forEach((name) => this.values.add(name)); }
  remove(...names: string[]) { names.forEach((name) => this.values.delete(name)); }
  contains(name: string) { return this.values.has(name); }
  toggle(name: string, force?: boolean) {
    const enabled = force === undefined ? !this.values.has(name) : force;
    if (enabled) this.values.add(name); else this.values.delete(name);
    return enabled;
  }
}

class FakeElement {
  readonly nodeType = 1;
  readonly tagName: string;
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly classList: FakeClassList;
  parentNode: FakeElement | null = null;
  className = '';
  textContent = '';
  innerHTML = '';
  currentSrc = '';
  hidden = false;
  loadCalls = 0;

  constructor(tagName: string, classes = '') {
    this.tagName = tagName.toUpperCase();
    this.className = classes;
    this.classList = new FakeClassList(classes);
  }

  appendChild(child: FakeElement) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  setAttribute(name: string, value: string) {
    const stringValue = String(value);
    this.attributes.set(name, stringValue);
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
      this.dataset[key] = stringValue;
    }
  }

  getAttribute(name: string) { return this.attributes.get(name) || ''; }

  remove() {
    if (!this.parentNode) return;
    const index = this.parentNode.children.indexOf(this);
    if (index >= 0) this.parentNode.children.splice(index, 1);
    this.parentNode = null;
  }

  replaceWith(replacement: FakeElement) {
    if (!this.parentNode) return;
    const parent = this.parentNode;
    const index = parent.children.indexOf(this);
    if (index >= 0) parent.children.splice(index, 1, replacement);
    replacement.parentNode = parent;
    this.parentNode = null;
  }

  closest(selector: string): FakeElement | null {
    let current: FakeElement | null = this;
    while (current) {
      if (selector === '.chat-md-video-shell' && current.classList.contains('chat-md-video-shell')) return current;
      if (selector === '[data-chat-md-video-retry="1"]'
        && current.getAttribute('data-chat-md-video-retry') === '1') return current;
      if (selector === '[data-chat-md-video-open="1"]'
        && current.getAttribute('data-chat-md-video-open') === '1') return current;
      current = current.parentNode;
    }
    return null;
  }

  querySelector(selector: string): FakeElement | null {
    const matches = (candidate: FakeElement) => {
      if (selector === 'video.chat-md-video') {
        return candidate.tagName === 'VIDEO' && candidate.classList.contains('chat-md-video');
      }
      if (selector === '[data-chat-md-video-load-failure="1"]') {
        return candidate.getAttribute('data-chat-md-video-load-failure') === '1';
      }
      if (selector === '[data-chat-md-video-open="1"]') {
        return candidate.getAttribute('data-chat-md-video-open') === '1';
      }
      return false;
    };
    for (const child of this.children) {
      if (matches(child)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }

  load() { this.loadCalls += 1; }
}

type Listener = (event: Record<string, unknown>) => void;

function loadHarness(invoke: (channel: string, payload: Record<string, unknown>) => unknown) {
  const listeners = new Map<string, Listener[]>();
  const document = {
    addEventListener(type: string, listener: Listener) {
      const current = listeners.get(type) || [];
      current.push(listener);
      listeners.set(type, current);
    },
    createElement(tagName: string) { return new FakeElement(tagName); },
  };
  const sandbox = {
    URL,
    console,
    setTimeout,
    clearTimeout,
    currentCid: 'conversation-1',
    module: { exports: {} },
    document,
    window: { orkas: { invoke } },
    t(key: string) {
      return ({
        'chat.video_missing_placeholder': 'Video missing',
        'chat.video_load_failed': 'Video could not be loaded',
        'chat.retry_btn': 'Retry',
      } as Record<string, string>)[key] || key;
    },
    CustomEvent: class {
      constructor(public type: string) {}
    },
  };
  vm.runInNewContext(utilsSource, sandbox, { filename: 'utils.js' });

  const shell = new FakeElement('span', 'chat-md-video-shell');
  const video = new FakeElement('video', 'chat-md-video');
  video.currentSrc = 'chat-media://local/Users/test/final.mp4?v=1-1-100';
  video.setAttribute('src', video.currentSrc);
  video.setAttribute('aria-label', 'final');
  shell.appendChild(video);
  return {
    listeners,
    shell,
    video,
    applyMaterializedMedia: (sandbox as any)._applyMaterializedMarkdownMedia as (
      payload: Record<string, unknown>,
      root: { querySelectorAll: () => FakeElement[] },
    ) => number,
  };
}

function emit(listeners: Map<string, Listener[]>, type: string, event: Record<string, unknown>, index = 0) {
  const listener = listeners.get(type)?.[index];
  if (!listener) throw new Error(`missing ${type} listener ${index}`);
  listener(event);
}

describe('markdown video error recovery', () => {
  it('keeps a failed local preview inert until the downloaded local file is ready', async () => {
    const invoke = vi.fn(async () => ({ diagnosis: 'missing', media_kind: 'video' }));
    const { listeners, shell, video, applyMaterializedMedia } = loadHarness(invoke);
    const remoteUrl = 'https://cdn.example/render?id=clip-1';
    const localUrl = 'chat-media://cid/conversation-1/cli-remote-aabbccddeeff001122334455.mp4';
    const openButton = new FakeElement('button');
    openButton.setAttribute('data-chat-md-video-open', '1');
    openButton.setAttribute('data-video-src', localUrl);
    shell.appendChild(openButton);
    video.setAttribute('data-orkas-remote-src', remoteUrl);
    video.setAttribute('data-orkas-local-src', localUrl);
    video.setAttribute('src', localUrl);

    emit(listeners, 'error', { target: video });

    expect(video.getAttribute('src')).toBe(localUrl);
    expect(video.dataset.orkasRemoteFallbackAttempted).toBeUndefined();
    expect(video.loadCalls).toBe(0);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('media.diagnose', { url: video.currentSrc }));

    const updated = applyMaterializedMedia({
      remote_url: remoteUrl,
      local_url: localUrl,
      media_kind: 'video',
    }, { querySelectorAll: () => [video] });

    expect(updated).toBe(1);
    expect(video.getAttribute('src')).toBe(localUrl);
    expect(video.dataset.orkasRemoteFallbackAttempted).toBeUndefined();
    expect(video.loadCalls).toBe(1);
    expect(openButton.hidden).toBe(false);
    expect(openButton.getAttribute('data-video-src')).toBe(localUrl);
  });

  it('keeps an existing video in place, labels the load failure, and retries the same URL', async () => {
    const invoke = vi.fn(async () => ({ diagnosis: 'available', media_kind: 'video' }));
    const { listeners, shell, video } = loadHarness(invoke);

    emit(listeners, 'error', { target: video });
    await vi.waitFor(() => expect(shell.querySelector('[data-chat-md-video-load-failure="1"]')).not.toBeNull());

    expect(invoke).toHaveBeenCalledWith('media.diagnose', { url: video.currentSrc });
    expect(video.parentNode).toBe(shell);
    expect(shell.classList.contains('is-load-failed')).toBe(true);
    const failure = shell.querySelector('[data-chat-md-video-load-failure="1"]');
    const retry = failure?.children[1];
    expect(retry?.getAttribute('data-chat-md-video-retry')).toBe('1');

    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    emit(listeners, 'click', { target: retry, preventDefault, stopPropagation });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(video.loadCalls).toBe(1);
    expect(shell.classList.contains('is-load-failed')).toBe(false);
    expect(shell.querySelector('[data-chat-md-video-load-failure="1"]')).toBeNull();
    expect(video.dataset.videoErrorHandled).toBeUndefined();
  });

  it('shows the missing-video chip only after the host confirms not_found', async () => {
    const { listeners, shell, video } = loadHarness(async () => ({ diagnosis: 'not_found' }));

    emit(listeners, 'error', { target: video });
    await vi.waitFor(() => expect(video.parentNode).toBeNull());

    expect(shell.children.some((child) => child.className === 'chat-md-video-missing')).toBe(true);
    expect(shell.querySelector('[data-chat-md-video-load-failure="1"]')).toBeNull();
  });

  it('falls back to a recoverable load failure when diagnosis itself fails', async () => {
    const { listeners, shell, video } = loadHarness(async () => {
      throw new Error('ipc unavailable');
    });

    emit(listeners, 'error', { target: video });
    await vi.waitFor(() => expect(shell.querySelector('[data-chat-md-video-load-failure="1"]')).not.toBeNull());

    expect(video.parentNode).toBe(shell);
    expect(shell.children.some((child) => child.className === 'chat-md-video-missing')).toBe(false);
  });
});
