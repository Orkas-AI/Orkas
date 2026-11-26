/**
 * The delivery gate: judges the final file, however it was made.
 *
 * On 2026-08-10 a hand-written ffmpeg join delivered two voices overlapping for
 * 0.44s, -18.3 LUFS and none of its 8 caption lines, because every check lived on
 * the operation it had skipped. So this looks only at the file and at what was
 * declared for it: the timeline when the video has one, or the caller's own
 * expectations for a video made with ffmpeg alone.
 */
import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { createLogger } from '../logger';
import { writeBytesAtomic } from '../storage';
import { bundledFfmpegPaths } from '../util/bundled-runtime';
import { versionedChatMediaLocalUrl } from '../util/chat-media-url';
import { narrationPlaybackIssues, originalClipAudioWarnings, type KeptClipAudio } from './video_narration_playback';
import { fileEditLock } from '../util/locks';
import { logErrorSummary } from '../util/log-redact';
import { isPathAllowed } from '../util/path-sandbox';
import { sha256OfFileStream } from '../util/sha256';
import { uniquifyPath } from '../util/uniquify-path';
import { runVideoProcessForTest, type VideoStudioResult } from './video_studio';
import {
  assessDeliveredNarration,
  assessDeliveredSpec,
  assessSilentStretches,
  cutsOffBeatIssues,
  measureDeliveredAudio,
  narrationOverSpeechIssues,
  measureVoicedSpan,
  probeDeliveredVideo,
  type DeliveryNarrationLine,
} from './video_studio_delivery';
import { spreadIndexes } from './video_phrases';
import { compareWithReference } from './video_reference_compare';
import { writeFrameContactSheet } from './video_studio_qa';
import { deriveVideoTimeline, sheetLayoutFor, spokenWords, timelineAudioTracks, validateVideoTimeline, VideoAssetLedgerSchema, type VideoAssetRecord } from './video_timeline';
import { loadVideoProject, markTimelineDelivered, renderedBeforeLastChange, renderedVisualReview, parseVisualReview, verifyRenderedAudioSources, visualReview, type VideoVisualReview } from './video_timeline_render';

const log = createLogger('video-timeline-ship');

/** Where a delivered version keeps its own file. The next render replaces the file it
 *  was made from, and the user's link to this version has to keep playing this version. */
const VERSIONS_DIR = 'versions';

/** Streams this far apart mean one of them stops before the other does. */
const AV_DURATION_TOLERANCE_SEC = 0.5;
const STATIC_SHARE_HINT = 0.4;
/** A video stops when the still pictures in its scenes without footage stand still for more
 *  than this share of it. 2026-11-15–21: three of eleven users who got a video called it a set
 *  of pictures and cards, one at 82% still. 2026-11-22: counting only videos whose product.json
 *  named something missed a site promo that held its screenshots 59% of the time, and stopped
 *  explainers that named their topic there (13 of 45 kept benchmark explainers, their diagrams
 *  drawn in the page and held while the voice explains, never judged too still). Over 115 kept
 *  deliveries, counting pictures alone stops the same promotions and adverts and no explainer. */
const HELD_STILLS_BLOCK = 0.5;
/** Scenes named in the message, most still first; the rest are counted. */
const HELD_STILLS_NAMED = 4;
const SHOTS_PER_SECOND_HINT = 1.5;
const HINT_DECODE_TIMEOUT_MS = 5 * 60 * 1000;
const HINT_SCENE_CHANGE_THRESHOLD = 0.35;
const STATIC_MIN_SEC = 1;
const DELIVERED_SHEET_FRAMES = 12;
/** Lines of a voiced delivery shown, each with its frame, before its last frame. A 30 s tutorial
 *  narrated in one take had 13 clauses; eleven left out the click it named (2026-11-19). */
const HEARD_SHEET_LINES = 16;
/** A line's frame is taken this long before it ends, so a cut right after it does not show instead. */
const LINE_END_LOOK_SEC = 0.1;
/** The last frame gets a cell of its own unless the last line's frame is this close to it. */
const LAST_FRAME_SEPARATE_SEC = 0.5;
const DELIVERED_FRAME_TIMEOUT_MS = 30 * 1000;
const DELIVERED_SCENE_FRAME_WIDTH = 480;
const DELIVERED_SCENE_FRAMES_MAX = 64;
const LAST_FRAME_MARGIN_SEC = 0.05;
/** Earlier words kept per narration audio: enough for a few accepted changes and back. */
const DELIVERED_WORDS_PER_AUDIO = 8;
const QUOTED_WORDS_MAX = 200;
/** Narration files kept between deliveries: more lines than a video has, with room for retakes. */
const VOICES_KEPT = 32;
const VOICES_NAMED = 3;
/** How far above a narration file its production may be. */
const PRODUCTION_SEARCH_DEPTH = 8;

export type ShipIssue = {
  code: string;
  severity: 'error' | 'warning';
  message: string;
};

export type VideoVersion = {
  id: string;
  video_id?: string;
  path: string;
  sha256: string;
  /** The file it was made from, when the output policy changed its bytes. */
  source_sha256?: string;
  duration_sec: number | null;
  canvas: string | null;
  fps: number | null;
  integrated_lufs: number | null;
  visual_review?: VideoVisualReview;
  shipped_at: string;
  warnings: string[];
  /** Blocking findings the user chose to deliver anyway, and why. */
  override?: { codes: string[]; reason: string };
  /** The video carries a voice: it plays narration, narration was made for it, or its last
   *  version did. A music cut is not listened to, as a recognizer reads words into music. */
  voiced?: true;
};

export type HeldStillsFinding = {
  percent: number;
  scenes: { id: string; seconds: number }[];
};

class CanvasReviewExpired extends Error {}
class RenderedAudioChanged extends Error {}

const RENDERED_AUDIO_CHANGED: ShipIssue = {
  code: 'DELIVERY_TIMELINE_CHANGED', severity: 'error',
  message: 'The audio sources of this render could not be verified against the current timeline. Run video.render again, then deliver.',
};

export type VideoShipOptions = {
  productionDirAbs: string;
  allowedRoots: readonly string[];
  videoPathAbs: string;
  /** The timeline this file was rendered from, when there is one. */
  videoDirAbs?: string;
  /** What a video made with ffmpeg alone is supposed to be. */
  expect?: { durationSec?: number; aspect?: string; hasAudio?: boolean };
  override?: { codes: string[]; reason: string };
  /** Waits for the canvas' decision after all delivery checks. The returned guard
   * still owns the same canvas update when the version is recorded. */
  reviewHeldStills?: (finding: HeldStillsFinding) => Promise<(() => boolean) | null>;
  /** The video is cut to its music's beat, so each cut is checked against that beat. */
  cutToBeat?: boolean;
  /** The reference this video was made from: delivery sets the two side by side and
   *  names the quarters that move much less than the reference does. */
  referenceAbs?: string;
  /** Runs on the copy the version keeps, never on the file it was made from, which can be
   *  an old video or an attachment: the account's output policy can change its bytes,
   *  and the version records what the user receives. */
  finalize?: (fileAbs: string) => Promise<void>;
  signal?: AbortSignal;
};

export function parseVisualHints(stderr: string, durationSec: number): {
  staticShare: number; shots: number; frozen: Array<{ startSec: number; endSec: number }>;
} {
  const starts = [...stderr.matchAll(/freeze_start:\s*(-?[\d.]+)/g)].map((match) => Number(match[1]));
  const ends = [...stderr.matchAll(/freeze_end:\s*(-?[\d.]+)/g)].map((match) => Number(match[1]));
  let staticSec = 0;
  const frozen: Array<{ startSec: number; endSec: number }> = [];
  for (const [index, start] of starts.entries()) {
    const end = ends[index] ?? durationSec;
    staticSec += Math.max(0, end - start);
    if (end > start) frozen.push({ startSec: Math.max(0, start), endSec: end });
  }
  const shots = 1 + [...stderr.matchAll(/Parsed_showinfo.*\bn:\s*\d+/g)].length;
  return { staticShare: durationSec > 0 ? Math.min(1, staticSec / durationSec) : 0, shots, frozen };
}

