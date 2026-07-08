import * as fs from 'node:fs/promises';
import * as fss from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import type { BrowserWindow as ElectronBrowserWindow } from 'electron';

import { bundledFfmpegPaths } from '../util/bundled-runtime';
import { createLogger } from '../logger';

const log = createLogger('video-studio');

export type VideoStudioOp =
  | 'composition.lint'
  | 'composition.inspect'
  | 'composition.render'
  | 'composition.draft'
  | 'composition.snapshot'
  | 'speech.transcribe';

export type RenderQuality = 'draft' | 'standard' | 'high';
export type RenderFormat = 'mp4' | 'webm';

export interface CompositionOptions {
  compositionDirAbs: string;
  outputAbsPath?: string;
  reportAbsPath?: string;
  findingsAbsPath?: string;
  snapshotAbsPath?: string;
  quality?: RenderQuality;
  fps?: number;
  format?: RenderFormat;
  variables?: Record<string, unknown>;
  signal?: AbortSignal;
  onProgress?: (event: { phase: string; message: string; data?: Record<string, unknown> }) => void;
}

export interface SpeechTranscribeOptions {
  inputAbsPath: string;
  transcriptAbsPath?: string;
  model?: string;
  language?: string;
  timestamps?: 'segment' | 'word';
  allowModelDownload?: boolean;
  signal?: AbortSignal;
  onProgress?: (event: { phase: string; message: string; data?: Record<string, unknown> }) => void;
}

export type VideoStudioResult =
  | { ok: true; op: VideoStudioOp; [key: string]: unknown }
  | { ok: false; op?: VideoStudioOp; errorCode: string; message: string; [key: string]: unknown };

type Issue = {
  code: string;
  severity: 'error' | 'warning' | 'info';
  selector?: string;
  message: string;
  fixHint?: string;
  source?: string;
};

type AudioTrack = {
  absPath: string;
  startSec: number;
  declaredDurationSec?: number;
  volume: number;
};

type CompositionMeta = {
  htmlPath: string;
  html: string;
  rootAttrs: Record<string, string>;
  id: string;
  width: number;
  height: number;
  durationSec: number;
  audioTracks: AudioTrack[];
};

type MediaProbe = {
  duration_seconds: number | null;
  size_bytes: number | null;
  video?: {
    codec: string;
    width?: number;
    height?: number;
    duration_seconds?: number;
    avg_frame_rate?: string;
  };
  audio?: {
    codec: string;
    duration_seconds?: number;
    bit_rate?: number;
  };
};

const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;
const DEFAULT_DURATION_SEC = 5;
const MAX_RENDER_DURATION_SEC = 20 * 60;
const MAX_FPS = 60;
const RENDER_TIMEOUT_MS = 20 * 60 * 1000;
const FFPROBE_TIMEOUT_MS = 30 * 1000;
const AUDIO_DURATION_TOLERANCE_SEC = 0.5;
const MEDIA_DURATION_TOLERANCE_SEC = 0.5;
const VIDEO_STUDIO_AGENT_ID = '79df9cc89f5f';
function round2(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
}

function isFinitePositive(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

function parseAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag)) !== null) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return attrs;
}

function htmlAttrNumber(attrs: Record<string, string>, key: string): number {
  const v = Number(attrs[key]);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function normalizeRef(ref: string): string {
  return String(ref || '').trim().replace(/&amp;/g, '&');
}

function isRemoteRef(ref: string): boolean {
  return /^(?:https?:)?\/\//i.test(ref);
}

function isIgnorableRef(ref: string): boolean {
  return !ref
    || ref.startsWith('#')
    || /^data:/i.test(ref)
    || /^blob:/i.test(ref)
    || /^javascript:/i.test(ref)
    || /^mailto:/i.test(ref);
}

function safeResolveLocalRef(compositionDirAbs: string, ref: string): string | null {
  const noHash = normalizeRef(ref).split('#')[0].split('?')[0];
  if (isIgnorableRef(noHash) || isRemoteRef(noHash) || path.isAbsolute(noHash)) return null;
  let decoded = noHash;
  try { decoded = decodeURIComponent(noHash); } catch { /* keep raw */ }
  const abs = path.resolve(compositionDirAbs, decoded);
  const rel = path.relative(compositionDirAbs, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return abs;
}

function normalizedLocalRefPath(ref: string): string {
  const noHash = normalizeRef(ref).split('#')[0].split('?')[0];
  let decoded = noHash;
  try { decoded = decodeURIComponent(noHash); } catch { /* keep raw */ }
  return decoded.replace(/\\/g, '/').replace(/^\.\/+/, '');
}

function isKnownBundledVendorRef(ref: string): boolean {
  return normalizedLocalRefPath(ref) === 'assets/vendor/gsap.min.js';
}

function isFileSync(absPath: string): boolean {
  try { return fss.statSync(absPath).isFile(); } catch { return false; }
}

function builtinGsapVendorCandidates(): string[] {
  const agentRel = path.join(
    'marketplace',
    'agents',
    VIDEO_STUDIO_AGENT_ID,
    'skills',
    'stage-compose',
    'scripts',
    'vendor',
    'gsap.min.js',
  );
  const sourceRel = path.join('resources', 'builtin', agentRel);
  const roots = [
    process.env.ORKAS_PC_DIR,
    process.cwd(),
    path.join(process.cwd(), 'PC'),
    path.resolve(__dirname, '..', '..', '..'),
    path.resolve(__dirname, '..', '..', '..', '..'),
    path.resolve(__dirname, '..', '..', '..', '..', 'PC'),
  ].filter((v): v is string => !!v);
  const resourceRoots = [
    process.env.ORKAS_BUILTIN_ROOT,
    (process as unknown as { resourcesPath?: string }).resourcesPath
      ? path.join((process as unknown as { resourcesPath: string }).resourcesPath, 'builtin')
      : undefined,
  ].filter((v): v is string => !!v);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const root of resourceRoots) {
    const candidate = path.resolve(root, agentRel);
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    out.push(candidate);
  }
  for (const root of roots) {
    const candidate = path.resolve(root, sourceRel);
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    out.push(candidate);
  }
  return out;
}

async function prepareKnownBundledVendor(ref: string, targetAbsPath: string): Promise<boolean> {
  if (!isKnownBundledVendorRef(ref)) return false;
  if (isFileSync(targetAbsPath)) return true;
  const source = builtinGsapVendorCandidates().find((candidate) => isFileSync(candidate));
  if (!source) return false;
  await fs.mkdir(path.dirname(targetAbsPath), { recursive: true });
  await fs.copyFile(source, targetAbsPath);
  return true;
}

function extractResourceRefs(html: string): Array<{ attr: string; ref: string }> {
  const refs: Array<{ attr: string; ref: string }> = [];
  const re = /\b(src|href|poster)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    refs.push({ attr: m[1].toLowerCase(), ref: normalizeRef(m[2] ?? m[3] ?? '') });
  }
  return refs;
}

