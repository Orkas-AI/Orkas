import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { NativeImage as ElectronNativeImage } from 'electron';

export type Issue = {
  code: string;
  severity: 'error' | 'warning' | 'info';
  selector?: string;
  message: string;
  fixHint?: string;
  source?: string;
};

export type AudioTrack = {
  absPath: string;
  startSec: number;
  declaredDurationSec?: number;
  volume: number;
};

export type CompositionMeta = {
  htmlPath: string;
  html: string;
  rootAttrs: Record<string, string>;
  id: string;
  width: number;
  height: number;
  durationSec: number;
  audioTracks: AudioTrack[];
};

export type JsonLoad = {
  path: string;
  exists: boolean;
  value: unknown;
  error?: string;
};

export type DraftRepairBudget = {
  compositionDirAbs: string;
  statePath: string;
  state: DraftRepairState;
  summary: DraftRepairSummary;
  blocked: boolean;
};

type DraftRepairState = {
  status: 'ok' | 'failed';
  failed_attempts: number;
  repair_passes_used: number;
  max_repair_passes: number;
  last_error: Record<string, unknown> | null;
  history: Array<Record<string, unknown>>;
  last_success?: Record<string, unknown>;
};

export type DraftRepairSummary = {
  ok: boolean;
  budget_exhausted: boolean;
  state_path: string;
  max_repair_passes: number;
  failed_attempts: number;
  repair_passes_used: number;
  repair_passes_remaining: number;
  last_error: Record<string, unknown> | null;
};

export type FrameSamplePlan = {
  label: string;
  timeSec: number;
  frameIndex: number;
};

export type FrameSampleEvidence = {
  label: string;
  time_seconds: number;
  frame_index: number;
  path: string;
  hash: string;
  brightness: number;
  contrast: number;
  width: number;
  height: number;
};

export type FrameEvidence = {
  evidence_dir: string;
  contact_sheet: string;
  frame_paths: string[];
  samples: FrameSampleEvidence[];
};

export const DRAFT_REPAIR_MAX_PASSES = 2;

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
  'ELEMENT_OUT_OF_CANVAS',
]);

function round2(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
}

