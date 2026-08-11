import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { NativeImage as ElectronNativeImage } from 'electron';

import { hardenedWebPreferences } from '../util/window-security';
import { isPathAllowed } from '../util/path-sandbox';
import {
  extractCssImports,
  extractCssUrls,
  extractHtmlResourceRefs,
  parseHtmlStructure,
} from './video_studio_html_check';
import { analyzeNativeImage } from './video_studio_qa';

export type ImageStudioRoute = 'compose' | 'hybrid' | 'generate' | 'edit';
export type ImageStudioReviewVerdict = 'passed' | 'repair' | 'blocked';
export type ImageStudioReferenceRole = 'style' | 'identity' | 'composition' | 'structure' | 'content' | 'mask' | 'edit_source';
export type ImageStudioReferenceIntentMode = 'reproduce' | 'edit' | 'guide';
export type ImageStudioReferenceIntentBasis = 'user' | 'inferred';
export type ImageStudioRegionDepth = 'background' | 'midground' | 'foreground';
export type ImageStudioRegionRole = 'hero' | 'support' | 'copy' | 'decoration' | 'background';
export type ImageStudioControlType = 'image_prompt' | 'canny' | 'depth' | 'pose' | 'mask';

export interface ImageStudioAdditionalQualityDimension {
  id: string;
  label: string;
  reason: string;
  evidence: string;
  score: number;
}

export interface ImageStudioQualityScorecard {
  intent_alignment: number;
  composition: number;
  craft: number;
  text_legibility: number;
  defect_freedom: number;
  specificity: number;
  reference_fidelity?: number;
  additional_dimensions: ImageStudioAdditionalQualityDimension[];
  overall: number;
  pass_threshold: number;
  dimension_floor: number;
}

export interface ImageStudioReference {
  id: string;
  path: string;
  role: ImageStudioReferenceRole;
  strength: number;
  required: boolean;
  preserve: string[];
  may_change: string[];
  region_ids: string[];
}

export interface ImageStudioReferenceIntent {
  mode: ImageStudioReferenceIntentMode;
  basis: ImageStudioReferenceIntentBasis;
  instructions: string[];
  minimum_score: number;
}

export interface ImageStudioVisualRegion {
  id: string;
  bounds: { x: number; y: number; width: number; height: number };
  depth: ImageStudioRegionDepth;
  role: ImageStudioRegionRole;
  description: string;
  detail_prompts: string[];
  reference_ids: string[];
}

export interface ImageStudioVisualPlan {
  global_description: string;
  reading_order: string[];
  regions: ImageStudioVisualRegion[];
}

export interface ImageStudioGenerationControl {
  type: ImageStudioControlType;
  reference_id: string;
  strength: number;
  start: number;
  end: number;
}

export interface ImageStudioGenerationContract {
  negative_prompt: string[];
  controls: ImageStudioGenerationControl[];
  seed?: number;
}

export interface ImageStudioManifest {
  schema_version: 1;
  route: ImageStudioRoute;
  canvas: { width: number; height: number };
  entry?: string;
  raster_source?: string;
  brief: {
    purpose: string;
    audience: string;
    required_copy: string[];
    must_include: string[];
    must_avoid: string[];
  };
  art_direction: {
    subject_world: string;
    one_job: string;
    visual_tradition: string;
    composition: string;
    signature_device: string;
    typography: string;
    color_light_material: string;
  };
  generation_budget: { max_calls: number };
  references?: ImageStudioReference[];
  reference_intent?: ImageStudioReferenceIntent;
  visual_plan?: ImageStudioVisualPlan;
  generation_contract?: ImageStudioGenerationContract;
}

export interface ImageStudioIssue {
  code: string;
  message: string;
}

export interface ImageStudioRequiredCopyLayout {
  copy: string;
  lineGlyphCounts: number[];
  explicitBreak: boolean;
  writingMode: string;
}

export function requiredCopyLayoutIssues(
  layouts: readonly ImageStudioRequiredCopyLayout[],
): ImageStudioIssue[] {
  return layouts.flatMap((layout) => {
    const lineGlyphCounts = layout.lineGlyphCounts.filter((count) => count > 0);
    const totalGlyphs = lineGlyphCounts.reduce((sum, count) => sum + count, 0);
    const isHorizontal = !layout.writingMode || layout.writingMode.startsWith('horizontal');
    if (
      layout.explicitBreak
      || !isHorizontal
      || totalGlyphs < 4
      || lineGlyphCounts.length < 2
      || !lineGlyphCounts.some((count) => count === 1)
    ) {
      return [];
    }
    return [{
      code: 'E_REQUIRED_COPY_ORPHAN_LINE',
      message: `Required copy wraps with a one-glyph orphan line (${lineGlyphCounts.join('+')}): ${layout.copy}. Widen the text box, reduce the type size, or add an intentional balanced line break.`,
    }];
  });
}

export interface ImageStudioInspection {
  ok: boolean;
  route?: ImageStudioRoute;
  signature?: string;
  evidence_path?: string;
  source_path?: string;
  blockers: ImageStudioIssue[];
  advisories: ImageStudioIssue[];
  resources: string[];
  image?: ReturnType<typeof analyzeNativeImage>;
  manifest?: ImageStudioManifest;
}

export interface ImageStudioEvidenceState {
  schema_version: 1;
  project_dir: string;
  route: ImageStudioRoute;
  signature: string;
  evidence_path: string;
  source_path?: string;
  image_hash: string;
  captured_at: string;
  review?: {
    verdict: ImageStudioReviewVerdict;
    scope: string;
    findings: string[];
    quality_scorecard: ImageStudioQualityScorecard;
    signature: string;
    evidence_path: string;
    reviewed_at: string;
  };
}

const ROUTES = new Set<ImageStudioRoute>(['compose', 'hybrid', 'generate', 'edit']);
const REFERENCE_ROLES = new Set<ImageStudioReferenceRole>(['style', 'identity', 'composition', 'structure', 'content', 'mask', 'edit_source']);
const REFERENCE_INTENT_MODES = new Set<ImageStudioReferenceIntentMode>(['reproduce', 'edit', 'guide']);
const REFERENCE_INTENT_BASES = new Set<ImageStudioReferenceIntentBasis>(['user', 'inferred']);
const REGION_DEPTHS = new Set<ImageStudioRegionDepth>(['background', 'midground', 'foreground']);
const REGION_ROLES = new Set<ImageStudioRegionRole>(['hero', 'support', 'copy', 'decoration', 'background']);
const CONTROL_TYPES = new Set<ImageStudioControlType>(['image_prompt', 'canny', 'depth', 'pose', 'mask']);
const QUALITY_SCORE_KEYS = ['intent_alignment', 'composition', 'craft', 'text_legibility', 'defect_freedom', 'specificity'] as const;
const RESERVED_QUALITY_DIMENSION_IDS = new Set([
  ...QUALITY_SCORE_KEYS,
  'reference_fidelity',
  'overall',
]);
const MAX_ADDITIONAL_QUALITY_DIMENSIONS = 8;
const QUALITY_PASS_THRESHOLD = 80;
const QUALITY_DIMENSION_FLOOR = 70;
const REQUIRED_ART_DIRECTION = [
  'subject_world',
  'one_job',
  'visual_tradition',
  'composition',
  'signature_device',
  'typography',
  'color_light_material',
] as const;
const FORBIDDEN_HTML_TAGS = new Set(['iframe', 'object', 'embed', 'base', 'script']);
const IMAGE_STUDIO_LOAD_TIMEOUT_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && !!value.trim();
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => !nonEmptyString(item))) return null;
  return value.map((item) => String(item).trim());
}

function optionalStringArray(value: unknown): string[] | null {
  return value === undefined ? [] : stringArray(value);
}

function normalizedIdentifier(value: unknown): string | null {
  if (!nonEmptyString(value)) return null;
  const id = value.trim();
  return /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id) ? id : null;
}

