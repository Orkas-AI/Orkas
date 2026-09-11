import { open } from 'node:fs/promises';

// Bounded calculation inputs, not a source-data format or ingestion engine.
const MAX_BYTES = 8 * 1024 * 1024;

export function check(condition, message) {
  if (!condition) throw new Error(message);
}

export function fields(value, allowed, label = 'input') {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object.`);
  check(Object.keys(value).every(key => allowed.includes(key)), `${label} accepts only: ${allowed.join(', ')}.`);
}

export function probability(value, label) {
  check(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1, `${label} must be a number between 0 and 1.`);
}

export async function input(args) {
  check(args.length === 2 && ['--json', '--input'].includes(args[0]), 'Use --json <object> or --input <JSON file>.');
  let raw = args[1];
  if (args[0] === '--input') {
    let handle;
    try {
      handle = await open(raw, 'r');
      const stat = await handle.stat();
      check(stat.isFile() && stat.size <= MAX_BYTES, 'Input must be a regular file of at most 8 MiB. Aggregate or partition larger inputs first.');
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      check(length <= MAX_BYTES, 'Input exceeds 8 MiB. Aggregate or partition it first.');
      raw = buffer.subarray(0, length).toString('utf8');
    } catch (error) {
      if (error.code) throw new Error('Cannot read the input file. Check the supplied path and read permission.');
      throw error;
    } finally {
      await handle?.close();
    }
  }
  check(Buffer.byteLength(raw, 'utf8') <= MAX_BYTES, 'Input exceeds 8 MiB. Aggregate or partition it first.');
  try { return JSON.parse(raw.replace(/^\uFEFF/u, '')); }
  catch { throw new Error('Input must be valid JSON; preserve exact decimal amounts as strings.'); }
}

export function entry(calculate) {
  return async ({ args }) => {
    try { return { ok: true, ...calculate(await input(args)) }; }
    catch (error) { return { ok: false, error: { code: 'INVALID_INPUT', message: error.message } }; }
  };
}
