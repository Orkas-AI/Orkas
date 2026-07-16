/**
 * Select the files that deserve a compact user-facing footer on a completed
 * assistant message. The workspace file listing remains the source of truth
 * for every supporting file; this module only decides what is prominent in
 * chat.
 *
 * The selector is deliberately conservative when no rendered/package output
 * exists: an ambiguous `.md`, `.py`, or `.json` may itself be what the user
 * requested, so it stays visible. When a higher-confidence terminal output is
 * present, likely sources and assets are suppressed from the message footer.
 */

import * as path from 'node:path';

const PROCESS_DIR_NAMES = new Set([
  '.cache', '.tmp', '.temp',
  'cache', 'caches',
  'intermediate', 'intermediates',
  'logs',
  'scratch',
  'temp', 'tmp',
  'thumbs', 'thumbnails',
  'work', 'working',
]);

const PROCESS_EXTS = new Set([
  'bak', 'log', 'map', 'pyc', 'temp', 'tmp',
]);

const PROCESS_EXACT_NAMES = new Set([
  '.ds_store',
  'debug.log',
  'manifest.json',
  'metadata.json',
]);

const EXPORTED_DOCUMENT_EXTS = new Set([
  'csv', 'doc', 'docx', 'key', 'numbers', 'pages', 'pdf',
  'ppt', 'pptx', 'xls', 'xlsx', 'zip',
]);
const VIDEO_EXTS = new Set(['m4v', 'mov', 'mp4', 'webm']);
const VIDEO_COMPANION_EXTS = new Set(['srt', 'vtt']);
const AUDIO_EXTS = new Set(['aac', 'flac', 'm4a', 'mp3', 'ogg', 'wav']);
const HTML_EXTS = new Set(['htm', 'html']);
const IMAGE_EXTS = new Set(['gif', 'jpeg', 'jpg', 'png', 'svg', 'webp']);

type ProducedCandidate = {
  path: string;
  ext: string;
};

function pathSegments(input: string): string[] {
  return String(input || '').split(/[\\/]/).filter(Boolean);
}

function extensionOf(input: string): string {
  return path.extname(input).slice(1).toLowerCase();
}

function isObviousProcessFile(input: string): boolean {
  const segments = pathSegments(input);
  if (!segments.length) return true;
  const base = segments[segments.length - 1].toLowerCase();
  // Only inspect the immediate parent. Absolute paths may legitimately live
  // below a user folder named `work` or `temp`; treating every ancestor as a
  // process hint would hide all outputs in that workspace.
  const parent = (segments[segments.length - 2] || '').toLowerCase();
  if (PROCESS_DIR_NAMES.has(parent)) return true;
  if (PROCESS_EXACT_NAMES.has(base)) return true;
  if (PROCESS_EXTS.has(extensionOf(base))) return true;
  return /(?:^|[-_.])(?:debug|preview|thumb|thumbnail|trace)(?=[-_.]|$)/i.test(base);
}

function uniqueCandidates(paths: Iterable<string>): ProducedCandidate[] {
  const out: ProducedCandidate[] = [];
  const seen = new Set<string>();
  for (const raw of paths) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value || seen.has(value) || isObviousProcessFile(value)) continue;
    seen.add(value);
    out.push({ path: value, ext: extensionOf(value) });
  }
  return out;
}

function pathsWithExts(
  candidates: readonly ProducedCandidate[],
  exts: ReadonlySet<string>,
): string[] {
  return candidates.filter((item) => exts.has(item.ext)).map((item) => item.path);
}

/**
 * Return only the high-confidence deliverables for a message footer.
 * Priority models common production chains:
 * source markdown/html/assets -> Office/PDF/archive, composition assets ->
 * rendered video/audio, and image-generation metadata -> final images.
 */
export function selectVisibleProducedFiles(
  paths: Iterable<string>,
  explicitlyPublished?: Iterable<string>,
): string[] {
  const allPaths: string[] = [];
  const available = new Set<string>();
  for (const raw of paths) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value || available.has(value)) continue;
    available.add(value);
    allPaths.push(value);
  }
  if (explicitlyPublished !== undefined) {
    const explicit: string[] = [];
    const explicitSeen = new Set<string>();
    for (const raw of explicitlyPublished) {
      const value = typeof raw === 'string' ? raw.trim() : '';
      if (!value || explicitSeen.has(value) || !available.has(value)) continue;
      explicitSeen.add(value);
      explicit.push(value);
    }
    // An explicit empty declaration is meaningful: the turn created working
    // files but has no file deliverable that belongs in the message footer.
    return explicit;
  }

  const candidates = uniqueCandidates(allPaths);
  if (!candidates.length) return [];

  const documents = pathsWithExts(candidates, EXPORTED_DOCUMENT_EXTS);
  if (documents.length) return documents;

  const videos = pathsWithExts(candidates, VIDEO_EXTS);
  if (videos.length) {
    return candidates
      .filter((item) => VIDEO_EXTS.has(item.ext) || VIDEO_COMPANION_EXTS.has(item.ext))
      .map((item) => item.path);
  }

  const html = pathsWithExts(candidates, HTML_EXTS);
  if (html.length) return html;

  const audio = pathsWithExts(candidates, AUDIO_EXTS);
  if (audio.length) return audio;

  const images = pathsWithExts(candidates, IMAGE_EXTS);
  if (images.length) return images;

  // No terminal-output signal: retain ambiguous files rather than hiding a
  // requested script, Markdown report, CSV, or JSON deliverable.
  return candidates.map((item) => item.path);
}