function normalizedProjectRelativePath(value: unknown): string | null {
  if (!nonEmptyString(value)) return null;
  const raw = value.trim();
  if (path.isAbsolute(raw) || path.win32.isAbsolute(raw) || externalResourceRef(raw) || /[?#]/.test(raw)) return null;
  const normalized = path.posix.normalize(raw.replace(/\\/g, '/'));
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) return null;
  return normalized;
}

function serializedProjectRelativePath(projectDir: string, absolutePath: string): string {
  return path.relative(projectDir, absolutePath).split(path.sep).join('/');
}

function unitNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : null;
}

function pushIssue(issues: ImageStudioIssue[], code: string, message: string): void {
  issues.push({ code, message });
}

function compileAdditionalQualityDimensions(value: unknown): ImageStudioAdditionalQualityDimension[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error('E_IMAGE_REVIEW_ADDITIONAL_DIMENSIONS_INVALID: additional_dimensions must be an array.');
  }
  if (value.length > MAX_ADDITIONAL_QUALITY_DIMENSIONS) {
    throw new Error(`E_IMAGE_REVIEW_ADDITIONAL_DIMENSIONS_LIMIT: additional_dimensions accepts at most ${MAX_ADDITIONAL_QUALITY_DIMENSIONS} task-specific dimensions.`);
  }
  const seen = new Set<string>();
  return value.map((raw, index) => {
    if (!isRecord(raw)) {
      throw new Error(`E_IMAGE_REVIEW_ADDITIONAL_DIMENSION_INVALID: additional_dimensions[${index}] must be an object.`);
    }
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(id)) {
      throw new Error(`E_IMAGE_REVIEW_ADDITIONAL_DIMENSION_ID: additional_dimensions[${index}].id must be a lowercase snake_case identifier.`);
    }
    if (RESERVED_QUALITY_DIMENSION_IDS.has(id)) {
      throw new Error(`E_IMAGE_REVIEW_ADDITIONAL_DIMENSION_RESERVED: additional_dimensions[${index}].id duplicates a mandatory quality dimension.`);
    }
    if (seen.has(id)) {
      throw new Error(`E_IMAGE_REVIEW_ADDITIONAL_DIMENSION_DUPLICATE: duplicate additional dimension id ${id}.`);
    }
    seen.add(id);
    const label = typeof raw.label === 'string' ? raw.label.trim() : '';
    const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
    const evidence = typeof raw.evidence === 'string' ? raw.evidence.trim() : '';
    if (!label || label.length > 120) {
      throw new Error(`E_IMAGE_REVIEW_ADDITIONAL_DIMENSION_LABEL: additional_dimensions[${index}].label must contain 1 to 120 characters.`);
    }
    if (!reason || reason.length > 500) {
      throw new Error(`E_IMAGE_REVIEW_ADDITIONAL_DIMENSION_REASON: additional_dimensions[${index}].reason must contain 1 to 500 characters.`);
    }
    if (!evidence || evidence.length > 1_000) {
      throw new Error(`E_IMAGE_REVIEW_ADDITIONAL_DIMENSION_EVIDENCE: additional_dimensions[${index}].evidence must contain 1 to 1000 characters.`);
    }
    const score = Number(raw.score);
    if (!Number.isFinite(score) || score < 0 || score > 100) {
      throw new Error(`E_IMAGE_REVIEW_ADDITIONAL_DIMENSION_SCORE: additional_dimensions[${index}].score must be from 0 to 100.`);
    }
    return {
      id,
      label,
      reason,
      evidence,
      score: Math.round(score * 10) / 10,
    };
  });
}

export function compileImageQualityScorecard(
  value: unknown,
  requireReferenceFidelity = false,
  additionalDimensions?: unknown,
): ImageStudioQualityScorecard {
  if (!isRecord(value)) throw new Error('E_IMAGE_REVIEW_SCORES_REQUIRED: quality_scores must be an object.');
  const scores: Record<string, number> = {};
  for (const key of QUALITY_SCORE_KEYS) {
    const score = Number(value[key]);
    if (!Number.isFinite(score) || score < 0 || score > 100) {
      throw new Error(`E_IMAGE_REVIEW_SCORE_INVALID: quality_scores.${key} must be from 0 to 100.`);
    }
    scores[key] = Math.round(score * 10) / 10;
  }
  if (requireReferenceFidelity) {
    const score = Number(value.reference_fidelity);
    if (!Number.isFinite(score) || score < 0 || score > 100) {
      throw new Error('E_IMAGE_REVIEW_SCORE_INVALID: quality_scores.reference_fidelity must be from 0 to 100 when references are present.');
    }
    scores.reference_fidelity = Math.round(score * 10) / 10;
  }
  const compiledAdditionalDimensions = compileAdditionalQualityDimensions(additionalDimensions);
  // Task-specific dimensions are pass/fail gates, not bonus points. Keep the
  // mandatory baseline comparable across reviews and prevent easy extra scores
  // from diluting a weak core result.
  const values = Object.values(scores);
  const overall = Math.round((values.reduce((sum, score) => sum + score, 0) / values.length) * 10) / 10;
  return {
    intent_alignment: scores.intent_alignment,
    composition: scores.composition,
    craft: scores.craft,
    text_legibility: scores.text_legibility,
    defect_freedom: scores.defect_freedom,
    specificity: scores.specificity,
    ...(scores.reference_fidelity !== undefined ? { reference_fidelity: scores.reference_fidelity } : {}),
    additional_dimensions: compiledAdditionalDimensions,
    overall,
    pass_threshold: QUALITY_PASS_THRESHOLD,
    dimension_floor: QUALITY_DIMENSION_FLOOR,
  };
}

export function assertImageQualityVerdict(
  verdict: ImageStudioReviewVerdict,
  findings: string[],
  scorecard: ImageStudioQualityScorecard,
  minimumReferenceFidelity = QUALITY_DIMENSION_FLOOR,
  advisories: ImageStudioIssue[] = [],
): void {
  const scoredDimensions = [
    scorecard.intent_alignment,
    scorecard.composition,
    scorecard.craft,
    scorecard.text_legibility,
    scorecard.defect_freedom,
    scorecard.specificity,
    ...(scorecard.reference_fidelity === undefined ? [] : [scorecard.reference_fidelity]),
    ...scorecard.additional_dimensions.map((dimension) => dimension.score),
  ];
  if (verdict === 'passed' && findings.some((item) => item.trim())) {
    throw new Error('E_IMAGE_REVIEW_PASS_FINDINGS: a passing review cannot retain blocker or fix findings.');
  }
  if (verdict === 'passed' && advisories.some((item) => item.code === 'A_ENGLISH_ALL_CAPS_OVERUSE')) {
    throw new Error('E_IMAGE_REVIEW_ENGLISH_CASING_REQUIRED: restore natural English casing before passing review.');
  }
  if (verdict === 'passed' && (scorecard.overall < QUALITY_PASS_THRESHOLD || scoredDimensions.some((score) => score < QUALITY_DIMENSION_FLOOR))) {
    throw new Error(`E_IMAGE_REVIEW_SCORE_BELOW_FLOOR: passed requires overall >= ${QUALITY_PASS_THRESHOLD} and every dimension >= ${QUALITY_DIMENSION_FLOOR}.`);
  }
  if (verdict === 'passed'
    && scorecard.reference_fidelity !== undefined
    && scorecard.reference_fidelity < minimumReferenceFidelity) {
    throw new Error(`E_IMAGE_REFERENCE_FIDELITY_BELOW_FLOOR: passed requires reference_fidelity >= ${minimumReferenceFidelity} for the declared reference intent.`);
  }
}

function englishAllCapsCandidates(html: string, requiredCopy: string[]): string[] {
  const explicitCopy = requiredCopy
    .map((item) => normalizedVisibleText(item).toUpperCase())
    .filter(Boolean);
  // Preserve element boundaries so separate labels do not collapse into one
  // long phrase when the generic HTML parser joins text nodes with spaces.
  const visibleChunks = html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .split(/<[^>]*>/g)
    .map((chunk) => parseHtmlStructure(chunk).textContent)
    .filter(Boolean);
  const candidates = visibleChunks.flatMap((chunk) => (
    chunk.match(/\b[A-Z][A-Z0-9&+./'-]*(?:\s+[A-Z][A-Z0-9&+./'-]*)*\b/g) || []
  ));
  return Array.from(new Set(candidates
    .map((item) => normalizedVisibleText(item))
    .filter((item) => {
      const words = item.match(/[A-Z]+/g) || [];
      const looksLikeAcronymOnly = words.length === 1 && words[0].length <= 3;
      if (!words.length || looksLikeAcronymOnly) return false;
      const normalized = item.toUpperCase();
      return !explicitCopy.some((copy) => copy.includes(normalized));
    })));
}

