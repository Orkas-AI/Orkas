'use strict';

const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');

const OPS = new Set(['draft', 'render', 'lint', 'inspect']);
const QUALITY = new Set(['draft', 'standard', 'high']);
const FORMAT = new Set(['mp4', 'webm']);
const FINDINGS_INLINE = new Set(['full', 'summary', 'none']);
const LOCAL_GSAP_VENDOR_REF = 'assets/vendor/gsap.min.js';
const REQUIRED_GSAP_TIMELINE_APIS = ['timeScale', 'totalTime', 'totalDuration', 'getChildren'];
const DRAFT_REPAIR_MAX_PASSES = 2;
const DRAFT_VISUAL_ADVISORY_CODES = new Set([
  'FONT_TOO_SMALL',
  'PALETTE_LARGE',
  'LOW_CONTRAST',
  'TEXT_BOX_OVERFLOW',
  'TEXT_OCCLUDED',
  'TEXT_OVERFLOW',
  'TEXT_CLIPPED',
  'CONTENT_OVERLAP',
  'CONTENT_OCCLUDED',
  'CONTENT_OVERFLOW',
  'CONTENT_CLIPPED',
  'SAFE_AREA_VIOLATION',
]);

function fail(code, message, extra = {}) {
  process.stderr.write(JSON.stringify({ ok: false, code, message, ...extra }) + '\n');
  process.exit(1);
}

// Best-effort progress JSONL on stderr (same protocol as video_edit); the
// direct-CLI runner forwards these lines to the user-facing tool progress.
// Throttled so a long render cannot flood the runner's output buffer.
const PROGRESS_EMIT_MIN_MS = 2000;
let lastProgressEmitMs = 0;
function makeProgressEmitter(op) {
  return (event) => {
    const now = Date.now();
    if (now - lastProgressEmitMs < PROGRESS_EMIT_MIN_MS) return;
    lastProgressEmitMs = now;
    const payload = {
      type: 'progress',
      source: 'render_composition',
      op,
      phase: (event && event.phase) ? event.phase : op,
      ...((event && event.message) ? { message: event.message } : {}),
    };
    try {
      process.stderr.write(JSON.stringify(payload) + '\n');
    } catch {
      // Progress must never break the render.
    }
  };
}

// Absolute path for a per-op HyperFrames diagnostic log under project/render/.
// The backend writes the full stdout+stderr there so a failed/slow render
// (browserGpuMode, RAM, worker crash, timeout) is diagnosable. Overwritten
// each run — the latest is what you want when chasing a failure.
function renderLogPath(compositionDirAbs, name) {
  return path.join(path.resolve(compositionDirAbs, '..', 'render'), `${name}-hyperframes.log`);
}

function help() {
  return {
    ok: true,
    script: 'render_composition',
    ops: [...OPS],
    usage: 'stage-compose render_composition -- --op <draft|inspect|lint|render> --composition-dir <dir> [--strict-craft] [--findings-output <json>] [--findings-inline <full|summary|none>] [--output <video>] [--report <json>]. draft renders hand-authored index.html; spec compilation is not supported.',
  };
}

function nextValue(args, i, name) {
  if (i + 1 >= args.length) fail('E_ARGS', `${name} requires a value`);
  return args[i + 1];
}

function parseNumber(raw, label) {
  const n = Number(raw);
  if (!Number.isFinite(n)) fail('E_ARGS', `${label} must be a number`);
  return n;
}

function parseJson(raw, label) {
  const text = String(raw || '').trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch (err) {
    fail('E_ARGS', `${label} is not valid JSON: ${err.message}`);
  }
}

function parseArgs(args) {
  const out = {
    op: 'render',
    compositionDir: '',
    outputPath: '',
    specPath: '',
    reportPath: '',
    help: false,
    strictCraft: false,
    normalizeAudio: true,
    videoQa: true,
    findingsOutputPath: '',
    findingsInline: '',
  };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--strict-craft') out.strictCraft = true;
    else if (a === '--normalize-audio') out.normalizeAudio = true;
    else if (a === '--skip-normalize-audio' || a === '--no-normalize-audio') out.normalizeAudio = false;
    else if (a === '--skip-video-qa' || a === '--no-video-qa') out.videoQa = false;
    else if (a === '--op' || a === '-o') { out.op = nextValue(args, i, a); i += 1; }
    else if (a.startsWith('--op=')) out.op = a.slice('--op='.length);
    else if (a === '--composition-dir' || a === '--dir' || a === '-d') { out.compositionDir = nextValue(args, i, a); i += 1; }
    else if (a.startsWith('--composition-dir=')) out.compositionDir = a.slice('--composition-dir='.length);
    else if (a.startsWith('--dir=')) out.compositionDir = a.slice('--dir='.length);
    else if (a === '--output' || a === '--output-path') { out.outputPath = nextValue(args, i, a); i += 1; }
    else if (a.startsWith('--output=')) out.outputPath = a.slice('--output='.length);
    else if (a.startsWith('--output-path=')) out.outputPath = a.slice('--output-path='.length);
    else if (a === '--report' || a === '--report-path') { out.reportPath = nextValue(args, i, a); i += 1; }
    else if (a.startsWith('--report=')) out.reportPath = a.slice('--report='.length);
    else if (a.startsWith('--report-path=')) out.reportPath = a.slice('--report-path='.length);
    else if (a === '--spec' || a === '--spec-path') { out.specPath = nextValue(args, i, a); i += 1; }
    else if (a.startsWith('--spec=')) out.specPath = a.slice('--spec='.length);
    else if (a.startsWith('--spec-path=')) out.specPath = a.slice('--spec-path='.length);
    else if (a === '--findings-output') { out.findingsOutputPath = nextValue(args, i, a); i += 1; }
    else if (a.startsWith('--findings-output=')) out.findingsOutputPath = a.slice('--findings-output='.length);
    else if (a === '--findings-inline') { out.findingsInline = nextValue(args, i, a); i += 1; }
    else if (a.startsWith('--findings-inline=')) out.findingsInline = a.slice('--findings-inline='.length);
    else if (a === '--quality') { out.quality = nextValue(args, i, a); i += 1; }
    else if (a.startsWith('--quality=')) out.quality = a.slice('--quality='.length);
    else if (a === '--format') { out.format = nextValue(args, i, a); i += 1; }
    else if (a.startsWith('--format=')) out.format = a.slice('--format='.length);
    else if (a === '--fps') { out.fps = parseNumber(nextValue(args, i, a), a); i += 1; }
    else if (a.startsWith('--fps=')) out.fps = parseNumber(a.slice('--fps='.length), '--fps');
    else if (a === '--variables') { out.variables = parseJson(nextValue(args, i, a), a); i += 1; }
    else if (a.startsWith('--variables=')) out.variables = parseJson(a.slice('--variables='.length), '--variables');
    else if (!out.compositionDir) out.compositionDir = a;
    else if (!out.outputPath) out.outputPath = a;
    else fail('E_ARGS', `unexpected argument: ${a}`);
  }
  return out;
}

function resolveDir(raw) {
  const abs = path.resolve(process.cwd(), String(raw || '').trim());
  const st = fs.existsSync(abs) ? fs.statSync(abs) : null;
  if (!st || !st.isDirectory()) fail('E_INPUT', `composition_dir is not a directory: ${abs}`, { path: abs });
  return abs;
}

function resolveOrCreateDir(raw) {
  const abs = path.resolve(process.cwd(), String(raw || '').trim());
  fs.mkdirSync(abs, { recursive: true });
  const st = fs.existsSync(abs) ? fs.statSync(abs) : null;
  if (!st || !st.isDirectory()) fail('E_INPUT', `composition_dir is not a directory: ${abs}`, { path: abs });
  return abs;
}

function resolveOutputPath(raw) {
  return path.resolve(process.cwd(), String(raw || '').trim());
}

