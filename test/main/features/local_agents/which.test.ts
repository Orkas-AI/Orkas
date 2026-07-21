import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { whichBin } from '../../../../src/main/features/local_agents/which';

const isWindows = process.platform === 'win32';

describe('local_agents/which › whichBin', () => {
  let tmpDir: string;
  let savedPath: string | undefined;
  let savedPathExt: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-which-'));
    savedPath = process.env.PATH;
    savedPathExt = process.env.PATHEXT;
  });

  afterEach(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedPathExt === undefined) delete process.env.PATHEXT;
    else process.env.PATHEXT = savedPathExt;
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('returns null for empty name', async () => {
    expect(await whichBin('')).toBeNull();
  });

  it('returns null when PATH is empty', async () => {
    process.env.PATH = '';
    expect(await whichBin('anything')).toBeNull();
  });

  it('returns null when binary does not exist anywhere on PATH', async () => {
    process.env.PATH = tmpDir;
    expect(await whichBin('does-not-exist-' + Date.now())).toBeNull();
  });

  if (!isWindows) {
    it('finds an executable file on POSIX PATH', async () => {
      const binPath = path.join(tmpDir, 'fakebin');
      fs.writeFileSync(binPath, '#!/bin/sh\necho hi\n');
      fs.chmodSync(binPath, 0o755);
      process.env.PATH = tmpDir;
      expect(await whichBin('fakebin')).toBe(binPath);
    });

    it('rejects a non-executable file on POSIX (no x bit)', async () => {
      const binPath = path.join(tmpDir, 'plain');
      fs.writeFileSync(binPath, 'not exec\n');
      fs.chmodSync(binPath, 0o644);
      process.env.PATH = tmpDir;
      expect(await whichBin('plain')).toBeNull();
    });

    it('returns the first match when multiple PATH entries have it', async () => {
      const a = fs.mkdtempSync(path.join(tmpDir, 'a-'));
      const b = fs.mkdtempSync(path.join(tmpDir, 'b-'));
      const ap = path.join(a, 'foo');
      const bp = path.join(b, 'foo');
      fs.writeFileSync(ap, ''); fs.chmodSync(ap, 0o755);
      fs.writeFileSync(bp, ''); fs.chmodSync(bp, 0o755);
      process.env.PATH = `${a}${path.delimiter}${b}`;
      expect(await whichBin('foo')).toBe(ap);
    });
  }

  if (isWindows) {
    it('respects PATHEXT on Windows', async () => {
      const binPath = path.join(tmpDir, 'thing.CMD');
      fs.writeFileSync(binPath, '@echo hi\r\n');
      process.env.PATH = tmpDir;
      process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
      const r = await whichBin('thing');
      expect(r?.toLowerCase()).toBe(binPath.toLowerCase());
    });

    it('uses the standard Windows PATHEXT fallback when PATHEXT is missing', async () => {
      const binPath = path.join(tmpDir, 'fallback.EXE');
      fs.writeFileSync(binPath, '');
      process.env.PATH = tmpDir;
      delete process.env.PATHEXT;

      expect((await whichBin('fallback'))?.toLowerCase()).toBe(binPath.toLowerCase());
    });

    it('prefers an exact bare Windows command before PATHEXT variants', async () => {
      const bare = path.join(tmpDir, 'tool');
      fs.writeFileSync(bare, 'bare');
      fs.writeFileSync(path.join(tmpDir, 'tool.CMD'), '@echo cmd\r\n');
      process.env.PATH = tmpDir;
      process.env.PATHEXT = '.CMD';

      expect((await whichBin('tool'))?.toLowerCase()).toBe(bare.toLowerCase());
    });

    it('accepts forward-slash explicit paths on Windows', async () => {
      const binPath = path.join(tmpDir, 'forward.cmd');
      fs.writeFileSync(binPath, '@echo hi\r\n');

      expect(await whichBin(binPath.replace(/\\/g, '/'))).toBe(path.resolve(binPath));
    });
  }

  it('searches caller-provided directories when PATH omits them', async () => {
    const extraDir = path.join(tmpDir, 'extra-bin');
    fs.mkdirSync(extraDir);
    const binPath = path.join(extraDir, isWindows ? 'sidecar.CMD' : 'sidecar');
    fs.writeFileSync(binPath, isWindows ? '@echo hi\r\n' : '#!/bin/sh\necho hi\n');
    if (!isWindows) fs.chmodSync(binPath, 0o755);
    process.env.PATH = '';
    if (isWindows) process.env.PATHEXT = '.CMD';

    const resolved = await whichBin('sidecar', { extraDirs: [extraDir] });
    expect(isWindows ? resolved?.toLowerCase() : resolved).toBe(isWindows ? binPath.toLowerCase() : binPath);
  });

  it('rejects a directory that happens to have the command name', async () => {
    fs.mkdirSync(path.join(tmpDir, 'not-a-file'));
    process.env.PATH = tmpDir;

    expect(await whichBin('not-a-file')).toBeNull();
  });

  it('accepts an absolute path that points at an existing executable', async () => {
    const binPath = path.join(tmpDir, isWindows ? 'p.cmd' : 'p');
    fs.writeFileSync(binPath, '');
    if (!isWindows) fs.chmodSync(binPath, 0o755);
    process.env.PATH = '';
    if (isWindows) process.env.PATHEXT = '.CMD';
    const r = await whichBin(binPath);
    expect(r).toBe(path.resolve(binPath));
  });

  it('returns null for absolute path that does not exist', async () => {
    expect(await whichBin(path.join(tmpDir, 'never-existed'))).toBeNull();
  });
});