type Span = { startSec: number; endSec: number };

/** Seconds of `from`..`to` that none of `spans` covers. */
function uncovered(from: number, to: number, spans: readonly Span[]): number {
  let left = to - from;
  let reach = from;
  for (const span of [...spans].sort((a, b) => a.startSec - b.startSec)) {
    const start = Math.max(span.startSec, reach);
    const end = Math.min(span.endSec, to);
    if (end > start) { left -= end - start; reach = end; }
  }
  return Math.max(0, left);
}

/** Seconds each scene that places a still picture stands still, most first. The time footage
 *  plays is left out: a recording may hold still, as a screen does between steps. Only that
 *  time: on 2026-11-23 a promotion put one stock clip and four screenshots in a single scene, so
 *  a scene-wide exemption delivered it 69% still. A scene drawn in the page alone is left out
 *  too: an explainer's diagram holds while the voice explains it. */
export function heldStillScenes(
  frozen: ReadonlyArray<Span>,
  scenes: ReadonlyArray<{ id: string; startSec: number; endSec: number; footage: readonly Span[]; pictures: boolean }>,
): Array<{ id: string; seconds: number }> {
  return scenes
    .filter((scene) => scene.pictures)
    .map((scene) => ({
      id: scene.id,
      seconds: frozen.reduce((sum, span) => {
        const from = Math.max(span.startSec, scene.startSec);
        const to = Math.min(span.endSec, scene.endSec);
        return to > from ? sum + uncovered(from, to, scene.footage) : sum;
      }, 0),
    }))
    .filter((scene) => scene.seconds > 0.001)
    .sort((a, b) => b.seconds - a.seconds);
}

