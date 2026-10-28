import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(join(__dirname, '../../src/renderer/modules/project-detail.js'), 'utf8');
const kinds = ['text', 'image', 'pdf', 'docx', 'office'] as const;
function harness(kind: typeof kinds[number], outcome = 'success', scriptPermission: unknown = true) {
  let release!: () => void;
  const response = new Promise((resolve, reject) => { release = () => {
    if (outcome === 'rejection') reject(new Error('synthetic preview rejection'));
    else resolve({ ok: outcome === 'success', content: 'Original text', html: '<p>Original Office</p>',
      path: '/fixture/original.pdf', mediaType: 'image/png', base64: 'AAAA', bytes: 3, allowScripts: scriptPermission });
  }; });
  const node = () => ({ innerHTML: '', textContent: '', scrollTop: 0, style: {} as Record<string, string>,
    classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() }, attributes: new Map<string, string>(),
    setAttribute(name: string, value: string) { this.attributes.set(name, value); },
    removeAttribute(name: string) { this.attributes.delete(name); },
    querySelector: () => ({ addEventListener: vi.fn() }),
  });
  const body = node(), actions = node();
  const nodes = new Map<string, any>([['project-library-viewer-body', body], ['project-library-viewer-actions', actions],
    ...['project-library-viewer-modal', 'project-library-editor-empty', 'project-library-viewer-wrap', 'project-library-editor-path'].map(id => [id, node()] as [string, any])]);
  const invoke = vi.fn(() => response);
  const context: any = { performance, AbortController, Blob, ArrayBuffer, Uint8Array, setTimeout, clearTimeout,
    currentUserId: 'first', t: String, escapeHtml: String,
    createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
    uiAlert: vi.fn(async () => undefined),
    URL: { createObjectURL: vi.fn(() => 'blob:fixture-current'), revokeObjectURL: vi.fn() },
    window: { addEventListener: vi.fn(), orkas: { invoke } },
    document: { readyState: 'loading', addEventListener: vi.fn(), getElementById: (id: string) => nodes.get(id) || null,
      querySelectorAll: () => [], querySelector: () => null },
  };
  vm.createContext(context); vm.runInContext(source, context);
  vm.runInContext("_projectDetailPid = 'project-1'", context);
  context._findProjectFileRow = () => ({ dataset: { projectFileKind: kind === 'office' ? 'spreadsheet' : kind } });
  const open = () => kind === 'docx'
    ? context._showProjectDocxViewer('original.docx')
    : context._openProjectFile(`original.${kind}`);
  const change = (scope: string) => {
    if (scope === 'file') context._prepProjectLibraryViewer('current.md');
    if (scope === 'closed') context._clearProjectLibraryViewer();
    if (scope === 'project') vm.runInContext("_projectDetailPid = 'project-2'", context);
    if (scope === 'account') context.currentUserId = 'second';
    body.innerHTML = 'Current body'; body.scrollTop = 73;
    body.setAttribute('aria-busy', 'true'); actions.innerHTML = 'Current actions';
  };
  return { context, body, actions, invoke, open, change, release };
}

describe('project file viewer request ownership', () => {
  for (const scope of ['file', 'closed', 'project', 'account']) {
    it.each(kinds)('does not replace the current view with a late %s response after ' + scope, async kind => {
      const h = harness(kind); const opening = h.open(); h.change(scope); h.release(); await opening;
      expect(h.body.innerHTML).toBe('Current body'); expect(h.actions.innerHTML).toBe('Current actions');
      expect(h.body.scrollTop).toBe(73); expect(h.body.attributes.get('aria-busy')).toBe('true');
      expect(h.context.uiAlert).not.toHaveBeenCalled(); expect(h.context.URL.createObjectURL).not.toHaveBeenCalled();
    });
  }

  for (const outcome of ['failure', 'rejection']) {
    it.each(kinds)('suppresses stale %s ' + outcome + ' feedback and cleanup after account switch', async kind => {
      const h = harness(kind, outcome); const opening = h.open(); h.change('account'); h.release();
      await expect(opening).resolves.toBeUndefined();
      expect(h.body.innerHTML).toBe('Current body'); expect(h.actions.innerHTML).toBe('Current actions');
      expect(h.body.attributes.get('aria-busy')).toBe('true'); expect(h.context.uiAlert).not.toHaveBeenCalled();
    });
  }

  it.each(kinds)('still renders the requested current %s file', async kind => {
    const h = harness(kind); const opening = h.open(); h.release(); await opening;
    expect(h.invoke).toHaveBeenCalledOnce(); expect(h.body.innerHTML).not.toBe('');
    if (kind === 'text') expect(h.body.innerHTML).toContain('Original text');
    if (kind === 'image') expect(h.body.innerHTML).toContain('data:image/png;base64,AAAA');
    if (kind === 'pdf') expect(h.body.innerHTML).toContain('chat-media://local/fixture/original.pdf');
    if (kind === 'docx') expect(h.body.innerHTML).toContain('Original Office');
    if (kind === 'office') {
      expect(h.body.innerHTML).toContain('sandbox="allow-scripts"');
      expect(h.body.innerHTML).not.toContain('allow-same-origin');
      expect(h.body.attributes.has('aria-busy')).toBe(false);
      expect(h.context.URL.createObjectURL).toHaveBeenCalledOnce();
      h.context._clearProjectLibraryViewer(); h.context._clearProjectLibraryViewer();
      expect(h.context.URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:fixture-current');
    }
    expect(h.context.uiAlert).not.toHaveBeenCalled();
  });

  it.each([false, 'true', null])('does not grant scripts for non-true Office permission %j', async permission => {
    const h = harness('office', 'success', permission); const opening = h.open(); h.release(); await opening;
    expect(h.body.innerHTML).toContain('sandbox=""');
    expect(h.body.innerHTML).not.toContain('allow-scripts');
  });

  it.each(kinds.filter(kind => kind !== 'docx'))('keeps current %s read failure feedback', async kind => {
    const h = harness(kind, 'failure'); const opening = h.open(); h.release(); await opening;
    expect(h.context.uiAlert).toHaveBeenCalledExactlyOnceWith('contexts.read_failed');
    if (kind === 'office') expect(h.body.attributes.has('aria-busy')).toBe(false);
  });
});
