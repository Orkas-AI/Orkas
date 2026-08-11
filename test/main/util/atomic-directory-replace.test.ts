import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { replaceDirectoryAtomically } from '../../../src/main/util/atomic-directory-replace';

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
});