function parseLeadingJson(text) {
  const raw = String(text || '').trim();
  if (!raw.startsWith('{')) return null;
  const craftIndex = raw.indexOf('\n\n[craft]');
  const jsonText = craftIndex >= 0 ? raw.slice(0, craftIndex).trim() : raw;
  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

function shortText(value, max = 220) {
  const s = String(value || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function summarizeFindings(findings) {
  const parsed = parseLeadingJson(findings);
  const issues = parsed && Array.isArray(parsed.issues)
    ? parsed.issues
    : (parsed && Array.isArray(parsed.findings) ? parsed.findings : []);
  const codeCounts = new Map();
  for (const issue of issues) {
    const code = shortText(issue && issue.code ? issue.code : 'ISSUE', 80);
    const severity = shortText(issue && issue.severity ? issue.severity : '', 40);
    const key = `${severity}\u0000${code}`;
    const prev = codeCounts.get(key) || { code, severity, count: 0 };
    prev.count += 1;
    codeCounts.set(key, prev);
  }
  const topIssues = issues.slice(0, 8).map((issue) => ({
    code: shortText(issue && issue.code ? issue.code : 'ISSUE', 80),
    severity: shortText(issue && issue.severity ? issue.severity : '', 40),
    selector: shortText(issue && issue.selector ? issue.selector : '', 120),
    message: shortText(issue && issue.message ? issue.message : issue, 260),
  }));
  const craftLines = String(findings || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- ') || line.startsWith('  - '))
    .slice(0, 8)
    .map((line) => shortText(line.replace(/^\s*-\s*/, ''), 260));
  return {
    parseable: !!parsed,
    ok: parsed && typeof parsed.ok === 'boolean' ? parsed.ok : undefined,
    errorCount: parsed && typeof parsed.errorCount === 'number' ? parsed.errorCount : undefined,
    warningCount: parsed && typeof parsed.warningCount === 'number' ? parsed.warningCount : undefined,
    issueCount: parsed && typeof parsed.issueCount === 'number' ? parsed.issueCount : issues.length,
    totalIssueCount: parsed && typeof parsed.totalIssueCount === 'number' ? parsed.totalIssueCount : issues.length,
    issueCodes: [...codeCounts.values()].sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
    topIssues,
    craft: craftLines,
    rawChars: String(findings || '').length,
  };
}

function findingsIssues(findings) {
  const parsed = parseLeadingJson(findings);
  if (parsed && Array.isArray(parsed.issues)) return parsed.issues;
  if (parsed && Array.isArray(parsed.findings)) return parsed.findings;
  return [];
}

function isDraftVisualAdvisory(issue) {
  const rawCode = issue && issue.code ? String(issue.code) : '';
  const code = rawCode.toUpperCase();
  const lower = rawCode.toLowerCase();
  return DRAFT_VISUAL_ADVISORY_CODES.has(code)
    || lower.includes('overflow')
    || lower.includes('overlap')
    || lower.includes('occlud')
    || lower.includes('clipp')
    || lower.includes('contrast')
    || lower.includes('font')
    || lower.includes('safe_area');
}

function summarizeDraftInspectDisposition(findings) {
  const issues = findingsIssues(findings);
  const blocking = [];
  const advisory = [];
  for (const issue of issues) {
    const severity = String(issue && issue.severity ? issue.severity : '').toLowerCase();
    if (severity === 'error' && !isDraftVisualAdvisory(issue)) blocking.push(issue);
    else advisory.push(issue);
  }
  return {
    blocking_error_count: blocking.length,
    advisory_count: advisory.length,
    blocking_codes: [...new Set(blocking.map((issue) => shortText(issue && issue.code ? issue.code : 'ISSUE', 80)))],
    advisory_codes: [...new Set(advisory.map((issue) => shortText(issue && issue.code ? issue.code : 'ISSUE', 80)))],
    blocking_issues: blocking.slice(0, 8).map((issue) => ({
      code: shortText(issue && issue.code ? issue.code : 'ISSUE', 80),
      severity: shortText(issue && issue.severity ? issue.severity : '', 40),
      selector: shortText(issue && issue.selector ? issue.selector : '', 120),
      message: shortText(issue && issue.message ? issue.message : issue, 260),
    })),
    advisory_issues: advisory.slice(0, 8).map((issue) => ({
      code: shortText(issue && issue.code ? issue.code : 'ISSUE', 80),
      severity: shortText(issue && issue.severity ? issue.severity : '', 40),
      selector: shortText(issue && issue.selector ? issue.selector : '', 120),
      message: shortText(issue && issue.message ? issue.message : issue, 260),
    })),
  };
}

function writeFindingsOutput(rawPath, payload) {
  const abs = resolveOutputPath(rawPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(payload, null, 2), 'utf8');
  return abs;
}

function withFormatExtension(rawAbs, format) {
  return path.extname(rawAbs) ? rawAbs : `${rawAbs}.${format}`;
}

function uniquifyOutputPath(requested) {
  if (!fs.existsSync(requested)) return { finalPath: requested, renamed: false };

  const { dir, name, ext } = path.parse(requested);
  for (let n = 2; n < 10000; n += 1) {
    const candidate = path.join(dir, `${name}-${n}${ext}`);
    if (!fs.existsSync(candidate)) return { finalPath: candidate, renamed: true };
  }
  fail('E_OUTPUT', `could not find a non-conflicting output path under ${dir}`, { path: requested });
}

async function outputFile(raw, format) {
  if (!raw) fail('E_ARGS', '--output is required for op=render or op=draft');
  const requested = withFormatExtension(path.resolve(process.cwd(), String(raw).trim()), format);
  const { finalPath, renamed } = uniquifyOutputPath(requested);
  return { requested, finalPath, renamed };
}

function parseFps(raw) {
  const s = String(raw || '').trim();
  if (!s) return 30;
  const [a, b] = s.split('/').map(Number);
  if (Number.isFinite(a) && Number.isFinite(b) && b > 0) return a / b;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

function runProcess(command, args, opts = {}) {
  const res = childProcess.spawnSync(command, args, {
    cwd: opts.cwd || process.cwd(),
    env: opts.env || process.env,
    encoding: opts.encoding === 'buffer' ? undefined : 'utf8',
    maxBuffer: opts.maxBuffer || 20 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    const stderr = Buffer.isBuffer(res.stderr) ? res.stderr.toString('utf8') : String(res.stderr || '');
    const stdout = Buffer.isBuffer(res.stdout) ? res.stdout.toString('utf8') : String(res.stdout || '');
    throw new Error(`${command} exited ${res.status}: ${(stderr || stdout).trim().slice(-1800)}`);
  }
  return res;
}

function toolEnvName(kind) {
  return kind === 'ffmpeg' ? 'ORKAS_BUNDLED_FFMPEG' : 'ORKAS_BUNDLED_FFPROBE';
}

function resolveMediaTool(kind) {
  const direct = process.env[toolEnvName(kind)] || process.env[`HYPERFRAMES_${kind.toUpperCase()}_PATH`];
  const candidates = [direct, kind].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const res = childProcess.spawnSync(candidate, ['-version'], { stdio: 'ignore' });
      if (res.status === 0) return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  fail('E_MEDIA_TOOL_MISSING', `${kind} was not found in the bundled runtime or PATH`);
}

function probeMedia(mediaPath) {
  const ffprobe = resolveMediaTool('ffprobe');
  const res = runProcess(ffprobe, [
    '-v', 'error',
    '-show_entries', 'format=duration,size,bit_rate:stream=index,codec_type,codec_name,width,height,r_frame_rate,bit_rate',
    '-of', 'json',
    mediaPath,
  ]);
  const parsed = JSON.parse(String(res.stdout || '{}'));
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const video = streams.find((s) => s.codec_type === 'video') || {};
  const audio = streams.find((s) => s.codec_type === 'audio') || null;
  return {
    duration_seconds: Number(parsed.format && parsed.format.duration) || 0,
    size_bytes: Number(parsed.format && parsed.format.size) || 0,
    bit_rate: Number(parsed.format && parsed.format.bit_rate) || 0,
    video: {
      codec: video.codec_name || '',
      width: Number(video.width) || 0,
      height: Number(video.height) || 0,
      fps: parseFps(video.r_frame_rate),
      bit_rate: Number(video.bit_rate) || 0,
    },
    audio: audio ? {
      codec: audio.codec_name || '',
      bit_rate: Number(audio.bit_rate) || 0,
    } : null,
  };
}

function parseLastJsonObject(text) {
  const raw = String(text || '');
  const end = raw.lastIndexOf('}');
  if (end < 0) return null;
  const start = raw.lastIndexOf('{', end);
  if (start < 0) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

function analyzeLoudness(mediaPath) {
  const ffmpeg = resolveMediaTool('ffmpeg');
  const res = runProcess(ffmpeg, [
    '-hide_banner',
    '-nostats',
    '-i', mediaPath,
    '-af', 'loudnorm=I=-14:TP=-1:LRA=11:print_format=json',
    '-f', 'null',
    '-',
  ]);
  const text = `${res.stdout || ''}\n${res.stderr || ''}`;
  return parseLastJsonObject(text) || { raw_tail: shortText(text.slice(-1000), 1000) };
}

function normalizeAudioInPlace(mediaPath) {
  const ffmpeg = resolveMediaTool('ffmpeg');
  const ext = path.extname(mediaPath) || '.mp4';
  if (ext.toLowerCase() !== '.mp4') {
    return { skipped: true, reason: 'audio normalization is currently only applied to mp4 output' };
  }
  const tmp = path.join(path.dirname(mediaPath), `${path.basename(mediaPath, ext)}.norm-${Date.now()}${ext}`);
  runProcess(ffmpeg, [
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    '-i', mediaPath,
    '-af', 'loudnorm=I=-14:TP=-1:LRA=11',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    tmp,
  ]);
  fs.renameSync(tmp, mediaPath);
  return { skipped: false, path: mediaPath };
}

function loadTimelineMap(compositionDirAbs) {
  const candidates = [
    path.join(compositionDirAbs, 'scene-map.json'),
    path.join(compositionDirAbs, 'timeline.json'),
  ];
  for (const timelinePath of candidates) {
    if (!fs.existsSync(timelinePath)) continue;
    const loaded = readJsonFile(timelinePath);
    if (loaded.error) return { path: timelinePath, map: null, error: loaded.error };
    const timeline = Array.isArray(loaded.value) ? { scenes: loaded.value } : loaded.value;
    return { path: timelinePath, map: timeline && typeof timeline === 'object' ? timeline : null };
  }
  return { path: '', map: null };
}

// The contract's audio section can promise narration; if TTS failed (or was
// skipped) the composition renders silent and every other QA still passes.
// Make that gap visible instead of shipping a silent draft unnoticed.
function compositionHasAudio(html, compositionDirAbs) {
  if (/<audio\b/i.test(String(html || ''))) return true;
  return [
    path.join(compositionDirAbs, 'assets', 'narration.mp3'),
    path.join(compositionDirAbs, 'assets', 'narration.wav'),
    path.join(compositionDirAbs, 'narration.mp3'),
    path.join(compositionDirAbs, 'narration.wav'),
  ].some((file) => fs.existsSync(file));
}

function contractDeclaresNarrationAudio(contract) {
  const audio = contract && typeof contract === 'object' ? contract.audio : null;
  if (!audio || typeof audio !== 'object') return false;
  const text = JSON.stringify(audio).toLowerCase();
  if (/render[_-]?silent|"silent"\s*:\s*true|assemble/.test(text)) return false;
  return /\.(mp3|wav|m4a|aac|ogg)\b/.test(text);
}

function htmlNeedsSceneMap(compositionDirAbs) {
  const htmlPath = path.join(compositionDirAbs, 'index.html');
  let html = '';
  try {
    html = fs.readFileSync(htmlPath, 'utf8');
  } catch {
    return false;
  }
  return compositionHasAudio(html, compositionDirAbs);
}

function readJsonFile(jsonPath) {
  try {
    return { path: jsonPath, value: JSON.parse(fs.readFileSync(jsonPath, 'utf8')) };
  } catch (err) {
    return { path: jsonPath, value: null, error: err && err.message ? err.message : String(err) };
  }
}

function loadDesignContract(compositionDirAbs) {
  const contractPath = path.join(compositionDirAbs, 'design-contract.json');
  if (!fs.existsSync(contractPath)) return { path: contractPath, exists: false, contract: null };
  const loaded = readJsonFile(contractPath);
  return {
    path: contractPath,
    exists: true,
    contract: loaded.value && typeof loaded.value === 'object' ? loaded.value : null,
    error: loaded.error || '',
  };
}

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function normalizeForSearch(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/&[a-z0-9#]+;/gi, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function flattenStringValues(value, out = [], depth = 0) {
  if (depth > 6 || value === null || value === undefined) return out;
  if (typeof value === 'string') {
    const s = value.trim();
    if (s) out.push(s);
  } else if (Array.isArray(value)) {
    for (const item of value) flattenStringValues(item, out, depth + 1);
  } else if (typeof value === 'object') {
    for (const item of Object.values(value)) flattenStringValues(item, out, depth + 1);
  }
  return out;
}

function sceneDisplayTexts(scene) {
  if (!scene || typeof scene !== 'object') return [];
  const fields = [
    'headline',
    'title',
    'subtitle',
    'kicker',
    'label',
    'metric',
    'value',
    'cta',
    'copy',
    'on_screen_copy',
    'onscreen_copy',
    'onscreen_text',
    'display_text',
    'text',
  ];
  const out = [];
  for (const field of fields) {
    if (scene[field] !== undefined) flattenStringValues(scene[field], out);
  }
  return [...new Set(out.map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => s.length >= 3 && s.length <= 140))];
}

function htmlAttr(tag, name) {
  const re = new RegExp(`${name}\\s*=\\s*["']?([^"'\\s>]+)`, 'i');
  const match = String(tag || '').match(re);
  return match ? match[1] : '';
}

function htmlDataNumber(tag, name) {
  const raw = htmlAttr(tag, `data-${name}`);
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function rootCompositionTag(html) {
  const match = String(html || '').match(/<[^>]+\bdata-composition-id\s*=\s*["'][^"']+["'][^>]*>/i);
  return match ? match[0] : '';
}

function extractRemoteRefs(html) {
  const refs = [];
  const add = (kind, value) => {
    const ref = String(value || '').trim();
    if (/^https?:\/\//i.test(ref)) refs.push({ kind, ref: shortText(ref, 180) });
  };
  let match;
  const attrRe = /\b(src|href|poster)\s*=\s*["']([^"']+)["']/gi;
  while ((match = attrRe.exec(html)) !== null) add(match[1].toLowerCase(), match[2]);
  const urlRe = /\burl\(\s*["']?(https?:\/\/[^"')\s]+)["']?\s*\)/gi;
  while ((match = urlRe.exec(html)) !== null) add('css-url', match[1]);
  const importRe = /@import\s+(?:url\(\s*)?["']?(https?:\/\/[^"')\s;]+)["']?/gi;
  while ((match = importRe.exec(html)) !== null) add('css-import', match[1]);
  return refs;
}

function stripRefSuffix(ref) {
  return String(ref || '').trim().split(/[?#]/)[0];
}

function isIgnoredLocalRef(ref) {
  const raw = String(ref || '').trim();
  return !raw
    || raw.startsWith('#')
    || raw.startsWith('data:')
    || raw.startsWith('blob:')
    || raw.startsWith('mailto:')
    || raw.startsWith('tel:')
    || raw.startsWith('javascript:')
    || /^https?:\/\//i.test(raw);
}

function extractLocalRefs(html) {
  const refs = [];
  const add = (kind, value) => {
    const raw = String(value || '').trim();
    if (!isIgnoredLocalRef(raw)) refs.push({ kind, ref: stripRefSuffix(raw) });
  };
  let match;
  const attrRe = /\b(src|href|poster)\s*=\s*["']([^"']+)["']/gi;
  while ((match = attrRe.exec(html)) !== null) add(match[1].toLowerCase(), match[2]);
  const urlRe = /\burl\(\s*["']?([^"')]+)["']?\s*\)/gi;
  while ((match = urlRe.exec(html)) !== null) add('css-url', match[1]);
  return refs;
}

function normalizeRefPath(ref) {
  return stripRefSuffix(ref).replace(/^\.\/+/, '').replace(/\\/g, '/');
}

function extractScriptSrcs(html) {
  const out = [];
  let match;
  const scriptRe = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
  while ((match = scriptRe.exec(String(html || ''))) !== null) out.push(match[1]);
  return out;
}

function htmlUsesGsap(html) {
  return /\bgsap\s*\./.test(String(html || ''));
}

function hasLocalGsapVendorScript(html) {
  return extractScriptSrcs(html).some((src) => normalizeRefPath(src) === LOCAL_GSAP_VENDOR_REF);
}

function managedLegacyGsapVendor(text) {
  const s = String(text || '');
  return s.includes('Local HyperFrames timeline vendor')
    || s.includes('Provides the small GSAP-compatible surface VideoStudio compositions need');
}

function gsapVendorCompatibilityIssue(text) {
  const s = String(text || '');
  if (!s.trim()) return { code: 'VENDOR_GSAP_EMPTY', missing: REQUIRED_GSAP_TIMELINE_APIS };
  const missing = REQUIRED_GSAP_TIMELINE_APIS.filter((api) => !s.includes(api));
  return missing.length ? { code: 'VENDOR_GSAP_MISSING_TIMELINE_API', missing } : null;
}

function ensureVendorAssets(htmlPath, compositionDirAbs) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const copied = [];
  const skipped = [];
  const issues = [];
  if (!hasLocalGsapVendorScript(html)) {
    return { ok: true, copied, skipped, issues };
  }
  const source = path.join(__dirname, 'vendor', 'gsap.min.js');
  const target = path.join(compositionDirAbs, LOCAL_GSAP_VENDOR_REF);
  if (!fs.existsSync(source)) {
    issues.push({
      severity: 'error',
      code: 'VENDOR_GSAP_SOURCE_MISSING',
      repair_target: 'assets',
      message: `Local GSAP vendor source is missing: ${source}`,
    });
    return { ok: false, copied, skipped, issues };
  }
  const sourceText = fs.readFileSync(source, 'utf8');
  const sourceIssue = gsapVendorCompatibilityIssue(sourceText);
  if (sourceIssue) {
    issues.push({
      severity: 'error',
      code: 'VENDOR_GSAP_SOURCE_INCOMPATIBLE',
      repair_target: 'assets',
      missing_api: sourceIssue.missing,
      message: `Built-in GSAP vendor is missing required HyperFrames timeline APIs: ${sourceIssue.missing.join(', ')}.`,
    });
    return { ok: false, copied, skipped, issues };
  }

  if (fs.existsSync(target)) {
    const targetText = fs.readFileSync(target, 'utf8');
    if (managedLegacyGsapVendor(targetText)) {
      fs.copyFileSync(source, target);
      copied.push({ id: 'gsap', reason: 'replaced legacy managed vendor', path: target });
      return { ok: true, copied, skipped, issues };
    }
    const targetIssue = gsapVendorCompatibilityIssue(targetText);
    if (!targetIssue) {
      skipped.push({ id: 'gsap', reason: 'compatible existing vendor', path: target });
      return { ok: true, copied, skipped, issues };
    }
    issues.push({
      severity: 'error',
      code: 'VENDOR_GSAP_INCOMPATIBLE',
      repair_target: LOCAL_GSAP_VENDOR_REF,
      missing_api: targetIssue.missing,
      message: `Existing GSAP vendor is missing required HyperFrames timeline APIs: ${targetIssue.missing.join(', ')}. Remove or replace ${LOCAL_GSAP_VENDOR_REF}; do not patch it manually inside the composition.`,
    });
    return { ok: false, copied, skipped, issues };
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  copied.push({ id: 'gsap', path: target });
  return { ok: true, copied, skipped, issues };
}

function ensureVendorAssetsForComposition(compositionDirAbs) {
  const htmlPath = path.join(compositionDirAbs, 'index.html');
  if (!fs.existsSync(htmlPath)) return { ok: true, copied: [], skipped: [], issues: [] };
  return ensureVendorAssets(htmlPath, compositionDirAbs);
}

function failVendorAssetsIfNeeded(vendorAssets, reportAbs) {
  if (!vendorAssets || vendorAssets.ok !== false) return;
  const firstError = (vendorAssets.issues || []).find((issue) => issue.severity === 'error') || {};
  fail('E_VENDOR_ASSETS_BLOCKED', 'could not prepare local composition vendor assets', {
    ...(reportAbs ? { report_path: reportAbs } : {}),
    repair_target: firstError.repair_target || 'assets',
    vendor_assets: vendorAssets,
  });
}

function validateLocalRefs(refs, compositionDirAbs) {
  const issues = [];
  const seen = new Set();
  for (const item of refs) {
    const ref = item.ref;
    if (!ref || seen.has(`${item.kind}\u0000${ref}`)) continue;
    seen.add(`${item.kind}\u0000${ref}`);
    if (path.isAbsolute(ref)) {
      issues.push({
        severity: 'error',
        code: 'ABSOLUTE_ASSET_REF',
        repair_target: 'index.html',
        message: `Asset reference must be relative to the composition directory: ${ref}`,
      });
      continue;
    }
    let decoded = ref;
    try { decoded = decodeURIComponent(ref); } catch {}
    const abs = path.resolve(compositionDirAbs, decoded);
    const rel = path.relative(compositionDirAbs, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      issues.push({
        severity: 'error',
        code: 'ASSET_OUTSIDE_COMPOSITION',
        repair_target: 'assets',
        message: `Asset reference escapes the composition directory: ${ref}`,
      });
      continue;
    }
    if (!fs.existsSync(abs)) {
      issues.push({
        severity: 'error',
        code: 'MISSING_LOCAL_ASSET',
        repair_target: 'assets',
        message: `Referenced local asset does not exist: ${ref}`,
      });
    }
  }
  return issues;
}

function canvasFrom(value) {
  const canvas = value && typeof value === 'object' && value.canvas && typeof value.canvas === 'object'
    ? value.canvas
    : {};
  return {
    width: numberOrZero(canvas.width),
    height: numberOrZero(canvas.height),
    duration: numberOrZero(canvas.duration ?? canvas.duration_sec),
    fps: numberOrZero(canvas.fps),
  };
}

function expectedCanvas(contract, timelineMap) {
  const fromTimeline = canvasFrom(timelineMap);
  const fromContract = canvasFrom(contract);
  return {
    width: fromTimeline.width || fromContract.width,
    height: fromTimeline.height || fromContract.height,
    duration: fromTimeline.duration || fromContract.duration,
    fps: fromTimeline.fps || fromContract.fps,
  };
}

function compareCanvasPair(a, b) {
  const issues = [];
  for (const key of ['width', 'height', 'duration']) {
    if (a[key] && b[key] && Math.abs(a[key] - b[key]) > (key === 'duration' ? 0.15 : 1)) {
      issues.push({
        severity: 'error',
        code: 'CONTRACT_SCENE_MAP_CANVAS_MISMATCH',
        repair_target: 'design-contract.json',
        message: `design-contract canvas ${key}=${a[key]} but scene-map canvas ${key}=${b[key]}. Keep them identical before rendering.`,
      });
    }
  }
  return issues;
}

function colorTokenValues(contract) {
  const raw = contract && typeof contract === 'object' ? contract.color_tokens : null;
  return flattenStringValues(raw)
    .map((s) => s.trim())
    .filter((s) => /^(#[0-9a-f]{3,8}\b|rgba?\(|hsla?\()/i.test(s));
}

function runContractHtmlQa(htmlPath, contractInfo, timelineMap, compositionDirAbs) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const issues = [];
  const contract = contractInfo.contract;

  if (!contractInfo.exists) {
    issues.push({
      severity: 'error',
      code: 'DESIGN_CONTRACT_MISSING',
      repair_target: 'design-contract.json',
      message: 'project/composition/design-contract.json is required before drafting model-authored HTML.',
    });
  } else if (contractInfo.error || !contract) {
    issues.push({
      severity: 'error',
      code: 'DESIGN_CONTRACT_PARSE_FAILED',
      repair_target: 'design-contract.json',
      message: `Could not parse design-contract.json: ${contractInfo.error || 'not a JSON object'}`,
    });
  }

  for (const item of extractRemoteRefs(html)) {
    issues.push({
      severity: 'error',
      code: 'REMOTE_RUNTIME_RESOURCE',
      repair_target: 'index.html',
      message: `Remote runtime resource is not allowed during render (${item.kind}: ${item.ref}). Vendor it into project/composition/assets and reference it relatively.`,
    });
  }
  if (htmlUsesGsap(html) && !hasLocalGsapVendorScript(html)) {
    issues.push({
      severity: 'error',
      code: 'GSAP_VENDOR_SCRIPT_MISSING',
      repair_target: 'index.html',
      message: 'index.html uses gsap but does not load ./assets/vendor/gsap.min.js. Use the local vendor script or remove GSAP for this composition.',
    });
  }
  issues.push(...validateLocalRefs(extractLocalRefs(html), compositionDirAbs));

  const rootTag = rootCompositionTag(html);
  const rootCanvas = rootTag ? {
    width: htmlDataNumber(rootTag, 'width'),
    height: htmlDataNumber(rootTag, 'height'),
    duration: htmlDataNumber(rootTag, 'duration'),
  } : { width: 0, height: 0, duration: 0 };
  if (!rootTag) {
    issues.push({
      severity: 'error',
      code: 'ROOT_COMPOSITION_MISSING',
      repair_target: 'index.html',
      message: 'index.html must declare a root element with data-composition-id, data-width, data-height, and data-duration.',
    });
  }

  const expected = expectedCanvas(contract, timelineMap);
  if (contract && timelineMap) {
    issues.push(...compareCanvasPair(canvasFrom(contract), canvasFrom(timelineMap)));
  }
  for (const key of ['width', 'height', 'duration']) {
    if (!expected[key]) continue;
    const tolerance = key === 'duration' ? 0.15 : 1;
    if (!rootCanvas[key] || Math.abs(rootCanvas[key] - expected[key]) > tolerance) {
      issues.push({
        severity: 'error',
        code: 'CANVAS_CONTRACT_MISMATCH',
        repair_target: 'index.html',
        message: `index.html root data-${key}=${rootCanvas[key] || 'missing'} but contract/scene-map expects ${expected[key]}.`,
      });
    }
  }

  const timelineSceneList = timelineScenes(timelineMap);
  const contractScenes = contract && Array.isArray(contract.scenes) ? contract.scenes : [];
  const scenes = timelineSceneList.length ? timelineSceneList : contractScenes;
  const duration = expected.duration || rootCanvas.duration;
  let prevEnd = -1;
  for (const scene of scenes) {
    const start = numberOrZero(scene && (scene.start ?? scene.start_sec));
    const sceneDuration = numberOrZero(scene && (scene.duration ?? scene.duration_sec));
    if (!Number.isFinite(start) || !Number.isFinite(sceneDuration) || sceneDuration <= 0) {
      issues.push({
        severity: 'error',
        code: 'SCENE_TIMING_INVALID',
        repair_target: timelineSceneList.length ? 'scene-map.json' : 'design-contract.json',
        message: `Scene "${shortText(scene && (scene.id || scene.title || scene.headline) || 'unnamed', 80)}" needs numeric start and positive duration.`,
      });
      continue;
    }
    if (duration && start + sceneDuration > duration + 0.15) {
      issues.push({
        severity: 'error',
        code: 'SCENE_TIMING_OUT_OF_RANGE',
        repair_target: timelineSceneList.length ? 'scene-map.json' : 'design-contract.json',
        message: `Scene "${shortText(scene && (scene.id || scene.title || scene.headline) || 'unnamed', 80)}" ends at ${(start + sceneDuration).toFixed(2)}s beyond the composition duration ${duration.toFixed(2)}s.`,
      });
    }
    if (prevEnd >= 0 && start < prevEnd - 0.15) {
      issues.push({
        severity: 'error',
        code: 'SCENE_TIMING_OVERLAP',
        repair_target: timelineSceneList.length ? 'scene-map.json' : 'design-contract.json',
        message: `Scene "${shortText(scene && (scene.id || scene.title || scene.headline) || 'unnamed', 80)}" starts before the prior scene ends.`,
      });
    }
    prevEnd = Math.max(prevEnd, start + sceneDuration);
  }

  const htmlSearch = normalizeForSearch(html);
  const missingText = [];
  for (const scene of scenes.slice(0, 16)) {
    for (const text of sceneDisplayTexts(scene).slice(0, 5)) {
      const needle = normalizeForSearch(text);
      if (needle && !htmlSearch.includes(needle)) {
        missingText.push({
          scene: shortText(scene && (scene.id || scene.title || scene.headline) || 'unnamed', 80),
          text: shortText(text, 100),
        });
      }
    }
  }
  for (const item of missingText.slice(0, 8)) {
    issues.push({
      severity: 'error',
      code: 'HTML_MISSING_SCENE_COPY',
      repair_target: 'index.html',
      message: `Scene "${item.scene}" declares on-screen copy not found in index.html: "${item.text}".`,
    });
  }

  const colors = colorTokenValues(contract);
  const htmlLower = html.toLowerCase();
  const unusedColors = colors.filter((color) => !htmlLower.includes(color.toLowerCase())).slice(0, 6);
  if (colors.length && unusedColors.length === colors.length) {
    issues.push({
      severity: 'warning',
      code: 'COLOR_TOKENS_NOT_USED',
      repair_target: 'index.html',
      message: 'No declared color_tokens appear in index.html. Use contract tokens as CSS variables or structured constants.',
    });
  }

  if (contractDeclaresNarrationAudio(contract) && !compositionHasAudio(html, compositionDirAbs)) {
    issues.push({
      severity: 'warning',
      code: 'NARRATION_DECLARED_BUT_SILENT',
      repair_target: 'index.html',
      message: 'design-contract.json audio declares composition-owned narration, but index.html has no <audio> element and no narration file exists. If TTS failed, tell the user and either fix the narration or explicitly proceed silent.',
    });
  }

  return {
    ok: !issues.some((issue) => issue.severity === 'error'),
    design_contract_path: contractInfo.path,
    html_path: htmlPath,
    expected_canvas: expected,
    root_canvas: rootCanvas,
    scene_count: scenes.length,
    remote_ref_count: extractRemoteRefs(html).length,
    local_ref_count: extractLocalRefs(html).length,
    issues,
  };
}

function timelineScenes(timelineMap) {
  return timelineMap && Array.isArray(timelineMap.scenes) ? timelineMap.scenes : [];
}

function timelineCanvas(timelineMap) {
  const canvas = timelineMap && typeof timelineMap.canvas === 'object' && timelineMap.canvas ? timelineMap.canvas : {};
  return {
    duration: Number(canvas.duration) || 0,
    fps: Number(canvas.fps) || 30,
  };
}

function narrationPathFromTimeline(timelineMap, compositionDirAbs) {
  const audio = timelineMap && typeof timelineMap.audio === 'object' && timelineMap.audio ? timelineMap.audio : {};
  const raw = audio.narration || audio.narration_path || audio.path;
  if (!raw) return '';
  return path.resolve(compositionDirAbs, String(raw));
}

function sceneNarrationText(scene) {
  if (!scene || typeof scene !== 'object') return '';
  const raw = scene.narration || scene.voiceover || scene.audio_text || scene.script;
  if (typeof raw === 'string') return raw.trim();
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return String(raw.text || raw.body || raw.line || '').trim();
  }
  return '';
}

function sceneNarrationRef(scene) {
  if (!scene || typeof scene !== 'object') return '';
  const raw = scene.narration_ref || scene.voiceover_ref || scene.script_ref;
  if (typeof raw === 'string') return raw.trim();
  if (Array.isArray(raw) && raw.length) return raw.map((x) => String(x)).join(',');
  return '';
}

function sceneNarrationRefs(scene) {
  const raw = sceneNarrationRef(scene);
  if (!raw) return [];
  return raw.split(/[, ]+/).map((x) => x.trim()).filter(Boolean);
}

function normalizeNarrationMap(raw) {
  const root = Array.isArray(raw) ? { lines: raw } : (raw && typeof raw === 'object' ? raw : {});
  const rawLines = Array.isArray(root.lines)
    ? root.lines
    : (Array.isArray(root.segments) ? root.segments : []);
  const lines = rawLines.filter((line) => line && typeof line === 'object').map((line, index) => ({
    id: String(line.id || line.line_id || line.ref || `line-${index + 1}`),
    start: numberOrZero(line.start ?? line.start_sec ?? line.begin),
    duration: numberOrZero(line.duration ?? line.duration_sec ?? line.target_sec),
    text: String(line.text || line.narration || line.body || '').trim(),
  }));
  const byId = new Map();
  for (const line of lines) byId.set(line.id, line);
  return { lines, byId };
}

function loadNarrationMap(compositionDirAbs) {
  const candidates = [
    path.join(compositionDirAbs, 'narration-map.json'),
    path.join(compositionDirAbs, 'audio-map.json'),
  ];
  for (const mapPath of candidates) {
    if (!fs.existsSync(mapPath)) continue;
    const loaded = readJsonFile(mapPath);
    if (loaded.error) return { path: mapPath, lines: [], byId: new Map(), error: loaded.error };
    return { path: mapPath, ...normalizeNarrationMap(loaded.value) };
  }
  return { path: '', lines: [], byId: new Map() };
}

function normalizeShotlist(raw) {
  const root = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? raw : {});
  const shots = Array.isArray(root) ? root : (root.shots || root.scenes || root.storyboard || []);
  if (!Array.isArray(shots)) return [];
  return shots.filter((shot) => shot && typeof shot === 'object').map((shot, index) => ({
    id: String(shot.id || shot.name || shot.shot || `shot-${index + 1}`),
    start: Number(shot.start ?? shot.start_sec ?? shot.in_sec),
    duration: Number(shot.duration ?? shot.duration_sec ?? shot.target_sec),
    narration: sceneNarrationText(shot),
  }));
}

function loadShotlist(compositionDirAbs) {
  const projectDir = path.dirname(compositionDirAbs);
  const candidates = [
    path.join(projectDir, 'shotlist.json'),
    path.join(projectDir, 'storyboard.json'),
  ];
  for (const shotlistPath of candidates) {
    if (!fs.existsSync(shotlistPath)) continue;
    try {
      return {
        path: shotlistPath,
        shots: normalizeShotlist(JSON.parse(fs.readFileSync(shotlistPath, 'utf8'))),
      };
    } catch (err) {
      return {
        path: shotlistPath,
        shots: [],
        error: err && err.message ? err.message : String(err),
      };
    }
  }
  return { path: '', shots: [] };
}

function sceneSourceShots(scene) {
  if (!scene || typeof scene !== 'object') return [];
  const raw = scene.source_shots || scene.shot_ids || scene.shots || scene.sourceShotIds;
  if (Array.isArray(raw)) return raw.map((x) => String(x)).filter(Boolean);
  if (typeof raw === 'string' && raw.trim()) return raw.split(/[, ]+/).map((x) => x.trim()).filter(Boolean);
  return [];
}

function hasMergeExplanation(timelineMap, scenes) {
  const alignment = timelineMap && typeof timelineMap === 'object'
    ? (timelineMap.source_alignment || timelineMap.alignment || timelineMap.timeline_alignment || {})
    : {};
  if (alignment && typeof alignment === 'object' && !Array.isArray(alignment)) {
    if (String(alignment.merge_reason || alignment.merge_policy || '').trim()) return true;
  }
  return scenes.some((scene) => String(scene.merge_reason || scene.alignment_note || '').trim())
    || scenes.every((scene) => sceneSourceShots(scene).length > 0);
}

function runSourceAlignmentQa(timelineMap, compositionDirAbs) {
  const scenes = timelineScenes(timelineMap);
  const shotlist = loadShotlist(compositionDirAbs);
  const issues = [];
  if (shotlist.error) {
    issues.push({
      severity: 'warning',
      code: 'SHOTLIST_PARSE_FAILED',
      message: `Could not parse ${shotlist.path}: ${shotlist.error}`,
    });
  }
  if (shotlist.shots.length && scenes.length && shotlist.shots.length !== scenes.length && !hasMergeExplanation(timelineMap, scenes)) {
    issues.push({
      severity: 'error',
      code: 'SHOTLIST_SCENE_COUNT_MISMATCH',
      message: `shotlist has ${shotlist.shots.length} shots but scene-map has ${scenes.length} scenes. Add source_alignment.merge_reason or per-scene source_shots when intentionally merging beats.`,
    });
  }
  return {
    ok: !issues.some((issue) => issue.severity === 'error'),
    skipped: !shotlist.path,
    shotlist_path: shotlist.path,
    shot_count: shotlist.shots.length,
    scene_count: scenes.length,
    issues,
  };
}

function buildVideoQaSamples(timelineMap, probe) {
  const duration = probe.duration_seconds || timelineCanvas(timelineMap).duration || 0;
  const scenes = timelineScenes(timelineMap);
  const samples = [{ id: 'first_frame', role: 'first_frame', time: 0 }];
  for (const scene of scenes.slice(0, 12)) {
    const id = shortText(scene && (scene.id || scene.name || scene.title) || 'scene', 80);
    const start = Number(scene && scene.start);
    const sceneDuration = Number(scene && (scene.duration || scene.duration_sec));
    if (!Number.isFinite(start) || !Number.isFinite(sceneDuration) || sceneDuration <= 0) continue;
    samples.push({ id, role: 'scene_start', time: Math.min(Math.max(start + 0.2, 0), Math.max(duration - 0.1, 0)) });
    samples.push({ id, role: 'scene_mid', time: Math.min(Math.max(start + sceneDuration / 2, 0), Math.max(duration - 0.1, 0)) });
  }
  return samples;
}

function sampleFrameStats(mediaPath, time) {
  const ffmpeg = resolveMediaTool('ffmpeg');
  const width = 160;
  const height = 90;
  const res = runProcess(ffmpeg, [
    '-hide_banner',
    '-loglevel', 'error',
    '-ss', Number(time).toFixed(3),
    '-i', mediaPath,
    '-frames:v', '1',
    '-vf', `scale=${width}:${height},format=rgb24`,
    '-f', 'rawvideo',
    'pipe:1',
  ], { encoding: 'buffer', maxBuffer: width * height * 3 + 1024 });
  const buf = res.stdout;
  if (!Buffer.isBuffer(buf) || buf.length < width * height * 3) throw new Error(`could not sample frame at ${time}s`);
  const luma = new Float32Array(width * height);
  let sum = 0;
  for (let i = 0, p = 0; i < luma.length; i += 1, p += 3) {
    const y = 0.2126 * buf[p] + 0.7152 * buf[p + 1] + 0.0722 * buf[p + 2];
    luma[i] = y;
    sum += y;
  }
  const mean = sum / luma.length;
  let variance = 0;
  let edgeSum = 0;
  let edgeCount = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = y * width + x;
      const d = luma[idx] - mean;
      variance += d * d;
      if (x > 0) { edgeSum += Math.abs(luma[idx] - luma[idx - 1]); edgeCount += 1; }
      if (y > 0) { edgeSum += Math.abs(luma[idx] - luma[idx - width]); edgeCount += 1; }
    }
  }
  const stddev = Math.sqrt(variance / luma.length);
  const edge = edgeCount ? edgeSum / edgeCount : 0;
  return {
    mean: Number(mean.toFixed(2)),
    stddev: Number(stddev.toFixed(2)),
    edge: Number(edge.toFixed(2)),
    fingerprint: crypto.createHash('sha1').update(buf.subarray(0, width * height * 3)).digest('hex').slice(0, 16),
    low_information: stddev < 14 && edge < 2.8,
  };
}

function detectStaticFrameRun(samples) {
  const visual = samples
    .filter((sample) => sample && !sample.error && sample.stats && sample.stats.fingerprint)
    .sort((a, b) => Number(a.time) - Number(b.time));
  let best = [];
  let run = [];
  for (const sample of visual) {
    const last = run[run.length - 1];
    if (last && last.stats.fingerprint === sample.stats.fingerprint) {
      run.push(sample);
    } else {
      if (run.length > best.length) best = run;
      run = [sample];
    }
  }
  if (run.length > best.length) best = run;
  if (best.length < 5) return null;
  const span = Number(best[best.length - 1].time) - Number(best[0].time);
  const sceneIds = new Set(best.map((sample) => `${sample.id || ''}`).filter(Boolean));
  if (span < 12 || sceneIds.size < 2) return null;
  return {
    count: best.length,
    start_time: Number(Number(best[0].time).toFixed(3)),
    end_time: Number(Number(best[best.length - 1].time).toFixed(3)),
    scene_count: sceneIds.size,
    fingerprint: best[0].stats.fingerprint,
  };
}

function writeContactSheet(mediaPath, samples, probe, reportPath) {
  if (!samples.length) return '';
  const ffmpeg = resolveMediaTool('ffmpeg');
  const fps = probe.video && probe.video.fps ? probe.video.fps : 30;
  const frames = [...new Set(samples.map((s) => Math.max(0, Math.round(s.time * fps))))].sort((a, b) => a - b).slice(0, 16);
  if (!frames.length) return '';
  const rows = Math.ceil(frames.length / 4);
  const selector = frames.map((n) => `eq(n\\,${n})`).join('+');
  const out = path.join(path.dirname(reportPath), `${path.basename(reportPath, path.extname(reportPath))}-contact-sheet.jpg`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  runProcess(ffmpeg, [
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    '-i', mediaPath,
    '-vf', `select=${selector},scale=420:-1,tile=4x${rows}`,
    '-frames:v', '1',
    out,
  ]);
  return out;
}

function safeFilePart(value) {
  const part = String(value || 'frame').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return part.slice(0, 80) || 'frame';
}

function writeEvidenceFrames(mediaPath, samples, reportPath) {
  const ffmpeg = resolveMediaTool('ffmpeg');
  const dir = path.join(path.dirname(reportPath), `${path.basename(reportPath, path.extname(reportPath))}-frames`);
  fs.mkdirSync(dir, { recursive: true });
  const frames = [];
  const seen = new Set();
  for (const sample of samples.slice(0, 16)) {
    const key = `${sample.role}\u0000${sample.id}\u0000${Number(sample.time).toFixed(3)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const filename = `${String(frames.length + 1).padStart(2, '0')}-${safeFilePart(sample.role)}-${safeFilePart(sample.id)}.jpg`;
    const out = path.join(dir, filename);
    runProcess(ffmpeg, [
      '-y',
      '-hide_banner',
      '-loglevel', 'error',
      '-ss', Number(sample.time).toFixed(3),
      '-i', mediaPath,
      '-frames:v', '1',
      '-vf', 'scale=960:-1',
      '-q:v', '3',
      out,
    ]);
    frames.push({
      id: sample.id,
      role: sample.role,
      time: sample.time,
      path: out,
    });
  }
  return { dir, frames };
}

function runVideoQa(mediaPath, timelineMap, probe, reportPath) {
  const samples = buildVideoQaSamples(timelineMap, probe);
  const issues = [];
  const sampled = samples.map((sample) => {
    try {
      const stats = sampleFrameStats(mediaPath, sample.time);
      const isBlockingRole = sample.role === 'first_frame' || sample.role === 'scene_start';
      if (isBlockingRole && stats.low_information) {
        issues.push({
          severity: 'error',
          code: sample.role === 'first_frame' ? 'FIRST_FRAME_EMPTY' : 'SCENE_START_EMPTY',
          sample: sample.id,
          time: sample.time,
          message: `${sample.role} at ${sample.time.toFixed(2)}s has too little visual information; keep the hook/title visible at scene start.`,
        });
      }
      return { ...sample, stats };
    } catch (err) {
      issues.push({
        severity: 'warning',
        code: 'FRAME_SAMPLE_FAILED',
        sample: sample.id,
        time: sample.time,
        message: err && err.message ? err.message : String(err),
      });
      return { ...sample, error: err && err.message ? err.message : String(err) };
    }
  });
  const staticRun = detectStaticFrameRun(sampled);
  if (staticRun) {
    issues.push({
      severity: 'error',
      code: 'STATIC_FRAME_RUN',
      ...staticRun,
      message: `${staticRun.count} sampled frames across ${staticRun.scene_count} scenes are pixel-identical from ${staticRun.start_time.toFixed(2)}s to ${staticRun.end_time.toFixed(2)}s; the render likely froze or the timeline is not being driven.`,
    });
  }
  let contactSheet = '';
  try {
    contactSheet = writeContactSheet(mediaPath, sampled, probe, reportPath);
  } catch (err) {
    issues.push({
      severity: 'warning',
      code: 'CONTACT_SHEET_FAILED',
      message: err && err.message ? err.message : String(err),
    });
  }
  let evidence = { dir: '', frames: [] };
  try {
    evidence = writeEvidenceFrames(mediaPath, sampled, reportPath);
  } catch (err) {
    issues.push({
      severity: 'warning',
      code: 'FRAME_EVIDENCE_FAILED',
      message: err && err.message ? err.message : String(err),
    });
  }
  const framePathByKey = new Map(evidence.frames.map((frame) => [
    `${frame.role}\u0000${frame.id}\u0000${Number(frame.time).toFixed(3)}`,
    frame.path,
  ]));
  return {
    ok: !issues.some((issue) => issue.severity === 'error'),
    issue_count: issues.length,
    issues,
    samples: sampled.map((sample) => ({
      ...sample,
      frame_path: framePathByKey.get(`${sample.role}\u0000${sample.id}\u0000${Number(sample.time).toFixed(3)}`) || '',
    })),
    contact_sheet: contactSheet,
    evidence_dir: evidence.dir,
    frame_paths: evidence.frames,
  };
}

function runAudioTimingQa(timelineMap, compositionDirAbs) {
  const scenes = timelineScenes(timelineMap);
  const narrationPath = narrationPathFromTimeline(timelineMap, compositionDirAbs);
  const narrationMap = loadNarrationMap(compositionDirAbs);
  const issues = [];
  if (narrationMap.error) {
    issues.push({
      severity: 'error',
      code: 'NARRATION_MAP_PARSE_FAILED',
      message: `Could not parse ${narrationMap.path}: ${narrationMap.error}`,
    });
  }
  if (narrationPath && !fs.existsSync(narrationPath)) {
    issues.push({
      severity: 'error',
      code: 'NARRATION_ASSET_MISSING',
      message: `scene-map declares narration audio but the file does not exist: ${narrationPath}`,
    });
    return {
      ok: false,
      skipped: false,
      narration_path: narrationPath,
      narration_map_path: narrationMap.path,
      issues,
    };
  }
  if (!narrationPath) {
    return {
      ok: !issues.some((issue) => issue.severity === 'error'),
      skipped: true,
      reason: 'no narration asset in scene-map',
      narration_map_path: narrationMap.path,
      issues,
    };
  }
  const narrationProbe = probeMedia(narrationPath);
  const duration = narrationProbe.duration_seconds || 0;
  if (scenes.length) {
    const last = scenes[scenes.length - 1] || {};
    const lastStart = Number(last.start);
    if (Number.isFinite(lastStart) && duration > 0 && lastStart > duration + 0.15) {
      issues.push({
        severity: 'warning',
        code: 'CLOSING_AFTER_NARRATION',
        message: `The final scene starts at ${lastStart.toFixed(2)}s but narration ends around ${duration.toFixed(2)}s. Align the closing visual with the final narrated line unless this is an intentional silent tail.`,
      });
    }
  }
  const mappedScenes = scenes.filter((scene) => sceneNarrationText(scene) || sceneNarrationRef(scene) || sceneSourceShots(scene).length);
  if (scenes.length >= 2 && mappedScenes.length < scenes.length) {
    issues.push({
      severity: 'error',
      code: 'SCENE_NARRATION_MISSING',
      message: `${scenes.length - mappedScenes.length} of ${scenes.length} scenes do not declare narration text or narration_ref, so voiceover-to-visual alignment cannot be verified.`,
    });
  }
  const refScenes = scenes.filter((scene) => sceneNarrationRefs(scene).length);
  if (refScenes.length && narrationMap.lines.length) {
    for (const scene of refScenes) {
      const refs = sceneNarrationRefs(scene);
      const lines = refs.map((ref) => narrationMap.byId.get(ref)).filter(Boolean);
      const missing = refs.filter((ref) => !narrationMap.byId.has(ref));
      if (missing.length) {
        issues.push({
          severity: 'error',
          code: 'NARRATION_REF_MISSING',
          scene: scene.id || scene.title || '',
          message: `Scene references narration line(s) not found in narration-map.json: ${missing.join(', ')}`,
        });
        continue;
      }
      const expectedStart = Math.min(...lines.map((line) => line.start));
      const expectedEnd = Math.max(...lines.map((line) => line.start + Math.max(line.duration, 0)));
      const actualStart = numberOrZero(scene.start ?? scene.start_sec);
      const actualEnd = actualStart + numberOrZero(scene.duration ?? scene.duration_sec);
      const startDrift = actualStart - expectedStart;
      if (Math.abs(startDrift) > 1.25) {
        issues.push({
          severity: 'error',
          code: 'NARRATION_LINE_START_DRIFT',
          scene: scene.id || scene.title || '',
          message: `Scene starts at ${actualStart.toFixed(2)}s but narration-map line timing starts at ${expectedStart.toFixed(2)}s (${startDrift.toFixed(2)}s drift).`,
        });
      }
      if (expectedEnd > actualEnd + 1.25) {
        issues.push({
          severity: 'error',
          code: 'NARRATION_LINE_OVERFLOWS_SCENE',
          scene: scene.id || scene.title || '',
          message: `Scene ends at ${actualEnd.toFixed(2)}s but referenced narration line(s) run until ${expectedEnd.toFixed(2)}s.`,
        });
      }
    }
  } else if (refScenes.length && !narrationMap.lines.length) {
    issues.push({
      severity: 'warning',
      code: 'NARRATION_MAP_MISSING',
      message: 'Scenes use narration_ref but no narration-map.json exists, so draft QA falls back to coarse timing checks.',
    });
  }
  const narratedScenes = scenes.filter((scene) => sceneNarrationText(scene));
  if (!narrationMap.lines.length && narratedScenes.length >= 2 && duration > 0) {
    const totalChars = narratedScenes.reduce((sum, scene) => sum + sceneNarrationText(scene).length, 0);
    let cursorChars = 0;
    for (const scene of narratedScenes) {
      const expectedStart = totalChars > 0 ? (cursorChars / totalChars) * duration : 0;
      const actualStart = Number(scene.start) || 0;
      const drift = actualStart - expectedStart;
      if (Math.abs(drift) > 3.5) {
        issues.push({
          severity: 'error',
          code: 'AUDIO_TIMING_DRIFT',
          scene: scene.id || scene.title || '',
          message: `Scene starts at ${actualStart.toFixed(2)}s but estimated narration timing is ${expectedStart.toFixed(2)}s (${drift.toFixed(2)}s drift).`,
        });
      }
      cursorChars += sceneNarrationText(scene).length;
    }
  } else if (!narrationMap.lines.length && mappedScenes.length >= 2 && narratedScenes.length < 2) {
    issues.push({
      severity: 'warning',
      code: 'AUDIO_TIMING_ESTIMATE_SKIPPED',
      message: 'Scenes use narration references or source_shots without inline narration text, so draft QA can verify mapping presence but cannot estimate timing drift.',
    });
  }
  return {
    ok: !issues.some((issue) => issue.severity === 'error'),
    skipped: false,
    narration_path: narrationPath,
    narration_map_path: narrationMap.path,
    narration_duration_seconds: duration,
    issues,
  };
}

function writeJsonFile(rawPath, payload) {
  const abs = resolveOutputPath(rawPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(payload, null, 2), 'utf8');
  return abs;
}

function readJsonFileIfExists(abs) {
  try {
    if (!abs || !fs.existsSync(abs)) return null;
    return JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch {
    return null;
  }
}

function draftRepairStatePath(compositionDirAbs) {
  return path.join(compositionDirAbs, 'qa', 'draft-repair-state.json');
}

function draftContentSignature(compositionDirAbs) {
  const hash = crypto.createHash('sha256');
  for (const name of ['design-contract.json', 'scene-map.json', 'narration-map.json', 'index.html']) {
    const abs = path.join(compositionDirAbs, name);
    if (!fs.existsSync(abs)) continue;
    hash.update(name);
    hash.update('\0');
    hash.update(fs.readFileSync(abs));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function normalizeRepairState(raw) {
  const failedAttempts = Math.max(0, Number(raw && raw.failed_attempts) || 0);
  return {
    status: raw && raw.status === 'failed' ? 'failed' : 'ok',
    failed_attempts: failedAttempts,
    repair_passes_used: Math.max(0, failedAttempts - 1),
    max_repair_passes: DRAFT_REPAIR_MAX_PASSES,
    last_error: raw && raw.last_error && typeof raw.last_error === 'object' ? raw.last_error : null,
    history: raw && Array.isArray(raw.history) ? raw.history.slice(-12) : [],
  };
}

function repairBudgetSummary(statePath, state) {
  const failedAttempts = Math.max(0, Number(state && state.failed_attempts) || 0);
  const used = Math.max(0, failedAttempts - 1);
  const budgetExhausted = failedAttempts > 0 && used >= DRAFT_REPAIR_MAX_PASSES;
  return {
    ok: !budgetExhausted,
    budget_exhausted: budgetExhausted,
    state_path: statePath,
    max_repair_passes: DRAFT_REPAIR_MAX_PASSES,
    failed_attempts: failedAttempts,
    repair_passes_used: used,
    repair_passes_remaining: Math.max(0, DRAFT_REPAIR_MAX_PASSES - used),
    last_error: state && state.last_error ? state.last_error : null,
  };
}

function initDraftRepairBudget(compositionDirAbs) {
  const statePath = draftRepairStatePath(compositionDirAbs);
  const state = normalizeRepairState(readJsonFileIfExists(statePath));
  const summary = repairBudgetSummary(statePath, state);
  return {
    compositionDirAbs,
    statePath,
    state,
    summary,
    blocked: state.status === 'failed' && summary.repair_passes_used >= DRAFT_REPAIR_MAX_PASSES,
  };
}

function writeRepairState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
}

function recordDraftFailure(repairBudget, reportAbs, code, message, extra = {}) {
  if (!repairBudget) return null;
  const previous = normalizeRepairState(readJsonFileIfExists(repairBudget.statePath) || repairBudget.state);
  const failedAttempts = previous.failed_attempts + 1;
  const entry = {
    ts: new Date().toISOString(),
    code,
    message: shortText(message, 300),
    report_path: reportAbs,
    repair_target: shortText(extra.repair_target || '', 120),
    content_signature: draftContentSignature(repairBudget.compositionDirAbs),
  };
  const next = {
    status: 'failed',
    max_repair_passes: DRAFT_REPAIR_MAX_PASSES,
    failed_attempts: failedAttempts,
    repair_passes_used: Math.max(0, failedAttempts - 1),
    last_error: entry,
    history: [...previous.history, entry].slice(-12),
  };
  writeRepairState(repairBudget.statePath, next);
  repairBudget.state = next;
  repairBudget.summary = repairBudgetSummary(repairBudget.statePath, next);
  repairBudget.blocked = repairBudget.summary.repair_passes_used >= DRAFT_REPAIR_MAX_PASSES;
  return repairBudget.summary;
}

function recordDraftSuccess(repairBudget, reportAbs, renderPath) {
  if (!repairBudget) return null;
  const previous = normalizeRepairState(readJsonFileIfExists(repairBudget.statePath) || repairBudget.state);
  const next = {
    status: 'ok',
    max_repair_passes: DRAFT_REPAIR_MAX_PASSES,
    failed_attempts: 0,
    repair_passes_used: 0,
    last_success: {
      ts: new Date().toISOString(),
      report_path: reportAbs,
      path: renderPath || '',
      content_signature: draftContentSignature(repairBudget.compositionDirAbs),
    },
    history: previous.history,
  };
  writeRepairState(repairBudget.statePath, next);
  repairBudget.state = next;
  repairBudget.summary = repairBudgetSummary(repairBudget.statePath, next);
  repairBudget.blocked = false;
  return repairBudget.summary;
}

function failDraft(report, reportAbs, code, message, extra = {}, repairBudget = null) {
  report.error = {
    code,
    message,
    ...(extra.repair_target ? { repair_target: extra.repair_target } : {}),
  };
  const budgetSummary = recordDraftFailure(repairBudget, reportAbs, code, message, extra);
  if (budgetSummary) {
    report.steps.repair_budget = budgetSummary;
    report.repair_budget = budgetSummary;
  }
  report.report_path = writeJsonFile(reportAbs, report);
  fail(code, message, {
    report_path: report.report_path,
    ...(budgetSummary ? { repair_budget: budgetSummary } : {}),
    ...extra,
  });
}

module.exports = async function renderCompositionScript({ args }) {
  const opts = parseArgs(args || []);
  if (opts.help) return help();
  if (!OPS.has(opts.op)) fail('E_ARGS', `op must be one of: ${[...OPS].join(', ')}`);
  if (opts.findingsInline && !FINDINGS_INLINE.has(opts.findingsInline)) {
    fail('E_ARGS', `--findings-inline must be one of: ${[...FINDINGS_INLINE].join(', ')}`);
  }
  if (!opts.compositionDir) fail('E_ARGS', '--composition-dir is required');

  if (opts.op === 'draft') {
    const compositionDirAbs = resolveOrCreateDir(opts.compositionDir);
    const format = FORMAT.has(opts.format) ? opts.format : 'mp4';
    const quality = QUALITY.has(opts.quality) ? opts.quality : 'draft';
    const out = await outputFile(opts.outputPath, format);
    const reportAbs = opts.reportPath
      ? resolveOutputPath(opts.reportPath)
      : path.join(path.dirname(out.finalPath), `${path.basename(out.finalPath, path.extname(out.finalPath))}-report.json`);
    const findingsAbs = opts.findingsOutputPath
      ? resolveOutputPath(opts.findingsOutputPath)
      : path.join(compositionDirAbs, 'qa', 'inspect.json');
    const lintFindingsAbs = path.join(compositionDirAbs, 'qa', 'lint.json');
    const report = {
      ok: false,
      op: 'draft',
      composition_dir: compositionDirAbs,
      requested_path: out.requested,
      path: out.finalPath,
      renamed: out.renamed,
      steps: {},
    };
    const repairBudget = initDraftRepairBudget(compositionDirAbs);
    report.steps.repair_budget = repairBudget.summary;
    report.repair_budget = repairBudget.summary;
    if (repairBudget.blocked) {
      report.error = {
        code: 'E_REPAIR_BUDGET_EXCEEDED',
        message: `Draft repair budget exceeded: the initial draft plus ${DRAFT_REPAIR_MAX_PASSES} repair pass(es) still failed. Stop and report the blocker instead of continuing to patch.`,
      };
      report.report_path = writeJsonFile(reportAbs, report);
      fail('E_REPAIR_BUDGET_EXCEEDED', report.error.message, {
        report_path: report.report_path,
        repair_budget: repairBudget.summary,
        last_error: repairBudget.summary.last_error,
      });
    }
    const { renderComposition, qaComposition, isConstrainedMachine, estimateRenderCost, renderCostDecision, degradedFps, machineRamGB } = require('./lib/video_render_core.cjs');
    try {
      if (opts.specPath || fs.existsSync(path.join(compositionDirAbs, 'spec.json'))) {
        failDraft(report, reportAbs, 'E_SPEC_COMPILER_REMOVED', 'COMPOSE spec compilation has been removed. Write project/composition/index.html directly and optional scene-map.json for timing QA.', {}, repairBudget);
      }
      const htmlPath = path.join(compositionDirAbs, 'index.html');
      if (!fs.existsSync(htmlPath)) {
        failDraft(report, reportAbs, 'E_RENDER_NO_COMPOSITION', `No hand-authored index.html found in ${compositionDirAbs}`, {}, repairBudget);
      }
      const timeline = loadTimelineMap(compositionDirAbs);
      if (timeline.error) {
        failDraft(report, reportAbs, 'E_SCENE_MAP_PARSE_FAILED', `Could not parse ${timeline.path}: ${timeline.error}`, {
          repair_target: path.basename(timeline.path),
        }, repairBudget);
      }
      const timelineMap = timeline.map;
      if (!timelineMap && htmlNeedsSceneMap(compositionDirAbs)) {
        failDraft(report, reportAbs, 'E_SCENE_MAP_REQUIRED', 'Narrated hand-authored HTML requires project/composition/scene-map.json so draft QA can verify voiceover-to-visual alignment.', {}, repairBudget);
      }
      const contractInfo = loadDesignContract(compositionDirAbs);
      report.authoring_mode = 'hand_authored_html';
      report.steps.authoring = {
        ok: true,
        mode: 'hand_authored_html',
        path: htmlPath,
        timeline_path: timeline.path || '',
        design_contract_path: contractInfo.path,
        text: 'Using model-authored project/composition/index.html.',
      };
      report.timeline_path = timeline.path || '';
      report.canvas = timelineMap ? timelineCanvas(timelineMap) : {};

      report.steps.vendor_assets = ensureVendorAssets(htmlPath, compositionDirAbs);
      if (report.steps.vendor_assets.ok === false) {
        const firstError = report.steps.vendor_assets.issues.find((issue) => issue.severity === 'error') || {};
        const repairTarget = firstError.repair_target || 'assets';
        failDraft(report, reportAbs, 'E_VENDOR_ASSETS_BLOCKED', 'could not prepare local composition vendor assets', {
          repair_target: repairTarget,
          vendor_assets: report.steps.vendor_assets,
        }, repairBudget);
      }

      report.steps.contract_html = runContractHtmlQa(htmlPath, contractInfo, timelineMap, compositionDirAbs);
      if (report.steps.contract_html.ok === false) {
        const firstError = report.steps.contract_html.issues.find((issue) => issue.severity === 'error') || {};
        const repairTarget = firstError.repair_target || 'index.html';
        failDraft(report, reportAbs, 'E_CONTRACT_HTML_BLOCKED', 'design-contract/scene-map/index.html consistency failed draft QA', {
          repair_target: repairTarget,
          contract_html: report.steps.contract_html,
        }, repairBudget);
      }

      report.steps.source_alignment = runSourceAlignmentQa(timelineMap, compositionDirAbs);
      if (report.steps.source_alignment.ok === false) {
        failDraft(report, reportAbs, 'E_SOURCE_ALIGNMENT_BLOCKED', 'script/shotlist/scene-map alignment failed draft QA', {
          source_alignment: report.steps.source_alignment,
        }, repairBudget);
      }

      report.steps.audio_timing = runAudioTimingQa(timelineMap, compositionDirAbs);
      if (report.steps.audio_timing.ok === false) {
        failDraft(report, reportAbs, 'E_AUDIO_TIMING_BLOCKED', 'audio timing drift failed draft QA', {
          audio_timing: report.steps.audio_timing,
        }, repairBudget);
      }

      // Render-resilience profile (P1/P2): weak/no-GPU machines software-render,
      // which is slow and memory-heavy. Detect the constraint, use the
      // low-memory render profile, and degrade a heavy DRAFT (lower fps) instead
      // of crashing / hanging. (A final render fails fast — handled below.)
      const renderCanvas = expectedCanvas(contractInfo.contract, timelineMap);
      const requestedFps = typeof opts.fps === 'number'
        ? opts.fps
        : (contractInfo.contract && contractInfo.contract.canvas && typeof contractInfo.contract.canvas.fps === 'number' ? contractInfo.contract.canvas.fps : 30);
      const ramGB = machineRamGB();
      const constrained = isConstrainedMachine(ramGB);
      const costUnits = estimateRenderCost(renderCanvas.width || 1920, renderCanvas.height || 1080, renderCanvas.duration || 0, requestedFps);
      const costDecision = renderCostDecision({ constrained, costUnits, isFinal: false });
      const renderFps = costDecision === 'degrade' ? degradedFps(requestedFps) : requestedFps;
      report.steps.render_profile = {
        constrained,
        machine_ram_gb: ramGB,
        cost_units: costUnits,
        decision: costDecision,
        ...(renderFps !== requestedFps ? { degraded_fps: `${requestedFps}→${renderFps}` } : {}),
      };

      const lint = await qaComposition('lint', {
        constrained,
        onProgress: makeProgressEmitter('draft'),
        logPath: renderLogPath(compositionDirAbs, 'qa-lint'),
        projectDirAbs: compositionDirAbs,
      });
      if (lint.ok === false) {
        report.steps.lint = {
          ok: false,
          error_code: lint.errorCode || 'E_LINT_FAILED',
          message: lint.message || 'lint failed',
        };
        failDraft(report, reportAbs, lint.errorCode || 'E_LINT_FAILED', lint.message || 'lint failed', {
          lint: report.steps.lint,
        }, repairBudget);
      }
      const lintSummary = summarizeFindings(lint.findings);
      report.steps.lint = {
        ok: lintSummary.ok,
        summary: lintSummary,
        findings_path: writeFindingsOutput(lintFindingsAbs, {
          ok: true,
          op: 'lint',
          summary: lintSummary,
          findings: lint.findings,
        }),
      };
      if (lintSummary.ok === false || (lintSummary.errorCount || 0) > 0) {
        failDraft(report, reportAbs, 'E_LINT_BLOCKED', 'HyperFrames lint failed; repair render-contract issues before inspect/render', {
          lint_summary: lintSummary,
        }, repairBudget);
      }

      const inspect = await qaComposition('inspect', {
        projectDirAbs: compositionDirAbs,
        strictCraft: true,
        constrained,
        onProgress: makeProgressEmitter('draft'),
        logPath: renderLogPath(compositionDirAbs, 'qa-inspect'),
      });
      if (inspect.ok === false) {
        report.steps.inspect = {
          ok: false,
          error_code: inspect.errorCode || 'E_INSPECT_FAILED',
          message: inspect.message || 'inspect failed',
        };
        failDraft(report, reportAbs, inspect.errorCode || 'E_INSPECT_FAILED', inspect.message || 'inspect failed', {
          inspect: report.steps.inspect,
        }, repairBudget);
      }
      const inspectSummary = summarizeFindings(inspect.findings);
      const inspectDisposition = summarizeDraftInspectDisposition(inspect.findings);
      const hasUnclassifiedInspectFailure = (inspectSummary.ok === false || (inspectSummary.errorCount || 0) > 0)
        && inspectDisposition.blocking_error_count === 0
        && inspectDisposition.advisory_count === 0;
      report.steps.inspect = {
        ok: inspectDisposition.blocking_error_count === 0 && !hasUnclassifiedInspectFailure,
        qa_ok: inspectSummary.ok,
        summary: inspectSummary,
        draft_disposition: inspectDisposition,
        findings_path: writeFindingsOutput(findingsAbs, {
          ok: true,
          op: 'inspect',
          summary: inspectSummary,
          draft_disposition: inspectDisposition,
          findings: inspect.findings,
        }),
      };
      if (inspectDisposition.blocking_error_count > 0 || hasUnclassifiedInspectFailure) {
        failDraft(report, reportAbs, 'E_INSPECT_BLOCKED', 'inspect found non-visual blockers; repair design-contract/scene-map/HTML before rendering', {
          inspect_summary: inspectSummary,
          draft_disposition: inspectDisposition,
        }, repairBudget);
      }

      const render = await renderComposition({
        projectDirAbs: compositionDirAbs,
        outputAbsPath: out.finalPath,
        quality,
        ...(typeof renderFps === 'number' ? { fps: renderFps } : {}),
        format,
        ...(opts.variables && typeof opts.variables === 'object' && !Array.isArray(opts.variables) ? { variables: opts.variables } : {}),
        constrained,
        onProgress: makeProgressEmitter('draft'),
        logPath: renderLogPath(compositionDirAbs, 'render'),
      });
      if (render.ok === false) {
        report.steps.render = render;
        failDraft(report, reportAbs, render.errorCode || 'E_RENDER_FAILED', render.message || 'render failed', {
          render,
        }, repairBudget);
      }
      report.steps.render = render;

      report.media_before_audio_postprocess = probeMedia(render.path);
      if (report.media_before_audio_postprocess.audio) {
        report.steps.loudness_before = analyzeLoudness(render.path);
        report.steps.audio_normalize = opts.normalizeAudio
          ? normalizeAudioInPlace(render.path)
          : { skipped: true, reason: 'disabled by args' };
      } else {
        report.steps.audio_normalize = { skipped: true, reason: 'no audio stream' };
      }
      report.media = probeMedia(render.path);
      if (report.media.audio) report.steps.loudness_after = analyzeLoudness(render.path);

      report.steps.video_qa = opts.videoQa
        ? runVideoQa(render.path, timelineMap, report.media, reportAbs)
        : { ok: true, skipped: true, reason: 'disabled by args' };
      if (report.steps.video_qa.ok === false) {
        failDraft(report, reportAbs, 'E_VIDEO_QA_BLOCKED', 'video-level QA failed; repair design-contract/scene-map/HTML before Gate D', {
          video_qa: report.steps.video_qa,
        }, repairBudget);
      }

      report.ok = true;
      const successBudget = recordDraftSuccess(repairBudget, reportAbs, render.path);
      if (successBudget) {
        report.steps.repair_budget = successBudget;
        report.repair_budget = successBudget;
      }
      report.report_path = writeJsonFile(reportAbs, report);
      return {
        ok: true,
        op: 'draft',
        path: render.path,
        bytes: render.bytes,
        media: `chat-media://local/${render.path}`,
        report_path: report.report_path,
        findings_path: report.steps.inspect.findings_path,
        contact_sheet: report.steps.video_qa.contact_sheet || '',
        evidence_dir: report.steps.video_qa.evidence_dir || '',
        frame_paths: report.steps.video_qa.frame_paths || [],
        probe: report.media,
        inspect: {
          ok: report.steps.inspect.ok,
          qa_ok: report.steps.inspect.qa_ok,
          advisory_count: report.steps.inspect.draft_disposition.advisory_count,
          blocking_error_count: report.steps.inspect.draft_disposition.blocking_error_count,
          advisory_issues: report.steps.inspect.draft_disposition.advisory_issues.slice(0, 6),
        },
        contract_html: report.steps.contract_html,
        source_alignment: report.steps.source_alignment,
        audio_timing: report.steps.audio_timing,
        video_qa: {
          ok: report.steps.video_qa.ok,
          issue_count: report.steps.video_qa.issue_count || 0,
          issues: (report.steps.video_qa.issues || []).slice(0, 6),
        },
        repair_budget: report.repair_budget,
        ...(render.diagnostics ? { render_diagnostics: render.diagnostics } : {}),
        ...(render.logPath ? { render_log_path: render.logPath } : {}),
        render_profile: report.steps.render_profile,
        text: `Draft rendered to ${render.path} (${render.diagnostics && render.diagnostics.gpuMode ? render.diagnostics.gpuMode + ' GPU mode' : 'render ok'})${report.steps.render_profile.degraded_fps ? `; drafted at reduced fps ${report.steps.render_profile.degraded_fps} because this machine has no GPU acceleration — the final render will need lower settings or a GPU machine` : ''}; QA report written to ${report.report_path}.`,
      };
    } catch (err) {
      if (err && err.code === 'E_MEDIA_TOOL_MISSING') throw err;
      failDraft(report, reportAbs, 'E_DRAFT_FAILED', err && err.message ? err.message : String(err), {}, repairBudget);
    }
  }

  const compositionDirAbs = resolveDir(opts.compositionDir);
  const vendorAssets = ensureVendorAssetsForComposition(compositionDirAbs);
  failVendorAssetsIfNeeded(vendorAssets);
  const { renderComposition, qaComposition, isConstrainedMachine, estimateRenderCost, renderCostDecision, degradedFps, machineRamGB } = require('./lib/video_render_core.cjs');

  if (opts.op === 'lint' || opts.op === 'inspect') {
    const result = await qaComposition(opts.op, {
      projectDirAbs: compositionDirAbs,
      strictCraft: opts.strictCraft,
      onProgress: makeProgressEmitter(opts.op),
      logPath: renderLogPath(compositionDirAbs, `qa-${opts.op}`),
    });
    if (result.ok === false) fail(result.errorCode, result.message, {
      ...(result.diagnostics ? { render_diagnostics: result.diagnostics } : {}),
      ...(result.logPath ? { render_log_path: result.logPath } : {}),
    });
    const summary = summarizeFindings(result.findings);
    const inline = opts.findingsInline || (opts.findingsOutputPath ? 'summary' : 'full');
    const payload = {
      ok: true,
      op: opts.op,
      summary,
      vendor_assets: vendorAssets,
      text: opts.findingsOutputPath
        ? `${opts.op} findings were summarized here and written to findings_path.`
        : (inline === 'full' ? `${opts.op} findings are available in findings.` : `${opts.op} findings were summarized here.`),
    };
    if (opts.findingsOutputPath) {
      payload.findings_path = writeFindingsOutput(opts.findingsOutputPath, {
        ok: true,
        op: opts.op,
        summary,
        findings: result.findings,
      });
    }
    if (inline === 'full') payload.findings = result.findings;
    else if (inline === 'summary') payload.findings_summary = summary;
    return payload;
  }

  const format = FORMAT.has(opts.format) ? opts.format : 'mp4';
  const quality = QUALITY.has(opts.quality) ? opts.quality : undefined;
  const out = await outputFile(opts.outputPath, format);

  // Render-resilience (P1/P2): a heavy composition on a weak/no-GPU machine will
  // software-render and likely crash or hang. A FINAL (high-quality) render
  // fails fast with an actionable message rather than a long hang; a
  // draft-quality standalone render degrades fps like the draft flow.
  let renderFps = typeof opts.fps === 'number' ? opts.fps : undefined;
  let constrained = false;
  try {
    const html = fs.readFileSync(path.join(compositionDirAbs, 'index.html'), 'utf8');
    const rootTag = rootCompositionTag(html);
    const w = htmlDataNumber(rootTag, 'width') || 1920;
    const h = htmlDataNumber(rootTag, 'height') || 1080;
    const dur = htmlDataNumber(rootTag, 'duration') || 0;
    const fps = renderFps || 30;
    const ramGB = machineRamGB();
    constrained = isConstrainedMachine(ramGB);
    const costUnits = estimateRenderCost(w, h, dur, fps);
    const decision = renderCostDecision({ constrained, costUnits, isFinal: quality === 'high' });
    if (decision === 'fail_fast') {
      fail('E_RENDER_TOO_HEAVY',
        `This ${w}x${h}, ${Math.round(dur)}s composition cannot be rendered at ${quality} quality on this machine without GPU acceleration (software rendering would crash or hang). Options: lower the resolution/fps/length, keep the draft, or render on a machine with a GPU.`,
        { render_profile: { constrained, machine_ram_gb: ramGB, cost_units: costUnits, decision } });
    }
    if (decision === 'degrade') renderFps = degradedFps(fps);
  } catch { /* canvas unknown → render as requested */ }

  const result = await renderComposition({
    projectDirAbs: compositionDirAbs,
    outputAbsPath: out.finalPath,
    ...(quality ? { quality } : {}),
    ...(typeof renderFps === 'number' ? { fps: renderFps } : {}),
    format,
    constrained,
    onProgress: makeProgressEmitter(opts.op),
    logPath: renderLogPath(compositionDirAbs, 'render'),
    ...(opts.variables && typeof opts.variables === 'object' && !Array.isArray(opts.variables) ? { variables: opts.variables } : {}),
  });
  if (result.ok === false) fail(result.errorCode, result.message, {
    ...(result.diagnostics ? { render_diagnostics: result.diagnostics } : {}),
    ...(result.logPath ? { render_log_path: result.logPath } : {}),
  });
  return {
    ok: true,
    op: opts.op,
    path: result.path,
    bytes: result.bytes,
    media: `chat-media://local/${result.path}`,
    renamed: out.renamed,
    requested_path: out.requested,
    vendor_assets: vendorAssets,
    ...(result.diagnostics ? { render_diagnostics: result.diagnostics } : {}),
    ...(result.logPath ? { render_log_path: result.logPath } : {}),
    text: `Video rendered to ${result.path}${result.diagnostics && result.diagnostics.gpuMode ? ` (${result.diagnostics.gpuMode} GPU mode)` : ''}.`,
  };
};