function findingsJson(issues: Issue[], extra: Record<string, unknown> = {}): string {
  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const warningCount = issues.filter((i) => i.severity === 'warning').length;
  return JSON.stringify({
    ok: errorCount === 0,
    errorCount,
    warningCount,
    issueCount: issues.length,
    totalIssueCount: issues.length,
    issues,
    ...extra,
  }, null, 2);
}

function qualityFps(quality: RenderQuality | undefined, fps: number | undefined): number {
  if (isFinitePositive(fps)) return Math.max(1, Math.min(MAX_FPS, Math.floor(fps)));
  if (quality === 'draft') return 15;
  return 30;
}

function crfForQuality(quality: RenderQuality | undefined): number {
  if (quality === 'high') return 16;
  if (quality === 'standard') return 20;
  return 26;
}

function positiveNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function nullablePositiveNumber(value: unknown): number | null {
  return positiveNumber(value) ?? null;
}

async function probeMedia(ffprobe: string, mediaAbsPath: string, signal?: AbortSignal): Promise<MediaProbe | null> {
  const r = await runProcess(ffprobe, [
    '-v', 'error',
    '-show_entries', 'format=duration,size:stream=codec_type,codec_name,width,height,duration,bit_rate,avg_frame_rate',
    '-of', 'json',
    mediaAbsPath,
  ], { signal, timeoutMs: FFPROBE_TIMEOUT_MS });
  if (r.aborted || r.timedOut || r.code !== 0) return null;

  let parsed: {
    format?: { duration?: string; size?: string };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      duration?: string;
      bit_rate?: string;
      avg_frame_rate?: string;
    }>;
  };
  try {
    parsed = JSON.parse(r.stdout) as typeof parsed;
  } catch {
    return null;
  }
  const video = parsed.streams?.find((stream) => stream.codec_type === 'video');
  const audio = parsed.streams?.find((stream) => stream.codec_type === 'audio');
  return {
    duration_seconds: nullablePositiveNumber(parsed.format?.duration),
    size_bytes: nullablePositiveNumber(parsed.format?.size),
    ...(video ? {
      video: {
        codec: video.codec_name || '',
        width: positiveNumber(video.width),
        height: positiveNumber(video.height),
        duration_seconds: positiveNumber(video.duration),
        avg_frame_rate: video.avg_frame_rate,
      },
    } : {}),
    ...(audio ? {
      audio: {
        codec: audio.codec_name || '',
        duration_seconds: positiveNumber(audio.duration),
        bit_rate: positiveNumber(audio.bit_rate),
      },
    } : {}),
  };
}

