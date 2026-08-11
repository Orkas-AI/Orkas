import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const source = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/conversation.js'),
  'utf8',
);

function extractFunction(name: string): string {
  const marker = `function ${name}`;
  const markerStart = source.indexOf(marker);
  if (markerStart < 0) throw new Error(`missing ${name}`);
  const start = source.slice(Math.max(0, markerStart - 6), markerStart) === 'async '
    ? markerStart - 6
    : markerStart;
  const braceStart = source.indexOf('{', start);
  if (braceStart < 0) throw new Error(`missing body for ${name}`);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

type AttachmentItem = {
  name?: string;
  displayName?: string;
  status?: string;
};

type OpenPreview = (cid: string, item: AttachmentItem | null) => Promise<void>;

function createPreviewHarness(
  invokeResult: unknown = { ok: true, path: '/safe/draft-note.md' },
  options: { viewerAvailable?: boolean } = {},
) {
  const invoke = vi.fn(async () => invokeResult);
  const openChatFileViewer = vi.fn(async () => undefined);
  const showFileMissingToast = vi.fn();
  const warn = vi.fn();
  const globals: Record<string, unknown> = {
    window: { orkas: { invoke } },
    _showFileMissingToast: showFileMissingToast,
    _convLog: { warn },
  };
  if (options.viewerAvailable !== false) globals.openChatFileViewer = openChatFileViewer;
  const context = vm.createContext(globals);
  vm.runInContext(`
    ${extractFunction('_chatAttachOpenPreview')}
    globalThis.openPreview = _chatAttachOpenPreview;
  `, context);
  return {
    openPreview: (context as typeof context & { openPreview: OpenPreview }).openPreview,
    invoke,
    openChatFileViewer,
    showFileMissingToast,
    warn,
  };
}

describe('pending attachment preview', () => {
  it('resolves the stored name and opens the viewer with the display name and cid', async () => {
    const harness = createPreviewHarness();

    await harness.openPreview('main_chat', {
      name: 'stored-draft-note.md',
      displayName: 'Draft note 中文.md',
      status: 'ready',
    });

    expect(harness.invoke).toHaveBeenCalledOnce();
    expect(harness.invoke).toHaveBeenCalledWith('attachments.absPath', {
      cid: 'main_chat',
      name: 'stored-draft-note.md',
    });
    expect(harness.openChatFileViewer).toHaveBeenCalledWith(
      '/safe/draft-note.md',
      'Draft note 中文.md',
      { cid: 'main_chat' },
    );
    expect(harness.showFileMissingToast).not.toHaveBeenCalled();
  });

  it('falls back to the stored name when no separate display name exists', async () => {
    const harness = createPreviewHarness();

    await harness.openPreview('main_chat', {
      name: 'draft-note.md',
      status: 'ready',
    });

    expect(harness.openChatFileViewer).toHaveBeenCalledWith(
      '/safe/draft-note.md',
      'draft-note.md',
      { cid: 'main_chat' },
    );
  });

  it('does not resolve a path before the viewer module is available', async () => {
    const harness = createPreviewHarness(undefined, { viewerAvailable: false });

    await harness.openPreview('main_chat', {
      name: 'draft-note.md',
      status: 'ready',
    });

    expect(harness.invoke).not.toHaveBeenCalled();
    expect(harness.openChatFileViewer).not.toHaveBeenCalled();
  });

  it.each([
    { cid: '', item: { name: 'draft.md', status: 'ready' }, label: 'missing cid' },
    { cid: 'main_chat', item: null, label: 'missing item' },
    { cid: 'main_chat', item: { name: 'draft.md', status: 'uploading' }, label: 'uploading item' },
    { cid: 'main_chat', item: { name: '', status: 'ready' }, label: 'missing stored name' },
  ])('does not resolve or open a $label', async ({ cid, item }) => {
    const harness = createPreviewHarness();

    await harness.openPreview(cid, item);

    expect(harness.invoke).not.toHaveBeenCalled();
    expect(harness.openChatFileViewer).not.toHaveBeenCalled();
    expect(harness.showFileMissingToast).not.toHaveBeenCalled();
  });

  it('shows the existing missing-file recovery when path resolution is rejected', async () => {
    const harness = createPreviewHarness({ ok: false, error: 'not found' });

    await harness.openPreview('main_chat', {
      name: 'stored.md',
      displayName: 'Visible.md',
      status: 'ready',
    });

    expect(harness.openChatFileViewer).not.toHaveBeenCalled();
    expect(harness.showFileMissingToast).toHaveBeenCalledWith('Visible.md');
    expect(harness.warn).toHaveBeenCalledOnce();
  });

  it('uses the same recovery when the path resolver throws', async () => {
    const harness = createPreviewHarness();
    harness.invoke.mockRejectedValueOnce(new Error('resolver unavailable'));

    await harness.openPreview('main_chat', {
      name: 'stored.md',
      displayName: 'Visible.md',
      status: 'ready',
    });

    expect(harness.openChatFileViewer).not.toHaveBeenCalled();
    expect(harness.showFileMissingToast).toHaveBeenCalledWith('Visible.md');
    expect(harness.warn).toHaveBeenCalledOnce();
  });

  it('renders only ready chips as previewable and keeps preview and remove clicks separate', async () => {
    type Handler = (event: { stopPropagation: () => void }) => Promise<void>;
    const previewHandlers: Record<string, Handler> = {};
    const removeHandlers: Record<string, Handler> = {};
    const previewNode = {
      dataset: { idx: '0' },
      addEventListener: (event: string, handler: Handler) => { previewHandlers[event] = handler; },
    };
    const removeNode = {
      dataset: { idx: '0' },
      addEventListener: (event: string, handler: Handler) => { removeHandlers[event] = handler; },
    };
    const host = {
      style: { display: 'none' },
      innerHTML: '',
      querySelectorAll: (selector: string) => {
        if (selector === '.chat-attach-preview:not(:disabled)') return [previewNode];
        if (selector === '.chat-attach-remove') return [removeNode];
        return [];
      },
    };
    const items = [
      { name: 'ready.md', displayName: 'Ready.md', kind: 'text', status: 'ready' },
      { name: 'uploading.md', displayName: 'Uploading.md', kind: 'text', status: 'uploading' },
    ];
    const openPreview = vi.fn(async () => undefined);
    const removeAttachment = vi.fn(async () => undefined);
    const context = vm.createContext({
      currentCid: null,
      document: { getElementById: (id: string) => id === 'new-chat-attachments' ? host : null },
      _chatAttachList: vi.fn(() => items),
      _chatFileIconHtml: vi.fn(() => '<i></i>'),
      escapeHtml: (value: unknown) => String(value),
      t: (key: string) => key,
      _chatAttachOpenPreview: openPreview,
      _chatAttachRemove: removeAttachment,
    });
    vm.runInContext(`
      const DRAFT_CID = 'main_chat';
      ${extractFunction('_chatAttachHostIdFor')}
      ${extractFunction('_chatAttachRenderChips')}
      globalThis.renderChips = _chatAttachRenderChips;
    `, context);

    (context as typeof context & { renderChips: (cid: string) => void }).renderChips('main_chat');

    const readyButton = host.innerHTML.match(/<button[^>]*data-idx="0"[^>]*>/)?.[0] || '';
    const uploadingButton = host.innerHTML.match(/<button[^>]*data-idx="1"[^>]*>/)?.[0] || '';
    expect(readyButton).not.toContain('disabled');
    expect(uploadingButton).toContain('disabled');
    expect(previewHandlers.click).toBeTypeOf('function');
    expect(removeHandlers.click).toBeTypeOf('function');

    const previewStop = vi.fn();
    await previewHandlers.click({ stopPropagation: previewStop });
    expect(previewStop).toHaveBeenCalledOnce();
    expect(openPreview).toHaveBeenCalledWith('main_chat', items[0]);
    expect(removeAttachment).not.toHaveBeenCalled();

    const removeStop = vi.fn();
    await removeHandlers.click({ stopPropagation: removeStop });
    expect(removeStop).toHaveBeenCalledOnce();
    expect(removeAttachment).toHaveBeenCalledWith('main_chat', 0);
    expect(openPreview).toHaveBeenCalledTimes(1);
  });
});
