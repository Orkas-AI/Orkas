export type ContractIssue = {
  code: string;
  severity: 'error' | 'warning' | 'info';
  selector?: string;
  message: string;
  fixHint?: string;
  source?: string;
  sceneId?: string;
};

/**
 * The single model of one page-rendered video: an ordered array of scenes.
 *
 * Everything derivable stays derived. A scene's start, the total length and the
 * frame ranges come from array order and clip lengths, so reordering moves one
 * array item and nothing else. Page motion runs on a per-scene timeline in
 * scene-local seconds, which is what lets a moved scene keep its rendered
 * segment; a page tied to absolute time would have to re-render everything after
 * the first change.
 *
 * This module is pure: no Electron, no ffmpeg, no filesystem. Rendering lives in
 * `video_timeline_render.ts`.
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { z } from 'zod';

import { extractHtmlResourceRefs, parseHtmlStructure, type HtmlStartTag } from './video_studio_html_check';

export const VIDEO_TIMELINE_MAX_DURATION_SEC = 600;
/** A scene this long with nothing on it costs minutes of page capture for what
 *  ffmpeg copies in seconds. */
const LONG_CLIP_ONLY_SCENE_SEC = 60;
/** Measured media lengths land between frames. */
const MEDIA_LENGTH_TOLERANCE_SEC = 0.05;
/** Footage repeated across a cut for less than this passes unnoticed. */
const REPEATED_FOOTAGE_MIN_SEC = 0.5;
// Old segments did not record their compositor. Some macOS software captures
// held the preceding frame, so every reader must miss those old keys.
const SCENE_KEY_VERSION = 2;

const IdSchema = z.string().trim().min(1).regex(
  /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
  'Use letters, numbers, hyphens, and underscores only.',
);

const ClipSchema = z.object({
  id: IdSchema,
  asset: IdSchema,
  in: z.number().finite().nonnegative(),
  dur: z.number().finite().positive(),
  /** Scene-local start for a clip shown alongside the sequence (split screen,
   *  picture in picture). It does not lengthen the scene. */
  at: z.number().finite().nonnegative().optional(),
  audio: z.enum(['keep', 'mute']).optional(),
  volume: z.number().finite().min(0).max(2).optional(),
}).strict();

const SceneTextSchema = z.union([
  z.object({ value: z.string() }).strict(),
  z.object({ fact_id: IdSchema }).strict(),
]);

const SceneSchema = z.object({
  id: IdSchema,
  clips: z.array(ClipSchema).optional(),
  duration: z.number().finite().positive().optional(),
  text: z.record(z.string(), SceneTextSchema).optional(),
  narration: z.object({ text: z.string().trim().min(1), asset: IdSchema.optional() }).strict().optional(),
}).strict();

const TrackSchema = z.object({
  kind: z.enum(['music', 'sfx', 'narration']),
  asset: IdSchema,
  volume: z.number().finite().min(0).max(2),
  fade_in: z.number().finite().nonnegative().optional(),
  fade_out: z.number().finite().nonnegative().optional(),
  duck: z.boolean().optional(),
}).strict();

