import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { NativeImage as ElectronNativeImage } from 'electron';

import { parseHtmlStructure } from './video_studio_html_check';

export type Issue = {
  code: string;
  severity: 'error' | 'warning' | 'info';
  disposition?: 'fatal' | 'blocking' | 'advisory';
  confidence?: 'high' | 'medium' | 'low';
  selector?: string;
  message: string;
  fixHint?: string;
  source?: string;
  sceneId?: string;
  role?: string;
  sampleTimeSec?: number;
  activeScene?: boolean;
  evidence?: Record<string, unknown>;
};

export const VIDEO_STUDIO_INSPECTOR_VERSION = 2;

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
  /** Authoritative ledger. Tool callers may place this outside the agent's
   * writable workspace so deleting the human-readable audit cannot reset the
   * retry budget. */
  statePath: string;
  /** Human-readable mirror kept beside the composition for diagnostics. */
  auditStatePath: string;
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
  sceneId?: string;
};

export type FrameSampleEvidence = {
  label: string;
  time_seconds: number;
  frame_index: number;
  path: string;
  hash: string;
  perceptual_hash?: string;
  brightness: number;
  contrast: number;
  width: number;
  height: number;
  expected_scene_id?: string;
  visible_scene_ids?: string[];
  visible_roles?: string[];
  visible_text?: string;
  capture_source_width?: number;
  capture_source_height?: number;
  capture_scale_factor?: number;
};

export type FrameEvidence = {
  evidence_dir: string;
  contact_sheet: string;
  frame_paths: string[];
  samples: FrameSampleEvidence[];
};

export type DesignReviewInputOptions = {
  contractLoad: JsonLoad;
  sceneMapLoad: JsonLoad;
  contractHtml?: Record<string, unknown> | null;
  inspectDisposition?: Record<string, unknown> | null;
  frameEvidence?: FrameEvidence | null;
  visualRegression?: Record<string, unknown> | null;
};

export const DRAFT_REPAIR_MAX_PASSES = 2;

// Environmental draft failures are machine/runtime conditions the model cannot
// fix by editing the composition: a machine too weak to render, missing bundled
// binaries, or a user abort. They must NOT consume the content-repair budget, or
// a constrained machine bricks the composition after a few identical machine-side
// failures with nothing to repair. Kept deliberately narrow — ambiguous timeouts
// and encode failures stay budget-consuming, since those can be a content-side
// runaway (e.g. an infinite script) the model can actually fix.
const ENVIRONMENTAL_DRAFT_FAILURE_CODES = new Set([
  'E_RENDER_TOO_HEAVY',
  'E_FFMPEG_MISSING',
  'E_FFPROBE_MISSING',
  'E_RENDER_ABORTED',
  'E_CAPTURE_GEOMETRY_INVALID',
]);

export function isEnvironmentalDraftFailure(code: string): boolean {
  return ENVIRONMENTAL_DRAFT_FAILURE_CODES.has(code);
}

const DRAFT_VISUAL_ADVISORY_CODES = new Set([
  'FONT_TOO_SMALL',
  'PALETTE_LARGE',
  'ONE_NOTE_PALETTE',
  'LOW_CONTRAST',
  'TEXT_DENSITY_HIGH',
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
  'VISUAL_COMPLEXITY_HIGH',
]);

const DESIGN_CONTRACT_SECTIONS = [
  'aesthetic',
  'visual_direction',
  'layout_boxes',
  'typography_tokens',
  'color_tokens',
  'motion_budget',
  'scene_variation',
];

const AESTHETIC_FIELDS = [
  'subject_world',
  'one_job',
  'signature_device',
  'aesthetic_risk',
  'anti_template_check',
];

const VISUAL_DIRECTION_FIELDS = [
  'visual_tradition',
  'lazy_defaults_rejected',
  'video_scale',
  'depth_layer_rule',
  'motion_verb_rule',
  'rhythm_pattern',
];

const GENERIC_AESTHETIC_RE = /\b(?:modern tech|clean modern|sleek|premium|minimalist|minimal|futuristic|dynamic|engaging|professional|high[- ]end|beautiful|polished)\b/i;
const HARD_PREVIEW_DESIGN_CODES = new Set([
  'AESTHETIC_THESIS_INCOMPLETE',
  'GENERIC_AESTHETIC_THESIS',
  'VISUAL_DIRECTION_INCOMPLETE',
  'SCENE_DEPTH_LAYERS_MISSING',
  'SCENE_MOTION_VERBS_MISSING',
]);

const PREVIEW_REQUIRED_DESIGN_SECTIONS = new Set([
  'aesthetic',
  'visual_direction',
  'motion_budget',
  'scene_variation',
]);

function designSeverity(code: string, hard = true): Issue['severity'] {
  if (code === 'DESIGN_CONTRACT_BUDGET_INCOMPLETE') return hard ? 'error' : 'warning';
  return HARD_PREVIEW_DESIGN_CODES.has(code) ? 'error' : 'warning';
}

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

function hasContent(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length >= 4;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.values(value).some(hasContent);
  return value !== null && value !== undefined && value !== false;
}

function textFrom(value: unknown): string {
  const out: string[] = [];
  const visit = (item: unknown) => {
    if (typeof item === 'string') {
      const s = item.trim();
      if (s) out.push(s);
      return;
    }
    if (Array.isArray(item)) {
      item.slice(0, 24).forEach(visit);
      return;
    }
    if (isRecord(item)) {
      Object.values(item).slice(0, 48).forEach(visit);
    }
  };
  visit(value);
  return out.join(' ').replace(/\s+/g, ' ').trim();
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
  const normalizedIssues = dedupeInspectIssues(normalizeDraftInspectIssueSeverities(parsed.issues));
  const advisoryIssues: Issue[] = [];
  const blockingIssues: Issue[] = [];
  for (const issue of normalizedIssues) {
    if (issue.severity === 'error') blockingIssues.push(issue);
    else advisoryIssues.push(issue);
  }
  return {
    blocking_error_count: blockingIssues.length,
    fatal_error_count: blockingIssues.filter((issue) => issue.disposition === 'fatal').length,
    advisory_count: advisoryIssues.length,
    blocking_issues: blockingIssues.slice(0, 12),
    advisory_issues: advisoryIssues.slice(0, 12),
  };
}

