import { composerAccessorSource } from './composer-test-source';
import { conversationCacheSource } from './conversation-cache-test-source';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const recoverySource = readFileSync(resolve(__dirname, '../../src/renderer/modules/app-save-recovery.js'), 'utf8');
const modulesDir = resolve(__dirname, '../../src/renderer/modules');
const savedAppsSource = readFileSync(resolve(modulesDir, 'saved-apps.js'), 'utf8');
const artifactSource = readFileSync(resolve(modulesDir, 'chat-artifact.js'), 'utf8');
const fileViewerSource = readFileSync(resolve(modulesDir, 'chat-file-viewer.js'), 'utf8');
const conversationInfoSource = readFileSync(resolve(modulesDir, 'conversation-info.js'), 'utf8');

function extractFunction(source: string, name: string): string {
  const asyncMarker = `async function ${name}`;
  const syncMarker = `function ${name}`;
  const start = source.indexOf(asyncMarker) >= 0
    ? source.indexOf(asyncMarker)
    : source.indexOf(syncMarker);
  if (start < 0) throw new Error(`missing ${name}`);
  const braceStart = source.indexOf('{', source.indexOf(')', start));
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

function loadSavedApps(invoke: (channel: string, payload?: any) => Promise<any>, options: {
  presentationFailure?: boolean;
} = {}) {
  const warnings: Array<Record<string, any>> = [];
  const executable = savedAppsSource.replace(
    'window.loadSavedApps = loadSavedApps;',
    'window.loadSavedApps = loadSavedApps; window.__savedAppActions = { open: _openApp, edit: _editApp, rename: _renameApp, delete: _deleteApp, create: _createAppTask };',
  );
  const context: any = {
    console,
    Date,
    Math,
    Set,
    setTimeout: (handler: () => void) => handler(),
    createLogger: () => ({
      warn: (_message: string, data: Record<string, any>) => warnings.push(data),
      error: vi.fn(),
    }),
    t: (key: string) => key,
    uiAlert: vi.fn(),
    uiPrompt: vi.fn(async () => 'Renamed app'),
    uiConfirmDanger: vi.fn(async () => true),
    window: {
      OrkasArtifactSecurity: {
        SANDBOX: 'allow-scripts',
        trustedArtifactMessage: () => false,
        safeExternalHttpUrl: () => '',
      },
      addEventListener: vi.fn(),
      open: vi.fn(),
      orkas: { invoke: vi.fn(invoke) },
    },
    document: {
      body: { appendChild: vi.fn() },
      addEventListener: vi.fn(),
      createElement: vi.fn(),
      getElementById: () => {
        if (options.presentationFailure) throw new Error('/Users/test/private/presentation');
        return null;
      },
      querySelectorAll: () => [],
      querySelector: () => null,
      documentElement: { getAttribute: () => 'en' },
    },
    navigator: { language: 'en' },
  };
  vm.createContext(context);
  vm.runInContext(recoverySource, context);
  vm.runInContext(composerAccessorSource, context);
  vm.runInContext(conversationCacheSource, context);
  vm.runInContext(executable, context, { filename: 'saved-apps.js' });
  return { context, warnings };
}

describe('saved app recovery and privacy', () => {

  it('preserves the creation form when task creation is rejected and reports no private data', async () => {
    const harness = loadSavedApps(async () => { throw new Error('/private/customer-description'); });
    harness.context.ensureModelConfigured = () => true;
    harness.context._autoTitle = (text: string) => text;
    const close = vi.fn();
    expect(await harness.context.window.__savedAppActions.create('private customer idea', close, 'web')).toBe(false);
    expect(close).not.toHaveBeenCalled();
    expect(harness.context.uiAlert).toHaveBeenCalled();
  });

  it('reports accepted creation once even when execution later fails', async () => {
    const harness = loadSavedApps(async () => ({ conversation: { conversation_id: 'new-task' } }));
    Object.assign(harness.context, {
      ensureModelConfigured: () => true, _autoTitle: (text: string) => text,
      conversations: [{ conversation_id: 'new-task', processing: true }],
      renderConversationList: vi.fn(), setView: vi.fn(), _restoreDraft: vi.fn(), setChatRecipient: vi.fn(),
      _rememberSentComposerSnapshot: vi.fn(),
      sendInConversation: vi.fn(async (_cid: string, _prompt: string, _extra: unknown, options: any) => {
        options.onAccepted(); options.onAccepted();
        throw new Error('later execution failure');
      }),
    });
    const close = vi.fn();
    expect(await harness.context.window.__savedAppActions.create('private idea', close)).toBe(true);
    expect(harness.context.window.orkas.invoke).toHaveBeenCalledWith(
      'conversations.create', { title: 'private idea', assistance: { kind: 'app_creation' } },
    );
    expect(harness.context.sendInConversation).toHaveBeenCalledWith(
      'new-task', 'private idea', { title_text: 'private idea' }, expect.any(Object),
    );
    expect(close).toHaveBeenCalledOnce();
    expect(harness.context.conversations).toHaveLength(1);
    expect(harness.context.conversations[0]).toMatchObject({ conversation_id: 'new-task', processing: true });
    expect(harness.context.uiAlert).not.toHaveBeenCalled();
  });

  it('keeps a refused rename recoverable and hides private diagnostics', async () => {
    const harness = loadSavedApps(async (channel) => {
      if (channel === 'savedApps.rename') {
        return { ok: false, error: '/Users/test/private/saved_apps/secret-app' };
      }
      return { apps: [] };
    });

    await harness.context.window.__savedAppActions.rename('private-app-id');
    expect(harness.context.window.orkas.invoke).toHaveBeenCalledExactlyOnceWith('savedApps.rename',{appId:'private-app-id',title:'Renamed app'});
    expect(harness.context.uiAlert).toHaveBeenCalledOnce();
    const diagnostics = JSON.stringify(harness.warnings);
    expect(diagnostics).not.toContain('/Users/test');
    expect(diagnostics).not.toContain('private-app-id');
    expect(diagnostics).not.toContain('Renamed app');
  });

  it('keeps edit success when post-create navigation or draft presentation fails', async () => {
    const harness = loadSavedApps(async (channel) => {
      if (channel === 'savedApps.openForEditing') {
        return { ok: true, conversation: { conversation_id: 'private-conversation' } };
      }
      return { apps: [] };
    }, { presentationFailure: true });

    await harness.context.window.__savedAppActions.edit('private-app-id');
    expect(harness.context.window.orkas.invoke).toHaveBeenCalledExactlyOnceWith('savedApps.openForEditing',{appId:'private-app-id'});
    expect(harness.context.uiAlert).not.toHaveBeenCalled();
    expect(harness.warnings).toHaveLength(1);
    expect(JSON.stringify(harness.warnings)).not.toContain('/Users/test');
  });

  it('reuses an edit conversation already read by the sidebar while the edit receipt is pending', async () => {
    let releaseEdit!: (value: unknown) => void;
    const harness = loadSavedApps(() => new Promise((resolve) => { releaseEdit = resolve; }));
    Object.assign(harness.context, { conversations: [], renderConversationList: vi.fn(), setView: vi.fn() });
    const editing = harness.context.window.__savedAppActions.edit('fixture-app');
    const current = { conversation_id: 'edit-task', title: 'User renamed edit task', title_manually_set: true,
      created_at: '2026-05-15T09:00:00Z', updated_at: '2026-05-15T09:01:00Z',
      last_active_at: '2026-05-15T09:01:00Z', processing: false };
    harness.context._appendConversationSlice([current]);
    releaseEdit({ ok: true, conversation: { conversation_id: 'edit-task', title: 'Creation title',
      created_at: '2026-05-15T09:00:00Z', updated_at: '2026-05-15T09:00:00Z' } });
    await editing;
    expect(harness.context.conversations).toEqual([current]);
    expect(harness.context.setView).toHaveBeenCalledExactlyOnceWith('conversation', 'edit-task', { skipLoad: true });
    expect(harness.warnings).toEqual([]);
  });

  it('reports a failed open without exposing app identity or raw paths', async () => {
    const harness = loadSavedApps(async () => {
      throw new Error('/Users/test/private/saved_apps/app/index.html');
    });

    await harness.context.window.__savedAppActions.open('private-app-id');
    expect(harness.context.uiAlert).toHaveBeenCalledWith('Could not open the app');
    expect(harness.warnings).toHaveLength(1);
    expect(JSON.stringify(harness.warnings)).not.toMatch(/alice|private-app-id/);
  });

  it('opens or refocuses one native window per request and recovers from a window failure', async () => {
    const harness = loadSavedApps(async () => ({ ok: true }));
    const open = vi.fn(async () => ({ ok: true }));
    harness.context.window.OrkasPreviewWindows = { open };
    await harness.context.window.__savedAppActions.open('private-app-id');

    open.mockResolvedValueOnce({ ok: true, reused: true } as any);
    await harness.context.window.__savedAppActions.open('private-app-id');
    open.mockResolvedValueOnce({ ok: false } as any);
    await harness.context.window.__savedAppActions.open('private-app-id');
    expect(open).toHaveBeenCalledTimes(3);
    expect(harness.context.window.orkas.invoke).not.toHaveBeenCalled();
    expect(harness.warnings).toHaveLength(1);
  });

  it('separates edit saves, declined data migrations, and structured save rejections', async () => {
    const run = async (invoke: (channel: string, payload: any) => Promise<any>, confirm = { export: false, clear: true }) => {
      const context: any = {
        Date, Math, Object,
        window: { orkas: { invoke: vi.fn(invoke) } },
        _convLog: { warn: vi.fn() },
        _notifyFail: vi.fn(),
        _t: (_key: string, fallback: string) => fallback,
        uiConfirm: vi.fn(async () => confirm.export),
        uiConfirmDanger: vi.fn(async () => confirm.clear),
        uiToast: vi.fn(),
        loadSavedApps: vi.fn(),
      };
      vm.createContext(context);
      vm.runInContext(recoverySource, context);
      vm.runInContext([
        extractFunction(artifactSource, '_artifactSaveFailure'),
        extractFunction(artifactSource, '_logArtifactFailure'),
      extractFunction(artifactSource, '_logArtifactSaveFailure'),
        extractFunction(artifactSource, '_doSave'),
      ].join('\n'), context);
      await context._doSave({ cid: 'private-cid', artifactId: 'private-artifact', saveMode: 'update' });
      return context;
    };
    const migration = { ok: false, code: 'app_edit_data_migration', error: '/Users/test/private' };
    const impact = { ok: true, tables: [{ name: 'private_table', count: 2, fields: ['private_field'] }], version: 1, fingerprint: 'f' };
    const success = await run(async (channel) => (channel === 'conversations.artifacts.dataImpact' ? impact : { ok: true }));
    expect(success.loadSavedApps).toHaveBeenCalledOnce();
    const canceled = await run(async (channel) => (channel === 'conversations.artifacts.dataImpact' ? impact : migration), { export: false, clear: false });
    expect(canceled.loadSavedApps).not.toHaveBeenCalled(); expect(canceled._notifyFail).not.toHaveBeenCalled();
    const rejected = await run(async () => ({ ok: false, code: 'app_type_mismatch', error: 'Private message' }));
    expect(rejected.loadSavedApps).not.toHaveBeenCalled(); expect(rejected._notifyFail).toHaveBeenCalledOnce();
  });

  it('keeps artifact save success when toast presentation fails', async () => {
    const warnings: any[] = [];
    const context: any = {
      Date,
      Math,
      Object,
      window: { orkas: { invoke: vi.fn(async () => ({ ok: true })) } },
      _convLog: { warn: (_message: string, payload: any) => warnings.push(payload) },
      _notifyFail: vi.fn(),
      _t: (_key: string, fallback: string) => fallback,
      uiToast: () => { throw new Error('/Users/test/private/toast'); },
      loadSavedApps: vi.fn(),
    };
    vm.createContext(context);
    vm.runInContext(recoverySource, context);
  vm.runInContext(composerAccessorSource, context);
    vm.runInContext([
      extractFunction(artifactSource, '_artifactSaveFailure'),
      extractFunction(artifactSource, '_logArtifactFailure'),
      extractFunction(artifactSource, '_logArtifactSaveFailure'),
      extractFunction(artifactSource, '_doSave'),
    ].join('\n'), context);

    await context._doSave({ cid: 'private-cid', artifactId: 'private-artifact' });
    expect(context._notifyFail).not.toHaveBeenCalled();
    expect(context.window.orkas.invoke).toHaveBeenCalledOnce();
    expect(JSON.stringify(warnings)).not.toMatch(/alice|private-cid|private-artifact/);
  });

  it.each([false,true])('does not replay a file-preview save after cancellation or failed toast (canceled: %s)', async canceled => {
    const warnings: any[] = [];
    const context: any = {
      Date,
      Math,
      Object,
      _viewerRenderSeq: 1,
      _viewerCurrentPath: '/Users/test/private/app.html',
      _viewerCurrentCid: 'private-cid',
      _viewerCurrentProjectId: null,
      _viewerSaveAppBtn: { disabled: false, innerHTML: '' },
      _viewerDirty: false,
      _kindOf: () => 'html',
      _viewerLogFailure: (name: string, payload: any) => warnings.push({ name, payload }),
      _viewerShowAlert: vi.fn(),
      _viewerLabel: (_key: string, fallback: string) => fallback,
      _viewerSaveAppButtonHtml: () => '<button>',
      _setSaveAppVisible: vi.fn(),
      _viewerFileActionPayload: () => ({ path: '/Users/test/private/app.html' }),
      _scheduleSaveAppButtonRestore: vi.fn(),
      window: { orkas: { invoke: vi.fn(async () => ({ ok: true, canceled })) } },
      uiToast: () => { throw new Error('/Users/test/private/toast'); },
      loadSavedApps: vi.fn(),
    };
    vm.createContext(context);
    vm.runInContext(recoverySource, context);
  vm.runInContext(composerAccessorSource, context);
    vm.runInContext([
      extractFunction(fileViewerSource, '_viewerStableFailure'),
      extractFunction(fileViewerSource, '_viewerDurationSince'),
      extractFunction(fileViewerSource, '_onSaveAppClick'),
    ].join('\n'), context);

    await context._onSaveAppClick();
    expect(context.window.orkas.invoke).toHaveBeenCalledExactlyOnceWith('savedApps.saveFromPath',{path:'/Users/test/private/app.html'});
    expect(context._viewerShowAlert).not.toHaveBeenCalled();
    expect(warnings).toHaveLength(canceled?0:1);
    expect(JSON.stringify(warnings)).not.toContain('/Users/test');
  });

  it('does not replay a completed Library import when its button presentation fails', async () => {
    const warnings: any[] = [];
    const button: any = { disabled: false };
    Object.defineProperty(button, 'innerHTML', {
      get: () => '',
      set: () => { throw new Error('/Users/test/private/button'); },
    });
    const context: any = {
      Date,
      Math,
      Object,
      _viewerRenderSeq: 1,
      _viewerCurrentPath: '/Users/test/private/note.md',
      _viewerCurrentCid: 'private-cid',
      _viewerCurrentProjectId: null,
      _viewerLibraryProjectScoped: false,
      _viewerAddLibraryBtn: button,
      _viewerCanAddToLibrary: () => true,
      _kindOf: () => 'markdown',
      _viewerLogFailure: (name: string, payload: any) => warnings.push({ name, payload }),
      _viewerShowAlert: vi.fn(),
      _viewerLabel: (_key: string, fallback: string) => fallback,
      _viewerAddLibraryButtonHtml: () => '<button>',
      _scheduleAddLibraryButtonRestore: vi.fn(),
      window: { orkas: { invoke: vi.fn(async () => ({ ok: true, scope: 'global' })) } },
      currentView: 'contexts',
      loadContexts: vi.fn(),
    };
    vm.createContext(context);
    vm.runInContext(recoverySource, context);
  vm.runInContext(composerAccessorSource, context);
    vm.runInContext([
      extractFunction(fileViewerSource, '_viewerStableFailure'),
      extractFunction(fileViewerSource, '_viewerDurationSince'),
      extractFunction(fileViewerSource, '_onAddLibraryClick'),
    ].join('\n'), context);

    await context._onAddLibraryClick();
    expect(context.window.orkas.invoke).toHaveBeenCalledExactlyOnceWith('library.importProduced',{path:'/Users/test/private/note.md',cid:'private-cid'});
    expect(context._viewerShowAlert).not.toHaveBeenCalled();
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings)).not.toContain('/Users/test');
  });

  it.each([false,true])('does not replay a conversation save after cancellation or failed toast (canceled: %s)', async canceled => {
    const warnings: any[] = [];
    const context: any = {
      Date,
      Math,
      Object,
      window: {
        orkas: { invoke: vi.fn(async () => ({ ok: true, canceled })) },
      },
      _infoLog: { warn: (_message: string, payload: any) => warnings.push(payload) },
      _fileActionPayload: () => ({ path: '/Users/test/private/app.html' }),
      _label: (_key: string, fallback: string) => fallback,
      uiToast: () => { throw new Error('/Users/test/private/toast'); },
      loadSavedApps: vi.fn(),
    };
    vm.createContext(context);
    vm.runInContext(recoverySource, context);
  vm.runInContext(composerAccessorSource, context);
    vm.runInContext([
      extractFunction(conversationInfoSource, '_baseName'),
      extractFunction(conversationInfoSource, '_extForName'),
      extractFunction(conversationInfoSource, '_savedAppSaveFailure'),
      extractFunction(conversationInfoSource, '_logSavedAppSaveFailure'),
      extractFunction(conversationInfoSource, '_saveEntryAsApp'),
    ].join('\n'), context);

    await context._saveEntryAsApp('/Users/test/private/app.html', 'private-cid', 'file');
    expect(context.window.orkas.invoke).toHaveBeenCalledExactlyOnceWith('savedApps.saveFromPath',{path:'/Users/test/private/app.html'});
    expect(warnings).toHaveLength(canceled?0:1);
    expect(JSON.stringify(warnings)).not.toMatch(/alice|private-cid/);
  });
});

