import { fork, spawnSync, type ChildProcess } from 'node:child_process';
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
  for (const dir of temporary.splice(0)) {
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    expect(fs.existsSync(dir), 'image fixture cleanup must remove the whole tree').toBe(false);
  }
});

describe('isolated bundled-Node image processing', () => {
  it('compares bounded PSD candidates in stock Node without accepting a different preview', async () => {
    const images = client();
    const { writePsdBuffer } = require('ag-psd');
    const imageData = { width: 4, height: 3, data: new Uint8ClampedArray(Array.from({ length: 12 }, () => [20, 40, 60, 255]).flat()) };
    const psd = writePsdBuffer({ width: 4, height: 3, imageData, children: [{ name: 'Base', imageData }] }, { noBackground: true });
    expect(await images.request('psd-check', psd, { canvas: { width: 4, height: 3 }, reference: input(4, 3) })).toEqual({ matches: true });
    expect(await images.request('psd-check', psd, { canvas: { width: 4, height: 3 }, reference: Buffer.from('<svg width="4" height="3"><rect width="4" height="3" fill="red"/></svg>') })).toEqual({ matches: false });
    await expect(images.request('psd-check', Buffer.from('not PSD'), { canvas: { width: 4, height: 3 }, reference: input(4, 3) })).rejects.toThrow('E_IMAGE_PROCESS');
    await expect(images.request('psd-check', psd, { canvas: { width: 8192, height: 8192 }, reference: input(4, 3) })).rejects.toThrow('E_IMAGE_PROCESS');
  });
  it('masks private screenshot pixels before cropping and resizing in stock Node', async () => {
    const images = client();
    const masked = await images.request('encode', input(12, 6), {
      format: 'png', composite: [{ input: Buffer.from('<svg width="12" height="6"><rect width="6" height="6" fill="black"/></svg>') }],
    });
    const cropped = await images.request('encode', masked.data, {
      format: 'png', extract: { left: 4, top: 0, width: 4, height: 6 },
    });
    const resized = await images.request('encode', cropped.data, {
      format: 'png', resize: { width: 8, height: 12, fit: 'inside', withoutEnlargement: false },
    });
    expect(resized.info).toMatchObject({ width: 8, height: 12 });
    const decoded = spawnSync(node!, ['-e', `const chunks=[];process.stdin.on('data',b=>chunks.push(b));process.stdin.on('end',async()=>{const {data,info}=await require(${JSON.stringify(require.resolve('sharp'))})(Buffer.concat(chunks)).ensureAlpha().raw().toBuffer({resolveWithObject:true});console.log(JSON.stringify({first:[...data.subarray(0,4)],last:[...data.subarray(data.length-4)],width:info.width,height:info.height}));});`], {
      input: resized.data, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
    });
    expect(decoded.status, decoded.stderr).toBe(0);
    expect(decoded.stderr).toBe('');
    expect(JSON.parse(decoded.stdout)).toEqual({ first: [0, 0, 0, 255], last: [20, 40, 60, 255], width: 8, height: 12 });
    await expect(images.request('encode', masked.data, { format: 'png', extract: { left: 20, top: 0, width: 4, height: 6 } })).rejects.toThrow('E_IMAGE_PROCESS');
    expect(await images.request('metadata', input())).toMatchObject({ width: 4, height: 3 });
  });

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

  it('renders SVG contact-sheet text in stock Node without native diagnostics', async () => {
    let stderr = '';
    const images = client({ spawn: (...args: Parameters<typeof fork>) => {
      const child = fork(...args);
      child.stderr!.on('data', chunk => { stderr += String(chunk); });
      children.push(child);
      return child;
    } });
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="80"><rect width="320" height="80" fill="white"/><text x="12" y="48" font-family="sans-serif" font-size="24">Contact sheet</text></svg>');
    const result = await images.request('encode', svg, { format: 'png', density: 96 });
    expect(result.data.readUInt32BE(16)).toBeGreaterThanOrEqual(320);
    expect(stderr).toBe('');
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

  it('loads the shipped dependency closure beside app.asar without checkout or Electron resolution', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-packaged-image-'));
    temporary.push(root);
    const unpacked = path.join(root, 'app.asar.unpacked');
    const entry = path.join(unpacked, 'bin', 'sharp-worker.cjs');
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.copyFileSync(worker, entry);
    fs.copyFileSync(path.join(process.cwd(), 'bin/psd-preview.cjs'), path.join(unpacked, 'bin/psd-preview.cjs'));
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    const gate = require('../../../bin/packaged-entrypoint-gate.cjs');
    for (const glob of gate.PACKAGED_IMAGE_RUNTIME_UNPACK_GLOBS) {
      expect(pkg.build.files).toContain(glob);
      expect(pkg.build.asarUnpack).toContain(glob);
      const relative = glob.slice(0, -5);
      fs.cpSync(path.join(process.cwd(), relative), path.join(unpacked, relative), { recursive: true });
    }
    // Use only paths shipped by both package lists, including ag-psd's nested
    // pako rather than borrowing an unrelated checkout resolution.
    const minimatchModule = require('minimatch');
    const minimatch = minimatchModule.minimatch || minimatchModule;
    // Keep the manifest's ordered include/exclude semantics without depending
    // on a separate product-builder toolchain.
    const included = (file: string, patterns: string[]) => {
      let result = false;
      for (const raw of patterns || []) {
        if (typeof raw !== 'string') throw new Error('Package patterns must be strings.');
        const negative = raw.startsWith('!');
        const pattern = (negative ? raw.slice(1) : raw).replace(/\\/g, '/').replace(/^\.\//, '');
        if (minimatch(file, pattern, { dot: true })
          || (!/[.*?{}[\]()]/.test(pattern) && file.startsWith(`${pattern}/`))) result = !negative;
      }
      return result;
    };
    for (const name of ['ag-psd', 'base64-js']) {
      fs.cpSync(path.join(process.cwd(), 'node_modules', name), path.join(unpacked, 'node_modules', name), {
        recursive: true,
        filter: (file: string) => {
          if (fs.statSync(file).isDirectory()) return true;
          const relative = path.relative(process.cwd(), file).split(path.sep).join('/');
          return included(relative, pkg.build.files) && included(relative, pkg.build.asarUnpack);
        },
      });
    }
    const pixels = { width: 4, height: 3, data: new Uint8ClampedArray(Array.from({ length: 12 }, () => [20, 40, 60, 255]).flat()) };
    const candidate = require('ag-psd').writePsdBuffer({ width: 4, height: 3, imageData: pixels, children: [{ name: 'Base', imageData: pixels }] }, { noBackground: true });
    const packagedImages = client({ workerPath: entry });
    expect(await packagedImages.request('psd-check', candidate, { canvas: { width: 4, height: 3 }, reference: input(4, 3) })).toEqual({ matches: true });
    expect(probeImageRuntime(node, entry)).toMatchObject({ status: 'passed', sharp: 'png-2x2', electron: null, arch: process.arch });
    // The persistent client still owns the native DLLs on Windows. Unload it
    // before deleting the payload for the separate missing-dependency probe.
    const packagedClosed = once(children.at(-1)!, 'close');
    packagedImages.close();
    await packagedClosed;
    const imageDependencies = path.join(unpacked, 'node_modules', '@img');
    await fs.promises.rm(imageDependencies, { recursive: true, maxRetries: 10, retryDelay: 50 });
    expect(fs.existsSync(imageDependencies)).toBe(false);
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
