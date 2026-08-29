/**
 * Path-uniquify helper for write-style tools.
 *
 * `write_file / create_pdf / generate_image` all funnel
 * the resolved absolute output path through `uniquifyPath` so that:
 *
 *   • non-conflicting writes go to the model-given path verbatim — the
 *     LLM's mental model and the filesystem stay in lockstep;
 *   • a clash with someone else's file (different agent / different turn /
 *     pre-existing user file) gets the basename suffixed `-2 / -3 / ...`
 *     before the extension, so we never silently overwrite work the
 *     model didn't author;
 *   • a clash with this caller's *own* prior writes is treated as a
 *     refinement (overwrite in place). The caller decides ownership via
 *     the `isMine` predicate — typically a `Set<string>.has` over the
 *     paths it's already received from `onFileWritten` this turn.
 *
 * Replaces the old `util/date-prefix.ts` (`YYYY-MM-DD-` basename prefix),
 * which gave the same date to every file written on the same day and so
 * still collided silently.
 *
 * Extension detection uses Node's `path.parse`, which only recognises the
 * last dot. `app.tar.gz` therefore uniquifies to `app.tar-2.gz` — odd but
 * unambiguous; double-extension whitelisting was deliberately deferred.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { fileEditLock } from './locks';

export interface UniquifyResult {
  finalPath: string;
  renamed: boolean;
}

/** Cap on rename attempts. A single basename growing past `<name>-9999<ext>`
 *  almost certainly means a runaway directory or an `isMine` predicate that
 *  always returns false against itself — fail loud rather than spin. */
const MAX_ATTEMPTS = 10000;

export async function uniquifyPath(
  absPath: string,
  isMine: (p: string) => boolean,
): Promise<UniquifyResult> {
  if (isMine(absPath)) return { finalPath: absPath, renamed: false };
  if (!(await pathExists(absPath))) return { finalPath: absPath, renamed: false };

  const { dir, name, ext } = path.parse(absPath);
  for (let n = 2; n < MAX_ATTEMPTS; n++) {
    const candidate = path.join(dir, `${name}-${n}${ext}`);
    if (isMine(candidate)) return { finalPath: candidate, renamed: true };
    if (!(await pathExists(candidate))) return { finalPath: candidate, renamed: true };
  }
  throw new Error(`uniquifyPath: exhausted ${MAX_ATTEMPTS} attempts under ${dir}`);
}

/** Decide the unique path AND perform the write under one per-path mutex.
 *
 *  `uniquifyPath` alone is check-then-act: between its existence probe and the
 *  caller's eventual write, a concurrent writer aimed at the same path (two
 *  parallel agent turns sharing one conversation workspace) passes the same
 *  probe, and both write one file — the silent overwrite this module exists to
 *  prevent. Serializing probe+write on the mutex keyed by the REQUESTED path
 *  (the only key both contenders share up front) makes the loser's probe see
 *  the winner's file and suffix correctly.
 *
 *  `write` runs with the lock held, so keep it to the write itself — do not
 *  run model calls or long renders inside unless the file only materializes
 *  there. It must not acquire `fileEditLock` on the same path again. */
export async function uniquifyPathForWrite<T>(
  absPath: string,
  isMine: (p: string) => boolean,
  write: (decision: UniquifyResult) => Promise<T>,
): Promise<T> {
  return fileEditLock(path.resolve(absPath)).runExclusive(async () => (
    write(await uniquifyPath(absPath, isMine))
  ));
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Render the `<file-renamed>` block appended to a write tool's result
 *  content when uniquify changed the target path. Loud, tagged, basename-only
 *  so the LLM can grep without a path tokenizer. The directory portion is
 *  unchanged between requested and final, so omitting it keeps the signal
 *  short. */
export function renderRenameSignal(requestedAbs: string, finalAbs: string): string {
  const requested = path.basename(requestedAbs);
  const saved = path.basename(finalAbs);
  return (
    '\n\n<file-renamed>\n'
    + `You requested: ${requested}\n`
    + `Saved as:      ${saved}\n`
    + 'Reason: a different file with that name already exists at the target location.\n'
    + 'Use the saved path verbatim in any subsequent read / reference / message to the user.\n'
    + '</file-renamed>'
  );
}