export function validateImageStudioManifest(value: unknown): {
  manifest?: ImageStudioManifest;
  issues: ImageStudioIssue[];
} {
  const issues: ImageStudioIssue[] = [];
  if (!isRecord(value)) return { issues: [{ code: 'E_MANIFEST_OBJECT_REQUIRED', message: 'image-manifest.json must contain an object.' }] };
  if (value.schema_version !== 1) pushIssue(issues, 'E_MANIFEST_SCHEMA_VERSION', 'schema_version must be 1.');

  const route = typeof value.route === 'string' ? value.route.toLowerCase() as ImageStudioRoute : undefined;
  if (!route || !ROUTES.has(route)) pushIssue(issues, 'E_MANIFEST_ROUTE', 'route must be compose, hybrid, generate, or edit.');

  const canvas = isRecord(value.canvas) ? value.canvas : {};
  const width = Number(canvas.width);
  const height = Number(canvas.height);
  if (!Number.isInteger(width) || width < 128 || width > 4096) {
    pushIssue(issues, 'E_MANIFEST_CANVAS_WIDTH', 'canvas.width must be an integer from 128 to 4096.');
  }
  if (!Number.isInteger(height) || height < 128 || height > 4096) {
    pushIssue(issues, 'E_MANIFEST_CANVAS_HEIGHT', 'canvas.height must be an integer from 128 to 4096.');
  }
  if (Number.isFinite(width) && Number.isFinite(height) && width * height > 16_777_216) {
    pushIssue(issues, 'E_MANIFEST_CANVAS_AREA', 'canvas area must not exceed 16,777,216 pixels.');
  }

  const brief = isRecord(value.brief) ? value.brief : {};
  if (!nonEmptyString(brief.purpose)) pushIssue(issues, 'E_MANIFEST_PURPOSE', 'brief.purpose is required.');
  if (!nonEmptyString(brief.audience)) pushIssue(issues, 'E_MANIFEST_AUDIENCE', 'brief.audience is required.');
  const requiredCopy = stringArray(brief.required_copy);
  const mustInclude = stringArray(brief.must_include);
  const mustAvoid = stringArray(brief.must_avoid);
  if (!requiredCopy) pushIssue(issues, 'E_MANIFEST_REQUIRED_COPY', 'brief.required_copy must be a string array.');
  if (!mustInclude) pushIssue(issues, 'E_MANIFEST_MUST_INCLUDE', 'brief.must_include must be a string array.');
  if (!mustAvoid) pushIssue(issues, 'E_MANIFEST_MUST_AVOID', 'brief.must_avoid must be a string array.');

  const direction = isRecord(value.art_direction) ? value.art_direction : {};
  for (const key of REQUIRED_ART_DIRECTION) {
    if (!nonEmptyString(direction[key])) {
      pushIssue(issues, 'E_MANIFEST_ART_DIRECTION', `art_direction.${key} is required.`);
    }
  }

  const budget = isRecord(value.generation_budget) ? value.generation_budget : {};
  const maxCalls = Number(budget.max_calls);
  if (!Number.isInteger(maxCalls) || maxCalls < 0 || maxCalls > 2) {
    pushIssue(issues, 'E_MANIFEST_GENERATION_BUDGET', 'generation_budget.max_calls must be an integer from 0 to 2.');
  } else if (route === 'compose' && maxCalls !== 0) {
    pushIssue(issues, 'E_COMPOSE_GENERATION_BUDGET', 'COMPOSE requires generation_budget.max_calls=0.');
  } else if (route === 'hybrid' && maxCalls > 1) {
    pushIssue(issues, 'E_HYBRID_GENERATION_BUDGET', 'HYBRID supports at most one image-generation call.');
  } else if ((route === 'generate' || route === 'edit') && maxCalls < 1) {
    pushIssue(issues, 'E_GENERATE_GENERATION_BUDGET', 'GENERATE and EDIT require a generation budget of at least one call.');
  }

  const entry = value.entry === undefined ? undefined : String(value.entry).trim();
  const rasterSource = value.raster_source === undefined ? undefined : String(value.raster_source).trim();
  if (entry !== undefined && !entry) pushIssue(issues, 'E_MANIFEST_ENTRY', 'entry must be a non-empty relative path when present.');
  if (rasterSource !== undefined && !rasterSource) pushIssue(issues, 'E_MANIFEST_RASTER_SOURCE', 'raster_source must be a non-empty relative path when present.');

  const references: ImageStudioReference[] = [];
  const referenceIds = new Set<string>();
  if (value.references !== undefined && !Array.isArray(value.references)) {
    pushIssue(issues, 'E_MANIFEST_REFERENCES', 'references must be an array when present.');
  } else {
    const rawReferences: unknown[] = Array.isArray(value.references) ? value.references : [];
    for (const [index, raw] of rawReferences.entries()) {
      if (!isRecord(raw)) {
        pushIssue(issues, 'E_MANIFEST_REFERENCE', `references[${index}] must be an object.`);
        continue;
      }
      const id = normalizedIdentifier(raw.id);
      const refPath = normalizedProjectRelativePath(raw.path);
      const role = typeof raw.role === 'string' ? raw.role as ImageStudioReferenceRole : undefined;
      const strength = unitNumber(raw.strength === undefined ? 1 : raw.strength);
      const preserve = optionalStringArray(raw.preserve);
      const mayChange = optionalStringArray(raw.may_change);
      const regionIds = optionalStringArray(raw.region_ids);
      if (!id) pushIssue(issues, 'E_MANIFEST_REFERENCE_ID', `references[${index}].id must be a safe identifier.`);
      else if (referenceIds.has(id)) pushIssue(issues, 'E_MANIFEST_REFERENCE_ID_DUPLICATE', `Duplicate reference id: ${id}`);
      else referenceIds.add(id);
      if (!refPath) pushIssue(issues, 'E_MANIFEST_REFERENCE_PATH', `references[${index}].path must be a project-relative local path without query or fragment.`);
      if (!role || !REFERENCE_ROLES.has(role)) pushIssue(issues, 'E_MANIFEST_REFERENCE_ROLE', `references[${index}].role is invalid.`);
      if (strength === null) pushIssue(issues, 'E_MANIFEST_REFERENCE_STRENGTH', `references[${index}].strength must be from 0 to 1.`);
      if (!preserve) pushIssue(issues, 'E_MANIFEST_REFERENCE_PRESERVE', `references[${index}].preserve must be a string array.`);
      if (!mayChange) pushIssue(issues, 'E_MANIFEST_REFERENCE_MAY_CHANGE', `references[${index}].may_change must be a string array.`);
      if (preserve && mayChange && preserve.some((item) => mayChange.includes(item))) {
        pushIssue(issues, 'E_MANIFEST_REFERENCE_RULE_CONFLICT', `references[${index}] cannot preserve and change the same attribute.`);
      }
      if (!regionIds) pushIssue(issues, 'E_MANIFEST_REFERENCE_REGIONS', `references[${index}].region_ids must be a string array.`);
      if (id && refPath && role && REFERENCE_ROLES.has(role) && strength !== null && preserve && mayChange && regionIds) {
        references.push({
          id,
          path: refPath,
          role,
          strength,
          required: raw.required === true,
          preserve,
          may_change: mayChange,
          region_ids: regionIds,
        });
      }
    }
  }

  let referenceIntent: ImageStudioReferenceIntent | undefined;
  if (value.reference_intent !== undefined || references.length) {
    const inferredEdit = route === 'edit' || references.some((reference) => reference.role === 'edit_source');
    const rawIntent = value.reference_intent !== undefined
      ? (isRecord(value.reference_intent) ? value.reference_intent : {})
      : {
          mode: inferredEdit ? 'edit' : 'guide',
          basis: 'inferred',
          instructions: [],
          minimum_score: inferredEdit ? 80 : QUALITY_DIMENSION_FLOOR,
        };
    const mode = typeof rawIntent.mode === 'string' ? rawIntent.mode as ImageStudioReferenceIntentMode : undefined;
    const basis = rawIntent.basis === undefined
      ? 'inferred'
      : typeof rawIntent.basis === 'string' ? rawIntent.basis as ImageStudioReferenceIntentBasis : undefined;
    const instructions = optionalStringArray(rawIntent.instructions);
    const minimumScore = Number(rawIntent.minimum_score);
    if (!mode || !REFERENCE_INTENT_MODES.has(mode)) {
      pushIssue(issues, 'E_MANIFEST_REFERENCE_INTENT_MODE', 'reference_intent.mode must be reproduce, edit, or guide.');
    }
    if (!instructions) {
      pushIssue(issues, 'E_MANIFEST_REFERENCE_INTENT_INSTRUCTIONS', 'reference_intent.instructions must be a string array.');
    }
    if (!basis || !REFERENCE_INTENT_BASES.has(basis)) {
      pushIssue(issues, 'E_MANIFEST_REFERENCE_INTENT_BASIS', 'reference_intent.basis must be user or inferred.');
    }
    if (!Number.isFinite(minimumScore) || minimumScore < QUALITY_DIMENSION_FLOOR || minimumScore > 100) {
      pushIssue(issues, 'E_MANIFEST_REFERENCE_INTENT_SCORE', 'reference_intent.minimum_score must be from 70 to 100.');
    }
    if (mode === 'reproduce' && Number.isFinite(minimumScore) && minimumScore < 85) {
      pushIssue(issues, 'E_MANIFEST_REPRODUCE_SCORE_FLOOR', 'reproduce intent requires minimum_score >= 85.');
    }
    if (mode === 'edit') {
      if (Number.isFinite(minimumScore) && minimumScore < 80) {
        pushIssue(issues, 'E_MANIFEST_EDIT_SCORE_FLOOR', 'edit intent requires minimum_score >= 80.');
      }
      if (!instructions?.length) {
        pushIssue(issues, 'E_MANIFEST_EDIT_INSTRUCTIONS', 'edit intent requires at least one explicit change instruction.');
      }
      if (route !== 'edit' && route !== 'hybrid') {
        pushIssue(issues, 'E_MANIFEST_EDIT_ROUTE', 'edit reference intent requires the EDIT or HYBRID route.');
      }
      const editSources = references.filter((reference) => reference.role === 'edit_source');
      if (!editSources.length) {
        pushIssue(issues, 'E_MANIFEST_EDIT_SOURCE_REQUIRED', 'edit reference intent requires a reference with role edit_source.');
      } else if (editSources.some((reference) => !reference.required)) {
        pushIssue(issues, 'E_MANIFEST_EDIT_SOURCE_REQUIRED', 'every edit_source reference must be required.');
      }
      if (editSources.some((reference) => !reference.preserve.length || !reference.may_change.length)) {
        pushIssue(issues, 'E_MANIFEST_EDIT_BOUNDARY_REQUIRED', 'edit_source references require non-empty preserve and may_change boundaries.');
      }
    }
    if (mode === 'reproduce' && references.some((reference) => !reference.required)) {
      pushIssue(issues, 'E_MANIFEST_REPRODUCE_REFERENCE_REQUIRED', 'references used for reproduction must be required.');
    }
    if (mode && REFERENCE_INTENT_MODES.has(mode)
      && basis && REFERENCE_INTENT_BASES.has(basis)
      && instructions
      && Number.isFinite(minimumScore)
      && minimumScore >= QUALITY_DIMENSION_FLOOR
      && minimumScore <= 100) {
      referenceIntent = { mode, basis, instructions, minimum_score: minimumScore };
    }
  }
  if (route === 'edit' && referenceIntent?.mode !== 'edit') {
    pushIssue(issues, 'E_MANIFEST_EDIT_INTENT_REQUIRED', 'the EDIT route requires reference_intent.mode="edit".');
  }

  let visualPlan: ImageStudioVisualPlan | undefined;
  const regionIds = new Set<string>();
  if (value.visual_plan !== undefined) {
    const rawPlan = isRecord(value.visual_plan) ? value.visual_plan : {};
    const globalDescription = nonEmptyString(rawPlan.global_description) ? rawPlan.global_description.trim() : '';
    const readingOrder = stringArray(rawPlan.reading_order);
    const regions: ImageStudioVisualRegion[] = [];
    if (!globalDescription) pushIssue(issues, 'E_MANIFEST_VISUAL_PLAN_DESCRIPTION', 'visual_plan.global_description is required.');
    if (!readingOrder) pushIssue(issues, 'E_MANIFEST_READING_ORDER', 'visual_plan.reading_order must be a string array.');
    if (!Array.isArray(rawPlan.regions) || rawPlan.regions.length === 0) {
      pushIssue(issues, 'E_MANIFEST_VISUAL_REGIONS', 'visual_plan.regions must contain at least one region.');
    } else {
      for (const [index, raw] of rawPlan.regions.entries()) {
        if (!isRecord(raw)) {
          pushIssue(issues, 'E_MANIFEST_VISUAL_REGION', `visual_plan.regions[${index}] must be an object.`);
          continue;
        }
        const id = normalizedIdentifier(raw.id);
        const bounds = isRecord(raw.bounds) ? raw.bounds : {};
        const x = unitNumber(bounds.x);
        const y = unitNumber(bounds.y);
        const regionWidth = unitNumber(bounds.width);
        const regionHeight = unitNumber(bounds.height);
        const depth = typeof raw.depth === 'string' ? raw.depth as ImageStudioRegionDepth : undefined;
        const regionRole = typeof raw.role === 'string' ? raw.role as ImageStudioRegionRole : undefined;
        const description = nonEmptyString(raw.description) ? raw.description.trim() : '';
        const detailPrompts = optionalStringArray(raw.detail_prompts);
        const referenceIdList = optionalStringArray(raw.reference_ids);
        if (!id) pushIssue(issues, 'E_MANIFEST_REGION_ID', `visual_plan.regions[${index}].id must be a safe identifier.`);
        else if (regionIds.has(id)) pushIssue(issues, 'E_MANIFEST_REGION_ID_DUPLICATE', `Duplicate visual region id: ${id}`);
        else regionIds.add(id);
        if (x === null || y === null || regionWidth === null || regionHeight === null || regionWidth <= 0 || regionHeight <= 0 || x + regionWidth > 1.000001 || y + regionHeight > 1.000001) {
          pushIssue(issues, 'E_MANIFEST_REGION_BOUNDS', `visual_plan.regions[${index}].bounds must be normalized and stay inside the canvas.`);
        }
        if (!depth || !REGION_DEPTHS.has(depth)) pushIssue(issues, 'E_MANIFEST_REGION_DEPTH', `visual_plan.regions[${index}].depth is invalid.`);
        if (!regionRole || !REGION_ROLES.has(regionRole)) pushIssue(issues, 'E_MANIFEST_REGION_ROLE', `visual_plan.regions[${index}].role is invalid.`);
        if (!description) pushIssue(issues, 'E_MANIFEST_REGION_DESCRIPTION', `visual_plan.regions[${index}].description is required.`);
        if (!detailPrompts) pushIssue(issues, 'E_MANIFEST_REGION_DETAILS', `visual_plan.regions[${index}].detail_prompts must be a string array.`);
        if (!referenceIdList) pushIssue(issues, 'E_MANIFEST_REGION_REFERENCES', `visual_plan.regions[${index}].reference_ids must be a string array.`);
        if (referenceIdList) {
          for (const referenceId of referenceIdList) if (!referenceIds.has(referenceId)) pushIssue(issues, 'E_MANIFEST_REGION_REFERENCE_UNKNOWN', `Visual region ${id || index} references unknown reference: ${referenceId}`);
        }
        if (id && x !== null && y !== null && regionWidth !== null && regionHeight !== null && regionWidth > 0 && regionHeight > 0 && x + regionWidth <= 1.000001 && y + regionHeight <= 1.000001 && depth && REGION_DEPTHS.has(depth) && regionRole && REGION_ROLES.has(regionRole) && description && detailPrompts && referenceIdList) {
          regions.push({ id, bounds: { x, y, width: regionWidth, height: regionHeight }, depth, role: regionRole, description, detail_prompts: detailPrompts, reference_ids: referenceIdList });
        }
      }
    }
    if (readingOrder) {
      if (new Set(readingOrder).size !== readingOrder.length) pushIssue(issues, 'E_MANIFEST_READING_ORDER_DUPLICATE', 'visual_plan.reading_order must not repeat region ids.');
      for (const id of readingOrder) if (!regionIds.has(id)) pushIssue(issues, 'E_MANIFEST_READING_ORDER_UNKNOWN', `visual_plan.reading_order references unknown region: ${id}`);
      for (const id of regionIds) if (!readingOrder.includes(id)) pushIssue(issues, 'E_MANIFEST_READING_ORDER_INCOMPLETE', `visual_plan.reading_order is missing region: ${id}`);
    }
    for (const reference of references) {
      for (const id of reference.region_ids) if (!regionIds.has(id)) pushIssue(issues, 'E_MANIFEST_REFERENCE_REGION_UNKNOWN', `Reference ${reference.id} targets unknown region: ${id}`);
    }
    if (globalDescription && readingOrder && regions.length) visualPlan = { global_description: globalDescription, reading_order: readingOrder, regions };
  } else if (references.some((item) => item.region_ids.length > 0)) {
    pushIssue(issues, 'E_MANIFEST_REFERENCE_REGION_PLAN_REQUIRED', 'references[].region_ids requires visual_plan.');
  }

  let generationContract: ImageStudioGenerationContract | undefined;
  if (value.generation_contract !== undefined) {
    const rawContract = isRecord(value.generation_contract) ? value.generation_contract : {};
    const negativePrompt = optionalStringArray(rawContract.negative_prompt);
    const controls: ImageStudioGenerationControl[] = [];
    if (!negativePrompt) pushIssue(issues, 'E_MANIFEST_NEGATIVE_PROMPT', 'generation_contract.negative_prompt must be a string array.');
    if (rawContract.controls !== undefined && !Array.isArray(rawContract.controls)) {
      pushIssue(issues, 'E_MANIFEST_GENERATION_CONTROLS', 'generation_contract.controls must be an array.');
    } else {
      const rawControls: unknown[] = Array.isArray(rawContract.controls) ? rawContract.controls : [];
      for (const [index, raw] of rawControls.entries()) {
        if (!isRecord(raw)) {
          pushIssue(issues, 'E_MANIFEST_GENERATION_CONTROL', `generation_contract.controls[${index}] must be an object.`);
          continue;
        }
        const type = typeof raw.type === 'string' ? raw.type as ImageStudioControlType : undefined;
        const referenceId = normalizedIdentifier(raw.reference_id);
        const strength = unitNumber(raw.strength);
        const start = unitNumber(raw.start === undefined ? 0 : raw.start);
        const end = unitNumber(raw.end === undefined ? 1 : raw.end);
        if (!type || !CONTROL_TYPES.has(type)) pushIssue(issues, 'E_MANIFEST_CONTROL_TYPE', `generation_contract.controls[${index}].type is invalid.`);
        if (!referenceId || !referenceIds.has(referenceId)) pushIssue(issues, 'E_MANIFEST_CONTROL_REFERENCE', `generation_contract.controls[${index}] references an unknown reference.`);
        if (strength === null) pushIssue(issues, 'E_MANIFEST_CONTROL_STRENGTH', `generation_contract.controls[${index}].strength must be from 0 to 1.`);
        if (start === null || end === null || start > end) pushIssue(issues, 'E_MANIFEST_CONTROL_WINDOW', `generation_contract.controls[${index}] requires 0 <= start <= end <= 1.`);
        if (type && CONTROL_TYPES.has(type) && referenceId && referenceIds.has(referenceId) && strength !== null && start !== null && end !== null && start <= end) controls.push({ type, reference_id: referenceId, strength, start, end });
      }
    }
    let seed: number | undefined;
    if (rawContract.seed !== undefined) {
      const parsedSeed = Number(rawContract.seed);
      if (!Number.isSafeInteger(parsedSeed) || parsedSeed < 0) pushIssue(issues, 'E_MANIFEST_GENERATION_SEED', 'generation_contract.seed must be a non-negative safe integer.');
      else seed = parsedSeed;
    }
    if (route === 'compose' && controls.length) pushIssue(issues, 'E_COMPOSE_GENERATION_CONTROLS', 'COMPOSE cannot declare provider generation controls.');
    if (negativePrompt) generationContract = { negative_prompt: negativePrompt, controls, ...(seed !== undefined ? { seed } : {}) };
  }

  if (issues.length || !route || !requiredCopy || !mustInclude || !mustAvoid) return { issues };
  return {
    issues,
    manifest: {
      schema_version: 1,
      route,
      canvas: { width, height },
      ...(entry ? { entry } : {}),
      ...(rasterSource ? { raster_source: rasterSource } : {}),
      brief: {
        purpose: String(brief.purpose).trim(),
        audience: String(brief.audience).trim(),
        required_copy: requiredCopy,
        must_include: mustInclude,
        must_avoid: mustAvoid,
      },
      art_direction: Object.fromEntries(REQUIRED_ART_DIRECTION.map((key) => [key, String(direction[key]).trim()])) as ImageStudioManifest['art_direction'],
      generation_budget: { max_calls: maxCalls },
      ...(value.references !== undefined ? { references } : {}),
      ...(referenceIntent ? { reference_intent: referenceIntent } : {}),
      ...(visualPlan ? { visual_plan: visualPlan } : {}),
      ...(generationContract ? { generation_contract: generationContract } : {}),
    },
  };
}

