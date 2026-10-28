import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import nativeFs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';

import { replaceDirectoryAtomically, sweepStaleReplacementArtifacts } from '../../../src/main/util/atomic-directory-replace';

describe('atomic directory replacement', () => {
  let root: string;
  let target: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-atomic-directory-'));
    target = path.join(root, 'installed-item');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeCurrent(content = 'working'): void {
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'content.txt'), content, 'utf8');
  }

  function transactionArtifacts(): string[] {
    return fs.readdirSync(root).filter((name) => name.startsWith('.installed-item.install-'));
  }

  it('sweeps abandoned staging while preserving prior copies and live work', async () => {
    // Directory presence cannot establish that a crashed replacement committed.
    // Keep its prior copy even when an installed-looking target also exists.
    writeCurrent();
    for (const name of ['.installed-item.install-dead01', '.installed-item.install-dead01.previous', '.other.install-x9']) {
      fs.mkdirSync(path.join(root, name), { recursive: true });
      fs.writeFileSync(path.join(root, name, 'content.txt'), 'stale', 'utf8');
    }
    fs.mkdirSync(path.join(root, '.hidden-but-not-ours'), { recursive: true });
    fs.writeFileSync(path.join(root, '.installed-item.install-file'), 'a file, not a dir', 'utf8');

    let releaseActivation: (() => void) | null = null;
    const held = new Promise<void>((resolve) => { releaseActivation = resolve; });
    let liveStaged = '';
    const inFlight = replaceDirectoryAtomically(target, async (staged) => {
      liveStaged = staged;
      fs.writeFileSync(path.join(staged, 'content.txt'), 'fresh', 'utf8');
    }, async () => undefined, {
      activationGuard: async (activate) => { await held; await activate(); },
    });
    await vi.waitFor(() => expect(liveStaged).not.toBe(''));

    const errors: string[] = [];
    const removed = await sweepStaleReplacementArtifacts(root, (_err, artifact) => { errors.push(artifact); });

    expect(errors).toEqual([]);
    expect(removed.map((item) => path.basename(item)).sort()).toEqual([
      '.installed-item.install-dead01',
      '.other.install-x9',
    ]);
    expect(fs.existsSync(liveStaged)).toBe(true);
    expect(fs.readFileSync(path.join(root, '.installed-item.install-dead01.previous', 'content.txt'), 'utf8')).toBe('stale');
    expect(fs.existsSync(path.join(root, '.hidden-but-not-ours'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.installed-item.install-file'))).toBe(true);
    expect(fs.readFileSync(path.join(target, 'content.txt'), 'utf8')).toBe('working');

    releaseActivation!();
    await inFlight;
    expect(fs.readFileSync(path.join(target, 'content.txt'), 'utf8')).toBe('fresh');
    fs.rmSync(path.join(root, '.installed-item.install-file'));
    expect(transactionArtifacts()).toEqual(['.installed-item.install-dead01.previous']);
    // Missing parent: nothing to do, no throw.
    expect(await sweepStaleReplacementArtifacts(path.join(root, 'nope'))).toEqual([]);
  });

  it('activates fully prepared content and removes its previous-directory backup', async () => {
    writeCurrent();
    const commit = vi.fn(async () => undefined);

    await replaceDirectoryAtomically(target, async (staged) => {
      fs.writeFileSync(path.join(staged, 'content.txt'), 'replacement', 'utf8');
    }, commit);

    expect(fs.readFileSync(path.join(target, 'content.txt'), 'utf8')).toBe('replacement');
    expect(commit).toHaveBeenCalledOnce();
    expect(transactionArtifacts()).toEqual([]);
  });

  it.each(['missing', 'file'])('preserves the recovery backup when the installed target is %s', async (state) => {
    writeCurrent('user-maintained content');
    const staged = path.join(root, '.installed-item.install-crashed');
    const backup = `${staged}.previous`;
    fs.mkdirSync(staged);
    fs.writeFileSync(path.join(staged, 'content.txt'), 'uncommitted replacement');
    // The process died after moving the old target aside, before activation.
    fs.renameSync(target, backup);
    if (state === 'file') fs.writeFileSync(target, 'not an installed directory');

    expect(await sweepStaleReplacementArtifacts(root)).toEqual([staged]);
    expect(fs.readFileSync(path.join(backup, 'content.txt'), 'utf8')).toBe('user-maintained content');
    // Repeated maintenance must continue preserving the last recoverable copy.
    expect(await sweepStaleReplacementArtifacts(root)).toEqual([]);
    expect(fs.readFileSync(path.join(backup, 'content.txt'), 'utf8')).toBe('user-maintained content');
  });

  it('keeps the old directory untouched when preparation fails midway', async () => {
    writeCurrent();
    const commit = vi.fn(async () => undefined);

    await expect(replaceDirectoryAtomically(target, async (staged) => {
      fs.writeFileSync(path.join(staged, 'partial.txt'), 'partial', 'utf8');
      throw new Error('prepare failed');
    }, commit)).rejects.toThrow('prepare failed');

    expect(fs.readFileSync(path.join(target, 'content.txt'), 'utf8')).toBe('working');
    expect(fs.existsSync(path.join(target, 'partial.txt'))).toBe(false);
    expect(commit).not.toHaveBeenCalled();
    expect(transactionArtifacts()).toEqual([]);
  });

  it('recovers the previous directory before retry preparation after activation and rollback both fail', async () => {
    writeCurrent('user-maintained draft');
    const rename = nativeFs.promises.rename.bind(nativeFs.promises);
    const fault = Object.assign(new Error('injected persistent rename failure'), { code: 'ENOSPC' });
    const spy = vi.spyOn(nativeFs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === target) throw fault;
      return rename(from, to);
    });
    syncBuiltinESMExports();
    try {
      await expect(replaceDirectoryAtomically(target, async staged => {
        fs.writeFileSync(path.join(staged, 'new.txt'), 'requested addition');
      })).rejects.toThrow(fault);
    } finally { spy.mockRestore(); syncBuiltinESMExports(); }
    const backup = transactionArtifacts().find(name => name.endsWith('.previous'))!;
    expect(fs.readFileSync(path.join(root, backup, 'content.txt'), 'utf8')).toBe('user-maintained draft');
    expect(fs.existsSync(target)).toBe(false);
    // The real consumer prepares a merge from the authoritative prior target.
    // It cannot discover an unreported random backup name itself.
    const commit = vi.fn(async () => undefined);
    await replaceDirectoryAtomically(target, async staged => {
      if (fs.existsSync(target)) fs.cpSync(target, staged, { recursive: true });
      fs.writeFileSync(path.join(staged, 'new.txt'), 'requested addition');
    }, commit);
    await sweepStaleReplacementArtifacts(root);
    expect(fs.existsSync(path.join(target, 'content.txt'))).toBe(true);
    expect(fs.readFileSync(path.join(target, 'content.txt'), 'utf8')).toBe('user-maintained draft');
    expect(fs.readFileSync(path.join(target, 'new.txt'), 'utf8')).toBe('requested addition');
    expect(commit).toHaveBeenCalledOnce();
    expect(transactionArtifacts()).toEqual([]);
  });

  it('keeps recovery behind the existing activation guard and preserves ambiguous backups', async () => {
    const first = path.join(root, '.installed-item.install-one.previous');
    fs.mkdirSync(first);
    fs.writeFileSync(path.join(first, 'content.txt'), 'original');
    const prepare = vi.fn(async () => undefined);
    await expect(replaceDirectoryAtomically(target, prepare, undefined, {
      activationGuard: async () => { throw new Error('account changed'); },
    })).rejects.toThrow('account changed');
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readFileSync(path.join(first, 'content.txt'), 'utf8')).toBe('original');
    expect(prepare).not.toHaveBeenCalled();
    const second = path.join(root, '.installed-item.install-two.previous');
    fs.mkdirSync(second);
    fs.writeFileSync(path.join(second, 'content.txt'), 'different original');
    await expect(replaceDirectoryAtomically(target, prepare)).rejects.toThrow('ambiguous');
    expect(prepare).not.toHaveBeenCalled();
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readFileSync(path.join(second, 'content.txt'), 'utf8')).toBe('different original');
    expect(fs.readFileSync(path.join(first, 'content.txt'), 'utf8')).toBe('original');
  });

  it('finishes staging before waiting for the activation guard', async () => {
    writeCurrent();
    let releaseActivation!: () => void;
    let markGuardEntered!: () => void;
    const guardEntered = new Promise<void>((resolve) => { markGuardEntered = resolve; });
    const activationGate = new Promise<void>((resolve) => { releaseActivation = resolve; });

    const replacing = replaceDirectoryAtomically(target, async (staged) => {
      fs.writeFileSync(path.join(staged, 'content.txt'), 'replacement', 'utf8');
    }, async () => undefined, {
      activationGuard: async (activate) => {
        markGuardEntered();
        await activationGate;
        await activate();
      },
    });

    await guardEntered;
    expect(fs.readFileSync(path.join(target, 'content.txt'), 'utf8')).toBe('working');
    expect(transactionArtifacts()).toHaveLength(1);

    releaseActivation();
    await replacing;
    expect(fs.readFileSync(path.join(target, 'content.txt'), 'utf8')).toBe('replacement');
    expect(transactionArtifacts()).toEqual([]);
  });

  it('discards staged content when the activation guard rejects publication', async () => {
    writeCurrent();

    await expect(replaceDirectoryAtomically(target, async (staged) => {
      fs.writeFileSync(path.join(staged, 'content.txt'), 'replacement', 'utf8');
    }, async () => undefined, {
      activationGuard: async () => {
        throw new Error('runtime context changed');
      },
    })).rejects.toThrow('runtime context changed');

    expect(fs.readFileSync(path.join(target, 'content.txt'), 'utf8')).toBe('working');
    expect(transactionArtifacts()).toEqual([]);
  });

  it('restores the old directory when metadata commit fails after activation', async () => {
    writeCurrent();

    await expect(replaceDirectoryAtomically(target, async (staged) => {
      fs.writeFileSync(path.join(staged, 'content.txt'), 'replacement', 'utf8');
    }, async () => {
      throw new Error('manifest commit failed');
    })).rejects.toThrow('manifest commit failed');

    expect(fs.readFileSync(path.join(target, 'content.txt'), 'utf8')).toBe('working');
    expect(transactionArtifacts()).toEqual([]);
  });

  it('removes a first-install directory when its metadata commit fails', async () => {
    await expect(replaceDirectoryAtomically(target, async (staged) => {
      fs.writeFileSync(path.join(staged, 'content.txt'), 'new install', 'utf8');
    }, async () => {
      throw new Error('manifest commit failed');
    })).rejects.toThrow('manifest commit failed');

    expect(fs.existsSync(target)).toBe(false);
    expect(transactionArtifacts()).toEqual([]);
  });

  it('restores the durable draft when rollback removal fails before an explicit retry and sweep', async () => {
    writeCurrent('only durable draft');
    const rm = nativeFs.promises.rm.bind(nativeFs.promises);
    const spy = vi.spyOn(nativeFs.promises, 'rm').mockImplementation(async (file, options) => {
      if (String(file) === target) throw Object.assign(new Error('injected removal denial'), { code: 'EACCES' });
      return rm(file, options);
    });
    syncBuiltinESMExports();
    try {
      await expect(replaceDirectoryAtomically(target, async staged => {
        fs.writeFileSync(path.join(staged, 'uncommitted.txt'), 'not durable');
      }, async () => { throw new Error('metadata rejected'); })).rejects.toThrow();
    } finally { spy.mockRestore(); syncBuiltinESMExports(); }
    // The caller reopens after rejection, before choosing to retry.
    expect(fs.existsSync(path.join(target, 'content.txt'))).toBe(true);
    expect(fs.readFileSync(path.join(target, 'content.txt'), 'utf8')).toBe('only durable draft');
    expect(fs.existsSync(path.join(target, 'uncommitted.txt'))).toBe(false);
    await replaceDirectoryAtomically(target, async staged => {
      fs.cpSync(target, staged, { recursive: true });
      fs.writeFileSync(path.join(staged, 'retry.txt'), 'accepted');
    });
    await sweepStaleReplacementArtifacts(root);
    expect(fs.readFileSync(path.join(target, 'content.txt'), 'utf8')).toBe('only durable draft');
    expect(fs.readFileSync(path.join(target, 'retry.txt'), 'utf8')).toBe('accepted');
    expect(transactionArtifacts()).toEqual([]);
  });

  it('checks the continuation guard both before and after activation', async () => {
    writeCurrent();
    let calls = 0;
    const commit = vi.fn(async () => undefined);

    await expect(replaceDirectoryAtomically(target, async (staged) => {
      fs.writeFileSync(path.join(staged, 'content.txt'), 'replacement', 'utf8');
    }, commit, {
      assertReady: () => {
        calls += 1;
        if (calls === 2) throw new Error('account changed');
      },
    })).rejects.toThrow('account changed');

    expect(calls).toBe(2);
    expect(commit).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(target, 'content.txt'), 'utf8')).toBe('working');
    expect(transactionArtifacts()).toEqual([]);
  });

  it('keeps the prior copy through maintenance when both rollback removal and quarantine fail', async () => {
    writeCurrent('only durable draft');
    const rm = nativeFs.promises.rm.bind(nativeFs.promises);
    const rename = nativeFs.promises.rename.bind(nativeFs.promises);
    let metadataRejected = false;
    const denied = Object.assign(new Error('injected rollback denial'), { code: 'EACCES' });
    const removeSpy = vi.spyOn(nativeFs.promises, 'rm').mockImplementation(async (file, options) => {
      if (metadataRejected && String(file) === target) throw denied;
      return rm(file, options);
    });
    const renameSpy = vi.spyOn(nativeFs.promises, 'rename').mockImplementation(async (from, to) => {
      if (metadataRejected && String(from) === target) throw denied;
      return rename(from, to);
    });
    syncBuiltinESMExports();
    try {
      await expect(replaceDirectoryAtomically(target, async staged => {
        fs.writeFileSync(path.join(staged, 'uncommitted.txt'), 'rejected candidate');
      }, async () => {
        metadataRejected = true;
        throw new Error('metadata rejected');
      })).rejects.toThrow();
    } finally {
      removeSpy.mockRestore();renameSpy.mockRestore();syncBuiltinESMExports();
    }
    const backup = transactionArtifacts().find(name => name.endsWith('.previous'))!;
    expect(fs.readFileSync(path.join(root, backup, 'content.txt'), 'utf8')).toBe('only durable draft');
    expect(fs.existsSync(path.join(target, 'uncommitted.txt'))).toBe(true);
    await sweepStaleReplacementArtifacts(root);
    await sweepStaleReplacementArtifacts(root);
    expect(fs.readFileSync(path.join(root, backup, 'content.txt'), 'utf8')).toBe('only durable draft');
  });

  it('distinguishes failed directory discovery from a missing parent', async () => {
    const denied = Object.assign(new Error('injected directory read denial'), { code: 'EACCES' });
    const spy = vi.spyOn(nativeFs.promises, 'readdir').mockRejectedValue(denied);
    syncBuiltinESMExports();
    try {
      const onError = vi.fn();
      expect(await sweepStaleReplacementArtifacts(root, onError)).toEqual([]);
      expect(onError).toHaveBeenCalledWith(denied, root);
      await expect(sweepStaleReplacementArtifacts(root)).rejects.toThrow(denied);
    } finally {spy.mockRestore();syncBuiltinESMExports();}
  });

  it('reports an undeletable staging directory instead of silently swallowing its failure', async () => {
    const artifact=path.join(root,'.installed-item.install-denied');
    fs.mkdirSync(artifact);
    const denied=Object.assign(new Error('injected staging cleanup denial'),{code:'EACCES'});
    const spy=vi.spyOn(nativeFs.promises,'rm').mockRejectedValue(denied);
    syncBuiltinESMExports();
    try {
      const onError=vi.fn();
      expect(await sweepStaleReplacementArtifacts(root,onError)).toEqual([]);
      expect(onError).toHaveBeenCalledWith(denied,artifact);
      expect(fs.existsSync(artifact)).toBe(true);
      await expect(sweepStaleReplacementArtifacts(root)).rejects.toThrow(denied);
    } finally {spy.mockRestore();syncBuiltinESMExports();}
  });
});