function heldStillsWhere(scenes: ReadonlyArray<{ id: string; seconds: number }>): string {
  const named = scenes.slice(0, HELD_STILLS_NAMED).map((scene) => `"${scene.id}" (${scene.seconds.toFixed(1)} s)`);
  const more = scenes.length - named.length;
  return `${scenes.length === 1 ? 'scene' : 'scenes'} ${named.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
}

/** What a video built from held stills should do next. */
export function heldStillsMessage(share: number, scenes: ReadonlyArray<{ id: string; seconds: number }>): string {
  return `${Math.round(share * 100)}% of this video is a still frame held for a second or more, so it plays as a slideshow. It stands still in ${heldStillsWhere(scenes)}. Make those scenes move, then render and deliver again: where the shot need not be the user's own, such as a place or people using this kind of thing, cut to suitable available footage; where it is the user's own product or photo, move across it with a slow push in, pan or scroll; on a screen of a site or app, show the step the line names done on it with ./assets/vendor/screen-demo.js (timeline.md).`;
}

/** Said when a video stopped once for held stills comes back still held: it is delivered, so
 *  changes cannot go round and round. */
export function heldStillsDeliveredMessage(share: number, scenes: ReadonlyArray<{ id: string; seconds: number }>): string {
  return `${Math.round(share * 100)}% of this video still stands still after one round of changes, in ${heldStillsWhere(scenes)}. It is delivered as it is: say in your reply which scenes still hold still, so the user can ask for more movement.`;
}

async function visualHintIssues(
  ffmpeg: string, videoAbs: string, durationSec: number | null, signal?: AbortSignal,
  timeline?: Pick<TimelineFacts, 'sceneSpans'> | null,
  /** This video was stopped for held stills since its last delivery, on other bytes. */
  stoppedBefore = false,
  onHeldStills?: (finding: HeldStillsFinding) => void,
): Promise<ShipIssue[]> {
  if (!durationSec || durationSec <= 0) return [];
  const run = await runVideoProcessForTest(ffmpeg, [
    '-hide_banner', '-nostats', '-i', videoAbs,
    '-map', '0:v:0',
    '-vf', `scale=240:-2,freezedetect=n=-55dB:d=${STATIC_MIN_SEC},select='gt(scene,${HINT_SCENE_CHANGE_THRESHOLD})',showinfo`,
    '-f', 'null', '-',
  ], { timeoutMs: HINT_DECODE_TIMEOUT_MS, ...(signal ? { signal } : {}) });
  if (run.code !== 0) {
    log.warn('visual hint pass failed', { code: run.code });
    return [];
  }
  const { staticShare, shots, frozen } = parseVisualHints(run.stderr, durationSec);
  const issues: ShipIssue[] = [];
  const held = timeline ? heldStillScenes(frozen, timeline.sceneSpans) : [];
  const heldShare = held.reduce((sum, scene) => sum + scene.seconds, 0) / durationSec;
  if (heldShare > HELD_STILLS_BLOCK) {
    onHeldStills?.({
      percent: Math.min(100, Math.round(heldShare * 100)),
      scenes: held.slice(0, HELD_STILLS_NAMED),
    });
    issues.push(stoppedBefore
      ? { code: 'DELIVERY_HELD_STILLS', severity: 'warning', message: heldStillsDeliveredMessage(heldShare, held) }
      : { code: 'DELIVERY_HELD_STILLS', severity: 'error', message: heldStillsMessage(heldShare, held) });
  } else if (staticShare > STATIC_SHARE_HINT) {
    issues.push({
      code: 'DELIVERY_MOSTLY_STATIC',
      severity: 'warning',
      message: `${Math.round(staticShare * 100)}% of the video does not move for a second or more at a time. Ads read as slides when this is high.`,
    });
  }
  if (durationSec >= 3 && shots / durationSec > SHOTS_PER_SECOND_HINT) {
    issues.push({
      code: 'DELIVERY_SHOTS_TOO_SHORT',
      severity: 'warning',
      message: `${shots} shots in ${durationSec.toFixed(1)}s is more than a viewer can follow.`,
    });
  }
  return issues;
}

/** A narrated scene's words and the audio heard with them, by the audio's bytes, so a copy
 *  under another name is the same voice. */
type VoicedWords = { sceneId: string; text: string; audioSha256: string; record: VideoAssetRecord };

type TimelineFacts = {
  videoId: string;
  durationSec: number;
  aspect: string;
  hasAudio: boolean;
  keptClipAudio: KeptClipAudio[];
  lines: DeliveryNarrationLine[];
  voiced: VoicedWords[];
  /** A scene speaks, or a narration track plays. */
  playsNarration: boolean;
  /** Every file the tracks play, whatever they are labelled. */
  trackAudio: Set<string>;
  assets: readonly VideoAssetRecord[];
  /** When each scene is fully built: its last frame. */
  sceneEnds: Array<{ id: string; atSec: number }>;
  /** Where each scene plays, when within it footage shows, and whether it places a still picture. */
  sceneSpans: Array<{ id: string; startSec: number; endSec: number; footage: Span[]; pictures: boolean }>;
};

async function timelineExpectations(input: {
  productionDirAbs: string;
  videoDirAbs: string;
  allowedRoots: readonly string[];
  signal?: AbortSignal;
}): Promise<{ timeline: TimelineFacts | null; issues: ShipIssue[] }> {
  const project = await loadVideoProject({
    productionDirAbs: input.productionDirAbs,
    videoDirAbs: input.videoDirAbs,
    allowedRoots: input.allowedRoots,
  });
  const issues: ShipIssue[] = project.issues.map((issue) => ({
    code: issue.code,
    severity: issue.severity === 'error' ? 'error' : 'warning',
    message: issue.message,
  }));
  if (!project.manifest) return { timeline: null, issues };
  const { manifest } = project;
  for (const issue of validateVideoTimeline({ manifest, assets: project.assets, product: project.product })) {
    issues.push({ code: issue.code, severity: issue.severity === 'error' ? 'error' : 'warning', message: issue.message });
  }
  const timeline = deriveVideoTimeline(manifest);
  const lines: DeliveryNarrationLine[] = [];
  const voiced: VoicedWords[] = [];
  const byId = new Map(project.assets.map((asset) => [asset.id, asset]));
  for (const derived of timeline.scenes) {
    const scene = manifest.scenes[derived.index];
    if (!scene.narration?.asset) continue;
    const record = byId.get(scene.narration.asset);
    if (!record) continue;
    const audioAbs = path.resolve(input.productionDirAbs, record.path);
    if (!isPathAllowed(audioAbs, input.allowedRoots)) {
      issues.push({ code: 'TIMELINE_ASSET_OUT_OF_SCOPE', severity: 'error', message: `Narration in scene "${scene.id}" points outside the files this task can use.` });
      continue;
    }
    const span = await measureVoicedSpan(audioAbs, input.signal);
    if (!span) {
      issues.push({ code: 'TIMELINE_ASSET_MISSING', severity: 'error', message: `Narration in scene "${scene.id}" could not be read.` });
      continue;
    }
    lines.push({
      index: derived.index,
      startSec: derived.startSec,
      targetSec: derived.durationSec,
      voicedStartSec: derived.startSec + span.startSec,
      voicedEndSec: derived.startSec + span.endSec,
      textHead: scene.narration.text.slice(0, 20),
    });
    // Unhashable costs this scene its check, never the delivery.
    const audioSha256 = await sha256OfFileStream(audioAbs).catch(() => null);
    if (audioSha256) voiced.push({ sceneId: scene.id, text: scene.narration.text, audioSha256, record });
  }
  const tracks = manifest.tracks ?? [];
  const audioTracks = timelineAudioTracks({ manifest, timeline, resolve: (id) => id });
  const keptClipAudio = audioTracks.flatMap((track) => {
    const record = byId.get(track.absPath);
    if (track.inSec === undefined || track.durSec === undefined || track.volume <= 0 || record?.kind !== 'video') return [];
    return [{ sourceAbs: path.resolve(input.productionDirAbs, record.path), sourceStartSec: track.inSec,
      startSec: track.startSec, durationSec: track.durSec }];
  });
  return {
    timeline: {
      videoId: manifest.id,
      durationSec: timeline.durationSec,
      aspect: `${manifest.canvas.width}:${manifest.canvas.height}`,
      hasAudio: audioTracks.some((track) => track.volume > 0),
      keptClipAudio,
      lines,
      voiced,
      playsNarration: manifest.scenes.some((scene) => !!scene.narration?.asset) || tracks.some((track) => track.kind === 'narration'),
      assets: project.assets,
      trackAudio: new Set(tracks.flatMap((track) => {
        const record = byId.get(track.asset);
        return record ? [path.resolve(input.productionDirAbs, record.path)] : [];
      })),
      sceneEnds: timeline.scenes.map((scene) => ({ id: scene.id, atSec: (scene.startFrame + scene.frameCount - 1) / timeline.fps })),
      sceneSpans: timeline.scenes.map((scene) => ({
        id: scene.id,
        startSec: scene.startFrame / timeline.fps,
        endSec: (scene.startFrame + scene.frameCount) / timeline.fps,
        footage: scene.clips.filter((clip) => byId.get(clip.assetId)?.kind === 'video').map((clip) => ({
          startSec: (scene.startFrame + clip.startFrame) / timeline.fps,
          endSec: (scene.startFrame + clip.startFrame + clip.frameCount) / timeline.fps,
        })),
        pictures: (manifest.scenes[scene.index].clips ?? []).some((clip) => byId.get(clip.asset)?.kind === 'image'),
      })),
    },
    issues,
  };
}

/** A narration file made since the last delivery, relative to the production. */
type MadeVoice = { path: string; seconds?: number };

type VersionFile = {
  versions: VideoVersion[];
  /** The words each delivered narration audio was shown with, by the audio's sha256, newest
   *  last. Beside the versions, so the list the model and the canvas read is unchanged. */
  delivered_narration: Record<string, string[]>;
  /** Narration generated here since the last delivery, newest last. Written by the host. */
  voices_since_delivery: MadeVoice[];
  /** Videos stopped for held stills since their last delivery, with the sha256 of the file
   *  stopped. Another file of the same video is then delivered with the finding as a warning. */
  held_stills_stopped: Record<string, string>;
};

/** Unreadable is not empty: starting a new list would lose every earlier version. */
async function readVersionFile(file: string): Promise<VersionFile> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { versions: [], delivered_narration: {}, voices_since_delivery: [], held_stills_stopped: {} };
    throw err;
  }
  let stored: { versions?: unknown; delivered_narration?: unknown; voices_since_delivery?: unknown; held_stills_stopped?: unknown } | null;
  try {
    stored = JSON.parse(raw) as { versions?: unknown; delivered_narration?: unknown; voices_since_delivery?: unknown; held_stills_stopped?: unknown } | null;
  } catch {
    stored = null;
  }
  if (!Array.isArray(stored?.versions)) {
    throw new Error('versions.json here is not a list of delivered versions, so this delivery was not recorded and the file was left alone. If it is damaged, repair it. If it belongs to something else, make this production in a folder of its own.');
  }
  return {
    versions: stored.versions as VideoVersion[],
    delivered_narration: deliveredWords(stored.delivered_narration),
    voices_since_delivery: madeVoices(stored.voices_since_delivery),
    held_stills_stopped: stoppedFiles(stored.held_stills_stopped),
  };
}

/** A malformed entry only means the video can be stopped for held stills once more. */
function stoppedFiles(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([videoId, sha256]) =>
    videoId.trim() && typeof sha256 === 'string' && /^[0-9a-f]{64}$/.test(sha256)));
}

/** A malformed entry, or one whose path leaves the production, is not one the host wrote. */
function madeVoices(value: unknown): MadeVoice[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const entry = (item && typeof item === 'object' ? item : {}) as { path?: unknown; seconds?: unknown };
    const relative = typeof entry.path === 'string' ? entry.path : '';
    const inside = relative && !path.isAbsolute(relative) && !path.normalize(relative).split(/[\\/]/).includes('..');
    if (!inside) return [];
    const seconds = typeof entry.seconds === 'number' && Number.isFinite(entry.seconds) && entry.seconds > 0 ? entry.seconds : undefined;
    return [{ path: relative, ...(seconds ? { seconds } : {}) }];
  });
}

/** A malformed entry costs its check, never a delivery. The canvas reads it too. */
export function deliveredWords(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const words: Record<string, string[]> = {};
  for (const [audioSha256, texts] of Object.entries(value)) {
    const kept = Array.isArray(texts) ? texts.filter((text): text is string => typeof text === 'string') : [];
    if (/^[0-9a-f]{64}$/.test(audioSha256) && kept.length) words[audioSha256] = kept;
  }
  return words;
}

/** Adds what this delivery showed with each audio, or returns null when nothing is new. */
function withDeliveredWords(stored: Record<string, string[]>, voiced: readonly VoicedWords[]): Record<string, string[]> | null {
  const next = { ...stored };
  let changed = false;
  for (const { audioSha256, text } of voiced) {
    const earlier = next[audioSha256] ?? [];
    if (earlier[earlier.length - 1] === text) continue;
    const others = earlier.filter((item) => spokenWords(item) !== spokenWords(text));
    next[audioSha256] = [...others, text].slice(-DELIVERED_WORDS_PER_AUDIO);
    changed = true;
  }
  return changed ? next : null;
}

async function writeVersionFile(file: string, stored: VersionFile): Promise<void> {
  const { versions, delivered_narration, voices_since_delivery, held_stills_stopped } = stored;
  const body = {
    versions,
    ...(Object.keys(delivered_narration).length ? { delivered_narration } : {}),
    ...(voices_since_delivery.length ? { voices_since_delivery } : {}),
    ...(Object.keys(held_stills_stopped).length ? { held_stills_stopped } : {}),
  };
  await writeBytesAtomic(file, Buffer.from(`${JSON.stringify(body, null, 2)}\n`));
}

/** Remember the file a video was stopped for held stills on. Unrecorded, the next file would be
 *  stopped again, so a list that cannot be read or written is left alone and logged. */
async function noteHeldStillsStop(productionDirAbs: string, videoId: string, sha256: string): Promise<void> {
  const file = path.join(productionDirAbs, 'versions.json');
  if (!isPathAllowed(file, [productionDirAbs])) return;
  await fileEditLock(file).runExclusive(async () => {
    const stored = await readVersionFile(file);
    if (stored.held_stills_stopped[videoId]) return;
    await writeVersionFile(file, { ...stored, held_stills_stopped: { ...stored.held_stills_stopped, [videoId]: sha256 } });
  }).catch((err) => log.warn('held stills stop not recorded', { error: logErrorSummary(err, { closed: true }) }));
}

/** The nearest folder at or above the file, within the workspace, that holds a production. */
export async function productionHolding(fileAbs: string, workspaceAbs: string): Promise<string | null> {
  const top = path.resolve(workspaceAbs);
  let dir = path.dirname(path.resolve(fileAbs));
  for (let depth = 0; depth <= PRODUCTION_SEARCH_DEPTH; depth += 1) {
    const relative = path.relative(top, dir);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
    const holds = await fs.stat(path.join(dir, 'videos')).then((st) => st.isDirectory(), () => false)
      || await fs.stat(path.join(dir, 'assets.json')).then((st) => st.isFile(), () => false);
    if (holds) return dir;
    if (!relative) return null;
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * Note narration generated for a production, so a delivery that plays none of it is stopped.
 * On 2026-11-07 Luna voiced a 12-second script as one file, found it longer than any of its
 * 4-second scenes and delivered a silent video the user had asked to be narrated. A file outside
 * every production is not noted; a list that cannot be read is left alone and this throws.
 */
export async function recordProductionVoice(input: { workspaceAbs: string; fileAbs: string; seconds?: number }): Promise<void> {
  const productionDirAbs = await productionHolding(input.fileAbs, input.workspaceAbs);
  if (!productionDirAbs) return;
  const relative = path.relative(productionDirAbs, path.resolve(input.fileAbs)).split(path.sep).join('/');
  const seconds = typeof input.seconds === 'number' && Number.isFinite(input.seconds) && input.seconds > 0
    ? Math.round(input.seconds * 10) / 10
    : undefined;
  const file = path.join(productionDirAbs, 'versions.json');
  // A link here could carry the write out of the production.
  if (!isPathAllowed(file, [productionDirAbs]) || !isPathAllowed(productionDirAbs, [input.workspaceAbs])) {
    throw new Error('versions.json resolves outside its production');
  }
  await fileEditLock(file).runExclusive(async () => {
    const stored = await readVersionFile(file);
    const voices = [...stored.voices_since_delivery.filter((voice) => voice.path !== relative), { path: relative, ...(seconds ? { seconds } : {}) }];
    await writeVersionFile(file, { ...stored, voices_since_delivery: voices.slice(-VOICES_KEPT) });
  });
}

/**
 * Narration whose words changed while its audio stayed the same file. Changing the words
 * changes the captions, not what is heard: on 2026-11-06 Luna changed a spoken price this
 * way in 4 of 12 runs, the voice kept the old price and three replies said it was updated.
 * Words the audio was delivered with before, such as ones the user chose to keep, pass.
 */
function staleNarration(voiced: readonly VoicedWords[], delivered: Record<string, string[]>): ShipIssue[] {
  return voiced.flatMap((line) => {
    const earlier = delivered[line.audioSha256];
    if (!earlier?.length || earlier.some((text) => spokenWords(text) === spokenWords(line.text))) return [];
    return [{ code: 'DELIVERY_NARRATION_NOT_REVOICED', severity: 'error' as const, message: staleNarrationMessage(line, earlier[earlier.length - 1]) }];
  });
}

function staleNarrationMessage(line: VoicedWords, deliveredText: string): string {
  const quoted = Array.from(deliveredText);
  const said = quoted.length > QUOTED_WORDS_MAX ? `${quoted.slice(0, QUOTED_WORDS_MAX).join('')}…` : deliveredText;
  const opening = `Scene "${line.sceneId}": the narration text changed but its audio is`;
  if (line.record.origin === 'upload') {
    return `${opening} the user's own recording, the same file as in the last delivery, when the text was "${said}". Only the user can record it again: tell them, and let them choose a new recording, captions only for this scene, or keeping it as it is.`;
  }
  const { route_ref: route, voice_ref: voice } = line.record.request ?? {};
  const named = typeof route === 'string' && typeof voice === 'string' ? ` (route_ref ${route}, voice_ref ${voice})` : '';
  return `${opening} the same file as in the last delivery, when the text was "${said}". Generate this line again with its voice${named}, point the scene's narration at the new file, then render and ship.`;
}