function normalizedVisibleText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function ignoredResourceRef(value: string): boolean {
  return !value || value.startsWith('#') || value.startsWith('data:') || value.startsWith('blob:') || value === 'about:blank';
}

function externalResourceRef(value: string): boolean {
  return /^\/\//.test(value) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
}

function localRefPath(projectDirAbs: string, ownerAbsPath: string, rawRef: string): string | null {
  const ref = rawRef.trim();
  if (ignoredResourceRef(ref) || externalResourceRef(ref)) return null;
  const withoutFragment = ref.split('#', 1)[0].split('?', 1)[0];
  if (!withoutFragment) return null;
  let decoded = withoutFragment;
  try { decoded = decodeURIComponent(withoutFragment); } catch { return path.resolve(projectDirAbs, '__invalid_url_encoding__'); }
  const resolved = path.resolve(path.dirname(ownerAbsPath), decoded);
  return isPathAllowed(resolved, [projectDirAbs]) ? resolved : path.resolve(projectDirAbs, '__outside_project__');
}

async function collectHtmlResources(
  projectDirAbs: string,
  htmlAbsPath: string,
  html: string,
  blockers: ImageStudioIssue[],
): Promise<string[]> {
  const resources = new Set<string>();
  const structure = parseHtmlStructure(html);
  for (const diagnostic of structure.diagnostics) pushIssue(blockers, 'E_HTML_STRUCTURE', diagnostic);
  for (const tag of structure.tags) {
    if (FORBIDDEN_HTML_TAGS.has(tag.tagName)) pushIssue(blockers, 'E_HTML_EMBED_FORBIDDEN', `<${tag.tagName}> is not allowed.`);
    if (tag.tagName === 'meta' && String(tag.attrs['http-equiv'] || '').toLowerCase() === 'refresh') {
      pushIssue(blockers, 'E_HTML_REFRESH_FORBIDDEN', '<meta http-equiv="refresh"> is not allowed.');
    }
  }

  const queue = extractHtmlResourceRefs(structure).map((item) => ({ owner: htmlAbsPath, ref: item.ref }));
  for (const tag of structure.tags) {
    if (tag.attrs.srcset) {
      for (const candidate of tag.attrs.srcset.split(',')) {
        const ref = candidate.trim().split(/\s+/, 1)[0];
        if (ref) queue.push({ owner: htmlAbsPath, ref });
      }
    }
    if (tag.tagName === 'style' && tag.rawText) {
      for (const ref of extractCssImports(tag.rawText)) queue.push({ owner: htmlAbsPath, ref });
    }
  }
  const scannedCss = new Set<string>();
  while (queue.length) {
    const item = queue.shift()!;
    if (ignoredResourceRef(item.ref)) continue;
    if (externalResourceRef(item.ref)) {
      pushIssue(blockers, 'E_REMOTE_RESOURCE_FORBIDDEN', `Remote or absolute resource is not allowed: ${item.ref}`);
      continue;
    }
    const local = localRefPath(projectDirAbs, item.owner, item.ref);
    if (!local || !isPathAllowed(local, [projectDirAbs]) || path.basename(local) === '__outside_project__') {
      pushIssue(blockers, 'E_RESOURCE_OUTSIDE_PROJECT', `Resource leaves the image project: ${item.ref}`);
      continue;
    }
    try {
      const stat = await fs.stat(local);
      if (!stat.isFile()) throw new Error('not a file');
      resources.add(local);
    } catch {
      pushIssue(blockers, 'E_RESOURCE_MISSING', `Local resource does not exist: ${item.ref}`);
      continue;
    }
    if (path.extname(local).toLowerCase() === '.css' && !scannedCss.has(local)) {
      scannedCss.add(local);
      const css = await fs.readFile(local, 'utf8');
      for (const ref of [...extractCssUrls(css), ...extractCssImports(css)]) queue.push({ owner: local, ref });
    }
  }
  return [...resources].sort();
}

