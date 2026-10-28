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

/** Remove abandoned staging (`.<name>.install-*`) directories under `parent`.
 * Live artifacts and previous-directory backups are retained: an existing
 * target may be a rejected candidate whose rollback also failed, not proof of
 * a successful metadata commit. Successful replacements clean their own
 * backups; maintenance cannot decide that an orphan prior copy is disposable. */
export async function sweepStaleReplacementArtifacts(
  parent: string,
  onCleanupError?: (err: unknown, artifactPath: string) => void,
): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(parent, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (!onCleanupError) throw err;
      onCleanupError(err, parent);
    }
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    const match = REPLACEMENT_ARTIFACT_RE.exec(entry.name);
    if (!entry.isDirectory() || !match) continue;
    const artifact = path.join(parent, entry.name);
    if (activeReplacementArtifacts.has(artifact)) continue;
    if (entry.name.endsWith('.previous')) continue;
    try {
      await fsp.rm(artifact, { recursive: true, force: true });
      removed.push(artifact);
    } catch (err) {
      if (!onCleanupError) throw err;
      onCleanupError(err, artifact);
    }
  }
  return removed;
}

/** A failed rollback can leave the only prior copy beside a missing target.
 * Restore that unambiguous copy before a merge consumer reads its baseline.
 * Existing targets take the constant-time path; cold recovery streams one
 * parent directory without opening unrelated entries or retaining its listing.
 */
async function recoverPreviousDirectory(target: string, opts: AtomicDirectoryReplaceOptions): Promise<void> {
  if (fs.existsSync(target)) return;
  const parent = path.dirname(target), name = path.basename(target);
  let backup: string | undefined;
  const directory = await fsp.opendir(parent);
  for await (const entry of directory) {
    const match = REPLACEMENT_ARTIFACT_RE.exec(entry.name);
    if (!match || match[1] !== name || !entry.name.endsWith('.previous')) continue;
    const candidate = path.join(parent, entry.name);
    if (activeReplacementArtifacts.has(candidate)) throw new Error('Previous directory replacement is still active');
    if (!entry.isDirectory() || backup) throw new Error('Previous directory recovery is ambiguous');
    backup = candidate;
  }
  if (!backup) return;
  const recover = async () => {
    opts.assertReady?.();
    if (fs.existsSync(target)) throw new Error('Directory changed before recovery');
    await fsp.rename(backup!, target);
  };
  if (opts.activationGuard) await opts.activationGuard(recover);
  else await recover();
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
  await recoverPreviousDirectory(target, opts);
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
          try {
            await fsp.rm(target, { recursive: true, force: true });
          } catch {
            // Cleanup can fail on an open or protected child even though the
            // parent permits a rename. Quarantine the rejected candidate at
            // its now-vacant staging path so the durable backup can return.
            // Never sweep the backup while an uncommitted target hides it.
            await fsp.rename(target, staged);
          }
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
