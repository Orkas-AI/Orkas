/**
 * The video canvas: the productions in a conversation's workspace, seen as cards, and the
 * changes a user can make to them without a model.
 *
 * The cards hold nothing of their own. Footage, shots and videos are read from the
 * production's ledger, timelines and versions each time, so what the Agent wrote and what
 * the user changed are one thing. Only card positions, and new shots drawn on the canvas until
 * they are generated, belong to the canvas. The page is the Agent's and is never written here: a
 * change to words goes to the scene's slot, a change of picture to its clip, and the renderer does
 * the rest.
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createLogger } from '../logger';
import { writeBytesAtomic } from '../storage';
import { bundledFfmpegPaths } from '../util/bundled-runtime';
import { fileEditLock } from '../util/locks';
import { logErrorSummary, maskId } from '../util/log-redact';
import { isPathAllowed } from '../util/path-sandbox';
import { sha256OfFileStream } from '../util/sha256';
import { resolveLocalMediaPath } from './chat_attachments';
import { getConversationWorkspacePath } from './group_chat/conv_workspace';
import { importProductionFile } from './video_production_spend';
import { upgradeWorkspaceOnce } from './video_project_upgrade';
import { probeMedia } from './video_studio';
import {
  compileVideoPage,
  deriveVideoTimeline,
  pagePictureRefs,
  parseVideoManifest,
  parseVideoScene,
  resolveSceneText,
  spokenWords,
  validateVideoTimeline,
  VideoAssetLedgerSchema,
  VideoProductSchema,
  type VideoAssetRecord,
  type VideoClip,
  type VideoManifestV3,
  type VideoProduct,
  type VideoScene,
} from './video_timeline';
import { videoModelSpec } from './video_models';
import { noteTimelineBeforeChange, productChangesSinceDelivery, timelineAheadOfDelivery } from './video_timeline_render';
import { deliveredWords, type VideoVersion } from './video_timeline_ship';

const log = createLogger('video-canvas');

const LAYOUT_FILE = 'canvas.json';
const MAX_PRODUCTION_CANDIDATES = 200;
const MAX_VIDEOS_PER_PRODUCTION = 32;
const MAX_LAYOUT_CARDS = 1000;
const MAX_PREVIEW_RUNS_READ = 8;
const MAX_IMPORTED_FILES = 32;
/** How long a still shows when it is added as a new scene. */
const ADDED_STILL_SEC = 3;
/** The most of a clip a new scene takes. Trimming is for the Agent, and a phone recording
 *  dropped whole into a 20-second ad would render for minutes and rarely be what was meant. */
const ADDED_CLIP_MAX_SEC = 15;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
/** A production has one product, so its card has a fixed key. */
const PRODUCT_CARD_KEY = 'product';
/** New shots waiting to be generated, and what each can be made from (decided 2026-11-10). */
const MAX_DRAFTS = 50;
const MAX_DRAFT_INPUTS = 30;
/** The server limit on a prompt. */
const MAX_PROMPT_CHARS = 20000;
const MAX_CHOICE_CHARS = 200;
const DRAFT_RATIOS: readonly string[] = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'];
/** Every resolution a video service names; each service offers some of them. */
export const VIDEO_RESOLUTIONS: readonly string[] = ['360p', '480p', '540p', '720p', '768p', '1080p', '2k', '4k'];
const MAX_DRAFT_SECONDS = 30;
/** Scenes taken out on the canvas that each video keeps to put back (decided 2026-11-11). */
const MAX_REMOVED_SCENES = 10;
/** Enough of a removed scene's words to tell it from another in a menu that grows to fit. */
const MAX_REMOVED_WORDS_CHARS = 24;

export type VideoCanvasRefusalCode =
  | 'busy'
  | 'not_found'
  | 'invalid'
  | 'last_scene'
  | 'page_scene'
  | 'page_picture'
  | 'in_use'
  | 'unreadable'
  | 'too_short'
  | 'too_long'
  | 'changed'
  | 'failed';

export type VideoCanvasRefusal = {
  ok: false;
  /** What the renderer says to the user: it reads `video_canvas.error.<code>`. */
  code: VideoCanvasRefusalCode;
  /** The reason in the timeline's own words, for logs and for asking the Agent. */
  detail?: string;
};

export type VideoCanvasAssetCard = {
  key: string;
  id: string;
  kind: 'image' | 'video';
  label: string;
  media_path: string;
};

/** What a generation call asked for, where it said. */
export type VideoCanvasTakeParams = {
  ratio?: string;
  resolution?: string;
  duration?: number;
  audio?: boolean;
  size?: string;
};

export type VideoCanvasShotResult = {
  asset_id: string;
  kind: 'image' | 'video';
  label: string;
  media_path: string;
  prompt?: string;
  /** The cards it was made from, in the order the call named them. */
  refs: Array<{ card: string; role: NonNullable<VideoAssetRecord['refs']>[number]['role'] }>;
  /** The model that made it, as the user knows it. */
  model?: string;
  params?: VideoCanvasTakeParams;
  /** The call that made it is on record, so it can be made again. */
  redoable: boolean;
  /** How many videos show it. */
  used_in: number;
};

export type VideoCanvasShotCard = {
  key: string;
  shot: string;
  label: string;
  /** Oldest first, so the last one is what was made most recently. */
  results: VideoCanvasShotResult[];
  /** The cards this shot was made from. */
  uses: string[];
};

export type VideoCanvasSceneText = {
  slot: string;
  value: string;
  /** The product fact these words quote, until the user changes them in the scene. */
  fact_id?: string;
};

export type VideoCanvasScene = {
  id: string;
  start_sec: number;
  duration_sec: number;
  /** A frame of the scene as last rendered. */
  frame_path?: string;
  /** The picture behind the scene, and what it is. */
  media_path?: string;
  media_kind?: 'image' | 'video';
  texts: VideoCanvasSceneText[];
  narration?: string;
  /** Its narration was voiced here and what it says is known, so its words can change and the
   *  Agent voices them again at the user's Update (decided 2026-11-11). A recording, a whole
   *  narration track or a line nothing records the words of cannot. The voice can change only
   *  when the card names it. */
  narration_editable: boolean;
  /** The card and ledger row behind this scene's picture. */
  source?: string;
  asset_id?: string;
  /** The call that made its picture is on record, so it can be made again. */
  redoable: boolean;
  /** Runs on the one timeline of an old page, which draws it. */
  on_page_timeline: boolean;
};

export type VideoCanvasVersion = {
  id: string;
  media_path: string;
  shipped_at: string;
  duration_sec: number | null;
};

/** A voice as the speech services name it: a route, and a voice on that route. */
export type VideoCanvasVoice = { route_ref: string; voice_ref: string };

/** A scene taken out on the canvas that can be put back as it was (decided 2026-11-11). */
export type VideoCanvasRemovedScene = {
  key: string;
  /** Where it stood when it was taken out, from 1. */
  position: number;
  duration_sec: number;
  /** Its first words, to tell it from another. Empty for a scene with none. */
  words: string;
};

export type VideoCanvasVideoCard = {
  key: string;
  /** The folder under videos/. Empty for a video made with ffmpeg alone, which has no
   *  timeline to change. */
  id: string;
  label: string;
  width: number;
  height: number;
  duration_sec: number;
  scenes: VideoCanvasScene[];
  /** Oldest first. */
  versions: VideoCanvasVersion[];
  /** Product facts whose words changed since its last delivery. Its update goes to the Agent,
   *  which says them in the video's own words (decided 2026-11-09). */
  product_changes: Array<{ before: string; after: string }>;
  uses: string[];
  /** Ledger rows its page shows by file rather than as clips: they can be neither swapped
   *  nor taken away here. */
  placed_by_page: string[];
  /** Newest first, only those that can still be put back. */
  removed_scenes: VideoCanvasRemovedScene[];
  /** The voice its narration has, from its first scene voiced here whose row names it; null with
   *  none. */
  voice: VideoCanvasVoice | null;
  /** The voice the user picked for all its narration, until the narration has it. */
  voice_wanted: (VideoCanvasVoice & { name: string }) | null;
  /** Narration whose words are not what its audio says, in scene order. The user's Update hands
   *  them, with a voice wanted, to the Agent to voice again (decided 2026-11-11). */
  narration_changes: Array<{ position: number; scene: string; text: string }>;
};

export type VideoCanvasFact = VideoProduct['facts'][number];

/** The product sits among the footage as a card of its own: what the videos say about it. */
export type VideoCanvasProductCard = {
  key: typeof PRODUCT_CARD_KEY;
  label: string;
  facts: VideoCanvasFact[];
  /** The cards of its pictures. */
  uses: string[];
};

export type VideoCanvasDraftMethod = 'references' | 'frames';

/** A new shot drawn from footage, kept on the canvas until it is generated (decided 2026-11-10). */
export type VideoCanvasStoredDraft = {
  kind: 'video' | 'image';
  prompt: string;
  /** References, or the first and last frames, by order. A still has references only. */
  method: VideoCanvasDraftMethod;
  /** Ledger rows, in order. */
  inputs: string[];
  /** The user's picks; a service that cannot honor one shows what it would make instead. */
  choice?: string;
  ratio?: string;
  duration?: number;
  /** Picked in the panel's settings (decided 2026-11-10, plan 27.21); absent in older files. */
  resolution?: string;
  audio?: boolean;
};

export type VideoCanvasDraftInput = { asset_id: string; card: string; kind: 'image' | 'video'; label: string; media_path: string };

export type VideoCanvasDraftCard = Omit<VideoCanvasStoredDraft, 'inputs'> & {
  key: string;
  id: string;
  /** Its footage still on the canvas, in order. */
  inputs: VideoCanvasDraftInput[];
  uses: string[];
};

export type VideoCanvasDraftChange =
  | { kind: 'create'; type: VideoCanvasStoredDraft['kind']; inputs?: string[]; at: { x: number; y: number } }
  | {
    kind: 'update';
    id: string;
    prompt?: string;
    method?: VideoCanvasDraftMethod;
    inputs?: string[];
    choice?: string;
    ratio?: string;
    duration?: number;
    resolution?: string;
    audio?: boolean;
  }
  | { kind: 'remove'; id: string };

export type VideoCanvasProduction = {
  /** Relative to the conversation's workspace. It identifies the production in every call. */
  dir: string;
  name: string;
  updated_at_ms: number;
  product: VideoCanvasProductCard | null;
  layout: Record<string, { x: number; y: number }>;
  assets: VideoCanvasAssetCard[];
  shots: VideoCanvasShotCard[];
  /** New shots not generated yet, in the order they were drawn. */
  drafts: VideoCanvasDraftCard[];
  videos: VideoCanvasVideoCard[];
};