async function collectManifestReferenceResources(
  projectDirAbs: string,
  manifest: ImageStudioManifest,
  blockers: ImageStudioIssue[],
): Promise<Array<{ reference: ImageStudioReference; absPath: string }>> {
  const resources: Array<{ reference: ImageStudioReference; absPath: string }> = [];
  for (const reference of manifest.references || []) {
    const absPath = path.resolve(projectDirAbs, reference.path);
    if (!isPathAllowed(absPath, [projectDirAbs])) {
      pushIssue(blockers, 'E_REFERENCE_OUTSIDE_PROJECT', `Reference leaves the image project: ${reference.path}`);
      continue;
    }
    try {
      const stat = await fs.stat(absPath);
      if (!stat.isFile()) throw new Error('not a file');
      resources.push({ reference, absPath });
    } catch {
      pushIssue(blockers, reference.required ? 'E_REQUIRED_REFERENCE_MISSING' : 'E_REFERENCE_MISSING', `Reference does not exist: ${reference.path}`);
    }
  }
  return resources;
}

async function sha256Files(parts: Array<{ label: string; absPath: string }>): Promise<string> {
  const hash = crypto.createHash('sha256');
  for (const part of parts.sort((a, b) => a.label.localeCompare(b.label))) {
    hash.update(part.label);
    hash.update('\0');
    hash.update(await fs.readFile(part.absPath));
    hash.update('\n');
  }
  return hash.digest('hex');
}

