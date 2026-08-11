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
}).strict().transform((scene) => (
  // An explicitly empty narration field means this scene is intentionally
  // silent. Clear stale implementation refs while parsing so a repaired id or
  // generated placeholder cannot alter the approved intent or make audio QA
  // treat the scene as narrated. Omitted narration_text remains compatible
  // with legacy ref-only manifests whose words live in narration-map.json.
  scene.narration_text !== undefined && !scene.narration_text.trim()
    ? { ...scene, narration_refs: [] }
    : scene
));

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
    /** Whether the delivered video carries captions, and how. Absent means
     * none. This is the one delivery fact the manifest could not already
     * state: duration, language, and audio ownership are declared above and
     * in `audio`, so the retired shotlist.json only restated them. */
    caption_mode: z.string().trim().min(1).optional(),
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

function isEnglishAllCaps(value: string): boolean {
  const letters = value.match(/[A-Za-z]/g) || [];
  return letters.length >= 2 && /[A-Z]/.test(value) && !/[a-z]/.test(value);
}

function isShortUppercaseCode(value: string): boolean {
  const text = value.replace(/\s+/g, ' ').trim();
  return /^[A-Z]{2,4}$/.test(text)
    || (/^[A-Z0-9][A-Z0-9._/+:-]{1,7}$/.test(text) && /[0-9._/+:-]/.test(text));
}

function isBoundedUppercaseAccent(value: string): boolean {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length <= 24
    && text.split(/\s+/).filter(Boolean).length <= 3
    && isEnglishAllCaps(text);
}

