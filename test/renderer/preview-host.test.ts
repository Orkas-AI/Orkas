import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function host() {
  const invoke = vi.fn();
  const context: any = { createLogger: () => ({}), initI18n: () => new Promise(() => {}),
    _updateLightboxNavigation: vi.fn(), window: { orkas: { invoke, onPushEvent: vi.fn() }, addEventListener: vi.fn() } };
  vm.runInNewContext(readFileSync(path.resolve(__dirname, '../../src/renderer/modules/preview-host.js'), 'utf8'), context);
  return { api: context.window.OrkasPreviewHost, invoke };
}
const item = (key: string) => ({ key, src: key, alt: key });

describe('in-place preview replacement', () => {
  it('renders the latest queued selection and its context before acknowledging readiness', async () => {
    const handlers = new Map<string, () => Promise<void>>();
    const video = (title: string) => ({ kind: 'video', src: title, title, options: { cid: title, projectScoped: true } });
    const opened: string[] = [];
    let replacements = 0;
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'previewWindows.replace') return { ok: true, source: video(++replacements === 1 ? 'second' : 'latest') };
      if (channel === 'previewWindows.ready' && replacements === 1) {
        await handlers.get('preview-windows:replace-request')!();
      }
      return { ok: true };
    });
    const context: any = { createLogger: () => ({}), initI18n: () => new Promise(() => {}),
      _confirmDiscardViewerEdits: async () => true,
      openChatVideoUrlViewer: async (_src: string, title: string) => { opened.push(title); },
      closeChatImageLightbox: vi.fn(), closeChatFileViewer: vi.fn(), clearTimeout,
      document: { title: '', querySelector: () => null, getElementById: () => ({ hidden: true }) },
      window: { orkas: { invoke, onPushEvent: (event: string, handler: any) => handlers.set(event, handler) }, addEventListener: vi.fn() } };
    vm.runInNewContext(readFileSync(path.resolve(__dirname, '../../src/renderer/modules/preview-host.js'), 'utf8'), context);
    await handlers.get('preview-windows:replace-request')!();
    expect(opened).toEqual(['second', 'latest']);
    expect(context.document.title).toBe('latest');
    expect(context.window.OrkasPreviewHost.projectScopedFor('latest')).toBe(true);
    expect(context.window.OrkasPreviewHost.projectScopedFor('second')).toBe(false);
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
      'previewWindows.replace', 'previewWindows.ready', 'previewWindows.replace', 'previewWindows.ready',
    ]);
  });
});

describe('retired gallery requests', () => {
  it('ignores a late image-list reply after switching to a different file', async () => {
    const handlers = new Map<string, () => Promise<void>>();
    let resolvePage: (result: any) => void = () => {};
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'previewWindows.requestOwner') return new Promise(resolve => { resolvePage = resolve; });
      if (channel === 'previewWindows.replace') return { source: { kind: 'file', path: '/new.txt', title: 'New', options: {} } };
      return { ok: true };
    });
    const cleared: string[] = [];
    const context: any = { clearTimeout, createLogger: () => ({}), initI18n: () => new Promise(() => {}),
      _confirmDiscardViewerEdits: async () => true, _updateLightboxNavigation: vi.fn(),
      closeChatImageLightbox: (opts: any) => { expect(opts.force).toBe(true); cleared.push('image'); },
      closeChatFileViewer: (opts: any) => { expect(opts.force).toBe(true); cleared.push('file'); },
      openChatFileViewer: async () => { expect(cleared).toEqual(['image', 'file']); }, _isViewerOpen: () => true,
      document: { title: '', querySelector: () => null, getElementById: () => ({ hidden: true }) },
      window: { orkas: { invoke, onPushEvent: (name: string, fn: any) => handlers.set(name, fn) }, addEventListener: vi.fn() } };
    vm.runInNewContext(readFileSync(path.resolve(__dirname, '../../src/renderer/modules/preview-host.js'), 'utf8'), context);
    const gallery = { items: [item('old')], nextCursor: 10 };
    const request = context.window.OrkasPreviewHost.loadGalleryPage(gallery, 10);
    await handlers.get('preview-windows:replace-request')!();
    resolvePage({ ok: true, items: [item('late')], nextCursor: null });
    await request;
    expect(gallery).toEqual({ items: [item('old')], nextCursor: 10 });
    expect(context._updateLightboxNavigation).not.toHaveBeenCalled();
    expect(context.document.title).toBe('New');
  });
});

describe('native image history', () => {
  it('keeps chronological order when a refresh overlaps a shorter opening snapshot and when older pages arrive', async () => {
    const { api, invoke } = host();
    const gallery = { items: [item('last')], selectedKey: 'last', nextCursor: 120 };
    invoke.mockResolvedValueOnce({ ok: true, items: [item('middle'), item('last')], nextCursor: 30 });
    await api.loadGalleryPage(gallery, null);
    expect(gallery.items.map(i => i.key)).toEqual(['middle', 'last']);
    invoke.mockResolvedValueOnce({ ok: true, items: [item('first'), item('middle')], nextCursor: null });
    await api.loadGalleryPage(gallery, 120);
    expect(gallery.items.map(i => i.key)).toEqual(['first', 'middle', 'last']);
    expect(gallery.nextCursor).toBeNull();
    invoke.mockResolvedValueOnce({ ok: true, items: [item('last'), item('new')], nextCursor: 50 });
    await api.loadGalleryPage(gallery, null);
    expect(gallery.items.map(i => i.key)).toEqual(['first', 'middle', 'last', 'new']);
    expect(gallery.selectedKey).toBe('last');
    expect(gallery.nextCursor).toBeNull();
  });

  it('preserves retry position and the selected image after a failed page', async () => {
    const { api, invoke } = host();
    const gallery = { items: [item('last')], selectedKey: 'last', nextCursor: 10 };
    invoke.mockResolvedValueOnce({ ok: false });
    await api.loadGalleryPage(gallery, 10);
    expect(gallery).toEqual({ items: [item('last')], selectedKey: 'last', nextCursor: 10 });
    invoke.mockResolvedValueOnce({ ok: true, items: [item('first')], nextCursor: null });
    await api.loadGalleryPage(gallery, 10);
    expect(gallery.items.map(i => i.key)).toEqual(['first', 'last']);
  });
});