async function nativeImageFromPath(absPath: string): Promise<ElectronNativeImage> {
  const { nativeImage } = await import('electron');
  const image = nativeImage.createFromPath(absPath);
  if (image.isEmpty()) throw new Error(`E_IMAGE_DECODE_FAILED: unable to decode ${absPath}`);
  return image;
}

async function readManifest(projectDirAbs: string): Promise<{
  manifestPath: string;
  manifest?: ImageStudioManifest;
  blockers: ImageStudioIssue[];
}> {
  const manifestPath = path.join(projectDirAbs, 'image-manifest.json');
  let raw = '';
  try { raw = await fs.readFile(manifestPath, 'utf8'); }
  catch { return { manifestPath, blockers: [{ code: 'E_MANIFEST_MISSING', message: 'image-manifest.json is required.' }] }; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { return { manifestPath, blockers: [{ code: 'E_MANIFEST_JSON', message: 'image-manifest.json must be valid JSON.' }] }; }
  const validated = validateImageStudioManifest(parsed);
  return { manifestPath, manifest: validated.manifest, blockers: validated.issues };
}

export async function inspectImageStudioProject(
  projectDirAbs: string,
  explicitRasterAbsPath?: string,
): Promise<ImageStudioInspection> {
  const projectDir = path.resolve(projectDirAbs);
  const read = await readManifest(projectDir);
  const blockers = [...read.blockers];
  const advisories: ImageStudioIssue[] = [];
  if (!read.manifest) return { ok: false, blockers, advisories, resources: [] };
  const manifest = read.manifest;
  const referenceResources = await collectManifestReferenceResources(projectDir, manifest, blockers);

  if (manifest.route === 'compose' || manifest.route === 'hybrid') {
    const entryRef = manifest.entry || 'index.html';
    const entryAbs = path.resolve(projectDir, entryRef);
    if (!isPathAllowed(entryAbs, [projectDir])) {
      pushIssue(blockers, 'E_ENTRY_OUTSIDE_PROJECT', 'HTML entry must stay inside the image project.');
      return { ok: false, route: manifest.route, blockers, advisories, resources: [], manifest };
    }
    let html = '';
    try { html = await fs.readFile(entryAbs, 'utf8'); }
    catch { pushIssue(blockers, 'E_ENTRY_MISSING', `HTML entry does not exist: ${entryRef}`); }
    const resources = html ? await collectHtmlResources(projectDir, entryAbs, html, blockers) : [];
    if (html) {
      const structure = parseHtmlStructure(html);
      const visible = normalizedVisibleText(structure.textContent);
      for (const copy of manifest.brief.required_copy) {
        if (!visible.includes(normalizedVisibleText(copy))) {
          pushIssue(blockers, 'E_REQUIRED_COPY_MISSING', `Required copy is missing from visible HTML text: ${copy}`);
        }
      }
      if (!/<svg\b/i.test(html) && manifest.route === 'compose') {
        pushIssue(advisories, 'A_NO_SVG_LAYER', 'The COMPOSE artifact has no SVG layer; confirm that HTML/CSS alone is intentional.');
      }
      const allCapsCandidates = englishAllCapsCandidates(html, manifest.brief.required_copy);
      const forcesUppercase = /\btext-transform\s*:\s*uppercase\b/i.test(html);
      if (allCapsCandidates.length >= 2 || (forcesUppercase && allCapsCandidates.length >= 1)) {
        pushIssue(
          advisories,
          'A_ENGLISH_ALL_CAPS_OVERUSE',
          `Multiple English text roles use all caps (${allCapsCandidates.slice(0, 4).join(', ')}). Restore natural title/sentence case unless exact casing is required copy; use size, weight, width, color, or spacing for hierarchy.`,
        );
      }
      for (const region of manifest.visual_plan?.regions || []) {
        if (!structure.tags.some((tag) => tag.attrs['data-image-region'] === region.id)) {
          pushIssue(blockers, 'E_VISUAL_REGION_UNMAPPED', `Visual region ${region.id} must map to an HTML/SVG element with data-image-region="${region.id}".`);
        }
      }
    }
    const allResources = [...new Set([
      ...resources,
      ...referenceResources.map((item) => item.absPath),
    ])].sort();
    const signature = blockers.length ? undefined : await sha256Files([
      { label: 'image-manifest.json', absPath: read.manifestPath },
      { label: entryRef, absPath: entryAbs },
      ...resources.map((absPath) => ({
        label: serializedProjectRelativePath(projectDir, absPath),
        absPath,
      })),
      ...referenceResources.map(({ reference, absPath }) => ({ label: `reference:${reference.id}:${reference.path}`, absPath })),
    ]);
    return {
      ok: blockers.length === 0,
      route: manifest.route,
      ...(signature ? { signature } : {}),
      blockers,
      advisories,
      resources: allResources.map((item) => serializedProjectRelativePath(projectDir, item)),
      manifest,
    };
  }

  const sourceRef = explicitRasterAbsPath || (manifest.raster_source ? path.resolve(projectDir, manifest.raster_source) : '');
  const sourceAbs = sourceRef ? path.resolve(sourceRef) : '';
  if (!sourceAbs) pushIssue(blockers, 'E_RASTER_SOURCE_REQUIRED', 'raster_source or input_path is required for GENERATE and EDIT.');
  else if (!isPathAllowed(sourceAbs, [projectDir])) pushIssue(blockers, 'E_RASTER_SOURCE_OUTSIDE_PROJECT', 'The raster source must stay inside the image project.');
  if (blockers.length) return { ok: false, route: manifest.route, blockers, advisories, resources: [], manifest };

  try {
    const image = await nativeImageFromPath(sourceAbs);
    const analysis = analyzeNativeImage(image);
    if (analysis.width !== manifest.canvas.width || analysis.height !== manifest.canvas.height) {
      pushIssue(advisories, 'A_CANVAS_SIZE_MISMATCH', `Raster is ${analysis.width}x${analysis.height}; manifest canvas is ${manifest.canvas.width}x${manifest.canvas.height}.`);
    }
    if (analysis.contrast < 8) pushIssue(advisories, 'A_LOW_CONTRAST', 'The raster has unusually low global contrast.');
    const signature = await sha256Files([
      { label: 'image-manifest.json', absPath: read.manifestPath },
      { label: `raster:${serializedProjectRelativePath(projectDir, sourceAbs)}`, absPath: sourceAbs },
      ...referenceResources.map(({ reference, absPath }) => ({ label: `reference:${reference.id}:${reference.path}`, absPath })),
    ]);
    return {
      ok: true,
      route: manifest.route,
      signature,
      evidence_path: sourceAbs,
      source_path: sourceAbs,
      blockers,
      advisories,
      resources: [...new Set([
        serializedProjectRelativePath(projectDir, sourceAbs),
        ...referenceResources.map((item) => serializedProjectRelativePath(projectDir, item.absPath)),
      ])],
      image: analysis,
      manifest,
    };
  } catch (err) {
    pushIssue(blockers, 'E_RASTER_SOURCE_INVALID', (err as Error).message);
    return { ok: false, route: manifest.route, blockers, advisories, resources: [], manifest };
  }
}

function imageStudioRequestAllowed(url: string, projectDirAbs: string): boolean {
  if (/^(?:data|blob|about):/i.test(url)) return true;
  if (!url.startsWith('file:')) return false;
  try { return isPathAllowed(fileURLToPath(url), [projectDirAbs]); }
  catch { return false; }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

async function renderHtmlSnapshot(projectDirAbs: string, manifest: ImageStudioManifest, outputAbsPath: string): Promise<{
  image: ReturnType<typeof analyzeNativeImage>;
  layoutBlockers: ImageStudioIssue[];
}> {
  const electron = await import('electron');
  if (!electron.BrowserWindow) throw new Error('E_IMAGE_STUDIO_BROWSER_UNAVAILABLE: Electron BrowserWindow is unavailable.');
  const partition = `image-studio-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const ses = electron.session.fromPartition(partition);
  ses.webRequest.onBeforeRequest((details, callback) => callback({
    cancel: !imageStudioRequestAllowed(String(details.url || ''), projectDirAbs),
  }));
  const win = new electron.BrowserWindow({
    show: false,
    width: manifest.canvas.width,
    height: manifest.canvas.height,
    useContentSize: true,
    backgroundColor: '#00000000',
    webPreferences: hardenedWebPreferences({ session: ses, backgroundThrottling: false }),
  });
  try {
    const entryAbs = path.resolve(projectDirAbs, manifest.entry || 'index.html');
    await withTimeout(win.loadURL(pathToFileURL(entryAbs).toString()), IMAGE_STUDIO_LOAD_TIMEOUT_MS, 'E_IMAGE_STUDIO_LOAD_TIMEOUT: HTML entry did not finish loading.');
    const requiredCopyLiteral = JSON.stringify(JSON.stringify(manifest.brief.required_copy));
    const requiredCopyLayouts = await withTimeout(win.webContents.executeJavaScript(`(async () => {
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
      const images = Array.from(document.images || []);
      await Promise.all(images.map((img) => img.complete ? Promise.resolve() : new Promise((resolve) => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
      })));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const requiredCopy = JSON.parse(${requiredCopyLiteral});
      const visibleText = (element) => Array.from(String(element.innerText || ''))
        .filter((char) => !/\\s/u.test(char));
      const elements = [document.body, ...Array.from(document.body.querySelectorAll('*'))];
      return requiredCopy.map((copy) => {
        const copyChars = Array.from(String(copy)).filter((char) => !/\\s/u.test(char));
        const candidates = elements.filter((element) => {
          const style = getComputedStyle(element);
          if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
          const chars = visibleText(element);
          if (chars.length < copyChars.length) return false;
          return chars.join('').includes(copyChars.join(''));
        }).sort((left, right) => visibleText(left).length - visibleText(right).length);
        const element = candidates[0];
        if (!element) return { copy, lineGlyphCounts: [], explicitBreak: false, writingMode: '' };
        const glyphs = [];
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        while (node) {
          const value = String(node.data || '');
          for (let offset = 0; offset < value.length;) {
            const codePoint = value.codePointAt(offset);
            const char = String.fromCodePoint(codePoint);
            const width = char.length;
            if (!/\\s/u.test(char)) glyphs.push({ node, start: offset, end: offset + width, char });
            offset += width;
          }
          node = walker.nextNode();
        }
        let start = -1;
        for (let index = 0; index <= glyphs.length - copyChars.length; index += 1) {
          if (copyChars.every((char, offset) => glyphs[index + offset].char === char)) {
            start = index;
            break;
          }
        }
        if (start < 0) {
          return {
            copy,
            lineGlyphCounts: [],
            explicitBreak: Boolean(element.querySelector('br')),
            writingMode: getComputedStyle(element).writingMode || '',
          };
        }
        const lineTops = [];
        for (const glyph of glyphs.slice(start, start + copyChars.length)) {
          const range = document.createRange();
          range.setStart(glyph.node, glyph.start);
          range.setEnd(glyph.node, glyph.end);
          const rect = range.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) lineTops.push(rect.top);
        }
        lineTops.sort((left, right) => left - right);
        const lines = [];
        for (const top of lineTops) {
          const line = lines.find((candidate) => Math.abs(candidate.top - top) <= 2);
          if (line) line.count += 1;
          else lines.push({ top, count: 1 });
        }
        return {
          copy,
          lineGlyphCounts: lines.map((line) => line.count),
          explicitBreak: Boolean(element.querySelector('br')),
          writingMode: getComputedStyle(element).writingMode || '',
        };
      });
    })()`, true), IMAGE_STUDIO_LOAD_TIMEOUT_MS, 'E_IMAGE_STUDIO_READY_TIMEOUT: fonts or local images did not become ready.');
    const image = await withTimeout(win.webContents.capturePage(), IMAGE_STUDIO_LOAD_TIMEOUT_MS, 'E_IMAGE_STUDIO_CAPTURE_TIMEOUT: screenshot capture timed out.');
    await fs.mkdir(path.dirname(outputAbsPath), { recursive: true });
    await fs.writeFile(outputAbsPath, image.toPNG());
    return {
      image: analyzeNativeImage(image),
      layoutBlockers: requiredCopyLayoutIssues(
        Array.isArray(requiredCopyLayouts) ? requiredCopyLayouts : [],
      ),
    };
  } finally {
    try { win.destroy(); } catch { /* best effort */ }
  }
}

async function writeEvidenceState(stateAbsPath: string, state: ImageStudioEvidenceState): Promise<void> {
  await fs.mkdir(path.dirname(stateAbsPath), { recursive: true });
  const tmp = `${stateAbsPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, stateAbsPath);
}