export type VideoCanvasEdit =
  | { kind: 'set_text'; video: string; scene: string; slot: string; value: string }
  | { kind: 'reorder'; video: string; order: string[] }
  | { kind: 'remove_scene'; video: string; scene: string }
  /** Put back a scene taken out on the canvas, by its key in removed_scenes. */
  | { kind: 'restore_scene'; video: string; removed: string }
  /** New words for narration voiced here. The Agent voices them at the user's Update. */
  | { kind: 'set_narration'; video: string; scene: string; value: string }
  /** The voice the user's Update gives all of a video's narration. */
  | { kind: 'set_voice'; video: string; route_ref: string; voice_ref: string }
  | { kind: 'add_scene'; video: string; asset: string; after?: string }
  | {
    kind: 'swap_clip';
    video: string;
    scene: string;
    asset: string;
    /** Only if the scene still shows this: it may have moved on since this was asked for. */
    if_current?: string;
  }
  | { kind: 'set_fact'; fact: string; text: string }
  | { kind: 'remove_asset'; asset: string }
  | { kind: 'replace_asset'; asset: string; with: string }
  /** Show this take wherever another take of its shot is shown. */
  | { kind: 'use_result'; asset: string };

export type VideoCanvasEditResult =
  | {
    ok: true;
    /** The videos the change left behind their delivered file. They wait for the user's Update
     *  (decided 2026-11-09). */
    changed_videos: string[];
    /** The new scene took only this much of a longer clip. */
    trimmed_to_sec?: number;
  }
  | VideoCanvasRefusal;

export type VideoCanvasLocation = { workspaceAbs: string; productionAbs: string };

function displayable(absPath: string): string {
  const resolved = resolveLocalMediaPath(absPath);
  return resolved.ok ? resolved.absPath : '';
}

function fileInProduction(productionAbs: string, recorded: string): string {
  const abs = path.resolve(productionAbs, recorded);
  return isPathAllowed(abs, [productionAbs]) ? displayable(abs) : '';
}

/** Fixed canvas storage must stay inside the already authorized production. */
function productionPathsAllowed(productionAbs: string): boolean {
  return ['assets.json', 'product.json', 'versions.json', LAYOUT_FILE, 'videos', 'media', 'preview', 'render', 'shots']
    .every(name => isPathAllowed(path.join(productionAbs, name), [productionAbs]));
}

/** A production named by the renderer has to be in this conversation's workspace. */
export async function locateProduction(uid: string, cid: string, dir: unknown): Promise<VideoCanvasLocation | null> {
  if (typeof dir !== 'string' || !dir || path.isAbsolute(dir)) return null;
  const workspaceAbs = await getConversationWorkspacePath(uid, cid).catch(() => '');
  if (!workspaceAbs) return null;
  const productionAbs = path.resolve(workspaceAbs, dir);
  return isPathAllowed(productionAbs, [workspaceAbs]) && productionPathsAllowed(productionAbs)
    ? { workspaceAbs, productionAbs } : null;
}

export function videoDirIn(productionAbs: string, videoId: unknown): string | null {
  if (typeof videoId !== 'string' || !ID_RE.test(videoId)) return null;
  const directory = path.join(productionAbs, 'videos', videoId);
  return ['', 'manifest.json', 'index.html', '.last-render.json']
    .every(name => isPathAllowed(path.join(directory, name), [productionAbs])) ? directory : null;
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
}

/** Null when it cannot be read, so it is never written over. An absent ledger is an empty one. */
export async function readProductionLedger(productionAbs: string): Promise<VideoAssetRecord[] | null> {
  if (!isPathAllowed(path.join(productionAbs, 'assets.json'), [productionAbs])) return null;
  try {
    return VideoAssetLedgerSchema.parse(await readJson(path.join(productionAbs, 'assets.json'))).assets;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null;
  }
}

async function readProduct(productionAbs: string): Promise<VideoProduct | null> {
  try {
    return VideoProductSchema.parse(await readJson(path.join(productionAbs, 'product.json')));
  } catch {
    return null;
  }
}

/** The delivered versions, and the words each delivered narration audio was shown with, by the
 *  audio's sha256. */
async function readVersionFile(productionAbs: string): Promise<{ versions: VideoVersion[]; deliveredNarration: Record<string, string[]> }> {
  try {
    const stored = await readJson(path.join(productionAbs, 'versions.json')) as { versions?: unknown; delivered_narration?: unknown };
    return {
      versions: Array.isArray(stored.versions) ? stored.versions as VideoVersion[] : [],
      deliveredNarration: deliveredWords(stored.delivered_narration),
    };
  } catch {
    return { versions: [], deliveredNarration: {} };
  }
}

async function readVersions(productionAbs: string): Promise<VideoVersion[]> {
  return (await readVersionFile(productionAbs)).versions;
}

async function readManifest(videoDirAbs: string): Promise<VideoManifestV3 | null> {
  try {
    return parseVideoManifest(await readJson(path.join(videoDirAbs, 'manifest.json'))).manifest;
  } catch {
    return null;
  }
}

function sanitizeLayout(cards: Record<string, unknown>): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = {};
  for (const [key, value] of Object.entries(cards).slice(0, MAX_LAYOUT_CARDS)) {
    const { x, y } = (value ?? {}) as { x?: unknown; y?: unknown };
    if (typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y)) {
      out[key] = { x: Math.round(x), y: Math.round(y) };
    }
  }
  return out;
}

function sanitizeDraft(value: unknown): VideoCanvasStoredDraft | null {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  if ((raw.kind !== 'video' && raw.kind !== 'image') || typeof raw.prompt !== 'string' || raw.prompt.length > MAX_PROMPT_CHARS) return null;
  if (raw.method !== 'references' && !(raw.method === 'frames' && raw.kind === 'video')) return null;
  const inputs = Array.isArray(raw.inputs) ? raw.inputs.filter((item): item is string => typeof item === 'string') : [];
  return {
    kind: raw.kind,
    prompt: raw.prompt,
    method: raw.method,
    inputs: [...new Set(inputs)].slice(0, MAX_DRAFT_INPUTS),
    ...(typeof raw.choice === 'string' && raw.choice && raw.choice.length <= MAX_CHOICE_CHARS ? { choice: raw.choice } : {}),
    ...(typeof raw.ratio === 'string' && DRAFT_RATIOS.includes(raw.ratio) ? { ratio: raw.ratio } : {}),
    ...(isDraftSeconds(raw.duration) ? { duration: raw.duration } : {}),
    ...(typeof raw.resolution === 'string' && VIDEO_RESOLUTIONS.includes(raw.resolution) ? { resolution: raw.resolution } : {}),
    ...(typeof raw.audio === 'boolean' ? { audio: raw.audio } : {}),
  };
}

function isDraftSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_DRAFT_SECONDS;
}

/** A scene as it was taken out, with where it stood: after the scene it followed (null for the
 *  first), else at its old place. */
type StoredRemovedScene = { key: string; scene: VideoScene; index: number; after: string | null };

/** The voice the user picked for a video, and the voice its narration had then: a pick stands
 *  only while the narration still has that voice (decided 2026-11-11). */
type StoredVoiceChoice = VideoCanvasVoice & { name: string; from: VideoCanvasVoice };

type CanvasFile = {
  cards: Record<string, { x: number; y: number }>;
  drafts: Record<string, VideoCanvasStoredDraft>;
  /** By video, newest first. */
  removed: Record<string, StoredRemovedScene[]>;
  /** By video. */
  voices: Record<string, StoredVoiceChoice>;
};

const MAX_VOICE_REF_CHARS = 200;

function voiceOf(value: unknown): VideoCanvasVoice | null {
  const { route_ref: route, voice_ref: voice } = (value ?? {}) as Record<string, unknown>;
  const fits = (item: unknown): item is string => typeof item === 'string' && !!item && item.length <= MAX_VOICE_REF_CHARS;
  return fits(route) && fits(voice) ? { route_ref: route, voice_ref: voice } : null;
}

function sanitizeVoices(value: unknown): Record<string, StoredVoiceChoice> {
  const out: Record<string, StoredVoiceChoice> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [video, choice] of Object.entries(value).slice(0, MAX_VIDEOS_PER_PRODUCTION)) {
    const { name, from } = (choice ?? {}) as Record<string, unknown>;
    const to = voiceOf(choice);
    const was = voiceOf(from);
    if (ID_RE.test(video) && to && was && typeof name === 'string' && name.length <= MAX_VOICE_REF_CHARS) out[video] = { ...to, name, from: was };
  }
  return out;
}

/** A video's own pick: a folder may be named like an object property. */
function voiceChoiceIn(canvas: CanvasFile, video: string): StoredVoiceChoice | null {
  return Object.hasOwn(canvas.voices, video) ? canvas.voices[video] : null;
}

/** A video's own list: a folder may be named like an object property. */
function removedIn(canvas: CanvasFile, video: string): StoredRemovedScene[] {
  return Object.hasOwn(canvas.removed, video) ? canvas.removed[video] : [];
}

function sanitizeRemoved(value: unknown): Record<string, StoredRemovedScene[]> {
  const out: Record<string, StoredRemovedScene[]> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [video, list] of Object.entries(value).slice(0, MAX_VIDEOS_PER_PRODUCTION)) {
    if (!ID_RE.test(video) || !Array.isArray(list)) continue;
    const kept = list.slice(0, MAX_REMOVED_SCENES).flatMap((item) => {
      const { key, scene, index, after } = (item ?? {}) as Record<string, unknown>;
      const parsed = parseVideoScene(scene);
      return typeof key === 'string' && ID_RE.test(key) && parsed && Number.isInteger(index) && (index as number) >= 0
        && (after === null || (typeof after === 'string' && ID_RE.test(after)))
        ? [{ key, scene: parsed, index: index as number, after: after as string | null }] : [];
    });
    if (kept.length) out[video] = kept;
  }
  return out;
}

/** Where the user put each card, the new shots drawn on the canvas, and the scenes taken out on
 *  it. A damaged file reads as empty, as it always has. */
async function readCanvasFile(productionAbs: string): Promise<CanvasFile> {
  try {
    const { cards, drafts, removed, voices } = await readJson(path.join(productionAbs, LAYOUT_FILE)) as { cards?: unknown; drafts?: unknown; removed?: unknown; voices?: unknown };
    const kept: Record<string, VideoCanvasStoredDraft> = {};
    if (drafts && typeof drafts === 'object' && !Array.isArray(drafts)) {
      for (const [id, value] of Object.entries(drafts).slice(0, MAX_DRAFTS)) {
        const draft = ID_RE.test(id) ? sanitizeDraft(value) : null;
        if (draft) kept[id] = draft;
      }
    }
    return {
      cards: cards && typeof cards === 'object' ? sanitizeLayout(cards as Record<string, unknown>) : {},
      drafts: kept,
      removed: sanitizeRemoved(removed),
      voices: sanitizeVoices(voices),
    };
  } catch {
    return { cards: {}, drafts: {}, removed: {}, voices: {} };
  }
}

