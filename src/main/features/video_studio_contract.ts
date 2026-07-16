import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { z } from 'zod';

export type ContractIssue = {
  code: string;
  severity: 'error' | 'warning' | 'info';
  selector?: string;
  message: string;
  fixHint?: string;
  source?: string;
  sceneId?: string;
};

const ManifestIdentifierSchema = z.string().trim().min(1).regex(
  /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
  'Use letters, numbers, hyphens, and underscores only.',
);

const ManifestTrackSchema = z.object({
  id: ManifestIdentifierSchema,
  kind: z.enum(['narration', 'music', 'sfx']),
  src: z.string().trim().min(1),
  start: z.number().finite().nonnegative(),
  duration: z.number().finite().positive(),
  volume: z.number().finite().min(0).max(1),
}).strict();

const ManifestSceneSchema = z.object({
  id: ManifestIdentifierSchema,
  start: z.number().finite().nonnegative(),
  duration: z.number().finite().positive(),
  approved_copy: z.array(z.string().trim().min(1)).default([]),
  narration_refs: z.array(z.string().trim().min(1)).default([]),
  narration_text: z.string().trim().optional(),
  source_shots: z.array(z.string().trim().min(1)).default([]),
  roles: z.array(z.string().trim().min(1)).default([]),
}).strict();

const NarrationIntentSchema = z.object({
  route_ref: z.string().trim().min(1),
  voice_ref: z.string().trim().min(1),
  display_name: z.string().trim().min(1),
  language: z.string().trim().regex(/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/),
  speed: z.number().finite().min(0.5).max(2),
}).strict();

export const CompositionManifestSchema = z.object({
  schema_version: z.union([z.literal(1), z.literal(2)]),
  composition: z.object({
    id: ManifestIdentifierSchema,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    duration: z.number().finite().positive().max(600),
    /** Immutable delivery duration approved at Gate B. Narration has its own
     * measured track duration and must not silently redefine this target. */
    target_duration: z.number().finite().positive().max(600).optional(),
    fps: z.number().int().positive().max(60),
    language: z.string().trim().min(1).optional(),
  }).strict(),
  scenes: z.array(ManifestSceneSchema).min(1),
  audio: z.object({
    owner: z.enum(['composition', 'assembler', 'none']),
    tracks: z.array(ManifestTrackSchema).default([]),
    /** Signed pre-production TTS selection. Required for new standalone
     * narrated manifests and preserved after materialization. */
    narration_intent: NarrationIntentSchema.optional(),
  }).strict(),
  source_alignment: z.object({
    merge_reason: z.string().trim().min(1).optional(),
  }).strict().optional(),
  art_direction: z.record(z.unknown()).optional(),
}).strict().superRefine((manifest, ctx) => {
  const hasNarration = manifest.scenes.some((scene) => !!scene.narration_text?.trim());
  if (manifest.schema_version === 2
    && hasNarration
    && manifest.audio.owner !== 'assembler'
    && !manifest.audio.narration_intent) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['audio', 'narration_intent'],
      message: 'schema_version 2 standalone narration requires a signed audio.narration_intent selected from speech.capabilities.',
    });
  }
});

export type CompositionManifest = z.infer<typeof CompositionManifestSchema>;