describe('Save-as-App failure alerts', () => {
  // Raw IPC/main errors can carry absolute local paths and English internals;
  // the user sees only the localized action copy, and logs stay code-only.
  const localeTable = (lang: string) => JSON.parse(readFileSync(resolve(modulesDir, `../locales/${lang}.json`), 'utf8'));
  const privateDetail = '/Users/test/private/project/app.html: EACCES permission denied';
  const outcomes = [
    ['rejected', async () => { throw new Error(privateDetail); }],
    ['refused', async () => ({ ok: false, error: privateDetail })],
    ['root_refused', async () => ({ ok: false, error: 'app_bundle_root' })],
  ] as const;
  const cases = (['zh', 'en'] as const).flatMap(lang => outcomes.map(([mode, invoke]) => [lang, mode, invoke] as const));

  it.each(cases)('file preview shows only "%s" save failure copy when the save is %s', async (lang, _mode, invoke) => {
    const table = localeTable(lang);
    const alerts: string[] = [];
    const warnings: any[] = [];
    const context: any = {
      Date, Math, Object, String,
      t: (key: string) => table[key] || key,
      _viewerRenderSeq: 1,
      _viewerCurrentPath: '/Users/test/private/project/app.html',
      _viewerSaveAppBtn: { disabled: false, innerHTML: '' },
      _viewerDirty: false,
      _kindOf: () => 'html',
      _viewerLogFailure: (name: string, payload: any) => warnings.push({ name, payload }),
      _viewerShowAlert: async (message: string) => { alerts.push(message); },
      _viewerSaveAppButtonHtml: () => '<button>',
      _setSaveAppVisible: () => {},
      _viewerFileActionPayload: () => ({ path: '/Users/test/private/project/app.html' }),
      _scheduleSaveAppButtonRestore: () => {},
      window: { orkas: { invoke: vi.fn(invoke) } },
    };
    vm.createContext(context);
    vm.runInContext(recoverySource, context);
    vm.runInContext([
      extractFunction(fileViewerSource, '_viewerLabel'),
      extractFunction(fileViewerSource, '_viewerStableFailure'),
      extractFunction(fileViewerSource, '_viewerDurationSince'),
      extractFunction(fileViewerSource, '_onSaveAppClick'),
    ].join('\n'), context);

    await context._onSaveAppClick();

    expect(alerts).toEqual([table[_mode === 'root_refused' ? 'apps.save_root_folder_required' : 'apps.save_failed']]);
    expect(JSON.stringify(warnings)).not.toContain('/Users/');
    expect(JSON.stringify(warnings)).not.toContain('EACCES');
  });

  it.each(cases)('conversation info shows only "%s" save failure copy when the save is %s', async (lang, _mode, invoke) => {
    const table = localeTable(lang);
    const alerts: string[] = [];
    const warnings: any[] = [];
    const context: any = {
      Date, Math, Object, String,
      t: (key: string) => table[key] || key,
      window: {orkas:{invoke:vi.fn(invoke)}},
      _infoLog: { warn: (_message: string, payload: any) => warnings.push(payload) },
      _fileActionPayload: () => ({ path: '/Users/test/private/project/app.html' }),
      uiAlert: async (message: string) => { alerts.push(message); },
    };
    vm.createContext(context);
    vm.runInContext(recoverySource, context);
    vm.runInContext([
      extractFunction(conversationInfoSource, '_label'),
      extractFunction(conversationInfoSource, '_baseName'),
      extractFunction(conversationInfoSource, '_extForName'),
      extractFunction(conversationInfoSource, '_savedAppSaveFailure'),
      extractFunction(conversationInfoSource, '_logSavedAppSaveFailure'),
      extractFunction(conversationInfoSource, '_saveEntryAsApp'),
    ].join('\n'), context);

    await context._saveEntryAsApp('/Users/test/private/project/app.html', 'private-cid', 'file');

    expect(alerts).toEqual([table[_mode === 'root_refused' ? 'apps.save_root_folder_required' : 'apps.save_failed']]);
    expect(JSON.stringify(warnings)).not.toContain('/Users/');
  });
});