export async function readImageStudioEvidenceState(stateAbsPath: string): Promise<ImageStudioEvidenceState | null> {
  try {
    const value = JSON.parse(await fs.readFile(stateAbsPath, 'utf8')) as ImageStudioEvidenceState;
    return value?.schema_version === 1 ? value : null;
  } catch { return null; }
}

/** Preserve a completed review when recapturing did not prove a material
 * repair. A rejected candidate needs both a changed source signature and
 * changed rendered pixels before it becomes eligible for another review.
 * This prevents a no-op source edit or a fresh output filename from erasing
 * the finding. A passing review is stricter: it survives only an exact
 * recapture of the same source and pixels. */
function reviewForRecapturedEvidence(input: {
  previous: ImageStudioEvidenceState | null;
  projectDirAbs: string;
  signature: string;
  evidencePath: string;
  imageHash: string;
}): ImageStudioEvidenceState['review'] | undefined {
  const previous = input.previous;
  const review = previous?.review;
  if (!previous || !review) return undefined;
  if (path.resolve(previous.project_dir) !== path.resolve(input.projectDirAbs)) return undefined;
  if (review.signature !== previous.signature) return undefined;
  const sourceChanged = previous.signature !== input.signature;
  const pixelsChanged = previous.image_hash !== input.imageHash;
  const rejected = review.verdict === 'repair' || review.verdict === 'blocked';
  const materialRepairProven = sourceChanged && pixelsChanged;
  const exactRecapture = !sourceChanged && !pixelsChanged;
  if ((rejected && materialRepairProven) || (!rejected && !exactRecapture)) return undefined;
  return {
    ...review,
    signature: input.signature,
    evidence_path: path.resolve(input.evidencePath),
  };
}

