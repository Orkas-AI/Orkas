import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

export interface AtomicDirectoryReplaceOptions {
  assertReady?: () => void;
  /**
   * Wrap only the final live-directory activation and metadata commit. Callers
   * may stage while model turns run, then use a runtime-idle publication gate
   * here without holding that gate during file copying or validation.
   */
  activationGuard?: <T>(activate: () => Promise<T>) => Promise<T>;
  onCleanupError?: (err: unknown, backup: string) => void;
}

/**
 * Prepare a sibling directory, atomically activate it, then commit associated
 * metadata. Any activation/metadata failure restores the previous directory.
 */
export async function replaceDirectoryAtomically(
  target: string,
  prepare: (staged: string) => Promise<void>,
  commit: () => Promise<void> = async () => undefined,
  opts: AtomicDirectoryReplaceOptions = {},
): Promise<void> {
  const assertReady = opts.assertReady || (() => undefined);
  const parent = path.dirname(target);
  await fsp.mkdir(parent, { recursive: true });
  const staged = await fsp.mkdtemp(path.join(parent, `.${path.basename(target)}.install-`));
  const backup = `${staged}.previous`;
  let previousMoved = false;
  let stagedActivated = false;

  try {
    await prepare(staged);
    const activate = async (): Promise<void> => {
      assertReady();

      if (fs.existsSync(target)) {
        await fsp.rename(target, backup);
        previousMoved = true;
      }

      try {
        await fsp.rename(staged, target);
        stagedActivated = true;
        assertReady();
        await commit();
      } catch (err) {
        if (stagedActivated) {
          await fsp.rm(target, { recursive: true, force: true });
          stagedActivated = false;
        }
        if (previousMoved) {
          await fsp.rename(backup, target);
          previousMoved = false;
        }
        throw err;
      }
    };

    if (opts.activationGuard) await opts.activationGuard(activate);
    else await activate();

    if (previousMoved) {
      try {
        await fsp.rm(backup, { recursive: true, force: true });
        previousMoved = false;
      } catch (err) {
        opts.onCleanupError?.(err, backup);
      }
    }
  } catch (err) {
    if (!stagedActivated) {
      await fsp.rm(staged, { recursive: true, force: true }).catch(() => undefined);
    }
    if (previousMoved && !fs.existsSync(target)) {
      await fsp.rename(backup, target).catch(() => undefined);
    }
    throw err;
  }
}