async function loadCompositionMeta(compositionDirAbs: string): Promise<{ meta: CompositionMeta | null; issues: Issue[] }> {
  const issues: Issue[] = [];
  const htmlPath = path.join(compositionDirAbs, 'index.html');
  const st = await fs.stat(htmlPath).catch(() => null);
  if (!st || !st.isFile()) {
    return {
      meta: null,
      issues: [{
        code: 'NO_COMPOSITION',
        severity: 'error',
        selector: 'index.html',
        message: `No index.html found in composition dir: ${compositionDirAbs}`,
      }],
    };
  }

  const html = await fs.readFile(htmlPath, 'utf8');
  const rootTag = html.match(/<[^>]+\bdata-composition-id\s*=\s*["'][^"']+["'][^>]*>/i)?.[0] ?? '';
  const rootAttrs = rootTag ? parseAttrs(rootTag) : {};
  const width = htmlAttrNumber(rootAttrs, 'data-width') || DEFAULT_WIDTH;
  const height = htmlAttrNumber(rootAttrs, 'data-height') || DEFAULT_HEIGHT;
  const durationSec = htmlAttrNumber(rootAttrs, 'data-duration') || DEFAULT_DURATION_SEC;
  const id = rootAttrs['data-composition-id'] || 'main';

  if (!rootTag) {
    issues.push({
      code: 'ROOT_COMPOSITION_MISSING',
      severity: 'error',
      selector: '[data-composition-id]',
      message: 'index.html must declare a root element with data-composition-id, data-width, data-height, and data-duration.',
    });
  }
  for (const key of ['data-width', 'data-height', 'data-duration']) {
    if (!htmlAttrNumber(rootAttrs, key)) {
      issues.push({
        code: 'ROOT_TIMING_ATTR_MISSING',
        severity: 'error',
        selector: '[data-composition-id]',
        message: `root composition is missing a positive numeric ${key}.`,
      });
    }
  }
  if (durationSec > MAX_RENDER_DURATION_SEC) {
    issues.push({
      code: 'DURATION_TOO_LONG',
      severity: 'error',
      selector: '[data-composition-id]',
      message: `composition duration ${durationSec}s exceeds the ${MAX_RENDER_DURATION_SEC}s render limit.`,
    });
  }

  const refs = extractResourceRefs(html);
  const audioTracks: AudioTrack[] = [];
  for (const item of refs) {
    if (isIgnorableRef(item.ref)) continue;
    if (isRemoteRef(item.ref)) {
      issues.push({
        code: 'REMOTE_RESOURCE_BLOCKED',
        severity: 'error',
        selector: `[${item.attr}="${item.ref}"]`,
        message: `Remote runtime resource is not allowed during video render: ${item.ref}`,
        fixHint: 'Copy runtime assets into the composition directory and reference them relatively.',
      });
      continue;
    }
    if (path.isAbsolute(item.ref)) {
      issues.push({
        code: 'ABSOLUTE_RESOURCE_BLOCKED',
        severity: 'error',
        selector: `[${item.attr}="${item.ref}"]`,
        message: `Absolute runtime resource is not allowed during video render: ${item.ref}`,
      });
      continue;
    }
    const abs = safeResolveLocalRef(compositionDirAbs, item.ref);
    if (!abs) {
      issues.push({
        code: 'RESOURCE_OUT_OF_SCOPE',
        severity: 'error',
        selector: `[${item.attr}="${item.ref}"]`,
        message: `Resource reference escapes the composition directory: ${item.ref}`,
      });
      continue;
    }
    let exists = await fs.stat(abs).catch(() => null);
    if ((!exists || !exists.isFile()) && isKnownBundledVendorRef(item.ref)) {
      const prepared = await prepareKnownBundledVendor(item.ref, abs);
      if (prepared) exists = await fs.stat(abs).catch(() => null);
      else {
        issues.push({
          code: 'LOCAL_VENDOR_MISSING',
          severity: 'error',
          selector: `[${item.attr}="${item.ref}"]`,
          message: `Built-in vendor resource could not be prepared: ${item.ref}`,
          fixHint: 'Use the built-in stage-compose vendor path assets/vendor/gsap.min.js or remove the runtime dependency.',
        });
        continue;
      }
    }
    if (!exists || !exists.isFile()) {
      issues.push({
        code: 'LOCAL_RESOURCE_MISSING',
        severity: 'error',
        selector: `[${item.attr}="${item.ref}"]`,
        message: `Local resource does not exist: ${item.ref}`,
      });
    }
  }

  const audioRe = /<audio\b[^>]*>/gi;
  let audioMatch: RegExpExecArray | null;
  while ((audioMatch = audioRe.exec(html)) !== null) {
    const attrs = parseAttrs(audioMatch[0]);
    const src = attrs.src;
    if (!src || isIgnorableRef(src) || isRemoteRef(src) || path.isAbsolute(src)) continue;
    const abs = safeResolveLocalRef(compositionDirAbs, src);
    if (abs) {
      audioTracks.push({
        absPath: abs,
        startSec: Number(attrs['data-start']) || 0,
        declaredDurationSec: htmlAttrNumber(attrs, 'data-duration') || undefined,
        volume: Number.isFinite(Number(attrs['data-volume'])) && Number(attrs['data-volume']) >= 0
          ? Number(attrs['data-volume'])
          : 1,
      });
    }
  }

  return {
    meta: { htmlPath, html, rootAttrs, id, width, height, durationSec, audioTracks },
    issues,
  };
}

export async function lintComposition(p: CompositionOptions): Promise<VideoStudioResult> {
  const { meta, issues } = await loadCompositionMeta(p.compositionDirAbs);
  const findings = findingsJson(issues, {
    engine: 'orkas-native',
    profile: 'orkas-html-composition',
    canvas: meta ? { width: meta.width, height: meta.height, durationSec: meta.durationSec } : null,
  });
  return { ok: true, op: 'composition.lint', findings };
}

function fileUrl(absPath: string): string {
  let resolved = path.resolve(absPath).replace(/\\/g, '/');
  if (!resolved.startsWith('/')) resolved = `/${resolved}`;
  return encodeURI(`file://${resolved}`);
}