describe('non-conversation image previews', () => {
  it('does not inherit the selected chat when a todo explicitly has no conversation', async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    const context: any = { currentCid: 'unrelated-chat', _viewerConversationIsProjectScoped: () => false,
      window: { orkas: { invoke, onPushEvent: vi.fn() } } };
    vm.runInNewContext(readFileSync(path.resolve(__dirname, '../../src/renderer/modules/preview-windows.js'), 'utf8'), context);
    await context.window.OrkasPreviewWindows.image('chat-media://local/test.png', 'test.png', { cid: null, projectId: 'p_todo' });
    expect(invoke.mock.calls[0]).toEqual(['previewWindows.open', expect.objectContaining({
      options: { projectId: 'p_todo', projectScoped: true }, gallery: null,
    })]);
    await context.window.OrkasPreviewWindows.image('chat-media://local/chat.png', 'chat.png');
    expect(invoke.mock.calls[1]).toEqual(['previewWindows.open', expect.objectContaining({
      options: { cid: 'unrelated-chat', projectScoped: false },
    })]);
  });
});


it('presents one localized error when the main preview adapter rejects an open', async () => {
  const receipt = { ok: false, code: 'E_MANIFEST' };
  const alert = vi.fn(), invoke = vi.fn(async () => receipt);
  const context: any = { t: (key:string) => key, uiAlert: alert, window: { orkas: { invoke, onPushEvent: vi.fn() } } };
  vm.runInNewContext(readFileSync(path.resolve(__dirname, '../../src/renderer/modules/preview-windows.js'), 'utf8'), context);
  await expect(context.window.OrkasPreviewWindows.open({ kind: 'file', path: '/fixture/app.html' })).resolves.toEqual({ok:false});
  expect(alert).toHaveBeenCalledExactlyOnceWith('chat.preview_window_failed');
  expect(invoke).toHaveBeenCalledExactlyOnceWith('previewWindows.open', {kind:'file',path:'/fixture/app.html'});
});


describe('saved app window readiness and failure recovery', () => {
  async function openAppWindow(openInApp: () => Promise<any>) {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'previewWindows.initialize') return {ok:true,source:{kind:'app',appId:'fixture-app',title:'Fixture app'}};
      if (channel === 'savedApps.openInApp') return openInApp();
      return {ok:true};
    });
    const context: any = {
      createLogger: () => ({}), initI18n: async () => {}, uiAlert: vi.fn(async () => {}), t: (key: string) => key,
      _confirmDiscardViewerEdits: async () => true, refreshLangFromMain: async () => {},
      document: {title:'',getElementById:() => ({hidden:false}),querySelector:() => null},
      window: {orkas:{invoke,onPushEvent:vi.fn()},addEventListener:vi.fn(),openSavedAppPreview:vi.fn()},
    };
    vm.runInNewContext(readFileSync(path.resolve(__dirname, '../../src/renderer/modules/preview-host.js'), 'utf8'), context);
    await vi.waitFor(() => expect(invoke.mock.calls.some(([channel]) => channel === 'previewWindows.ready' || channel === 'previewWindows.close')).toBe(true));
    return {invoke,context};
  }

  it('mounts the app before acknowledging a ready native window', async () => {
    const {invoke,context} = await openAppWindow(async () => ({ok:true,url:'chat-app://fixture/index.html'}));
    expect(context.window.openSavedAppPreview).toHaveBeenCalledExactlyOnceWith({ok:true,url:'chat-app://fixture/index.html'},'Fixture app');
    const ready = invoke.mock.calls.findIndex(([channel]) => channel === 'previewWindows.ready');
    expect(invoke.mock.invocationCallOrder[ready]).toBeGreaterThan(context.window.openSavedAppPreview.mock.invocationCallOrder[0]);
    expect(context.document.title).toBe('Fixture app');
    expect(context.uiAlert).not.toHaveBeenCalled();
    expect(invoke.mock.calls.some(([channel]) => channel === 'previewWindows.close')).toBe(false);
  });

  it('presents the failure dialog before closing and never mounts a rejected runtime', async () => {
    const {invoke,context} = await openAppWindow(async () => ({ok:false,code:'E_MANIFEST',error:'Private localized path'}));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('previewWindows.close'));
    expect(context.window.openSavedAppPreview).not.toHaveBeenCalled();
    expect(context.uiAlert).toHaveBeenCalledExactlyOnceWith('chat.preview_window_failed');
    const ready = invoke.mock.calls.findIndex(([channel]) => channel === 'previewWindows.ready');
    const close = invoke.mock.calls.findIndex(([channel]) => channel === 'previewWindows.close');
    expect(ready).toBeGreaterThanOrEqual(0);
    expect(invoke.mock.invocationCallOrder[ready]).toBeLessThan(context.uiAlert.mock.invocationCallOrder[0]);
    expect(invoke.mock.invocationCallOrder[close]).toBeGreaterThan(context.uiAlert.mock.invocationCallOrder[0]);
  });
});