function shortText(value: unknown, max = 220): string {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}...` : s;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function numberFrom(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function normalizeForSearch(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function isRemoteRef(ref: string): boolean {
  return /^(?:https?:)?\/\//i.test(ref);
}

function isIgnorableRef(ref: string): boolean {
  const s = String(ref || '').trim();
  return !s || s.startsWith('#') || /^(?:data|blob|javascript):/i.test(s);
}

function safeResolveLocalRef(rootAbs: string, ref: string): string | null {
  const clean = String(ref || '').split(/[?#]/)[0];
  const abs = path.resolve(rootAbs, clean);
  const rel = path.relative(rootAbs, abs);
  if (abs === rootAbs || (rel && !rel.startsWith('..') && !path.isAbsolute(rel))) return abs;
  return null;
}

export function parseFindingsPayload(findings: string): { errorCount: number; warningCount: number; issues: Issue[]; ok?: boolean } {
  try {
    const parsed = JSON.parse(String(findings || '{}')) as {
      ok?: boolean;
      errorCount?: number;
      warningCount?: number;
      issues?: Issue[];
      findings?: Issue[];
    };
    const issues = Array.isArray(parsed.issues)
      ? parsed.issues
      : (Array.isArray(parsed.findings) ? parsed.findings : []);
    return {
      ok: parsed.ok,
      errorCount: typeof parsed.errorCount === 'number'
        ? parsed.errorCount
        : issues.filter((i) => i.severity === 'error').length,
      warningCount: typeof parsed.warningCount === 'number'
        ? parsed.warningCount
        : issues.filter((i) => i.severity === 'warning').length,
      issues,
    };
  } catch {
    return { errorCount: 0, warningCount: 0, issues: [] };
  }
}

export function summarizeDraftInspectDisposition(findings: string): Record<string, unknown> {
  const parsed = parseFindingsPayload(findings);
  const advisoryIssues: Issue[] = [];
  const blockingIssues: Issue[] = [];
  for (const issue of parsed.issues) {
    const code = String(issue.code || '').toUpperCase();
    const isVisual = DRAFT_VISUAL_ADVISORY_CODES.has(code);
    if (issue.severity === 'error' && !isVisual) blockingIssues.push(issue);
    else advisoryIssues.push(issue);
  }
  return {
    blocking_error_count: blockingIssues.length,
    advisory_count: advisoryIssues.length,
    blocking_issues: blockingIssues.slice(0, 12),
    advisory_issues: advisoryIssues.slice(0, 12),
  };
}

async function readJsonIfExists(absPath: string): Promise<JsonLoad> {
  const st = await fs.stat(absPath).catch(() => null);
  if (!st || !st.isFile()) return { path: absPath, exists: false, value: null };
  try {
    return { path: absPath, exists: true, value: JSON.parse(await fs.readFile(absPath, 'utf8')) };
  } catch (err) {
    return { path: absPath, exists: true, value: null, error: (err as Error).message };
  }
}

export async function loadDesignContract(compositionDirAbs: string): Promise<JsonLoad> {
  return readJsonIfExists(path.join(compositionDirAbs, 'design-contract.json'));
}

export async function loadSceneMap(compositionDirAbs: string): Promise<JsonLoad> {
  return readJsonIfExists(path.join(compositionDirAbs, 'scene-map.json'));
}

export async function loadNarrationMap(compositionDirAbs: string): Promise<JsonLoad> {
  return readJsonIfExists(path.join(compositionDirAbs, 'narration-map.json'));
}

export async function loadShotlist(compositionDirAbs: string): Promise<JsonLoad> {
  return readJsonIfExists(path.resolve(compositionDirAbs, '..', 'shotlist.json'));
}

function jsonCanvas(value: unknown): { width: number; height: number; duration: number; fps: number } {
  const canvas = isRecord(value) && isRecord(value.canvas) ? value.canvas : {};
  return {
    width: numberFrom(canvas.width),
    height: numberFrom(canvas.height),
    duration: numberFrom(canvas.duration ?? canvas.duration_sec ?? canvas.duration_seconds),
    fps: numberFrom(canvas.fps),
  };
}

function expectedCanvas(contract: unknown, sceneMap: unknown): { width: number; height: number; duration: number; fps: number } {
  const fromSceneMap = jsonCanvas(sceneMap);
  const fromContract = jsonCanvas(contract);
  return {
    width: fromSceneMap.width || fromContract.width,
    height: fromSceneMap.height || fromContract.height,
    duration: fromSceneMap.duration || fromContract.duration,
    fps: fromSceneMap.fps || fromContract.fps,
  };
}

function extractScenes(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return [];
  if (Array.isArray(value.scenes)) return value.scenes.filter(isRecord);
  if (Array.isArray(value.shots)) return value.shots.filter(isRecord);
  if (isRecord(value.timeline) && Array.isArray(value.timeline.scenes)) return value.timeline.scenes.filter(isRecord);
  return [];
}

function extractShotlistShots(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return [];
  if (Array.isArray(value.shots)) return value.shots.filter(isRecord);
  if (Array.isArray(value.scenes)) return value.scenes.filter(isRecord);
  return [];
}

function sceneLabel(scene: Record<string, unknown>, index: number): string {
  return shortText(scene.id || scene.title || scene.headline || scene.name || `scene-${index + 1}`, 80);
}

function flattenSceneText(scene: unknown): string[] {
  const out: string[] = [];
  const visit = (value: unknown, key = '') => {
    if (typeof value === 'string') {
      if (/^(id|kind|type|role|layout|asset|src|path|narration_ref)$/i.test(key)) return;
      const s = value.trim();
      if (s.length >= 3 && s.length <= 180) out.push(s);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 12)) visit(item, key);
      return;
    }
    if (isRecord(value)) {
      for (const [k, v] of Object.entries(value)) visit(v, k);
    }
  };
  if (isRecord(scene)) {
    for (const key of ['headline', 'title', 'subtitle', 'body', 'copy', 'caption', 'label', 'text']) {
      if (scene[key]) visit(scene[key], key);
    }
  }
  return [...new Set(out)].slice(0, 8);
}

function htmlUsesGsap(html: string): boolean {
  return /\bgsap\s*\./.test(html);
}

function htmlHasLocalGsapVendorScript(html: string): boolean {
  return /<script\b[^>]*\bsrc\s*=\s*["']\.?\/?assets\/vendor\/gsap\.min\.js["'][^>]*>/i.test(html);
}

function contractAudio(value: unknown): Record<string, unknown> | null {
  return isRecord(value) && isRecord(value.audio) ? value.audio : null;
}

function sceneMapAudio(value: unknown): Record<string, unknown> | null {
  return isRecord(value) && isRecord(value.audio) ? value.audio : null;
}

function audioOwnsNarration(audio: Record<string, unknown> | null): boolean {
  if (!audio) return false;
  const owner = String(audio.owner || audio.mode || '').toLowerCase();
  if (audio.render_silent === true || owner === 'assemble' || owner === 'assembler' || owner === 'external') return false;
  return owner === 'composition' || !!(audio.narration || audio.narration_path || audio.path || audio.src);
}

function compositionOwnsNarration(contract: unknown, sceneMap: unknown): boolean {
  const audio = contractAudio(contract);
  const timelineAudio = sceneMapAudio(sceneMap);
  return audioOwnsNarration(audio) || audioOwnsNarration(timelineAudio);
}

function narrationPathFromAudio(audio: Record<string, unknown> | null): string {
  if (!audio) return '';
  return String(audio.narration || audio.narration_path || audio.path || audio.src || '').trim();
}

function narrationPathFromSources(contract: unknown, sceneMap: unknown): string {
  return narrationPathFromAudio(sceneMapAudio(sceneMap)) || narrationPathFromAudio(contractAudio(contract));
}

function resolveCompositionLocalPath(compositionDirAbs: string, raw: string): string | null {
  if (!raw || isRemoteRef(raw) || isIgnorableRef(raw) || path.isAbsolute(raw)) return null;
  return safeResolveLocalRef(compositionDirAbs, raw);
}

function sceneNarrationText(scene: Record<string, unknown>): string {
  const raw = scene.narration ?? scene.narration_text ?? scene.voiceover ?? scene.audio_text ?? scene.script;
  if (typeof raw === 'string') return raw.trim();
  if (isRecord(raw)) return String(raw.text || raw.body || raw.line || '').trim();
  return '';
}

function isTimedNarrationRef(ref: string): boolean {
  return /#t\s*=/i.test(ref);
}

function isMediaNarrationRef(ref: string): boolean {
  return /\.(?:mp3|wav|m4a|aac|ogg|opus)(?:[?#]|$)/i.test(ref);
}

function sceneNarrationRefs(scene: Record<string, unknown>): string[] {
  const raw = scene.narration_ref || scene.voiceover_ref || scene.script_ref;
  if (Array.isArray(raw)) return raw.map((item) => String(item).trim()).filter(Boolean);
  if (typeof raw === 'string') {
    const ref = raw.trim();
    if (!ref) return [];
    if (isTimedNarrationRef(ref) || isMediaNarrationRef(ref)) return [ref];
    return ref.split(/[, ]+/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function sceneSourceShots(scene: Record<string, unknown>): string[] {
  return Array.isArray(scene.source_shots) ? scene.source_shots.map((item) => String(item).trim()).filter(Boolean) : [];
}

function sceneStartSec(scene: Record<string, unknown>): number {
  return numberFrom(scene.start ?? scene.start_sec);
}

function sceneDurationSec(scene: Record<string, unknown>): number {
  const duration = numberFrom(scene.duration ?? scene.duration_sec);
  if (duration > 0) return duration;
  const start = sceneStartSec(scene);
  const end = numberFrom(scene.end ?? scene.end_sec);
  return end > start ? end - start : 0;
}

function sceneEndSec(scene: Record<string, unknown>): number {
  const start = sceneStartSec(scene);
  const duration = sceneDurationSec(scene);
  if (duration > 0) return start + duration;
  return numberFrom(scene.end ?? scene.end_sec);
}

function sceneKeyCandidates(scene: Record<string, unknown>): string[] {
  const keys = [
    scene.id,
    scene.scene_id,
    scene.shot_id,
    scene.source_shot,
    ...sceneSourceShots(scene),
  ].map((item) => String(item || '').trim()).filter(Boolean);
  return [...new Set(keys)];
}

type NarrationLine = {
  id: string;
  sceneId?: string;
  shotId?: string;
  start: number;
  duration: number;
  text: string;
};

function extractNarrationLines(value: unknown): NarrationLine[] {
  const rawLines = isRecord(value) && Array.isArray(value.lines) ? value.lines : [];
  const lines: NarrationLine[] = [];
  for (const [index, raw] of rawLines.entries()) {
    if (!isRecord(raw)) continue;
    const sceneId = String(raw.scene_id || raw.sceneId || '').trim();
    const shotId = String(raw.shot_id || raw.shotId || '').trim();
    const id = String(raw.id || raw.line_id || sceneId || shotId || `line-${index + 1}`).trim();
    const start = numberFrom(raw.start ?? raw.start_sec);
    const explicitDuration = numberFrom(raw.duration ?? raw.duration_sec);
    const end = numberFrom(raw.end ?? raw.end_sec);
    const duration = explicitDuration > 0 ? explicitDuration : (end > start ? end - start : 0);
    lines.push({
      id,
      ...(sceneId ? { sceneId } : {}),
      ...(shotId ? { shotId } : {}),
      start,
      duration,
      text: String(raw.text || raw.body || raw.line || '').trim(),
    });
  }
  return lines;
}

function narrationLineEnd(line: NarrationLine): number {
  return line.start + Math.max(line.duration, 0);
}

function narrationLineKeyIndex(lines: NarrationLine[]): Map<string, NarrationLine[]> {
  const out = new Map<string, NarrationLine[]>();
  const add = (key: string, line: NarrationLine) => {
    const clean = String(key || '').trim();
    if (!clean) return;
    const bucket = out.get(clean) || [];
    if (!bucket.includes(line)) bucket.push(line);
    out.set(clean, bucket);
  };
  for (const line of lines) {
    add(line.id, line);
    if (line.sceneId) add(line.sceneId, line);
    if (line.shotId) add(line.shotId, line);
  }
  return out;
}

function timedRefRange(ref: string): { start: number; end: number } | null {
  const m = /#t\s*=\s*([0-9.]+)\s*,\s*([0-9.]+)/i.exec(ref);
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? { start, end } : null;
}

function lineMatchesRange(line: NarrationLine, range: { start: number; end: number }): boolean {
  return Math.abs(line.start - range.start) <= 0.35 && Math.abs(narrationLineEnd(line) - range.end) <= 0.35;
}

function narrationLinesForScene(
  scene: Record<string, unknown>,
  refs: string[],
  lines: NarrationLine[],
  byKey: Map<string, NarrationLine[]>,
): { lines: NarrationLine[]; missingRefs: string[] } {
  const matched: NarrationLine[] = [];
  const missingRefs: string[] = [];
  const add = (line: NarrationLine) => {
    if (!matched.includes(line)) matched.push(line);
  };
  const timedRefs: string[] = [];

  for (const ref of refs) {
    const direct = byKey.get(ref);
    if (direct?.length) {
      direct.forEach(add);
    } else if (isTimedNarrationRef(ref) || isMediaNarrationRef(ref)) {
      timedRefs.push(ref);
    } else {
      missingRefs.push(ref);
    }
  }

  if (timedRefs.length) {
    for (const key of sceneKeyCandidates(scene)) {
      byKey.get(key)?.forEach(add);
    }
    const ranges = timedRefs.map(timedRefRange).filter((range): range is { start: number; end: number } => !!range);
    for (const range of ranges) {
      for (const line of lines) {
        if (lineMatchesRange(line, range)) add(line);
      }
    }
    for (const ref of timedRefs) {
      const range = timedRefRange(ref);
      const hasRangeMatch = range ? matched.some((line) => lineMatchesRange(line, range)) : false;
      const hasSceneMatch = matched.some((line) => {
        const keys = sceneKeyCandidates(scene);
        return (line.sceneId && keys.includes(line.sceneId)) || (line.shotId && keys.includes(line.shotId));
      });
      if (!hasRangeMatch && !hasSceneMatch) missingRefs.push(ref);
    }
  }

  return { lines: matched, missingRefs };
}

function audioTargetDuration(contract: unknown, sceneMap: unknown): number {
  const timelineAudio = sceneMapAudio(sceneMap);
  const audio = contractAudio(contract);
  return numberFrom(
    timelineAudio?.narration_duration_seconds
      ?? timelineAudio?.narration_duration_sec
      ?? timelineAudio?.source_duration_seconds
      ?? timelineAudio?.audio_duration_seconds
      ?? timelineAudio?.duration_seconds
      ?? timelineAudio?.duration
      ?? timelineAudio?.duration_sec
      ?? timelineAudio?.target_duration_seconds
      ?? timelineAudio?.target_sec
      ?? audio?.narration_duration_seconds
      ?? audio?.narration_duration_sec
      ?? audio?.source_duration_seconds
      ?? audio?.audio_duration_seconds
      ?? audio?.duration_seconds
      ?? audio?.duration
      ?? audio?.duration_sec
      ?? audio?.target_duration_seconds
      ?? audio?.target_sec,
  );
}

export async function runContractHtmlQa(
  meta: CompositionMeta,
  metaIssues: Issue[],
  contractLoad: JsonLoad,
  sceneMapLoad: JsonLoad,
  _compositionDirAbs: string,
): Promise<Record<string, unknown>> {
  const issues: Issue[] = metaIssues.map((issue) => ({
    ...issue,
    source: issue.source || 'orkas-native-contract-html',
  }));
  const contract = contractLoad.value;
  const sceneMap = sceneMapLoad.value;

  if (!contractLoad.exists) {
    issues.push({
      code: 'DESIGN_CONTRACT_MISSING',
      severity: 'error',
      selector: 'design-contract.json',
      message: 'project/composition/design-contract.json is required before drafting model-authored HTML.',
      source: 'orkas-native-contract-html',
    });
  } else if (contractLoad.error || !isRecord(contract)) {
    issues.push({
      code: 'DESIGN_CONTRACT_PARSE_FAILED',
      severity: 'error',
      selector: 'design-contract.json',
      message: `Could not parse design-contract.json: ${contractLoad.error || 'not a JSON object'}`,
      source: 'orkas-native-contract-html',
    });
  }
  if (sceneMapLoad.exists && (sceneMapLoad.error || !isRecord(sceneMap))) {
    issues.push({
      code: 'SCENE_MAP_PARSE_FAILED',
      severity: 'error',
      selector: 'scene-map.json',
      message: `Could not parse scene-map.json: ${sceneMapLoad.error || 'not a JSON object'}`,
      source: 'orkas-native-contract-html',
    });
  }
  if (htmlUsesGsap(meta.html) && !htmlHasLocalGsapVendorScript(meta.html)) {
    issues.push({
      code: 'GSAP_VENDOR_SCRIPT_MISSING',
      severity: 'error',
      selector: 'index.html',
      message: 'index.html uses gsap but does not load ./assets/vendor/gsap.min.js.',
      source: 'orkas-native-contract-html',
    });
  }

  const contractCanvas = jsonCanvas(contract);
  const sceneMapCanvas = jsonCanvas(sceneMap);
  for (const key of ['width', 'height', 'duration'] as const) {
    const tolerance = key === 'duration' ? 0.15 : 1;
    if (contractCanvas[key] && sceneMapCanvas[key] && Math.abs(contractCanvas[key] - sceneMapCanvas[key]) > tolerance) {
      issues.push({
        code: 'CONTRACT_SCENE_MAP_CANVAS_MISMATCH',
        severity: 'error',
        selector: 'design-contract.json',
        message: `design-contract canvas ${key}=${contractCanvas[key]} but scene-map canvas ${key}=${sceneMapCanvas[key]}.`,
        source: 'orkas-native-contract-html',
      });
    }
  }

  const expected = expectedCanvas(contract, sceneMap);
  const rootCanvas = { width: meta.width, height: meta.height, duration: meta.durationSec };
  for (const key of ['width', 'height', 'duration'] as const) {
    if (!expected[key]) continue;
    const tolerance = key === 'duration' ? 0.15 : 1;
    if (Math.abs(rootCanvas[key] - expected[key]) > tolerance) {
      issues.push({
        code: 'CANVAS_CONTRACT_MISMATCH',
        severity: 'error',
        selector: '[data-composition-id]',
        message: `index.html root ${key}=${rootCanvas[key]} but contract/scene-map expects ${expected[key]}.`,
        source: 'orkas-native-contract-html',
      });
    }
  }

  const scenes = extractScenes(sceneMap).length ? extractScenes(sceneMap) : extractScenes(contract);
  const duration = expected.duration || meta.durationSec;
  let prevEnd = -1;
  scenes.forEach((scene, index) => {
    const start = sceneStartSec(scene);
    const sceneDuration = sceneDurationSec(scene);
    if (sceneDuration <= 0) {
      issues.push({
        code: 'SCENE_TIMING_INVALID',
        severity: 'error',
        selector: sceneMapLoad.exists ? 'scene-map.json' : 'design-contract.json',
        message: `Scene "${sceneLabel(scene, index)}" needs numeric start plus positive duration or end.`,
        source: 'orkas-native-contract-html',
      });
      return;
    }
    if (start + sceneDuration > duration + 0.15) {
      issues.push({
        code: 'SCENE_TIMING_OUT_OF_RANGE',
        severity: 'error',
        selector: sceneMapLoad.exists ? 'scene-map.json' : 'design-contract.json',
        message: `Scene "${sceneLabel(scene, index)}" ends beyond the composition duration.`,
        source: 'orkas-native-contract-html',
      });
    }
    if (prevEnd >= 0 && start < prevEnd - 0.15) {
      issues.push({
        code: 'SCENE_TIMING_OVERLAP',
        severity: 'error',
        selector: sceneMapLoad.exists ? 'scene-map.json' : 'design-contract.json',
        message: `Scene "${sceneLabel(scene, index)}" starts before the prior scene ends.`,
        source: 'orkas-native-contract-html',
      });
    }
    prevEnd = Math.max(prevEnd, start + sceneDuration);
  });

  const htmlSearch = normalizeForSearch(meta.html);
  for (const [index, scene] of scenes.slice(0, 16).entries()) {
    for (const text of flattenSceneText(scene).slice(0, 5)) {
      const needle = normalizeForSearch(text);
      if (needle && !htmlSearch.includes(needle)) {
        issues.push({
          code: 'HTML_MISSING_SCENE_COPY',
          severity: 'error',
          selector: 'index.html',
          message: `Scene "${sceneLabel(scene, index)}" declares on-screen copy not found in index.html: "${shortText(text, 100)}".`,
          source: 'orkas-native-contract-html',
        });
      }
    }
  }

  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  return {
    ok: errorCount === 0,
    error_count: errorCount,
    warning_count: issues.filter((issue) => issue.severity === 'warning').length,
    issue_count: issues.length,
    contract_path: contractLoad.path,
    scene_map_path: sceneMapLoad.path,
    issues,
  };
}

export async function runSourceAlignmentQa(sceneMapLoad: JsonLoad, shotlistLoad: JsonLoad): Promise<Record<string, unknown>> {
  const issues: Issue[] = [];
  const scenes = extractScenes(sceneMapLoad.value);
  const shots = extractShotlistShots(shotlistLoad.value);
  if (!shotlistLoad.exists) {
    return { ok: true, skipped: true, reason: 'shotlist_missing', issues };
  }
  if (shotlistLoad.error) {
    issues.push({
      code: 'SHOTLIST_PARSE_FAILED',
      severity: 'error',
      selector: 'shotlist.json',
      message: `Could not parse shotlist.json: ${shotlistLoad.error}`,
      source: 'orkas-native-source-alignment',
    });
  }
  if (!sceneMapLoad.exists || sceneMapLoad.error || !scenes.length) {
    issues.push({
      code: 'SCENE_MAP_REQUIRED_FOR_SOURCE_ALIGNMENT',
      severity: 'error',
      selector: 'scene-map.json',
      message: 'shotlist.json exists, but scene-map.json has no scenes to map approved beats.',
      source: 'orkas-native-source-alignment',
    });
  }
  const alignment = isRecord(sceneMapLoad.value) && isRecord(sceneMapLoad.value.source_alignment)
    ? sceneMapLoad.value.source_alignment
    : {};
  const mergeReason = typeof alignment.merge_reason === 'string' && alignment.merge_reason.trim();
  const mappedShotCount = new Set<string>();
  for (const scene of scenes) {
    const refs = Array.isArray(scene.source_shots) ? scene.source_shots : [];
    refs.forEach((ref) => mappedShotCount.add(String(ref)));
  }
  if (shots.length > scenes.length && !mergeReason && mappedShotCount.size < shots.length) {
    issues.push({
      code: 'SHOTLIST_SCENE_MAP_MISMATCH',
      severity: 'error',
      selector: 'scene-map.json',
      message: `shotlist has ${shots.length} shots but scene-map has ${scenes.length} scenes. Add source_alignment.merge_reason or per-scene source_shots when intentionally merging beats.`,
      source: 'orkas-native-source-alignment',
    });
  }
  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  return {
    ok: errorCount === 0,
    skipped: false,
    shot_count: shots.length,
    scene_count: scenes.length,
    mapped_source_shot_count: mappedShotCount.size,
    error_count: errorCount,
    issue_count: issues.length,
    issues,
  };
}

export async function runAudioTimingQa(
  meta: CompositionMeta,
  contractLoad: JsonLoad,
  sceneMapLoad: JsonLoad,
  narrationMapLoad: JsonLoad,
  compositionDirAbs: string,
): Promise<Record<string, unknown>> {
  const issues: Issue[] = [];
  const contract = contractLoad.value;
  const sceneMap = sceneMapLoad.value;
  const ownsNarration = compositionOwnsNarration(contract, sceneMap);
  const scenes = extractScenes(sceneMapLoad.value);
  const narrationPath = narrationPathFromSources(contract, sceneMap);
  const narrationAbsPath = narrationPath ? resolveCompositionLocalPath(compositionDirAbs, narrationPath) : null;
  const narrationFileExists = narrationAbsPath ? !!(await fs.stat(narrationAbsPath).catch(() => null)) : false;

  if (narrationPath && !narrationFileExists) {
    issues.push({
      code: 'NARRATION_ASSET_MISSING',
      severity: 'error',
      selector: narrationPath,
      message: `Narration audio is declared but the file does not exist: ${narrationPath}.`,
      source: 'orkas-native-audio-timing',
    });
  }
  if (ownsNarration && (!meta.audioTracks.length || !narrationFileExists)) {
    issues.push({
      code: 'NARRATION_DECLARED_BUT_SILENT',
      severity: 'error',
      selector: meta.audioTracks.length ? narrationPath || 'design-contract.json' : 'index.html',
      message: 'design-contract.json declares composition-owned narration, but the composition has no usable narration audio track.',
      source: 'orkas-native-audio-timing',
    });
  }
  if ((ownsNarration || meta.audioTracks.length > 0) && !sceneMapLoad.exists) {
    issues.push({
      code: 'SCENE_MAP_REQUIRED_FOR_AUDIO_TIMING',
      severity: 'error',
      selector: 'scene-map.json',
      message: 'Narrated compositions require scene-map.json so voiceover-to-visual alignment is auditable.',
      source: 'orkas-native-audio-timing',
    });
  }
  if (sceneMapLoad.exists && sceneMapLoad.error) {
    issues.push({
      code: 'SCENE_MAP_PARSE_FAILED',
      severity: 'error',
      selector: 'scene-map.json',
      message: `Could not parse scene-map.json: ${sceneMapLoad.error}`,
      source: 'orkas-native-audio-timing',
    });
  }
  if (narrationMapLoad.exists && narrationMapLoad.error) {
    issues.push({
      code: 'NARRATION_MAP_PARSE_FAILED',
      severity: 'error',
      selector: 'narration-map.json',
      message: `Could not parse narration-map.json: ${narrationMapLoad.error}`,
      source: 'orkas-native-audio-timing',
    });
  }
  if (ownsNarration && scenes.length) {
    const missing = scenes.filter((scene) => {
      if (sceneNarrationText(scene)) return false;
      if (sceneNarrationRefs(scene).length) return false;
      if (sceneSourceShots(scene).length) return false;
      return true;
    });
    if (missing.length) {
      issues.push({
        code: 'SCENE_NARRATION_MAPPING_MISSING',
        severity: 'error',
        selector: 'scene-map.json',
        message: `${missing.length} scene(s) have no narration, narration_ref, or source_shots mapping.`,
        source: 'orkas-native-audio-timing',
      });
    }
  }

  const narrationLines = extractNarrationLines(narrationMapLoad.value);
  const narrationLineByKey = narrationLineKeyIndex(narrationLines);
  const refScenes = scenes.filter((scene) => sceneNarrationRefs(scene).length);
  if (refScenes.length && narrationLines.length) {
    for (const scene of refScenes) {
      const refs = sceneNarrationRefs(scene);
      const { lines, missingRefs } = narrationLinesForScene(scene, refs, narrationLines, narrationLineByKey);
      if (missingRefs.length) {
        issues.push({
          code: 'NARRATION_REF_MISSING',
          severity: 'error',
          selector: 'scene-map.json',
          message: `Scene "${sceneLabel(scene, scenes.indexOf(scene))}" references narration line(s) not found in narration-map.json: ${missingRefs.join(', ')}.`,
          source: 'orkas-native-audio-timing',
        });
        continue;
      }
      if (!lines.length) continue;
      const expectedStart = Math.min(...lines.map((line) => line.start));
      const expectedEnd = Math.max(...lines.map(narrationLineEnd));
      const actualStart = sceneStartSec(scene);
      const actualEnd = sceneEndSec(scene);
      const startDrift = actualStart - expectedStart;
      if (Math.abs(startDrift) > 1.25) {
        issues.push({
          code: 'NARRATION_LINE_START_DRIFT',
          severity: 'error',
          selector: 'scene-map.json',
          message: `Scene "${sceneLabel(scene, scenes.indexOf(scene))}" starts at ${round2(actualStart)}s but narration-map starts at ${round2(expectedStart)}s (${round2(startDrift)}s drift).`,
          source: 'orkas-native-audio-timing',
        });
      }
      if (expectedEnd > actualEnd + 1.25) {
        issues.push({
          code: 'NARRATION_LINE_OVERFLOWS_SCENE',
          severity: 'error',
          selector: 'scene-map.json',
          message: `Scene "${sceneLabel(scene, scenes.indexOf(scene))}" ends at ${round2(actualEnd)}s but referenced narration line(s) run until ${round2(expectedEnd)}s.`,
          source: 'orkas-native-audio-timing',
        });
      }
    }
  } else if (refScenes.length && !narrationLines.length) {
    const refScenesWithoutInlineTiming = refScenes.filter((scene) => !sceneNarrationText(scene) || sceneDurationSec(scene) <= 0);
    issues.push({
      code: 'NARRATION_MAP_MISSING',
      severity: refScenesWithoutInlineTiming.length ? 'error' : 'warning',
      selector: 'narration-map.json',
      message: refScenesWithoutInlineTiming.length
        ? 'Scenes use narration_ref but narration-map.json has no lines and not every referenced scene has inline narration text with a numeric time window. Add project/composition/narration-map.json or inline per-scene narration text and timing before Gate D.'
        : 'Scenes use narration_ref but narration-map.json has no lines, so draft QA falls back to coarse inline narration timing checks.',
      source: 'orkas-native-audio-timing',
    });
  }

  const mappedScenes = scenes.filter((scene) => sceneNarrationText(scene) || sceneNarrationRefs(scene).length || sceneSourceShots(scene).length);
  const narratedScenes = scenes.filter((scene) => sceneNarrationText(scene));
  const targetDuration = audioTargetDuration(contract, sceneMap);
  if (!narrationLines.length && narratedScenes.length >= 2 && targetDuration > 0) {
      const totalChars = narratedScenes.reduce((sum, scene) => sum + sceneNarrationText(scene).length, 0);
    let cursorChars = 0;
    for (const scene of narratedScenes) {
      const expectedStart = totalChars > 0 ? (cursorChars / totalChars) * targetDuration : 0;
      const actualStart = sceneStartSec(scene);
      const drift = actualStart - expectedStart;
      if (Math.abs(drift) > 3.5) {
        issues.push({
          code: 'AUDIO_TIMING_DRIFT',
          severity: 'error',
          selector: 'scene-map.json',
          message: `Scene "${sceneLabel(scene, scenes.indexOf(scene))}" starts at ${round2(actualStart)}s but estimated narration timing is ${round2(expectedStart)}s (${round2(drift)}s drift).`,
          source: 'orkas-native-audio-timing',
        });
      }
      cursorChars += sceneNarrationText(scene).length;
    }
  } else if (!narrationLines.length && mappedScenes.length >= 2 && narratedScenes.length < 2) {
    issues.push({
      code: 'AUDIO_TIMING_ESTIMATE_SKIPPED',
      severity: 'warning',
      selector: 'scene-map.json',
      message: 'Scenes use narration references or source_shots without inline narration text, so draft QA can verify mapping presence but cannot estimate timing drift.',
      source: 'orkas-native-audio-timing',
    });
  }

  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  return {
    ok: errorCount === 0,
    skipped: !ownsNarration && meta.audioTracks.length === 0,
    narration_path: narrationPath,
    narration_file_exists: narrationFileExists,
    narration_map_path: narrationMapLoad.path,
    narration_line_count: narrationLines.length,
    scene_count: scenes.length,
    audio_track_count: meta.audioTracks.length,
    error_count: errorCount,
    warning_count: issues.filter((issue) => issue.severity === 'warning').length,
    issue_count: issues.length,
    issues,
  };
}

function draftRepairStatePath(compositionDirAbs: string): string {
  return path.join(compositionDirAbs, 'qa', 'draft-repair-state.json');
}

async function draftContentSignature(compositionDirAbs: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  for (const name of ['design-contract.json', 'scene-map.json', 'narration-map.json', 'index.html']) {
    const abs = path.join(compositionDirAbs, name);
    const st = await fs.stat(abs).catch(() => null);
    if (!st || !st.isFile()) continue;
    hash.update(name);
    hash.update('\0');
    hash.update(await fs.readFile(abs));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function normalizeRepairState(raw: unknown): DraftRepairState {
  const r = isRecord(raw) ? raw : {};
  const failedAttempts = Math.max(0, Number(r.failed_attempts) || 0);
  return {
    status: r.status === 'failed' ? 'failed' : 'ok',
    failed_attempts: failedAttempts,
    repair_passes_used: Math.max(0, failedAttempts - 1),
    max_repair_passes: DRAFT_REPAIR_MAX_PASSES,
    last_error: isRecord(r.last_error) ? r.last_error : null,
    history: Array.isArray(r.history) ? r.history.filter(isRecord).slice(-12) : [],
    last_success: isRecord(r.last_success) ? r.last_success : undefined,
  };
}

function repairBudgetSummary(statePath: string, state: DraftRepairState): DraftRepairSummary {
  const failedAttempts = Math.max(0, Number(state.failed_attempts) || 0);
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
    last_error: state.last_error,
  };
}

export async function initDraftRepairBudget(compositionDirAbs: string): Promise<DraftRepairBudget> {
  const statePath = draftRepairStatePath(compositionDirAbs);
  const raw = await readJsonIfExists(statePath);
  const state = normalizeRepairState(raw.value);
  const summary = repairBudgetSummary(statePath, state);
  return {
    compositionDirAbs,
    statePath,
    state,
    summary,
    blocked: state.status === 'failed' && summary.budget_exhausted,
  };
}

async function writeRepairState(statePath: string, state: DraftRepairState): Promise<void> {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');
}

export async function recordDraftFailure(
  repairBudget: DraftRepairBudget,
  reportAbsPath: string | undefined,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Promise<DraftRepairSummary> {
  const raw = await readJsonIfExists(repairBudget.statePath);
  const previous = normalizeRepairState(raw.value || repairBudget.state);
  const failedAttempts = previous.failed_attempts + 1;
  const entry = {
    ts: new Date().toISOString(),
    code,
    message: shortText(message, 300),
    report_path: reportAbsPath || '',
    repair_target: shortText(extra.repair_target || '', 120),
    content_signature: await draftContentSignature(repairBudget.compositionDirAbs),
  };
  const next: DraftRepairState = {
    status: 'failed',
    failed_attempts: failedAttempts,
    repair_passes_used: Math.max(0, failedAttempts - 1),
    max_repair_passes: DRAFT_REPAIR_MAX_PASSES,
    last_error: entry,
    history: [...previous.history, entry].slice(-12),
  };
  await writeRepairState(repairBudget.statePath, next);
  repairBudget.state = next;
  repairBudget.summary = repairBudgetSummary(repairBudget.statePath, next);
  repairBudget.blocked = repairBudget.summary.budget_exhausted;
  return repairBudget.summary;
}

export async function recordDraftSuccess(
  repairBudget: DraftRepairBudget,
  reportAbsPath: string | undefined,
  renderPath: string | undefined,
): Promise<DraftRepairSummary> {
  const raw = await readJsonIfExists(repairBudget.statePath);
  const previous = normalizeRepairState(raw.value || repairBudget.state);
  const next: DraftRepairState = {
    status: 'ok',
    failed_attempts: 0,
    repair_passes_used: 0,
    max_repair_passes: DRAFT_REPAIR_MAX_PASSES,
    last_error: null,
    history: previous.history,
    last_success: {
      ts: new Date().toISOString(),
      report_path: reportAbsPath || '',
      path: renderPath || '',
      content_signature: await draftContentSignature(repairBudget.compositionDirAbs),
    },
  };
  await writeRepairState(repairBudget.statePath, next);
  repairBudget.state = next;
  repairBudget.summary = repairBudgetSummary(repairBudget.statePath, next);
  repairBudget.blocked = false;
  return repairBudget.summary;
}

export function samplePlanKey(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'sample';
}

export function buildDraftFrameSamplePlan(meta: CompositionMeta, sceneMap: unknown, fps: number): FrameSamplePlan[] {
  const duration = Math.max(0.1, meta.durationSec);
  const raw: Array<{ label: string; timeSec: number }> = [
    { label: 'first-frame', timeSec: 0 },
    { label: 'quarter', timeSec: duration * 0.25 },
    { label: 'midpoint', timeSec: duration * 0.5 },
    { label: 'three-quarter', timeSec: duration * 0.75 },
    { label: 'payoff-frame', timeSec: Math.max(0, duration - 0.05) },
  ];
  extractScenes(sceneMap).slice(0, 8).forEach((scene, index) => {
    const start = Math.max(0, numberFrom(scene.start ?? scene.start_sec));
    const sceneDuration = Math.max(0, numberFrom(scene.duration ?? scene.duration_sec));
    raw.push({ label: `${sceneLabel(scene, index)}-start`, timeSec: start });
    if (sceneDuration > 0.2) raw.push({ label: `${sceneLabel(scene, index)}-mid`, timeSec: start + sceneDuration / 2 });
  });

  const totalFrames = Math.max(1, Math.ceil(duration * fps));
  const seen = new Set<number>();
  const out: FrameSamplePlan[] = [];
  for (const item of raw) {
    const t = Math.max(0, Math.min(duration - 0.001, item.timeSec));
    const frameIndex = Math.max(0, Math.min(totalFrames - 1, Math.floor(t * fps)));
    if (seen.has(frameIndex)) continue;
    seen.add(frameIndex);
    out.push({ label: samplePlanKey(item.label), timeSec: round2(frameIndex / fps), frameIndex });
    if (out.length >= 14) break;
  }
  return out;
}

export function analyzeNativeImage(image: ElectronNativeImage): { hash: string; brightness: number; contrast: number; width: number; height: number } {
  const size = image.getSize();
  const bitmap = image.toBitmap();
  const pixelCount = Math.max(1, size.width * size.height);
  const stride = Math.max(1, Math.floor(bitmap.length / pixelCount));
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < bitmap.length; i += stride) {
    const r = bitmap[i] ?? 0;
    const g = bitmap[i + 1] ?? r;
    const b = bitmap[i + 2] ?? r;
    const y = (0.2126 * r) + (0.7152 * g) + (0.0722 * b);
    sum += y;
    sumSq += y * y;
  }
  const mean = sum / pixelCount;
  const variance = Math.max(0, (sumSq / pixelCount) - mean * mean);
  return {
    hash: crypto.createHash('sha256').update(bitmap).digest('hex'),
    brightness: round2(mean),
    contrast: round2(Math.sqrt(variance)),
    width: size.width,
    height: size.height,
  };
}

export async function writeFrameContactSheet(evidenceDirAbs: string, samples: FrameSampleEvidence[]): Promise<string> {
  const thumbW = 320;
  const thumbH = 180;
  const gap = 16;
  const cols = Math.min(3, Math.max(1, samples.length));
  const rows = Math.max(1, Math.ceil(samples.length / cols));
  const width = cols * thumbW + (cols + 1) * gap;
  const height = rows * (thumbH + 36) + (rows + 1) * gap;
  const items = samples.map((sample, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const x = gap + col * (thumbW + gap);
    const y = gap + row * (thumbH + 36 + gap);
    const href = path.basename(sample.path).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    const label = `${sample.label} @ ${sample.time_seconds}s`.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    return `<image href="${href}" x="${x}" y="${y}" width="${thumbW}" height="${thumbH}" preserveAspectRatio="xMidYMid meet"/><text x="${x}" y="${y + thumbH + 24}" fill="#111" font-family="system-ui, sans-serif" font-size="16">${label}</text>`;
  }).join('\n');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#fff"/>\n${items}\n</svg>\n`;
  const out = path.join(evidenceDirAbs, 'contact-sheet.svg');
  await fs.writeFile(out, svg, 'utf8');
  return out;
}