/** Narration made here since the last delivery, for a video that plays none of it. */
async function unplayedNarration(productionDirAbs: string, timeline: TimelineFacts, made: readonly MadeVoice[]): Promise<ShipIssue[]> {
  if (timeline.playsNarration || !made.length) return [];
  const waiting: MadeVoice[] = [];
  for (const voice of made) {
    const fileAbs = path.resolve(productionDirAbs, voice.path);
    if (timeline.trackAudio.has(fileAbs)) return [];
    if (!isPathAllowed(fileAbs, [productionDirAbs])) continue;
    if (await fs.stat(fileAbs).then((st) => st.isFile(), () => false)) waiting.push(voice);
  }
  if (!waiting.length) return [];
  const named = waiting.slice(0, VOICES_NAMED).map((voice) => (voice.seconds ? `${voice.path} (${voice.seconds.toFixed(1)} s)` : voice.path)).join(', ');
  const more = waiting.length > VOICES_NAMED ? ` and ${waiting.length - VOICES_NAMED} more` : '';
  const take = waiting.length === 1 ? waiting[0] : null;
  const asset = take?.seconds !== undefined && take.seconds <= timeline.durationSec
    ? timeline.assets.find((row) => row.kind === 'audio'
      && path.resolve(productionDirAbs, row.path) === path.resolve(productionDirAbs, take.path))
    : undefined;
  const repair = asset
    ? `Put it in the timeline as scene narration. If this take covers several scenes from the start, add ${JSON.stringify({ kind: 'narration', asset: asset.id, volume: 1 })} to manifest.json tracks instead. Render and ship the new file with video_id ${JSON.stringify(timeline.videoId)}.`
    : `Put ${waiting.length === 1 ? 'it' : 'them'} in the video, as scene narration or as a narration track when one file covers several scenes, then render and ship.`;
  return [{
    code: 'DELIVERY_NARRATION_MISSING',
    severity: 'error',
    message: `This video plays no narration, but narration was made for it: ${named}${more}. ${repair} If the user asked for no narration, ship with accept_findings and say why.`,
  }];
}

type KeptFile = { path: string; sha256: string };

