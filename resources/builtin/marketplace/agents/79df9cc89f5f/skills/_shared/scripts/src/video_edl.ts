/**
 * video_edl — the cross-modal Edit Decision List (EDL) that is the spine of the
 * end-to-end video-studio orchestration. One `plan.json` per project describes
 * the whole deliverable: a delivery promise, a style kit, an ordered list of
 * segments (each tagged with how it is produced — edit / generate / compose /
 * provided — and which layer it lives on), and the narration / music / caption
 * tracks. The single video-studio agent authors this file, the user approves it
 * at gate B, and the assembler walks it deterministically.
 *
 * This module is PURE: schema types + `validateEdl` (structural + promise
 * consistency checks, errors vs. warnings) + `summarizeEdl` (an agent-facing,
 * paragraph-level rendering used to present the plan at gate B). It does no IO;
 * the `video_plan` tool layer reads plan.json and owns path-sandbox validation.
 *
 * Design notes:
 * - Validation distinguishes ERRORS (the plan cannot be executed / violates its
 *   own promise) from WARNINGS (smells the agent should reconsider but that do
 *   not block). The agent self-checks before gate B so malformed EDLs surface
 *   deterministically instead of failing deep in assembly.
 * - The promise (`delivery_promise`) is a contract borrowed in spirit from the
 *   "promise preservation" idea: if it says source footage is required, a plan
 *   with no source segment is a hard error, not a stylistic choice.
 */

export type DeliveryPromiseType = 'source_led' | 'motion_led' | 'compose_led' | 'hybrid';
export type SegmentRole = 'hook' | 'body' | 'proof' | 'cta' | 'transition';
export type SegmentLayer = 'primary' | 'overlay' | 'bg';
export type SegmentSource = 'edit' | 'generate' | 'compose' | 'provided';

export const DELIVERY_PROMISE_TYPES: readonly DeliveryPromiseType[] = [
  'source_led',
  'motion_led',
  'compose_led',
  'hybrid',
];
export const SEGMENT_ROLES: readonly SegmentRole[] = ['hook', 'body', 'proof', 'cta', 'transition'];
export const SEGMENT_LAYERS: readonly SegmentLayer[] = ['primary', 'overlay', 'bg'];
export const SEGMENT_SOURCES: readonly SegmentSource[] = ['edit', 'generate', 'compose', 'provided'];
/** How much a generated shot varies from its reference — the cost/consistency
 *  gate (ViMax idea): small = reuse a prior frame (cheapest, most consistent),
 *  large = a fresh shot. Informs the generate executor + the cost estimate. */
export type VariationType = 'small' | 'medium' | 'large';
export const VARIATION_TYPES: readonly VariationType[] = ['small', 'medium', 'large'];

export interface DeliveryPromise {
  type: DeliveryPromiseType;
  /** Hard requirement: the deliverable must contain real source footage. */
  source_required: boolean;
  /** Minimum share [0..1] of runtime that must be real motion (footage/generated
   *  video) rather than static composed cards. Guards against slideshow drift. */
  motion_min_ratio: number;
  /** Free-text floor the QA pass checks against ("broadcast-legible captions",
   *  "no upside-down product", ...). */
  quality_floor?: string;
}

export interface StyleKitMotion {
  ease?: string;
  default_in_sec?: number;
}
export interface StyleKitAudio {
  target_lufs?: number;
  music_duck_db?: number;
}
export interface StyleKit {
  palette?: string[];
  fonts?: string[];
  lut?: string;
  motion?: StyleKitMotion;
  audio?: StyleKitAudio;
}

/** Per-source `spec` is intentionally open (`Record<string, unknown>`): the
 *  validator only enforces the identifying field each source needs to be
 *  executable, and leaves the rest to the stage skills. */
export interface EdlSegment {
  id: string;
  order: number;
  role: SegmentRole;
  layer: SegmentLayer;
  source: SegmentSource;
  target_sec: number;
  /** For overlay/bg layers: the id of the primary segment this sits over. */
  over?: string;
  spec: Record<string, unknown>;
  status?: string;
  produced_path?: string;
  /** Audit trail for a decision-layer cut (trim_silence / remove_fillers / a
   *  selection): what was removed/kept and why, plus a confidence. Optional —
   *  only auto-cut / chosen segments carry it. Makes a cut traceable instead of
   *  a black box. */
  evidence?: Record<string, unknown>;
  reason?: string;
  confidence?: number;
}

export interface NarrationLine {
  text: string;
  start_sec?: number;
  target_sec?: number;
  /** Where this line's synthesized audio landed (set after generate_speech). A
   *  separate path per line lets a later edit re-voice ONE line without touching
   *  the rest — the separability the language-driven workflow depends on. */
  produced_path?: string;
}
export interface NarrationTrack {
  /** Runtime-discovered and Gate B-signed synthesis selection. */
  synthesis?: {
    route_ref: string;
    voice_ref: string;
    display_name: string;
    speed: number;
  };
  /** Legacy plans only; new plans use synthesis. */
  voice?: string;
  segments: NarrationLine[];
}
export interface MusicTrack {
  path?: string;
  volume?: number;
  duck?: boolean | number;
}
/** One editable subtitle: the text plus its on-screen window. Captions live as
 *  DATA here (not burned into pixels), so a user can fix a typo by language and
 *  the assembler re-burns just the .srt — see the language-driven refactor. */
