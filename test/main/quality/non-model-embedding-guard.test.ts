import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import * as ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const source = fs.readFileSync(path.resolve('test/e2e/fixtures/non-model-embedding-guard.cjs'), 'utf8');
const directory = path.resolve(os.tmpdir(), 'orkas-model-guard-receipts');

function fixture(options: { enabled?: boolean; electron?: boolean; directory?: string; writable?: boolean; quitObservable?: boolean; parentPid?: number } = {}) {
  const result = { process: 'unrelated-worker' };
  const original = vi.fn(function (this: unknown, ..._args: unknown[]) { return result; });
  const utilityProcess = { fork: original };
  const app = new EventEmitter();
  const receipts: Array<{ file: string; body: string }> = [];
  const mkdirSync = vi.fn();
  const writeFileSync = vi.fn((file: string, body: string) => {
    if (options.writable === false) throw new Error('Fixture receipt storage unavailable');
    receipts.push({ file, body });
  });
  const requireModule = vi.fn((name: string) => {
    if (name === 'node:fs') return { mkdirSync, writeFileSync };
    if (name === 'node:path') return path;
    if (name === 'node:crypto') return { randomUUID: () => 'bff631db-bb07-4f0e-8e01-00714bcab67d' };
    if (name === 'electron') return options.electron === false ? {} : { utilityProcess, app: options.quitObservable === false ? {} : app };
    throw new Error('Unexpected module');
  });
  const context = vm.createContext({
    process: { pid: 123, ppid: options.parentPid ?? 100, versions: { electron: '42.11.18' }, env: {
      ORKAS_E2E_FORBID_REAL_EMBEDDING: options.enabled === false ? '0' : '1',
      ORKAS_E2E_MODEL_GUARD_LOG_DIR: options.directory ?? directory,
    } },
    require: requireModule,
  });
  return { context, app, utilityProcess, original, result, receipts, mkdirSync, writeFileSync,
    emitQuit: (code: number) => app.emit('quit', {}, code),
    requireModule, install: () => vm.runInContext(source, context) };
}

describe('non-model native embedding admission', () => {
  it('preserves the ordinary E2E fixture when the explicit policy is disabled', () => {
    const test = fixture({ enabled: false });
    test.install();
    expect(test.requireModule).not.toHaveBeenCalled();
    expect(test.utilityProcess.fork).toBe(test.original);
    expect(test.receipts).toEqual([]);
    expect(test.context.__ORKAS_NON_MODEL_GUARD).toBeUndefined();
  });

  it('rejects real embedding workers before dispatch on portable native paths', () => {
    const test = fixture();
    test.install();
    for (const worker of ['kb-embed-worker.cjs', '/fixtures/kb-embed-worker.cjs', 'C:\\fixtures\\KB-EMBED-WORKER.CJS']) {
      expect(() => test.utilityProcess.fork(worker)).toThrow('Real embedding is prohibited');
    }
    expect(test.original).not.toHaveBeenCalled();
    expect(test.context.__ORKAS_NON_MODEL_GUARD).toMatchObject({ installed: true, denied: 3 });
    expect(JSON.parse(test.receipts.at(-1)!.body)).toMatchObject({
      version: 2, pid: 123, parent_pid: 100, quit_observed: false, installed: true, denied: 1, denied_count_is_lower_bound: true,
    });
  });

  it('forwards unrelated workers with their exact arguments, receiver and result', () => {
    const test = fixture();
    test.install();
    const args = ['--fixture'];
    const options = { env: { FIXTURE: '1' } };
    const receiver = { fixture: true };
    const result = Reflect.apply(test.utilityProcess.fork, receiver, ['file-reader.cjs', args, options]);
    expect(result).toBe(test.result);
    expect(test.original).toHaveBeenCalledExactlyOnceWith('file-reader.cjs', args, options);
    expect(test.original.mock.contexts[0]).toBe(receiver);
    expect(test.context.__ORKAS_NON_MODEL_GUARD).toMatchObject({ denied: 0 });
  });

  it.each([false, true])('blocks the actual production embedding dispatch before a worker starts (packaged=%s)', packaged => {
    const test = fixture();
    Object.assign(test.app, { isPackaged: packaged });
    test.install();
    const production = fs.readFileSync(path.resolve('src/main/features/kb_embed.ts'), 'utf8');
    const parsed = ts.createSourceFile('kb_embed.ts', production, ts.ScriptTarget.Latest, true);
    const factories = parsed.statements.filter(ts.isFunctionDeclaration)
      .filter(node => node.name?.text === '_defaultChannelFactory');
    expect(factories).toHaveLength(1);
    // Execute the real dispatch owner with only its local path dependencies.
    // A renamed or different worker route must fail this safety boundary case.
    Object.assign(test.context, { path, PC_ROOT: path.resolve('fixture', 'app.asar'),
      embeddingModelDir: () => path.resolve('fixture', 'unread-model-cache') });
    vm.runInContext(ts.transpileModule(`globalThis.__productionFactory = ${factories[0].getText(parsed)};`, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, test.context);
    let error: unknown;
    try { test.context.__productionFactory(); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: 'ORKAS_NON_MODEL_EMBEDDING_DENIED' });
    expect(test.original).not.toHaveBeenCalled();
    expect(test.context.__ORKAS_NON_MODEL_GUARD).toMatchObject({ denied: 1 });
  });

  it('bounds receipt I/O during repeated denied work without allowing a dispatch', () => {
    const test = fixture();
    test.install();
    for (let attempt = 0; attempt < 100; attempt++) {
      expect(() => test.utilityProcess.fork('kb-embed-worker.cjs')).toThrow();
    }
    expect(test.context.__ORKAS_NON_MODEL_GUARD).toMatchObject({ denied: 100 });
    expect(test.writeFileSync).toHaveBeenCalledTimes(2);
    expect(test.mkdirSync).toHaveBeenCalledTimes(2);
    expect(test.receipts.every(receipt => path.dirname(receipt.file) === directory)).toBe(true);
    expect(test.original).not.toHaveBeenCalled();
  });

  it('records the actual parent and terminal outcome without fabricating a clean exit', () => {
    const test = fixture();
    test.install();
    expect(JSON.parse(test.receipts[0].body)).toMatchObject({
      version: 2, pid: 123, parent_pid: 100, quit_observed: false,
    });
    expect(() => test.utilityProcess.fork('kb-embed-worker.cjs')).toThrow();
    test.emitQuit(2);
    test.emitQuit(0);
    expect(test.writeFileSync).toHaveBeenCalledTimes(3);
    expect(JSON.parse(test.receipts.at(-1)!.body)).toMatchObject({
      parent_pid: 100, quit_observed: true, exit_code: 2, denied: 1,
    });
    expect(test.original).not.toHaveBeenCalled();
  });

  it.each([{ electron: false }, { directory: 'relative-receipts' }, { writable: false },
    { quitObservable: false }, { parentPid: 0 }])(
    'fails closed when it cannot establish the guard and its evidence: %o', (options) => {
      const test = fixture(options);
      expect(test.install).toThrow();
      expect(test.original).not.toHaveBeenCalled();
      expect(test.context.__ORKAS_NON_MODEL_GUARD).toBeUndefined();
    },
  );
});
