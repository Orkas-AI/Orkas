import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

class Element extends EventTarget {
  children: Element[] = [];
  attributes = new Map<string, string>();
  classes = new Set<string>();
  className = '';
  dataset = {};
  classList = { add: (...names: string[]) => names.forEach(name => this.classes.add(name)),
    remove: (...names: string[]) => names.forEach(name => this.classes.delete(name)) };
  appendChild(child: Element) { this.children.push(child); }
  contains(child: Element): boolean { return this.children.includes(child) || this.children.some(node => node.contains(child)); }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  set innerHTML(_value: string) { this.children = []; }
  querySelector() { return null; }
}

class Video extends Element {
  readyState = 0;
  currentTime = 0;
  duration = 10;
  paused = true;
  play = vi.fn(async () => { this.paused = false; });
  pause = vi.fn(() => { this.paused = true; });
  load = vi.fn(() => { this.readyState = 0; });
  set src(value: string) { this.setAttribute('src', value); }
}

function viewer() {
  const videos: Video[] = [];
  const body = new Element();
  const context = vm.createContext({
    window: {}, escapeHtml: String, body, setTimeout, clearTimeout,
    document: { addEventListener: vi.fn(), createElement: (tag: string) => {
      if (tag !== 'video') return new Element();
      const video = new Video(); videos.push(video); return video;
    } },
  });
  vm.runInContext(readFileSync(path.resolve(__dirname, '../../src/renderer/modules/chat-file-viewer.js'), 'utf8'), context);
  // Isolate native shell construction; exercise the real media creation,
  // teardown, pending playback callbacks and loading-state ownership.
  vm.runInContext(`var originalOpenViewerShell = _openViewerShell; _viewerBody = body;
    _openViewerShell = async () => { _teardownViewerContent(); return ++_viewerRenderSeq; };`, context);
  return { body, videos, context,
    open: (src: string) => context.openChatVideoUrlViewer(src, src, { autoplay: true, startTime: 3 }),
    openLocal: () => context._renderVideoBody('/fixture/local.mp4', 'Local', null, null, { autoplay: true }),
    close: () => context._teardownViewerContent('closed') };
}

describe('video media lifecycle', () => {
  it.each(['local', 'url'])('keeps the %s player reachable through the delegated playback surface', async entry => {
    const h = viewer();
    if (entry === 'local') await h.openLocal();
    else await h.open('https://example.com/preview.mp4');
    expect(h.body.children).toHaveLength(1);
    expect(h.body.children[0].dataset).toEqual({ chatVideoPlaybackSurface: 'floating_player' });
    expect(h.body.children[0].children).toEqual([h.videos[0]]);
    h.close();
    expect(h.videos[0].getAttribute('src')).toBeNull();
  });

  it('releases a pending video and ignores its late metadata/errors while the new video loads', async () => {
    const h = viewer();
    await h.open('chat-media://local/first.mp4');
    expect(h.body.children[0].dataset).toMatchObject({ chatVideoPlaybackSurface: 'floating_player' });
    const old = h.videos[0];
    await h.open('chat-media://local/second.mp4');
    const current = h.videos[1];
    expect(old.paused).toBe(true);
    expect(old.getAttribute('src')).toBeNull();
    expect(old.load).toHaveBeenCalledOnce();
    const oldPlayCount = old.play.mock.calls.length;
    old.dispatchEvent(new Event('loadedmetadata'));
    old.dispatchEvent(new Event('error'));
    expect(old.play).toHaveBeenCalledTimes(oldPlayCount);
    expect(h.body.getAttribute('aria-busy')).toBe('true');
    current.dispatchEvent(new Event('loadedmetadata'));
    expect(h.body.getAttribute('aria-busy')).toBeNull();
    expect(current.currentTime).toBe(3);
    h.close();
    expect(current.paused).toBe(true);
    expect(current.getAttribute('src')).toBeNull();
    expect(h.body.children).toHaveLength(0);
  });

  it('settles a failed video and can open another video without keeping its source alive', async () => {
    const h = viewer();
    await h.openLocal();
    expect(h.body.children[0].dataset).toMatchObject({ chatVideoPlaybackSurface: 'floating_player' });
    const failed = h.videos[0];
    failed.dispatchEvent(new Event('error'));
    expect(h.body.getAttribute('aria-busy')).toBeNull();
    await h.open('chat-media://local/recovered.mp4');
    h.videos[1].dispatchEvent(new Event('loadedmetadata'));
    expect(failed.getAttribute('src')).toBeNull();
    expect(h.body.contains(failed)).toBe(false);
    expect(h.body.contains(h.videos[1])).toBe(true);
    expect(h.body.getAttribute('aria-busy')).toBeNull();
  });
});


describe('file action ownership after replacement', () => {
  it('resets completed action icons and disabled buttons when opening the next file', async () => {
    const h = viewer();
    h.context.window.uiIconHtml = (name: string) => name;
    vm.runInContext(`
      _viewerEl = body; _ensureViewer = () => body; _viewerTitle = {};
      _viewerAddLibraryBtn = { innerHTML: 'check', disabled: true };
      _viewerSaveAppBtn = { innerHTML: 'check' };
      _refreshSaveAppButton = async () => {};
    `, h.context);
    await h.context.originalOpenViewerShell('next.html', { kind: 'html', absPath: '/next.html' });
    expect(vm.runInContext('_viewerSaveAppBtn.innerHTML', h.context)).toBe('layout-grid');
    expect(vm.runInContext('_viewerAddLibraryBtn.innerHTML', h.context)).toBe('database');
    expect(vm.runInContext('_viewerAddLibraryBtn.disabled', h.context)).toBe(false);
  });

  it('does not apply an old bundle inspection or delayed library-button reset to a newly opened file', async () => {
    vi.useFakeTimers();
    try {
      const h = viewer();
      let finish: (value: any) => void = () => {};
      h.context.window.orkas = { invoke: () => new Promise(resolve => { finish = resolve; }) };
      vm.runInContext(`
        _viewerCurrentPath = '/same.html'; _viewerCurrentCid = 'first';
        _viewerSaveAppBtn = { dataset: {}, hidden: false };
        _viewerAddLibraryBtn = { innerHTML: 'first', disabled: true };
        _setSaveAppVisible = value => { _viewerSaveAppBtn.hidden = !value; };
        _setViewerButtonLabel = () => {};
        _isViewerOpen = () => true;
      `, h.context);
      const inspect = h.context._refreshSaveAppButton('/same.html');
      h.context._scheduleAddLibraryButtonRestore('first', 0);
      vm.runInContext(`_viewerRenderSeq++; _viewerCurrentCid = 'next';
        _viewerAddLibraryBtn.innerHTML = 'next'; _viewerSaveAppBtn.hidden = true;`, h.context);
      finish({ ok: true, canSave: true, target: {} });
      await inspect;
      await vi.runAllTimersAsync();
      expect(vm.runInContext('_viewerSaveAppBtn.hidden', h.context)).toBe(true);
      expect(vm.runInContext('_viewerAddLibraryBtn.innerHTML', h.context)).toBe('next');
    } finally { vi.useRealTimers(); }
  });
});
