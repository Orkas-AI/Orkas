import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import * as ts from 'typescript';
import { createShutdownCoordinator } from '../../../src/main/util/shutdown';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

describe('application shutdown durability and latency', () => {
  it('restores admission only after failed shutdown cleanup and before allowing retry', async () => {
    const events: string[] = [];
    const terminate = vi.fn().mockRejectedValueOnce(new Error('controlled failure')).mockResolvedValue(undefined);
    const shutdown = createShutdownCoordinator({
      captureProcesses: async () => ({ terminate, dispose: () => { events.push('disposed'); } }),
      quiesce: async () => { events.push('stopped'); },
      localTasks: [{ name: 'close', run: () => { events.push('closed'); } }],
      onFailure: vi.fn(),
      onIncomplete: async () => { events.push('resumed'); },
    });
    await expect(shutdown.prepare()).rejects.toMatchObject({ code: 'E_SHUTDOWN_PROCESSES_FAILED' });
    expect(events).toEqual(['stopped', 'closed', 'disposed', 'resumed']);
    await shutdown.prepare();
    expect(shutdown.complete).toBe(true);
    expect(events.filter(e => e === 'resumed')).toHaveLength(1);
  });
  it.each(['quit', 'relaunch'] as const)('runs the real app shutdown wiring for CLI, Office, workers and browser persistence: %s', async mode => {
    // Execute the production composition without booting Electron or touching
    // a real account. This catches an omitted owner in index.ts, not just a
    // correctly behaving coordinator used with a test-only list of owners.
    const source = fs.readFileSync(path.resolve('src/main/index.ts'), 'utf8');
    const parsed = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
    const compositions: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'createShutdownCoordinator') compositions.push(node.getText(parsed));
      ts.forEachChild(node, visit);
    };
    visit(parsed);
    expect(compositions).toHaveLength(1);
    const archived = gate();
    const browserSaved = gate();
    const lifecycleSaved = gate();
    const appDataDrained = gate();
    const exited = gate();
    const events: string[] = [];
    const mark = (name: string) => () => { events.push(name); };
    const dependencies: Record<string, unknown> = {
      './util/boot_init': { stopBootWork: mark('boot-work') },
      './features/library_corpus': { closeAllLibraryCorpora: mark('library-owners') },
      './features/local_agents/runner.js': { stopBackgroundRuns: mark('background-cli') },
      './features/kb_vector': { closeAllKb: mark('kb-database') },
      './features/kb_embed': { closeEmbedder: mark('embed-worker') },
      './util/sharp-runtime': { closeImageRuntime: mark('image-worker') },
      './util/office-extract': { closeOfficeExtraction: mark('office-extract') },
      './features/office/office_engine': { closeAllOfficeResidents: mark('office') },
      './features/web_assist_session': { flushWebAssistSessions: () => { events.push('browser-save'); return browserSaved.promise; } },
      './features/web_apps/host': { runtime: {
        closeUser: (uid: string) => { expect(uid).toBe('isolated-owner'); events.push('app-close'); },
        drainData: () => { events.push('app-databases'); return appDataDrained.promise; },
      } },
    };
    const mod = { exports: {} as ReturnType<typeof createShutdownCoordinator> };
    vm.runInNewContext(ts.transpileModule(`module.exports = ${compositions[0]};`, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, {
      module: mod, createShutdownCoordinator,
      require: (name: string) => { if (!(name in dependencies)) throw new Error(`Uncontrolled shutdown dependency: ${name}`); return dependencies[name]; },
      captureWindowsShutdownProcesses: async () => {
        events.push('capture');
        return { terminate: () => { events.push('terminate'); return exited.promise; }, dispose: mark('dispose') };
      },
      prepareForShutdown: () => { events.push('archive'); return archived.promise; },
      connectorsFeature: { shutdown: mark('connectors') },
      searchFeature: { flushAll: mark('search-workers') },
      openLifecycleTracking: { flushQuit: () => { events.push('open-lifecycle'); return lifecycleSaved.promise; } },
      users: { getActiveUserId: () => 'isolated-owner' },
      createLogger: (name: string) => ({ warn: mark(`failure:${name}`) }),
    });
    const shutdown = mod.exports;
    const pending = shutdown.prepare(mode);
    expect(shutdown.prepare(mode)).toBe(pending);
    await vi.waitFor(() => expect(events).toContain('background-cli'));
    expect(events).toEqual(mode === 'quit' ? ['capture', 'archive', 'background-cli'] : ['archive', 'background-cli']);
    archived.release();
    await vi.waitFor(() => expect(events).toContain('browser-save'));
    expect(events.indexOf('library-owners')).toBeLessThan(events.indexOf('kb-database'));
    expect(events.indexOf('library-owners')).toBeLessThan(events.indexOf('embed-worker'));
    expect(events.indexOf('boot-work')).toBeLessThan(events.indexOf('library-owners'));
    expect(events).not.toContain('terminate');
    expect(shutdown.complete).toBe(false);
    browserSaved.release();
    await Promise.resolve();
    expect(shutdown.complete).toBe(false);
    expect(events).not.toContain('terminate');
    lifecycleSaved.release();
    await Promise.resolve();
    expect(shutdown.complete).toBe(false);
    expect(events).not.toContain('terminate');
    expect(events.indexOf('app-close')).toBeLessThan(events.indexOf('app-databases'));
    appDataDrained.release();
    if (mode === 'quit') {
      await vi.waitFor(() => expect(events).toContain('terminate'));
      expect(shutdown.complete).toBe(false);
      expect(events.indexOf('app-databases')).toBeLessThan(events.indexOf('terminate'));
      expect(events.indexOf('open-lifecycle')).toBeLessThan(events.indexOf('terminate'));
      exited.release();
    }
    await pending;
    const owners = ['archive', 'background-cli', 'boot-work', 'library-owners', 'connectors', 'search-workers', 'kb-database', 'embed-worker', 'image-worker', 'office-extract', 'office', 'browser-save', 'open-lifecycle', 'app-close', 'app-databases'];
    expect([...events].sort()).toEqual([...owners, ...(mode === 'quit' ? ['capture', 'terminate', 'dispose'] : [])].sort());
    expect(shutdown.complete).toBe(true);
  });

  it('pins owned processes before stopping producers and confirms their exit before installer handoff', async () => {
    const exited = gate();
    const order: string[] = [];
    const shutdown = createShutdownCoordinator({
      captureProcesses: async () => {
        order.push('capture');
        return { terminate: async () => { order.push('terminate'); await exited.promise; }, dispose: () => { order.push('dispose'); } };
      },
      quiesce: async () => { order.push('archive'); },
      localTasks: [{ name: 'connectors', run: () => { order.push('connectors'); } }],
      onFailure: vi.fn(),
    });
    const pending = shutdown.prepare();
    await vi.waitFor(() => expect(order).toContain('terminate'));
    expect(order).toEqual(['capture', 'archive', 'connectors', 'terminate']);
    expect(shutdown.complete).toBe(false);
    exited.release();
    await pending;
    expect(shutdown.complete).toBe(true);
    expect(order.at(-1)).toBe('dispose');
  });

  it.each(['capture', 'terminate'])('blocks handoff after a process %s failure and allows a successful retry', async phase => {
    const dispose = vi.fn();
    const terminate = vi.fn().mockResolvedValue(undefined);
    if (phase === 'terminate') terminate.mockRejectedValueOnce(new Error('access denied'));
    const captureProcesses = vi.fn().mockResolvedValue({ terminate, dispose });
    if (phase === 'capture') captureProcesses.mockRejectedValueOnce(new Error('PowerShell unavailable'));
    const archive = vi.fn();
    const shutdown = createShutdownCoordinator({
      captureProcesses, quiesce: archive,
      localTasks: [], onFailure: vi.fn(),
    });
    await expect(shutdown.prepare()).rejects.toMatchObject({ code: 'E_SHUTDOWN_PROCESSES_FAILED' });
    expect(shutdown.complete).toBe(false);
    expect(archive).toHaveBeenCalledTimes(phase === 'capture' ? 0 : 1);
    expect(dispose).toHaveBeenCalledTimes(phase === 'capture' ? 0 : 1);
    await shutdown.prepare();
    expect(shutdown.complete).toBe(true);
    expect(captureProcesses).toHaveBeenCalledTimes(2);
    expect(terminate).toHaveBeenCalledTimes(phase === 'capture' ? 1 : 2);
    expect(dispose).toHaveBeenCalledTimes(phase === 'capture' ? 1 : 2);
  });

  it('releases process identities without killing work when archival fails', async () => {
    const terminate = vi.fn();
    const dispose = vi.fn();
    const shutdown = createShutdownCoordinator({
      captureProcesses: async () => ({ terminate, dispose }),
      quiesce: async () => { throw new Error('save failed'); },
      localTasks: [], onFailure: vi.fn(),
    });
    await expect(shutdown.prepare()).rejects.toMatchObject({ code: 'E_SHUTDOWN_ARCHIVE_FAILED' });
    expect(terminate).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('archives active work before closing dependencies', async () => {
    const archived = gate();
    const order: string[] = [];
    const shutdown = createShutdownCoordinator({
      quiesce: async () => { order.push('stop'); await archived.promise; order.push('archived'); },
      localTasks: [{ name: 'office', run: () => { order.push('office'); } }],
      onFailure: vi.fn(),
    });
    const pending = shutdown.prepare();
    await Promise.resolve();
    expect(order).toEqual(['stop']);
    archived.release();
    await pending;
    expect(order).toEqual(['stop', 'archived', 'office']);
  });

  it('keeps exit incomplete after an archival failure and retries without closing dependencies', async () => {
    const quiesce = vi.fn().mockRejectedValueOnce(new Error('controlled save failure')).mockResolvedValue(undefined);
    const close = vi.fn();
    const shutdown = createShutdownCoordinator({ quiesce, localTasks: [{ name: 'office', run: close }], onFailure: vi.fn() });
    await expect(shutdown.prepare()).rejects.toMatchObject({ code: 'E_SHUTDOWN_ARCHIVE_FAILED', cause: new Error('controlled save failure') });
    expect(shutdown.complete).toBe(false);
    expect(close).not.toHaveBeenCalled();
    await shutdown.prepare();
    expect(close).toHaveBeenCalledOnce();
    expect(shutdown.complete).toBe(true);
  });

  it('coalesces a quit emitted synchronously by local cleanup', async () => {
    let reentered: Promise<void> | undefined;
    let calls = 0;
    const shutdown = createShutdownCoordinator({
      localTasks: [{ name: 'local', run: () => {
        if (++calls === 1) reentered = shutdown.prepare();
      } }], onFailure: vi.fn(),
    });
    const pending = shutdown.prepare();
    await pending;
    expect(calls).toBe(1);
    expect(reentered).toBe(pending);
  });

  it('finishes independent local saves together before normal exit', async () => {
    const search = gate();
    const browser = gate();
    const started: string[] = [];
    const shutdown = createShutdownCoordinator({
      localTasks: [
        { name: 'search', run: () => { started.push('search'); return search.promise; } },
        { name: 'browser', run: () => { started.push('browser'); return browser.promise; } },
      ], onFailure: vi.fn(),
    });
    const pending = shutdown.prepare();
    await Promise.resolve();
    expect(started).toEqual(['search', 'browser']);
    search.release();
    await Promise.resolve();
    expect(shutdown.complete).toBe(false);
    browser.release();
    await pending;
    expect(shutdown.complete).toBe(true);
  });


  it('drains remaining local saves and reports a failed cleanup once', async () => {
    const saved = gate();
    const onFailure = vi.fn();
    const shutdown = createShutdownCoordinator({
      localTasks: [
        { name: 'broken', run: () => { throw new Error('controlled failure'); } },
        { name: 'browser', run: () => saved.promise },
      ], onFailure,
    });
    const pending = shutdown.prepare();
    await Promise.resolve();
    expect(shutdown.complete).toBe(false);
    saved.release();
    await pending;
    expect(onFailure).toHaveBeenCalledExactlyOnceWith('broken');
    expect(shutdown.complete).toBe(true);
  });

});


it('revokes the critical phase during failed cleanup before a retry is admitted', async () => {
  const entered = gate(), resume = gate();
  const terminate = vi.fn().mockRejectedValueOnce(new Error('controlled termination failure')).mockResolvedValue(undefined);
  const shutdown = createShutdownCoordinator({
    captureProcesses: async () => ({ terminate, dispose() {} }),
    quiesce: async () => {}, localTasks: [], onFailure: vi.fn(),
    onIncomplete: async () => { entered.release(); await resume.promise; },
  });
  const failure = shutdown.prepare().catch(error => error);
  try {
    await entered.promise;
    expect((shutdown as any).quiescent).toBe(false);
  } finally { resume.release(); await failure; }
  await shutdown.prepare();
  expect((shutdown as any).quiescent).toBe(true);
  expect(shutdown.complete).toBe(true);
});
