import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  checkRepositoryLineEndings,
  classifyLineEndings,
  listRepositoryTextFiles,
} from '../../../scripts/check-line-endings.mjs';

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-line-endings-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(relative: string, content: string | Buffer): string {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function gitList(...entries: string[]) {
  return vi.fn(() => ({
    status: 0,
    stdout: Buffer.from(`${entries.join('\0')}\0`),
    stderr: Buffer.alloc(0),
  }));
}

describe('repository line-ending gate', () => {
  it('classifies LF, CRLF, mixed, and unsupported bare-CR bytes exactly', () => {
    expect(classifyLineEndings(Buffer.from('a\nb\n'))).toEqual({
      bareCr: 0,
      bareLf: 2,
      crlf: 0,
      invalid: false,
    });
    expect(classifyLineEndings(Buffer.from('a\r\nb\r\n'))).toEqual({
      bareCr: 0,
      bareLf: 0,
      crlf: 2,
      invalid: false,
    });
    expect(classifyLineEndings(Buffer.from('a\r\nb\n'))).toMatchObject({
      bareCr: 0,
      bareLf: 1,
      crlf: 1,
      invalid: true,
    });
    expect(classifyLineEndings(Buffer.from('a\rb\r'))).toMatchObject({
      bareCr: 2,
      bareLf: 0,
      crlf: 0,
      invalid: true,
    });
  });

  it('includes production data/build paths when Git owns them and excludes binary files and symlinks', () => {
    const pcData = write('PC/src/main/data/commander.json', '{}\n');
    const webData = write('Web/res/data/catalog.js', 'export {};\n');
    const trackedBuild = write('PC/src/main/native/build/metadata.txt', 'metadata\n');
    write('PC/src/resources/logo.png', 'not really an image');
    const outside = write('outside.txt', 'outside\n');
    const link = path.join(root, 'PC', 'linked.txt');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(outside, link);
    const spawn = gitList(
      'PC/src/main/data/commander.json',
      'Web/res/data/catalog.js',
      'PC/src/main/native/build/metadata.txt',
      'PC/src/resources/logo.png',
      'PC/linked.txt',
    );

    expect(listRepositoryTextFiles(root, { spawn })).toEqual([
      pcData,
      trackedBuild,
      webData,
    ]);
    expect(spawn).toHaveBeenCalledWith(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      expect.objectContaining({
        cwd: root,
        timeout: 30_000,
      }),
    );
  });

  it('reports every invalid tracked or unignored text file with stable relative diagnostics', () => {
    write('PC/src/main/data/good.json', '{\r\n  "ok": true\r\n}\r\n');
    write('PC/src/main/data/mixed.json', '{\r\n  "bad": true\n}\r\n');
    write('Web/res/data/bare.js', 'a\rb\r');
    const printError = vi.fn();

    const result = checkRepositoryLineEndings({
      print: vi.fn(),
      printError,
      root,
      spawn: gitList(
        'Web/res/data/bare.js',
        'PC/src/main/data/mixed.json',
        'PC/src/main/data/good.json',
      ),
    });

    expect(result).toMatchObject({ code: 1, files: 3 });
    expect(result.invalid.map((item) => path.relative(root, item.file).split(path.sep).join('/'))).toEqual([
      'PC/src/main/data/mixed.json',
      'Web/res/data/bare.js',
    ]);
    expect(printError).toHaveBeenCalledWith(
      '- PC/src/main/data/mixed.json (CRLF=2, LF=1, bare-CR=0)',
    );
    expect(printError).toHaveBeenCalledWith(
      '- Web/res/data/bare.js (CRLF=0, LF=0, bare-CR=2)',
    );
  });

  it('distinguishes repository discovery failure from content failure', () => {
    const printError = vi.fn();
    const result = checkRepositoryLineEndings({
      print: vi.fn(),
      printError,
      root,
      spawn: vi.fn(() => ({
        status: null,
        error: new Error('git timed out'),
        stdout: Buffer.alloc(0),
      })),
    });

    expect(result).toEqual({ code: 2, files: 0, invalid: [] });
    expect(printError).toHaveBeenCalledWith(
      'Line-ending file discovery failed: git timed out',
    );
  });
});