/** Written whole, under the file's lock. With no new shots, no scenes taken out and no voice
 *  picked it keeps the shape it always had. */
async function writeCanvasFile(productionAbs: string, canvas: CanvasFile): Promise<void> {
  const removed = Object.fromEntries(Object.entries(canvas.removed).filter(([, list]) => list.length));
  const body = {
    cards: canvas.cards,
    ...(Object.keys(canvas.drafts).length ? { drafts: canvas.drafts } : {}),
    ...(Object.keys(removed).length ? { removed } : {}),
    ...(Object.keys(canvas.voices).length ? { voices: canvas.voices } : {}),
  };
  await writeBytesAtomic(path.join(productionAbs, LAYOUT_FILE), Buffer.from(`${JSON.stringify(body, null, 2)}\n`));
}

/** Keep a scene the user took out, newest first, so it can be put back. Losing it costs only
 *  that, never the change already made. */
async function keepRemovedScene(productionAbs: string, video: string, record: StoredRemovedScene): Promise<void> {
  try {
    await fileEditLock(path.join(productionAbs, LAYOUT_FILE)).runExclusive(async () => {
      const canvas = await readCanvasFile(productionAbs);
      const videos = new Set(await videoFolders(productionAbs));
      // Kept only for videos that are still there.
      for (const id of Object.keys(canvas.removed)) if (!videos.has(id)) delete canvas.removed[id];
      canvas.removed[video] = [record, ...removedIn(canvas, video).filter((item) => item.key !== record.key)].slice(0, MAX_REMOVED_SCENES);
      await writeCanvasFile(productionAbs, canvas);
    });
  } catch (err) {
    log.warn('removed scene not kept', { error: logErrorSummary(err) });
  }
}

/** Take a kept scene off the list to put it back, so it goes back once. */
async function takeRemovedScene(productionAbs: string, video: string, key: unknown): Promise<{ record: StoredRemovedScene; position: number } | null> {
  if (typeof key !== 'string' || !ID_RE.test(key) || !ID_RE.test(video)) return null;
  return fileEditLock(path.join(productionAbs, LAYOUT_FILE)).runExclusive(async () => {
    const canvas = await readCanvasFile(productionAbs);
    const list = [...removedIn(canvas, video)];
    const position = list.findIndex((item) => item.key === key);
    if (position < 0) return null;
    const [record] = list.splice(position, 1);
    canvas.removed[video] = list;
    await writeCanvasFile(productionAbs, canvas);
    return { record, position };
  });
}

/** A scene that could not go back returns to its place on the list. */
async function returnRemovedScene(productionAbs: string, video: string, record: StoredRemovedScene, position: number): Promise<void> {
  try {
    await fileEditLock(path.join(productionAbs, LAYOUT_FILE)).runExclusive(async () => {
      const canvas = await readCanvasFile(productionAbs);
      const list = removedIn(canvas, video).filter((item) => item.key !== record.key);
      list.splice(Math.min(position, list.length), 0, record);
      canvas.removed[video] = list.slice(0, MAX_REMOVED_SCENES);
      await writeCanvasFile(productionAbs, canvas);
    });
  } catch (err) {
    log.warn('removed scene not returned', { error: logErrorSummary(err) });
  }
}

async function videoFolders(productionAbs: string): Promise<string[]> {
  const entries = await fs.readdir(path.join(productionAbs, 'videos'), { withFileTypes: true }).catch(() => []);
  return entries.filter((item) => item.isDirectory() && ID_RE.test(item.name)).map((item) => item.name);
}

/** A frame for each scene, from the newest preview that has one: a preview can cover only
 *  part of a video. A preview names them `NN-<scene>-end.png`, each scene fully built. */
async function previewFrames(productionAbs: string, videoId: string): Promise<Map<string, string>> {
  const frames = new Map<string, string>();
  const previewAbs = path.join(productionAbs, 'preview', videoId);
  const runs = (await fs.readdir(previewAbs, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => Number(b) - Number(a))
    .slice(0, MAX_PREVIEW_RUNS_READ);
  for (const run of runs) {
    for (const name of await fs.readdir(path.join(previewAbs, run)).catch(() => [] as string[])) {
      const match = /^\d+-(.+)-end\.png$/.exec(name);
      if (match && !frames.has(match[1])) frames.set(match[1], path.join(previewAbs, run, name));
    }
  }
  return frames;
}

function versionCards(productionAbs: string, versions: readonly VideoVersion[]): VideoCanvasVersion[] {
  return versions.flatMap((version) => {
    const mediaPath = version.path ? fileInProduction(productionAbs, version.path) : '';
    return mediaPath
      ? [{ id: version.id, media_path: mediaPath, shipped_at: version.shipped_at, duration_sec: version.duration_sec }]
      : [];
  });
}

/** Where a ledger row shows on the canvas. A generated result lives on its shot's card. */
function cardOfAsset(row: VideoAssetRecord): string {
  return row.origin === 'generated' ? `shot:${row.shot || row.id}` : `asset:${row.id}`;
}

/** The ledger row of a scene's narration when it was voiced here. A recording the user made, or
 *  a line of a whole narration track, has none. */
function generatedNarration(scene: VideoScene, rowOf: ReadonlyMap<string, VideoAssetRecord>): VideoAssetRecord | null {
  const row = scene.narration?.asset ? rowOf.get(scene.narration.asset) : undefined;
  return row && row.kind === 'audio' && row.origin === 'generated' ? row : null;
}

/** The voice a scene's narration was made with, when it was voiced here and its row names it. */
function narrationVoice(scene: VideoScene, rowOf: ReadonlyMap<string, VideoAssetRecord>): VideoCanvasVoice | null {
  const row = generatedNarration(scene, rowOf);
  return row ? voiceOf(row.request) : null;
}

/**
 * The words each scene's narration audio says, for the scenes voiced here: those it was delivered
 * with, by the audio's bytes as delivery checks them, else the words it was voiced from. These
 * are the lines whose words can change. On 2026-11-11 Luna voiced every line before the
 * production had a ledger and wrote the rows itself, without the words, in 3 of 4 runs, and once
 * named the voice in fields of its own; the Agent still knows the voice it used. A scene with
 * neither has no words to change.
 */
async function heardNarration(
  productionAbs: string,
  scenes: readonly VideoScene[],
  rowOf: ReadonlyMap<string, VideoAssetRecord>,
  delivered: Readonly<Record<string, string[]>>,
): Promise<Map<string, readonly string[]>> {
  const heard = new Map<string, readonly string[]>();
  const anyDelivered = Object.keys(delivered).length > 0;
  for (const scene of scenes) {
    const row = generatedNarration(scene, rowOf);
    if (!row) continue;
    const fileAbs = path.resolve(productionAbs, row.path);
    // Hashed on each read: the canvas reads when the user acts or a turn ends, and lines are short.
    const sha256 = anyDelivered && isPathAllowed(fileAbs, [productionAbs]) ? await sha256OfFileStream(fileAbs).catch(() => null) : null;
    const words = (sha256 && delivered[sha256]) || (typeof row.prompt === 'string' && row.prompt.trim() ? [row.prompt] : []);
    if (words.length) heard.set(scene.id, words);
  }
  return heard;
}

function sameVoice(a: VideoCanvasVoice | null, b: VideoCanvasVoice | null): boolean {
  return !!a && !!b && a.route_ref === b.route_ref && a.voice_ref === b.voice_ref;
}

/** The voice a video's narration has: its first scene voiced here. */
function videoVoice(manifest: VideoManifestV3, rowOf: ReadonlyMap<string, VideoAssetRecord>): VideoCanvasVoice | null {
  for (const scene of manifest.scenes) {
    const voice = narrationVoice(scene, rowOf);
    if (voice) return voice;
  }
  return null;
}

/** The language a video is narrated in, from its voice or its canvas. */
function narrationLanguage(manifest: VideoManifestV3, rowOf: ReadonlyMap<string, VideoAssetRecord>): string {
  for (const scene of manifest.scenes) {
    const language = scene.narration?.asset ? rowOf.get(scene.narration.asset)?.request?.language : undefined;
    if (typeof language === 'string' && language) return language;
  }
  return manifest.canvas.language ?? '';
}

function buildAssetCards(productionAbs: string, ledger: readonly VideoAssetRecord[]): VideoCanvasAssetCard[] {
  return ledger.flatMap((row) => {
    if (row.origin === 'generated' || row.kind === 'audio') return [];
    const mediaPath = fileInProduction(productionAbs, row.path);
    return mediaPath ? [{ key: cardOfAsset(row), id: row.id, kind: row.kind, label: row.label, media_path: mediaPath }] : [];
  });
}

/** A take names the configured service's actual model. */
function takeModelName(row: VideoAssetRecord): string | undefined {
  const recorded = row.model?.trim();
  if (!recorded) return undefined;
  const slash = recorded.indexOf('/');
  const provider = slash > 0 ? recorded.slice(0, slash) : '';
  const model = slash > 0 ? recorded.slice(slash + 1) : recorded;
  return videoModelSpec(provider, model)?.name ?? model;
}

function takeParams(row: VideoAssetRecord): VideoCanvasTakeParams | undefined {
  const { request } = row;
  if (!request) return undefined;
  if (row.kind === 'image') return typeof request.size === 'string' ? { size: request.size } : {};
  return {
    ...(typeof request.ratio === 'string' ? { ratio: request.ratio } : {}),
    ...(typeof request.resolution === 'string' ? { resolution: request.resolution } : {}),
    ...(typeof request.duration === 'number' ? { duration: request.duration } : {}),
    audio: request.generate_audio !== false,
  };
}

function buildShotCards(
  productionAbs: string,
  ledger: readonly VideoAssetRecord[],
  usedIn: ReadonlyMap<string, number>,
): VideoCanvasShotCard[] {
  const byId = new Map(ledger.map((row) => [row.id, row]));
  const cards = new Map<string, VideoCanvasShotCard>();
  for (const row of ledger) {
    if (row.origin !== 'generated' || row.kind === 'audio') continue;
    const mediaPath = fileInProduction(productionAbs, row.path);
    if (!mediaPath) continue;
    const key = cardOfAsset(row);
    const card = cards.get(key) ?? { key, shot: row.shot || row.id, label: row.label, results: [], uses: [] };
    card.label = row.label;
    const refs: VideoCanvasShotResult['refs'] = [];
    for (const ref of row.refs ?? []) {
      const source = byId.get(ref.asset);
      const from = source && source.kind !== 'audio' ? cardOfAsset(source) : '';
      if (!from || from === key) continue;
      if (!refs.some((item) => item.card === from && item.role === ref.role)) refs.push({ card: from, role: ref.role });
      if (!card.uses.includes(from)) card.uses.push(from);
    }
    const model = takeModelName(row);
    const params = takeParams(row);
    card.results.push({
      asset_id: row.id,
      kind: row.kind,
      label: row.label,
      media_path: mediaPath,
      ...(row.prompt ? { prompt: row.prompt } : {}),
      refs,
      ...(model ? { model } : {}),
      ...(params ? { params } : {}),
      redoable: !!row.request,
      used_in: usedIn.get(row.id) ?? 0,
    });
    cards.set(key, card);
  }
  return [...cards.values()];
}

/** The footage a new shot uses that is still on the canvas, in order. */
function draftInputs(productionAbs: string, ledger: readonly VideoAssetRecord[], ids: readonly string[]): Array<VideoCanvasDraftInput & { path: string }> {
  const rowOf = new Map(ledger.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = rowOf.get(id);
    const mediaPath = row && row.kind !== 'audio' ? fileInProduction(productionAbs, row.path) : '';
    return row && mediaPath
      ? [{ asset_id: row.id, card: cardOfAsset(row), kind: row.kind as 'image' | 'video', label: row.label, media_path: mediaPath, path: path.resolve(productionAbs, row.path) }]
      : [];
  });
}