async function withCompositionWindow<T>(
  meta: CompositionMeta,
  p: CompositionOptions,
  fn: (win: ElectronBrowserWindow) => Promise<T>,
): Promise<T> {
  const electron = await import('electron');
  const { BrowserWindow, session } = electron;
  if (!BrowserWindow) throw new Error('Electron BrowserWindow unavailable');
  const partition = `video-studio-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const ses = session.fromPartition(partition);
  ses.webRequest.onBeforeRequest((details, callback) => {
    const url = String(details.url || '');
    if (/^https?:\/\//i.test(url)) {
      callback({ cancel: true });
      return;
    }
    callback({});
  });

  const win = new BrowserWindow({
    show: false,
    width: meta.width,
    height: meta.height,
    useContentSize: true,
    backgroundColor: '#000000',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      session: ses,
    },
  });
  try {
    const loaded = new Promise<void>((resolve, reject) => {
      win.webContents.once('did-finish-load', () => resolve());
      win.webContents.once('did-fail-load', (_e, _code, desc) => reject(new Error(`did-fail-load: ${desc}`)));
    });
    await win.loadURL(fileUrl(meta.htmlPath));
    await loaded;
    await win.webContents.executeJavaScript(buildTimelineAdapterScript(meta, p.variables), true);
    await waitForReady(win);
    return await fn(win);
  } finally {
    try { win.destroy(); } catch { /* best effort */ }
  }
}

function buildTimelineAdapterScript(meta: CompositionMeta, variables?: Record<string, unknown>): string {
  const vars = JSON.stringify(variables || {});
  return `
(() => {
  const root = document.querySelector('[data-composition-id]') || document.body;
  const compositionId = root && root.getAttribute ? (root.getAttribute('data-composition-id') || ${JSON.stringify(meta.id)}) : ${JSON.stringify(meta.id)};
  const variables = ${vars};
  window.__ORKAS_VIDEO_VARIABLES__ = variables;
  function num(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
  function pauseMedia() {
    for (const media of Array.from(document.querySelectorAll('audio,video'))) {
      try { media.pause(); } catch {}
    }
  }
  async function seekMedia(t) {
    const mediaEls = Array.from(document.querySelectorAll('audio,video'));
    await Promise.all(mediaEls.map((media) => new Promise((resolve) => {
      const start = num(media.getAttribute('data-start'), 0);
      const local = Math.max(0, t - start);
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      try {
        media.pause();
        if (Number.isFinite(media.duration) && Math.abs(media.currentTime - local) > 0.04) {
          media.addEventListener('seeked', finish, { once: true });
          media.currentTime = Math.min(local, Math.max(0, media.duration || local));
          setTimeout(finish, 1000);
        } else {
          finish();
        }
      } catch {
        finish();
      }
    })));
  }
  function seekTimelines(t) {
    const timelines = window.__timelines || {};
    const tl = timelines[compositionId] || timelines.main || timelines.root;
    if (!tl) return false;
    try {
      if (typeof tl.pause === 'function') tl.pause();
      if (typeof tl.seek === 'function') { tl.seek(t, false); return true; }
      if (typeof tl.time === 'function') { tl.time(t, false); return true; }
      if (typeof tl.progress === 'function' && typeof tl.duration === 'function') {
        const dur = Number(tl.duration()) || ${meta.durationSec};
        tl.progress(dur > 0 ? Math.max(0, Math.min(1, t / dur)) : 0, false);
        return true;
      }
    } catch {}
    return false;
  }
  function seekWebAnimations(t) {
    try {
      for (const anim of document.getAnimations({ subtree: true })) {
        try {
          anim.pause();
          anim.currentTime = Math.max(0, t * 1000);
        } catch {}
      }
    } catch {}
  }
  function applyTimedVisibility(t) {
    for (const el of Array.from(document.querySelectorAll('[data-start], [data-duration]'))) {
      if (el === root) continue;
      const start = num(el.getAttribute('data-start'), 0);
      const dur = num(el.getAttribute('data-duration'), Number.POSITIVE_INFINITY);
      if (!Number.isFinite(dur)) continue;
      const visible = t >= start && t <= start + dur;
      if (el.classList && el.classList.contains('clip')) {
        el.style.visibility = visible ? '' : 'hidden';
      }
    }
  }
  window.__ORKAS_VIDEO__ = window.__ORKAS_VIDEO__ || {};
  window.__ORKAS_VIDEO__.duration = ${meta.durationSec};
  window.__ORKAS_VIDEO__.seek = async (t) => {
    pauseMedia();
    const usedTimeline = seekTimelines(t);
    seekWebAnimations(t);
    if (!usedTimeline) applyTimedVisibility(t);
    await seekMedia(t);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  };
  pauseMedia();
})()
`;
}

async function waitForReady(win: ElectronBrowserWindow): Promise<void> {
  await win.webContents.executeJavaScript(`
(async () => {
  try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch {}
  const imgs = Array.from(document.images || []);
  await Promise.all(imgs.map((img) => {
    if (img.complete) return Promise.resolve();
    if (typeof img.decode === 'function') return img.decode().catch(() => {});
    return new Promise((resolve) => {
      img.addEventListener('load', resolve, { once: true });
      img.addEventListener('error', resolve, { once: true });
    });
  }));
  const media = Array.from(document.querySelectorAll('audio,video'));
  await Promise.all(media.map((m) => {
    if (m.readyState >= 1) return Promise.resolve();
    return new Promise((resolve) => {
      m.addEventListener('loadedmetadata', resolve, { once: true });
      m.addEventListener('error', resolve, { once: true });
      setTimeout(resolve, 2000);
    });
  }));
})()
`, true);
}

async function seek(win: ElectronBrowserWindow, tSec: number): Promise<void> {
  await win.webContents.executeJavaScript(`
(async () => {
  if (window.__ORKAS_VIDEO__ && typeof window.__ORKAS_VIDEO__.seek === 'function') {
    await window.__ORKAS_VIDEO__.seek(${JSON.stringify(tSec)});
  }
})()
`, true);
}

function sampleTimes(durationSec: number): number[] {
  const dur = Math.max(0.1, durationSec);
  return [...new Set([0, dur * 0.25, dur * 0.5, dur * 0.75, Math.max(0, dur - 0.05)].map((n) => round2(n)))];
}

export async function inspectComposition(p: CompositionOptions): Promise<VideoStudioResult> {
  const loaded = await loadCompositionMeta(p.compositionDirAbs);
  if (!loaded.meta) {
    return { ok: true, op: 'composition.inspect', findings: findingsJson(loaded.issues) };
  }
  const issues: Issue[] = [...loaded.issues];
  const samples = sampleTimes(loaded.meta.durationSec);
  try {
    await withCompositionWindow(loaded.meta, p, async (win) => {
      for (const t of samples) {
        await seek(win, t);
        const sampleIssues = await win.webContents.executeJavaScript(buildInspectScript(loaded.meta, t), true) as Issue[];
        issues.push(...sampleIssues);
      }
    });
  } catch (err) {
    issues.push({
      code: 'INSPECT_RENDERER_FAILED',
      severity: 'error',
      selector: 'document',
      message: (err as Error).message,
      source: 'orkas-native',
    });
  }
  return {
    ok: true,
    op: 'composition.inspect',
    findings: findingsJson(issues, {
      engine: 'orkas-native',
      samples,
      canvas: { width: loaded.meta.width, height: loaded.meta.height, durationSec: loaded.meta.durationSec },
    }),
  };
}

function buildInspectScript(meta: CompositionMeta, tSec: number): string {
  return `
(() => {
  const issues = [];
  const width = ${meta.width};
  const height = ${meta.height};
  const tSec = ${tSec};
  const selectorFor = (el) => {
    if (!el || !el.tagName) return 'document';
    if (el.id) return '#' + el.id;
    const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
    return el.tagName.toLowerCase() + cls;
  };
  const add = (code, severity, el, message) => issues.push({
    code, severity, selector: selectorFor(el), message: '[' + tSec.toFixed(2) + 's] ' + message, source: 'orkas-native-inspect'
  });
  const visible = (el, style) => style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) > 0.01;
  for (const el of Array.from(document.body.querySelectorAll('*'))) {
    const style = getComputedStyle(el);
    if (!visible(el, style)) continue;
    const rect = el.getBoundingClientRect();
    if (!rect || rect.width <= 1 || rect.height <= 1) continue;
    if (rect.left < -1 || rect.top < -1 || rect.right > width + 1 || rect.bottom > height + 1) {
      add('ELEMENT_OUT_OF_CANVAS', 'warning', el, 'element extends outside the declared video canvas.');
    }
    const text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
    if (text) {
      if (el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 2) {
        add('TEXT_OVERFLOW', 'warning', el, 'text content overflows its box.');
      }
      const fs = parseFloat(style.fontSize || '0');
      if (Number.isFinite(fs) && fs > 0 && fs < 18) {
        add('FONT_TOO_SMALL', 'warning', el, 'text is below the 18px legibility floor.');
      }
    }
  }
  return issues;
})()
`;
}

export async function snapshotComposition(p: CompositionOptions): Promise<VideoStudioResult> {
  const loaded = await loadCompositionMeta(p.compositionDirAbs);
  if (!loaded.meta) {
    return { ok: false, op: 'composition.snapshot', errorCode: 'E_COMPOSITION_INVALID', message: loaded.issues[0]?.message || 'composition invalid' };
  }
  if (!p.snapshotAbsPath) {
    return { ok: false, op: 'composition.snapshot', errorCode: 'E_OUTPUT_REQUIRED', message: 'snapshot output path is required.' };
  }
  await fs.mkdir(path.dirname(p.snapshotAbsPath), { recursive: true });
  await withCompositionWindow(loaded.meta, p, async (win) => {
    await seek(win, 0);
    const image = await win.webContents.capturePage({ x: 0, y: 0, width: loaded.meta!.width, height: loaded.meta!.height });
    await fs.writeFile(p.snapshotAbsPath!, image.toPNG());
  });
  const st = await fs.stat(p.snapshotAbsPath);
  return { ok: true, op: 'composition.snapshot', path: p.snapshotAbsPath, bytes: st.size };
}

export async function renderComposition(p: CompositionOptions): Promise<VideoStudioResult> {
  const loaded = await loadCompositionMeta(p.compositionDirAbs);
  if (!loaded.meta) {
    return { ok: false, op: 'composition.render', errorCode: 'E_COMPOSITION_INVALID', message: loaded.issues[0]?.message || 'composition invalid' };
  }
  const blocking = loaded.issues.filter((i) => i.severity === 'error');
  if (blocking.length) {
    return { ok: false, op: 'composition.render', errorCode: 'E_LINT_BLOCKED', message: blocking[0].message, findings: findingsJson(loaded.issues) };
  }
  if (!p.outputAbsPath) {
    return { ok: false, op: 'composition.render', errorCode: 'E_OUTPUT_REQUIRED', message: 'output path is required.' };
  }
  const bins = bundledFfmpegPaths();
  if (!bins.ffmpeg) {
    return { ok: false, op: 'composition.render', errorCode: 'E_FFMPEG_MISSING', message: 'Bundled ffmpeg not found.' };
  }

  const fps = qualityFps(p.quality, p.fps);
  const totalFrames = Math.max(1, Math.ceil(loaded.meta.durationSec * fps));
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'orkas-video-studio-'));
  const framePattern = path.join(tmp, 'frame-%06d.png');
  try {
    p.onProgress?.({ phase: 'composition.render', message: `Capturing ${totalFrames} frames with the native renderer.`, data: { totalFrames, fps } });
    await withCompositionWindow(loaded.meta, p, async (win) => {
      for (let frame = 0; frame < totalFrames; frame += 1) {
        if (p.signal?.aborted) throw new Error('render aborted');
        const t = frame / fps;
        await seek(win, Math.min(t, Math.max(0, loaded.meta!.durationSec - 0.001)));
        const image = await win.webContents.capturePage({ x: 0, y: 0, width: loaded.meta!.width, height: loaded.meta!.height });
        await fs.writeFile(path.join(tmp, `frame-${String(frame + 1).padStart(6, '0')}.png`), image.toPNG());
        if (frame % Math.max(1, Math.floor(fps * 2)) === 0) {
          p.onProgress?.({ phase: 'composition.render.capture', message: `Captured frame ${frame + 1}/${totalFrames}.`, data: { frame: frame + 1, totalFrames } });
        }
      }
    });
    await fs.mkdir(path.dirname(p.outputAbsPath), { recursive: true });
    const encoded = await encodeFrames({
      ffmpeg: bins.ffmpeg,
      framePattern,
      outputAbsPath: p.outputAbsPath,
      fps,
      format: p.format ?? 'mp4',
      quality: p.quality,
      audioTracks: loaded.meta.audioTracks,
      durationSec: loaded.meta.durationSec,
      signal: p.signal,
    });
    if (encoded.ok === false) return encoded;
    const st = await fs.stat(p.outputAbsPath);
    const probe = bins.ffprobe ? await probeMedia(bins.ffprobe, p.outputAbsPath, p.signal) : null;
    return {
      ok: true,
      op: 'composition.render',
      path: p.outputAbsPath,
      bytes: st.size,
      media: `chat-media://local/${p.outputAbsPath}`,
      probe,
      engine: 'orkas-native',
      fps,
      frames: totalFrames,
      canvas: { width: loaded.meta.width, height: loaded.meta.height, durationSec: loaded.meta.durationSec },
    };
  } catch (err) {
    return { ok: false, op: 'composition.render', errorCode: p.signal?.aborted ? 'E_RENDER_ABORTED' : 'E_RENDER_FAILED', message: (err as Error).message };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

async function encodeFrames(opts: {
  ffmpeg: string;
  framePattern: string;
  outputAbsPath: string;
  fps: number;
  format: RenderFormat;
  quality?: RenderQuality;
  audioTracks: AudioTrack[];
  durationSec: number;
  signal?: AbortSignal;
}): Promise<VideoStudioResult> {
  const args = ['-y', '-framerate', String(opts.fps), '-i', opts.framePattern];
  const audioTracks = opts.audioTracks.filter((track) => fss.existsSync(track.absPath));
  for (const track of audioTracks) args.push('-i', track.absPath);
  if (audioTracks.length) {
    const duration = opts.durationSec.toFixed(3);
    const filters: string[] = [];
    audioTracks.forEach((track, index) => {
      const inputIndex = index + 1;
      const delayMs = Math.max(0, Math.round((track.startSec || 0) * 1000));
      const volume = Number.isFinite(track.volume) && track.volume >= 0 ? track.volume : 1;
      const delay = delayMs > 0 ? `adelay=${delayMs}|${delayMs},` : '';
      filters.push(`[${inputIndex}:a]volume=${volume},${delay}apad,atrim=0:${duration}[a${index}]`);
    });
    if (audioTracks.length === 1) {
      filters.push('[a0]anull[aout]');
    } else {
      filters.push(`${audioTracks.map((_track, index) => `[a${index}]`).join('')}amix=inputs=${audioTracks.length}:duration=longest:normalize=0,atrim=0:${duration}[aout]`);
    }
    args.push('-filter_complex', filters.join(';'), '-map', '0:v:0', '-map', '[aout]');
  }
  if (opts.format === 'webm') {
    args.push('-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-b:v', '0', '-crf', String(crfForQuality(opts.quality) + 8));
    if (audioTracks.length) args.push('-c:a', 'libopus');
  } else {
    args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', String(crfForQuality(opts.quality)), '-movflags', '+faststart');
    if (audioTracks.length) args.push('-c:a', 'aac');
  }
  args.push('-t', opts.durationSec.toFixed(3), opts.outputAbsPath);
  const r = await runProcess(opts.ffmpeg, args, { signal: opts.signal, timeoutMs: RENDER_TIMEOUT_MS });
  if (r.aborted) return { ok: false, op: 'composition.render', errorCode: 'E_RENDER_ABORTED', message: 'render aborted.' };
  if (r.timedOut) return { ok: false, op: 'composition.render', errorCode: 'E_RENDER_TIMEOUT', message: 'ffmpeg encode timed out.' };
  if (r.code !== 0) {
    log.warn('ffmpeg encode failed', { code: r.code, stderr: r.stderr.slice(-500) });
    return { ok: false, op: 'composition.render', errorCode: 'E_RENDER_ENCODE_FAILED', message: `ffmpeg exited ${r.code}. ${r.stderr.slice(-1200)}` };
  }
  return { ok: true, op: 'composition.render' };
}

async function runProcess(
  bin: string,
  args: string[],
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; aborted: boolean }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { ...(opts.signal ? { signal: opts.signal } : {}) });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: (err as Error).message, timedOut: false, aborted: false });
      return;
    }
    const out: string[] = [];
    const err: string[] = [];
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, opts.timeoutMs)
      : null;
    child.stdout?.on('data', (c: Buffer) => out.push(c.toString('utf8')));
    child.stderr?.on('data', (c: Buffer) => err.push(c.toString('utf8')));
    child.stdin?.end();
    child.on('error', (e: Error) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout: out.join(''), stderr: e.message, timedOut, aborted: !!opts.signal?.aborted });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout: out.join(''), stderr: err.join(''), timedOut, aborted: !!opts.signal?.aborted });
    });
  });
}