export function validateCompositionManifestSemantics(manifest: CompositionManifest): ContractIssue[] {
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
    if (/^en(?:-|$)/i.test(manifest.composition.language || '')) {
      const uppercaseCopy = scene.approved_copy.filter(isEnglishAllCaps);
      const hasAccentRole = scene.roles.some((role) => (
        ['label', 'eyebrow', 'metadata', 'code'].includes(role.trim().toLowerCase())
      ));
      const allowsOneBoundedAccent = uppercaseCopy.length === 1
        && (
          isShortUppercaseCode(uppercaseCopy[0])
          || (hasAccentRole && isBoundedUppercaseAccent(uppercaseCopy[0]))
        );
      if (!allowsOneBoundedAccent) {
        for (const copy of uppercaseCopy) {
          issues.push({
            code: 'COMPOSITION_MANIFEST_PRIMARY_COPY_ALL_CAPS',
            severity: 'error',
            selector: `composition-manifest.json#scenes.${index}.approved_copy`,
            sceneId: scene.id,
            message: `English scene "${scene.id}" contains all-caps approved copy that is not a single bounded metadata accent.`,
            fixHint: 'Use sentence case or natural title case before production-plan approval; keep at most one short uppercase label, acronym, or code.',
            source: 'orkas-native-composition-manifest',
          });
        }
      }
    }
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
  const issues = validateCompositionManifestSemantics(parsed.data);
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
      ...(manifest.composition.caption_mode ? { caption_mode: manifest.composition.caption_mode } : {}),
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
  const narratedIndexes = manifest.scenes.flatMap((scene, index) => (
    scene.narration_text?.trim() ? [index] : []
  ));
  const firstNarrated = narratedIndexes[0] ?? 0;
  const narrationStart = Math.round(
    manifest.scenes.slice(0, firstNarrated).reduce((sum, scene) => sum + scene.duration, 0) * 1000,
  ) / 1000;
  const tracks = manifest.audio.tracks
    .filter((track) => track.kind !== 'narration')
    .concat([{
      id: 'narration',
      kind: 'narration' as const,
      src: 'assets/narration.mp3',
      start: narrationStart,
      duration: narrationDuration,
      volume: 1,
    }]);
  const narratedSceneCapacity = manifest.scenes.reduce((sum, scene) => (
    scene.narration_text?.trim() ? sum + scene.duration : sum
  ), 0);
  // A shorter take fits inside the already-authored visual windows. Preserve
  // those windows exactly and leave the remainder as a visual hold/silence;
  // redistributing it would turn an audio-only edit into a visual change and
  // invalidate a preview whose pixels did not need to move.
  if (narratedIndexes.length > 0 && narrationDuration <= narratedSceneCapacity + 0.001) {
    return {
      ...manifest,
      audio: {
        owner: 'composition',
        tracks,
        ...(manifest.audio.narration_intent ? { narration_intent: manifest.audio.narration_intent } : {}),
      },
    };
  }
  const silentDuration = manifest.scenes.reduce((sum, scene) => (
    scene.narration_text?.trim() ? sum : sum + scene.duration
  ), 0);
  // `target_duration` is the approved delivery target. Measured speech and
  // explicitly silent scene windows are different pieces of that timeline;
  // scaling them together made a 48s narration appear to end at 31s when a
  // silent payoff carried a large authored weight. Reserve the complete
  // measured narration first, preserve silent beats, and expand rather than
  // truncate when their combined duration exceeds the target.
  const duration = Math.round(Math.max(
    manifest.composition.target_duration ?? narrationDuration + silentDuration,
    narrationDuration + silentDuration,
  ) * 1000) / 1000;
  const narrationWeights = manifest.scenes.map((scene, index) => {
    if (!scene.narration_text?.trim()) return 0;
    const supplied = Number(sceneWeights[index]);
    return Number.isFinite(supplied) && supplied > 0 ? supplied : Math.max(0.001, scene.duration);
  });
  const totalNarrationWeight = narrationWeights.reduce((sum, value) => sum + value, 0);
  const deliveryHold = Math.max(0, duration - narrationDuration - silentDuration);
  let cursor = 0;
  const scenes = manifest.scenes.map((scene, index) => {
    const start = Math.round(cursor * 1000) / 1000;
    let sceneDuration: number;
    if (scene.narration_text?.trim()) {
      sceneDuration = narrationDuration * narrationWeights[index] / Math.max(0.001, totalNarrationWeight);
      // Keep a short-read delivery target as a visual hold after the final
      // spoken line. Never fold that hold into a silent scene: its authored
      // duration is the stable reservation used by later fit/materialization
      // calls, while narration-map timing still ends at the measured audio.
      if (index === narratedIndexes.at(-1)) {
        sceneDuration += deliveryHold;
      }
    } else {
      sceneDuration = scene.duration;
    }
    cursor = index === manifest.scenes.length - 1 ? duration : cursor + sceneDuration;
    const end = Math.round(cursor * 1000) / 1000;
    return { ...scene, start, duration: Math.max(0.001, Math.round((end - start) * 1000) / 1000) };
  });
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
  input: {
    textSha256: string;
    audioSha256: string;
    method: 'scene_estimate_scaled' | 'forced_alignment';
    /** Measured length of the audio these lines are claimed to cover. Every
     *  timing below is copied from the manifest, so without this the map
     *  asserts a span nobody checked against the take it names — a 200s claim
     *  sat beside a 175s file on 2026-08-09 and nothing compared them. */
    audioDurationSec?: number;
  },
): Record<string, unknown> {
  const narrationTrack = manifest.audio.tracks.find((track) => track.kind === 'narration');
  const narrationStart = narrationTrack?.start ?? 0;
  const narrationDuration = input.audioDurationSec ?? narrationTrack?.duration ?? 0;
  const narrationEnd = narrationStart + narrationDuration;
  const narratedScenes = manifest.scenes.filter((scene) => !!scene.narration_text?.trim());
  const lines = manifest.scenes.flatMap((scene) => {
    const text = scene.narration_text?.trim() || '';
    if (!text) return [];
    const ids = scene.narration_refs.length ? scene.narration_refs : [`narration-${scene.id}`];
    const sceneIndex = narratedScenes.findIndex((candidate) => candidate.id === scene.id);
    const nextNarratedStart = narratedScenes[sceneIndex + 1]?.start ?? narrationEnd;
    const lineStart = Math.max(narrationStart, scene.start);
    const lineEnd = Math.min(narrationEnd, nextNarratedStart);
    return ids.map((id) => ({
      id,
      scene_id: scene.id,
      start: Math.round(lineStart * 1000) / 1000,
      duration: Math.max(0.001, Math.round((lineEnd - lineStart) * 1000) / 1000),
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
    narration_audio_start: Math.round(narrationStart * 1000) / 1000,
    ...(typeof input.audioDurationSec === 'number'
      ? { narration_audio_duration: Math.round(input.audioDurationSec * 1000) / 1000 }
      : {}),
    narration_audio_end: Math.round(narrationEnd * 1000) / 1000,
    timing_evidence: {
      audio_duration: 'measured_media_probe',
      line_timing: input.method === 'forced_alignment'
        ? 'forced_alignment'
        : 'scene_projection_over_measured_audio',
    },
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

  // Scaffolds generated since the data-driven visibility loop landed carry no
  // per-scene setter here: the loop reads the data-start/data-duration this
  // function just rewrote, so those compositions are already retimed. The
  // per-scene rewrite below is the legacy path for compositions scaffolded
  // before that, and it is why `reconciledSceneIds` exists — a file that
  // matched SOME scenes and not others is half-retimed, which renders the
  // wrong scene at the sampled second and used to pass silently, because a
  // String.replace that matches nothing returns the input unchanged.
  const reconciledSceneIds: string[] = [];
  for (const [index, scene] of manifest.scenes.entries()) {
    const selector = JSON.stringify(`#scene-${scene.id.replace(/(["\\])/g, '\\$1')}`);
    const selectorPattern = escapeRegExp(selector);
    const showRe = new RegExp(`tl\\.set\\(\\s*${selectorPattern}\\s*,\\s*\\{\\s*autoAlpha\\s*:\\s*1\\s*\\}\\s*,\\s*-?[0-9.]+\\s*\\);`);
    if (!showRe.test(next)) continue;
    next = next.replace(showRe, `tl.set(${selector}, { autoAlpha: 1 }, ${scene.start});`);
    reconciledSceneIds.push(scene.id);
    if (index < manifest.scenes.length - 1) {
      const hideRe = new RegExp(`tl\\.set\\(\\s*${selectorPattern}\\s*,\\s*\\{\\s*autoAlpha\\s*:\\s*0\\s*\\}\\s*,\\s*-?[0-9.]+\\s*\\);`);
      next = next.replace(hideRe, `tl.set(${selector}, { autoAlpha: 0 }, ${scene.start + scene.duration});`);
    }
  }
  if (reconciledSceneIds.length && reconciledSceneIds.length < manifest.scenes.length) {
    const unreconciled = manifest.scenes
      .map((scene) => scene.id)
      .filter((id) => !reconciledSceneIds.includes(id));
    issues.push({
      code: 'COMPOSITION_VISIBILITY_TIMING_UNRECONCILED',
      severity: 'error',
      selector: 'index.html',
      message: `Measured scene timing was applied to ${reconciledSceneIds.length} of ${manifest.scenes.length} scene visibility setters; ${unreconciled.slice(0, 6).join(', ')} still play on their pre-measurement window.`,
      fixHint: 'Let the runtime own scene visibility: drive it from each section\'s data-start/data-duration instead of writing the seconds into the timeline.',
      source: 'orkas-native-composition-reconcile',
    });
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

/**
 * Timeline calls whose POSITION argument is a timeline second, by arity.
 * `tl.to(target, vars)` has no position; only a call that actually reaches the
 * index below is carrying one, which is what keeps `duration: 4` inside a vars
 * object from reading as an absolute second. `call(callback, params, position)`
 * carries its position third — reading params as the position would flag their
 * values with a bogus replacement while missing the real literal.
 */
const TIMELINE_POSITION_ARG_INDEX: Record<string, number> = {
  set: 2, to: 2, from: 2, fromTo: 3, add: 1, addLabel: 1, call: 2,
};

/** Timing tolerance shared with the scene-window checks in inspect. */
const TIMELINE_POSITION_TOLERANCE_SEC = 0.15;

export type AuthoredAbsolutePosition = {
  method: string;
  seconds: number;
  line: number;
  suggestion: string;
  /** The scene whose window contains the literal — the one `suggestion`
   *  offsets from. `scenes` is non-empty by the guard, so there is always one. */
  scene_id: string;
};

/** Split one call's top-level arguments, respecting nesting and strings. */
function splitCallArguments(source: string, openIndex: number): { args: string[]; endIndex: number } | null {
  const args: string[] = [];
  let depth = 0;
  let quote = '';
  let current = '';
  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      current += ch;
      if (ch === '\\') { current += source[++i] ?? ''; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; current += ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
      if (depth === 1) continue;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) { args.push(current.trim()); return { args, endIndex: i }; }
    } else if (ch === ',' && depth === 1) {
      args.push(current.trim());
      current = '';
      continue;
    }
    if (depth >= 1) current += ch;
  }
  return null;
}

/**
 * Timeline positions written as absolute seconds instead of `S(id)` offsets.
 *
 * The scene windows these literals encode are recomputed from the measured
 * narration audio, and that can happen after the HTML is authored — a TTS
 * retry reaches `materialize_narration` on an already-authored file. On
 * 2026-08-08 that left 46 literals pointing one scene off; the model spent 11
 * minutes and 13 round trips transcribing new ones by hand and did not finish.
 * The host knows every window, so it can hand back the exact replacement
 * expression rather than only the complaint.
 */
export function authoredAbsoluteTimelinePositions(
  html: string,
  scenes: { id: string; start: number; duration: number }[],
): AuthoredAbsolutePosition[] {
  const found: AuthoredAbsolutePosition[] = [];
  if (!scenes.length) return found;
  const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let scriptMatch: RegExpExecArray | null;
  while ((scriptMatch = scriptRe.exec(html)) !== null) {
    const script = scriptMatch[1];
    const scriptOffset = scriptMatch.index + scriptMatch[0].indexOf(script);
    const callRe = /\btl\s*\.\s*(set|to|from|fromTo|add|addLabel|call)\s*\(/g;
    let call: RegExpExecArray | null;
    while ((call = callRe.exec(script)) !== null) {
      const parsed = splitCallArguments(script, call.index + call[0].length - 1);
      if (!parsed) continue;
      callRe.lastIndex = parsed.endIndex;
      const method = call[1];
      const position = parsed.args[TIMELINE_POSITION_ARG_INDEX[method]];
      if (!position) continue;
      // `S(id) + 0.2` is the offset form this check exists to promote, and a
      // string position ("+=1", "<", a label) is relative to another tween
      // rather than to the timeline, so both survive a retime unchanged.
      if (/\b[SD]\s*\(/.test(position) || /^["'`]/.test(position)) continue;
      const literals = (position.match(/(?<![\w.])\d+(?:\.\d+)?/g) || []).map(Number);
      const seconds = literals.find((value) => value > TIMELINE_POSITION_TOLERANCE_SEC);
      if (seconds === undefined) continue;
      const owner = scenes.find((scene) => seconds >= scene.start && seconds < scene.start + scene.duration)
        || scenes[scenes.length - 1];
      const offset = Math.round((seconds - owner.start) * 1000) / 1000;
      found.push({
        method,
        seconds,
        line: html.slice(0, scriptOffset + call.index).split('\n').length,
        suggestion: offset === 0
          ? `S(${JSON.stringify(owner.id)})`
          : `S(${JSON.stringify(owner.id)}) + ${offset}`,
        scene_id: owner.id,
      });
    }
  }
  return found;
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
      // Scene windows live on each section's data-start/data-duration. They are
      // re-measured from the generated narration audio, which can happen AFTER
      // this file is authored, so a timeline second written as a literal here
      // points at the wrong scene from that moment on. Position every tween
      // with S(id)/D(id) and it survives any retiming untouched.
      const sceneEl = (id) => document.querySelector('[data-scene-id="' + id + '"]');
      const S = (id) => Number(sceneEl(id).dataset.start);      // scene start, seconds
      const D = (id) => Number(sceneEl(id).dataset.duration);   // scene duration, seconds

      // Scene visibility is runtime-owned: it reads the same attributes and is
      // already correct after a retime. Do not author, move, or replace it.
      // Keyed on start rather than DOM order, so moving a section in the markup
      // cannot decide which scene holds to the end.
      const sceneNodes = Array.from(document.querySelectorAll('[data-scene-id]'));
      const lastStart = Math.max(...sceneNodes.map((node) => Number(node.dataset.start)));
      sceneNodes.forEach((node) => {
        const start = Number(node.dataset.start);
        tl.set(node, { autoAlpha: 1 }, start);
        if (start < lastStart) {
          tl.set(node, { autoAlpha: 0 }, start + Number(node.dataset.duration));
        }
      });

      // Add deterministic scene motion to tl. Do not control audio/video imperatively.
      // Keep each scene's tweens inside its own marked block below and target
      // only elements inside that scene's section; that keeps the composition
      // scene-attributable so unchanged scenes can skip re-rendering.
${manifest.scenes.map((scene) => [
    `      // ORKAS-SCENE-MOTION-BEGIN:${scene.id}`,
    `      // Tweens for scene "${scene.id}" only, positioned from S(${JSON.stringify(scene.id)}) — for example:`,
    `      //   tl.from('[data-scene-id="${scene.id}"] [data-role="title"]', { y: 40, duration: 0.6 }, S(${JSON.stringify(scene.id)}) + 0.2);`,
    `      //   tl.to('[data-scene-id="${scene.id}"] [data-role="visual"]', { x: 240, duration: D(${JSON.stringify(scene.id)}) }, S(${JSON.stringify(scene.id)}));`,
    `      // ORKAS-SCENE-MOTION-END:${scene.id}`,
  ].join('\n')).join('\n')}
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

/**
 * Visual-identity normalization.
 *
 * The preview (a silent contact sheet) attests visual content only, but its
 * gate entry historically bound the full composition signature — including
 * narration text and audio bytes. Any narration change therefore invalidated
 * a visually identical preview and cost the user a duplicate confirmation.
 *
 * These two functions produce the visual projection of the composition:
 * everything the silent preview can show, nothing it cannot. The HTML
 * Scene windows remain visual: moving them changes which pixels appear at a
 * sampled time. Only narration/audio bindings are neutralized. A shorter take
 * now preserves the existing windows, so it keeps identity without hiding a
 * real timeline change.
 */

export function visualProjectionOfCompositionManifest(raw: unknown): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (!value || typeof value !== 'object') return value;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonical((value as Record<string, unknown>)[key]);
    }
    return out;
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return JSON.stringify(raw ?? null);
  const manifest = raw as Record<string, unknown>;
  const projected: Record<string, unknown> = { ...manifest };
  delete projected.audio;
  if (manifest.composition && typeof manifest.composition === 'object' && !Array.isArray(manifest.composition)) {
    const composition = { ...(manifest.composition as Record<string, unknown>) };
    delete composition.target_duration;
    projected.composition = composition;
  }
  if (Array.isArray(manifest.scenes)) {
    projected.scenes = manifest.scenes.map((scene) => {
      if (!scene || typeof scene !== 'object' || Array.isArray(scene)) return scene;
      const visual = { ...(scene as Record<string, unknown>) };
      delete visual.narration_text;
      delete visual.narration_refs;
      return visual;
    });
  }
  return JSON.stringify(canonical(projected));
}

export function normalizeCompositionHtmlForVisualIdentity(html: string): string {
  let next = html;
  // The protected composition root always starts at zero. Older authored
  // files may omit that default and reconciliation materializes it; absence
  // versus explicit zero cannot change a frame.
  next = next.replace(
    /<([a-z][\w:-]*)\b[^>]*\bdata-composition-id=(?:"[^"]*"|'[^']*')[^>]*>/gi,
    (tag) => setOpeningTagAttribute(tag, 'data-start', '0'),
  );
  // Declarative audio elements are runtime-owned and invisible to the preview.
  // Reconcile inserts them with their own indentation, so the element and its
  // surrounding whitespace reduce to one newline, and whitespace-only line
  // runs collapse afterwards — identity must not hinge on insertion residue.
  next = next.replace(/\s*<audio\b[^>]*\bdata-start=(?:"[^"]*"|'[^']*')[^>]*>(?:\s*<\/audio>)?\s*/gi, '\n');
  next = next.replace(/\n[ \t]*(?:\n[ \t]*)+/g, '\n');
  return next;
}

/** P3c R1: scene attribution. Decomposes a composition page into a shared
 * surface plus per-scene (subtree, motion region) pairs so later renders can
 * attribute changes to individual scenes. Attribution is advisory: any
 * malformed or ambiguous structure yields attributable:false and the
 * composition simply keeps rendering the whole-page way — never an error. */
export type SceneAttributionDecomposition = {
  attributable: boolean;
  reasons: string[];
  scene_subtrees: Record<string, string>;
  scene_motion_regions: Record<string, string>;
  shared_surface: string;
};

function extractBalancedElement(html: string, openTagMatch: RegExpExecArray, tagName: string): string | null {
  const openRe = new RegExp(`<${tagName}\\b`, 'gi');
  const closeRe = new RegExp(`</${tagName}\\s*>`, 'gi');
  let depth = 1;
  let cursor = openTagMatch.index + openTagMatch[0].length;
  while (depth > 0) {
    openRe.lastIndex = cursor;
    closeRe.lastIndex = cursor;
    const nextOpen = openRe.exec(html);
    const nextClose = closeRe.exec(html);
    if (!nextClose) return null;
    if (nextOpen && nextOpen.index < nextClose.index) {
      depth += 1;
      cursor = nextOpen.index + nextOpen[0].length;
    } else {
      depth -= 1;
      cursor = nextClose.index + nextClose[0].length;
    }
  }
  return html.slice(openTagMatch.index, cursor);
}

export function decomposeCompositionSceneAttribution(
  html: string,
  manifest: CompositionManifest,
): SceneAttributionDecomposition {
  const reasons: string[] = [];
  const sceneSubtrees: Record<string, string> = {};
  const sceneMotionRegions: Record<string, string> = {};
  let shared = html;

  for (const scene of manifest.scenes) {
    const escapedId = escapeRegExp(scene.id);
    const sectionRe = new RegExp(`<([a-z][\\w:-]*)\\b[^>]*\\bdata-scene-id=(?:"${escapedId}"|'${escapedId}')[^>]*>`, 'gi');
    const first = sectionRe.exec(html);
    if (!first) {
      reasons.push(`scene "${scene.id}" has no [data-scene-id] element`);
      continue;
    }
    if (sectionRe.exec(html)) {
      reasons.push(`scene "${scene.id}" has more than one [data-scene-id] element`);
      continue;
    }
    const subtree = extractBalancedElement(html, first, first[1]);
    if (!subtree) {
      reasons.push(`scene "${scene.id}" section never closes`);
      continue;
    }
    sceneSubtrees[scene.id] = subtree;

    const beginMarker = `// ORKAS-SCENE-MOTION-BEGIN:${scene.id}`;
    const endMarker = `// ORKAS-SCENE-MOTION-END:${scene.id}`;
    const beginAt = html.indexOf(beginMarker);
    const endAt = html.indexOf(endMarker);
    if (beginAt < 0 || endAt < 0) {
      reasons.push(`scene "${scene.id}" has no motion region markers`);
      continue;
    }
    if (endAt < beginAt
      || html.indexOf(beginMarker, beginAt + beginMarker.length) >= 0
      || html.indexOf(endMarker, endAt + endMarker.length) >= 0) {
      reasons.push(`scene "${scene.id}" motion region markers are duplicated or out of order`);
      continue;
    }
    const region = html.slice(beginAt + beginMarker.length, endAt);
    if (manifest.scenes.some((other) => other.id !== scene.id
      && (region.includes(`// ORKAS-SCENE-MOTION-BEGIN:${other.id}`) || region.includes(`// ORKAS-SCENE-MOTION-END:${other.id}`)))) {
      reasons.push(`scene "${scene.id}" motion region nests another scene's markers`);
      continue;
    }
    sceneMotionRegions[scene.id] = region;
  }

  const attributable = reasons.length === 0
    && manifest.scenes.length > 0
    && manifest.scenes.every((scene) => scene.id in sceneSubtrees && scene.id in sceneMotionRegions);
  if (attributable) {
    for (const scene of manifest.scenes) {
      shared = shared.replace(sceneSubtrees[scene.id], `<!--orkas-scene:${scene.id}-->`);
      const beginMarker = `// ORKAS-SCENE-MOTION-BEGIN:${scene.id}`;
      const endMarker = `// ORKAS-SCENE-MOTION-END:${scene.id}`;
      const beginAt = shared.indexOf(beginMarker);
      const endAt = shared.indexOf(endMarker);
      if (beginAt >= 0 && endAt > beginAt) {
        shared = `${shared.slice(0, beginAt + beginMarker.length)}/*orkas-scene-motion:${scene.id}*/${shared.slice(endAt)}`;
      }
    }
  }
  return {
    attributable,
    reasons,
    scene_subtrees: sceneSubtrees,
    scene_motion_regions: sceneMotionRegions,
    shared_surface: attributable ? normalizeCompositionHtmlForVisualIdentity(shared) : '',
  };
}