function buildDraftCards(productionAbs: string, ledger: readonly VideoAssetRecord[], drafts: CanvasFile['drafts']): VideoCanvasDraftCard[] {
  return Object.entries(drafts).map(([id, draft]) => {
    const inputs = draftInputs(productionAbs, ledger, draft.inputs).map(({ path: _path, ...input }) => input);
    return { ...draft, key: `draft:${id}`, id, inputs, uses: [...new Set(inputs.map((input) => input.card))] };
  });
}

/** The ledger rows a video's page shows by file, from the scenes on its timeline and the
 *  markup around them. */
async function pagePictureIds(input: {
  productionAbs: string;
  videoId: string;
  manifest: VideoManifestV3;
  ledger: readonly VideoAssetRecord[];
  product: VideoProduct | null;
}): Promise<string[]> {
  const videoDirAbs = videoDirIn(input.productionAbs, input.videoId);
  if (!videoDirAbs) return [];
  const html = await fs.readFile(path.join(videoDirAbs, 'index.html'), 'utf8').catch(() => null);
  if (html === null) return [];
  const compiled = compileVideoPage({
    html,
    manifest: input.manifest,
    product: input.product,
    baseHref: pathToFileURL(`${videoDirAbs}${path.sep}`).href,
  });
  const refs = pagePictureRefs({ compiled, assets: input.ledger, videoDirAbs, productionDirAbs: input.productionAbs });
  return [...new Set([...refs.shared, ...Object.values(refs.scenes).flat()])];
}

async function buildVideoCard(input: {
  productionAbs: string;
  videoId: string;
  manifest: VideoManifestV3;
  ledger: readonly VideoAssetRecord[];
  product: VideoProduct | null;
  versions: readonly VideoVersion[];
  deliveredNarration: Readonly<Record<string, string[]>>;
  removed: readonly StoredRemovedScene[];
  voiceChoice: StoredVoiceChoice | null;
}): Promise<VideoCanvasVideoCard> {
  const { productionAbs, videoId, manifest, ledger, product } = input;
  const timeline = deriveVideoTimeline(manifest);
  const frames = await previewFrames(productionAbs, videoId);
  const rowOf = new Map(ledger.map((row) => [row.id, row]));
  const heard = await heardNarration(productionAbs, manifest.scenes, rowOf, input.deliveredNarration);
  const uses = new Set<string>();
  const scenes: VideoCanvasScene[] = manifest.scenes.map((scene, index) => {
    const values = resolveSceneText(scene, product);
    const pictures = (scene.clips ?? []).flatMap((clip) => {
      const row = rowOf.get(clip.asset);
      return row && row.kind !== 'audio' ? [row] : [];
    });
    for (const row of pictures) uses.add(cardOfAsset(row));
    // What the scene is made of; an overlay is only shown alongside it.
    const sequential = (scene.clips ?? []).find((clip) => clip.at === undefined);
    const main = sequential ? rowOf.get(sequential.asset) : undefined;
    const picture = main && main.kind !== 'audio' ? main : pictures[0];
    const frame = frames.get(scene.id);
    const framePath = frame ? fileInProduction(productionAbs, frame) : '';
    const mediaPath = picture ? fileInProduction(productionAbs, picture.path) : '';
    return {
      id: scene.id,
      start_sec: timeline.scenes[index].startSec,
      duration_sec: timeline.scenes[index].durationSec,
      texts: Object.entries(scene.text ?? {}).map(([slot, entry]) => ({
        slot,
        value: values[slot] ?? '',
        ...('fact_id' in entry ? { fact_id: entry.fact_id } : {}),
      })),
      ...(framePath ? { frame_path: framePath } : {}),
      ...(mediaPath ? { media_path: mediaPath, media_kind: picture.kind as 'image' | 'video' } : {}),
      ...(scene.narration?.text ? { narration: scene.narration.text } : {}),
      ...(picture ? { source: cardOfAsset(picture), asset_id: picture.id } : {}),
      redoable: picture?.origin === 'generated' && !!picture.request,
      on_page_timeline: typeof manifest.absolute_page?.scene_starts[scene.id] === 'number',
      narration_editable: heard.has(scene.id),
    };
  });
  const voice = videoVoice(manifest, rowOf);
  const choice = input.voiceChoice;
  // Changed as delivery sees it: words the audio was never delivered with.
  const narrationChanges = manifest.scenes.flatMap((scene, index) => {
    const said = heard.get(scene.id);
    const now = scene.narration ? spokenWords(scene.narration.text) : '';
    return said && scene.narration && !said.some((words) => spokenWords(words) === now)
      ? [{ position: index + 1, scene: scene.id, text: scene.narration.text }] : [];
  });
  const placedByPage = await pagePictureIds({ productionAbs, videoId, manifest, ledger, product });
  for (const id of placedByPage) {
    const row = rowOf.get(id);
    if (row) uses.add(cardOfAsset(row));
  }
  // Every video is made from the product, whether or not it quotes a fact word for word.
  if (product?.facts.length) uses.add(PRODUCT_CARD_KEY);
  return {
    key: `video:${videoId}`,
    id: videoId,
    label: manifest.label,
    width: manifest.canvas.width,
    height: manifest.canvas.height,
    duration_sec: timeline.durationSec,
    scenes,
    versions: versionCards(productionAbs, input.versions.filter((version) => version.video_id === manifest.id)),
    product_changes: await productChangesSinceDelivery({ productionDirAbs: productionAbs, videoDirAbs: path.join(productionAbs, 'videos', videoId) }),
    uses: [...uses],
    placed_by_page: placedByPage,
    removed_scenes: input.removed.length
      ? removedSceneCards({ manifest, removed: input.removed, ledger, product, inPage: new Set(await pageSceneIds(path.join(productionAbs, 'videos', videoId))) })
      : [],
    voice,
    // A pick stands while the narration has the voice it had then, and is not that voice.
    voice_wanted: choice && sameVoice(choice.from, voice) && !sameVoice(choice, voice)
      ? { route_ref: choice.route_ref, voice_ref: choice.voice_ref, name: choice.name } : null,
    narration_changes: narrationChanges,
  };
}

/** The cards of the product's own pictures, in the order it lists them. */
function productPictureCards(product: VideoProduct, ledger: readonly VideoAssetRecord[]): string[] {
  const rowOf = new Map(ledger.map((row) => [row.id, row]));
  return [...new Set(product.images.flatMap((id) => {
    const row = rowOf.get(id);
    return row && row.kind !== 'audio' ? [cardOfAsset(row)] : [];
  }))];
}

async function readProduction(workspaceAbs: string, productionAbs: string): Promise<VideoCanvasProduction | null> {
  if (!isPathAllowed(productionAbs, [workspaceAbs]) || !productionPathsAllowed(productionAbs)) return null;
  const folders = (await videoFolders(productionAbs)).slice(0, MAX_VIDEOS_PER_PRODUCTION);
  const ledger = await readProductionLedger(productionAbs) ?? [];
  const { versions, deliveredNarration } = await readVersionFile(productionAbs);
  if (!folders.length && !ledger.length && !versions.length) return null;
  const product = await readProduct(productionAbs);
  const canvas = await readCanvasFile(productionAbs);
  const manifests = (await Promise.all(folders.map(async (videoId) => ({
    videoId,
    manifest: videoDirIn(productionAbs, videoId) ? await readManifest(path.join(productionAbs, 'videos', videoId)) : null,
  })))).filter((item): item is { videoId: string; manifest: VideoManifestV3 } => !!item.manifest);
  const videos = await Promise.all(manifests.map(({ videoId, manifest }) => buildVideoCard({
    productionAbs,
    videoId,
    manifest,
    ledger,
    product,
    versions,
    deliveredNarration,
    removed: removedIn(canvas, videoId),
    voiceChoice: voiceChoiceIn(canvas, videoId),
  })));
  // A video made with ffmpeg alone has delivered files and nothing else.
  const loose = versionCards(productionAbs, versions.filter((version) => !version.video_id));
  if (loose.length) {
    const latest = loose[loose.length - 1];
    videos.push({
      key: 'video:delivered',
      id: '',
      label: path.basename(latest.media_path),
      width: 0,
      height: 0,
      duration_sec: latest.duration_sec ?? 0,
      scenes: [],
      versions: loose,
      product_changes: [],
      uses: [],
      placed_by_page: [],
      removed_scenes: [],
      voice: null,
      voice_wanted: null,
      narration_changes: [],
    });
  }
  // A video shows a picture through a clip, an overlay or its page.
  const usedIn = new Map<string, number>();
  manifests.forEach(({ manifest }, index) => {
    const shown = new Set([...manifest.scenes.flatMap((scene) => (scene.clips ?? []).map((clip) => clip.asset)), ...videos[index].placed_by_page]);
    for (const id of shown) usedIn.set(id, (usedIn.get(id) ?? 0) + 1);
  });
  const assets = buildAssetCards(productionAbs, ledger);
  const shots = buildShotCards(productionAbs, ledger, usedIn);
  if (!videos.length && !assets.length && !shots.length) return null;
  // Moving a card is not a change to the work, so canvas.json has no say in the order.
  const times = await Promise.all([
    ...['assets.json', 'versions.json', 'product.json'].map((name) => path.join(productionAbs, name)),
    ...manifests.map(({ videoId }) => path.join(productionAbs, 'videos', videoId, 'manifest.json')),
  ].map((file) => fs.stat(file).then((st) => st.mtimeMs, () => 0)));
  const relative = path.relative(workspaceAbs, productionAbs).split(path.sep).join('/') || '.';
  return {
    dir: relative,
    name: product?.name || (relative === '.' ? videos[0]?.label ?? '' : path.basename(productionAbs)),
    updated_at_ms: Math.max(0, ...times),
    product: product
      ? {
        key: PRODUCT_CARD_KEY,
        label: product.name,
        facts: product.facts,
        uses: productPictureCards(product, ledger),
      }
      : null,
    layout: canvas.cards,
    assets,
    shots,
    drafts: buildDraftCards(productionAbs, ledger, canvas.drafts),
    videos,
  };
}