async function recordVersion(input: {
  productionDirAbs: string;
  /** The file being delivered, as it is now. */
  sha256: string;
  videoId?: string;
  /** Match any version of the video, not only the latest. */
  anyVersion?: boolean;
  /** The words this delivery shows with each narration audio. */
  voiced?: readonly VoicedWords[];
  /** A delivery: narration made before it is no longer waiting for one. */
  delivers?: boolean;
  checkLatest?: (latest: VideoVersion | undefined) => Promise<void>;
  inspectRepeat?: (keptPath: string) => Promise<void>;
  keep: (id: string) => Promise<KeptFile>;
  build: (id: string, kept: KeptFile) => VideoVersion;
}): Promise<VideoVersion> {
  const file = path.join(input.productionDirAbs, 'versions.json');
  if (!isPathAllowed(file, [input.productionDirAbs])) throw new Error('That file is outside the files this task can use.');
  return fileEditLock(file).runExclusive(async () => {
    const stored = await readVersionFile(file);
    const { versions } = stored;
    const words = withDeliveredWords(stored.delivered_narration, input.voiced ?? []);
    const voices = input.delivers ? [] : stored.voices_since_delivery;
    // A delivery ends the round of changes the held-stills stop began.
    const { [input.videoId]: stoppedHere, ...stoppedElsewhere } = stored.held_stills_stopped;
    const stopped = input.delivers ? stoppedElsewhere : stored.held_stills_stopped;
    const same = (version: VideoVersion) => version.sha256 === input.sha256 || version.source_sha256 === input.sha256;
    const ofVideo = versions.filter((version) => version.video_id === input.videoId);
    if (input.checkLatest) await input.checkLatest(ofVideo.at(-1));
    // A repeat of the latest delivery is that delivery. Older bytes coming back are not:
    // moving a scene and moving it back has to end on the version showing that order.
    const existing = input.anyVersion ? ofVideo.find(same) : ofVideo.filter((_, index) => index === ofVideo.length - 1).find(same);
    if (existing) {
      const keptPath = typeof existing.path === 'string'
        ? path.resolve(input.productionDirAbs, existing.path) : '';
      if (!keptPath || !isPathAllowed(keptPath, [input.productionDirAbs])
          || await sha256OfFileStream(keptPath).catch(() => null) !== existing.sha256) {
        throw new Error('The previously delivered file is missing or changed. Restore that file or render a new version before delivering again.');
      }
      await input.inspectRepeat?.(keptPath);
      // Unchanged bytes can still carry new words, as with captions off, and are still delivered.
      if (words || voices.length !== stored.voices_since_delivery.length || (input.delivers && stoppedHere)) {
        await writeVersionFile(file, { versions, delivered_narration: words ?? stored.delivered_narration, voices_since_delivery: voices, held_stills_stopped: stopped });
      }
      return existing;
    }
    const id = `v${versions.length + 1}`;
    const version = input.build(id, await input.keep(id));
    versions.push(version);
    await writeVersionFile(file, { versions, delivered_narration: words ?? stored.delivered_narration, voices_since_delivery: voices, held_stills_stopped: stopped });
    return version;
  });
}

/** List a file delivered before this production was upgraded, so it stays a version
 *  that can be played and downloaded. It was judged by the rules of its day. */
export async function recordExistingVersion(input: {
  productionDirAbs: string;
  videoPathAbs: string;
  videoId: string;
  signal?: AbortSignal;
}): Promise<VideoVersion> {
  const [spec, sha256, stat] = await Promise.all([
    probeDeliveredVideo(input.videoPathAbs, input.signal),
    sha256OfFileStream(input.videoPathAbs),
    fs.stat(input.videoPathAbs),
  ]);
  return recordVersion({
    productionDirAbs: input.productionDirAbs,
    sha256,
    videoId: input.videoId,
    // A second pass over the old files has to find each of them again.
    anyVersion: true,
    keep: async () => ({ path: input.videoPathAbs, sha256 }),
    build: (id, kept) => ({
      id,
      video_id: input.videoId,
      path: portablePath(input.productionDirAbs, kept.path),
      sha256,
      duration_sec: spec?.durationSec ?? null,
      canvas: spec?.width && spec.height ? `${spec.width}x${spec.height}` : null,
      fps: spec?.fps ?? null,
      integrated_lufs: null,
      shipped_at: stat.mtime.toISOString(),
      warnings: ['DELIVERED_BEFORE_UPGRADE'],
    }),
  });
}

function portablePath(productionDirAbs: string, fileAbs: string): string {
  const relative = path.relative(productionDirAbs, fileAbs);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative.split(path.sep).join('/')
    : fileAbs;
}

/**
 * Frames of the delivered file, from its first frame to its last, for the model to
 * look at before it tells the user the video is done. No check here can read the
 * picture: on a live run Chinese text drawn with ffmpeg came out as empty boxes, passed
 * every measurement and went out as finished. Best effort: failing costs the look, not
 * the delivery.
 */
/** A line of a delivered file's voice, as it was heard. */
export type HeardLine = { startSec: number; endSec: number; text: string };

/** A frame of a sheet: where to take it, what its cell says, and the words heard there. */
export type SheetSample = { atSec: number; label: string; heard?: string };

/** Frames of a delivered file to look at. Twelve spread over it, or, when its voice was heard,
 *  one just before each line ends (up to sixteen lines), then its last frame (2026-11-17: a tutorial ended on the
 *  export spinner while its last line said the file was saved, and the evenly spaced frames
 *  showed the spinner beside nothing that claimed otherwise). Pure. */
export function deliveredFrameSamples(durationSec: number, heard: readonly HeardLine[] = []): SheetSample[] {
  const lastSec = Math.max(0, Math.round((durationSec - 0.1) * 1000) / 1000);
  if (!heard.length) {
    return Array.from({ length: DELIVERED_SHEET_FRAMES }, (_item, index) => {
      const atSec = lastSec * index / (DELIVERED_SHEET_FRAMES - 1);
      return { atSec, label: `${atSec.toFixed(1)}s` };
    });
  }
  const samples: SheetSample[] = spreadIndexes(heard.length, HEARD_SHEET_LINES).map((index, order) => {
    const line = heard[index];
    const atSec = Math.round(Math.min(lastSec, Math.max(line.startSec, line.endSec - LINE_END_LOOK_SEC)) * 1000) / 1000;
    return { atSec, label: `#${order + 1} ${atSec.toFixed(1)}s`, heard: line.text };
  });
  if (lastSec - samples[samples.length - 1].atSec > LAST_FRAME_SEPARATE_SEC) {
    samples.push({ atSec: lastSec, label: `#${samples.length + 1} ${lastSec.toFixed(1)}s (last frame)` });
  }
  return samples;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function isPngFile(fileAbs: string): Promise<boolean> {
  const handle = await fs.open(fileAbs, 'r').catch(() => null);
  if (!handle) return false;
  try {
    const head = Buffer.alloc(PNG_SIGNATURE.length);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return bytesRead === head.length && head.equals(PNG_SIGNATURE);
  } finally {
    await handle.close().catch(() => {});
  }
}

/** One sheet of a video's frames at the given times, or null when none could be taken. */
export async function writeTimedFrameSheet(input: {
  videoPathAbs: string;
  outputDirAbs: string;
  width: number;
  height: number;
  samples: ReadonlyArray<{ atSec: number; label: string }>;
  signal?: AbortSignal;
}): Promise<string | null> {
  const { ffmpeg } = bundledFfmpegPaths();
  if (!ffmpeg || !input.samples.length || !input.width || !input.height) return null;
  const layout = sheetLayoutFor(input.width, input.height);
  const taken: Array<{ label: string; time_seconds: number; path: string }> = [];
  for (const [index, sample] of input.samples.entries()) {
    const framePath = path.join(input.outputDirAbs, `${String(index).padStart(2, '0')}.png`);
    const run = await runVideoProcessForTest(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', sample.atSec.toFixed(3), '-i', input.videoPathAbs,
      '-frames:v', '1', '-vf', `scale=${layout.thumbWidth}:${layout.thumbHeight}`, framePath,
    ], { timeoutMs: DELIVERED_FRAME_TIMEOUT_MS, ...(input.signal ? { signal: input.signal } : {}) });
    // A frame is used only when it is an image: a cell left blank would show nothing as if it were the picture.
    const wrote = run.code === 0 && await isPngFile(framePath);
    if (wrote) taken.push({ label: sample.label, time_seconds: sample.atSec, path: framePath });
  }
  return taken.length
    ? writeFrameContactSheet(input.outputDirAbs, taken, { labelOnly: true, ...layout })
    : null;
}