async function buildMediaQa(
  meta: CompositionMeta,
  mediaProbe: MediaProbe | null,
  ffprobe: string | undefined,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const issues: Issue[] = [];
  const sourceAudioTracks: Array<{
    path: string;
    start_seconds: number;
    volume: number;
    declared_duration_seconds?: number;
    source_duration_seconds?: number;
    expected_duration_seconds?: number;
    expected_end_seconds?: number;
  }> = [];

  if (!mediaProbe) {
    issues.push({
      code: 'MEDIA_PROBE_MISSING',
      severity: meta.audioTracks.length ? 'error' : 'warning',
      message: 'Final media could not be probed with ffprobe.',
      source: 'orkas-native-media-qa',
    });
  } else {
    if (!mediaProbe.video) {
      issues.push({
        code: 'VIDEO_STREAM_MISSING',
        severity: 'error',
        message: 'Final media does not contain a video stream.',
        source: 'orkas-native-media-qa',
      });
    }
    if (mediaProbe.duration_seconds !== null && Math.abs(mediaProbe.duration_seconds - meta.durationSec) > MEDIA_DURATION_TOLERANCE_SEC) {
      issues.push({
        code: 'MEDIA_DURATION_MISMATCH',
        severity: 'error',
        message: `Final media duration ${round2(mediaProbe.duration_seconds)}s does not match composition duration ${round2(meta.durationSec)}s.`,
        source: 'orkas-native-media-qa',
      });
    }
    const videoDuration = mediaProbe.video?.duration_seconds;
    if (videoDuration !== undefined && Math.abs(videoDuration - meta.durationSec) > MEDIA_DURATION_TOLERANCE_SEC) {
      issues.push({
        code: 'VIDEO_DURATION_MISMATCH',
        severity: 'error',
        message: `Final video stream duration ${round2(videoDuration)}s does not match composition duration ${round2(meta.durationSec)}s.`,
        source: 'orkas-native-media-qa',
      });
    }
  }

  let expectedAudioEndSec = 0;
  for (const track of meta.audioTracks) {
    const sourceProbe = ffprobe ? await probeMedia(ffprobe, track.absPath, signal) : null;
    const sourceDurationSec = sourceProbe?.duration_seconds ?? sourceProbe?.audio?.duration_seconds;
    const expectedCandidates = [
      track.declaredDurationSec,
      sourceDurationSec,
    ].filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
    const expectedDurationSec = expectedCandidates.length ? Math.min(...expectedCandidates) : undefined;
    const expectedEndSec = expectedDurationSec !== undefined
      ? Math.min(meta.durationSec, track.startSec + expectedDurationSec)
      : undefined;
    if (expectedEndSec !== undefined) expectedAudioEndSec = Math.max(expectedAudioEndSec, expectedEndSec);
    sourceAudioTracks.push({
      path: track.absPath,
      start_seconds: round2(track.startSec),
      volume: round2(track.volume),
      ...(track.declaredDurationSec !== undefined ? { declared_duration_seconds: round2(track.declaredDurationSec) } : {}),
      ...(sourceDurationSec !== undefined ? { source_duration_seconds: round2(sourceDurationSec) } : {}),
      ...(expectedDurationSec !== undefined ? { expected_duration_seconds: round2(expectedDurationSec) } : {}),
      ...(expectedEndSec !== undefined ? { expected_end_seconds: round2(expectedEndSec) } : {}),
    });
  }

  if (meta.audioTracks.length > 0) {
    if (!mediaProbe?.audio) {
      issues.push({
        code: 'AUDIO_STREAM_MISSING',
        severity: 'error',
        message: 'Composition declares audio tracks, but final media has no audio stream.',
        source: 'orkas-native-media-qa',
      });
    } else {
      const actualAudioDurationSec = mediaProbe.audio.duration_seconds ?? mediaProbe.duration_seconds;
      if (expectedAudioEndSec > 0 && actualAudioDurationSec !== null && actualAudioDurationSec !== undefined
        && actualAudioDurationSec + AUDIO_DURATION_TOLERANCE_SEC < expectedAudioEndSec) {
        issues.push({
          code: 'AUDIO_STREAM_TOO_SHORT',
          severity: 'error',
          message: `Final audio stream duration ${round2(actualAudioDurationSec)}s is shorter than expected narration coverage ${round2(expectedAudioEndSec)}s.`,
          source: 'orkas-native-media-qa',
        });
      }
    }
  }

  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  return {
    ok: errorCount === 0,
    issue_count: issues.length,
    error_count: errorCount,
    warning_count: issues.filter((issue) => issue.severity === 'warning').length,
    media_duration_seconds: mediaProbe?.duration_seconds !== null && mediaProbe?.duration_seconds !== undefined
      ? round2(mediaProbe.duration_seconds)
      : null,
    video_duration_seconds: mediaProbe?.video?.duration_seconds !== undefined ? round2(mediaProbe.video.duration_seconds) : null,
    audio_duration_seconds: mediaProbe?.audio?.duration_seconds !== undefined
      ? round2(mediaProbe.audio.duration_seconds)
      : (mediaProbe?.audio && mediaProbe.duration_seconds !== null ? round2(mediaProbe.duration_seconds) : null),
    expected_audio_end_seconds: expectedAudioEndSec > 0 ? round2(expectedAudioEndSec) : null,
    source_audio_tracks: sourceAudioTracks,
    issues,
  };
}