/** Every production in the conversation's workspace, the one touched last first. */
export async function readVideoCanvasProductions(uid: string, cid: string): Promise<VideoCanvasProduction[]> {
  const workspaceAbs = await getConversationWorkspacePath(uid, cid).catch((err) => {
    log.warn('canvas workspace resolution failed', { user_id: maskId(uid), cid: maskId(cid), error: logErrorSummary(err) });
    return '';
  });
  if (!workspaceAbs) return [];
  // Only work this machine knows VideoStudio made: opening a conversation must not write
  // into a folder that merely looks like an old production.
  await upgradeWorkspaceOnce({ userId: uid, workspaceAbs, gateRecordsOnly: true }).catch((err) => {
    log.warn('canvas upgrade failed', { error: logErrorSummary(err) });
  });
  const children = await fs.readdir(workspaceAbs, { withFileTypes: true }).catch(() => []);
  const candidates = [
    workspaceAbs,
    ...children
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .slice(0, MAX_PRODUCTION_CANDIDATES)
      .map((entry) => path.join(workspaceAbs, entry.name)),
  ];
  const productions = (await Promise.all(candidates.map((productionAbs) => readProduction(workspaceAbs, productionAbs).catch((err) => {
    log.warn('production unreadable on the canvas', { error: logErrorSummary(err) });
    return null;
  })))).filter((item): item is VideoCanvasProduction => !!item);
  return productions.sort((a, b) => b.updated_at_ms - a.updated_at_ms);
}

/** Moving a card changes nothing about a video, so this does not wait for the Agent. */
export async function saveVideoCanvasLayout(input: {
  uid: string;
  cid: string;
  dir: unknown;
  cards: unknown;
}): Promise<{ ok: true } | VideoCanvasRefusal> {
  const located = await locateProduction(input.uid, input.cid, input.dir);
  if (!located) return { ok: false, code: 'not_found' };
  if (!input.cards || typeof input.cards !== 'object' || Array.isArray(input.cards)) return { ok: false, code: 'invalid' };
  const cards = sanitizeLayout(input.cards as Record<string, unknown>);
  const { productionAbs } = located;
  await fileEditLock(path.join(productionAbs, LAYOUT_FILE)).runExclusive(async () => {
    const canvas = await readCanvasFile(productionAbs);
    // A new shot generated or removed since the renderer read the canvas has no card to place.
    const placed = Object.fromEntries(Object.entries(cards).filter(([key]) => !key.startsWith('draft:') || key.slice('draft:'.length) in canvas.drafts));
    await writeCanvasFile(productionAbs, { ...canvas, cards: placed });
  });
  return { ok: true };
}

/** The footage a new shot is made from, or null if any of it cannot be: sound, footage the
 *  ledger does not have, a file that is gone, or a video for a still. The same footage twice is once. */
function draftInputIds(
  productionAbs: string,
  ledger: readonly VideoAssetRecord[],
  kind: VideoCanvasStoredDraft['kind'],
  value: unknown,
): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_DRAFT_INPUTS) return null;
  const ids: string[] = [];
  for (const item of value) {
    const row = typeof item === 'string' ? ledger.find((entry) => entry.id === item) : undefined;
    if (!row || row.kind === 'audio' || (kind === 'image' && row.kind !== 'image') || !fileInProduction(productionAbs, row.path)) return null;
    if (!ids.includes(row.id)) ids.push(row.id);
  }
  return ids;
}

/** An id no shot on the ledger and no other new shot has, since it becomes the shot's. */
function newDraftId(ledger: readonly VideoAssetRecord[], drafts: CanvasFile['drafts']): string {
  const taken = new Set([...ledger.map((row) => row.shot || row.id), ...Object.keys(drafts)]);
  let id = '';
  do id = `new-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`; while (taken.has(id));
  return id;
}

/** Apply one field of an update, or say it cannot be saved. */
function updatedDraft(
  draft: VideoCanvasStoredDraft,
  change: Record<string, unknown>,
  inputsOf: (value: unknown) => string[] | null,
): VideoCanvasStoredDraft | null {
  const next = { ...draft };
  if (change.prompt !== undefined) {
    if (typeof change.prompt !== 'string' || change.prompt.length > MAX_PROMPT_CHARS) return null;
    next.prompt = change.prompt;
  }
  if (change.method !== undefined) {
    if (change.method !== 'references' && !(change.method === 'frames' && draft.kind === 'video')) return null;
    next.method = change.method;
  }
  if (change.inputs !== undefined) {
    const inputs = inputsOf(change.inputs);
    if (!inputs) return null;
    next.inputs = inputs;
  }
  if (change.choice !== undefined) {
    if (typeof change.choice !== 'string' || change.choice.length > MAX_CHOICE_CHARS) return null;
    if (change.choice) next.choice = change.choice;
    else delete next.choice;
  }
  if (change.ratio !== undefined) {
    if (typeof change.ratio !== 'string' || !DRAFT_RATIOS.includes(change.ratio)) return null;
    next.ratio = change.ratio;
  }
  if (change.duration !== undefined) {
    if (!isDraftSeconds(change.duration)) return null;
    next.duration = change.duration;
  }
  if (change.resolution !== undefined) {
    if (typeof change.resolution !== 'string' || !VIDEO_RESOLUTIONS.includes(change.resolution)) return null;
    next.resolution = change.resolution;
  }
  if (change.audio !== undefined) {
    if (typeof change.audio !== 'boolean') return null;
    next.audio = change.audio;
  }
  return next;
}

/**
 * Make, change or remove a new shot drawn on the canvas (decided 2026-11-10). Like moving a card,
 * it changes no video and so does not wait for the Agent: the shot is made only when the user
 * generates it, which does wait.
 */
export async function applyVideoCanvasDraftChange(input: {
  uid: string;
  cid: string;
  dir: unknown;
  change: unknown;
}): Promise<{ ok: true; id: string } | VideoCanvasRefusal> {
  const located = await locateProduction(input.uid, input.cid, input.dir);
  if (!located) return { ok: false, code: 'not_found' };
  const { productionAbs } = located;
  const change = (input.change && typeof input.change === 'object' ? input.change : {}) as Record<string, unknown>;
  if (change.kind !== 'create' && change.kind !== 'update' && change.kind !== 'remove') return { ok: false, code: 'invalid' };
  const ledger = await readProductionLedger(productionAbs);
  if (!ledger) return { ok: false, code: 'unreadable' };
  return fileEditLock(path.join(productionAbs, LAYOUT_FILE)).runExclusive(async (): Promise<{ ok: true; id: string } | VideoCanvasRefusal> => {
    const canvas = await readCanvasFile(productionAbs);
    if (change.kind === 'create') {
      const kind = change.type;
      const at = (change.at && typeof change.at === 'object' ? change.at : {}) as { x?: unknown; y?: unknown };
      if ((kind !== 'video' && kind !== 'image') || typeof at.x !== 'number' || !Number.isFinite(at.x) || typeof at.y !== 'number' || !Number.isFinite(at.y)) {
        return { ok: false, code: 'invalid' };
      }
      const inputs = draftInputIds(productionAbs, ledger, kind, change.inputs ?? []);
      if (!inputs || Object.keys(canvas.drafts).length >= MAX_DRAFTS) return { ok: false, code: 'invalid' };
      const id = newDraftId(ledger, canvas.drafts);
      canvas.drafts[id] = { kind, prompt: '', method: 'references', inputs };
      canvas.cards[`draft:${id}`] = { x: Math.round(at.x), y: Math.round(at.y) };
      await writeCanvasFile(productionAbs, canvas);
      return { ok: true, id };
    }
    const id = typeof change.id === 'string' ? change.id : '';
    const draft = ID_RE.test(id) ? canvas.drafts[id] : undefined;
    if (!draft) return { ok: false, code: 'not_found' };
    if (change.kind === 'remove') {
      delete canvas.drafts[id];
      delete canvas.cards[`draft:${id}`];
    } else {
      const next = updatedDraft(draft, change, (value) => draftInputIds(productionAbs, ledger, draft.kind, value));
      if (!next) return { ok: false, code: 'invalid' };
      canvas.drafts[id] = next;
    }
    await writeCanvasFile(productionAbs, canvas);
    return { ok: true, id };
  });
}

export type VideoCanvasDraftSource = {
  draft: VideoCanvasStoredDraft;
  /** Its footage still on the canvas, in order, as files. */
  inputs: Array<{ asset_id: string; kind: 'image' | 'video'; path: string }>;
  /** The shape of the production's video, which a new shot defaults to. */
  shape: { width: number; height: number } | null;
  /** The shape of the picture a new shot opens on, which it defaults to instead. */
  frameShape: { width: number; height: number } | null;
};