const BLOCKING_VISUAL_CODES = new Set([
  'FONT_TOO_SMALL',
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

/** Native browser heuristics are enforceable only when they carry high-
 * confidence evidence from the active scene. Structural errors and explicit
 * non-native semantic errors remain fail-closed. */
export function normalizeDraftInspectIssueSeverities(issues: Issue[]): Issue[] {
  return issues.map((issue) => {
    const code = String(issue.code || '').toUpperCase();
    const isVisual = DRAFT_VISUAL_ADVISORY_CODES.has(code);
    const role = String(issue.role || '').toLowerCase();
    const selector = String(issue.selector || '').toLowerCase();
    const decorative = /(?:background|decoration|decorative|texture|glow|particle|ornament)/.test(role)
      || /(?:background|\bbg\b|decor|glow|particle|arc|orb|texture)/.test(selector);
    const semanticVisual = BLOCKING_VISUAL_CODES.has(code)
      && (code !== 'ELEMENT_OUT_OF_CANVAS' || !decorative);
    const nativeHeuristic = issue.source === 'orkas-native-inspect';
    const trustworthyNativeFinding = nativeHeuristic
      && issue.confidence === 'high'
      && issue.activeScene !== false
      && !!issue.evidence;
    const blocking = isVisual
      ? semanticVisual && (nativeHeuristic ? trustworthyNativeFinding : issue.severity === 'error')
      : issue.severity === 'error';
    return {
      ...issue,
      severity: blocking ? 'error' as const : issue.severity === 'info' ? 'info' as const : 'warning' as const,
      disposition: blocking ? (isVisual ? 'blocking' as const : 'fatal' as const) : 'advisory' as const,
    };
  });
}

export function dedupeInspectIssues(issues: Issue[]): Issue[] {
  const seen = new Set<string>();
  const deduped: Issue[] = [];
  for (const issue of issues) {
    const sample = typeof issue.sampleTimeSec === 'number' ? issue.sampleTimeSec.toFixed(2) : '';
    const key = [
      String(issue.code || '').toUpperCase(),
      issue.sceneId || '',
      issue.selector || '',
      sample,
      issue.message.replace(/^\[[\d.]+s\]\s*/, ''),
    ].join('\0');
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(issue);
  }
  return deduped;
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
  const record = isRecord(value) ? value : {};
  const canvas = isRecord(record.canvas) ? record.canvas : {};
  return {
    width: numberFrom(canvas.width),
    height: numberFrom(canvas.height),
    duration: numberFrom(
      canvas.duration
      ?? canvas.duration_sec
      ?? canvas.duration_seconds
      ?? canvas.duration_s
      ?? record.duration
      ?? record.duration_sec
      ?? record.duration_seconds
      ?? record.duration_s
      ?? record.narration_total_duration_s,
    ),
    fps: numberFrom(canvas.fps ?? record.fps),
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
  if (isRecord(value.scenes)) {
    return Object.entries(value.scenes)
      .filter(([, scene]) => isRecord(scene))
      .map(([id, scene]) => ({
        ...(scene as Record<string, unknown>),
        ...((scene as Record<string, unknown>).id ? {} : { id }),
      }));
  }
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

function hueFromHex(hex: string): number | null {
  const clean = hex.replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(clean)) return null;
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d < 0.08) return null;
  let h = 0;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

function extractHexColors(value: unknown): string[] {
  const found = new Set<string>();
  const visit = (item: unknown) => {
    if (typeof item === 'string') {
      const matches = item.match(/#[0-9a-f]{6}\b/gi);
      if (matches) {
        for (const color of matches) found.add(color.toLowerCase());
      }
      return;
    }
    if (Array.isArray(item)) {
      item.slice(0, 48).forEach(visit);
      return;
    }
    if (isRecord(item)) {
      Object.values(item).slice(0, 96).forEach(visit);
    }
  };
  visit(value);
  return [...found];
}

function circularHueSpread(hues: number[]): number {
  if (hues.length <= 1) return 0;
  const sorted = [...hues].sort((a, b) => a - b);
  let largestGap = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    const current = sorted[i];
    const next = sorted[(i + 1) % sorted.length] + (i === sorted.length - 1 ? 360 : 0);
    largestGap = Math.max(largestGap, next - current);
  }
  return 360 - largestGap;
}

function sceneLayoutKey(scene: Record<string, unknown>): string {
  return String(
    scene.layout_type
    || scene.layout
    || scene.visual_layout
    || scene.scene_type
    || scene.kind
    || '',
  ).trim().toLowerCase();
}

function addDesignContractAdvisories(
  issues: Issue[],
  contract: unknown,
  sceneMap: unknown,
  sourceSelector = 'composition-manifest.json#art_direction',
): void {
  if (!isRecord(contract)) return;

  const missingSections = DESIGN_CONTRACT_SECTIONS.filter((key) => !hasContent(contract[key]));
  if (missingSections.length) {
    const code = 'DESIGN_CONTRACT_BUDGET_INCOMPLETE';
    const missingPreviewRequiredSections = missingSections.filter((key) => PREVIEW_REQUIRED_DESIGN_SECTIONS.has(key));
    issues.push({
      code,
      severity: designSeverity(code, missingPreviewRequiredSections.length > 0),
      selector: sourceSelector,
      message: `Design contract is missing low-cost aesthetic budget fields: ${missingSections.join(', ')}.`,
      fixHint: 'Add compact aesthetic, layout, type, color, motion, and scene-variation budgets before writing HTML.',
      source: 'orkas-native-design-contract',
    });
  }

  const aesthetic = isRecord(contract.aesthetic) ? contract.aesthetic : {};
  const aestheticForChecks: Record<string, unknown> = {
    ...aesthetic,
    // frontend-design originally documented anti_template_check, while some
    // manifests used the shorter anti_template key. Treat them as aliases so a
    // real anti-template thesis is not reported missing just because the field
    // name drifted between skill text and native QA.
    anti_template_check: hasContent(aesthetic.anti_template_check)
      ? aesthetic.anti_template_check
      : aesthetic.anti_template,
  };
  const missingAesthetic = AESTHETIC_FIELDS.filter((key) => !hasContent(aestheticForChecks[key]));
  if (missingAesthetic.length) {
    const code = 'AESTHETIC_THESIS_INCOMPLETE';
    issues.push({
      code,
      severity: designSeverity(code),
      selector: `${sourceSelector}.aesthetic`,
      message: `Aesthetic thesis is too thin for distinctive HTML generation: ${missingAesthetic.join(', ')} missing.`,
      fixHint: 'Name the subject-specific visual world, signature device, risk, and rejected generic move.',
      source: 'orkas-native-design-contract',
    });
  }

  const aestheticText = textFrom(aesthetic);
  if (aestheticText && GENERIC_AESTHETIC_RE.test(aestheticText) && !hasContent(aesthetic.signature_device)) {
    const code = 'GENERIC_AESTHETIC_THESIS';
    issues.push({
      code,
      severity: designSeverity(code),
      selector: `${sourceSelector}.aesthetic`,
      message: 'Aesthetic thesis uses generic style language without a concrete signature device.',
      fixHint: 'Replace generic descriptors with a visual behavior that belongs to this brief.',
      source: 'orkas-native-design-contract',
    });
  }

  const visualDirection = isRecord(contract.visual_direction) ? contract.visual_direction : {};
  const missingVisualDirection = VISUAL_DIRECTION_FIELDS.filter((key) => !hasContent(visualDirection[key]));
  if (hasContent(contract.visual_direction) && missingVisualDirection.length) {
    const code = 'VISUAL_DIRECTION_INCOMPLETE';
    issues.push({
      code,
      severity: designSeverity(code),
      selector: `${sourceSelector}.visual_direction`,
      message: `Visual direction is missing HyperFrames-style pre-authoring fields: ${missingVisualDirection.join(', ')}.`,
      fixHint: 'Name the design tradition, rejected lazy defaults, video-scale rule, depth-layer rule, motion-verb rule, and rhythm pattern before HTML authoring.',
      source: 'orkas-native-design-contract',
    });
  }

  const typography = isRecord(contract.typography_tokens) ? contract.typography_tokens : {};
  const typographyText = textFrom(typography).toLowerCase();
  const missingRoles = ['title', 'body', 'label'].filter((role) => !typographyText.includes(role) && !hasContent(typography[role]));
  if (hasContent(contract.typography_tokens) && missingRoles.length) {
    issues.push({
      code: 'TYPOGRAPHY_ROLES_THIN',
      severity: 'warning',
      selector: `${sourceSelector}.typography_tokens`,
      message: `Typography tokens do not clearly name readable video roles: ${missingRoles.join(', ')}.`,
      fixHint: 'Use role-based type tokens with video-size floors, not only font names or mood words.',
      source: 'orkas-native-design-contract',
    });
  }

  const scenes = extractScenes(contract).length ? extractScenes(contract) : extractScenes(sceneMap);
  const scenesMissingDepth = scenes.filter((scene) => !hasContent(scene.depth_layers)).slice(0, 4);
  if (scenes.length && scenesMissingDepth.length) {
    const code = 'SCENE_DEPTH_LAYERS_MISSING';
    issues.push({
      code,
      severity: designSeverity(code),
      selector: `${sourceSelector}.scenes`,
      message: `Scene art direction is missing background/midground/foreground depth layers for ${scenesMissingDepth.map(sceneLabel).join(', ')}.`,
      fixHint: 'Give each non-trivial scene a topic-derived background field, dominant midground hero, and foreground accent/metadata layer.',
      source: 'orkas-native-design-contract',
    });
  }

  const scenesMissingMotionVerbs = scenes
    .filter((scene) => !hasContent(scene.motion_verbs) && !hasContent(scene.motion_choreography))
    .slice(0, 4);
  if (scenes.length && scenesMissingMotionVerbs.length) {
    const code = 'SCENE_MOTION_VERBS_MISSING';
    issues.push({
      code,
      severity: designSeverity(code),
      selector: `${sourceSelector}.scenes`,
      message: `Scene art direction is missing motion verbs/choreography for ${scenesMissingMotionVerbs.map(sceneLabel).join(', ')}.`,
      fixHint: 'Assign concrete verbs such as draw, lock, drift, slam, count up, or reveal to primary scene elements before writing GSAP.',
      source: 'orkas-native-design-contract',
    });
  }

  let repeatedLayoutRun = 1;
  let previousLayout = '';
  for (const scene of scenes) {
    const key = sceneLayoutKey(scene);
    if (key && key === previousLayout) repeatedLayoutRun += 1;
    else repeatedLayoutRun = 1;
    previousLayout = key;
    if (key && repeatedLayoutRun >= 3) {
      const code = 'SCENE_VARIATION_LOW';
      issues.push({
        code,
        severity: designSeverity(code),
        selector: `${sourceSelector}.scenes`,
        message: `Three or more consecutive scenes use the same layout grammar "${key}".`,
        fixHint: 'Vary at least one of framing, focal zone, diagram grammar, or transition family.',
        source: 'orkas-native-design-contract',
      });
      break;
    }
  }

  const hues = extractHexColors(contract.color_tokens).map(hueFromHex).filter((hue): hue is number => hue !== null);
  if (hues.length >= 3 && circularHueSpread(hues) < 28) {
    issues.push({
      code: 'ONE_NOTE_PALETTE',
      severity: 'warning',
      selector: `${sourceSelector}.color_tokens`,
      message: 'Color tokens appear to come from a single narrow hue family.',
      fixHint: 'Keep brand colors, but add purposeful neutral/supporting accents for hierarchy, data meaning, or scene variation.',
      source: 'orkas-native-design-contract',
    });
  }
}

function sceneLabel(scene: Record<string, unknown>, index: number): string {
  return shortText(scene.id || scene.title || scene.headline || scene.name || `scene-${index + 1}`, 80);
}

function sceneId(scene: Record<string, unknown>): string {
  return String(scene.id || scene.scene_id || scene.sceneId || '').trim();
}

function semanticHookSummary(html: string, scenes: Array<Record<string, unknown>>): Record<string, unknown> {
  const structure = parseHtmlStructure(html);
  const sceneHooks = structure.tags
    .map((tag) => String(tag.attrs['data-scene-id'] || '').trim())
    .filter(Boolean);
  const roleHooks = structure.tags
    .map((tag) => String(tag.attrs['data-role'] || '').trim())
    .filter(Boolean);
  const expectedIds = scenes.map(sceneId).filter(Boolean);
  const uniqueSceneHooks = [...new Set(sceneHooks)];
  const matchedIds = expectedIds.filter((id) => uniqueSceneHooks.includes(id));
  const duplicateIds = uniqueSceneHooks.filter((id) => sceneHooks.filter((hook) => hook === id).length > 1);
  return {
    expected_scene_count: expectedIds.length,
    scene_hook_count: sceneHooks.length,
    unique_scene_hook_count: uniqueSceneHooks.length,
    matched_scene_count: matchedIds.length,
    missing_scene_ids: expectedIds.filter((id) => !uniqueSceneHooks.includes(id)),
    duplicate_scene_ids: duplicateIds,
    role_hook_count: roleHooks.length,
    roles: [...new Set(roleHooks)].slice(0, 24),
    coverage: expectedIds.length ? round2(matchedIds.length / expectedIds.length) : (sceneHooks.length ? 1 : 0),
  };
}

function sceneVisibilitySummary(html: string, scenes: Array<Record<string, unknown>>): Record<string, unknown> {
  const structure = parseHtmlStructure(html);
  const expectedIds = new Set(scenes.map(sceneId).filter(Boolean));
  const hiddenSceneIds = structure.tags
    .filter((tag) => expectedIds.has(String(tag.attrs['data-scene-id'] || '').trim()))
    .filter((tag) => /(?:^|;)\s*display\s*:\s*none\s*(?:;|$)/i.test(String(tag.attrs.style || '')))
    .map((tag) => String(tag.attrs['data-scene-id'] || '').trim());
  const scriptText = structure.tags
    .filter((tag) => tag.tagName === 'script' && tag.rawText)
    .map((tag) => tag.rawText)
    .join('\n');
  // Accept the common deterministic activation forms. Opacity/autoAlpha
  // alone cannot revive an element whose inline style is display:none.
  const hasDisplayActivation = /\bdisplay\s*:\s*["'`]?(?:block|flex|grid|inline|inline-block)["'`]?/i.test(scriptText)
    || /\.style\.display\s*=\s*["'`](?:block|flex|grid|inline|inline-block)["'`]/i.test(scriptText)
    || /removeProperty\s*\(\s*["'`]display["'`]\s*\)/i.test(scriptText);
  return {
    hidden_scene_ids: [...new Set(hiddenSceneIds)],
    hidden_scene_count: new Set(hiddenSceneIds).size,
    display_activation_detected: hasDisplayActivation,
  };
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
    for (const key of ['approved_copy', 'headline', 'title', 'subtitle', 'body', 'copy', 'caption', 'label', 'text']) {
      if (scene[key]) visit(scene[key], key);
    }
  }
  return [...new Set(out)].slice(0, 8);
}

function htmlUsesGsap(html: string): boolean {
  const structure = parseHtmlStructure(html);
  return structure.tags.some((tag) => tag.tagName === 'script' && /\bgsap\s*\./.test(tag.rawText || ''));
}

function htmlHasLocalGsapVendorScript(html: string): boolean {
  const structure = parseHtmlStructure(html);
  return structure.tags.some((tag) => tag.tagName === 'script'
    && String(tag.attrs.src || '').replace(/^\.\//, '') === 'assets/vendor/gsap.min.js');
}

function htmlHasRegisteredGsapTimeline(html: string): boolean {
  const scripts = parseHtmlStructure(html).tags
    .filter((tag) => tag.tagName === 'script' && !tag.attrs.src)
    .map((tag) => tag.rawText || '')
    .join('\n');
  return /(?:window\.)?__timelines\s*\[[^\]]+\]\s*=/.test(scripts)
    || /(?:window\.)?__timelines\.[A-Za-z_$][\w$]*\s*=/.test(scripts);
}

function htmlHasPausedGsapTimeline(html: string): boolean {
  const scripts = parseHtmlStructure(html).tags
    .filter((tag) => tag.tagName === 'script' && !tag.attrs.src)
    .map((tag) => tag.rawText || '')
    .join('\n');
  return /\bgsap\s*\.\s*timeline\s*\(\s*\{[^}]*\bpaused\s*:\s*true\b/i.test(scripts);
}

function htmlImperativeMediaControl(html: string): string[] {
  const scripts = parseHtmlStructure(html).tags
    .filter((tag) => tag.tagName === 'script' && !tag.attrs.src)
    .map((tag) => tag.rawText || '')
    .join('\n');
  const found: string[] = [];
  if (/\bnew\s+Audio\s*\(/i.test(scripts) || /createElement\s*\(\s*['"]audio['"]\s*\)/i.test(scripts)) found.push('imperative audio construction');
  if (/\.\s*(?:play|pause)\s*\(/i.test(scripts)) found.push('play/pause call');
  if (/\.\s*currentTime\s*=/i.test(scripts)) found.push('currentTime assignment');
  return [...new Set(found)];
}

function htmlUsesSeekUnsafeTimelineCallback(html: string): boolean {
  const scripts = parseHtmlStructure(html).tags
    .filter((tag) => tag.tagName === 'script' && !tag.attrs.src)
    .map((tag) => tag.rawText || '')
    .join('\n');
  return /\.\s*(?:call|add)\s*\(\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/i.test(scripts);
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
  return numberFrom(scene.start ?? scene.start_sec ?? scene.start_s);
}

function sceneDurationSec(scene: Record<string, unknown>): number {
  const duration = numberFrom(scene.duration ?? scene.duration_sec ?? scene.duration_s);
  if (duration > 0) return duration;
  const start = sceneStartSec(scene);
  const end = numberFrom(scene.end ?? scene.end_sec ?? scene.end_s);
  return end > start ? end - start : 0;
}

function sceneEndSec(scene: Record<string, unknown>): number {
  const start = sceneStartSec(scene);
  const duration = sceneDurationSec(scene);
  if (duration > 0) return start + duration;
  return numberFrom(scene.end ?? scene.end_sec ?? scene.end_s);
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
  const contractSelector = path.basename(contractLoad.path) || 'composition-manifest.json';
  const timelineSelector = path.basename(sceneMapLoad.path) || contractSelector;

  if (!contractLoad.exists) {
    issues.push({
      code: 'DESIGN_CONTRACT_MISSING',
      severity: 'error',
      selector: contractSelector,
      message: 'A validated composition contract is required before drafting model-authored HTML.',
      source: 'orkas-native-contract-html',
    });
  } else if (contractLoad.error || !isRecord(contract)) {
    issues.push({
      code: 'DESIGN_CONTRACT_PARSE_FAILED',
      severity: 'error',
      selector: contractSelector,
      message: `Could not parse ${contractSelector}: ${contractLoad.error || 'not a JSON object'}`,
      source: 'orkas-native-contract-html',
    });
  }
  if (sceneMapLoad.exists && (sceneMapLoad.error || !isRecord(sceneMap))) {
    issues.push({
      code: 'SCENE_MAP_PARSE_FAILED',
      severity: 'error',
      selector: timelineSelector,
      message: `Could not parse ${timelineSelector}: ${sceneMapLoad.error || 'not a JSON object'}`,
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
  if (htmlUsesGsap(meta.html) && !htmlHasRegisteredGsapTimeline(meta.html)) {
    issues.push({
      code: 'GSAP_TIMELINE_NOT_REGISTERED',
      severity: 'error',
      selector: 'index.html',
      message: 'GSAP is used but no timeline is registered on window.__timelines[compositionId], so deterministic frame seeking would repeat or freeze frames.',
      fixHint: 'Create one paused gsap.timeline and assign it to window.__timelines using the exact data-composition-id.',
      source: 'orkas-native-contract-html',
    });
  }
  if (htmlUsesGsap(meta.html) && !htmlHasPausedGsapTimeline(meta.html)) {
    issues.push({
      code: 'GSAP_TIMELINE_NOT_PAUSED',
      severity: 'error',
      selector: 'index.html',
      message: 'GSAP timeline creation must include paused:true so the renderer, not wall-clock time, controls every frame.',
      fixHint: 'Use gsap.timeline({ paused: true }) and position tweens with explicit timeline times.',
      source: 'orkas-native-contract-html',
    });
  }
  const imperativeMedia = htmlImperativeMediaControl(meta.html);
  if (imperativeMedia.length) {
    issues.push({
      code: 'IMPERATIVE_MEDIA_CONTROL',
      severity: 'error',
      selector: 'index.html',
      message: `Composition scripts use renderer-owned media operations: ${imperativeMedia.join(', ')}.`,
      fixHint: 'Declare audio/video with data-start/data-duration/data-track-index; the renderer owns play, pause, and seeking.',
      source: 'orkas-native-contract-html',
    });
  }
  if (htmlUsesGsap(meta.html) && htmlUsesSeekUnsafeTimelineCallback(meta.html)) {
    issues.push({
      code: 'GSAP_CALLBACK_NOT_SEEKABLE',
      severity: 'error',
      selector: 'index.html',
      message: 'GSAP timeline callbacks such as tl.call() or function-valued tl.add() are not deterministic under frame seeking.',
      fixHint: 'Replace callback-driven scene switching with positioned set/to/fromTo opacity or autoAlpha tweens.',
      source: 'orkas-native-contract-html',
    });
  }
  addDesignContractAdvisories(
    issues,
    contract,
    sceneMap,
    contractSelector === 'composition-manifest.json' ? 'composition-manifest.json#art_direction' : contractSelector,
  );

  const contractCanvas = jsonCanvas(contract);
  const sceneMapCanvas = jsonCanvas(sceneMap);
  for (const key of ['width', 'height', 'duration'] as const) {
    const tolerance = key === 'duration' ? 0.15 : 1;
    if (contractCanvas[key] && sceneMapCanvas[key] && Math.abs(contractCanvas[key] - sceneMapCanvas[key]) > tolerance) {
      issues.push({
        code: 'CONTRACT_SCENE_MAP_CANVAS_MISMATCH',
        severity: 'error',
        selector: contractSelector,
        message: `Composition contract sources disagree on ${key}: ${contractCanvas[key]} vs ${sceneMapCanvas[key]}.`,
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
        message: `index.html root ${key}=${rootCanvas[key]} but the canonical composition contract expects ${expected[key]}.`,
        source: 'orkas-native-contract-html',
      });
    }
  }

  const scenes = extractScenes(sceneMap).length ? extractScenes(sceneMap) : extractScenes(contract);
  const semanticHooks = semanticHookSummary(meta.html, scenes);
  const sceneVisibility = sceneVisibilitySummary(meta.html, scenes);
  const missingSceneIds = Array.isArray(semanticHooks.missing_scene_ids) ? semanticHooks.missing_scene_ids as string[] : [];
  const duplicateSceneIds = Array.isArray(semanticHooks.duplicate_scene_ids) ? semanticHooks.duplicate_scene_ids as string[] : [];
  if (missingSceneIds.length) {
    issues.push({
      code: 'SEMANTIC_SCENE_HOOKS_MISSING',
      severity: 'error',
      selector: 'index.html',
      message: `HTML is missing data-scene-id hooks for: ${missingSceneIds.slice(0, 8).join(', ')}.`,
      fixHint: 'Put data-scene-id on each scene root so preview and design QA can report scene-specific findings.',
      source: 'orkas-native-contract-html',
    });
  }
  if (duplicateSceneIds.length) {
    issues.push({
      code: 'SEMANTIC_SCENE_HOOKS_DUPLICATE',
      severity: 'error',
      selector: 'index.html',
      message: `data-scene-id should identify one scene root; duplicate ids: ${duplicateSceneIds.slice(0, 8).join(', ')}.`,
      source: 'orkas-native-contract-html',
    });
  }
  if (scenes.length && Number(semanticHooks.role_hook_count || 0) === 0) {
    issues.push({
      code: 'SEMANTIC_ROLE_HOOKS_MISSING',
      severity: 'error',
      selector: 'index.html',
      message: 'HTML has no data-role hooks for title, body, label, focal visual, or supporting visual elements.',
      fixHint: 'Add compact data-role markers to important elements; they improve scene-specific QA without changing layout.',
      source: 'orkas-native-contract-html',
    });
  }
  const matchedSceneCount = Number(semanticHooks.matched_scene_count || 0);
  const hiddenSceneCount = Number(sceneVisibility.hidden_scene_count || 0);
  if (matchedSceneCount > 0
      && hiddenSceneCount >= matchedSceneCount
      && sceneVisibility.display_activation_detected !== true) {
    issues.push({
      code: 'SCENE_ROOTS_NEVER_DISPLAYED',
      severity: 'error',
      selector: 'index.html',
      message: 'Every semantic scene root starts with display:none, but no script activates display. Opacity animation alone would render blank frames.',
      fixHint: 'Set each active scene root to display:block/flex/grid before animating opacity, or avoid display:none on timeline-driven scene roots.',
      source: 'orkas-native-contract-html',
    });
  }
  const duration = expected.duration || meta.durationSec;
  let prevEnd = -1;
  scenes.forEach((scene, index) => {
    const start = sceneStartSec(scene);
    const sceneDuration = sceneDurationSec(scene);
    if (sceneDuration <= 0) {
      issues.push({
        code: 'SCENE_TIMING_INVALID',
        severity: 'error',
        selector: sceneMapLoad.exists ? timelineSelector : contractSelector,
        message: `Scene "${sceneLabel(scene, index)}" needs numeric start plus positive duration or end.`,
        source: 'orkas-native-contract-html',
      });
      return;
    }
    if (start + sceneDuration > duration + 0.15) {
      issues.push({
        code: 'SCENE_TIMING_OUT_OF_RANGE',
        severity: 'error',
        selector: sceneMapLoad.exists ? timelineSelector : contractSelector,
        message: `Scene "${sceneLabel(scene, index)}" ends beyond the composition duration.`,
        source: 'orkas-native-contract-html',
      });
    }
    if (prevEnd >= 0 && start < prevEnd - 0.15) {
      issues.push({
        code: 'SCENE_TIMING_OVERLAP',
        severity: 'error',
        selector: sceneMapLoad.exists ? timelineSelector : contractSelector,
        message: `Scene "${sceneLabel(scene, index)}" starts before the prior scene ends.`,
        source: 'orkas-native-contract-html',
      });
    }
    prevEnd = Math.max(prevEnd, start + sceneDuration);
  });

  const htmlSearch = normalizeForSearch(parseHtmlStructure(meta.html).textContent);
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
    ...(contractLoad.path === sceneMapLoad.path ? { manifest_path: contractLoad.path } : {}),
    semantic_hooks: semanticHooks,
    scene_visibility: sceneVisibility,
    issues,
  };
}

export async function runSourceAlignmentQa(sceneMapLoad: JsonLoad, shotlistLoad: JsonLoad): Promise<Record<string, unknown>> {
  const issues: Issue[] = [];
  const timelineSelector = path.basename(sceneMapLoad.path) || 'composition-manifest.json';
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
      selector: timelineSelector,
      message: `shotlist.json exists, but ${timelineSelector} has no scenes to map approved beats.`,
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
  const shotIds = new Set(shots.map((shot) => String(shot.id || shot.shot_id || shot.scene_id || '').trim()).filter(Boolean));
  const unknownShotRefs = [...mappedShotCount].filter((ref) => shotIds.size > 0 && !shotIds.has(ref));
  if (shotIds.size > 0 && mappedShotCount.size === 0) {
    issues.push({
      code: 'SOURCE_SHOT_MAPPING_EMPTY',
      severity: 'error',
      selector: timelineSelector,
      message: 'The approved shotlist has shot ids, but every manifest scene has an empty source_shots mapping.',
      source: 'orkas-native-source-alignment',
    });
  }
  if (unknownShotRefs.length) {
    issues.push({
      code: 'SOURCE_SHOT_REFERENCE_UNKNOWN',
      severity: 'error',
      selector: timelineSelector,
      message: `Manifest source_shots reference unknown approved shot ids: ${unknownShotRefs.slice(0, 8).join(', ')}.`,
      source: 'orkas-native-source-alignment',
    });
  }
  if (shots.length > scenes.length && !mergeReason && mappedShotCount.size < shots.length) {
    issues.push({
      code: 'SHOTLIST_SCENE_MAP_MISMATCH',
      severity: 'error',
      selector: timelineSelector,
      message: `shotlist has ${shots.length} shots but the canonical manifest has ${scenes.length} scenes. Add source_alignment.merge_reason or per-scene source_shots when intentionally merging beats.`,
      source: 'orkas-native-source-alignment',
    });
  }
  const missingShotIds = [...shotIds].filter((id) => !mappedShotCount.has(id));
  if (missingShotIds.length > 0 && !mergeReason) {
    issues.push({
      code: 'SOURCE_SHOT_COVERAGE_INCOMPLETE',
      severity: 'error',
      selector: timelineSelector,
      message: `Approved shot ids are not represented by source_shots: ${missingShotIds.slice(0, 8).join(', ')}. Map them or declare source_alignment.merge_reason.`,
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

export async function runDeliveryRequirementsQa(
  meta: CompositionMeta,
  sceneMapLoad: JsonLoad,
  shotlistLoad: JsonLoad,
  compositionDirAbs: string,
): Promise<Record<string, unknown>> {
  const issues: Issue[] = [];
  if (!shotlistLoad.exists) return { ok: true, skipped: true, reason: 'shotlist_missing', issues };
  const shotlist = isRecord(shotlistLoad.value) ? shotlistLoad.value : {};
  const requiredString = (field: string): string => {
    const value = typeof shotlist[field] === 'string' ? String(shotlist[field]).trim() : '';
    if (!value) issues.push({
      code: 'DELIVERY_REQUIREMENT_MISSING',
      severity: 'error',
      selector: `shotlist.json#${field}`,
      message: `Gate B shotlist must declare ${field}.`,
      source: 'orkas-native-delivery-requirements',
    });
    return value.toLowerCase();
  };
  const audioMode = requiredString('audio_mode');
  const captionMode = requiredString('caption_mode');
  const musicMode = requiredString('music_mode');
  const videoLanguage = requiredString('video_language');
  const targetDuration = Number(shotlist.target_duration_seconds);
  if (!(Number.isFinite(targetDuration) && targetDuration > 0)) {
    issues.push({
      code: 'DELIVERY_TARGET_DURATION_MISSING', severity: 'error', selector: 'shotlist.json#target_duration_seconds',
      message: 'Gate B shotlist must declare a positive target_duration_seconds.', source: 'orkas-native-delivery-requirements',
    });
  } else if (Math.abs(meta.durationSec - targetDuration) > 0.15) {
    issues.push({
      code: 'DELIVERY_TARGET_DURATION_MISMATCH', severity: 'error', selector: 'composition-manifest.json#composition.duration',
      message: `Composition duration ${meta.durationSec}s does not match the approved ${targetDuration}s delivery target.`, source: 'orkas-native-delivery-requirements',
    });
  }
  const sceneMap = isRecord(sceneMapLoad.value) ? sceneMapLoad.value : {};
  const canvas = isRecord(sceneMap.canvas) ? sceneMap.canvas : {};
  const manifestLanguage = String(canvas.language || '').trim().toLowerCase();
  if (videoLanguage && manifestLanguage && videoLanguage !== manifestLanguage) {
    issues.push({
      code: 'DELIVERY_LANGUAGE_MISMATCH', severity: 'error', selector: 'composition-manifest.json#composition.language',
      message: `Composition language ${manifestLanguage} does not match approved video_language ${videoLanguage}.`, source: 'orkas-native-delivery-requirements',
    });
  }
  if (captionMode && !/^(?:none|off|disabled)$/.test(captionMode)) {
    const hasBurnedInCaptions = /data-role\s*=\s*["']caption["']/i.test(meta.html);
    const sidecarCandidates = ['captions.vtt', 'captions.srt', 'subtitles.vtt', 'subtitles.srt'];
    const hasSidecar = (await Promise.all(sidecarCandidates.map((name) => fs.stat(path.join(compositionDirAbs, name)).catch(() => null))))
      .some((stat) => stat?.isFile());
    if (!hasBurnedInCaptions && !hasSidecar) issues.push({
      code: 'DELIVERY_CAPTIONS_MISSING', severity: 'error', selector: 'index.html',
      message: `caption_mode=${captionMode} requires burned-in data-role="caption" elements or a captions sidecar file.`, source: 'orkas-native-delivery-requirements',
    });
  }
  const audio = isRecord(sceneMap.audio) ? sceneMap.audio : {};
  const tracks = Array.isArray(audio.tracks) ? audio.tracks.filter(isRecord) : [];
  if (/^(?:required|yes|on|music)$/.test(musicMode) && !tracks.some((track) => track.kind === 'music')) {
    issues.push({
      code: 'DELIVERY_MUSIC_MISSING', severity: 'error', selector: 'composition-manifest.json#audio.tracks',
      message: 'music_mode requires a declarative music track, but none is present.', source: 'orkas-native-delivery-requirements',
    });
  }
  if (audioMode && /^(?:narration|voice|voiceover|tts)$/.test(audioMode) && !tracks.some((track) => track.kind === 'narration')) {
    issues.push({
      code: 'DELIVERY_NARRATION_MISSING', severity: 'error', selector: 'composition-manifest.json#audio.tracks',
      message: `audio_mode=${audioMode} requires a narration track.`, source: 'orkas-native-delivery-requirements',
    });
  }
  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  return { ok: errorCount === 0, error_count: errorCount, issue_count: issues.length, issues };
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
  const contractSelector = path.basename(contractLoad.path) || 'composition-manifest.json';
  const timelineSelector = path.basename(sceneMapLoad.path) || contractSelector;
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
      selector: meta.audioTracks.length ? narrationPath || contractSelector : 'index.html',
      message: 'The canonical manifest declares composition-owned narration, but the composition has no usable narration audio track.',
      source: 'orkas-native-audio-timing',
    });
  }
  if ((ownsNarration || meta.audioTracks.length > 0) && !sceneMapLoad.exists) {
    issues.push({
      code: 'SCENE_MAP_REQUIRED_FOR_AUDIO_TIMING',
      severity: 'error',
      selector: timelineSelector,
      message: 'Narrated compositions require canonical scene mappings so voiceover-to-visual alignment is auditable.',
      source: 'orkas-native-audio-timing',
    });
  }
  if (sceneMapLoad.exists && sceneMapLoad.error) {
    issues.push({
      code: 'SCENE_MAP_PARSE_FAILED',
      severity: 'error',
      selector: timelineSelector,
      message: `Could not parse ${timelineSelector}: ${sceneMapLoad.error}`,
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
        selector: timelineSelector,
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
          selector: timelineSelector,
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
          selector: timelineSelector,
          message: `Scene "${sceneLabel(scene, scenes.indexOf(scene))}" starts at ${round2(actualStart)}s but narration-map starts at ${round2(expectedStart)}s (${round2(startDrift)}s drift).`,
          source: 'orkas-native-audio-timing',
        });
      }
      if (expectedEnd > actualEnd + 1.25) {
        issues.push({
          code: 'NARRATION_LINE_OVERFLOWS_SCENE',
          severity: 'error',
          selector: timelineSelector,
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
          selector: timelineSelector,
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
      selector: timelineSelector,
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
  const hasManifest = !!(await fs.stat(path.join(compositionDirAbs, 'composition-manifest.json')).catch(() => null));
  const names = hasManifest
    ? ['composition-manifest.json', 'narration-map.json', 'index.html']
    : ['design-contract.json', 'scene-map.json', 'narration-map.json', 'index.html'];
  for (const name of names) {
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

export async function initDraftRepairBudget(
  compositionDirAbs: string,
  authoritativeStatePath?: string,
): Promise<DraftRepairBudget> {
  const auditStatePath = draftRepairStatePath(compositionDirAbs);
  const statePath = authoritativeStatePath ? path.resolve(authoritativeStatePath) : auditStatePath;
  const raw = await readJsonIfExists(statePath);
  // One-time migration: when a private authoritative ledger is introduced,
  // preserve any failures already recorded in the old composition-local
  // audit instead of granting a fresh budget.
  const auditRaw = statePath === auditStatePath ? raw : await readJsonIfExists(auditStatePath);
  let state = normalizeRepairState(raw.exists ? raw.value : auditRaw.value);
  // Content-change reset: the repair budget exists to stop the model from
  // re-failing the SAME composition; it must not permanently brick a
  // composition that has since been edited. When the current source signature
  // differs from the one recorded at the last failure, those failures are stale
  // — start fresh instead of blocking. The per-failure signature was already
  // captured (recordDraftFailure) but never consulted until now; persist the
  // reset so recordDraftFailure, which counts from disk, restarts from zero.
  if (state.status === 'failed' && isRecord(state.last_error)) {
    const recordedSig = typeof state.last_error.content_signature === 'string'
      ? state.last_error.content_signature
      : '';
    if (recordedSig && recordedSig !== await draftContentSignature(compositionDirAbs)) {
      state = normalizeRepairState({ status: 'ok', failed_attempts: 0, history: state.history });
      await writeRepairState(statePath, state);
      if (auditStatePath !== statePath) await writeRepairState(auditStatePath, state);
    }
  }
  const summary = repairBudgetSummary(auditStatePath, state);
  const budget: DraftRepairBudget = {
    compositionDirAbs,
    statePath,
    auditStatePath,
    state,
    summary,
    blocked: state.status === 'failed' && summary.budget_exhausted,
  };
  // Restore a deleted audit mirror from the private ledger, or materialise the
  // private ledger during migration. This write is intentionally best-effort
  // only in the sense that failures still surface to the caller; silently
  // resetting the retry counter would be worse than stopping the draft.
  if (statePath !== auditStatePath && (!raw.exists || !auditRaw.exists)) {
    await writeRepairStateCopies(budget, state);
  }
  return budget;
}

async function writeRepairState(statePath: string, state: DraftRepairState): Promise<void> {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');
}

async function writeRepairStateCopies(repairBudget: DraftRepairBudget, state: DraftRepairState): Promise<void> {
  await writeRepairState(repairBudget.statePath, state);
  if (repairBudget.auditStatePath !== repairBudget.statePath) {
    await writeRepairState(repairBudget.auditStatePath, state);
  }
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
  await writeRepairStateCopies(repairBudget, next);
  repairBudget.state = next;
  repairBudget.summary = repairBudgetSummary(repairBudget.auditStatePath, next);
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
  await writeRepairStateCopies(repairBudget, next);
  repairBudget.state = next;
  repairBudget.summary = repairBudgetSummary(repairBudget.auditStatePath, next);
  repairBudget.blocked = false;
  return repairBudget.summary;
}

export function samplePlanKey(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'sample';
}

export function buildDraftFrameSamplePlan(meta: CompositionMeta, sceneMap: unknown, fps: number): FrameSamplePlan[] {
  const duration = Math.max(0.1, meta.durationSec);
  const scenes = extractScenes(sceneMap);
  const firstId = scenes[0] ? sceneId(scenes[0]) : '';
  const raw: Array<{ label: string; timeSec: number; sceneId?: string }> = [
    { label: 'first-frame', timeSec: 0, ...(firstId ? { sceneId: firstId } : {}) },
  ];
  scenes.forEach((scene, index) => {
    const start = Math.max(0, sceneStartSec(scene));
    const sceneDuration = Math.max(0, sceneDurationSec(scene));
    const id = sceneId(scene) || undefined;
    raw.push({
      label: `${sceneLabel(scene, index)}-mid`,
      timeSec: sceneDuration > 0 ? start + sceneDuration / 2 : start,
      ...(id ? { sceneId: id } : {}),
    });
  });
  const lastId = scenes.length ? sceneId(scenes[scenes.length - 1]) : '';
  raw.push(
    { label: 'quarter', timeSec: duration * 0.25 },
    { label: 'midpoint', timeSec: duration * 0.5 },
    { label: 'three-quarter', timeSec: duration * 0.75 },
    { label: 'payoff-frame', timeSec: Math.max(0, duration - 0.05), ...(lastId ? { sceneId: lastId } : {}) },
  );

  const totalFrames = Math.max(1, Math.ceil(duration * fps));
  const seen = new Set<number>();
  const out: FrameSamplePlan[] = [];
  for (const item of raw) {
    const t = Math.max(0, Math.min(duration - 0.001, item.timeSec));
    const frameIndex = Math.max(0, Math.min(totalFrames - 1, Math.floor(t * fps)));
    if (seen.has(frameIndex)) continue;
    seen.add(frameIndex);
    out.push({ label: samplePlanKey(item.label), timeSec: round2(frameIndex / fps), frameIndex, ...(item.sceneId ? { sceneId: item.sceneId } : {}) });
  }
  return out;
}

export function buildPreviewFrameSamplePlan(meta: CompositionMeta, sceneMap: unknown, fps = 30): FrameSamplePlan[] {
  const duration = Math.max(0.1, meta.durationSec);
  const scenes = extractScenes(sceneMap);
  const firstSceneId = scenes[0] ? sceneId(scenes[0]) : '';
  const raw: Array<{ label: string; timeSec: number; sceneId?: string }> = [{
    label: 'first-frame',
    timeSec: 0,
    ...(firstSceneId ? { sceneId: firstSceneId } : {}),
  }];
  if (scenes.length) {
    for (const [index, scene] of scenes.entries()) {
      const start = Math.max(0, sceneStartSec(scene));
      const sceneDuration = Math.max(0, sceneDurationSec(scene));
      raw.push({
        label: `${sceneLabel(scene, index)}-mid`,
        timeSec: sceneDuration > 0 ? start + sceneDuration / 2 : start,
        ...(sceneId(scene) ? { sceneId: sceneId(scene) } : {}),
      });
    }
  } else {
    raw.push(
      { label: 'quarter', timeSec: duration * 0.25 },
      { label: 'midpoint', timeSec: duration * 0.5 },
      { label: 'three-quarter', timeSec: duration * 0.75 },
    );
  }
  const lastSceneId = scenes.length ? sceneId(scenes[scenes.length - 1]) : '';
  raw.push({
    label: 'payoff-frame',
    timeSec: Math.max(0, duration - 0.05),
    ...(lastSceneId ? { sceneId: lastSceneId } : {}),
  });

  const totalFrames = Math.max(1, Math.ceil(duration * fps));
  const seen = new Set<number>();
  const out: FrameSamplePlan[] = [];
  for (const item of raw) {
    const t = Math.max(0, Math.min(duration - 0.001, item.timeSec));
    const frameIndex = Math.max(0, Math.min(totalFrames - 1, Math.floor(t * fps)));
    if (seen.has(frameIndex)) continue;
    seen.add(frameIndex);
    out.push({ label: samplePlanKey(item.label), timeSec: round2(frameIndex / fps), frameIndex, ...(item.sceneId ? { sceneId: item.sceneId } : {}) });
  }
  return out;
}

/** Layout inspection samples stable per-scene frames. It intentionally avoids
 * global quarter marks and exact scene boundaries, which commonly land inside
 * entrance/exit tweens and create transient false positives. */
export function buildInspectFrameSamplePlan(meta: CompositionMeta, sceneMap: unknown, fps = 30): FrameSamplePlan[] {
  const duration = Math.max(0.1, meta.durationSec);
  const scenes = extractScenes(sceneMap);
  const raw: Array<{ label: string; timeSec: number; sceneId?: string }> = scenes.length
    ? scenes.map((scene, index) => {
      const start = Math.max(0, sceneStartSec(scene));
      const sceneDuration = Math.max(0.1, sceneDurationSec(scene));
      const stableOffset = Math.max(0.05, Math.min(sceneDuration - 0.05, sceneDuration * 0.5));
      const id = sceneId(scene) || undefined;
      return {
        label: `${sceneLabel(scene, index)}-stable`,
        timeSec: start + stableOffset,
        ...(id ? { sceneId: id } : {}),
      };
    })
    : [0.25, 0.5, 0.75].map((ratio) => ({ label: `fallback-${ratio}`, timeSec: duration * ratio }));
  const totalFrames = Math.max(1, Math.ceil(duration * fps));
  const seen = new Set<number>();
  const out: FrameSamplePlan[] = [];
  for (const item of raw) {
    const t = Math.max(0, Math.min(duration - 0.001, item.timeSec));
    const frameIndex = Math.max(0, Math.min(totalFrames - 1, Math.floor(t * fps)));
    if (seen.has(frameIndex)) continue;
    seen.add(frameIndex);
    out.push({
      label: samplePlanKey(item.label),
      timeSec: round2(frameIndex / fps),
      frameIndex,
      ...(item.sceneId ? { sceneId: item.sceneId } : {}),
    });
  }
  return out;
}

function perceptualHash(bitmap: Buffer, width: number, height: number): string {
  const cols = 16;
  const rows = 9;
  const stride = Math.max(1, Math.floor(bitmap.length / Math.max(1, width * height)));
  const values: number[] = [];
  for (let row = 0; row < rows; row += 1) {
    const y = Math.min(height - 1, Math.floor(((row + 0.5) * height) / rows));
    for (let col = 0; col < cols; col += 1) {
      const x = Math.min(width - 1, Math.floor(((col + 0.5) * width) / cols));
      const offset = Math.max(0, (y * width + x) * stride);
      const b = bitmap[offset] ?? 0;
      const g = bitmap[offset + 1] ?? b;
      const r = bitmap[offset + 2] ?? b;
      values.push((0.2126 * r) + (0.7152 * g) + (0.0722 * b));
    }
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  let out = '';
  for (let i = 0; i < values.length; i += 4) {
    let nibble = 0;
    for (let bit = 0; bit < 4; bit += 1) {
      if ((values[i + bit] ?? 0) >= mean) nibble |= 1 << (3 - bit);
    }
    out += nibble.toString(16);
  }
  return out;
}

export function analyzeNativeImage(image: ElectronNativeImage): { hash: string; perceptual_hash: string; brightness: number; contrast: number; width: number; height: number } {
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
    perceptual_hash: perceptualHash(bitmap, size.width, size.height),
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
  const items = await Promise.all(samples.map(async (sample, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const x = gap + col * (thumbW + gap);
    const y = gap + row * (thumbH + 36 + gap);
    // SVGs loaded through <img> cannot fetch external subresources in Chromium.
    // Embed every captured PNG so the contact sheet is a self-contained image.
    const frameBytes = await fs.readFile(sample.path);
    const href = `data:image/png;base64,${frameBytes.toString('base64')}`;
    const label = `${sample.label} @ ${sample.time_seconds}s`.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    return `<image href="${href}" x="${x}" y="${y}" width="${thumbW}" height="${thumbH}" preserveAspectRatio="xMidYMid meet"/><text x="${x}" y="${y + thumbH + 24}" fill="#111" font-family="system-ui, sans-serif" font-size="16">${label}</text>`;
  }));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#fff"/>\n${items.join('\n')}\n</svg>\n`;
  const out = path.join(evidenceDirAbs, 'contact-sheet.svg');
  await fs.writeFile(out, svg, 'utf8');
  return out;
}

export async function writeVisualBaseline(baselineAbsPath: string, frameEvidence: FrameEvidence): Promise<string> {
  const manifest = {
    version: 1,
    sample_count: frameEvidence.samples.length,
    samples: frameEvidence.samples.map((sample) => ({
      label: sample.label,
      time_seconds: sample.time_seconds,
      width: sample.width,
      height: sample.height,
      hash: sample.hash,
      perceptual_hash: sample.perceptual_hash || '',
      brightness: sample.brightness,
      contrast: sample.contrast,
    })),
  };
  await fs.mkdir(path.dirname(baselineAbsPath), { recursive: true });
  await fs.writeFile(baselineAbsPath, JSON.stringify(manifest, null, 2), 'utf8');
  return baselineAbsPath;
}

function hashDifference(a: string, b: string): number | null {
  const left = String(a || '').trim().toLowerCase();
  const right = String(b || '').trim().toLowerCase();
  if (!left || left.length !== right.length || !/^[0-9a-f]+$/.test(left) || !/^[0-9a-f]+$/.test(right)) return null;
  let changedBits = 0;
  for (let i = 0; i < left.length; i += 1) {
    let xor = parseInt(left[i], 16) ^ parseInt(right[i], 16);
    while (xor) {
      changedBits += xor & 1;
      xor >>= 1;
    }
  }
  return round2(changedBits / (left.length * 4));
}

export async function compareVisualBaseline(
  baselineAbsPath: string,
  frameEvidence: FrameEvidence | null,
): Promise<Record<string, unknown>> {
  const issues: Issue[] = [];
  if (!frameEvidence?.samples.length) {
    return { ok: true, skipped: true, status: 'no_samples', baseline_path: baselineAbsPath, changed: false, issues };
  }
  const loaded = await readJsonIfExists(baselineAbsPath);
  if (!loaded.exists) {
    return { ok: true, skipped: true, status: 'baseline_missing', baseline_path: baselineAbsPath, changed: false, issues };
  }
  if (loaded.error || !isRecord(loaded.value) || !Array.isArray(loaded.value.samples)) {
    issues.push({
      code: 'VISUAL_BASELINE_PARSE_FAILED',
      severity: 'warning',
      selector: baselineAbsPath,
      message: `Visual baseline could not be parsed: ${loaded.error || 'samples array missing'}.`,
      source: 'orkas-native-visual-regression',
    });
    return { ok: true, skipped: true, status: 'baseline_invalid', baseline_path: baselineAbsPath, changed: false, issues };
  }

  const baselineSamples = (loaded.value.samples as unknown[]).filter(isRecord);
  const baselineByLabel = new Map(baselineSamples.map((sample) => [String(sample.label || ''), sample]));
  const comparisons: Array<Record<string, unknown>> = [];
  for (const sample of frameEvidence.samples) {
    const baseline = baselineByLabel.get(sample.label);
    if (!baseline) continue;
    const perceptualDelta = hashDifference(sample.perceptual_hash || '', String(baseline.perceptual_hash || ''));
    const brightnessDelta = round2(Math.abs(sample.brightness - numberFrom(baseline.brightness)));
    const contrastDelta = round2(Math.abs(sample.contrast - numberFrom(baseline.contrast)));
    const dimensionsChanged = sample.width !== numberFrom(baseline.width) || sample.height !== numberFrom(baseline.height);
    const changed = dimensionsChanged
      || (perceptualDelta !== null && perceptualDelta > 0.28)
      || brightnessDelta > 24
      || contrastDelta > 18;
    comparisons.push({
      label: sample.label,
      changed,
      perceptual_delta: perceptualDelta,
      brightness_delta: brightnessDelta,
      contrast_delta: contrastDelta,
      dimensions_changed: dimensionsChanged,
    });
  }
  if (!comparisons.length) {
    issues.push({
      code: 'VISUAL_BASELINE_NO_MATCHING_SAMPLES',
      severity: 'warning',
      selector: baselineAbsPath,
      message: 'Visual baseline has no sample labels matching the current preview/draft plan.',
      source: 'orkas-native-visual-regression',
    });
  }
  const changedLabels = comparisons.filter((item) => item.changed === true).map((item) => String(item.label));
  if (changedLabels.length) {
    issues.push({
      code: 'VISUAL_BASELINE_CHANGED',
      severity: 'warning',
      selector: baselineAbsPath,
      message: `Visual baseline changed at: ${changedLabels.slice(0, 8).join(', ')}. Review intentionally; this advisory does not trigger an automatic rerender.`,
      source: 'orkas-native-visual-regression',
    });
  }
  return {
    ok: true,
    skipped: false,
    status: changedLabels.length ? 'changed' : 'pass',
    baseline_path: baselineAbsPath,
    changed: changedLabels.length > 0,
    matched_sample_count: comparisons.length,
    changed_labels: changedLabels,
    comparisons,
    warning_count: issues.length,
    issues,
  };
}

function reviewIssueList(value: unknown, key: string): Issue[] {
  if (!isRecord(value) || !Array.isArray(value[key])) return [];
  return (value[key] as unknown[]).filter(isRecord).map((issue) => ({
    code: String(issue.code || 'UNKNOWN'),
    severity: issue.severity === 'error' || issue.severity === 'info' ? issue.severity : 'warning',
    selector: typeof issue.selector === 'string' ? issue.selector : undefined,
    message: String(issue.message || ''),
    source: typeof issue.source === 'string' ? issue.source : undefined,
  }));
}

export function buildDesignReviewInputs(opts: DesignReviewInputOptions): Record<string, unknown> {
  const contract = isRecord(opts.contractLoad.value) ? opts.contractLoad.value : {};
  const sceneMap = isRecord(opts.sceneMapLoad.value) ? opts.sceneMapLoad.value : {};
  const scenes = extractScenes(sceneMap).length ? extractScenes(sceneMap) : extractScenes(contract);
  const contractIssues = reviewIssueList(opts.contractHtml, 'issues').filter((issue) => issue.severity !== 'info');
  const inspectIssues = reviewIssueList(opts.inspectDisposition, 'advisory_issues');
  const allIssues = [...contractIssues, ...inspectIssues];
  const issueCodes = [...new Set(allIssues.map((issue) => issue.code))];
  const focus: string[] = [];
  if (issueCodes.some((code) => code.includes('CONTRAST'))) focus.push('contrast hierarchy');
  if (issueCodes.some((code) => code.includes('SAFE_AREA') || code.includes('OVERFLOW'))) focus.push('safe-area and text fit');
  if (issueCodes.some((code) => code.includes('SCENE_VARIATION') || code.includes('COMPLEXITY'))) focus.push('scene grammar and visual density');
  if (issueCodes.some((code) => code.includes('PALETTE'))) focus.push('palette hierarchy');
  if (issueCodes.some((code) => code.includes('SEMANTIC'))) focus.push('scene/role QA coverage');
  if ((opts.visualRegression as { changed?: boolean } | null)?.changed) focus.push('intentional baseline changes');

  return {
    version: 1,
    contract_path: opts.contractLoad.path,
    scene_map_path: opts.sceneMapLoad.exists ? opts.sceneMapLoad.path : '',
    aesthetic: contract.aesthetic || null,
    color_tokens: contract.color_tokens || null,
    typography_tokens: contract.typography_tokens || null,
    motion_budget: contract.motion_budget || null,
    scene_variation: contract.scene_variation || null,
    scenes: {
      count: scenes.length,
      ids: scenes.map((scene, index) => sceneId(scene) || sceneLabel(scene, index)).slice(0, 24),
      layout_sequence: scenes.map(sceneLayoutKey).filter(Boolean).slice(0, 24),
    },
    semantic_hooks: isRecord(opts.contractHtml) ? opts.contractHtml.semantic_hooks || null : null,
    preview_assets: {
      contact_sheet: opts.frameEvidence?.contact_sheet || '',
      frame_paths: opts.frameEvidence?.frame_paths || [],
    },
    advisory_count: allIssues.length,
    advisory_codes: issueCodes,
    advisories: allIssues.slice(0, 16),
    review_focus: focus,
    visual_regression: opts.visualRegression || null,
  };
}

export function summarizeVideoFrameQa(
  frameEvidence: FrameEvidence | null,
  durationSec: number,
  opts: { sceneCount?: number; expectedSceneIds?: string[]; requireSemanticCoverage?: boolean; minimumSamples?: number } = {},
): Record<string, unknown> {
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
  const expectedMinimum = opts.minimumSamples
    ?? Math.max(1, Number(opts.sceneCount || 0));
  if (samples.length && samples.length < expectedMinimum) {
    issues.push({
      code: 'VIDEO_SAMPLE_COVERAGE_INSUFFICIENT',
      severity: 'error',
      message: `Captured ${samples.length} distinct evidence frame(s); this composition requires at least ${expectedMinimum}.`,
      source: 'orkas-native-video-qa',
    });
  }
  if (opts.requireSemanticCoverage && opts.expectedSceneIds?.length) {
    const evidenced = new Set(samples.map((sample) => sample.expected_scene_id).filter(Boolean));
    const missingSceneIds = opts.expectedSceneIds.filter((id) => !evidenced.has(id));
    if (missingSceneIds.length) {
      issues.push({
        code: 'VIDEO_SCENE_EVIDENCE_MISSING',
        severity: 'error',
        message: `No semantic evidence frame was captured for scene(s): ${missingSceneIds.slice(0, 12).join(', ')}.`,
        source: 'orkas-native-video-qa',
      });
    }
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
    if (opts.requireSemanticCoverage && sample.expected_scene_id) {
      const visibleSceneIds = sample.visible_scene_ids || [];
      if (!visibleSceneIds.includes(sample.expected_scene_id)) {
        issues.push({
          code: 'EXPECTED_SCENE_NOT_VISIBLE',
          severity: 'error',
          sceneId: sample.expected_scene_id,
          message: `Sample "${sample.label}" at ${sample.time_seconds}s does not show expected scene "${sample.expected_scene_id}".`,
          source: 'orkas-native-video-qa',
        });
      }
    }
    if (opts.requireSemanticCoverage && sample.label === 'first-frame') {
      const roles = sample.visible_roles || [];
      const visibleText = String(sample.visible_text || '').trim();
      if (!roles.includes('title') || !visibleText) {
        issues.push({
          code: 'HOOK_PROMISE_NOT_VISIBLE',
          severity: 'error',
          message: 'The first frame must expose a visible data-role="title" and readable promise text.',
          source: 'orkas-native-video-qa',
        });
      }
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
    expected_minimum_samples: expectedMinimum,
    semantic_coverage_required: opts.requireSemanticCoverage === true,
    issues,
  };
}