export async function draftComposition(p: CompositionOptions): Promise<VideoStudioResult> {
  const report: Record<string, unknown> = {
    ok: false,
    op: 'composition.draft',
    engine: 'orkas-native',
    composition_dir: p.compositionDirAbs,
    path: p.outputAbsPath || '',
    steps: {},
  };
  const steps = report.steps as Record<string, unknown>;
  const lint = await lintComposition(p);
  steps.lint = lint;
  if (lint.ok === false) return lint;
  const parsedLint = parseFindings(String(lint.findings || ''));
  if ((parsedLint.errorCount || 0) > 0) {
    report.error = { code: 'E_LINT_BLOCKED', message: 'composition lint failed.' };
    await writeReportIfRequested(p.reportAbsPath, report);
    return { ok: false, op: 'composition.draft', errorCode: 'E_LINT_BLOCKED', message: 'composition lint failed.', report };
  }

  const inspect = await inspectComposition(p);
  steps.inspect = inspect;
  if (inspect.ok === false) return inspect;
  if (p.findingsAbsPath && inspect.ok) {
    await fs.mkdir(path.dirname(p.findingsAbsPath), { recursive: true });
    await fs.writeFile(p.findingsAbsPath, String(inspect.findings || ''), 'utf8');
  }

  const render = await renderComposition(p);
  steps.render = render;
  if (render.ok === false) {
    report.error = { code: render.errorCode, message: render.message };
    await writeReportIfRequested(p.reportAbsPath, report);
    return { ...render, report };
  }

  const loaded = await loadCompositionMeta(p.compositionDirAbs);
  const mediaProbe = ((render as { probe?: MediaProbe | null }).probe ?? null);
  steps.media_probe = mediaProbe;
  if (loaded.meta) {
    const mediaQa = await buildMediaQa(loaded.meta, mediaProbe, bundledFfmpegPaths().ffprobe, p.signal);
    steps.media_qa = mediaQa;
    if (mediaQa.ok === false) {
      report.error = { code: 'E_MEDIA_QA_BLOCKED', message: 'draft media QA failed.' };
      await writeReportIfRequested(p.reportAbsPath, report);
      return { ok: false, op: 'composition.draft', errorCode: 'E_MEDIA_QA_BLOCKED', message: 'draft media QA failed.', report };
    }
  }

  report.ok = true;
  report.media = { path: render.path, bytes: render.bytes };
  report.next_action = 'open_gate_d';
  report.advisory_policy = 'visual inspect warnings are advisory after ok:true; open Gate D instead of self-repairing.';
  await writeReportIfRequested(p.reportAbsPath, report);
  return {
    ok: true,
    op: 'composition.draft',
    path: render.path,
    bytes: render.bytes,
    report_path: p.reportAbsPath || '',
    findings_path: p.findingsAbsPath || '',
    media: `chat-media://local/${render.path}`,
    probe: mediaProbe,
    next_action: 'open_gate_d',
    report,
  };
}