/** A new shot as stored, for pricing and making it. */
export async function readVideoCanvasDraft(productionAbs: string, id: unknown): Promise<VideoCanvasDraftSource | VideoCanvasRefusal> {
  if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false, code: 'not_found' };
  const draft = (await readCanvasFile(productionAbs)).drafts[id];
  if (!draft) return { ok: false, code: 'not_found' };
  // Made without footage it was given would be a different shot, and still paid for.
  const ledger = await readProductionLedger(productionAbs);
  if (!ledger) return { ok: false, code: 'unreadable' };
  // Display projection may omit unavailable footage; a paid request must retain
  // every selection, including its media kind and physical containment.
  if (!draftInputIds(productionAbs, ledger, draft.kind, draft.inputs)) return { ok: false, code: 'invalid' };
  const inputs = draftInputs(productionAbs, ledger, draft.inputs).map(({ asset_id, kind, path: file }) => ({ asset_id, kind, path: file }));
  let shape: VideoCanvasDraftSource['shape'] = null;
  for (const videoId of (await videoFolders(productionAbs)).sort().slice(0, MAX_VIDEOS_PER_PRODUCTION)) {
    const videoDirAbs = videoDirIn(productionAbs, videoId);
    const manifest = videoDirAbs ? await readManifest(videoDirAbs) : null;
    if (manifest && manifest.canvas.width > 0 && manifest.canvas.height > 0) {
      shape = { width: manifest.canvas.width, height: manifest.canvas.height };
      break;
    }
  }
  const opening = draft.kind === 'video' && draft.method === 'frames' && inputs[0]?.kind === 'image' ? inputs[0].path : '';
  return { draft, inputs, shape, frameShape: opening ? await pictureShape(opening) : null };
}

/** A picture's width and height, from its file; none when it cannot be read. */
export async function pictureShape(fileAbs: string): Promise<{ width: number; height: number } | null> {
  const probe = await probed(fileAbs);
  const width = probe?.video?.width;
  const height = probe?.video?.height;
  return width && height ? { width, height } : null;
}

/**
 * Whether a video already shows what its timeline shows: it has a version, and its timeline has not
 * changed since its last delivery. Asked when the user presses Update, never to label the card
 * (decided 2026-11-11). Nothing on record counts as unchanged, as for an upgraded video, since the
 * first change notes the timeline before it.
 */
export async function videoUpToDate(productionAbs: string, videoId: string): Promise<boolean> {
  const videoDirAbs = videoDirIn(productionAbs, videoId);
  const manifest = videoDirAbs ? await readManifest(videoDirAbs) : null;
  if (!videoDirAbs || !manifest) return false;
  if (!(await readVersions(productionAbs)).some((version) => version.video_id === manifest.id)) return false;
  return !await timelineAheadOfDelivery({ productionDirAbs: productionAbs, videoDirAbs });
}

/** The new shot was made: its card gives way to the shot's, in the same place. */
export async function settleVideoCanvasDraft(productionAbs: string, id: string): Promise<void> {
  await fileEditLock(path.join(productionAbs, LAYOUT_FILE)).runExclusive(async () => {
    const canvas = await readCanvasFile(productionAbs);
    if (!canvas.drafts[id]) return;
    delete canvas.drafts[id];
    const at = canvas.cards[`draft:${id}`];
    delete canvas.cards[`draft:${id}`];
    if (at && !canvas.cards[`shot:${id}`]) canvas.cards[`shot:${id}`] = at;
    await writeCanvasFile(productionAbs, canvas);
  });
}

async function probed(fileAbs: string) {
  const { ffprobe } = bundledFfmpegPaths();
  return ffprobe ? probeMedia(ffprobe, fileAbs).catch(() => null) : null;
}

const REFUSAL_OF_ISSUE: Readonly<Record<string, VideoCanvasRefusalCode>> = {
  TIMELINE_NARRATION_OVERRUNS_SCENE: 'too_short',
  TIMELINE_CLIP_PAST_MEDIA_END: 'too_short',
  TIMELINE_TOO_LONG: 'too_long',
};

/** Why this timeline could not render, if it could not. */
function refusalFor(
  manifest: VideoManifestV3,
  ledger: readonly VideoAssetRecord[],
  product: VideoProduct | null,
  lengths: ReadonlyMap<string, number>,
): VideoCanvasRefusal | null {
  const blocking = validateVideoTimeline({ manifest, assets: ledger, product, mediaDurations: lengths })
    .find((issue) => issue.severity === 'error');
  return blocking ? { ok: false, code: REFUSAL_OF_ISSUE[blocking.code] ?? 'invalid', detail: blocking.message } : null;
}

function unusedId(base: string, taken: ReadonlySet<string>): string {
  const stem = base.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'scene';
  const start = /^[A-Za-z0-9]/.test(stem) ? stem : `s-${stem}`;
  let id = start;
  for (let n = 2; taken.has(id); n += 1) id = `${start}-${n}`;
  return id;
}

type TimelineEdit = Extract<VideoCanvasEdit, { video: string }>;

type PictureFacts = { lengthSec: number | null; hasSound: boolean };

/** What a picture from the ledger can be on a timeline, measured from its file. */
async function pictureFacts(productionAbs: string, row: VideoAssetRecord): Promise<PictureFacts | VideoCanvasRefusal> {
  if (row.kind === 'audio') return { ok: false, code: 'invalid', detail: `"${row.id}" is audio, and a scene needs a picture.` };
  const abs = path.resolve(productionAbs, row.path);
  if (!isPathAllowed(abs, [productionAbs]) || !await fs.stat(abs).then((st) => st.isFile(), () => false)) return { ok: false, code: 'not_found' };
  if (row.kind === 'image') return { lengthSec: null, hasSound: false };
  const probe = await probed(abs);
  return probe?.duration_seconds ? { lengthSec: probe.duration_seconds, hasSound: !!probe.audio } : { ok: false, code: 'unreadable' };
}

/** Point a clip at a new picture. Its length can only shrink, and a kept sound the picture
 *  does not have would make every later mix fail. */
function pointClipAt(clip: VideoClip, row: VideoAssetRecord, facts: PictureFacts): void {
  clip.asset = row.id;
  clip.in = 0;
  if (facts.lengthSec !== null) clip.dur = Math.min(clip.dur, facts.lengthSec);
  if (!facts.hasSound) {
    delete clip.audio;
    delete clip.volume;
  }
}

/** The scene ids a page holds, which include scenes taken off the timeline: a new scene
 *  under one of those ids would take over its section. */
async function pageSceneIds(videoDirAbs: unknown): Promise<string[]> {
  if (typeof videoDirAbs !== 'string') return [];
  const page = await fs.readFile(path.join(videoDirAbs, 'index.html'), 'utf8').catch(() => '');
  return [...page.matchAll(/data-scene-id\s*=\s*["']([^"']+)["']/g)].map((match) => match[1]);
}

/** Put a scene taken out back into a timeline, after the scene it followed, else where it stood.
 *  It keeps its ids unless a scene added since took them. A page finds its section and clips by
 *  those ids, so a scene the page holds goes back under them or not at all. */
function putSceneBack(manifest: VideoManifestV3, record: StoredRemovedScene, inPage: ReadonlySet<string>): { at: number } | VideoCanvasRefusal {
  const scene = structuredClone(record.scene);
  const used = new Set(manifest.scenes.flatMap((item) => [item.id, ...(item.clips ?? []).map((clip) => clip.id)]));
  const clash = used.has(scene.id) || (scene.clips ?? []).some((clip) => used.has(clip.id));
  if (clash) {
    if (inPage.has(scene.id)) return { ok: false, code: 'invalid', detail: 'Another scene now has the ids this page shows it by.' };
    const taken = new Set([...used, ...inPage]);
    scene.id = unusedId(scene.id, taken);
    taken.add(scene.id);
    for (const clip of scene.clips ?? []) {
      clip.id = unusedId(`${scene.id}-clip`, taken);
      taken.add(clip.id);
    }
  }
  const follows = record.after === null ? -1 : manifest.scenes.findIndex((item) => item.id === record.after);
  const at = record.after === null ? 0 : follows >= 0 ? follows + 1 : Math.min(record.index, manifest.scenes.length);
  manifest.scenes.splice(at, 0, scene);
  return { at };
}

/** The scenes a video can take back, as its "+" offers them: each tried on a copy of the
 *  timeline with the same check a change gets, so what is offered goes back. */
function removedSceneCards(input: {
  manifest: VideoManifestV3;
  removed: readonly StoredRemovedScene[];
  ledger: readonly VideoAssetRecord[];
  product: VideoProduct | null;
  inPage: ReadonlySet<string>;
}): VideoCanvasRemovedScene[] {
  return input.removed.flatMap((record) => {
    const trial = structuredClone(input.manifest);
    const placed = putSceneBack(trial, record, input.inPage);
    if ('ok' in placed || refusalFor(trial, input.ledger, input.product, new Map())) return [];
    const values = resolveSceneText(record.scene, input.product);
    const words = [...(Object.values(values).find((value) => value.trim()) ?? record.scene.narration?.text ?? '').trim()];
    return [{
      key: record.key,
      position: record.index + 1,
      duration_sec: deriveVideoTimeline(trial).scenes[placed.at].durationSec,
      words: words.length > MAX_REMOVED_WORDS_CHARS ? `${words.slice(0, MAX_REMOVED_WORDS_CHARS).join('')}\u2026` : words.join(''),
    }];
  });
}

