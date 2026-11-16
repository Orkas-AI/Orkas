'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { analyzeMedia } = require('./lib/video_analyze_core.cjs');
const { editSelectedIntervals } = require('./lib/video_edit_core.cjs');

function fail(code, message) { throw Object.assign(new Error(message), { code }); }
async function digest(file) {
  const hash = createHash('sha256');
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}

/** Listing never chooses a take. Execution requires IDs from the same measured source. */
module.exports = async function cutSelection({ args }) {
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--help') return { ok: true, script: 'cut_selection',
      usage: '--input video --transcript words.json; then add --keep "[1,3]" --selection-id <returned id> --output clean.mp4' };
    if (!['--input', '--transcript', '--keep', '--selection-id', '--output'].includes(key) || !args[i + 1]) fail('E_SELECTION_ARGS', 'Unsupported or missing selection argument.');
    if (opts[key] !== undefined) fail('E_SELECTION_ARGS', 'Selection arguments must be unique.');
    opts[key] = args[++i];
  }
  if (!opts['--input'] || !opts['--transcript']) fail('E_SELECTION_ARGS', 'Selection requires source media and its saved word transcript.');
  const input = path.resolve(opts['--input']), transcript = path.resolve(opts['--transcript']);
  for (const file of [input, transcript]) if (!fs.statSync(file).isFile()) fail('E_SELECTION_INPUT', 'Selection inputs must be regular files.');
  const sourceSha = await digest(input), transcriptSha = await digest(transcript);
  const analysis = await analyzeMedia({ op: 'phrases', inputAbsPath: input, transcriptAbsPath: transcript, structuredPhrases: true });
  if (!analysis.ok) fail(analysis.errorCode, analysis.message);
  if (analysis.summary.timing !== 'word') fail('E_SELECTION_TIMING', 'Selection requires measured word-level transcription.');
  const rows = analysis.summary.phrases;
  if (!Array.isArray(rows) || !rows.length || rows.length > 1000) fail('E_SELECTION_TIMING', 'Selection requires 1–1000 measured phrases.');
  const candidates = rows.map((row, i) => ({ id: i + 1, ...row }));
  const selectionId = createHash('sha256').update(JSON.stringify([sourceSha, transcriptSha, candidates])).digest('hex');
  const view = { ok: true, selection_id: selectionId, source_sha256: sourceSha, candidates, note: analysis.summary.note };
  if (opts['--keep'] === undefined && opts['--output'] === undefined && opts['--selection-id'] === undefined) return view;
  if (opts['--selection-id'] !== selectionId) fail('E_SELECTION_STALE', 'The measured source or transcript changed; no cut was written.');
  let keep;
  try { keep = JSON.parse(opts['--keep']); } catch { fail('E_SELECTION_IDS', 'Keep must be a JSON array of phrase IDs.'); }
  if (!Array.isArray(keep) || !keep.length || keep.some((id, i) => !Number.isInteger(id) || id < 1
    || id > rows.length || (i > 0 && id <= keep[i - 1]))) fail('E_SELECTION_IDS', 'Keep IDs must be unique, in source order and from the measured candidate list.');
  if (!opts['--output']) fail('E_SELECTION_ARGS', 'Selection execution requires a separate output path.');
  const output = path.resolve(opts['--output']);
  if (output === input || output === transcript || fs.existsSync(output) || fs.existsSync(`${output}.selection.json`)) fail('E_SELECTION_OUTPUT', 'Selection output and its receipt must be new files.');
  const kept = [];
  let previous = 0;
  for (const id of keep) {
    const row = rows[id - 1], last = kept[kept.length - 1];
    // Adjacent selected phrases keep their original pause. Keeping every phrase
    // preserves the entire source, including its lead and tail, byte-for-byte.
    const start = id === 1 ? 0 : row.startSec;
    const end = id === rows.length ? analysis.summary.durationSec : row.endSec;
    if (last && id === previous + 1) last.endSec = end;
    else kept.push({ startSec: start, endSec: end });
    previous = id;
  }
  // Recheck the source identities after measurement before any output mutation.
  if (sourceSha !== await digest(input) || transcriptSha !== await digest(transcript)) fail('E_SELECTION_STALE', 'Selection input changed during analysis; no cut was written.');
  const result = await editSelectedIntervals({ inputAbsPath: input, outputAbsPath: output, kept });
  if (!result.ok) fail(result.errorCode, result.message);
  const receipt = { ...result, selection_id: selectionId, selected_ids: keep, source_sha256: sourceSha,
    output_sha256: await digest(output) };
  fs.writeFileSync(`${output}.selection.json`, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
  return receipt;
};
