'use strict';

// Explicit transcript-index cuts only. No text/intent matching or ASR replay.
const path = require('node:path');
const fs = require('node:fs/promises');
const { MEDIA_INPUT } = require('./composition.js');
function fail(message, code = 'E_WORD_EDIT') { throw Object.assign(new Error(message), { code }); }
function settings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(k => !['transcript_path', 'mode', 'ranges'].includes(k))
    || typeof value.transcript_path !== 'string' || !value.transcript_path
    || !['keep', 'remove'].includes(value.mode) || !Array.isArray(value.ranges) || !value.ranges.length || value.ranges.length > 100) fail('Word edits need a transcript, keep/remove mode and 1–100 index ranges.');
  let previous = -1;
  for (const r of value.ranges) {
    if (!r || Object.keys(r).some(k => !['first', 'last'].includes(k)) || !Number.isInteger(r.first) || !Number.isInteger(r.last) || r.first <= previous || r.last < r.first) fail('Use ordered, non-overlapping zero-based transcript index ranges.');
    previous = r.last;
  }
  return value;
}
function timed(segments, duration) {
  let previous = 0;
  if (!Array.isArray(segments) || segments.length > 40000) fail('Word timing is missing or too large.');
  for (const s of segments) {
    if (!s || typeof s.text !== 'string' || !s.text.trim() || !Number.isFinite(s.start_sec) || !Number.isFinite(s.end_sec)
      || s.start_sec < previous || s.end_sec <= s.start_sec || s.end_sec > duration + .001) fail('Word timing must be positive, ordered and inside the source.');
    previous = s.end_sec;
  }
  return segments;
}
function fromSegments(segments, duration) {
  const units = []; let prefix = '';
  // ASR may assign punctuation or another token no duration. Preserve its text
  // with an adjacent timed unit, never invent a new audio interval for it.
  for (const s of segments) {
    if (s.end_sec === s.start_sec) {
      if (units.length && s.start_sec === units.at(-1).end_sec) units.at(-1).text += s.text;
      else if (!units.length && s.start_sec === 0) prefix += s.text;
      else fail('Untimed text has no adjacent timed unit.');
    } else { units.push({ ...s, text: prefix + s.text }); prefix = ''; }
  }
  if (prefix) fail('Recognition returned text without usable word timing.');
  return timed(units, duration);
}
async function cut(root, temp, index, source, segment, duration, signal, h) {
  const edit = settings(segment.word_edit), transcript = await h.local(root, edit.transcript_path);
  // Admit bounded metadata before scanning its identity or the recording.
  const { data, sha256: transcriptHash } = await h.json(transcript, true);
  if (data.schema_version !== 1 || data.granularity !== 'word' || data.timing !== 'estimated') fail('Use a word-mode transcript for the original recording.');
  const info = await fs.stat(source);
  if (!info.isFile() || info.size > 8 * 1024 ** 3) fail('Use a regular recording up to 8 GiB for word editing.');
  const sourceHash = await h.digest(source, signal);
  if (data.source_sha256 !== sourceHash) fail('The source changed after transcription. Transcribe the current recording before editing.', 'E_TRANSCRIPT_STALE');
  const units = timed(data.segments, duration), start = segment.start_sec ?? 0, end = segment.end_sec ?? duration;
  const chosen = edit.ranges.map(r => {
    if (r.first < 0 || r.last >= units.length) fail('A selected word index is outside the transcript.');
    const a = units[r.first].start_sec, b = units[r.last].end_sec;
    if (a < start || b > end) fail('Selected words must lie inside the segment trim window.');
    return [a, b];
  });
  const keep = [];
  if (edit.mode === 'keep') keep.push(...chosen);
  else { let at = start; for (const [a, b] of chosen) { if (a > at) keep.push([at, a]); at = b; } if (at < end) keep.push([at, end]); }
  if (!keep.length) fail('This edit would remove the entire recording.');
  const graph = keep.map(([a, b], i) => `[0:a]atrim=start=${a}:end=${b},asetpts=PTS-STARTPTS[c${i}]`);
  graph.push(`${keep.map((_, i) => `[c${i}]`).join('')}concat=n=${keep.length}:v=0:a=1[out]`);
  const name = `words-${index}.wav`, file = path.join(temp, name);
  const maxBytes = 2 * 1024 ** 3;
  await h.run(await h.binary('ORKAS_BUNDLED_FFMPEG'), ['-v', 'error', '-xerror', '-nostdin', ...MEDIA_INPUT, '-i', source, '-filter_complex', graph.join(';'), '-map', '[out]', '-ar', '48000', '-ac', String(h.channels), '-c:a', 'pcm_s16le', '-fs', String(maxBytes), file], signal);
  if ((await fs.stat(file)).size >= maxBytes) fail('The word edit exceeds 2 GiB; split it into chapters.');
  if (await h.digest(source, signal) !== sourceHash) fail('The source changed during editing.', 'E_TRANSCRIPT_STALE');
  if (await h.digest(transcript, signal) !== transcriptHash) fail('The transcript changed during editing.', 'E_TRANSCRIPT_STALE');
  let cursor = 0;
  const map = keep.map(([a, b]) => { const from = cursor; cursor += b - a; return { input_start_sec: a, input_end_sec: b, output_start_sec: from, output_end_sec: cursor }; });
  return { path: file, name, duration: cursor, receipt: { segment_id: segment.id, source_sha256: sourceHash, transcript_sha256: transcriptHash, timing: 'estimated', mode: edit.mode, ranges: edit.ranges, time_map: map } };
}
module.exports = { settings, timed, fromSegments, cut };