export interface CaptionLine {
  text: string;
  start_sec?: number;
  /** On-screen duration in seconds (end = start_sec + target_sec). */
  target_sec?: number;
}
export interface CaptionsTrack {
  /** Provenance hint when the lines are derived (e.g. "narration"). */
  from?: string;
  style?: string;
  /** The editable caption data the assembler turns into a .srt for burnsubs. */
  lines?: CaptionLine[];
}
export interface EdlTracks {
  /** Disabled tracks are omitted or null. The validator also tolerates legacy
   *  empty objects as disabled (with a warning) so an old plan cannot turn an
   *  empty declaration into a late assembly failure. */
  narration?: NarrationTrack | null;
  music?: MusicTrack | null;
  captions?: CaptionsTrack | null;
}

export interface CostEstimate {
  billable_generations: number;
  note?: string;
}

export interface VideoEdl {
  aspect: string;
  total_target_sec: number;
  language: string;
  delivery_promise: DeliveryPromise;
  style_kit?: StyleKit;
  segments: EdlSegment[];
  tracks?: EdlTracks;
  cost_estimate?: CostEstimate;
}

export interface EdlIssue {
  level: 'error' | 'warning';
  path: string;
  code: string;
  message: string;
}
export interface EdlValidation {
  ok: boolean;
  errors: EdlIssue[];
  warnings: EdlIssue[];
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/**
 * Validate a parsed plan.json against the EDL contract. Returns every issue
 * found (does not short-circuit) so the agent can fix the plan in one pass.
 * `ok` is true only when there are zero ERROR-level issues; warnings never
 * block.
 */
export function validateEdl(obj: unknown): EdlValidation {
  const issues: EdlIssue[] = [];
  const err = (path: string, code: string, message: string) =>
    issues.push({ level: 'error', path, code, message });
  const warn = (path: string, code: string, message: string) =>
    issues.push({ level: 'warning', path, code, message });

  if (!isObject(obj)) {
    return {
      ok: false,
      errors: [{ level: 'error', path: '$', code: 'E_NOT_OBJECT', message: 'plan is not a JSON object' }],
      warnings: [],
    };
  }

  // --- top-level scalars ---------------------------------------------------
  if (!isStr(obj.aspect)) {
    err('aspect', 'E_ASPECT_MISSING', 'aspect is required (e.g. "9:16", "16:9", "1:1")');
  } else if (!/^\d+:\d+$/.test(obj.aspect)) {
    warn('aspect', 'W_ASPECT_FORMAT', `aspect "${obj.aspect}" is not W:H (e.g. "9:16")`);
  }
  if (!isNum(obj.total_target_sec) || obj.total_target_sec <= 0) {
    err('total_target_sec', 'E_TOTAL_SEC', 'total_target_sec must be a positive number');
  }
  if (!isStr(obj.language)) {
    err('language', 'E_LANGUAGE_MISSING', 'language is required (BCP-47 or natural name)');
  }

  // --- delivery_promise ----------------------------------------------------
  const promise = obj.delivery_promise;
  if (!isObject(promise)) {
    err('delivery_promise', 'E_PROMISE_MISSING', 'delivery_promise is required');
  } else {
    if (!DELIVERY_PROMISE_TYPES.includes(promise.type as DeliveryPromiseType)) {
      err(
        'delivery_promise.type',
        'E_PROMISE_TYPE',
        `type must be one of ${DELIVERY_PROMISE_TYPES.join(' | ')}`,
      );
    }
    if (promise.motion_min_ratio !== undefined) {
      if (!isNum(promise.motion_min_ratio) || promise.motion_min_ratio < 0 || promise.motion_min_ratio > 1) {
        warn('delivery_promise.motion_min_ratio', 'W_MOTION_RATIO_RANGE', 'motion_min_ratio should be in [0,1]');
      } else if (promise.type === 'compose_led' && promise.motion_min_ratio > 0) {
        warn(
          'delivery_promise.motion_min_ratio',
          'W_COMPOSE_MOTION_FLOOR_IGNORED',
          'compose_led uses native HTML motion QA; its real-footage motion_min_ratio is treated as 0',
        );
      }
    }
  }

  // --- segments ------------------------------------------------------------
  const rawSegments = obj.segments;
  const segments: Array<Record<string, unknown>> = [];
  if (!Array.isArray(rawSegments) || rawSegments.length === 0) {
    err('segments', 'E_SEGMENTS_EMPTY', 'segments must be a non-empty array');
  } else {
    const ids = new Set<string>();
    const orders = new Set<number>();
    for (let i = 0; i < rawSegments.length; i++) {
      const s = rawSegments[i];
      const at = `segments[${i}]`;
      if (!isObject(s)) {
        err(at, 'E_SEG_NOT_OBJECT', 'segment is not an object');
        continue;
      }
      segments.push(s);
      if (!isStr(s.id)) {
        err(`${at}.id`, 'E_SEG_ID', 'segment id is required');
      } else if (ids.has(s.id)) {
        err(`${at}.id`, 'E_SEG_ID_DUP', `duplicate segment id "${s.id}"`);
      } else {
        ids.add(s.id);
      }
      if (!isNum(s.order)) {
        err(`${at}.order`, 'E_SEG_ORDER', 'segment order must be a number');
      } else if (orders.has(s.order)) {
        warn(`${at}.order`, 'W_ORDER_DUP', `duplicate order ${s.order} (assembly order is ambiguous)`);
      } else {
        orders.add(s.order);
      }
      if (!SEGMENT_ROLES.includes(s.role as SegmentRole)) {
        err(`${at}.role`, 'E_SEG_ROLE', `role must be one of ${SEGMENT_ROLES.join(' | ')}`);
      }
      if (!SEGMENT_LAYERS.includes(s.layer as SegmentLayer)) {
        err(`${at}.layer`, 'E_SEG_LAYER', `layer must be one of ${SEGMENT_LAYERS.join(' | ')}`);
      }
      if (!SEGMENT_SOURCES.includes(s.source as SegmentSource)) {
        err(`${at}.source`, 'E_SEG_SOURCE', `source must be one of ${SEGMENT_SOURCES.join(' | ')}`);
      }
      if (!isNum(s.target_sec) || s.target_sec <= 0) {
        err(`${at}.target_sec`, 'E_SEG_TARGET_SEC', 'target_sec must be a positive number');
      }
      validateSpec(s, at, err, warn);
    }

    // primary track must exist
    if (segments.length > 0 && !segments.some((s) => s.layer === 'primary')) {
      err('segments', 'E_NO_PRIMARY', 'at least one segment must be on the primary layer');
    }

    // `over` references must resolve, and only make sense on overlay/bg layers
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      if (s.over === undefined) continue;
      const at = `segments[${i}].over`;
      if (!isStr(s.over) || !ids.has(s.over)) {
        err(at, 'E_OVER_UNKNOWN', `over references unknown segment id "${String(s.over)}"`);
      } else if (s.layer === 'primary') {
        warn(at, 'W_OVER_LAYER', 'a primary segment should not set `over` (overlays/bg sit over primary)');
      }
    }
  }