/** Change one video's timeline, unless the result could not render. */
async function editTimeline(input: {
  productionAbs: string;
  video: unknown;
  ledger: readonly VideoAssetRecord[];
  product: VideoProduct | null;
  change: (manifest: VideoManifestV3, lengths: Map<string, number>) => Promise<VideoCanvasRefusal | void> | VideoCanvasRefusal | void;
}): Promise<VideoCanvasEditResult> {
  const videoDirAbs = videoDirIn(input.productionAbs, input.video);
  if (!videoDirAbs) return { ok: false, code: 'not_found' };
  const file = path.join(videoDirAbs, 'manifest.json');
  return fileEditLock(file).runExclusive(async (): Promise<VideoCanvasEditResult> => {
    const manifest = await readManifest(videoDirAbs);
    if (!manifest) return { ok: false, code: await fs.stat(file).then(() => 'unreadable' as const, () => 'not_found' as const) };
    const lengths = new Map<string, number>();
    const refused = await input.change(manifest, lengths);
    if (refused) return refused;
    const problem = refusalFor(manifest, input.ledger, input.product, lengths);
    if (problem) return problem;
    await noteTimelineBeforeChange({ productionDirAbs: input.productionAbs, videoDirAbs });
    await writeBytesAtomic(file, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
    return { ok: true, changed_videos: [String(input.video)] };
  });
}

/** A shorter picture shortens its scene, and the scene's narration still has to fit. */
async function noteNarrationLength(
  productionAbs: string,
  ledger: readonly VideoAssetRecord[],
  scene: VideoManifestV3['scenes'][number],
  lengths: Map<string, number>,
): Promise<void> {
  const voice = scene.narration?.asset ? ledger.find((row) => row.id === scene.narration?.asset) : undefined;
  if (!voice) return;
  const voiceAbs = path.resolve(productionAbs, voice.path);
  if (!isPathAllowed(voiceAbs, [productionAbs])) return;
  const probe = await probed(voiceAbs);
  if (probe?.duration_seconds) lengths.set(voice.id, probe.duration_seconds);
}

async function applyTimelineEdit(
  edit: TimelineEdit,
  productionAbs: string,
  ledger: readonly VideoAssetRecord[],
  product: VideoProduct | null,
): Promise<VideoCanvasEditResult> {
  const common = { productionAbs, video: edit.video, ledger, product };
  const sceneOf = (manifest: VideoManifestV3, id: string) => manifest.scenes.find((scene) => scene.id === id);
  switch (edit.kind) {
    case 'set_text':
      return editTimeline({
        ...common,
        change: (manifest) => {
          const text = sceneOf(manifest, edit.scene)?.text;
          if (!text?.[edit.slot]) return { ok: false, code: 'not_found' };
          // Words that quoted a product fact become this scene's own, and the product stays as it
          // was (decided 2026-11-11).
          text[edit.slot] = { value: String(edit.value) };
          return undefined;
        },
      });
    case 'reorder':
      return editTimeline({
        ...common,
        change: (manifest) => {
          const ids = manifest.scenes.map((scene) => scene.id);
          const order = Array.isArray(edit.order) ? edit.order.map(String) : [];
          if (order.length !== ids.length || new Set(order).size !== ids.length || order.some((id) => !ids.includes(id))) {
            return { ok: false, code: 'invalid', detail: 'The order has to list every scene once.' };
          }
          manifest.scenes = order.map((id) => sceneOf(manifest, id) as VideoManifestV3['scenes'][number]);
          return undefined;
        },
      });
    case 'remove_scene': {
      const taken: { record?: StoredRemovedScene } = {};
      const result = await editTimeline({
        ...common,
        change: (manifest) => {
          const index = manifest.scenes.findIndex((scene) => scene.id === edit.scene);
          if (index < 0) return { ok: false, code: 'not_found' };
          if (manifest.scenes.length === 1) return { ok: false, code: 'last_scene' };
          const [scene] = manifest.scenes.splice(index, 1);
          taken.record = { key: randomBytes(6).toString('hex'), scene, index, after: index > 0 ? manifest.scenes[index - 1].id : null };
          return undefined;
        },
      });
      // Kept once the change is saved, so a scene that stayed is never offered back.
      if (result.ok && taken.record) await keepRemovedScene(productionAbs, String(edit.video), taken.record);
      return result;
    }
    case 'set_narration': {
      const rowOf = new Map(ledger.map((row) => [row.id, row]));
      const { deliveredNarration } = await readVersionFile(productionAbs);
      return editTimeline({
        ...common,
        change: async (manifest) => {
          const scene = sceneOf(manifest, edit.scene);
          if (!scene) return { ok: false, code: 'not_found' };
          const words = String(edit.value ?? '').trim();
          // Only words that were voiced here, and are known, can be voiced again with the same voice.
          const heard = await heardNarration(productionAbs, [scene], rowOf, deliveredNarration);
          if (!scene.narration || !heard.has(scene.id) || !words) return { ok: false, code: 'invalid' };
          scene.narration = { ...scene.narration, text: words };
          return undefined;
        },
      });
    }
    case 'restore_scene': {
      const taken = await takeRemovedScene(productionAbs, String(edit.video), edit.removed);
      if (!taken) return { ok: false, code: 'not_found' };
      try {
        const inPage = new Set(await pageSceneIds(videoDirIn(productionAbs, edit.video)));
        const result = await editTimeline({
          ...common,
          change: (manifest) => {
            const placed = putSceneBack(manifest, taken.record, inPage);
            return 'ok' in placed ? placed : undefined;
          },
        });
        if (!result.ok) await returnRemovedScene(productionAbs, String(edit.video), taken.record, taken.position);
        return result;
      } catch (error) {
        await returnRemovedScene(productionAbs, String(edit.video), taken.record, taken.position);
        throw error;
      }
    }
    case 'add_scene': {
      const row = ledger.find((item) => item.id === edit.asset);
      if (!row) return { ok: false, code: 'not_found' };
      const measured = await pictureFacts(productionAbs, row);
      if ('ok' in measured) return measured;
      const dur = measured.lengthSec === null ? ADDED_STILL_SEC : Math.min(measured.lengthSec, ADDED_CLIP_MAX_SEC);
      const inPage = await pageSceneIds(videoDirIn(productionAbs, edit.video));
      const result = await editTimeline({
        ...common,
        change: (manifest, lengths) => {
          if (measured.lengthSec !== null) lengths.set(row.id, measured.lengthSec);
          const taken = new Set([...inPage, ...manifest.scenes.flatMap((scene) => [scene.id, ...(scene.clips ?? []).map((clip) => clip.id)])]);
          const id = unusedId(row.shot || row.id, taken);
          const clipId = unusedId(`${id}-clip`, new Set([...taken, id]));
          const after = edit.after ? manifest.scenes.findIndex((scene) => scene.id === edit.after) : -1;
          manifest.scenes.splice(after >= 0 ? after + 1 : manifest.scenes.length, 0, {
            id,
            clips: [{ id: clipId, asset: row.id, in: 0, dur }],
          });
        },
      });
      return result.ok && measured.lengthSec !== null && measured.lengthSec > ADDED_CLIP_MAX_SEC
        ? { ...result, trimmed_to_sec: ADDED_CLIP_MAX_SEC }
        : result;
    }
    case 'swap_clip': {
      const row = ledger.find((item) => item.id === edit.asset);
      if (!row) return { ok: false, code: 'not_found' };
      const measured = await pictureFacts(productionAbs, row);
      if ('ok' in measured) return measured;
      return editTimeline({
        ...common,
        change: async (manifest, lengths) => {
          const scene = sceneOf(manifest, edit.scene);
          if (!scene) return { ok: false, code: 'not_found' };
          if (measured.lengthSec !== null) lengths.set(row.id, measured.lengthSec);
          await noteNarrationLength(productionAbs, ledger, scene, lengths);
          const sequential = (scene.clips ?? []).find((clip) => clip.at === undefined);
          if (edit.if_current !== undefined && sequential?.asset !== edit.if_current) return { ok: false, code: 'changed' };
          if (sequential) {
            // The page finds its clip by id, so the id stays and only the picture changes.
            pointClipAt(sequential, row, measured);
            return undefined;
          }
          // An old page draws this scene itself, with no room to lay a picture behind it.
          if (typeof manifest.absolute_page?.scene_starts[scene.id] === 'number') return { ok: false, code: 'page_scene' };
          const taken = new Set(manifest.scenes.flatMap((item) => (item.clips ?? []).map((clip) => clip.id)));
          const clip: VideoClip = { id: unusedId(`${scene.id}-clip`, taken), asset: row.id, in: 0, dur: scene.duration ?? measured.lengthSec ?? ADDED_STILL_SEC };
          pointClipAt(clip, row, measured);
          scene.clips = [...(scene.clips ?? []), clip];
          delete scene.duration;
          return undefined;
        },
      });
    }
    default:
      return { ok: false, code: 'invalid' };
  }
}

async function readAllManifests(productionAbs: string): Promise<Array<{ id: string; manifest: VideoManifestV3 }>> {
  const items = await Promise.all((await videoFolders(productionAbs)).map(async (id) => ({
    id,
    manifest: videoDirIn(productionAbs, id) ? await readManifest(path.join(productionAbs, 'videos', id)) : null,
  })));
  return items.filter((item): item is { id: string; manifest: VideoManifestV3 } => !!item.manifest);
}

/** A fact the videos quote, changed on the product card. The videos quoting it are not rendered:
 *  they say they are behind, and the user updates them when ready (decided on 2026-11-09). */
async function applyFactEdit(
  edit: Extract<VideoCanvasEdit, { kind: 'set_fact' }>,
  productionAbs: string,
): Promise<VideoCanvasEditResult> {
  const file = path.join(productionAbs, 'product.json');
  const manifests = await readAllManifests(productionAbs);
  return fileEditLock(file).runExclusive(async (): Promise<VideoCanvasEditResult> => {
    if (!await readProduct(productionAbs)) return { ok: false, code: 'not_found' };
    // Written back as it was read, because the Agent may keep more here than this needs.
    const raw = await readJson(file) as { facts: Array<Record<string, unknown>> };
    const fact = raw.facts.find((item) => item.id === edit.fact);
    if (!fact) return { ok: false, code: 'not_found' };
    const text = String(edit.text).trim();
    if (!text) return { ok: false, code: 'invalid' };
    fact.text = text;
    // The user just stated it.
    fact.source = 'user';
    // Every video is made from the product, so each is behind until the user updates it.
    const videos = manifests.map(({ id }) => id);
    for (const id of videos) {
      await noteTimelineBeforeChange({ productionDirAbs: productionAbs, videoDirAbs: path.join(productionAbs, 'videos', id) });
    }
    await writeBytesAtomic(file, Buffer.from(`${JSON.stringify(raw, null, 2)}\n`));
    return { ok: true, changed_videos: videos };
  });
}

function usesAsset(manifest: VideoManifestV3, assetId: string): boolean {
  return manifest.scenes.some((scene) => (
    (scene.clips ?? []).some((clip) => clip.asset === assetId) || scene.narration?.asset === assetId
  )) || (manifest.tracks ?? []).some((track) => track.asset === assetId);
}

/** Take one row off the ledger. The others are written back as they were read, because a
 *  model may keep more in them than this needs. */
async function removeLedgerRow(productionAbs: string, assetId: string): Promise<boolean> {
  const file = path.join(productionAbs, 'assets.json');
  return fileEditLock(file).runExclusive(async () => {
    if (!await readProductionLedger(productionAbs)) return false;
    const raw = await readJson(file) as { assets: Array<Record<string, unknown>> };
    raw.assets = raw.assets.filter((row) => row.id !== assetId);
    await writeBytesAtomic(file, Buffer.from(`${JSON.stringify(raw, null, 2)}\n`));
    return true;
  });
}

/** Show `next` wherever a clip shows one of `old`, in every video, or change nothing: no video
 *  keeps an old picture because another one could not take the new one. */
async function replaceInVideos(input: {
  productionAbs: string;
  ledger: readonly VideoAssetRecord[];
  product: VideoProduct | null;
  old: ReadonlySet<string>;
  next: VideoAssetRecord;
  videos: ReadonlyArray<{ id: string; manifest: VideoManifestV3 }>;
}): Promise<{ ok: true; videos: string[] } | VideoCanvasRefusal> {
  const { productionAbs, ledger, product, old, next } = input;
  const users = input.videos.filter((item) => [...old].some((id) => usesAsset(item.manifest, id)));
  const measured = await pictureFacts(productionAbs, next);
  if ('ok' in measured) return measured;
  const lengths = new Map(measured.lengthSec === null ? [] : [[next.id, measured.lengthSec]]);
  for (const { manifest } of users) {
    for (const scene of manifest.scenes) {
      if (!(scene.clips ?? []).some((clip) => old.has(clip.asset))) continue;
      await noteNarrationLength(productionAbs, ledger, scene, lengths);
      for (const clip of scene.clips ?? []) {
        if (old.has(clip.asset)) pointClipAt(clip, next, measured);
      }
    }
    const problem = refusalFor(manifest, ledger, product, lengths);
    if (problem) return problem;
  }
  for (const { id, manifest } of users) {
    const videoDirAbs = path.join(productionAbs, 'videos', id);
    await noteTimelineBeforeChange({ productionDirAbs: productionAbs, videoDirAbs });
    const file = path.join(videoDirAbs, 'manifest.json');
    await fileEditLock(file).runExclusive(() => writeBytesAtomic(file, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)));
  }
  return { ok: true, videos: users.map((item) => item.id) };
}

