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
/** Staging and backup directories of replacements still in flight in this
 *  process; the sweep below must never remove one of these. */
const activeReplacementArtifacts = new Set<string>();

const REPLACEMENT_ARTIFACT_RE = /^\.(.+)\.install-[^.]+(?:\.previous)?$/;

/** Remove staging (`.<name>.install-*`) and backup (`*.previous`) directories a
 *  crashed or killed replacement left under `parent`. They start with a dot,
 *  so the install listings never showed them and nothing ever reclaimed
 *  their space. Live artifacts are skipped. A previous-directory backup is
 *  retained if activation never installed a real target directory: it may
 *  contain the only recoverable copy of the user's prior content. */
export async function sweepStaleReplacementArtifacts(
  parent: string,
  onCleanupError?: (err: unknown, artifactPath: string) => void,
): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(parent, { withFileTypes: true });
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    const match = REPLACEMENT_ARTIFACT_RE.exec(entry.name);
    if (!entry.isDirectory() || !match) continue;
    const artifact = path.join(parent, entry.name);
    if (activeReplacementArtifacts.has(artifact)) continue;
    if (entry.name.endsWith('.previous')) {
      try {
        if (!fs.lstatSync(path.join(parent, match[1])).isDirectory()) continue;
      } catch {
        continue;
      }
    }
    try {
      await fsp.rm(artifact, { recursive: true, force: true });
      removed.push(artifact);
    } catch (err) {
      onCleanupError?.(err, artifact);
    }
  }
  return removed;
}

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
  activeReplacementArtifacts.add(staged);
  activeReplacementArtifacts.add(backup);

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
  } finally {
    activeReplacementArtifacts.delete(staged);
    activeReplacementArtifacts.delete(backup);
  }
}