  // --- promise vs. segments consistency -----------------------------------
  if (isObject(promise) && segments.length > 0) {
    const primaries = segments.filter((s) => s.layer === 'primary');
    const hasSource = primaries.some((s) => s.source === 'edit'
      || (s.source === 'provided' && isObject(s.spec) && s.spec.kind === 'video'));
    if (promise.source_required === true && !hasSource) {
      err(
        'delivery_promise.source_required',
        'E_PROMISE_NO_SOURCE',
        'source_required is true but no primary segment uses real footage (edit or provided kind=video)',
      );
    }
    if (promise.type === 'compose_led' && !segments.some((s) => s.source === 'compose')) {
      warn('delivery_promise.type', 'W_PROMISE_TYPE_MISMATCH', 'compose_led promise but no compose segment');
    }
    if (promise.type === 'motion_led' && !segments.some((s) => s.source === 'generate' || s.source === 'edit')) {
      warn('delivery_promise.type', 'W_PROMISE_TYPE_MISMATCH', 'motion_led promise but no generated/edited motion segment');
    }

    // duration drift: primary-layer target_sec sum vs. total_target_sec
    if (isNum(obj.total_target_sec) && obj.total_target_sec > 0) {
      const primarySec = primaries.reduce((acc, s) => acc + (isNum(s.target_sec) ? s.target_sec : 0), 0);
      if (primarySec > 0) {
        const drift = Math.abs(primarySec - obj.total_target_sec) / obj.total_target_sec;
        if (drift > 0.25) {
          warn(
            'segments',
            'W_DURATION_DRIFT',
            `primary segments sum to ${round1(primarySec)}s but total_target_sec is ${obj.total_target_sec}s (${Math.round(drift * 100)}% off)`,
          );
        }
      }
    }
  }