/** Whether a video's page places one of these rows by file. The page is the Agent's, so a
 *  picture it places stays where it is. */
async function placedByAnyPage(
  productionAbs: string,
  ledger: readonly VideoAssetRecord[],
  product: VideoProduct | null,
  videos: ReadonlyArray<{ id: string; manifest: VideoManifestV3 }>,
  ids: ReadonlySet<string>,
): Promise<boolean> {
  return (await Promise.all(videos.map(({ id, manifest }) => pagePictureIds({ productionAbs, videoId: id, manifest, ledger, product }))))
    .some((placed) => placed.some((id) => ids.has(id)));
}

async function applyAssetEdit(
  edit: Extract<VideoCanvasEdit, { kind: 'remove_asset' | 'replace_asset' }>,
  productionAbs: string,
  ledger: readonly VideoAssetRecord[],
  product: VideoProduct | null,
): Promise<VideoCanvasEditResult> {
  const row = ledger.find((item) => item.id === edit.asset);
  if (!row) return { ok: false, code: 'not_found' };
  const videos = await readAllManifests(productionAbs);
  const placed = await placedByAnyPage(productionAbs, ledger, product, videos, new Set([row.id]));
  if (edit.kind === 'remove_asset') {
    if (videos.some((item) => usesAsset(item.manifest, row.id)) || placed) return { ok: false, code: 'in_use' };
    // Only the row goes. The file may have been paid for, and keeping it costs little.
    return await removeLedgerRow(productionAbs, row.id)
      ? { ok: true, changed_videos: [] }
      : { ok: false, code: 'unreadable' };
  }
  if (placed) return { ok: false, code: 'page_picture' };
  const next = ledger.find((item) => item.id === edit.with);
  if (!next || next.id === row.id) return { ok: false, code: 'not_found' };
  const replaced = await replaceInVideos({ productionAbs, ledger, product, old: new Set([row.id]), next, videos });
  if (replaced.ok === false) return replaced;
  // A generated result stays in its shot's history: it was paid for, and it can come back.
  if (row.origin !== 'generated') await removeLedgerRow(productionAbs, row.id);
  return { ok: true, changed_videos: replaced.videos };
}

/** A take shown wherever its shot is shown, in place of the shot's other takes. */
async function applyUseResult(
  edit: Extract<VideoCanvasEdit, { kind: 'use_result' }>,
  productionAbs: string,
  ledger: readonly VideoAssetRecord[],
  product: VideoProduct | null,
): Promise<VideoCanvasEditResult> {
  const row = ledger.find((item) => item.id === edit.asset);
  if (!row || row.origin !== 'generated' || row.kind === 'audio') return { ok: false, code: 'not_found' };
  const shot = cardOfAsset(row);
  const others = new Set(ledger
    .filter((item) => item.id !== row.id && item.origin === 'generated' && item.kind !== 'audio' && cardOfAsset(item) === shot)
    .map((item) => item.id));
  const videos = await readAllManifests(productionAbs);
  if (await placedByAnyPage(productionAbs, ledger, product, videos, others)) return { ok: false, code: 'page_picture' };
  const replaced = await replaceInVideos({ productionAbs, ledger, product, old: others, next: row, videos });
  if (replaced.ok === false) return replaced;
  return { ok: true, changed_videos: replaced.videos };
}

/** The voice the user's Update gives all of a video's narration. Kept in canvas.json with the
 *  voice the narration has now, so it stands only until the narration has another; only a voice
 *  the speech services offer can be picked (decided 2026-11-11). */
async function applyVoiceChoice(
  edit: Extract<VideoCanvasEdit, { kind: 'set_voice' }>,
  productionAbs: string,
  ledger: readonly VideoAssetRecord[],
): Promise<VideoCanvasEditResult> {
  const videoDirAbs = videoDirIn(productionAbs, edit.video);
  const manifest = videoDirAbs ? await readManifest(videoDirAbs) : null;
  if (!videoDirAbs || !manifest) return { ok: false, code: 'not_found' };
  const current = videoVoice(manifest, new Map(ledger.map((row) => [row.id, row])));
  const picked = voiceOf(edit);
  if (!current || !picked) return { ok: false, code: 'invalid' };
  let name = '';
  try {
    const { listTtsCapabilities } = await import('./tts_capabilities');
    const route = (await listTtsCapabilities()).find((item) => item.routeRef === picked.route_ref);
    name = route?.voices.find((item) => item.voiceRef === picked.voice_ref)?.displayName ?? '';
  } catch (err) {
    log.warn('voice catalog not read', { error: logErrorSummary(err) });
    return { ok: false, code: 'failed' };
  }
  if (!name) return { ok: false, code: 'not_found' };
  const video = String(edit.video);
  await fileEditLock(path.join(productionAbs, LAYOUT_FILE)).runExclusive(async () => {
    const canvas = await readCanvasFile(productionAbs);
    if (sameVoice(picked, current)) delete canvas.voices[video];
    else canvas.voices[video] = { ...picked, name: name.slice(0, MAX_VOICE_REF_CHARS), from: current };
    await writeCanvasFile(productionAbs, canvas);
  });
  return { ok: true, changed_videos: [video] };
}

/** The voices a video's narration can take: those that speak its language, from every speech
 *  service set up here, and the voice it has. Asked once a conversation, when the canvas first
 *  shows the video's voice, since the list can come from the Orkas server. */
export async function readVideoCanvasVoices(uid: string, cid: string, dir: unknown, video: unknown): Promise<
  { ok: true; current: VideoCanvasVoice | null; voices: Array<VideoCanvasVoice & { route_name: string; name: string }> } | VideoCanvasRefusal
> {
  const located = await locateProduction(uid, cid, dir);
  const videoDirAbs = located ? videoDirIn(located.productionAbs, video) : null;
  const manifest = videoDirAbs ? await readManifest(videoDirAbs) : null;
  if (!located || !manifest) return { ok: false, code: 'not_found' };
  const rowOf = new Map((await readProductionLedger(located.productionAbs) ?? []).map((row) => [row.id, row]));
  const language = narrationLanguage(manifest, rowOf);
  try {
    const { listTtsCapabilities, listableTtsVoices, publicTtsCapabilities } = await import('./tts_capabilities');
    const routes = publicTtsCapabilities(await listTtsCapabilities());
    return {
      ok: true,
      current: videoVoice(manifest, rowOf),
      voices: routes.flatMap((route) => listableTtsVoices(route.voices, { language, limit: Number.POSITIVE_INFINITY }).voices
        .map((item) => ({ route_ref: route.routeRef, route_name: route.displayName, voice_ref: item.voiceRef, name: item.displayName }))),
    };
  } catch (err) {
    log.warn('voice catalog not read', { error: logErrorSummary(err) });
    return { ok: false, code: 'failed' };
  }
}

/** One change a user made on the canvas. The Agent owns these files while it works, so
 *  nothing is written then. */
export async function applyVideoCanvasEdit(input: {
  uid: string;
  cid: string;
  dir: unknown;
  busy: boolean;
  edit: VideoCanvasEdit;
}): Promise<VideoCanvasEditResult> {
  if (input.busy) return { ok: false, code: 'busy' };
  const located = await locateProduction(input.uid, input.cid, input.dir);
  if (!located) return { ok: false, code: 'not_found' };
  const { productionAbs } = located;
  const ledger = await readProductionLedger(productionAbs);
  if (!ledger) return { ok: false, code: 'unreadable' };
  const { edit } = input;
  switch (edit?.kind) {
    case 'set_text':
    case 'reorder':
    case 'remove_scene':
    case 'restore_scene':
    case 'set_narration':
    case 'add_scene':
    case 'swap_clip':
      return applyTimelineEdit(edit, productionAbs, ledger, await readProduct(productionAbs));
    case 'set_voice':
      return applyVoiceChoice(edit, productionAbs, ledger);
    case 'set_fact':
      return applyFactEdit(edit, productionAbs);
    case 'remove_asset':
    case 'replace_asset':
      return applyAssetEdit(edit, productionAbs, ledger, await readProduct(productionAbs));
    case 'use_result':
      return applyUseResult(edit, productionAbs, ledger, await readProduct(productionAbs));
    default:
      return { ok: false, code: 'invalid' };
  }
}

export type VideoCanvasImport =
  | { name: string; ok: true; asset_id: string }
  | { name: string; ok: false; reason: 'unsupported' | 'failed' };

/** Files dropped on the canvas, added to the production's ledger. */
export async function importVideoCanvasFiles(input: {
  uid: string;
  cid: string;
  dir: unknown;
  busy: boolean;
  entries: ReadonlyArray<{ path: string; name: string }>;
}): Promise<{ ok: true; files: VideoCanvasImport[] } | VideoCanvasRefusal> {
  if (input.busy) return { ok: false, code: 'busy' };
  const located = await locateProduction(input.uid, input.cid, input.dir);
  if (!located) return { ok: false, code: 'not_found' };
  if (await readProductionLedger(located.productionAbs) === null) return { ok: false, code: 'unreadable' };
  const files: VideoCanvasImport[] = [];
  for (const entry of input.entries.slice(0, MAX_IMPORTED_FILES)) {
    const name = path.basename(entry.name);
    try {
      const imported = await importProductionFile({ productionDirAbs: located.productionAbs, sourceAbs: entry.path, name });
      files.push(imported ? { name, ok: true, asset_id: imported.asset_id } : { name, ok: false, reason: 'unsupported' });
    } catch (err) {
      log.warn('canvas file import failed', { error: logErrorSummary(err) });
      files.push({ name, ok: false, reason: 'failed' });
    }
  }
  return { ok: true, files };
}