export function summarizeVideoFrameQa(frameEvidence: FrameEvidence | null, durationSec: number): Record<string, unknown> {
  const issues: Issue[] = [];
  const samples = frameEvidence?.samples || [];
  if (!samples.length) {
    issues.push({
      code: 'VIDEO_SAMPLE_FRAMES_MISSING',
      severity: 'error',
      message: 'No sampled evidence frames were captured for draft video QA.',
      source: 'orkas-native-video-qa',
    });
  }
  for (const sample of samples) {
    if (sample.brightness < 4 || sample.brightness > 251 || sample.contrast < 1.5) {
      issues.push({
        code: sample.label === 'first-frame' ? 'EMPTY_HOOK_FRAME' : 'BLANK_SAMPLE_FRAME',
        severity: 'error',
        message: `Sample "${sample.label}" at ${sample.time_seconds}s appears blank or nearly flat (brightness=${sample.brightness}, contrast=${sample.contrast}).`,
        source: 'orkas-native-video-qa',
      });
    }
  }
  let runStart = 0;
  for (let i = 1; i <= samples.length; i += 1) {
    const sameAsRun = i < samples.length && samples[i].hash === samples[runStart].hash;
    if (sameAsRun) continue;
    const runLen = i - runStart;
    const span = runLen > 1 ? samples[i - 1].time_seconds - samples[runStart].time_seconds : 0;
    if (runLen >= 3 && span >= Math.min(6, Math.max(2, durationSec * 0.35))) {
      issues.push({
        code: 'FROZEN_FRAME_RUN',
        severity: 'error',
        message: `${runLen} sampled frames are identical across ${round2(span)}s, indicating a frozen or static draft.`,
        source: 'orkas-native-video-qa',
      });
    }
    runStart = i;
  }
  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  return {
    ok: errorCount === 0,
    issue_count: issues.length,
    error_count: errorCount,
    warning_count: issues.filter((issue) => issue.severity === 'warning').length,
    evidence_dir: frameEvidence?.evidence_dir || '',
    contact_sheet: frameEvidence?.contact_sheet || '',
    frame_paths: frameEvidence?.frame_paths || [],
    samples,
    issues,
  };
}
