import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

/** A copied attachment is still input, even when shell discovery registers it
 * as a new file. Compare host-resolved resources, never names or model prose.
 * This guard affects byte-mutating finalization, not resource presentation. */
export async function excludeUnchangedInputs(
  outputs: readonly string[],
  inputPaths: readonly string[],
): Promise<string[]> {
  if (!outputs.length || !inputPaths.length) return [...outputs];
  // NTFS file ids can exceed Number's precision. Keep exact identities for
  // both alias detection and the before/after mutation check.
  const inputsBySize = new Map<bigint, Array<{ file: string; stat: fs.BigIntStats }>>();
  for (const file of new Set(inputPaths.map(p => path.resolve(p)))) {
    let stat: fs.BigIntStats;
    try { stat = await fs.promises.stat(file, { bigint: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error; // Unverified input ownership must not permit mutation.
    }
    if (!stat.isFile()) continue;
    const inputs = inputsBySize.get(stat.size) || [];
    inputs.push({ file, stat });
    inputsBySize.set(stat.size, inputs);
  }
  // Invocation-local cache bounds memory to the declared resources and never
  // carries exemptions across edits or turns. Stream only same-size candidates.
  const hashes = new Map<string, string>();
  const hash = async (file: string, before: fs.BigIntStats): Promise<string> => {
    const cached = hashes.get(file);
    if (cached) return cached;
    const digest = createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
    const after = await fs.promises.stat(file, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error('Input identity changed during output finalization');
    }
    const value = digest.digest('hex');
    hashes.set(file, value);
    return value;
  };
  const retained: string[] = [];
  for (const output of outputs) {
    const file = path.resolve(output);
    const stat = await fs.promises.stat(file, { bigint: true });
    let unchanged = false;
    for (const input of inputsBySize.get(stat.size) || []) {
      if (input.file === file || (input.stat.dev === stat.dev && input.stat.ino === stat.ino)
        || await hash(file, stat) === await hash(input.file, input.stat)) {
        unchanged = true;
        break;
      }
    }
    if (!unchanged) retained.push(output);
  }
  return retained;
}
