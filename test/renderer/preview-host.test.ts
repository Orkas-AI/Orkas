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