export async function writeDeliveredFrameSheet(input: {
  videoPathAbs: string;
  outputDirAbs: string;
  durationSec: number;
  width: number;
  height: number;
  /** The file's voice as heard; frames then follow its lines. */
  heard?: readonly HeardLine[];
  signal?: AbortSignal;
}): Promise<string | null> {
  if (!(input.durationSec > 0)) return null;
  return writeTimedFrameSheet({
    videoPathAbs: input.videoPathAbs,
    outputDirAbs: input.outputDirAbs,
    width: input.width,
    height: input.height,
    samples: deliveredFrameSamples(input.durationSec, input.heard ?? []),
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

/** How each scene came out, under the names a preview uses, for whatever shows the scenes.
 *  Losing one loses a thumbnail, never the delivery. */
async function writeDeliveredSceneFrames(input: {
  ffmpeg: string;
  fileAbs: string;
  durationSec: number;
  previewDirAbs: string;
  productionDirAbs: string;
  sceneEnds: ReadonlyArray<{ id: string; atSec: number }>;
  signal?: AbortSignal;
}): Promise<void> {
  try {
    if (!isPathAllowed(input.previewDirAbs, [input.productionDirAbs])) throw new Error('Scene preview is outside the production.');
    await fs.mkdir(input.previewDirAbs, { recursive: true });
    for (const [index, scene] of input.sceneEnds.slice(0, DELIVERED_SCENE_FRAMES_MAX).entries()) {
      const out = path.join(input.previewDirAbs, `${String(index + 1).padStart(2, '0')}-${scene.id}-end.png`);
      if (!isPathAllowed(out, [input.productionDirAbs])) throw new Error('Scene preview is outside the production.');
      // A seek past the file's last frame writes nothing and still exits cleanly.
      const atSec = Math.max(0, Math.min(scene.atSec, input.durationSec - LAST_FRAME_MARGIN_SEC));
      const run = await runVideoProcessForTest(input.ffmpeg, [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-ss', (Math.floor(atSec * 1000) / 1000).toFixed(3), '-i', input.fileAbs,
        '-frames:v', '1', '-vf', `scale=${DELIVERED_SCENE_FRAME_WIDTH}:-2`, out,
      ], { timeoutMs: DELIVERED_FRAME_TIMEOUT_MS, ...(input.signal ? { signal: input.signal } : {}) });
      if (run.code !== 0) log.warn('scene frame not written', { code: run.code });
    }
  } catch (err) {
    log.warn('scene frames not written', { error: logErrorSummary(err) });
  }
}

/** What a picture and sound of different lengths should do next. On 2026-11-19 a tutorial was
 *  told only that "one of them stops early" (picture 30.6 s, sound 22.2 s) and stopped to ask for
 *  narration to be recorded again. */
export function avDurationMismatchMessage(videoSec: number, audioSec: number, narrationCutOff = false): string {
  const lengths = `The picture runs ${videoSec.toFixed(2)}s and the sound ${audioSec.toFixed(2)}s`;
  const gap = Math.abs(videoSec - audioSec).toFixed(2);
  if (audioSec < videoSec && narrationCutOff) {
    return `${lengths}. The delivered mix cuts off existing narration. Check the full original recording against the current picture. If it fits, rebuild the mix from the original narration and deliver again. If it does not fit, adjust the timing before recording again.`;
  }
  return audioSec < videoSec
    ? `${lengths}, so the last ${gap}s have no sound. Give that stretch sound, such as another narration line or music under the end, or cut the picture to ${audioSec.toFixed(2)}s, then deliver again.`
    : `${lengths}, so the sound runs ${gap}s past the picture. Cut the sound to ${videoSec.toFixed(2)}s or extend the picture, then deliver again.`;
}

export async function shipVideoFile(p: VideoShipOptions): Promise<VideoStudioResult> {
  const op = 'video.ship' as const;
  const expiredReview = { ok: false, op, errorCode: 'E_VIDEO_SHIP_REVIEW_EXPIRED', message: 'The video changed. Update it again.' } as const;
  const previewDirAbs = p.videoDirAbs
    ? path.join(p.productionDirAbs, 'preview', path.basename(p.videoDirAbs), String(Date.now())) : null;
  // 2026-11-20: a recreation rendered fine, then twice passed its absolute path with one
  // character copied wrong, was told only that the file was out of scope, and gave up.
  if (!isPathAllowed(p.videoPathAbs, p.allowedRoots)) {
    return { ok: false, op, errorCode: 'E_VIDEO_SHIP_OUT_OF_SCOPE', message: 'That file is outside the files this task can use. Pass its path relative to the production folder, such as render/main.mp4, and run it again.' };
  }
  if (!isPathAllowed(p.productionDirAbs, p.allowedRoots)
      || ['versions', 'versions.json', 'preview'].some(name => !isPathAllowed(path.join(p.productionDirAbs, name), [p.productionDirAbs]))
      || (previewDirAbs && !isPathAllowed(previewDirAbs, [p.productionDirAbs]))
      || (p.videoDirAbs && !isPathAllowed(path.join(p.videoDirAbs, '.last-render.json'), [p.productionDirAbs]))) {
    return { ok: false, op, errorCode: 'E_VIDEO_SHIP_OUT_OF_SCOPE', message: 'That file is outside the files this task can use.' };
  }
  // Said apart from an unreadable file: told the stream was unreadable, live runs took
  // a mistyped path for a broken check and stopped.
  const initialFile = await fs.stat(p.videoPathAbs).catch(() => null);
  if (!initialFile?.isFile()) {
    return { ok: false, op, errorCode: 'E_VIDEO_SHIP_NO_FILE', message: `There is no file at ${p.videoPathAbs}. Pass the path video.render returned.` };
  }
  const sourceIsCurrent = async () => {
    if (!isPathAllowed(p.videoPathAbs, p.allowedRoots)) return false;
    const current = await fs.stat(p.videoPathAbs).catch(() => null);
    return !!current?.isFile() && current.dev === initialFile.dev && current.ino === initialFile.ino
      && current.size === initialFile.size && current.mtimeMs === initialFile.mtimeMs && current.ctimeMs === initialFile.ctimeMs;
  };
  const { ffmpeg } = bundledFfmpegPaths();
  if (!ffmpeg) return { ok: false, op, errorCode: 'E_FFMPEG_MISSING', message: 'Bundled ffmpeg not found.' };
  const issues: ShipIssue[] = [];
  const spec = await probeDeliveredVideo(p.videoPathAbs, p.signal);
  if (!spec) {
    return {
      ok: false,
      op,
      errorCode: 'E_VIDEO_SHIP_BLOCKED',
      message: 'The file has no readable video stream.',
      issues: [{ code: 'DELIVERY_VIDEO_UNREADABLE', severity: 'error', message: 'The file has no readable video stream.' }],
    };
  }

  const declared = p.videoDirAbs
    ? await timelineExpectations({
      productionDirAbs: p.productionDirAbs,
      videoDirAbs: p.videoDirAbs,
      allowedRoots: p.allowedRoots,
      ...(p.signal ? { signal: p.signal } : {}),
    })
    : null;
  if (declared) issues.push(...declared.issues);
  const timeline = declared?.timeline ?? null;
  if (timeline && previewDirAbs && timeline.sceneEnds.slice(0, DELIVERED_SCENE_FRAMES_MAX).some((scene, index) =>
    !isPathAllowed(path.join(previewDirAbs, `${String(index + 1).padStart(2, '0')}-${scene.id}-end.png`), [p.productionDirAbs]))) {
    return { ok: false, op, errorCode: 'E_VIDEO_SHIP_OUT_OF_SCOPE', message: 'That file is outside the files this task can use.' };
  }
  // An unreadable list stops the delivery when it is recorded, with its own message.
  const stored = await readVersionFile(path.join(p.productionDirAbs, 'versions.json')).catch(() => null);
  if (timeline) {
    issues.push(...staleNarration(timeline.voiced, stored?.delivered_narration ?? {}));
    issues.push(...await unplayedNarration(p.productionDirAbs, timeline, stored?.voices_since_delivery ?? []));
  }
  // Read before this delivery clears the voices made for it.
  const lastOfVideo = (stored?.versions ?? []).filter((version) => version.video_id === timeline?.videoId).at(-1);
  const voiced = timeline?.playsNarration === true || spec.narrationMixExpected === true
    || (stored?.voices_since_delivery.length ?? 0) > 0 || lastOfVideo?.voiced === true;
  if (p.videoDirAbs && await renderedBeforeLastChange({ productionDirAbs: p.productionDirAbs, videoDirAbs: p.videoDirAbs, fileAbs: p.videoPathAbs })) {
    issues.push({
      code: 'DELIVERY_TIMELINE_CHANGED',
      severity: 'error',
      message: 'The timeline changed after this file was rendered, so the file does not show the change. Run video.render again, then deliver.',
    });
  }

  const aspect = timeline?.aspect ?? p.expect?.aspect ?? null;
  const expectsAudio = timeline?.hasAudio ?? p.expect?.hasAudio ?? false;
  const audio = spec.hasAudio ? await measureDeliveredAudio(p.videoPathAbs, spec.audioStreams ?? 1, p.signal, spec.durationSec) : null;
  let integratedLufs = audio?.integratedLufs ?? null;
  issues.push(...assessDeliveredSpec({
    spec,
    expectedDurationSec: timeline?.durationSec ?? null,
    ...(p.expect?.durationSec !== undefined ? { requestedDurationSec: p.expect.durationSec } : {}),
    expectedAspect: aspect,
    expectsAudio,
    integratedLufs,
    digitalSilence: audio?.digitalSilence ?? null,
  }));
  if (timeline) {
    issues.push(...assessDeliveredNarration(timeline.lines, spec.durationSec)
      .map(({ code, severity, message }) => ({ code, severity, message })));
  }
  // The matched source voice tells the first delivery error whether the existing mix can be repaired.
  const playbackIssues = spec.hasAudio ? await narrationPlaybackIssues({
    ffmpeg,
    videoAbs: p.videoPathAbs,
    productionDirAbs: p.productionDirAbs,
    voices: stored?.voices_since_delivery ?? [],
    ...(p.signal ? { signal: p.signal } : {}),
  }) : [];
  if (spec.hasAudio && spec.audioDurationSec !== undefined && spec.videoDurationSec !== undefined
    && Math.abs(spec.audioDurationSec - spec.videoDurationSec) > AV_DURATION_TOLERANCE_SEC) {
    issues.push({
      code: 'DELIVERY_AV_DURATION_MISMATCH',
      severity: 'error',
      message: avDurationMismatchMessage(spec.videoDurationSec, spec.audioDurationSec,
        playbackIssues.some((issue) => issue.code === 'DELIVERY_NARRATION_CUT_OFF')),
    });
  }
  // 2026-11-22: stopped for held stills, a video gets one round of changes. A later file of it,
  // even one still held, is delivered with the finding as a warning; the same file is stopped again.
  const stoppedSha = timeline ? stored?.held_stills_stopped[timeline.videoId] : undefined;
  const stoppedBefore = !p.reviewHeldStills && !!stoppedSha && await sha256OfFileStream(p.videoPathAbs) !== stoppedSha;
  const held: { finding?: HeldStillsFinding } = {};
  issues.push(...await visualHintIssues(ffmpeg, p.videoPathAbs, spec.durationSec, p.signal, timeline, stoppedBefore,
    p.reviewHeldStills ? (finding) => { held.finding = finding; } : undefined));
  // Sound the file itself shows is missing, and narration laid over the clip's own speech
  // (from the record its mix left): both ask for a repair within the delivery's rework.
  issues.push(...assessSilentStretches(audio?.silences, expectsAudio));
  issues.push(...await narrationOverSpeechIssues(p.videoPathAbs, p.productionDirAbs, p.signal, spec.narrationMixExpected === true));
  issues.push(...playbackIssues);
  if (p.cutToBeat) issues.push(...await cutsOffBeatIssues(p.videoPathAbs, { fps: spec.fps, durationSec: spec.durationSec }, p.signal));

  const blocking = issues.filter((issue) => issue.severity === 'error');
  const warnings = issues.filter((issue) => issue.severity !== 'error');
  let override = p.override;
  const accepted = new Set(override?.codes ?? []);
  const unaccepted = blocking.filter((issue) => !accepted.has(issue.code));
  let review: { sha256: string; isCurrent: () => boolean } | undefined;
  if (p.reviewHeldStills && stored && held.finding && unaccepted.length === 1
      && unaccepted[0].code === 'DELIVERY_HELD_STILLS' && !p.signal?.aborted) {
    const sha256 = await sha256OfFileStream(p.videoPathAbs).catch(() => null);
    if (!sha256 || !await sourceIsCurrent()) return expiredReview;
    const isCurrent = await p.reviewHeldStills(held.finding);
    if (isCurrent) {
      review = { sha256, isCurrent };
      override = { codes: ['DELIVERY_HELD_STILLS'], reason: 'User confirmed this rendered version on the video canvas.' };
      accepted.add('DELIVERY_HELD_STILLS');
    }
  }
  if (unaccepted.length && !review) {
    if (!p.reviewHeldStills && timeline && unaccepted.some((issue) => issue.code === 'DELIVERY_HELD_STILLS')) {
      await noteHeldStillsStop(p.productionDirAbs, timeline.videoId, await sha256OfFileStream(p.videoPathAbs));
    }
    return {
      ok: false,
      op,
      errorCode: 'E_VIDEO_SHIP_BLOCKED',
      message: unaccepted[0].message,
      issues: unaccepted,
      warnings,
    };
  }
  const checkReview = async () => {
    if (!review) return;
    if (p.signal?.aborted || !review.isCurrent() || !isPathAllowed(p.videoPathAbs, p.allowedRoots)
        || (p.videoDirAbs && await renderedBeforeLastChange({
          productionDirAbs: p.productionDirAbs, videoDirAbs: p.videoDirAbs, fileAbs: p.videoPathAbs,
        })) || p.signal?.aborted || !review.isCurrent()) throw new CanvasReviewExpired();
  };
  // Measured only for a delivery that goes ahead: a blocked one is fixed first.
  const reference = p.referenceAbs
    ? await compareWithReference({ ffmpeg, referenceAbs: p.referenceAbs, videoAbs: p.videoPathAbs, videoSec: spec.durationSec, ...(p.signal ? { signal: p.signal } : {}) })
    : null;
  if (reference?.issue) warnings.push(reference.issue);
  const sha256 = await sha256OfFileStream(p.videoPathAbs).catch((err) => {
    if (review) return null;
    throw err;
  });
  if (sha256 === null || (review && sha256 !== review.sha256)) return expiredReview;
  let visual = await renderedVisualReview(p.videoDirAbs, sha256);
  const videoId = timeline?.videoId;
  const { name, ext } = path.parse(p.videoPathAbs);
  let version: VideoVersion;
  let audioSourcesSha256: string | undefined;
  const verifyAudio = async () => {
    if (!p.videoDirAbs) return;
    const audio = await verifyRenderedAudioSources({
      productionDirAbs: p.productionDirAbs, videoDirAbs: p.videoDirAbs, fileAbs: p.videoPathAbs,
      allowedRoots: p.allowedRoots, signal: p.signal,
    });
    if (audio === false || (audio !== undefined && !await sourceIsCurrent())) throw new RenderedAudioChanged();
    audioSourcesSha256 = audio;
  };
  // A changed output-policy copy is judged before recordVersion publishes it.
  // Keep this failure distinct from a ledger/write failure for the same repair path.
  let finalizedBlock: ShipIssue[] | null = null;
  const inspectOriginalAudio = async (fileAbs: string) => {
    if (!timeline?.keptClipAudio.length) return;
    warnings.push(...await originalClipAudioWarnings({
      ffmpeg, videoAbs: fileAbs, clips: timeline.keptClipAudio, allowedRoots: p.allowedRoots, signal: p.signal,
    }));
  };
  try {
    version = await recordVersion({
      productionDirAbs: p.productionDirAbs,
      sha256,
      ...(videoId ? { videoId } : {}),
      ...(timeline ? { voiced: timeline.voiced } : {}),
      delivers: true,
      inspectRepeat: async (fileAbs) => {
        await inspectOriginalAudio(fileAbs);
        await verifyAudio();
      },
      ...(review ? {
        checkLatest: async (latest: VideoVersion | undefined) => {
          if (latest?.id !== lastOfVideo?.id || latest?.sha256 !== lastOfVideo?.sha256) throw new CanvasReviewExpired();
          await checkReview();
        },
      } : {}),
      keep: async (id) => {
        const { finalPath } = await uniquifyPath(path.join(p.productionDirAbs, VERSIONS_DIR, `${videoId ?? name}-${id}${ext}`), () => false);
        if (!isPathAllowed(finalPath, [p.productionDirAbs])) throw new Error('That file is outside the files this task can use.');
        await fs.mkdir(path.dirname(finalPath), { recursive: true });
        await fs.copyFile(p.videoPathAbs, finalPath, fsConstants.COPYFILE_FICLONE);
        try {
          if (review) {
            if (await sha256OfFileStream(finalPath) !== review.sha256) throw new CanvasReviewExpired();
            await checkReview();
          }
          await p.finalize?.(finalPath);
          const keptSha256 = await sha256OfFileStream(finalPath);
          if (keptSha256 !== sha256 && (visual.status === 'has_findings' || visual.status === 'no_findings')) visual = { ...visual, status: 'stale' };
          if (keptSha256 !== sha256 && expectsAudio) {
            const finalSpec = await probeDeliveredVideo(finalPath, p.signal);
            const finalAudio = finalSpec?.hasAudio
              ? await measureDeliveredAudio(finalPath, finalSpec.audioStreams ?? 1, p.signal) : null;
            integratedLufs = finalAudio?.integratedLufs ?? null;
            const finalIssues: ShipIssue[] = finalSpec ? assessDeliveredSpec({
              spec: finalSpec, expectedDurationSec: null, expectedAspect: null,
              expectsAudio, integratedLufs,
              digitalSilence: finalAudio?.digitalSilence ?? null,
            }) : [{ code: 'DELIVERY_VIDEO_UNREADABLE', severity: 'error', message: 'The final file has no readable video stream.' }];
            const audioCodes = new Set(['DELIVERY_NO_AUDIO', 'DELIVERY_AUDIO_SILENT', 'DELIVERY_AUDIO_UNVERIFIABLE', 'DELIVERY_LOUDNESS_OFF_TARGET']);
            for (const list of [blocking, warnings]) {
              for (let index = list.length - 1; index >= 0; index -= 1) if (audioCodes.has(list[index].code)) list.splice(index, 1);
            }
            for (const issue of finalIssues) (issue.severity === 'error' ? blocking : warnings).push(issue);
            const rejected = blocking.filter((issue) => !accepted.has(issue.code));
            if (rejected.length) {
              finalizedBlock = rejected;
              throw new Error(rejected[0].message);
            }
          }
          await inspectOriginalAudio(finalPath);
          if (review) await checkReview();
          await verifyAudio();
          return { path: finalPath, sha256: keptSha256 };
        } catch (err) {
          await fs.rm(finalPath, { force: true }).catch(() => {});
          throw err;
        }
      },
      build: (id, kept) => ({
        id,
        ...(videoId ? { video_id: videoId } : {}),
        path: portablePath(p.productionDirAbs, kept.path),
        sha256: kept.sha256,
        ...(kept.sha256 !== sha256 ? { source_sha256: sha256 } : {}),
        duration_sec: spec.durationSec,
        canvas: spec.width && spec.height ? `${spec.width}x${spec.height}` : null,
        fps: spec.fps,
        integrated_lufs: integratedLufs,
        visual_review: visual,
        shipped_at: new Date().toISOString(),
        warnings: warnings.map((issue) => issue.code),
        ...(blocking.length && override ? { override: { codes: blocking.map((issue) => issue.code), reason: override.reason } } : {}),
        ...(voiced ? { voiced: true as const } : {}),
      }),
    });
  } catch (err) {
    if (err instanceof CanvasReviewExpired) return expiredReview;
    if (err instanceof RenderedAudioChanged) {
      const issue = RENDERED_AUDIO_CHANGED;
      return { ok: false, op, errorCode: 'E_VIDEO_SHIP_BLOCKED', message: issue.message, issues: [issue], warnings };
    }
    if (finalizedBlock) return { ok: false, op, errorCode: 'E_VIDEO_SHIP_BLOCKED', message: finalizedBlock[0].message, issues: finalizedBlock, warnings };
    return { ok: false, op, errorCode: 'E_VIDEO_SHIP_RECORD', message: String((err as Error).message || err).slice(0, 300) };
  }
  if (timeline && p.videoDirAbs) {
    await markTimelineDelivered({ productionDirAbs: p.productionDirAbs, videoDirAbs: p.videoDirAbs }, version.id, audioSourcesSha256)
      .catch((err) => log.warn('delivery not noted', { error: logErrorSummary(err) }));
    await writeDeliveredSceneFrames({
      ffmpeg,
      fileAbs: path.resolve(p.productionDirAbs, version.path),
      durationSec: spec.durationSec ?? timeline.durationSec,
      previewDirAbs: previewDirAbs!,
      productionDirAbs: p.productionDirAbs,
      sceneEnds: timeline.sceneEnds,
      ...(p.signal ? { signal: p.signal } : {}),
    });
  }
  // versions.json keeps the review on the version; the reply shows it once, below.
  const { visual_review: _storedReview, ...shownVersion } = version;
  return {
    ok: true,
    op,
    version: shownVersion,
    media: versionedChatMediaLocalUrl(path.resolve(p.productionDirAbs, version.path)),
    visual_review: parseVisualReview(version.visual_review) ?? visualReview('not_checked'),
    warnings,
    ...(blocking.length ? { accepted_issues: blocking } : {}),
    ...(reference ? { reference_comparison: reference.report } : {}),
  };
}

/** The asset ids a timeline plays: its clips, narration and tracks. */
async function assetsTimelineUses(videoDirAbs: string): Promise<Set<string>> {
  const used = new Set<string>();
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(videoDirAbs, 'manifest.json'), 'utf8')) as {
      scenes?: Array<{ clips?: Array<{ asset?: unknown }>; narration?: { asset?: unknown } }>;
      tracks?: Array<{ asset?: unknown }>;
    };
    for (const scene of manifest.scenes ?? []) {
      for (const clip of scene.clips ?? []) if (typeof clip.asset === 'string') used.add(clip.asset);
      if (typeof scene.narration?.asset === 'string') used.add(scene.narration.asset);
    }
    for (const track of manifest.tracks ?? []) if (typeof track.asset === 'string') used.add(track.asset);
  } catch {
    // An unreadable timeline was already refused by delivery; credit nothing from it.
  }
  return used;
}