export type CompositionManifestLoad = {
  ok: boolean;
  manifest: CompositionManifest | null;
  manifestPath: string;
  source: 'manifest' | 'legacy_migration' | 'missing';
  wroteManifest: boolean;
  issues: ContractIssue[];
  legacyContract: unknown;
  legacySceneMap: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function numberFrom(...values: unknown[]): number {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function stringFrom(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
  return [];
}

async function readJson(absPath: string): Promise<{ exists: boolean; value: unknown; error?: string }> {
  const st = await fs.stat(absPath).catch(() => null);
  if (!st?.isFile()) return { exists: false, value: null };
  try {
    return { exists: true, value: JSON.parse(await fs.readFile(absPath, 'utf8')) };
  } catch (err) {
    return { exists: true, value: null, error: (err as Error).message };
  }
}

function schemaIssues(error: z.ZodError): ContractIssue[] {
  return error.issues.map((issue) => ({
    code: 'COMPOSITION_MANIFEST_SCHEMA_INVALID',
    severity: 'error',
    selector: `composition-manifest.json#${issue.path.join('.') || 'root'}`,
    message: issue.message,
    fixHint: 'Use the canonical composition-manifest.json v1 field names and value types.',
    source: 'orkas-native-composition-manifest',
  }));
}

function validateManifestSemantics(manifest: CompositionManifest): ContractIssue[] {
  const issues: ContractIssue[] = [];
  const ids = new Set<string>();
  const trackIds = new Set<string>();
  let previousEnd = 0;
  for (const [index, scene] of manifest.scenes.entries()) {
    if (ids.has(scene.id)) {
      issues.push({
        code: 'COMPOSITION_MANIFEST_SCENE_ID_DUPLICATE',
        severity: 'error',
        selector: `composition-manifest.json#scenes.${index}.id`,
        sceneId: scene.id,
        message: `Scene id "${scene.id}" is duplicated.`,
        source: 'orkas-native-composition-manifest',
      });
    }
    ids.add(scene.id);
    if (scene.start > previousEnd + 0.05) {
      issues.push({
        code: 'COMPOSITION_MANIFEST_SCENE_GAP',
        severity: 'error',
        selector: `composition-manifest.json#scenes.${index}`,
        sceneId: scene.id,
        message: `Scene "${scene.id}" leaves an uncovered timeline gap from ${previousEnd}s to ${scene.start}s.`,
        source: 'orkas-native-composition-manifest',
      });
    }
    if (scene.start < previousEnd - 0.001) {
      issues.push({
        code: 'COMPOSITION_MANIFEST_SCENE_OVERLAP',
        severity: 'error',
        selector: `composition-manifest.json#scenes.${index}`,
        sceneId: scene.id,
        message: `Scene "${scene.id}" starts before the previous scene ends.`,
        source: 'orkas-native-composition-manifest',
      });
    }
    if (scene.start + scene.duration > manifest.composition.duration + 0.05) {
      issues.push({
        code: 'COMPOSITION_MANIFEST_SCENE_OUT_OF_RANGE',
        severity: 'error',
        selector: `composition-manifest.json#scenes.${index}`,
        sceneId: scene.id,
        message: `Scene "${scene.id}" ends after the composition duration.`,
        source: 'orkas-native-composition-manifest',
      });
    }
    previousEnd = Math.max(previousEnd, scene.start + scene.duration);
  }
  if (manifest.scenes.length && Math.abs(previousEnd - manifest.composition.duration) > 0.15) {
    issues.push({
      code: 'COMPOSITION_MANIFEST_TIMELINE_COVERAGE_MISMATCH',
      severity: 'error',
      selector: 'composition-manifest.json#scenes',
      message: `Scene timeline ends at ${previousEnd}s but composition duration is ${manifest.composition.duration}s.`,
      source: 'orkas-native-composition-manifest',
    });
  }
  for (const [index, track] of manifest.audio.tracks.entries()) {
    if (trackIds.has(track.id)) {
      issues.push({
        code: 'COMPOSITION_MANIFEST_AUDIO_ID_DUPLICATE',
        severity: 'error',
        selector: `composition-manifest.json#audio.tracks.${index}.id`,
        message: `Audio track id "${track.id}" is duplicated.`,
        source: 'orkas-native-composition-manifest',
      });
    }
    trackIds.add(track.id);
    const normalizedSrc = track.src.replace(/\\/g, '/');
    if (/^(?:https?:|data:|blob:|file:)/i.test(track.src)
      || path.isAbsolute(track.src)
      || normalizedSrc === '..'
      || normalizedSrc.startsWith('../')
      || normalizedSrc.includes('/../')) {
      issues.push({
        code: 'COMPOSITION_MANIFEST_AUDIO_PATH_INVALID',
        severity: 'error',
        selector: `composition-manifest.json#audio.tracks.${index}.src`,
        message: `Audio track "${track.id}" must use a composition-local relative path.`,
        source: 'orkas-native-composition-manifest',
      });
    }
    if (track.start + track.duration > manifest.composition.duration + 0.15) {
      issues.push({
        code: 'COMPOSITION_MANIFEST_AUDIO_OUT_OF_RANGE',
        severity: 'error',
        selector: `composition-manifest.json#audio.tracks.${index}`,
        message: `Audio track "${track.id}" extends beyond the composition duration.`,
        source: 'orkas-native-composition-manifest',
      });
    }
  }
  const declaresNarration = manifest.scenes.some((scene) => !!scene.narration_text || scene.narration_refs.length > 0);
  if (manifest.audio.owner === 'composition' && manifest.audio.tracks.length === 0) {
    issues.push({
      code: 'COMPOSITION_MANIFEST_AUDIO_TRACKS_MISSING',
      severity: 'error',
      selector: 'composition-manifest.json#audio',
      message: 'Audio owner "composition" requires at least one declarative audio track.',
      source: 'orkas-native-composition-manifest',
    });
  }
  if (manifest.audio.owner === 'composition'
    && declaresNarration
    && !manifest.audio.tracks.some((track) => track.kind === 'narration')) {
    issues.push({
      code: 'COMPOSITION_MANIFEST_NARRATION_TRACK_MISSING',
      severity: 'error',
      selector: 'composition-manifest.json#audio',
      message: 'Narrated scenes require a declarative narration audio track.',
      source: 'orkas-native-composition-manifest',
    });
  }
  if (manifest.audio.owner !== 'composition' && manifest.audio.tracks.length > 0) {
    issues.push({
      code: 'COMPOSITION_MANIFEST_AUDIO_OWNERSHIP_CONFLICT',
      severity: 'error',
      selector: 'composition-manifest.json#audio',
      message: `Audio tracks are not allowed when audio owner is "${manifest.audio.owner}".`,
      source: 'orkas-native-composition-manifest',
    });
  }
  return issues;
}

function sceneCopy(scene: Record<string, unknown>): string[] {
  const explicit = stringList(scene.approved_copy);
  if (explicit.length) return [...new Set(explicit)];
  const out: string[] = [];
  for (const key of ['headline', 'title', 'subtitle', 'body', 'copy', 'caption', 'label', 'text']) {
    const value = scene[key];
    if (typeof value === 'string' && value.trim()) out.push(value.trim());
    else if (Array.isArray(value)) out.push(...value.map((item) => String(item).trim()).filter(Boolean));
  }
  return [...new Set(out)];
}

function legacyScenes(value: unknown): Record<string, unknown>[] {
  if (!isRecord(value)) return [];
  if (Array.isArray(value.scenes)) return value.scenes.filter(isRecord);
  if (Array.isArray(value.shots)) return value.shots.filter(isRecord);
  if (isRecord(value.timeline) && Array.isArray(value.timeline.scenes)) return value.timeline.scenes.filter(isRecord);
  return [];
}

function legacyCanvas(contract: unknown, sceneMap: unknown): CompositionManifest['composition'] {
  const contractRecord = isRecord(contract) ? contract : {};
  const sceneRecord = isRecord(sceneMap) ? sceneMap : {};
  const contractCanvas = isRecord(contractRecord.canvas) ? contractRecord.canvas : {};
  const sceneCanvas = isRecord(sceneRecord.canvas) ? sceneRecord.canvas : {};
  return {
    id: stringFrom(sceneCanvas.id, sceneRecord.composition_id, sceneRecord.id, contractCanvas.id, contractRecord.composition_id, contractRecord.id, 'main'),
    width: numberFrom(sceneCanvas.width, sceneRecord.width, contractCanvas.width, contractRecord.width),
    height: numberFrom(sceneCanvas.height, sceneRecord.height, contractCanvas.height, contractRecord.height),
    duration: numberFrom(
      sceneCanvas.duration,
      sceneCanvas.duration_sec,
      sceneCanvas.duration_s,
      sceneRecord.duration,
      sceneRecord.duration_sec,
      sceneRecord.duration_s,
      sceneRecord.narration_total_duration_s,
      contractCanvas.duration,
      contractCanvas.duration_sec,
      contractCanvas.duration_s,
      contractRecord.duration,
      contractRecord.duration_sec,
      contractRecord.duration_s,
    ),
    fps: numberFrom(sceneCanvas.fps, sceneRecord.fps, contractCanvas.fps, contractRecord.fps, 30),
    ...(stringFrom(sceneCanvas.language, sceneRecord.language, sceneRecord.narration_language, contractCanvas.language, contractRecord.language)
      ? { language: stringFrom(sceneCanvas.language, sceneRecord.language, sceneRecord.narration_language, contractCanvas.language, contractRecord.language) }
      : {}),
  };
}

function legacyAudio(contract: unknown, sceneMap: unknown, duration: number): CompositionManifest['audio'] {
  const contractRecord = isRecord(contract) ? contract : {};
  const sceneRecord = isRecord(sceneMap) ? sceneMap : {};
  const contractAudio = isRecord(contractRecord.audio) ? contractRecord.audio : {};
  const sceneAudio = isRecord(sceneRecord.audio) ? sceneRecord.audio : {};
  const ownership = isRecord(contractRecord.audio_ownership) ? contractRecord.audio_ownership : {};
  const ownerText = stringFrom(sceneAudio.owner, sceneAudio.mode, contractAudio.owner, contractAudio.mode).toLowerCase();
  const narration = stringFrom(
    sceneAudio.narration,
    sceneAudio.narration_path,
    sceneAudio.src,
    sceneRecord.narration_audio,
    contractAudio.narration,
    contractAudio.narration_path,
    contractAudio.src,
  );
  const renderSilent = sceneAudio.render_silent === true || contractAudio.render_silent === true;
  const assemblerOwned = renderSilent || ['assemble', 'assembler', 'external'].includes(ownerText);
  const ownershipDeclaresNarration = typeof ownership.narration === 'string' && ownership.narration.trim().length > 0;
  const owner: CompositionManifest['audio']['owner'] = assemblerOwned
    ? 'assembler'
    : narration || ownerText === 'composition' || ownershipDeclaresNarration
      ? 'composition'
      : 'none';
  return {
    owner,
    tracks: narration && owner === 'composition'
      ? [{
        id: 'narration',
        kind: 'narration',
        src: narration,
        start: 0,
        duration: numberFrom(
          sceneAudio.narration_duration_seconds,
          sceneAudio.narration_duration_sec,
          sceneRecord.narration_total_duration_s,
          contractAudio.narration_duration_seconds,
          contractAudio.target_sec,
          duration,
        ),
        volume: numberFrom(sceneAudio.volume, contractAudio.volume, 1),
      }]
      : [],
  };
}

function legacyArtDirection(contract: unknown): Record<string, unknown> | undefined {
  if (!isRecord(contract)) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of [
    'aesthetic',
    'style_source',
    'typography_tokens',
    'color_tokens',
    'safe_zone',
    'layout_boxes',
    'motion_budget',
    'scene_variation',
  ]) {
    if (contract[key] !== undefined) out[key] = contract[key];
  }
  return Object.keys(out).length ? out : undefined;
}

export function migrateLegacyCompositionManifest(contract: unknown, sceneMap: unknown): unknown {
  const composition = legacyCanvas(contract, sceneMap);
  const contractScenes = legacyScenes(contract);
  const contractById = new Map(contractScenes.map((scene) => [String(scene.id || scene.scene_id || ''), scene]));
  const sourceScenes = legacyScenes(sceneMap).length ? legacyScenes(sceneMap) : contractScenes;
  const scenes = sourceScenes.map((raw, index) => {
    const id = stringFrom(raw.id, raw.scene_id, raw.sceneId, `scene-${index + 1}`);
    const designScene = contractById.get(id) || {};
    const start = numberFrom(raw.start, raw.start_sec, raw.start_s);
    const explicitDuration = numberFrom(raw.duration, raw.duration_sec, raw.duration_s);
    const end = numberFrom(raw.end, raw.end_sec, raw.end_s);
    return {
      id,
      start,
      duration: explicitDuration > 0 ? explicitDuration : Math.max(0, end - start),
      approved_copy: sceneCopy({ ...designScene, ...raw }),
      narration_refs: stringList(raw.narration_ref ?? raw.voiceover_ref ?? raw.script_ref),
      ...(stringFrom(raw.narration, raw.narration_text, raw.voiceover, raw.audio_text, raw.script)
        ? { narration_text: stringFrom(raw.narration, raw.narration_text, raw.voiceover, raw.audio_text, raw.script) }
        : {}),
      source_shots: stringList(raw.source_shots),
      roles: stringList(raw.roles),
    };
  });
  const sceneRecord = isRecord(sceneMap) ? sceneMap : {};
  const sourceAlignment = isRecord(sceneRecord.source_alignment) ? sceneRecord.source_alignment : {};
  return {
    schema_version: 1,
    composition,
    scenes,
    audio: legacyAudio(contract, sceneMap, composition.duration),
    ...(stringFrom(sourceAlignment.merge_reason)
      ? { source_alignment: { merge_reason: stringFrom(sourceAlignment.merge_reason) } }
      : {}),
    ...(legacyArtDirection(contract) ? { art_direction: legacyArtDirection(contract) } : {}),
  };
}

function parseManifest(value: unknown): { manifest: CompositionManifest | null; issues: ContractIssue[] } {
  const parsed = CompositionManifestSchema.safeParse(value);
  if (!parsed.success) return { manifest: null, issues: schemaIssues(parsed.error) };
  const issues = validateManifestSemantics(parsed.data);
  return {
    manifest: issues.some((issue) => issue.severity === 'error') ? null : parsed.data,
    issues,
  };
}

export async function ensureCompositionManifest(
  compositionDirAbs: string,
  opts: { writeGenerated?: boolean } = {},
): Promise<CompositionManifestLoad> {
  const manifestPath = path.join(compositionDirAbs, 'composition-manifest.json');
  const contractPath = path.join(compositionDirAbs, 'design-contract.json');
  const sceneMapPath = path.join(compositionDirAbs, 'scene-map.json');
  const [manifestLoad, contractLoad, sceneMapLoad] = await Promise.all([
    readJson(manifestPath),
    readJson(contractPath),
    readJson(sceneMapPath),
  ]);
  const inputIssues: ContractIssue[] = [];
  if (manifestLoad.exists) {
    if (manifestLoad.error) {
      inputIssues.push({
        code: 'COMPOSITION_MANIFEST_PARSE_FAILED',
        severity: 'error',
        selector: 'composition-manifest.json',
        message: manifestLoad.error,
        source: 'orkas-native-composition-manifest',
      });
      return {
        ok: false,
        manifest: null,
        manifestPath,
        source: 'manifest',
        wroteManifest: false,
        issues: inputIssues,
        legacyContract: contractLoad.value,
        legacySceneMap: sceneMapLoad.value,
      };
    }
    const parsed = parseManifest(manifestLoad.value);
    return {
      ok: !!parsed.manifest,
      manifest: parsed.manifest,
      manifestPath,
      source: 'manifest',
      wroteManifest: false,
      issues: parsed.issues,
      legacyContract: contractLoad.value,
      legacySceneMap: sceneMapLoad.value,
    };
  }
  if (contractLoad.error) inputIssues.push({
    code: 'DESIGN_CONTRACT_PARSE_FAILED',
    severity: 'error',
    selector: 'design-contract.json',
    message: contractLoad.error,
    source: 'orkas-native-composition-manifest',
  });
  if (sceneMapLoad.error) inputIssues.push({
    code: 'SCENE_MAP_PARSE_FAILED',
    severity: 'error',
    selector: 'scene-map.json',
    message: sceneMapLoad.error,
    source: 'orkas-native-composition-manifest',
  });
  if (!contractLoad.exists && !sceneMapLoad.exists) {
    return {
      ok: false,
      manifest: null,
      manifestPath,
      source: 'missing',
      wroteManifest: false,
      issues: [{
        code: 'COMPOSITION_MANIFEST_MISSING',
        severity: 'error',
        selector: 'composition-manifest.json',
        message: 'composition-manifest.json is required; legacy migration also needs design-contract.json or scene-map.json.',
        fixHint: 'Call composition.prepare after writing the approved composition manifest.',
        source: 'orkas-native-composition-manifest',
      }],
      legacyContract: contractLoad.value,
      legacySceneMap: sceneMapLoad.value,
    };
  }
  const parsed = parseManifest(migrateLegacyCompositionManifest(contractLoad.value, sceneMapLoad.value));
  const migrationIssue: ContractIssue = {
    code: 'LEGACY_COMPOSITION_CONTRACT_MIGRATED',
    severity: 'warning',
    selector: 'composition-manifest.json',
    message: 'Generated canonical composition-manifest.json v1 from legacy design-contract.json/scene-map.json.',
    fixHint: 'Use composition-manifest.json as the only structural timeline source for future edits.',
    source: 'orkas-native-composition-manifest',
  };
  let wroteManifest = false;
  if (parsed.manifest && inputIssues.length === 0 && opts.writeGenerated !== false) {
    await fs.writeFile(manifestPath, `${JSON.stringify(parsed.manifest, null, 2)}\n`, 'utf8');
    wroteManifest = true;
  }
  return {
    ok: inputIssues.length === 0 && !!parsed.manifest,
    manifest: parsed.manifest,
    manifestPath,
    source: 'legacy_migration',
    wroteManifest,
    issues: [...inputIssues, ...parsed.issues, ...(parsed.manifest ? [migrationIssue] : [])],
    legacyContract: contractLoad.value,
    legacySceneMap: sceneMapLoad.value,
  };
}

export function manifestAsSceneMap(manifest: CompositionManifest): Record<string, unknown> {
  const narration = manifest.audio.tracks.find((track) => track.kind === 'narration');
  return {
    schema_version: manifest.schema_version,
    canvas: {
      width: manifest.composition.width,
      height: manifest.composition.height,
      duration: manifest.composition.duration,
      fps: manifest.composition.fps,
      ...(manifest.composition.language ? { language: manifest.composition.language } : {}),
    },
    audio: {
      owner: manifest.audio.owner,
      ...(narration ? {
        narration: narration.src,
        narration_duration_seconds: narration.duration,
      } : {}),
      ...(manifest.audio.owner !== 'composition' ? { render_silent: true } : {}),
    },
    ...(manifest.source_alignment ? { source_alignment: manifest.source_alignment } : {}),
    scenes: manifest.scenes.map((scene) => ({
      id: scene.id,
      start: scene.start,
      duration: scene.duration,
      approved_copy: scene.approved_copy,
      ...(scene.narration_text ? { narration_text: scene.narration_text } : {}),
      ...(scene.narration_refs.length === 1 ? { narration_ref: scene.narration_refs[0] } : scene.narration_refs.length ? { narration_ref: scene.narration_refs } : {}),
      source_shots: scene.source_shots,
      roles: scene.roles,
    })),
  };
}

export function manifestAsDesignContract(manifest: CompositionManifest, legacyContract: unknown): Record<string, unknown> {
  const contract = isRecord(legacyContract) ? legacyContract : {};
  return {
    ...contract,
    ...(manifest.art_direction || {}),
    canvas: {
      ...(isRecord(contract.canvas) ? contract.canvas : {}),
      width: manifest.composition.width,
      height: manifest.composition.height,
      duration: manifest.composition.duration,
      fps: manifest.composition.fps,
      ...(manifest.composition.language ? { language: manifest.composition.language } : {}),
    },
    audio: manifestAsSceneMap(manifest).audio,
  };
}

export function compositionNarrationText(manifest: CompositionManifest): string {
  return manifest.scenes
    .map((scene) => scene.narration_text?.trim() || '')
    .filter(Boolean)
    .join('\n\n');
}

/** Apply one measured standalone narration duration before visual authoring. */
export function retimeCompositionManifestForNarration(
  manifest: CompositionManifest,
  measuredDurationSec: number,
  sceneWeights: number[] = [],
): CompositionManifest {
  const narrationDuration = Math.round(measuredDurationSec * 1000) / 1000;
  const duration = Math.round((manifest.composition.target_duration ?? narrationDuration) * 1000) / 1000;
  const weights = manifest.scenes.map((scene, index) => {
    const supplied = Number(sceneWeights[index]);
    return Number.isFinite(supplied) && supplied > 0 ? supplied : Math.max(0.001, scene.duration);
  });
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  let cursor = 0;
  const scenes = manifest.scenes.map((scene, index) => {
    const start = Math.round(cursor * 1000) / 1000;
    cursor = index === manifest.scenes.length - 1
      ? duration
      : cursor + (duration * weights[index] / totalWeight);
    const end = Math.round(cursor * 1000) / 1000;
    return { ...scene, start, duration: Math.max(0.001, Math.round((end - start) * 1000) / 1000) };
  });
  const tracks = manifest.audio.tracks
    .filter((track) => track.kind !== 'narration')
    .concat([{
      id: 'narration',
      kind: 'narration' as const,
      src: 'assets/narration.mp3',
      start: 0,
      duration: narrationDuration,
      volume: 1,
    }]);
  return {
    ...manifest,
    composition: { ...manifest.composition, duration },
    scenes,
    audio: {
      owner: 'composition',
      tracks,
      ...(manifest.audio.narration_intent ? { narration_intent: manifest.audio.narration_intent } : {}),
    },
  };
}

export function buildCompositionNarrationMap(
  manifest: CompositionManifest,
  input: { textSha256: string; audioSha256: string; method: 'scene_estimate_scaled' | 'forced_alignment' },
): Record<string, unknown> {
  const lines = manifest.scenes.flatMap((scene) => {
    const text = scene.narration_text?.trim() || '';
    if (!text) return [];
    const ids = scene.narration_refs.length ? scene.narration_refs : [`narration-${scene.id}`];
    return ids.map((id) => ({
      id,
      scene_id: scene.id,
      start: scene.start,
      duration: scene.duration,
      text,
    }));
  });
  return {
    schema_version: 1,
    source: 'composition.materialize_narration',
    alignment_method: input.method,
    narration_text_sha256: input.textSha256,
    narration_audio_sha256: input.audioSha256,
    total_duration: manifest.composition.duration,
    lines,
  };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function setOpeningTagAttribute(tag: string, name: string, value: string): string {
  const attr = new RegExp(`\\s${name}=(?:"[^"]*"|'[^']*')`, 'i');
  if (attr.test(tag)) return tag.replace(attr, ` ${name}="${escapeHtml(value)}"`);
  return tag.replace(/>$/, ` ${name}="${escapeHtml(value)}">`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Update runtime-owned composition/clip/audio metadata without replacing
 * model-authored DOM, CSS, SVG, or custom timeline code. */
export function reconcileCompositionHtml(
  html: string,
  manifest: CompositionManifest,
): { ok: boolean; html: string; changed: boolean; issues: ContractIssue[] } {
  const issues: ContractIssue[] = [];
  let next = html;
  const rootRe = /<([a-z][\w:-]*)\b[^>]*\bdata-composition-id=(?:"[^"]*"|'[^']*')[^>]*>/i;
  const rootMatch = rootRe.exec(next);
  if (!rootMatch) {
    issues.push({
      code: 'COMPOSITION_ROOT_MISSING',
      severity: 'error',
      selector: '[data-composition-id]',
      message: 'Cannot reconcile composition metadata because the protected root is missing.',
      source: 'orkas-native-composition-reconcile',
    });
    return { ok: false, html, changed: false, issues };
  }
  let rootTag = rootMatch[0];
  rootTag = setOpeningTagAttribute(rootTag, 'data-composition-id', manifest.composition.id);
  rootTag = setOpeningTagAttribute(rootTag, 'data-start', '0');
  rootTag = setOpeningTagAttribute(rootTag, 'data-duration', String(manifest.composition.duration));
  rootTag = setOpeningTagAttribute(rootTag, 'data-width', String(manifest.composition.width));
  rootTag = setOpeningTagAttribute(rootTag, 'data-height', String(manifest.composition.height));
  next = `${next.slice(0, rootMatch.index)}${rootTag}${next.slice(rootMatch.index + rootMatch[0].length)}`;

  for (const scene of manifest.scenes) {
    const escapedId = escapeRegExp(scene.id);
    const sceneRe = new RegExp(`<([a-z][\\w:-]*)\\b[^>]*\\bdata-scene-id=(?:"${escapedId}"|'${escapedId}')[^>]*>`, 'i');
    const match = sceneRe.exec(next);
    if (!match) {
      issues.push({
        code: 'SEMANTIC_SCENE_HOOKS_MISSING',
        severity: 'error',
        selector: `[data-scene-id="${scene.id}"]`,
        sceneId: scene.id,
        message: `Cannot reconcile timing because scene "${scene.id}" is missing from HTML.`,
        source: 'orkas-native-composition-reconcile',
      });
      continue;
    }
    let tag = setOpeningTagAttribute(match[0], 'data-start', String(scene.start));
    tag = setOpeningTagAttribute(tag, 'data-duration', String(scene.duration));
    next = `${next.slice(0, match.index)}${tag}${next.slice(match.index + match[0].length)}`;
  }

  // Patch only the runtime-generated visibility setters. Authored motion
  // remains intact and is still validated by inspect after a timing change.
  for (const [index, scene] of manifest.scenes.entries()) {
    const selector = JSON.stringify(`#scene-${scene.id.replace(/(["\\])/g, '\\$1')}`);
    const selectorPattern = escapeRegExp(selector);
    const showRe = new RegExp(`tl\\.set\\(\\s*${selectorPattern}\\s*,\\s*\\{\\s*autoAlpha\\s*:\\s*1\\s*\\}\\s*,\\s*-?[0-9.]+\\s*\\);`);
    next = next.replace(showRe, `tl.set(${selector}, { autoAlpha: 1 }, ${scene.start});`);
    if (index < manifest.scenes.length - 1) {
      const hideRe = new RegExp(`tl\\.set\\(\\s*${selectorPattern}\\s*,\\s*\\{\\s*autoAlpha\\s*:\\s*0\\s*\\}\\s*,\\s*-?[0-9.]+\\s*\\);`);
      next = next.replace(hideRe, `tl.set(${selector}, { autoAlpha: 0 }, ${scene.start + scene.duration});`);
    }
  }

  // Declarative audio elements are runtime-owned. Rebuild only these tags and
  // leave all visual children and author code untouched.
  next = next.replace(/\n?\s*<audio\b[^>]*\bdata-start=(?:"[^"]*"|'[^']*')[^>]*>(?:\s*<\/audio>)?/gi, '');
  const audio = manifest.audio.owner === 'composition'
    ? manifest.audio.tracks.map((track, index) => `    <audio id="audio-${escapeHtml(track.id)}" src="./${escapeHtml(track.src.replace(/^\.\//, ''))}" data-start="${track.start}" data-duration="${track.duration}" data-track-index="${index + 10}" data-volume="${track.volume}"></audio>`).join('\n')
    : '';
  if (audio) {
    const closeRoot = new RegExp(`</${rootMatch[1]}>`, 'i');
    const closeMatch = closeRoot.exec(next.slice(rootMatch.index));
    if (closeMatch) {
      const insertion = rootMatch.index + closeMatch.index;
      next = `${next.slice(0, insertion)}\n${audio}\n  ${next.slice(insertion)}`;
    } else {
      issues.push({
        code: 'COMPOSITION_ROOT_UNCLOSED',
        severity: 'error',
        selector: '[data-composition-id]',
        message: 'Cannot reconcile declarative audio because the composition root is not closed.',
        source: 'orkas-native-composition-reconcile',
      });
    }
  }
  return {
    ok: !issues.some((issue) => issue.severity === 'error'),
    html: next,
    changed: next !== html,
    issues,
  };
}

export function buildCompositionScaffold(manifest: CompositionManifest): string {
  const { composition } = manifest;
  const clips = manifest.scenes.map((scene) => {
    const title = scene.approved_copy[0] || scene.id;
    return [
      `    <section id="scene-${escapeHtml(scene.id)}" class="clip" data-scene-id="${escapeHtml(scene.id)}" data-start="${scene.start}" data-duration="${scene.duration}" data-track-index="1">`,
      '      <div class="scene-content">',
      `        <h1 data-role="title">${escapeHtml(title)}</h1>`,
      `        <div data-role="visual" aria-label="${escapeHtml(scene.id)} visual"></div>`,
      '      </div>',
      '    </section>',
    ].join('\n');
  }).join('\n');
  const audio = manifest.audio.owner === 'composition'
    ? manifest.audio.tracks.map((track, index) => `    <audio id="audio-${escapeHtml(track.id)}" src="./${escapeHtml(track.src.replace(/^\.\//, ''))}" data-start="${track.start}" data-duration="${track.duration}" data-track-index="${index + 10}" data-volume="${track.volume}"></audio>`).join('\n')
    : '';
  const visibilityTimeline = manifest.scenes.map((scene, index) => {
    const selector = `#scene-${scene.id.replace(/(["\\])/g, '\\$1')}`;
    return [
      `      tl.set(${JSON.stringify(selector)}, { autoAlpha: 1 }, ${scene.start});`,
      ...(index < manifest.scenes.length - 1 ? [`      tl.set(${JSON.stringify(selector)}, { autoAlpha: 0 }, ${scene.start + scene.duration});`] : []),
    ].join('\n');
  }).join('\n');
  return `<!doctype html>
<html lang="${escapeHtml(composition.language || 'en')}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=${composition.width}, height=${composition.height}" />
  <script src="./assets/vendor/gsap.min.js"></script>
  <style>
    * { box-sizing: border-box; }
    html, body { width: ${composition.width}px; height: ${composition.height}px; margin: 0; overflow: hidden; background: #000; color: #fff; }
    [data-composition-id="${escapeHtml(composition.id)}"] { position: relative; width: 100%; height: 100%; overflow: hidden; }
    .clip { position: absolute; inset: 0; opacity: 0; visibility: hidden; }
    .scene-content { width: 100%; height: 100%; padding: 96px; display: flex; flex-direction: column; justify-content: center; gap: 32px; }
    h1 { margin: 0; font-size: 96px; }
  </style>
</head>
<body>
  <!-- ORKAS-GENERATED-SCAFFOLD: keep composition/clip/audio attributes declarative. -->
  <main id="composition-root" data-composition-id="${escapeHtml(composition.id)}" data-start="0" data-duration="${composition.duration}" data-width="${composition.width}" data-height="${composition.height}">
${clips}
${audio}
  </main>
  <script>
    (() => {
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
      window.__timelines[${JSON.stringify(composition.id)}] = tl;
      window.__ORKAS_COMPOSITION_TIMELINE__ = tl;
${visibilityTimeline}
      // Add deterministic scene motion to tl. Do not control audio/video imperatively.
    })();
  </script>
</body>
</html>
`;
}

export async function prepareCompositionScaffold(compositionDirAbs: string): Promise<{
  ok: boolean;
  manifest: CompositionManifest | null;
  manifest_path: string;
  manifest_source: CompositionManifestLoad['source'];
  manifest_written: boolean;
  html_path: string;
  scaffold_created: boolean;
  issues: ContractIssue[];
}> {
  const loaded = await ensureCompositionManifest(compositionDirAbs, { writeGenerated: true });
  const htmlPath = path.join(compositionDirAbs, 'index.html');
  if (!loaded.ok || !loaded.manifest) {
    return {
      ok: false,
      manifest: null,
      manifest_path: loaded.manifestPath,
      manifest_source: loaded.source,
      manifest_written: loaded.wroteManifest,
      html_path: htmlPath,
      scaffold_created: false,
      issues: loaded.issues,
    };
  }
  const htmlExists = !!(await fs.stat(htmlPath).catch(() => null));
  let scaffoldCreated = false;
  if (!htmlExists) {
    await fs.mkdir(path.join(compositionDirAbs, 'assets', 'vendor'), { recursive: true });
    await fs.writeFile(htmlPath, buildCompositionScaffold(loaded.manifest), 'utf8');
    scaffoldCreated = true;
  }
  return {
    ok: true,
    manifest: loaded.manifest,
    manifest_path: loaded.manifestPath,
    manifest_source: loaded.source,
    manifest_written: loaded.wroteManifest,
    html_path: htmlPath,
    scaffold_created: scaffoldCreated,
    issues: loaded.issues,
  };
}
