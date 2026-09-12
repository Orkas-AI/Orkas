import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { bundledNodeExecutable } from '../../../src/main/util/bundled-runtime';

const { createSharpClient, probeImageRuntime, processImage } = require('../../../bin/sharp-worker.cjs');
const worker = path.join(process.cwd(), 'bin/sharp-worker.cjs');
const node = bundledNodeExecutable();
const clients: Array<{ close(): void }> = [];
const children: ChildProcess[] = [];
const temporary: string[] = [];
const input = (width = 4, height = 3) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#14283c"/></svg>`);

function client(options: Record<string, unknown> = {}) {
  const instance = createSharpClient({ nodeExecutable: node, workerPath: worker,
    spawn: (...args: Parameters<typeof fork>) => { const child = fork(...args); children.push(child); return child; },
    ...options });
  clients.push(instance);
  return instance;
}

function fixture(source: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-image-worker-'));
  temporary.push(root);
  const file = path.join(root, 'worker.cjs');
  fs.writeFileSync(file, source);
  return file;
}

afterEach(async () => {
  const exiting = children.filter(c => c.exitCode === null && c.signalCode === null)
    .map(c => once(c, 'exit').catch(() => undefined));
  for (const instance of clients.splice(0)) instance.close();
  await Promise.all(exiting);
  children.splice(0);
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('isolated bundled-Node image processing', () => {
  it('preserves image dimensions and format across concurrent calls in a reused process', async () => {
    expect(node).toBeTruthy();
    const images = client();
    const results = await Promise.all([3, 7, 11].map(width => images.request('encode', input(width, 5), { format: 'png' })));
    for (const [index, result] of results.entries()) {
      expect(result.data.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(result.data.readUInt32BE(16)).toBe([3, 7, 11][index]);
      expect(result.data.readUInt32BE(20)).toBe(5);
      expect(await images.request('metadata', result.data)).toMatchObject({ format: 'png', height: 5 });
    }
    expect(children).toHaveLength(1);
    for (const format of ['jpeg', 'webp']) {
      const result = await images.request('encode', input(), { format });
      expect(await images.request('metadata', result.data)).toMatchObject({ format, width: 4, height: 3 });
    }
  });

  it('surfaces invalid images and remains usable without restarting or replaying the failed request', async () => {
    const images = client();
    await expect(images.request('metadata', Buffer.from('not-an-image'))).rejects.toThrow('E_IMAGE_PROCESS');
    expect(await images.request('metadata', input())).toMatchObject({ width: 4, height: 3 });
    expect(children).toHaveLength(1);
  });

  it('fails before spawning when the bundled Node runtime is missing', async () => {
    const spawn = vi.fn();
    await expect(client({ nodeExecutable: undefined, spawn }).request('metadata', input())).rejects.toThrow(/E_IMAGE_RUNTIME_MISSING.*reinstall/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    ['crash', "process.on('message', () => process.exit(9));", 'E_IMAGE_RUNTIME_EXIT'],
    ['timeout', "process.on('message', () => {});", 'E_IMAGE_RUNTIME_TIMEOUT'],
  ])('rejects a %s without automatic replay, then recovers on a new caller request', async (_name, source, code) => {
    const broken = fixture(source);
    let starts = 0;
    const images = client({ timeoutMs: 2000, spawn: (_file: string, args: string[], options: Parameters<typeof fork>[2]) => {
      const child = fork(starts++ === 0 ? broken : worker, args, options);
      children.push(child);
      return child;
    } });
    await expect(images.request('metadata', input())).rejects.toThrow(code);
    expect(starts).toBe(1);
    expect(await images.request('metadata', input())).toMatchObject({ width: 4, height: 3 });
    expect(starts).toBe(2);
  });

  it('never loads sharp in the Electron caller', async () => {
    expect(process.versions.electron).toBeTruthy();
    await expect(processImage('metadata', input())).rejects.toThrow('E_IMAGE_RUNTIME_ELECTRON');
  });

  it('reports a native warning without private text or discarding a valid image', async () => {
    const onDiagnostic = vi.fn();
    const images = client({ onDiagnostic, workerPath: fixture("process.on('message', msg => { process.stderr.write('/private/image.png: native warning'); setTimeout(() => process.send({id:msg.id,ok:true,result:{format:'png',width:4,height:3}}), 25); });") });
    expect(await images.request('metadata', input())).toMatchObject({ width: 4 });
    expect(await images.request('metadata', input())).toMatchObject({ width: 4 });
    expect(onDiagnostic).toHaveBeenCalledExactlyOnceWith();
  });

  it('rejects an incomplete success response instead of accepting an empty image', async () => {
    const images = client({ workerPath: fixture("process.on('message', msg => process.send({id:msg.id,ok:true,result:{}}));") });
    await expect(images.request('encode', input(), { format: 'png' })).rejects.toThrow('E_IMAGE_PROCESS');
  });

  it('releases an idle process and starts a fresh worker for the next image', async () => {
    const images = client({ idleMs: 30 });
    expect(await images.request('metadata', input())).toMatchObject({ width: 4 });
    await once(children[0], 'exit');
    expect(await images.request('metadata', input(8))).toMatchObject({ width: 8 });
    expect(children).toHaveLength(2);
  });

  it('rejects pending work when the application closes the worker', async () => {
    const images = client({ workerPath: fixture("process.on('message', () => {});") });
    const result = images.request('metadata', input());
    const rejected = expect(result).rejects.toThrow('E_IMAGE_RUNTIME_CLOSED');
    images.close();
    await rejected;
  });

  it('loads the shipped dependency closure beside app.asar without checkout or Electron resolution', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-packaged-image-'));
    temporary.push(root);
    const unpacked = path.join(root, 'app.asar.unpacked');
    const entry = path.join(unpacked, 'bin', 'sharp-worker.cjs');
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.copyFileSync(worker, entry);
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    const gate = require('../../../bin/packaged-entrypoint-gate.cjs');
    for (const glob of gate.PACKAGED_IMAGE_RUNTIME_UNPACK_GLOBS) {
      expect(pkg.build.files).toContain(glob);
      expect(pkg.build.asarUnpack).toContain(glob);
      const relative = glob.slice(0, -5);
      fs.cpSync(path.join(process.cwd(), relative), path.join(unpacked, relative), { recursive: true });
    }
    expect(probeImageRuntime(node, entry)).toMatchObject({ status: 'passed', sharp: 'png-2x2', electron: null, arch: process.arch });
    fs.rmSync(path.join(unpacked, 'node_modules', '@img'), { recursive: true });
    expect(() => probeImageRuntime(node, entry)).toThrow(/E_IMAGE_RUNTIME_VERIFY.*reinstall/);
  });

  it.each(['files', 'asarUnpack'])('rejects an incomplete image dependency closure in build.%s', field => {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    const gate = require('../../../bin/packaged-entrypoint-gate.cjs');
    for (const glob of gate.PACKAGED_IMAGE_RUNTIME_UNPACK_GLOBS) {
      const build = { ...pkg.build, [field]: pkg.build[field].filter((value: string) => value !== glob) };
      expect(() => gate.verifyBuildFilesConfig(build)).toThrow('must include');
    }
  });

  it('keeps every application sharp import behind the isolated image boundary', () => {
    const offenders: string[] = [];
    function visitFiles(directory: string) {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) visitFiles(file);
        else if (/\.(ts|js|mjs|cjs)$/.test(entry.name)) {
          const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
          function visit(node: ts.Node) {
            if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
              && node.moduleSpecifier.text === 'sharp' && !node.importClause?.isTypeOnly) offenders.push(file);
            if (ts.isCallExpression(node) && node.arguments.length && ts.isStringLiteral(node.arguments[0])
              && node.arguments[0].text === 'sharp'
              && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) offenders.push(file);
            ts.forEachChild(node, visit);
          }
          visit(source);
        }
      }
    }
    visitFiles(path.join(process.cwd(), 'src/main'));
    expect(offenders.map(file => path.relative(process.cwd(), file))).toEqual([]);
  });
});