export const VideoManifestV3Schema = z.object({
  schema_version: z.literal(3),
  id: IdSchema,
  label: z.string().trim().min(1),
  canvas: z.object({
    platform: z.string().trim().min(1).optional(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().int().positive().max(60),
    language: z.string().trim().min(1).optional(),
  }).strict(),
  scenes: z.array(SceneSchema).min(1),
  tracks: z.array(TrackSchema).optional(),
  captions: z.object({ enabled: z.boolean() }).strict().optional(),
  art_direction: z.record(z.string(), z.unknown()).optional(),
  upgraded_from: z.string().trim().min(1).optional(),
  /** A page from the old flow: one timeline on absolute time, and where each scene
   *  starts on it. A scene it does not list runs on its own timeline as usual. */
  absolute_page: z.object({
    /** Absent for a page with no timeline, whose elements show by their data-start. */
    timeline_key: z.string().trim().min(1).optional(),
    scene_starts: z.record(z.string(), z.number().finite().nonnegative()),
  }).strict().optional(),
}).strict();

export type VideoManifestV3 = z.infer<typeof VideoManifestV3Schema>;
export type VideoScene = VideoManifestV3['scenes'][number];
export type VideoClip = NonNullable<VideoScene['clips']>[number];

// Ledger rows are also written by hand for files a model made itself, so an extra
// key is dropped rather than refused: this file only ever affects display, and
// measured facts (hash, length) are read from the file at use.
export const VideoAssetRecordSchema = z.object({
  id: IdSchema,
  kind: z.enum(['image', 'video', 'audio']),
  label: z.string(),
  path: z.string().trim().min(1),
  origin: z.enum(['upload', 'page', 'generated', 'edited', 'stock']),
  sha256: z.string().optional(),
  duration: z.number().finite().positive().optional(),
  shot: z.string().optional(),
  prompt: z.string().optional(),
  refs: z.array(z.object({
    asset: z.string(),
    role: z.enum(['first_frame', 'last_frame', 'reference']),
  })).optional(),
  model: z.string().optional(),
  seed: z.number().optional(),
  /** The call that made this result, so the same shot can be made again from the canvas. */
  request: z.record(z.string(), z.unknown()).optional(),
  /** Where the product sits in an image, as [left, top, right, bottom] fractions of its size.
   *  video.check finds words placed on it. */
  subject: z.array(z.number().finite()).length(4).optional(),
  /** A stock or archive file's provider, its page, author and licence, so it can be credited.
   *  `credit` is the line the licence asks for, when it asks for one. `pexels` is no longer
   *  searched; it stays readable for files imported before it was removed. */
  source: z.object({
    provider: z.enum(['pexels', 'pixabay', 'wikimedia', 'nasa']),
    id: z.string(),
    title: z.string().optional(),
    page_url: z.string().optional(),
    author: z.string().optional(),
    author_url: z.string().optional(),
    license: z.string(),
    license_url: z.string().optional(),
    credit: z.string().optional(),
  }).optional(),
});

export type VideoAssetRecord = z.infer<typeof VideoAssetRecordSchema>;

export const VideoAssetLedgerSchema = z.object({ assets: z.array(VideoAssetRecordSchema) });

export const VideoProductSchema = z.object({
  name: z.string(),
  facts: z.array(z.object({
    id: IdSchema,
    text: z.string(),
    source: z.enum(['page', 'user', 'unverified']),
  })).default([]),
  images: z.array(z.string()).default([]),
});

export type VideoProduct = z.infer<typeof VideoProductSchema>;

const SOURCE = 'orkas-video-timeline';

function schemaIssues(error: z.ZodError): ContractIssue[] {
  return error.issues.map((issue) => ({
    code: 'TIMELINE_SCHEMA_INVALID',
    severity: 'error' as const,
    selector: `manifest.json#${issue.path.join('.') || 'root'}`,
    message: issue.message,
    source: SOURCE,
  }));
}

export function parseVideoManifest(raw: unknown): { manifest: VideoManifestV3 | null; issues: ContractIssue[] } {
  const parsed = VideoManifestV3Schema.safeParse(raw);
  return parsed.success
    ? { manifest: parsed.data, issues: [] }
    : { manifest: null, issues: schemaIssues(parsed.error) };
}

/** One scene as a manifest holds it, or null. */
export function parseVideoScene(raw: unknown): VideoScene | null {
  const parsed = SceneSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export type DerivedClip = {
  id: string;
  assetId: string;
  inSec: number;
  durSec: number;
  /** First scene-local frame this clip shows on. */
  startFrame: number;
  frameCount: number;
  overlay: boolean;
};

export type DerivedScene = {
  id: string;
  index: number;
  startFrame: number;
  frameCount: number;
  startSec: number;
  durationSec: number;
  clips: DerivedClip[];
};

export type DerivedTimeline = {
  fps: number;
  scenes: DerivedScene[];
  totalFrames: number;
  durationSec: number;
};

function sequentialClips(scene: VideoScene): VideoClip[] {
  return (scene.clips ?? []).filter((clip) => clip.at === undefined);
}

function sceneNominalSec(scene: VideoScene): number {
  const sequence = sequentialClips(scene);
  return sequence.length ? sequence.reduce((sum, clip) => sum + clip.dur, 0) : (scene.duration ?? 0);
}

/** How to fix a scene's narration that runs past the scene. A file that fits in the rest
 *  of the video was usually made for several scenes (2026-11-17: a tutorial's whole 19.7s
 *  voice-over went on its 3s first scene, and "lengthen the scene" did not help). A track
 *  plays from 0s, so it is offered only from the start and when no other scene is voiced. */
function narrationOverrunRepair(manifest: VideoManifestV3, sceneIndex: number, sceneStartSec: number, measuredSec: number): string {
  const scene = manifest.scenes[sceneIndex];
  const restSec = manifest.scenes.slice(sceneIndex).reduce((sum, later) => sum + sceneNominalSec(later), 0);
  if (measuredSec > restSec + MEDIA_LENGTH_TOLERANCE_SEC) return 'Lengthen the scene or shorten the line.';
  const otherVoice = manifest.scenes.some((other, index) => index !== sceneIndex && other.narration?.asset);
  const fix = sceneStartSec <= MEDIA_LENGTH_TOLERANCE_SEC && !otherVoice
    ? 'play it as a track, which starts with the video: '
      + `add { "kind": "narration", "asset": "${scene.narration?.asset}", "volume": 1 } to "tracks" and remove "asset" from the narration of scene "${scene.id}"`
    : 'make one narration file per scene, each no longer than its scene';
  return `When this one file narrates the scenes after it too, ${fix}. Otherwise lengthen the scene or shorten the line.`;
}

/** Every scene and clip edge is the frame nearest its place on the whole video's
 *  seconds, so seven 1.37s clips cover the same 288 frames a 9.59s scene would,
 *  and ten 1.875s bars cut at 56, 113, 169 … frames rather than drifting to 56,
 *  112, 168 … (2026-11-17: rounding each scene on its own put the sixth cut of a
 *  128 BPM montage more than a frame before its beat). A scene shorter than a
 *  frame still gets one; the next edge stays where its seconds put it. */
export function deriveVideoTimeline(manifest: VideoManifestV3, fpsOverride?: number): DerivedTimeline {
  const fps = fpsOverride ?? manifest.canvas.fps;
  let cursor = 0;
  let sceneStartSec = 0;
  const scenes = manifest.scenes.map((scene, index): DerivedScene => {
    const startFrame = cursor;
    const sceneEndSec = sceneStartSec + sceneNominalSec(scene);
    const endFrame = Math.max(startFrame + 1, Math.round(sceneEndSec * fps));
    const frameCount = endFrame - startFrame;
    // A sequential clip edge at `sec` of the whole video, as a frame of this scene.
    const edgeFrame = (sec: number) => Math.min(endFrame, Math.max(startFrame, Math.round(sec * fps))) - startFrame;
    // The last one ends with the scene, which its clips make up.
    let sequentialLeft = sequentialClips(scene).length;
    const clips: DerivedClip[] = [];
    let cumulativeSec = sceneStartSec;
    for (const clip of scene.clips ?? []) {
      if (clip.at !== undefined) {
        const overlayStart = Math.round(clip.at * fps);
        clips.push({
          id: clip.id,
          assetId: clip.asset,
          inSec: clip.in,
          durSec: clip.dur,
          startFrame: overlayStart,
          frameCount: Math.max(1, Math.min(frameCount - overlayStart, Math.round(clip.dur * fps))),
          overlay: true,
        });
        continue;
      }
      const clipStart = edgeFrame(cumulativeSec);
      cumulativeSec += clip.dur;
      sequentialLeft -= 1;
      clips.push({
        id: clip.id,
        assetId: clip.asset,
        inSec: clip.in,
        durSec: clip.dur,
        startFrame: clipStart,
        frameCount: (sequentialLeft === 0 ? frameCount : edgeFrame(cumulativeSec)) - clipStart,
        overlay: false,
      });
    }
    const derived: DerivedScene = {
      id: scene.id,
      index,
      startFrame,
      frameCount,
      startSec: startFrame / fps,
      durationSec: frameCount / fps,
      clips,
    };
    cursor = endFrame;
    sceneStartSec = sceneEndSec;
    return derived;
  });
  return { fps, scenes, totalFrames: cursor, durationSec: cursor / fps };
}

export function validateVideoTimeline(input: {
  manifest: VideoManifestV3;
  assets: readonly VideoAssetRecord[];
  product: VideoProduct | null;
  /** Measured lengths by asset id, when the files have been probed. */
  mediaDurations?: ReadonlyMap<string, number>;
  fps?: number;
}): ContractIssue[] {
  const { manifest, product } = input;
  const issues: ContractIssue[] = [];
  const add = (code: string, message: string, extra: Partial<ContractIssue> = {}) => {
    issues.push({ code, severity: 'error', message, source: SOURCE, ...extra });
  };
  const fps = input.fps ?? manifest.canvas.fps;
  const timeline = deriveVideoTimeline(manifest, fps);
  const assetsById = new Map(input.assets.map((asset) => [asset.id, asset]));
  const facts = new Set((product?.facts ?? []).map((fact) => fact.id));

  if (manifest.canvas.width % 2 || manifest.canvas.height % 2) {
    add('TIMELINE_CANVAS_ODD', `Canvas ${manifest.canvas.width}x${manifest.canvas.height} has an odd side; H.264 needs even dimensions.`);
  }

  const sceneIds = new Set<string>();
  const clipIds = new Set<string>();
  let totalSec = 0;
  for (const [sceneIndex, scene] of manifest.scenes.entries()) {
    const selector = `manifest.json#scenes.${sceneIndex}`;
    const sceneExtra = { selector, sceneId: scene.id };
    if (sceneIds.has(scene.id)) add('TIMELINE_SCENE_ID_DUPLICATE', `Scene id "${scene.id}" is used twice.`, sceneExtra);
    sceneIds.add(scene.id);

    const sequence = sequentialClips(scene);
    if (sequence.length && scene.duration !== undefined) {
      add('TIMELINE_SCENE_LENGTH_CONFLICT', `Scene "${scene.id}" has clips, so its length comes from them. Remove "duration".`, sceneExtra);
    }
    if (!sequence.length && scene.duration === undefined) {
      add('TIMELINE_SCENE_LENGTH_MISSING', `Scene "${scene.id}" has no sequential clips, so it needs a "duration".`, sceneExtra);
    }
    const sceneSec = sceneNominalSec(scene);
    totalSec += sceneSec;

    for (const [clipIndex, clip] of (scene.clips ?? []).entries()) {
      const clipExtra = { selector: `${selector}.clips`, sceneId: scene.id };
      if (clipIds.has(clip.id)) {
        add('TIMELINE_CLIP_ID_DUPLICATE', `Clip id "${clip.id}" is used twice; a page addresses clips by id, so ids are unique across the video.`, clipExtra);
      }
      clipIds.add(clip.id);
      const asset = assetsById.get(clip.asset);
      if (!asset) {
        add('TIMELINE_ASSET_UNKNOWN', `Clip "${clip.id}" uses asset "${clip.asset}", which is not in assets.json.`, clipExtra);
      } else if (asset.kind === 'audio') {
        add('TIMELINE_CLIP_NOT_VISUAL', `Clip "${clip.id}" uses audio asset "${clip.asset}". Put audio on tracks or narration.`, clipExtra);
      }
      if (Math.round(clip.dur * fps) < 1 || timeline.scenes[sceneIndex].clips[clipIndex].frameCount < 1) {
        add('TIMELINE_CLIP_TOO_SHORT', `Clip "${clip.id}" is ${clip.dur}s, shorter than one frame at ${fps}fps.`, clipExtra);
      }
      if (clip.at !== undefined && clip.at + clip.dur > sceneSec + 1 / fps) {
        add('TIMELINE_OVERLAY_PAST_SCENE', `Overlay clip "${clip.id}" ends at ${clip.at + clip.dur}s but scene "${scene.id}" is ${sceneSec}s.`, clipExtra);
      }
      const measured = asset?.kind === 'video' ? input.mediaDurations?.get(clip.asset) : undefined;
      if (measured !== undefined && clip.in + clip.dur > measured + MEDIA_LENGTH_TOLERANCE_SEC) {
        add('TIMELINE_CLIP_PAST_MEDIA_END', `Clip "${clip.id}" reads to ${clip.in + clip.dur}s but "${clip.asset}" is ${measured}s long.`, clipExtra);
      }
    }

    for (const [slot, entry] of Object.entries(scene.text ?? {})) {
      if ('fact_id' in entry && !facts.has(entry.fact_id)) {
        add('TIMELINE_FACT_UNKNOWN', `Slot "${slot}" in scene "${scene.id}" is bound to fact "${entry.fact_id}", which is not in product.json.`, sceneExtra);
      }
    }

    if (scene.narration?.asset) {
      const voice = assetsById.get(scene.narration.asset);
      if (!voice) {
        add('TIMELINE_ASSET_UNKNOWN', `Narration in scene "${scene.id}" uses asset "${scene.narration.asset}", which is not in assets.json.`, sceneExtra);
      } else if (voice.kind !== 'audio') {
        add('TIMELINE_AUDIO_ASSET_NOT_AUDIO', `Narration in scene "${scene.id}" uses ${voice.kind} asset "${voice.id}".`, sceneExtra);
      }
      const measured = input.mediaDurations?.get(scene.narration.asset);
      if (measured !== undefined && measured > sceneSec + MEDIA_LENGTH_TOLERANCE_SEC) {
        add('TIMELINE_NARRATION_OVERRUNS_SCENE', `Narration in scene "${scene.id}" is ${measured}s but the scene is ${sceneSec}s, so it would talk over the next scene or be cut off. `
          + narrationOverrunRepair(manifest, sceneIndex, totalSec - sceneSec, measured), sceneExtra);
      }
    }

    if (sequence.length && !scene.text && !scene.narration && sceneSec > LONG_CLIP_ONLY_SCENE_SEC) {
      issues.push({
        code: 'TIMELINE_LONG_CLIP_ONLY_SCENE',
        severity: 'warning',
        message: `Scene "${scene.id}" is ${Math.round(sceneSec)}s of footage with nothing on it. Page rendering costs about 2s per second of video; cutting it with edit_video is much faster.`,
        source: SOURCE,
        ...sceneExtra,
      });
    }
  }

  // On 2026-11-07 a launch video cut 23–30s of the site's demo into one scene and 26–33s into the
  // next, so the same four seconds played twice in a row.
  for (let sceneIndex = 1; sceneIndex < manifest.scenes.length; sceneIndex += 1) {
    const before = manifest.scenes[sceneIndex - 1];
    const scene = manifest.scenes[sceneIndex];
    const repeat = (scene.clips ?? []).flatMap((clip) => (before.clips ?? []).flatMap((earlier) => {
      if (earlier.asset !== clip.asset || assetsById.get(clip.asset)?.kind !== 'video') return [];
      const from = Math.max(earlier.in, clip.in);
      const to = Math.min(earlier.in + earlier.dur, clip.in + clip.dur);
      return to - from + 1e-9 >= REPEATED_FOOTAGE_MIN_SEC ? [{ asset: clip.asset, from, to }] : [];
    }))[0];
    if (!repeat) continue;
    issues.push({
      code: 'TIMELINE_ADJACENT_FOOTAGE_OVERLAP',
      severity: 'warning',
      message: `Scenes "${before.id}" and "${scene.id}" both show ${repeat.from.toFixed(1)}–${repeat.to.toFixed(1)}s of "${repeat.asset}", so the same footage plays twice in a row. Move one of them to a part of the clip the other does not use, or use another clip.`,
      source: SOURCE,
      selector: `manifest.json#scenes.${sceneIndex}.clips`,
      sceneId: scene.id,
    });
  }

  for (const [trackIndex, track] of (manifest.tracks ?? []).entries()) {
    const extra = { selector: `manifest.json#tracks.${trackIndex}` };
    const asset = assetsById.get(track.asset);
    if (!asset) {
      add('TIMELINE_ASSET_UNKNOWN', `Track ${trackIndex} uses asset "${track.asset}", which is not in assets.json.`, extra);
    } else if (asset.kind !== 'audio') {
      add('TIMELINE_AUDIO_ASSET_NOT_AUDIO', `Track ${trackIndex} uses ${asset.kind} asset "${asset.id}".`, extra);
    }
  }

  totalSec = Math.max(totalSec, timeline.durationSec);
  if (totalSec > VIDEO_TIMELINE_MAX_DURATION_SEC) {
    add('TIMELINE_TOO_LONG', `The video is ${Math.round(totalSec)}s; page rendering stops at ${VIDEO_TIMELINE_MAX_DURATION_SEC}s. Cut long footage with edit_video and join the page-rendered parts to it.`);
  }
  return issues;
}

function escapeHtmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeHtmlAttr(value: string): string {
  return escapeHtmlText(value).replace(/"/g, '&quot;');
}

/** End offset of the element a start tag opens, or null when it never closes.
 *  Comments and raw script/style text cannot close it. */
function findElementEnd(html: string, tag: HtmlStartTag): { innerEnd: number; end: number } | null {
  const closeRe = /<(\/?)([a-zA-Z][\w:-]*)\b[^>]*>|<!--[\s\S]*?-->/g;
  closeRe.lastIndex = tag.end;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = closeRe.exec(html))) {
    if (!match[2]) continue;
    const name = match[2].toLowerCase();
    if (!match[1] && (name === 'script' || name === 'style')) {
      const rawEnd = html.toLowerCase().indexOf(`</${name}`, closeRe.lastIndex);
      if (rawEnd < 0) return null;
      closeRe.lastIndex = rawEnd;
      continue;
    }
    if (name !== tag.tagName) continue;
    if (match[1]) {
      depth -= 1;
      if (depth === 0) return { innerEnd: match.index, end: match.index + match[0].length };
    } else if (!match[0].endsWith('/>')) {
      depth += 1;
    }
  }
  return null;
}

type Edit = { start: number; end: number; text: string };

/** Where a scene's motion script sits between its markers, when each marker appears once. */
function sceneMotionRegion(source: string, sceneId: string): { start: number; end: number } | null {
  const begin = `// ORKAS-SCENE-MOTION-BEGIN:${sceneId}`;
  const end = `// ORKAS-SCENE-MOTION-END:${sceneId}`;
  const beginAt = source.indexOf(begin);
  const endAt = source.indexOf(end);
  return beginAt >= 0 && endAt > beginAt
    && source.indexOf(begin, beginAt + begin.length) < 0
    && source.indexOf(end, endAt + end.length) < 0
    ? { start: beginAt + begin.length, end: endAt }
    : null;
}

function applyEdits(source: string, edits: Edit[]): string {
  return [...edits]
    .sort((a, b) => b.start - a.start)
    .reduce((out, edit) => `${out.slice(0, edit.start)}${edit.text}${out.slice(edit.end)}`, source);
}

/** The words as heard: spacing, punctuation and full-width forms change only how they look. */
export function spokenWords(text: string): string {
  return text.normalize('NFKC').replace(/[\p{P}\p{Z}\s]+/gu, '');
}

export function resolveSceneText(scene: VideoScene, product: VideoProduct | null): Record<string, string> {
  const factText = new Map((product?.facts ?? []).map((fact) => [fact.id, fact.text]));
  const values: Record<string, string> = {};
  for (const [slot, entry] of Object.entries(scene.text ?? {})) {
    const value = 'value' in entry ? entry.value : factText.get(entry.fact_id);
    if (value !== undefined) values[slot] = value;
  }
  return values;
}

function fillImg(clipId: string): string {
  return `<img data-clip="${escapeHtmlAttr(clipId)}" class="orkas-fill" alt="">`;
}

/** Slots filled, unplaced clips laid behind the content, captions added. */
function rewriteSceneSubtree(input: {
  subtree: string;
  scene: VideoScene;
  values: Record<string, string>;
  captions: boolean;
  issues: ContractIssue[];
}): string {
  const { subtree, scene, values, issues } = input;
  const structure = parseHtmlStructure(subtree);
  const [open] = structure.tags;
  const edits: Edit[] = [];
  const add = (code: string, message: string) => {
    issues.push({ code, severity: 'error', message, source: SOURCE, sceneId: scene.id, selector: `[data-scene-id="${scene.id}"]` });
  };

  const clipIds = new Set((scene.clips ?? []).map((clip) => clip.id));
  const placedClips = new Set<string>();
  const filledSlots = new Set<string>();
  let coveredUntil = 0;
  for (const tag of structure.tags.slice(1)) {
    if (tag.start < coveredUntil) continue;
    if (tag.attrs['data-clip'] !== undefined) {
      const clipId = tag.attrs['data-clip'];
      if (tag.tagName !== 'img') add('PAGE_CLIP_NOT_IMG', `data-clip="${clipId}" is on a <${tag.tagName}>; clips are shown through <img data-clip>.`);
      else if (!clipIds.has(clipId)) add('PAGE_CLIP_UNKNOWN', `<img data-clip="${clipId}"> is not a clip of scene "${scene.id}".`);
      else placedClips.add(clipId);
    }
    if (tag.attrs['data-slot'] === undefined) continue;
    const slot = tag.attrs['data-slot'];
    const close = findElementEnd(subtree, tag);
    if (!close) {
      add('PAGE_SLOT_INVALID', `data-slot="${slot}" is on a <${tag.tagName}> that holds no text.`);
      continue;
    }
    if (values[slot] === undefined) {
      add('PAGE_SLOT_UNFILLED', `Slot "${slot}" in scene "${scene.id}" has no text. Add it to the scene's "text".`);
    } else {
      edits.push({ start: tag.end, end: close.innerEnd, text: escapeHtmlText(values[slot]) });
    }
    filledSlots.add(slot);
    coveredUntil = close.end;
  }
  for (const slot of Object.keys(values)) {
    if (!filledSlots.has(slot)) add('PAGE_SLOT_MISSING', `Scene "${scene.id}" has text for slot "${slot}", but the page has no data-slot="${slot}" there.`);
  }

  const unplaced = [...clipIds].filter((id) => !placedClips.has(id));
  if (unplaced.length) {
    edits.push({ start: open.end, end: open.end, text: unplaced.map(fillImg).join('') });
    edits.push({ start: open.end - 1, end: open.end - 1, text: ' data-orkas-has-fill' });
  }
  if (input.captions && !subtree.includes('data-orkas-caption')) {
    const close = findElementEnd(subtree, open);
    if (close) edits.push({ start: close.innerEnd, end: close.innerEnd, text: '<div class="orkas-caption" data-orkas-caption></div>' });
  }
  return applyEdits(subtree, edits);
}

function defaultPage(manifest: VideoManifestV3): string {
  const { width, height, language } = manifest.canvas;
  return `<!doctype html>
<html lang="${escapeHtmlAttr(language || 'en')}">
<head>
<meta charset="UTF-8">
<style>html, body { width: ${width}px; height: ${height}px; margin: 0; overflow: hidden; background: #000; }</style>
</head>
<body>
<main data-composition-id="${escapeHtmlAttr(manifest.id)}" style="position: relative; width: 100%; height: 100%; overflow: hidden"></main>
</body>
</html>
`;
}

function hostStyle(manifest: VideoManifestV3): string {
  const unit = Math.min(manifest.canvas.width, manifest.canvas.height);
  return `<style data-orkas-host>
[data-orkas-hidden] { display: none !important; }
[data-orkas-has-fill] { isolation: isolate; }
.orkas-fill { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; z-index: -1; }
.orkas-caption { position: absolute; left: 8%; right: 8%; bottom: 12%; z-index: 10; text-align: center; color: #fff; font: 600 ${Math.round(unit * 0.05)}px/1.3 -apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif; text-shadow: 0 2px 8px rgba(0, 0, 0, 0.85); }
.orkas-caption:empty { display: none; }
</style>`;
}

export type CompiledVideoPage = {
  /** What the render window loads. */
  html: string;
  issues: ContractIssue[];
  /** Per-scene rendering inputs; every other byte of the page is in `shared`. */
  scenes: Record<string, { subtree: string; motion: string }>;
  shared: string;
};

/**
 * Turn the authored page plus the manifest into the page the window renders.
 *
 * Slots are filled in the page text rather than in the DOM after load: the page's
 * own scripts measure and animate text as they run, so words injected later would
 * sit in boxes sized for the placeholder.
 */
export function compileVideoPage(input: {
  html: string | null;
  manifest: VideoManifestV3;
  product: VideoProduct | null;
  /** File URL of the video directory, ending in a slash. */
  baseHref: string;
}): CompiledVideoPage {
  const { manifest, product } = input;
  const issues: ContractIssue[] = [];
  const source = input.html ?? defaultPage(manifest);
  const structure = parseHtmlStructure(source);
  const pageIssue = (code: string, message: string, selector: string) => {
    issues.push({ code, severity: 'error', message, selector, source: SOURCE });
  };

  for (const tag of structure.tags) {
    if (tag.tagName === 'video' || tag.tagName === 'audio') {
      pageIssue(
        'PAGE_MEDIA_ELEMENT_FORBIDDEN',
        `<${tag.tagName}> does not render frame-accurately. Put footage in "clips" with <img data-clip>, and sound on "tracks" or "narration".`,
        tag.tagName,
      );
    }
    if (tag.tagName === 'base') pageIssue('PAGE_BASE_FORBIDDEN', 'Remove <base>; page resources resolve against the video directory.', 'base');
  }

  const captionsOn = manifest.captions?.enabled === true;
  const edits: Edit[] = [];
  const sharedEdits: Edit[] = [];
  const scenes: CompiledVideoPage['scenes'] = {};
  const inserted: string[] = [];

  for (const scene of manifest.scenes) {
    const values = resolveSceneText(scene, product);
    const captions = captionsOn && !!scene.narration;
    const sections = structure.tags.filter((tag) => tag.attrs['data-scene-id'] === scene.id);
    if (sections.length > 1) {
      pageIssue('PAGE_SCENE_DUPLICATE', `The page has ${sections.length} data-scene-id="${scene.id}" elements.`, `[data-scene-id="${scene.id}"]`);
      continue;
    }
    if (!sections.length) {
      if (!scene.clips?.length) {
        pageIssue('PAGE_SCENE_MISSING', `Scene "${scene.id}" has no footage and no <section data-scene-id="${scene.id}"> in index.html.`, `[data-scene-id="${scene.id}"]`);
        continue;
      }
      const subtree = rewriteSceneSubtree({
        subtree: `<section data-scene-id="${escapeHtmlAttr(scene.id)}" style="position: absolute; inset: 0; overflow: hidden"></section>`,
        scene,
        values,
        captions,
        issues,
      });
      scenes[scene.id] = { subtree, motion: '' };
      inserted.push(subtree);
      continue;
    }
    const [tag] = sections;
    const close = findElementEnd(source, tag);
    if (!close) {
      pageIssue('PAGE_SCENE_UNCLOSED', `<${tag.tagName} data-scene-id="${scene.id}"> never closes.`, `[data-scene-id="${scene.id}"]`);
      continue;
    }
    const subtree = rewriteSceneSubtree({
      subtree: source.slice(tag.start, close.end),
      scene,
      values,
      captions,
      issues,
    });
    edits.push({ start: tag.start, end: close.end, text: subtree });
    sharedEdits.push({ start: tag.start, end: close.end, text: `<!--orkas-scene:${scene.id}-->` });
    scenes[scene.id] = { subtree, motion: '' };

    const motion = sceneMotionRegion(source, scene.id);
    if (motion) {
      scenes[scene.id].motion = source.slice(motion.start, motion.end);
      sharedEdits.push({ ...motion, text: '' });
    }
  }

  // A scene taken off the timeline stays in the page and never shows. It leaves the shared
  // surface the way a listed scene does, or removing one would re-render all the others.
  const listed = new Set(manifest.scenes.map((scene) => scene.id));
  for (const tag of structure.tags) {
    const id = tag.attrs['data-scene-id'];
    if (id === undefined || listed.has(id)) continue;
    const close = findElementEnd(source, tag);
    if (close) sharedEdits.push({ start: tag.start, end: close.end, text: `<!--orkas-scene:${id}-->` });
    const motion = sceneMotionRegion(source, id);
    if (motion) sharedEdits.push({ ...motion, text: '' });
  }

  // Nested markup outside the marked regions stays in the shared surface, which
  // only costs extra re-rendering. A scene's identity can never miss a byte.
  const shared = applyEdits(source, sharedEdits);

  if (inserted.length) {
    const root = structure.tags.find((tag) => tag.attrs['data-composition-id'] !== undefined);
    const rootClose = root ? findElementEnd(source, root) : null;
    const body = structure.tags.find((tag) => tag.tagName === 'body');
    const bodyClose = body ? findElementEnd(source, body) : null;
    const at = rootClose?.innerEnd ?? bodyClose?.innerEnd ?? source.length;
    edits.push({ start: at, end: at, text: inserted.join('\n') });
  }

  const hostHead = `<base href="${escapeHtmlAttr(input.baseHref)}">${hostStyle(manifest)}`;
  const head = structure.tags.find((tag) => tag.tagName === 'head');
  if (head) {
    edits.push({ start: head.end, end: head.end, text: hostHead });
  } else {
    const html = structure.tags.find((tag) => tag.tagName === 'html');
    const at = html ? html.end : 0;
    edits.push({ start: at, end: at, text: `<head>${hostHead}</head>` });
  }

  return { html: applyEdits(source, edits), issues, scenes, shared };
}

export type PagePictureRefs = {
  /** Placed outside every scene, so shown throughout. */
  shared: string[];
  /** By scene on the timeline. A scene taken off it shows nothing, so it is not here. */
  scenes: Record<string, string[]>;
};

/** The ledger pictures a page shows by file, through src or a CSS url(), rather than as
 *  clips. Both are read the way the render window reads them, against the video folder. */
export function pagePictureRefs(input: {
  compiled: CompiledVideoPage;
  assets: readonly VideoAssetRecord[];
  videoDirAbs: string;
  productionDirAbs: string;
}): PagePictureRefs {
  const base = pathToFileURL(`${input.videoDirAbs}${path.sep}`);
  const idOfFile = new Map(input.assets
    .filter((row) => row.kind !== 'audio')
    .map((row) => [path.resolve(input.productionDirAbs, row.path), row.id]));
  const idsIn = (markup: string): string[] => {
    const ids: string[] = [];
    for (const { attr, ref } of extractHtmlResourceRefs(parseHtmlStructure(markup))) {
      if (attr !== 'src' && attr !== 'style-url') continue;
      let file = '';
      try {
        const url = new URL(ref, base);
        if (url.protocol === 'file:') file = path.resolve(fileURLToPath(url));
      } catch {
        continue;
      }
      const id = idOfFile.get(file);
      if (id && !ids.includes(id)) ids.push(id);
    }
    return ids;
  };
  return {
    shared: idsIn(input.compiled.shared),
    scenes: Object.fromEntries(Object.entries(input.compiled.scenes).map(([id, scene]) => [id, idsIn(scene.subtree)])),
  };
}

/** How long a run of soundless scenes may last in a narrated video before it is reported:
 *  the delivery check's own silent stretch. */
export const SILENT_SCENES_MIN_SEC = 3;

/** In a video that narrates some scenes, consecutive scenes with no line, no clip sound and
 *  no music or narration track under the video play as silence (2026-11-17: explainers made
 *  without a requested length voiced their first one or two scenes and went silent for the
 *  remaining 16-24 s). Checked before rendering, so the fix is a line per scene. */
export function silentSceneIssues(manifest: VideoManifestV3, fps?: number): ContractIssue[] {
  if ((manifest.tracks ?? []).some((track) => track.kind === 'music' || track.kind === 'narration')) return [];
  const timeline = deriveVideoTimeline(manifest, fps);
  const clipSound = (scene: VideoScene) => (scene.clips ?? []).some((clip) => clip.audio === 'keep');
  if (!manifest.scenes.some((scene) => scene.narration?.asset)) {
    // Narration written for every scene and never voiced (2026-11-17: 2 of 5 explainers made
    // without a requested length shipped 27-40 s of silent captions).
    const scripted = manifest.scenes.flatMap((scene, index) => (
      scene.narration?.text && !clipSound(scene) ? [{ id: scene.id, index, sec: timeline.scenes[index]?.durationSec ?? 0 }] : []
    ));
    const sec = scripted.reduce((sum, scene) => sum + scene.sec, 0);
    if (!scripted.length || sec < SILENT_SCENES_MIN_SEC - 0.05) return [];
    const names = scripted.map((scene) => scene.id);
    const one = names.length === 1;
    const listed = one ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    return [{
      code: 'TIMELINE_NARRATION_UNVOICED',
      severity: 'error',
      source: SOURCE,
      selector: `manifest.json#scenes.${scripted[0].index}`,
      sceneId: names[0],
      message: `${one ? 'Scene' : 'Scenes'} ${listed} (${sec.toFixed(1)}s) ${one ? 'has' : 'have'} narration text but no voice, and nothing else plays under ${one ? 'it' : 'them'}, so the video would be silent. Voice each line with generate_speech, or put music under the video. If the user asked for no sound, put the lines on screen as text instead of narration. Then check again.`,
    }];
  }
  const issues: ContractIssue[] = [];
  let run: Array<{ id: string; index: number; sec: number }> = [];
  const flush = () => {
    const sec = run.reduce((sum, scene) => sum + scene.sec, 0);
    if (run.length && sec >= SILENT_SCENES_MIN_SEC - 0.05) {
      const names = run.map((scene) => scene.id);
      const one = names.length === 1;
      const listed = one ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
      issues.push({
        code: 'TIMELINE_SCENES_SILENT',
        severity: 'error',
        source: SOURCE,
        selector: `manifest.json#scenes.${run[0].index}`,
        sceneId: names[0],
        message: one
          ? `Scene ${listed} (${sec.toFixed(1)}s) has no narration and nothing else plays under it, so it would be silent. Give it a line with generate_speech, or put music under the video, then check again.`
          : `Scenes ${listed} (${sec.toFixed(1)}s) have no narration and nothing else plays under them, so they would be silent. Give each a line with generate_speech, or put music under the video, then check again.`,
      });
    }
    run = [];
  };
  manifest.scenes.forEach((scene, index) => {
    const sounded = !!scene.narration?.asset || clipSound(scene);
    if (sounded) flush();
    else run.push({ id: scene.id, index, sec: timeline.scenes[index]?.durationSec ?? 0 });
  });
  flush();
  return issues;
}

/** A scene that places ledger pictures by file keeps them off the canvas, which reads a
 *  scene's pictures from its clips. Markup shared by every scene has no clip to move into. */
export function pagePictureIssues(manifest: VideoManifestV3, refs: PagePictureRefs): ContractIssue[] {
  return manifest.scenes.flatMap((scene) => {
    const ids = refs.scenes[scene.id] ?? [];
    if (!ids.length) return [];
    const several = ids.length > 1;
    const message = (named: number) => {
      const quoted = ids.slice(0, named).map((id) => `"${id}"`);
      const list = !named ? (several ? `${ids.length} pictures` : 'a picture')
        : named < ids.length ? `${quoted.join(', ')} and ${ids.length - named} more`
          : several ? `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}` : quoted[0];
      return `Scene "${scene.id}" places ${list} from assets.json straight in its page markup, so the canvas cannot show or swap ${several ? 'them' : 'it'}. Add ${several ? 'each' : 'it'} to the scene's "clips" and show it with <img data-clip="id">.`;
    };
    // The check reports a shortened message, and the fix is its last sentence.
    let named = ids.length;
    while (named > 0 && message(named).length > WARNING_MESSAGE_MAX) named -= 1;
    return [{
      code: 'PAGE_PICTURE_NOT_A_CLIP',
      severity: 'warning' as const,
      message: message(named),
      selector: `[data-scene-id="${scene.id}"]`,
      source: SOURCE,
      sceneId: scene.id,
    }];
  });
}

export type SceneKeyClip = {
  id: string;
  assetSha256: string;
  inSec: number;
  startFrame: number;
  frameCount: number;
};

export type CaptionFrameCue = { fromFrame: number; toFrame: number; text: string };

/** Identity of one rendered scene. Its position in the video is deliberately not
 *  an input: that is what makes reordering free. */
export function buildTimelineSceneKey(input: {
  subtree: string;
  motion: string;
  shared: string;
  sceneAssetsSha256: string;
  sharedAssetsSha256: string;
  clips: SceneKeyClip[];
  captions: CaptionFrameCue[];
  frameCount: number;
  fps: number;
  width: number;
  height: number;
  quality: string | undefined;
  format: string | undefined;
  /** Where the scene starts on an old page's one timeline. */
  pageStart?: number;
}): string {
  return createHash('sha256').update(JSON.stringify({
    v: SCENE_KEY_VERSION,
    ...(input.pageStart === undefined ? {} : { page_start: input.pageStart }),
    subtree: input.subtree,
    motion: input.motion,
    shared: input.shared,
    scene_assets: input.sceneAssetsSha256,
    shared_assets: input.sharedAssetsSha256,
    clips: input.clips,
    captions: input.captions,
    frames: input.frameCount,
    fps: input.fps,
    width: input.width,
    height: input.height,
    quality: input.quality ?? 'unset',
    format: input.format ?? 'mp4',
  })).digest('hex');
}

/**
 * Share of a frame covered by its most common flat colour, from a small BGRA bitmap.
 * Near 1 is a blank frame. A photograph or footage scores low, because no one colour
 * dominates it even where it looks plain.
 */
export function dominantFlatShare(bitmap: Uint8Array, width: number, height: number): number {
  const counts = new Map<number, number>();
  const pixels = width * height;
  let peak = 0;
  for (let index = 0; index < pixels; index += 1) {
    const offset = index * 4;
    // Buckets of 16 levels per channel, so anti-aliasing and compression noise on a
    // flat background do not split it into many colours.
    const key = (bitmap[offset] >> 4) << 8 | (bitmap[offset + 1] >> 4) << 4 | (bitmap[offset + 2] >> 4);
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    if (count > peak) peak = count;
  }
  return pixels ? peak / pixels : 0;
}

/**
 * Whether a still picture looks like a screen of a site or app rather than a photograph,
 * from a small BGRA bitmap. A screen is flat colour almost everywhere, also away from its
 * background (bars, cards, buttons, text); a photograph is continuous tone, even one shot
 * on a plain backdrop, so its pixels off the backdrop spread over many colours. A flat-lay
 * or a cut-out can still pass, so what follows from this is said as a question.
 */
export function looksLikeScreen(bitmap: Uint8Array, width: number, height: number): boolean {
  const pixels = width * height;
  if (pixels < 64) return false;
  const counts = new Map<number, number>();
  for (let index = 0; index < pixels; index += 1) {
    const offset = index * 4;
    const key = (bitmap[offset] >> 4) << 8 | (bitmap[offset + 1] >> 4) << 4 | (bitmap[offset + 2] >> 4);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const top = [...counts.values()].sort((a, b) => b - a);
  const rest = pixels - top[0];
  // Measured on 49 real screenshots and 30 stock photographs: 48 screens and 2 photographs
  // (a pastel flat-lay, a cut-out on black) reach two thirds.
  const nextEight = top.slice(1, 9).reduce((sum, count) => sum + count, 0);
  return rest > 0 ? nextEight / rest >= 0.66 : true;
}

const WARNING_EXAMPLES_PER_CODE = 2;
const WARNING_SCENES_PER_CODE = 12;
const WARNING_MESSAGE_MAX = 200;

type CheckWarningEvidence = Record<string, number | string | Record<string, number>>;
export type CheckWarningExample = {
  scene_id?: string;
  selector?: string;
  message: string;
  /** Observations of this located target, not a count of distinct frames. */
  occurrences?: number;
  /** Scene-local time of the same observation as message and evidence. */
  scene_time_sec?: number;
  evidence?: CheckWarningEvidence;
};

export type CheckWarningRow = {
  code: string;
  /** Retains the original meaning: total finding observations. */
  count: number;
  scenes: string[];
  examples: CheckWarningExample[];
  /** Distinct scene/selector pairs; missing in legacy records means unknown. */
  target_count?: number;
  unlocated_count?: number;
  omitted_targets?: number;
};

const WARNING_MEASUREMENTS: Readonly<Record<string, readonly string[]>> = {
  LOW_CONTRAST: ['contrast_ratio', 'minimum_ratio'],
  FONT_TOO_SMALL: ['font_size_px', 'minimum_px'],
  TEXT_OVERFLOW: [],
  ELEMENT_OUT_OF_CANVAS: ['intersection_ratio'],
  SAFE_AREA_VIOLATION: [],
  TEXT_DENSITY_HIGH: ['character_count'],
  TEXT_OCCLUDED: ['overlap_area', 'overlap_ratio'],
};

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function warningEvidence(code: string, value: unknown): CheckWarningEvidence | undefined {
  const keys = Object.hasOwn(WARNING_MEASUREMENTS, code) ? WARNING_MEASUREMENTS[code] : undefined;
  if (!keys || !value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const pick = (record: Record<string, unknown>, names: readonly string[]): Record<string, number> => {
    const result: Record<string, number> = {};
    for (const name of names) if (finiteNumber(record[name])) result[name] = record[name];
    return result;
  };
  const result: CheckWarningEvidence = pick(source, keys);
  const groups: Array<[string, readonly string[]]> = [
    ['rect', ['left', 'top', 'width', 'height']], ['canvas', ['width', 'height']],
    ...(code === 'TEXT_OVERFLOW' ? [['overflow_pixels', ['x', 'y']] as [string, string[]]] : []),
    ...(code === 'ELEMENT_OUT_OF_CANVAS' ? [['overflow_pixels', ['left', 'top', 'right', 'bottom']] as [string, string[]]] : []),
    ...(code === 'SAFE_AREA_VIOLATION' ? [['safe_area', ['x', 'y']] as [string, string[]]] : []),
  ];
  for (const [name, fields] of groups) {
    const record = source[name];
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
    const numbers = pick(record as Record<string, unknown>, fields);
    if (Object.keys(numbers).length) result[name] = numbers;
  }
  if (code === 'TEXT_OCCLUDED' && typeof source.other_selector === 'string') result.other_selector = source.other_selector.slice(0, 200);
  return Object.keys(result).length ? result : undefined;
}

function boundedWarningExample(code: string, example: CheckWarningExample): CheckWarningExample {
  const evidence = warningEvidence(code, example.evidence);
  return {
    ...(example.scene_id ? { scene_id: example.scene_id.slice(0, 80) } : {}),
    ...(example.selector ? { selector: example.selector.slice(0, 200) } : {}),
    message: example.message.slice(0, WARNING_MESSAGE_MAX),
    ...(example.occurrences !== undefined ? { occurrences: example.occurrences } : {}),
    ...(example.scene_time_sec !== undefined ? { scene_time_sec: example.scene_time_sec } : {}),
    ...(evidence ? { evidence } : {}),
  };
}

/** Shared by the inline check and persisted reviews so neither loses measured facts. */
export function boundedCheckWarning(row: CheckWarningRow): CheckWarningRow {
  return {
    code: row.code.slice(0, 80), count: row.count,
    scenes: row.scenes.slice(0, WARNING_SCENES_PER_CODE).map(scene => scene.slice(0, 80)),
    examples: row.examples.slice(0, WARNING_EXAMPLES_PER_CODE).map(example => boundedWarningExample(row.code, example)),
    ...(row.target_count !== undefined ? { target_count: row.target_count } : {}),
    ...(row.unlocated_count !== undefined ? { unlocated_count: row.unlocated_count } : {}),
    ...(row.omitted_targets !== undefined ? { omitted_targets: row.omitted_targets } : {}),
  };
}

type CheckObservation = { code: string; message: string; sceneId?: string; selector?: string; sampleTimeSec?: number; evidence?: Record<string, unknown> };

/** One pass over existing observations, with at most two representative examples.
 * Full identities stay in nested maps rather than copied concatenated strings.
 */
export function summarizeCheckWarnings(warnings: ReadonlyArray<CheckObservation>): CheckWarningRow[] {
  type Target = { occurrences: number; example?: CheckWarningExample };
  const rows = new Map<string, { row: CheckWarningRow; targets: Map<string, Map<string, Target>>;
    examples: Array<{ scene: string; selector?: string; target?: Target }> }>();
  for (const warning of warnings) {
    let state = rows.get(warning.code);
    if (!state) {
      state = { row: { code: warning.code, count: 0, scenes: [], examples: [], target_count: 0, unlocated_count: 0 }, targets: new Map(), examples: [] };
      rows.set(warning.code, state);
    }
    const { row } = state;
    row.count += 1;
    if (warning.sceneId && !row.scenes.includes(warning.sceneId) && row.scenes.length < WARNING_SCENES_PER_CODE) {
      row.scenes.push(warning.sceneId);
    }
    const scene = warning.sceneId || '';
    const selector = warning.selector || undefined;
    let target: Target | undefined;
    if (selector) {
      let targets = state.targets.get(scene);
      if (!targets) { targets = new Map(); state.targets.set(scene, targets); }
      target = targets.get(selector);
      if (target) {
        target.occurrences += 1;
        if (target.example) target.example.occurrences = target.occurrences;
        continue;
      }
      target = { occurrences: 1 };
      targets.set(selector, target);
      row.target_count! += 1;
    } else {
      row.unlocated_count! += 1;
      if (state.examples.some(example => example.scene === scene && !example.selector)) continue;
    }
    // Cover another scene before spending both slots in the first scene.
    const index = row.examples.length < WARNING_EXAMPLES_PER_CODE ? row.examples.length
      : state.examples.every(example => example.scene === state!.examples[0].scene) && scene !== state.examples[0].scene ? 1 : -1;
    if (index >= 0) {
      const example = boundedWarningExample(warning.code, {
        ...(warning.sceneId ? { scene_id: warning.sceneId } : {}),
        ...(selector ? { selector, occurrences: 1 } : {}),
        message: warning.message,
        ...(warning.sceneId && finiteNumber(warning.sampleTimeSec) && warning.sampleTimeSec >= 0 ? { scene_time_sec: warning.sampleTimeSec } : {}),
        ...(warning.evidence ? { evidence: warning.evidence as CheckWarningEvidence } : {}),
      });
      const replaced = state.examples[index]?.target;
      if (replaced) replaced.example = undefined;
      if (target) target.example = example;
      state.examples[index] = { scene, selector, target };
      row.examples[index] = example;
    }
  }
  return [...rows.values()].map(({ row, examples }) => {
    const omitted = row.target_count! - examples.filter(example => example.target).length;
    if (omitted > 0) row.omitted_targets = omitted;
    return boundedCheckWarning(row);
  });
}

const SHEET_CELL_LONG_EDGE = 480;

/** Contact-sheet cells shaped like the video, so that each frame fills its cell. */
export function sheetLayoutFor(width: number, height: number): { thumbWidth: number; thumbHeight: number; columns: number } {
  if (height > width) {
    return { thumbWidth: Math.round(SHEET_CELL_LONG_EDGE * width / height), thumbHeight: SHEET_CELL_LONG_EDGE, columns: 6 };
  }
  return { thumbWidth: SHEET_CELL_LONG_EDGE, thumbHeight: Math.round(SHEET_CELL_LONG_EDGE * height / width), columns: width > height ? 3 : 4 };
}

export type CaptionCue = { startSec: number; endSec: number; text: string };

const CAPTION_MAX_WIDTH = 42;

function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += ch.charCodeAt(0) > 0x2e7f ? 2 : 1;
  return width;
}

/** Cut one over-long phrase without losing a character or splitting a word. */
function breakByWidth(text: string): string[] {
  const out: string[] = [];
  let line = '';
  // A Latin word stays whole; each CJK character is its own unit.
  for (const unit of text.match(/[⺀-￿]|[^\s⺀-￿]+|\s+/g) ?? []) {
    if (line && displayWidth(line.trimEnd() + unit) > CAPTION_MAX_WIDTH) {
      out.push(line.trim());
      line = /^\s+$/.test(unit) ? '' : unit;
    } else {
      line += unit;
    }
  }
  if (line.trim()) out.push(line.trim());
  return out;
}

function captionLines(sentence: string): string[] {
  if (displayWidth(sentence) <= CAPTION_MAX_WIDTH) return [sentence];
  const lines: string[] = [];
  let line = '';
  for (const part of sentence.match(/[^，、,：:]+[，、,：:]?\s*/g) ?? [sentence]) {
    if (line && displayWidth((line + part).trim()) > CAPTION_MAX_WIDTH) {
      lines.push(line.trim());
      line = '';
    }
    line += part;
  }
  if (line.trim()) lines.push(line.trim());
  return lines
    .flatMap((candidate) => (displayWidth(candidate) > CAPTION_MAX_WIDTH ? breakByWidth(candidate) : [candidate]))
    .map((candidate) => candidate.replace(/[，、,：:]$/, ''));
}

/**
 * Page captions: sentence by sentence, with time shared by length. Good enough for
 * a short ad over one line of speech; a long cut burns real transcript timing with
 * edit_video instead.
 */
export function captionCues(text: string, durationSec: number): CaptionCue[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized || !(durationSec > 0)) return [];
  // A period only ends a sentence before a space or the end, so 1.5 and orkas.ai
  // stay whole.
  const sentences = normalized
    .split(/(?<=[。！？!?；;…])\s*|(?<=\.)(?=\s|$)\s*/)
    .map((sentence) => sentence.replace(/[。！!；;….]+$/, '').trim())
    .filter(Boolean);
  const lines = sentences.flatMap(captionLines);
  const totalWidth = lines.reduce((sum, line) => sum + displayWidth(line), 0);
  let consumed = 0;
  let previousEnd = 0;
  return lines.map((line, index) => {
    consumed += displayWidth(line);
    const endSec = index === lines.length - 1 ? durationSec : durationSec * consumed / totalWidth;
    const cue = { startSec: previousEnd, endSec, text: line };
    previousEnd = endSec;
    return cue;
  });
}

export type TimelineAudioTrack = {
  absPath: string;
  startSec: number;
  volume: number;
  loop?: boolean;
  inSec?: number;
  durSec?: number;
  fadeInSec?: number;
  fadeOutSec?: number;
  duck?: boolean;
  /** Speech the music ducks under. */
  voice?: boolean;
};

/** Every sound in the video, positioned from the derived timeline so a moved
 *  scene takes its narration and kept clip sound with it. */
export function timelineAudioTracks(input: {
  manifest: VideoManifestV3;
  timeline: DerivedTimeline;
  resolve: (assetId: string) => string;
}): TimelineAudioTrack[] {
  const { manifest, timeline, resolve } = input;
  const tracks: TimelineAudioTrack[] = (manifest.tracks ?? []).map((track) => ({
    absPath: resolve(track.asset),
    startSec: 0,
    volume: track.volume,
    ...(track.kind === 'music' ? { loop: true } : {}),
    ...(track.fade_in ? { fadeInSec: track.fade_in } : {}),
    ...(track.fade_out ? { fadeOutSec: track.fade_out } : {}),
    ...(track.duck ? { duck: true } : {}),
    ...(track.kind === 'narration' ? { voice: true } : {}),
  }));
  for (const derived of timeline.scenes) {
    const scene = manifest.scenes[derived.index];
    if (scene.narration?.asset) {
      tracks.push({ absPath: resolve(scene.narration.asset), startSec: derived.startSec, volume: 1, voice: true });
    }
    for (const clip of derived.clips) {
      const authored = scene.clips?.find((candidate) => candidate.id === clip.id);
      if (authored?.audio !== 'keep') continue;
      tracks.push({
        absPath: resolve(clip.assetId),
        startSec: derived.startSec + clip.startFrame / timeline.fps,
        inSec: clip.inSec,
        durSec: clip.frameCount / timeline.fps,
        volume: authored.volume ?? 1,
        voice: true,
      });
    }
  }
  return tracks;
}

/**
 * The script the render window runs after load. Every call carries everything the
 * frame needs, so frames can be rendered in any order and a retry in a fresh window
 * cannot depend on what the previous one did.
 */
export function buildVideoTimelineAdapterScript(absolutePage?: VideoManifestV3['absolute_page']): string {
  return `
(() => {
  const absolutePage = ${JSON.stringify(absolutePage ?? null)};
  const pageStartOf = (sceneId) => (absolutePage ? absolutePage.scene_starts[sceneId] : undefined);
  const timelines = () => window.__timelines || {};
  const sections = () => Array.from(document.querySelectorAll('[data-scene-id]'));
  function seekTimeline(id, t) {
    const tl = timelines()[id];
    if (!tl) return;
    if (typeof tl.pause === 'function') tl.pause();
    // GSAP skips rendering when the playhead is already at the requested time,
    // which would leave frame 0 of every scene unapplied.
    const before = typeof tl.time === 'function' ? Number(tl.time()) : NaN;
    if (typeof tl.seek === 'function') tl.seek(t, false);
    else if (typeof tl.time === 'function') tl.time(t, false);
    if (Number.isFinite(before) && Math.abs(before - t) < 1e-6 && typeof tl.render === 'function') tl.render(t, false, true);
  }
  function seekWebAnimations(t) {
    for (const anim of document.getAnimations({ subtree: true })) {
      anim.pause();
      anim.currentTime = t * 1000;
    }
  }
  // How the old renderer showed a page with no timeline.
  function applyTimedVisibility(t) {
    for (const el of document.querySelectorAll('.clip[data-start][data-duration]')) {
      const start = Number(el.getAttribute('data-start')) || 0;
      const duration = Number(el.getAttribute('data-duration'));
      if (Number.isFinite(duration)) el.style.visibility = t >= start && t <= start + duration ? '' : 'hidden';
    }
  }
  async function showClips(section, clips) {
    const pending = [];
    for (const img of section.querySelectorAll('img[data-clip]')) {
      const url = clips[img.getAttribute('data-clip')];
      if (!url) {
        img.setAttribute('data-orkas-hidden', '');
        continue;
      }
      img.removeAttribute('data-orkas-hidden');
      if (img.dataset.orkasUrl === url) continue;
      img.dataset.orkasUrl = url;
      img.src = url;
      pending.push(img.decode());
    }
    await Promise.all(pending);
  }
  // Chromium paints a large image only once a background decode finishes, so a scene's
  // first capture can miss it. Wait for that once per scene, before its first frame.
  const decodedSections = new WeakSet();
  async function decodeSectionImages(section) {
    if (decodedSections.has(section)) return;
    decodedSections.add(section);
    const urls = new Set();
    for (const el of [section, ...section.querySelectorAll('*')]) {
      if (el.tagName === 'IMG' && !el.hasAttribute('data-clip') && el.currentSrc) urls.add(el.currentSrc);
      for (const match of getComputedStyle(el).backgroundImage.matchAll(/url\\("([^"]+)"\\)/g)) urls.add(match[1]);
    }
    await Promise.all(Array.from(urls, (url) => {
      const image = new Image();
      image.src = url;
      return image.decode().catch(() => {});
    }));
  }
  for (const tl of Object.values(timelines())) {
    if (tl && typeof tl.pause === 'function') tl.pause();
  }
  window.__ORKAS_VIDEO__ = {
    timelineKeys: () => Object.keys(timelines()),
    renderFrame: async (sceneId, t, clips, caption) => {
      const all = sections();
      const active = all.find((section) => section.getAttribute('data-scene-id') === sceneId);
      if (!active) throw new Error('scene is not in the page: ' + sceneId);
      const pageStart = pageStartOf(sceneId);
      const onPageTimeline = typeof pageStart === 'number';
      // A scene on the page's one timeline shows what that timeline shows, the way the old
      // video was made, even where it disagrees with the scene list. Any other scene is the
      // host's to show, alone.
      const showing = all.filter((section) => (
        section === active || (onPageTimeline && typeof pageStartOf(section.getAttribute('data-scene-id')) === 'number')
      ));
      await Promise.all(showing.map(decodeSectionImages));
      await showClips(active, clips);
      // Only now, with nothing left to wait for, so no paint can show a frame half set up.
      for (const section of all) {
        if (showing.includes(section)) section.removeAttribute('data-orkas-hidden');
        else section.setAttribute('data-orkas-hidden', '');
      }
      // A page that hides its sections by default would otherwise render blank frames with
      // nothing wrong in the check.
      if (!onPageTimeline && getComputedStyle(active).display === 'none') active.style.display = 'block';
      if (onPageTimeline) {
        const pageTime = pageStart + t;
        if (absolutePage.timeline_key) seekTimeline(absolutePage.timeline_key, pageTime);
        else applyTimedVisibility(pageTime);
        seekWebAnimations(pageTime);
      } else {
        seekTimeline(sceneId, t);
        seekWebAnimations(t);
      }
      const captionEl = active.querySelector('[data-orkas-caption]');
      if (captionEl) captionEl.textContent = caption || '';
    },
  };
})()
`;
}