  // --- tracks --------------------------------------------------------------
  const tracks = obj.tracks;
  if (tracks !== undefined) {
    if (!isObject(tracks)) {
      err('tracks', 'E_TRACKS_NOT_OBJECT', 'tracks must be an object');
    } else {
      const nar = tracks.narration;
      if (nar !== undefined && nar !== null && !isObject(nar)) {
        err('tracks.narration', 'E_NARRATION_NOT_OBJECT', 'narration must be an object, null, or omitted');
      } else if (isObject(nar)) {
        if (nar.segments !== undefined && !Array.isArray(nar.segments)) {
          err('tracks.narration.segments', 'E_NARRATION_SEGMENTS', 'narration.segments must be an array of timed lines');
        } else if (Array.isArray(nar.segments) && nar.segments.length > 0) {
          if (isObject(nar.synthesis)) {
            if (!isStr(nar.synthesis.route_ref)
              || !isStr(nar.synthesis.voice_ref)
              || !isStr(nar.synthesis.display_name)
              || !isStr(nar.synthesis.language)
              || !/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(nar.synthesis.language)
              || !isNum(nar.synthesis.speed)
              || nar.synthesis.speed < 0.5
              || nar.synthesis.speed > 2) {
              err(
                'tracks.narration.synthesis',
                'E_NARRATION_SYNTHESIS',
                'synthesis requires route_ref, voice_ref, display_name, language, and speed 0.5–2 from video_studio speech.capabilities',
              );
            }
          } else if (isStr(nar.voice)) {
            warn(
              'tracks.narration.voice',
              'W_NARRATION_LEGACY_VOICE',
              'legacy raw voice ids are compatibility-only; new plans must sign tracks.narration.synthesis from speech.capabilities',
            );
          } else {
            err('tracks.narration.synthesis', 'E_NARRATION_SYNTHESIS', 'an active narration track requires a signed synthesis selection from speech.capabilities');
          }
          nar.segments.forEach((ln, i) => {
            if (!isObject(ln) || !isStr(ln.text)) {
              err(`tracks.narration.segments[${i}].text`, 'E_NARRATION_LINE_TEXT', 'each narration line needs non-empty text');
            } else if (ln.produced_path !== undefined && !isStr(ln.produced_path)) {
              warn(`tracks.narration.segments[${i}].produced_path`, 'W_NARRATION_PRODUCED', 'produced_path should be a string path when present');
            }
          });
        } else {
          warn(
            'tracks.narration',
            'W_EMPTY_TRACK_DISABLED',
            'empty narration is treated as disabled; omit it or use null instead of an empty object',
          );
        }
      }

      const music = tracks.music;
      if (music !== undefined && music !== null && !isObject(music)) {
        err('tracks.music', 'E_MUSIC_NOT_OBJECT', 'music must be an object, null, or omitted');
      } else if (isObject(music) && !isStr(music.path)) {
        warn(
          'tracks.music',
          'W_EMPTY_TRACK_DISABLED',
          'music without a path is treated as disabled; omit it or use null instead of an empty object',
        );
      }

      const caps = tracks.captions;
      if (caps !== undefined && caps !== null && !isObject(caps)) {
        err('tracks.captions', 'E_CAPTIONS_NOT_OBJECT', 'captions must be an object, null, or omitted');
      } else if (isObject(caps)) {
        if (caps.lines !== undefined && !Array.isArray(caps.lines)) {
          err('tracks.captions.lines', 'E_CAPTIONS_LINES', 'captions.lines must be an array of {text, start_sec, target_sec}');
        } else if (Array.isArray(caps.lines) && caps.lines.length > 0) {
          caps.lines.forEach((ln, i) => {
            if (!isObject(ln) || !isStr(ln.text)) {
              err(`tracks.captions.lines[${i}].text`, 'E_CAPTION_LINE_TEXT', 'each caption line needs non-empty text');
            } else {
              if (ln.start_sec !== undefined && !isNum(ln.start_sec)) {
                warn(`tracks.captions.lines[${i}].start_sec`, 'W_CAPTION_TIMING', 'start_sec should be a number');
              }
              if (ln.target_sec !== undefined && !isNum(ln.target_sec)) {
                warn(`tracks.captions.lines[${i}].target_sec`, 'W_CAPTION_TIMING', 'target_sec (on-screen seconds) should be a number');
              }
            }
          });
        } else if (!isStr(caps.from)) {
          warn(
            'tracks.captions',
            'W_CAPTIONS_EMPTY',
            'empty captions are treated as disabled; omit them or use null instead of an empty object',
          );
        }
      }
    }
  }

  // --- style kit (the look — surfaced + approved at gate B) ----------------
  const styleKit = obj.style_kit;
  if (styleKit !== undefined) {
    if (!isObject(styleKit)) {
      warn('style_kit', 'W_STYLE_KIT', 'style_kit should be an object (palette / fonts / lut / motion / audio)');
    } else {
      if (styleKit.palette !== undefined && !Array.isArray(styleKit.palette)) {
        warn('style_kit.palette', 'W_STYLE_KIT', 'palette should be an array of colors');
      }
      if (styleKit.fonts !== undefined && !Array.isArray(styleKit.fonts)) {
        warn('style_kit.fonts', 'W_STYLE_KIT', 'fonts should be an array of font names');
      }
    }
  }

  // --- cost estimate -------------------------------------------------------
  const generateCount = segments.filter((s) => s.source === 'generate').length;
  const cost = obj.cost_estimate;
  const billable = isObject(cost) && isNum(cost.billable_generations)
    ? cost.billable_generations
    : 0;
  if (generateCount !== billable) {
    err(
      'cost_estimate.billable_generations',
      'E_COST_COUNT_MISMATCH',
      `cost_estimate.billable_generations=${billable} but the plan has ${generateCount} generate segment(s); Gate C must show the exact count`,
    );
  }

  const errors = issues.filter((x) => x.level === 'error');
  const warnings = issues.filter((x) => x.level === 'warning');
  return { ok: errors.length === 0, errors, warnings };
}