function parseFindings(findings: string): { errorCount?: number } {
  try {
    const parsed = JSON.parse(findings);
    return { errorCount: typeof parsed.errorCount === 'number' ? parsed.errorCount : undefined };
  } catch {
    return {};
  }
}

async function writeReportIfRequested(reportAbsPath: string | undefined, report: Record<string, unknown>): Promise<void> {
  if (!reportAbsPath) return;
  await fs.mkdir(path.dirname(reportAbsPath), { recursive: true });
  await fs.writeFile(reportAbsPath, JSON.stringify(report, null, 2), 'utf8');
  report.report_path = reportAbsPath;
}

function resolveWhisperBackend(): { cli: string; model: string } | null {
  const cli = process.env.ORKAS_WHISPER_CPP || process.env.ORKAS_WHISPER_CLI || '';
  const model = process.env.ORKAS_WHISPER_MODEL || '';
  if (!cli || !model) return null;
  try {
    if (!fss.statSync(cli).isFile() || !fss.statSync(model).isFile()) return null;
  } catch {
    return null;
  }
  return { cli, model };
}

export async function transcribeSpeech(p: SpeechTranscribeOptions): Promise<VideoStudioResult> {
  const backend = resolveWhisperBackend();
  if (!backend) {
    return {
      ok: false,
      op: 'speech.transcribe',
      errorCode: 'E_VIDEO_STUDIO_UNAVAILABLE',
      message: 'Orkas-native speech transcription backend is not installed/configured.',
    };
  }
  const bins = bundledFfmpegPaths();
  if (!bins.ffmpeg) {
    return { ok: false, op: 'speech.transcribe', errorCode: 'E_FFMPEG_MISSING', message: 'Bundled ffmpeg not found.' };
  }
  const st = await fs.stat(p.inputAbsPath).catch(() => null);
  if (!st || !st.isFile()) {
    return { ok: false, op: 'speech.transcribe', errorCode: 'E_TRANSCRIBE_NO_INPUT', message: `input is not a file: ${p.inputAbsPath}` };
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'orkas-transcribe-'));
  const wav = path.join(tmp, 'audio.wav');
  const outBase = path.join(tmp, 'transcript');
  try {
    p.onProgress?.({ phase: 'speech.transcribe.extract', message: 'Extracting mono 16 kHz audio for transcription.' });
    const ex = await runProcess(bins.ffmpeg, ['-y', '-i', p.inputAbsPath, '-vn', '-ac', '1', '-ar', '16000', wav], { signal: p.signal, timeoutMs: 20 * 60 * 1000 });
    if (ex.code !== 0) {
      return { ok: false, op: 'speech.transcribe', errorCode: 'E_TRANSCRIBE_AUDIO_EXTRACT_FAILED', message: ex.stderr.slice(-1200) };
    }
    p.onProgress?.({ phase: 'speech.transcribe.asr', message: 'Running Orkas-native whisper.cpp transcription.' });
    const args = ['-m', backend.model, '-f', wav, '-oj', '-of', outBase];
    if (p.language && p.language !== 'auto') args.push('-l', p.language);
    const tr = await runProcess(backend.cli, args, { signal: p.signal, timeoutMs: 45 * 60 * 1000 });
    if (tr.code !== 0) {
      return { ok: false, op: 'speech.transcribe', errorCode: 'E_TRANSCRIBE_FAILED', message: tr.stderr.slice(-1200) || tr.stdout.slice(-1200) };
    }
    const jsonPath = `${outBase}.json`;
    const raw = await fs.readFile(jsonPath, 'utf8').catch(() => '');
    if (!raw.trim()) {
      return { ok: false, op: 'speech.transcribe', errorCode: 'E_TRANSCRIBE_NO_OUTPUT', message: 'transcriber produced no JSON output.' };
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { parsed = { raw }; }
    if (p.transcriptAbsPath) {
      await fs.mkdir(path.dirname(p.transcriptAbsPath), { recursive: true });
      await fs.writeFile(p.transcriptAbsPath, JSON.stringify(parsed, null, 2), 'utf8');
    }
    return {
      ok: true,
      op: 'speech.transcribe',
      summary: parsed,
      transcript_path: p.transcriptAbsPath || '',
      backend: 'orkas-native:whisper.cpp',
    };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