export async function snapshotImageStudioProject(input: {
  projectDirAbs: string;
  outputAbsPath: string;
  stateAbsPath: string;
}): Promise<ImageStudioInspection> {
  const previous = await readImageStudioEvidenceState(input.stateAbsPath);
  const inspection = await inspectImageStudioProject(input.projectDirAbs);
  if (!inspection.ok || !inspection.manifest || !inspection.signature) return inspection;
  if (inspection.route !== 'compose' && inspection.route !== 'hybrid') {
    return {
      ...inspection,
      ok: false,
      blockers: [...inspection.blockers, { code: 'E_SNAPSHOT_ROUTE', message: 'project.snapshot is only for COMPOSE and HYBRID; inspect the generated raster directly.' }],
    };
  }
  const rendered = await renderHtmlSnapshot(path.resolve(input.projectDirAbs), inspection.manifest, path.resolve(input.outputAbsPath));
  const image = rendered.image;
  const evidencePath = path.resolve(input.outputAbsPath);
  const review = rendered.layoutBlockers.length
    ? undefined
    : reviewForRecapturedEvidence({
      previous,
      projectDirAbs: input.projectDirAbs,
      signature: inspection.signature,
      evidencePath,
      imageHash: image.hash,
    });
  const state: ImageStudioEvidenceState = {
    schema_version: 1,
    project_dir: path.resolve(input.projectDirAbs),
    route: inspection.route,
    signature: inspection.signature,
    evidence_path: evidencePath,
    image_hash: image.hash,
    captured_at: new Date().toISOString(),
    ...(review ? { review } : {}),
  };
  await writeEvidenceState(input.stateAbsPath, state);
  if (rendered.layoutBlockers.length) {
    return {
      ...inspection,
      ok: false,
      evidence_path: evidencePath,
      image,
      blockers: [...inspection.blockers, ...rendered.layoutBlockers],
    };
  }
  return { ...inspection, evidence_path: state.evidence_path, image };
}

export async function recordRasterEvidence(input: {
  projectDirAbs: string;
  rasterAbsPath?: string;
  stateAbsPath: string;
}): Promise<ImageStudioInspection> {
  const previous = await readImageStudioEvidenceState(input.stateAbsPath);
  const inspection = await inspectImageStudioProject(input.projectDirAbs, input.rasterAbsPath);
  if (!inspection.ok || !inspection.signature || !inspection.evidence_path || !inspection.image || !inspection.route) return inspection;
  if (inspection.route === 'compose' || inspection.route === 'hybrid') return inspection;
  const evidencePath = path.resolve(inspection.evidence_path);
  const review = reviewForRecapturedEvidence({
    previous,
    projectDirAbs: input.projectDirAbs,
    signature: inspection.signature,
    evidencePath,
    imageHash: inspection.image.hash,
  });
  await writeEvidenceState(input.stateAbsPath, {
    schema_version: 1,
    project_dir: path.resolve(input.projectDirAbs),
    route: inspection.route,
    signature: inspection.signature,
    evidence_path: evidencePath,
    source_path: inspection.source_path,
    image_hash: inspection.image.hash,
    captured_at: new Date().toISOString(),
    ...(review ? { review } : {}),
  });
  return inspection;
}

async function assertCurrentEvidence(stateAbsPath: string): Promise<{ state: ImageStudioEvidenceState; inspection: ImageStudioInspection }> {
  const state = await readImageStudioEvidenceState(stateAbsPath);
  if (!state) throw new Error('E_IMAGE_REVIEW_EVIDENCE_REQUIRED: inspect or snapshot the current image first.');
  const inspection = await inspectImageStudioProject(state.project_dir, state.source_path);
  if (!inspection.ok || inspection.signature !== state.signature) {
    throw new Error('E_IMAGE_REVIEW_EVIDENCE_STALE: project sources changed after the evidence was captured.');
  }
  const image = await nativeImageFromPath(state.evidence_path);
  if (analyzeNativeImage(image).hash !== state.image_hash) {
    throw new Error('E_IMAGE_REVIEW_EVIDENCE_CHANGED: the reviewed evidence image changed on disk.');
  }
  return { state, inspection };
}

export async function submitImageStudioDesignReview(input: {
  stateAbsPath: string;
  evidenceAbsPath: string;
  verdict: ImageStudioReviewVerdict;
  scope: string;
  findings: string[];
  qualityScores: unknown;
  additionalDimensions?: unknown;
}): Promise<ImageStudioEvidenceState> {
  const { state, inspection } = await assertCurrentEvidence(input.stateAbsPath);
  if (path.resolve(input.evidenceAbsPath) !== path.resolve(state.evidence_path)) {
    throw new Error('E_IMAGE_REVIEW_PATH_MISMATCH: review the exact evidence path returned by ImageStudio.');
  }
  if (!input.scope.trim()) throw new Error('E_IMAGE_REVIEW_SCOPE_REQUIRED: review_scope is required.');
  if (input.verdict !== 'passed' && input.findings.length === 0) {
    throw new Error('E_IMAGE_REVIEW_FINDINGS_REQUIRED: repair and blocked verdicts require concrete findings.');
  }
  if (state.review?.verdict === 'repair' || state.review?.verdict === 'blocked') {
    throw new Error('E_IMAGE_REVIEW_REPAIR_REQUIRED: change both the candidate sources and the rendered pixels before reviewing again.');
  }
  if (state.review?.verdict === 'passed') {
    throw new Error('E_IMAGE_REVIEW_ALREADY_SUBMITTED: this exact visual evidence already has a passing review.');
  }
  const qualityScorecard = compileImageQualityScorecard(
    input.qualityScores,
    !!inspection.manifest?.references?.length,
    input.additionalDimensions,
  );
  assertImageQualityVerdict(
    input.verdict,
    input.findings,
    qualityScorecard,
    inspection.manifest?.reference_intent?.minimum_score ?? QUALITY_DIMENSION_FLOOR,
    inspection.advisories,
  );
  const next: ImageStudioEvidenceState = {
    ...state,
    review: {
      verdict: input.verdict,
      scope: input.scope.trim(),
      findings: input.findings.map((item) => item.trim()).filter(Boolean),
      quality_scorecard: qualityScorecard,
      signature: state.signature,
      evidence_path: state.evidence_path,
      reviewed_at: new Date().toISOString(),
    },
  };
  await writeEvidenceState(input.stateAbsPath, next);
  return next;
}

export async function exportImageStudioProject(input: {
  stateAbsPath: string;
  outputAbsPath: string;
  format: 'png' | 'jpeg';
}): Promise<{ output_path: string; signature: string; image: ReturnType<typeof analyzeNativeImage> }> {
  const { state } = await assertCurrentEvidence(input.stateAbsPath);
  if (!state.review || state.review.verdict !== 'passed' || state.review.signature !== state.signature) {
    throw new Error('E_IMAGE_REVIEW_PASS_REQUIRED: the exact current evidence needs a passing design review before export.');
  }
  const image = await nativeImageFromPath(state.evidence_path);
  const bytes = input.format === 'jpeg' ? image.toJPEG(92) : image.toPNG();
  await fs.mkdir(path.dirname(input.outputAbsPath), { recursive: true });
  await fs.writeFile(input.outputAbsPath, bytes);
  const outputImage = await nativeImageFromPath(input.outputAbsPath);
  return { output_path: input.outputAbsPath, signature: state.signature, image: analyzeNativeImage(outputImage) };
}