export type StockCredits = { lines: string[]; file: string; timeline: boolean };

/**
 * After a delivery, the credit lines its licences ask for, saved beside the delivered file as
 * `<name>.credits.txt`. A timeline credits the files it plays; a file made with ffmpeg alone
 * credits every such file in the production, as the host cannot tell which it used. Null when
 * nothing needs credit.
 */
export async function writeStockCredits(input: {
  productionDirAbs: string;
  deliveredAbs: string;
  videoDirAbs?: string;
}): Promise<StockCredits | null> {
  let rows: VideoAssetRecord[] = [];
  try {
    rows = VideoAssetLedgerSchema.parse(JSON.parse(await fs.readFile(path.join(input.productionDirAbs, 'assets.json'), 'utf8'))).assets;
  } catch {
    return null;
  }
  const used = input.videoDirAbs ? await assetsTimelineUses(input.videoDirAbs) : null;
  const lines = [...new Set(rows
    .filter((row) => row.origin === 'stock' && row.source?.credit && (!used || used.has(row.id)))
    .map((row) => String(row.source!.credit).replace(/\s+/g, ' ').trim())
    .filter(Boolean))];
  if (!lines.length) return null;
  const file = path.join(path.dirname(input.deliveredAbs), `${path.basename(input.deliveredAbs, path.extname(input.deliveredAbs))}.credits.txt`);
  if (!isPathAllowed(file, [input.productionDirAbs])) throw new Error('Credit output is outside the production.');
  await writeBytesAtomic(file, Buffer.from(`${lines.join('\n')}\n`));
  return { lines, file, timeline: !!input.videoDirAbs };
}