function validateSpec(
  s: Record<string, unknown>,
  at: string,
  err: (path: string, code: string, message: string) => void,
  warn: (path: string, code: string, message: string) => void,
): void {
  const spec = s.spec;
  if (!isObject(spec)) {
    err(`${at}.spec`, 'E_SEG_SPEC_MISSING', 'segment spec object is required');
    return;
  }
  switch (s.source) {
    case 'edit': {
      if (!isStr(spec.input_id)) {
        err(`${at}.spec.input_id`, 'E_SPEC_EDIT_FIELDS', 'edit spec needs input_id (the ingested source clip)');
      }
      const inSec = spec.in_sec;
      const outSec = spec.out_sec;
      if (!isNum(inSec) || !isNum(outSec)) {
        err(`${at}.spec`, 'E_SPEC_EDIT_FIELDS', 'edit spec needs numeric in_sec / out_sec');
      } else if (outSec <= inSec) {
        err(`${at}.spec.out_sec`, 'E_SPEC_EDIT_RANGE', `out_sec (${outSec}) must be greater than in_sec (${inSec})`);
      }
      break;
    }
    case 'generate': {
      if (!isStr(spec.prompt)) {
        err(`${at}.spec.prompt`, 'E_SPEC_GENERATE_PROMPT', 'generate spec needs a prompt');
      }
      if (spec.duration_sec !== undefined || spec.audio !== undefined) {
        err(
          `${at}.spec`,
          'E_SPEC_GENERATE_SETTINGS_ALIAS',
          'use generation_duration_sec and generate_audio; duration_sec/audio are ignored aliases and cannot be approved',
        );
      }
      if (spec.media_kind !== undefined && spec.media_kind !== 'video' && spec.media_kind !== 'image') {
        err(`${at}.spec.media_kind`, 'E_SPEC_GENERATE_KIND', 'generate spec media_kind must be "video" or "image"');
      } else if (spec.media_kind === undefined) {
        warn(`${at}.spec.media_kind`, 'W_SPEC_GENERATE_KIND_DEFAULT', 'missing media_kind defaults to video; declare it explicitly for Gate C');
      }
      const referenceFields = spec.media_kind === 'image'
        ? ['reference_images', 'reference_image_urls']
        : ['reference_image_urls', 'reference_image_paths', 'reference_video_urls', 'reference_video_paths'];
      for (const field of referenceFields) {
        const value = spec[field];
        if (value !== undefined && (!Array.isArray(value) || value.some((item) => !isStr(item)))) {
          err(`${at}.spec.${field}`, 'E_SPEC_GENERATE_REFERENCE', `${field} must be an array of non-empty strings because Gate C signs the exact references`);
        }
      }
      if (spec.media_kind === 'image') {
        if (spec.size !== undefined && !isStr(spec.size)) {
          err(`${at}.spec.size`, 'E_SPEC_GENERATE_SETTINGS', 'image size must be a non-empty string when present');
        }
        if (spec.operation !== undefined) {
          err(`${at}.spec.operation`, 'E_SPEC_GENERATE_SETTINGS', 'image generation does not use operation; declare its references instead');
        }
      } else {
        if (spec.operation !== undefined && spec.operation !== 'generate' && spec.operation !== 'edit') {
          err(`${at}.spec.operation`, 'E_SPEC_GENERATE_SETTINGS', 'video operation must be "generate" or "edit"');
        }
        if (spec.generation_duration_sec !== undefined
          && (!isNum(spec.generation_duration_sec) || spec.generation_duration_sec < 4 || spec.generation_duration_sec > 15)) {
          err(`${at}.spec.generation_duration_sec`, 'E_SPEC_GENERATE_SETTINGS', 'video generation_duration_sec must be between 4 and 15');
        }
        if (spec.resolution !== undefined && !['480p', '720p', '1080p'].includes(String(spec.resolution))) {
          err(`${at}.spec.resolution`, 'E_SPEC_GENERATE_SETTINGS', 'video resolution must be 480p, 720p, or 1080p');
        }
        if (spec.quality !== undefined && !['economy', 'balanced', 'quality'].includes(String(spec.quality))) {
          err(`${at}.spec.quality`, 'E_SPEC_GENERATE_SETTINGS', 'video quality must be economy, balanced, or quality');
        }
        if (spec.generate_audio !== undefined && typeof spec.generate_audio !== 'boolean') {
          err(`${at}.spec.generate_audio`, 'E_SPEC_GENERATE_SETTINGS', 'video generate_audio must be boolean');
        }
      }
      // Optional consistency / cost intent — generation works with just a
      // prompt, so these are soft: a malformed value is a smell, not a blocker.
      if (spec.variation_type !== undefined && !VARIATION_TYPES.includes(spec.variation_type as VariationType)) {
        warn(`${at}.spec.variation_type`, 'W_VARIATION_TYPE', `variation_type should be one of ${VARIATION_TYPES.join(' | ')}`);
      }
      if (spec.characters !== undefined && !Array.isArray(spec.characters)) {
        warn(`${at}.spec.characters`, 'W_GENERATE_CHARACTERS', 'characters should be an array of character ids (consistency)');
      }
      if (spec.refs !== undefined && !Array.isArray(spec.refs)) {
        warn(`${at}.spec.refs`, 'W_GENERATE_REFS', 'refs should be an array of reference image paths/ids');
      }
      break;
    }
    case 'compose': {
      if (!isStr(spec.kind)) {
        err(`${at}.spec.kind`, 'E_SPEC_COMPOSE_KIND', 'compose spec needs a kind (the composition template)');
      }
      const compositionPlan = spec.composition_plan;
      if (!isObject(compositionPlan) || !Array.isArray(compositionPlan.scenes) || compositionPlan.scenes.length === 0) {
        warn(
          `${at}.spec.composition_plan`,
          'W_SPEC_COMPOSE_PLAN',
          'compose spec needs composition_plan.scenes for native parent Gate B inheritance; legacy plans require one parent re-approval',
        );
      } else {
        compositionPlan.scenes.forEach((scene, sceneIndex) => {
          const sceneAt = `${at}.spec.composition_plan.scenes[${sceneIndex}]`;
          if (!isObject(scene) || !isStr(scene.id)) {
            err(`${sceneAt}.id`, 'E_SPEC_COMPOSE_SCENE_ID', 'each compose scene needs an id');
            return;
          }
          if (!Array.isArray(scene.approved_copy) || !scene.approved_copy.every(isStr)) {
            err(`${sceneAt}.approved_copy`, 'E_SPEC_COMPOSE_COPY', 'each compose scene needs approved_copy as a string array');
          }
          if (!Array.isArray(scene.roles) || !scene.roles.every(isStr)) {
            err(`${sceneAt}.roles`, 'E_SPEC_COMPOSE_ROLES', 'each compose scene needs semantic roles');
          }
          if (scene.narration_text !== undefined && typeof scene.narration_text !== 'string') {
            err(`${sceneAt}.narration_text`, 'E_SPEC_COMPOSE_NARRATION', 'compose scene narration_text must be a string when present');
          }
        });
      }
      break;
    }
    case 'provided':
      if (!isStr(spec.asset_id)) {
        err(`${at}.spec.asset_id`, 'E_SPEC_PROVIDED_ASSET', 'provided spec needs asset_id');
      }
      if (spec.kind !== 'video' && spec.kind !== 'image') {
        err(`${at}.spec.kind`, 'E_SPEC_PROVIDED_KIND', 'provided spec kind must be "video" or "image"; unknown kind cannot satisfy source/motion promises');
      }
      break;
    default:
      break; // unknown source already flagged
  }
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
const round2 = (n: number): number => Math.round(n * 100) / 100;
const pct = (n: number): string => `${Math.round(n * 100)}%`;

/**
 * Whether a primary segment is REAL MOTION vs. static slide grammar (the
 * anti-slideshow distinction): footage (edit) and generated video are motion;
 * a composed card is not (even when it animates — an animated text/stat card is
 * still slide grammar, not motion). A `provided` asset is motion unless it is
 * explicitly a still (`spec.kind === 'image'` or `spec.motion === false`) — a
 * supplied still image must not inflate the motion ratio.
 */
function isMotionSegment(s: EdlSegment): boolean {
  if (s.source === 'edit') return true;
  if (s.source === 'generate') return s.spec?.media_kind !== 'image';
  if (s.source === 'provided') {
    const spec = s.spec || {};
    return spec.kind === 'video' && spec.motion !== false;
  }
  return false; // compose = slide grammar
}

/** Default minimum motion ratio per promise type, used when the plan does not
 *  set an explicit `motion_min_ratio`, so the gate still has teeth. Motion-led
 *  must be mostly motion; source/hybrid keep a real-footage floor; compose-led
 *  has none. (Informed by OpenMontage's promise table; values are our own.) */
const PROMISE_DEFAULT_MOTION_FLOOR: Record<DeliveryPromiseType, number> = {
  motion_led: 0.7,
  source_led: 0.3,
  hybrid: 0.2,
  compose_led: 0,
};
/** How far below the motion floor is a borderline "warn" vs. a hard "fail". */
const MOTION_WARN_BAND = 0.1;
/** Run of identical-source primary segments that reads as a one-note slideshow. */
const REPETITION_RUN = 3;

export interface DeliveryAssessment {
  /** Share [0..1] of primary-track runtime that is real motion. */
  motion_ratio: number;
  motion_sec: number;
  total_primary_sec: number;
  source_present: boolean;
  source_required: boolean;
  motion_min_ratio: number;
  source_ok: boolean;
  motion_ok: boolean;
  verdict: 'pass' | 'warn' | 'fail';
  issues: string[];
}

/**
 * Deterministically assess whether a plan keeps its delivery promise — the
 * gate-D guard with teeth, so "is this a slideshow?" is not left to LLM
 * judgment. Computes the motion ratio of the PRIMARY track (real footage /
 * generated video / supplied clips vs. static composed cards) and checks it
 * against `motion_min_ratio`, plus the `source_required` invariant.
 *
 * By default it uses each segment's planned `target_sec`; pass `producedSec`
 * (segment id → actual probed seconds) at gate D to assess the real cut.
 */
export function assessDelivery(edl: VideoEdl, opts: { producedSec?: Record<string, number> } = {}): DeliveryAssessment {
  const segs = Array.isArray(edl.segments) ? edl.segments : [];
  const primaries = segs.filter((s) => s.layer === 'primary');
  const dur = (s: EdlSegment): number => {
    const actual = opts.producedSec?.[s.id];
    if (isNum(actual) && actual > 0) return actual;
    return isNum(s.target_sec) ? s.target_sec : 0;
  };
  const total = primaries.reduce((acc, s) => acc + dur(s), 0);
  const motionSec = primaries.filter(isMotionSegment).reduce((acc, s) => acc + dur(s), 0);
  const motionRatio = total > 0 ? motionSec / total : 0;

  const promise = edl.delivery_promise || ({} as DeliveryPromise);
  const sourceRequired = promise.source_required === true;
  const sourcePresent = primaries.some((s) => s.source === 'edit'
    || (s.source === 'provided' && s.spec?.kind === 'video'));
  // `motion_min_ratio` measures footage/generated motion, not animation inside
  // HTML compositions. Native composition inspect/snapshot/draft owns that
  // motion contract, so compose-led plans always use a zero real-motion floor.
  const motionMin = promise.type === 'compose_led'
    ? 0
    : isNum(promise.motion_min_ratio)
      ? promise.motion_min_ratio
      : (PROMISE_DEFAULT_MOTION_FLOOR[promise.type as DeliveryPromiseType] ?? 0);
  const sourceOk = !sourceRequired || sourcePresent;
  const motionOk = motionMin <= 0 || motionRatio >= motionMin;

  const issues: string[] = [];
  let verdict: 'pass' | 'warn' | 'fail' = 'pass';
  if (!sourceOk) {
    issues.push('promise requires real source footage but the primary track has none');
    verdict = 'fail';
  }
  if (motionMin > 0 && !motionOk) {
    if (motionRatio >= motionMin - MOTION_WARN_BAND) {
      issues.push(`motion ${pct(motionRatio)} is just under the ${pct(motionMin)} floor — borderline slideshow`);
      if (verdict !== 'fail') verdict = 'warn';
    } else {
      issues.push(`motion ${pct(motionRatio)} is well under the ${pct(motionMin)} floor — a slideshow, not the promised ${promise.type || 'video'}`);
      verdict = 'fail';
    }
  }
  // Repetition smell: a long run of the same source on the primary track reads
  // as one-note (a stack of cards / the same clip on loop). Warn, don't block.
  const runSource = longestSameSourceRun(primaries);
  if (runSource.run >= REPETITION_RUN) {
    issues.push(`${runSource.run} consecutive ${runSource.source} segments — vary source/scale so it does not read as a slideshow`);
    if (verdict === 'pass') verdict = 'warn';
  }
  if (total <= 0) {
    issues.push('no primary-track duration to assess');
    if (verdict === 'pass') verdict = 'warn';
  }

  return {
    motion_ratio: round2(motionRatio),
    motion_sec: round2(motionSec),
    total_primary_sec: round2(total),
    source_present: sourcePresent,
    source_required: sourceRequired,
    motion_min_ratio: motionMin,
    source_ok: sourceOk,
    motion_ok: motionOk,
    verdict,
    issues,
  };
}

/** Longest run of consecutive same-`source` segments (in plan order). */
function longestSameSourceRun(primaries: EdlSegment[]): { run: number; source: SegmentSource | '' } {
  const ordered = [...primaries].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  let best = 0;
  let bestSrc: SegmentSource | '' = '';
  let run = 0;
  let prev: SegmentSource | '' = '';
  for (const s of ordered) {
    run = s.source === prev ? run + 1 : 1;
    prev = s.source;
    if (run > best) {
      best = run;
      bestSrc = s.source;
    }
  }
  return { run: best, source: bestSrc };
}

/**
 * Render an agent-facing, paragraph-level summary of the plan for gate B. The
 * agent presents this to the user (in the user's language) before any billable
 * work. Kept deterministic and compact: a header line, the ordered primary
 * timeline with overlays nested, the tracks, and the cost. This is a tool
 * result for the model, not direct user copy, so it stays in English.
 */
export function summarizeEdl(edl: VideoEdl): string {
  const lines: string[] = [];
  const p = edl.delivery_promise || ({} as DeliveryPromise);
  lines.push(
    `Plan: ${edl.aspect || '?'} · ~${edl.total_target_sec || '?'}s · ${edl.language || '?'} · promise=${p.type || '?'}` +
      (p.source_required ? ' · source-required' : '') +
      (p.type === 'compose_led'
        ? ' · HTML-motion=native-QA'
        : isNum(p.motion_min_ratio) ? ` · motion≥${Math.round(p.motion_min_ratio * 100)}%` : ''),
  );
  if (p.quality_floor) lines.push(`Quality floor: ${p.quality_floor}`);

  const sk = edl.style_kit;
  if (sk && isObject(sk)) {
    const bits: string[] = [];
    if (Array.isArray(sk.palette) && sk.palette.length) bits.push(`palette ${sk.palette.slice(0, 5).join(' ')}`);
    if (Array.isArray(sk.fonts) && sk.fonts.length) bits.push(`fonts ${sk.fonts.join(', ')}`);
    if (isStr(sk.lut)) bits.push(`LUT ${sk.lut}`);
    if (bits.length) lines.push(`Look: ${bits.join(' · ')}`);
  }

  const segments = Array.isArray(edl.segments) ? [...edl.segments] : [];
  const ordered = segments
    .filter((s) => s.layer === 'primary')
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const byOver = new Map<string, EdlSegment[]>();
  for (const s of segments) {
    if (s.layer !== 'primary' && s.over) {
      const arr = byOver.get(s.over) || [];
      arr.push(s);
      byOver.set(s.over, arr);
    }
  }
  lines.push('Timeline:');
  let n = 1;
  for (const s of ordered) {
    const why = isStr(s.reason) ? ` · ${s.reason}` : '';
    lines.push(`  ${n}. [${s.role}] ${describeSegment(s)} (~${s.target_sec ?? '?'}s)${why}`);
    for (const ov of byOver.get(s.id) || []) {
      lines.push(`       └ ${ov.layer}: ${describeSegment(ov)}`);
    }
    n++;
  }
  // floating overlays/bg with no resolved `over`
  const floating = segments.filter((s) => s.layer !== 'primary' && (!s.over || !ordered.some((o) => o.id === s.over)));
  for (const s of floating) {
    lines.push(`  · ${s.layer} (${s.role}): ${describeSegment(s)}`);
  }

  const t = edl.tracks;
  const narration = t?.narration;
  const music = t?.music;
  const captions = t?.captions;
  if (isActiveNarration(narration)) {
    const voice = narration.synthesis
      ? `${narration.synthesis.display_name} (${narration.synthesis.route_ref}) · language=${narration.synthesis.language} · speed=${narration.synthesis.speed}`
      : `legacy:${narration.voice}`;
    lines.push(`Narration: voice=${voice}, ${narration.segments.length} line(s)`);
  }
  if (isActiveMusic(music)) lines.push(`Music: ${music.path}${music.duck ? ' · ducked under narration' : ''}`);
  if (isActiveCaptions(captions)) {
    const n = Array.isArray(captions.lines) ? captions.lines.length : 0;
    const head = n ? `${n} line(s)` : `from=${captions.from || '?'}`;
    lines.push(`Captions: ${head}${captions.style ? ` · ${captions.style}` : ''}`);
  }

  const cost = edl.cost_estimate;
  const billable = cost && isNum(cost.billable_generations) ? cost.billable_generations : 0;
  lines.push(`Cost: ${billable} billable generation(s)${cost?.note ? ` — ${cost.note}` : ''}`);

  return lines.join('\n');
}

function isActiveNarration(track: NarrationTrack | null | undefined): track is NarrationTrack {
  return isObject(track) && Array.isArray(track.segments) && track.segments.length > 0;
}

function isActiveMusic(track: MusicTrack | null | undefined): track is MusicTrack & { path: string } {
  return isObject(track) && isStr(track.path);
}

function isActiveCaptions(track: CaptionsTrack | null | undefined): track is CaptionsTrack {
  return isObject(track) && (
    (Array.isArray(track.lines) && track.lines.length > 0) || isStr(track.from)
  );
}

function describeSegment(s: EdlSegment): string {
  const spec = s.spec || {};
  switch (s.source) {
    case 'edit':
      return `edit ${String(spec.input_id ?? '?')} ${fmtRange(spec.in_sec, spec.out_sec)}`;
    case 'generate': {
      const vt = isStr(spec.variation_type) ? ` ·${spec.variation_type}` : '';
      const chars = Array.isArray(spec.characters) && spec.characters.length ? ` ·chars:${spec.characters.join(',')}` : '';
      const mediaKind = spec.media_kind === 'image' ? 'image' : 'video';
      return `generate-${mediaKind} "${truncate(String(spec.prompt ?? ''), 56)}"${vt}${chars}`;
    }
    case 'compose': {
      const compositionPlan = isObject(spec.composition_plan) && Array.isArray(spec.composition_plan.scenes)
        ? spec.composition_plan.scenes.filter(isObject)
        : [];
      const copy = compositionPlan.flatMap((scene) => Array.isArray(scene.approved_copy)
        ? scene.approved_copy.map(String)
        : []);
      return `compose ${String(spec.kind ?? '?')}${copy.length ? ` — "${truncate(copy.join(' / '), 72)}"` : ''}`;
    }
    case 'provided':
      return `provided ${String(spec.asset_id ?? '?')}`;
    default:
      return `${s.source}`;
  }
}

function fmtRange(a: unknown, b: unknown): string {
  if (isNum(a) && isNum(b)) return `[${round1(a)}–${round1(b)}s]`;
  return '';
}
function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
