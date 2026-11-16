/**
 * One-way upgrade of productions the old flow made (a signed plan, gate records and
 * compositions) into timeline productions. This is the only code that still reads
 * those formats. It is deterministic, costs nothing, and never writes to the old
 * folders: pages are copied, and media stays where it is and is referred to.
 *
 * An old page animates one timeline on absolute time, which the renderer's per-scene
 * model cannot express, so an upgraded video records where each scene starts on it
 * (`absolute_page`). Scenes can still be reordered without re-rendering. What cannot
 * be carried over is written to `upgrade-notes.md` beside the video.
 */
import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { createLogger } from '../logger';
import { userLocalRoot } from '../paths';
import { writeBytesAtomic } from '../storage';
import { bundledFfmpegPaths } from '../util/bundled-runtime';
import { fileEditLock } from '../util/locks';
import { isPathAllowed } from '../util/path-sandbox';
import { logErrorSummary } from '../util/log-redact';
import { probeMedia } from './video_studio';
import { recordExistingVersion } from './video_timeline_ship';
import { VideoAssetLedgerSchema, VideoManifestV3Schema, type VideoAssetRecord, type VideoManifestV3 } from './video_timeline';

const log = createLogger('video-project-upgrade');

const MAX_GATE_RECORDS = 2000;
const MAX_WORKSPACE_CHILDREN = 200;
const MAX_COMPOSITIONS_PER_PROJECT = 64;
const NOTES_FILE = 'upgrade-notes.md';
const ROOT_TIMELINE_KEYS = ['main', 'root'];
/** Left in the old folder: previews, QA evidence and the old flow's own records. */
const UNCOPIED_DIRS = new Set(['qa', 'preview', 'preview-frames', 'snapshots', 'snapshot-frames', 'render', 'project', 'node_modules']);
const UNCOPIED_FILE = /\.(?:json|md|srt)$/i;
const IMAGE_FILE = /\.(?:jpe?g|png|webp|gif|bmp|avif)$/i;
const VIDEO_FILE = /\.(?:mp4|mov|webm|m4v)$/i;
const OLD_SEGMENT_SOURCES = new Set(['compose', 'edit', 'generate', 'provided']);

/** A plan whose segments were never made: nothing to carry over, and nothing wrong. */
class NothingProducedError extends Error {}

const upgradedWorkspaces = new Set<string>();

export type UpgradeResult = {
  /** The production folder, relative to the workspace ('.' when it is the workspace). */
  production_dir: string;
  videos: string[];
  status: 'upgraded' | 'failed';
  reason?: string;
};

type OldProduction = {
  rootAbs: string;
  planAbs?: string;
  compositionDirs: Set<string>;
  /** Gate records by composition folder, for its title and draft. */
  states: Map<string, OldGateState>;
};

type OldGateState = {
  composition_dir?: string;
  task_title?: string;
  draft?: { path?: string };
};

type OldComposition = {
  composition: { id: string; width: number; height: number; fps: number; language?: string; caption_mode?: string };
  scenes: Array<{ id: string; start: number; duration: number; narration_text?: string }>;
  audio: { tracks: Array<{ id: string; kind: 'narration' | 'music' | 'sfx'; src: string; start: number; volume: number }> };
  art_direction?: Record<string, unknown>;
};

type OldPlanSegment = {
  id?: unknown;
  order?: unknown;
  layer?: unknown;
  source?: unknown;
  role?: unknown;
  target_sec?: unknown;
  produced_path?: unknown;
  spec?: { prompt?: unknown; composition_dir?: unknown; composition_plan?: unknown };
};

type OldPlan = {
  aspect?: unknown;
  language?: unknown;
  segments?: OldPlanSegment[];
  tracks?: {
    narration?: { segments?: Array<{ text?: unknown; segment_id?: unknown; produced_path?: unknown; start_sec?: unknown }>; produced_path?: unknown } | null;
    music?: { produced_path?: unknown; path?: unknown } | null;
    captions?: unknown;
  };
  _runtime?: { render?: { final_path?: unknown } };
};

const isFile = (absPath: string): Promise<boolean> => fs.stat(absPath).then((st) => st.isFile(), () => false);
const isDirectory = (absPath: string): Promise<boolean> => fs.stat(absPath).then((st) => st.isDirectory(), () => false);

function isInside(parentAbs: string, childAbs: string): boolean {
  const relative = path.relative(parentAbs, childAbs);
  return (relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative)))
    && isPathAllowed(childAbs, [parentAbs]);
}

function requireInside(rootAbs: string, ...files: string[]): void {
  for (const file of files) if (!isInside(rootAbs, file)) {
    throw new Error(`Resource reference escapes the composition directory: ${portable(rootAbs, file)}`);
  }
}

function portable(fromAbs: string, toAbs: string): string {
  return path.relative(fromAbs, toAbs).split(path.sep).join('/') || '.';
}

/** Ids in a manifest take letters, numbers, hyphens and underscores. */
function safeId(raw: unknown, fallback: string): string {
  const cleaned = String(raw ?? '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return /^[A-Za-z0-9]/.test(cleaned) ? cleaned : fallback;
}

function uniqueId(base: string, taken: Set<string>): string {
  let id = base;
  for (let suffix = 2; taken.has(id); suffix += 1) id = `${base}-${suffix}`;
  taken.add(id);
  return id;
}

/** The folder a composition's production lives in: the parent of its `project/`. */
function productionRootOf(compositionDirAbs: string): string {
  const parts = compositionDirAbs.split(path.sep);
  const at = parts.lastIndexOf('project');
  return at > 0 ? parts.slice(0, at).join(path.sep) || path.sep : path.dirname(compositionDirAbs);
}

async function readJsonObject(absPath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(absPath, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** A file named plan.json can be anything, so its segments have to say what made them. */
function looksLikeOldPlan(plan: Record<string, unknown> | null): boolean {
  return Array.isArray(plan?.segments)
    && (plan.segments as Array<{ source?: unknown }>).some((segment) => OLD_SEGMENT_SOURCES.has(String(segment?.source)));
}

async function addProjectFolder(found: Map<string, OldProduction>, rootAbs: string): Promise<void> {
  const project = path.join(rootAbs, 'project');
  if (!isInside(rootAbs, project) || !await isDirectory(project)) return;
  const planAbs = path.join(project, 'plan.json');
  const hasPlan = isInside(rootAbs, planAbs) && looksLikeOldPlan(await readJsonObject(planAbs));
  const dirs: string[] = [];
  if (isInside(rootAbs, path.join(project, 'composition', 'composition-manifest.json')) && await isFile(path.join(project, 'composition', 'composition-manifest.json'))) dirs.push(path.join(project, 'composition'));
  const children = isInside(rootAbs, path.join(project, 'compositions'))
    ? await fs.readdir(path.join(project, 'compositions'), { withFileTypes: true }).catch(() => []) : [];
  for (const child of children.filter((entry) => entry.isDirectory()).slice(0, MAX_COMPOSITIONS_PER_PROJECT)) {
    const dir = path.join(project, 'compositions', child.name);
    if (isInside(rootAbs, path.join(dir, 'composition-manifest.json')) && await isFile(path.join(dir, 'composition-manifest.json'))) dirs.push(dir);
  }
  if (!hasPlan && !dirs.length) return;
  const entry: OldProduction = found.get(rootAbs) ?? { rootAbs, compositionDirs: new Set<string>(), states: new Map() };
  if (hasPlan) entry.planAbs = planAbs;
  for (const dir of dirs) entry.compositionDirs.add(dir);
  found.set(rootAbs, entry);
}

/** Old productions in this workspace: named by a gate record, or found in a `project/`
 *  folder at the workspace or one level down, since gate records are per machine. */
export async function discoverOldProductions(input: { userId: string; workspaceAbs: string; gateRecordsOnly?: boolean }): Promise<OldProduction[]> {
  const workspaceAbs = path.resolve(input.workspaceAbs);
  const found = new Map<string, OldProduction>();
  if (!input.gateRecordsOnly) {
    await addProjectFolder(found, workspaceAbs);
    const children = await fs.readdir(workspaceAbs, { withFileTypes: true }).catch(() => []);
    for (const child of children.filter((entry) => entry.isDirectory()).slice(0, MAX_WORKSPACE_CHILDREN)) {
      await addProjectFolder(found, path.join(workspaceAbs, child.name));
    }
  }
  const gatesDir = path.join(userLocalRoot(input.userId), 'video_studio', 'gates');
  const gates = await fs.readdir(gatesDir, { withFileTypes: true }).catch(() => []);
  for (const gate of gates.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).slice(0, MAX_GATE_RECORDS)) {
    const state = await readJsonObject(path.join(gatesDir, gate.name)) as OldGateState | null;
    const dir = typeof state?.composition_dir === 'string' ? path.resolve(state.composition_dir) : '';
    if (!dir || !isInside(workspaceAbs, dir)) continue;
    if (!isInside(workspaceAbs, path.join(dir, 'composition-manifest.json')) || !await isFile(path.join(dir, 'composition-manifest.json'))) continue;
    const rootAbs = productionRootOf(dir);
    if (!isInside(workspaceAbs, rootAbs)) continue;
    await addProjectFolder(found, rootAbs);
    const entry: OldProduction = found.get(rootAbs) ?? { rootAbs, compositionDirs: new Set<string>(), states: new Map() };
    entry.compositionDirs.add(dir);
    entry.states.set(dir, state as OldGateState);
    found.set(rootAbs, entry);
  }
  return [...found.values()];
}

/** Bring an old page in line with what the renderer accepts, without touching its look.
 *  Sound moves to tracks. Footage becomes a clip when its timing is complete; otherwise
 *  it stays, and the check refuses it with the fix named. */
export function upgradePageMarkup(input: {
  html: string;
  scenes: Array<{ id: string; start: number; duration: number }>;
  takeVideo: (video: { src: string; sceneId: string; inSec: number; durSec: number; atSec: number }) => string;
}): { html: string; unconverted: number } {
  let unconverted = 0;
  const withoutAudio = input.html.replace(/<audio\b[^>]*?(?:\/>|>[\s\S]*?<\/audio>)/gi, '');
  const html = withoutAudio.replace(/<video\b([^>]*?)(?:\/>|>[\s\S]*?<\/video>)/gi, (whole, attributes: string) => {
    const attr = (name: string) => new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(attributes);
    const value = (name: string) => { const match = attr(name); return match ? (match[1] ?? match[2] ?? '') : ''; };
    const src = value('src');
    const start = Number(value('data-start'));
    const duration = Number(value('data-duration'));
    const scene = input.scenes.find((item) => start >= item.start && start < item.start + item.duration);
    if (!src || !(duration > 0) || !Number.isFinite(start) || !scene) {
      unconverted += 1;
      return whole;
    }
    const clipId = input.takeVideo({
      src,
      sceneId: scene.id,
      inSec: Number(value('data-media-start')) || 0,
      durSec: duration,
      atSec: start - scene.start,
    });
    const kept = attributes
      .replace(/\s(?:src|data-start|data-duration|data-media-start|data-track-index|muted|autoplay|loop|playsinline|preload|controls)(?:\s*=\s*(?:"[^"]*"|'[^']*'))?/gi, '');
    return `<img data-clip="${clipId}"${kept} alt="">`;
  });
  return { html, unconverted };
}

/** The key the old page registered its one timeline under, or null for a page with none. */
export function oldPageTimelineKey(html: string, compositionId: string): string | null {
  const keys = [compositionId, ...ROOT_TIMELINE_KEYS];
  for (const key of keys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`__timelines\\s*(?:\\[\\s*["'\`]${escaped}["'\`]\\s*\\]|\\.${escaped}\\b)`).test(html)) return key;
  }
  return null;
}

/** The newest video in a folder, for a delivered file no record names. */
async function newestVideoIn(dirAbs: string, rootAbs: string): Promise<string | null> {
  requireInside(rootAbs, dirAbs);
  const entries = await fs.readdir(dirAbs, { withFileTypes: true }).catch(() => []);
  const videos = await Promise.all(entries
    .filter((entry) => entry.isFile() && VIDEO_FILE.test(entry.name))
    .map(async (entry) => {
      const abs = path.join(dirAbs, entry.name);
      return { abs, modified: await fs.stat(abs).then((st) => st.mtimeMs, () => 0) };
    }));
  return videos.sort((a, b) => b.modified - a.modified)[0]?.abs ?? null;
}

async function mediaDuration(fileAbs: string, signal?: AbortSignal): Promise<number | null> {
  const { ffprobe } = bundledFfmpegPaths();
  if (!ffprobe) return null;
  const probe = await probeMedia(ffprobe, fileAbs, signal).catch(() => null);
  // The picture's own length: a container also counts a longer audio stream.
  return probe?.video?.duration_seconds ?? probe?.duration_seconds ?? null;
}

type NewVideo = {
  videoId: string;
  manifest: VideoManifestV3;
  assets: VideoAssetRecord[];
  notes: string[];
  /** A file already delivered, to list as this video's first version. */
  deliveredAbs?: string;
  /** Written into the video folder after the copy. */
  html?: string;
  copyFromAbs?: string;
};

function asNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Read only what the upgrade uses. Old manifests carry fields of their day, and a
 *  signature or a stray key is no reason to leave a project behind. */
function readOldComposition(raw: unknown): OldComposition {
  const value = (raw ?? {}) as { composition?: Record<string, unknown>; scenes?: unknown; audio?: { tracks?: unknown }; art_direction?: unknown };
  const composition = value.composition ?? {};
  const positive = (field: string) => {
    const parsed = Number(composition[field]);
    if (!(parsed > 0)) throw new Error(`composition.${field} is missing`);
    return parsed;
  };
  const scenes = (Array.isArray(value.scenes) ? value.scenes : []).map((scene: Record<string, unknown>) => {
    const duration = Number(scene.duration);
    if (typeof scene.id !== 'string' || !scene.id || !(duration > 0)) throw new Error('a scene has no id or length');
    return {
      id: scene.id,
      start: Math.max(0, Number(scene.start) || 0),
      duration,
      ...(typeof scene.narration_text === 'string' && scene.narration_text.trim() ? { narration_text: scene.narration_text.trim() } : {}),
    };
  });
  if (!scenes.length) throw new Error('it has no scenes');
  const tracks = (Array.isArray(value.audio?.tracks) ? value.audio.tracks : []).flatMap((track: Record<string, unknown>) => (
    typeof track.src === 'string' && track.src && (track.kind === 'narration' || track.kind === 'music' || track.kind === 'sfx')
      ? [{ id: String(track.id ?? track.kind), kind: track.kind as 'narration' | 'music' | 'sfx', src: track.src, start: Number(track.start) || 0, volume: Number.isFinite(Number(track.volume)) ? Number(track.volume) : 1 }]
      : []
  ));
  return {
    composition: {
      id: String(composition.id || 'main'),
      width: positive('width'),
      height: positive('height'),
      fps: positive('fps'),
      ...(typeof composition.language === 'string' && composition.language ? { language: composition.language } : {}),
      ...(typeof composition.caption_mode === 'string' && composition.caption_mode ? { caption_mode: composition.caption_mode } : {}),
    },
    scenes,
    audio: { tracks },
    ...(value.art_direction && typeof value.art_direction === 'object' ? { art_direction: value.art_direction as Record<string, unknown> } : {}),
  };
}

async function upgradeComposition(input: {
  rootAbs: string;
  compositionDirAbs: string;
  state?: OldGateState;
  videoId: string;
  takenAssets: Set<string>;
  /** The production's only composition, so its render folder is this video's. */
  onlyComposition: boolean;
}): Promise<NewVideo> {
  const { rootAbs, compositionDirAbs, videoId } = input;
  requireInside(rootAbs, compositionDirAbs, ...['composition-manifest.json', 'index.html'].map(name => path.join(compositionDirAbs, name)));
  const old = readOldComposition(JSON.parse(await fs.readFile(path.join(compositionDirAbs, 'composition-manifest.json'), 'utf8')));
  const notes: string[] = [];
  const assets: VideoAssetRecord[] = [];
  const videoRel = `videos/${videoId}`;
  const clipsByScene = new Map<string, NonNullable<VideoManifestV3['scenes'][number]['clips']>>();

  const rawHtml = await fs.readFile(path.join(compositionDirAbs, 'index.html'), 'utf8').catch(() => null);
  const page = rawHtml === null ? null : upgradePageMarkup({
    html: rawHtml,
    scenes: old.scenes,
    takeVideo: ({ src, sceneId, inSec, durSec, atSec }) => {
      const clipId = uniqueId(`footage-${sceneId}`, input.takenAssets);
      assets.push({ id: clipId, kind: 'video', label: path.basename(src), path: `${videoRel}/${src.replace(/^\.\//, '')}`, origin: 'upload' });
      const clips = clipsByScene.get(sceneId) ?? [];
      // Placed with "at", so the scene keeps the length the page was timed to.
      clips.push({ id: clipId, asset: clipId, in: inSec, dur: durSec, at: atSec });
      clipsByScene.set(sceneId, clips);
      return clipId;
    },
  });
  if (rawHtml === null) notes.push('The old composition had no page, so this video has no words or motion yet. Write index.html with a section for each scene.');
  const missingSections = rawHtml === null ? [] : old.scenes.filter((scene) => !rawHtml.includes(`data-scene-id="${scene.id}"`));
  if (missingSections.length) {
    notes.push(`The page has no section for ${missingSections.map((scene) => `"${scene.id}"`).join(', ')}. Add them before rendering.`);
  }
  if (page?.unconverted) {
    notes.push(`The page still has ${page.unconverted} <video> element(s) with incomplete timing. The check will refuse them: replace each with <img data-clip> and a clip.`);
  }
  if (page) {
    notes.push('This page keeps its one timeline through `absolute_page` in manifest.json, so it renders as it is. To reorder scenes, change their order in manifest.json; leave `absolute_page` and the page alone.');
    notes.push('The words on this page are written into the HTML, so changing one means editing index.html. If you rewrite a scene, move its words to data-slot and its motion to its own timeline.');
  }

  const tracks: NonNullable<VideoManifestV3['tracks']> = [];
  for (const track of old.audio.tracks) {
    const assetId = uniqueId(`track-${safeId(track.id, 'audio')}`, input.takenAssets);
    if (track.start > 0) {
      notes.push(`The ${track.kind} track "${track.id}" started at ${track.start}s. Tracks now play from 0s, so it was not carried over; its file is ${portable(rootAbs, path.join(compositionDirAbs, track.src))}.`);
      continue;
    }
    assets.push({ id: assetId, kind: 'audio', label: track.id, path: `${videoRel}/${track.src.replace(/^\.\//, '')}`, origin: 'edited' });
    tracks.push({ kind: track.kind, asset: assetId, volume: track.volume });
  }
  if (tracks.some((track) => track.kind === 'narration')) {
    notes.push('Narration is one track across the whole video. Before reordering scenes, generate it again scene by scene.');
  }

  const timelineKey = page ? oldPageTimelineKey(page.html, old.composition.id) : null;
  const manifest: VideoManifestV3 = VideoManifestV3Schema.parse({
    schema_version: 3,
    id: videoId,
    label: input.state?.task_title || old.composition.id,
    canvas: {
      width: old.composition.width,
      height: old.composition.height,
      fps: old.composition.fps,
      ...(old.composition.language ? { language: old.composition.language } : {}),
    },
    scenes: old.scenes.map((scene) => {
      const clips = clipsByScene.get(scene.id);
      return {
        id: scene.id,
        duration: scene.duration,
        ...(clips ? { clips } : {}),
        ...(scene.narration_text ? { narration: { text: scene.narration_text } } : {}),
      };
    }),
    ...(tracks.length ? { tracks } : {}),
    ...(old.composition.caption_mode ? { captions: { enabled: true } } : {}),
    ...(old.art_direction ? { art_direction: old.art_direction } : {}),
    upgraded_from: portable(rootAbs, compositionDirAbs),
    ...(page ? {
      absolute_page: {
        ...(timelineKey ? { timeline_key: timelineKey } : {}),
        scene_starts: Object.fromEntries(old.scenes.map((scene) => [scene.id, scene.start])),
      },
    } : {}),
  });

  const draftPath = input.state?.draft?.path;
  const recordedDraft = typeof draftPath === 'string' && draftPath
    ? (path.isAbsolute(draftPath) ? draftPath : path.resolve(compositionDirAbs, draftPath))
    : '';
  const delivered = recordedDraft && isInside(rootAbs, recordedDraft) && await isFile(recordedDraft)
    ? recordedDraft
    : await newestVideoIn(path.join(compositionDirAbs, 'render'), rootAbs) ?? (input.onlyComposition ? await newestVideoIn(path.join(rootAbs, 'project', 'render'), rootAbs) : null);
  return {
    videoId,
    manifest,
    assets,
    notes,
    ...(delivered ? { deliveredAbs: delivered } : {}),
    ...(page ? { html: page.html } : {}),
    copyFromAbs: compositionDirAbs,
  };
}

const CANVAS_BY_ASPECT: Record<string, { width: number; height: number }> = {
  '9:16': { width: 1080, height: 1920 },
  '16:9': { width: 1920, height: 1080 },
  '1:1': { width: 1080, height: 1080 },
  '4:5': { width: 1080, height: 1350 },
};

async function upgradePlan(input: {
  rootAbs: string;
  planAbs: string;
  videoId: string;
  takenAssets: Set<string>;
  signal?: AbortSignal;
}): Promise<NewVideo> {
  const { rootAbs, videoId } = input;
  requireInside(rootAbs, input.planAbs);
  const plan = JSON.parse(await fs.readFile(input.planAbs, 'utf8')) as OldPlan;
  const notes: string[] = [];
  const assets: VideoAssetRecord[] = [];
  const scenes: VideoManifestV3['scenes'] = [];
  const projectAbs = path.dirname(input.planAbs);
  const resolveProduced = async (raw: unknown): Promise<string | null> => {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) return null;
    const candidates = path.isAbsolute(value) ? [path.resolve(value)] : [path.resolve(rootAbs, value), path.resolve(projectAbs, value)];
    for (const candidate of candidates) {
      if (isInside(rootAbs, candidate) && await isFile(candidate)) return candidate;
    }
    return null;
  };
  /** The file a segment became: what the plan recorded, or where each kind of segment
   *  was written when a run skipped recording it. */
  const producedFile = async (segment: OldPlanSegment): Promise<string | null> => {
    const recorded = await resolveProduced(segment.produced_path);
    if (recorded) return recorded;
    const id = String(segment.id ?? '');
    if (!id) return null;
    for (const folder of ['cuts', 'parts']) {
      for (const ext of ['mp4', 'mov', 'webm', 'm4v']) {
        const candidate = path.join(projectAbs, folder, `${id}.${ext}`);
        if (isInside(rootAbs, candidate) && await isFile(candidate)) return candidate;
      }
    }
    return segment.source === 'compose'
      ? newestVideoIn(typeof segment.spec?.composition_dir === 'string'
        ? path.join(path.resolve(rootAbs, segment.spec.composition_dir), 'render')
        : path.join(projectAbs, 'compositions', id, 'render'), rootAbs)
      : null;
  };
  const segments = (Array.isArray(plan.segments) ? plan.segments : [])
    .map((segment, index) => ({ segment, index }))
    .sort((a, b) => (asNumber(a.segment.order) ?? a.index) - (asNumber(b.segment.order) ?? b.index));
  const takenScenes = new Set<string>();
  let canvasFromFile: { width: number; height: number } | null = null;
  const { ffprobe } = bundledFfmpegPaths();
  for (const { segment, index } of segments) {
    const sceneId = uniqueId(safeId(segment.id, `segment-${index + 1}`), takenScenes);
    if (segment.layer === 'overlay') {
      notes.push(`Overlay segment "${sceneId}" was not carried over: overlays are now part of a scene's page.`);
      continue;
    }
    const produced = await producedFile(segment);
    if (!produced || !isInside(rootAbs, produced)) {
      notes.push(`Segment "${sceneId}" was never produced, so it is not in this video. Its description is in ${portable(rootAbs, input.planAbs)}.`);
      continue;
    }
    const isImage = IMAGE_FILE.test(produced);
    const measured = isImage ? asNumber(segment.target_sec) : await mediaDuration(produced, input.signal);
    // A stop is not a bad file: dropping this segment would pass for finished work.
    input.signal?.throwIfAborted();
    if (!(measured && measured > 0)) {
      notes.push(`Segment "${sceneId}" could not be measured, so it is not in this video. Its file is ${portable(rootAbs, produced)}.`);
      continue;
    }
    const source = String(segment.source ?? '');
    const assetId = uniqueId(`segment-${sceneId}`, input.takenAssets);
    assets.push({
      id: assetId,
      kind: isImage ? 'image' : 'video',
      label: String(segment.role ?? sceneId),
      path: portable(rootAbs, produced),
      origin: source === 'generate' ? 'generated' : source === 'edit' ? 'edited' : 'page',
      ...(typeof segment.spec?.prompt === 'string' && segment.spec.prompt ? { prompt: segment.spec.prompt } : {}),
    });
    scenes.push({ id: sceneId, clips: [{ id: `${sceneId}-clip`, asset: assetId, in: 0, dur: measured }] });
    if (source === 'compose') {
      const dir = typeof segment.spec?.composition_dir === 'string' ? segment.spec.composition_dir : `project/compositions/${String(segment.id ?? sceneId)}`;
      notes.push(`Scene "${sceneId}" is the rendered video of its old page, so changing its words means making it again. The old page is at ${dir}/index.html.`);
    }
    if (!canvasFromFile && !isImage && ffprobe) {
      const probe = await probeMedia(ffprobe, produced, input.signal).catch(() => null);
      if (probe?.video?.width && probe.video.height) canvasFromFile = { width: probe.video.width, height: probe.video.height };
    }
  }
  if (!scenes.length) throw new NothingProducedError();

  const narration = plan.tracks?.narration;
  const tracks: NonNullable<VideoManifestV3['tracks']> = [];
  if (narration) {
    const whole = await resolveProduced(narration.produced_path);
    if (whole) {
      const assetId = uniqueId('track-narration', input.takenAssets);
      assets.push({ id: assetId, kind: 'audio', label: 'Narration', path: portable(rootAbs, whole), origin: 'edited' });
      tracks.push({ kind: 'narration', asset: assetId, volume: 1 });
      notes.push('Narration is one track across the whole video. Before reordering scenes, generate it again scene by scene.');
    } else if (narration.segments?.length) {
      notes.push(`The ${narration.segments.length} narration line(s) in ${portable(rootAbs, input.planAbs)} were not carried over. Generate them again scene by scene.`);
    }
  }
  const musicAbs = await resolveProduced(plan.tracks?.music?.produced_path ?? plan.tracks?.music?.path);
  if (musicAbs) {
    const assetId = uniqueId('track-music', input.takenAssets);
    assets.push({ id: assetId, kind: 'audio', label: 'Music', path: portable(rootAbs, musicAbs), origin: 'edited' });
    tracks.push({ kind: 'music', asset: assetId, volume: 0.3 });
  }
  if (plan.tracks?.captions) notes.push('Captions from the old plan were not carried over. Turn them on from scene narration, or burn them with burnsubs.');

  const finalAbs = await resolveProduced(plan._runtime?.render?.final_path) ?? await newestVideoIn(path.join(projectAbs, 'render'), rootAbs);
  const aspect = typeof plan.aspect === 'string' ? CANVAS_BY_ASPECT[plan.aspect] : undefined;
  const manifest = VideoManifestV3Schema.parse({
    schema_version: 3,
    id: videoId,
    label: 'Upgraded video',
    canvas: {
      ...(aspect ?? canvasFromFile ?? CANVAS_BY_ASPECT['9:16']),
      fps: 30,
      ...(typeof plan.language === 'string' && plan.language ? { language: plan.language } : {}),
    },
    scenes,
    ...(tracks.length ? { tracks } : {}),
    upgraded_from: portable(rootAbs, input.planAbs),
  });
  return { videoId, manifest, assets, notes, ...(finalAbs ? { deliveredAbs: finalAbs } : {}) };
}

/** Preserve uncertain legacy requests as notes. Public providers do not promise free replay. */
async function pendingPaidRequests(input: { userId: string; rootAbs: string }): Promise<string[]> {
  const dir = path.join(userLocalRoot(input.userId), 'video_studio', 'production');
  const files = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const lines: string[] = [];
  for (const file of files.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).slice(0, MAX_GATE_RECORDS)) {
    const ledger = await readJsonObject(path.join(dir, file.name));
    if (typeof ledger?.plan_path !== 'string' || !isInside(input.rootAbs, path.resolve(ledger.plan_path))) continue;
    const transactions = ledger.transactions;
    if (!transactions || typeof transactions !== 'object') continue;
    for (const entry of Object.values(transactions as Record<string, { status?: unknown; output_path?: unknown; segment_id?: unknown; started_at?: unknown }>)) {
      if (entry?.status === 'pending' && typeof entry.output_path === 'string') {
        lines.push(`A request for segment "${String(entry.segment_id ?? '')}" never finished (${entry.output_path}). Check the selected service before requesting it again; it may have charged already.`);
      }
    }
  }
  return lines;
}

async function copyVideoFolder(fromAbs: string, toAbs: string): Promise<void> {
  await fs.mkdir(toAbs, { recursive: true });
  const entries = await fs.readdir(fromAbs, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory() ? UNCOPIED_DIRS.has(entry.name) : UNCOPIED_FILE.test(entry.name)) continue;
    await fs.cp(path.join(fromAbs, entry.name), path.join(toAbs, entry.name), { recursive: true, mode: fsConstants.COPYFILE_FICLONE, verbatimSymlinks: true });
  }
}

/** A production's root is often the workspace itself, so an assets.json there can be
 *  anything. Writing rows over it would lose it, so it stops the upgrade instead. */
async function readLedger(rootAbs: string): Promise<VideoAssetRecord[]> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(rootAbs, 'assets.json'), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  try {
    return VideoAssetLedgerSchema.parse(JSON.parse(raw)).assets;
  } catch {
    throw new Error(`assets.json in ${path.basename(rootAbs)} is not a list of production files, so it was left alone and this old production was not upgraded.`);
  }
}

async function existingVideos(rootAbs: string): Promise<Map<string, { upgradedFrom?: string }>> {
  const out = new Map<string, { upgradedFrom?: string }>();
  const entries = await fs.readdir(path.join(rootAbs, 'videos'), { withFileTypes: true }).catch(() => []);
  for (const entry of entries.filter((item) => item.isDirectory() && !item.name.startsWith('.'))) {
    const file = path.join(rootAbs, 'videos', entry.name, 'manifest.json');
    requireInside(rootAbs, file);
    const manifest = await readJsonObject(file);
    out.set(entry.name, typeof manifest?.upgraded_from === 'string' ? { upgradedFrom: manifest.upgraded_from } : {});
  }
  return out;
}

/** Everything the video folder holds, beside where it will go. */
async function buildVideo(rootAbs: string, video: NewVideo): Promise<string> {
  const buildAbs = path.join(rootAbs, 'videos', `.upgrading-${video.videoId}`);
  requireInside(rootAbs, buildAbs, path.join(rootAbs, 'videos', video.videoId));
  await fs.rm(buildAbs, { recursive: true, force: true });
  if (video.copyFromAbs) await copyVideoFolder(video.copyFromAbs, buildAbs);
  else await fs.mkdir(buildAbs, { recursive: true });
  requireInside(rootAbs, ...['index.html', NOTES_FILE, 'manifest.json'].map(name => path.join(buildAbs, name)));
  if (video.html !== undefined) await fs.writeFile(path.join(buildAbs, 'index.html'), video.html, 'utf8');
  if (video.notes.length) {
    await fs.writeFile(path.join(buildAbs, NOTES_FILE), `# Upgrade notes\n\nThis video came from the old production flow.\n\n${video.notes.map((note) => `- ${note}`).join('\n')}\n`, 'utf8');
  }
  await fs.writeFile(path.join(buildAbs, 'manifest.json'), `${JSON.stringify(video.manifest, null, 2)}\n`, 'utf8');
  return buildAbs;
}

async function upgradeOne(input: { userId: string; production: OldProduction; workspaceAbs: string; signal?: AbortSignal }): Promise<UpgradeResult | null> {
  const { production, workspaceAbs } = input;
  const { rootAbs } = production;
  const productionDir = portable(workspaceAbs, rootAbs);
  requireInside(workspaceAbs, rootAbs);
  return fileEditLock(path.join(rootAbs, 'assets.json')).runExclusive(async (): Promise<UpgradeResult | null> => {
    requireInside(rootAbs, ...['assets.json', 'videos', 'versions', 'versions.json'].map(name => path.join(rootAbs, name)));
    const existing = await existingVideos(rootAbs);
    const already = new Set([...existing.values()].flatMap((video) => (video.upgradedFrom ? [video.upgradedFrom] : [])));
    const ledger = await readLedger(rootAbs);
    const takenAssets = new Set(ledger.map((asset) => asset.id));
    const takenVideos = new Set(existing.keys());
    const planRel = production.planAbs ? portable(rootAbs, production.planAbs) : '';
    const pending = await pendingPaidRequests({ userId: input.userId, rootAbs });
    const made: NewVideo[] = [];
    const failures: string[] = [];
    let planMadeNothing = false;
    if (production.planAbs && !already.has(planRel)) {
      const videoId = uniqueId('main', takenVideos);
      try {
        made.push(await upgradePlan({ rootAbs, planAbs: production.planAbs, videoId, takenAssets, ...(input.signal ? { signal: input.signal } : {}) }));
      } catch (err) {
        takenVideos.delete(videoId);
        if (err instanceof NothingProducedError) planMadeNothing = true;
        else failures.push(`${planRel}: ${(err as Error).message}`);
      }
    }
    // A plan's compositions are its rendered segments. Only with no plan, or one that
    // never produced anything, do they stand as videos of their own.
    const standalone = production.planAbs && !planMadeNothing ? [] : [...production.compositionDirs];
    for (const dir of standalone.sort()) {
      const rel = portable(rootAbs, dir);
      if (already.has(rel)) continue;
      try {
        const manifest = await readJsonObject(path.join(dir, 'composition-manifest.json'));
        const compositionId = (manifest?.composition as { id?: unknown } | undefined)?.id;
        const videoId = uniqueId(safeId(compositionId, 'main'), takenVideos);
        made.push(await upgradeComposition({
          rootAbs,
          compositionDirAbs: dir,
          ...(production.states.get(dir) ? { state: production.states.get(dir) as OldGateState } : {}),
          videoId,
          takenAssets,
          onlyComposition: standalone.length === 1,
        }));
      } catch (err) {
        failures.push(`${rel}: ${(err as Error).message}`);
      }
    }
    if (!made.length && !failures.length) return null;
    await fs.mkdir(path.join(rootAbs, 'videos'), { recursive: true });
    if (made.length && pending.length) made[0].notes.push(...pending);
    // A video in place reads as upgraded and is never looked at again, so it goes in last,
    // once its rows are written and every copy is done. A failure or a stop before that
    // leaves nothing a later pass would skip.
    const built: string[] = [];
    const published: NewVideo[] = [];
    const ledgerFile = path.join(rootAbs, 'assets.json');
    const originalLedger = await fs.readFile(ledgerFile).catch((err: NodeJS.ErrnoException) => { if (err.code === 'ENOENT') return null; throw err; });
    let ledgerWritten = false;
    try {
      for (const video of made) built.push(await buildVideo(rootAbs, video));
      input.signal?.throwIfAborted();
      const added = made.flatMap((video) => video.assets);
      if (added.length || (made.length && !ledger.length)) {
        await writeBytesAtomic(ledgerFile, Buffer.from(`${JSON.stringify({ assets: [...ledger, ...added] }, null, 2)}\n`));
        ledgerWritten = true;
      }
      for (const [index, video] of made.entries()) {
        await fs.rename(built[index], path.join(rootAbs, 'videos', video.videoId));
        published.push(video);
        if (!video.deliveredAbs) continue;
        await recordExistingVersion({ productionDirAbs: rootAbs, videoPathAbs: video.deliveredAbs, videoId: video.videoId, ...(input.signal ? { signal: input.signal } : {}) })
          .catch((err) => {
            input.signal?.throwIfAborted();
            log.warn('old final was not listed as a version', { error: logErrorSummary(err) });
          });
      }
    } catch (err) {
      // Keep rows of published videos; retry must not allocate fresh IDs for
      // unpublished rows left by a failed rename. The asset lock is still held.
      if (ledgerWritten) {
        if (published.length) await writeBytesAtomic(ledgerFile, Buffer.from(`${JSON.stringify({ assets: [...ledger, ...published.flatMap(video => video.assets)] }, null, 2)}\n`));
        else if (originalLedger) await writeBytesAtomic(ledgerFile, originalLedger);
        else await fs.unlink(ledgerFile);
      }
      const unfinished = made[built.length];
      const cleanup = [...built, ...(unfinished ? [path.join(rootAbs, 'videos', `.upgrading-${unfinished.videoId}`)] : [])];
      await Promise.all(cleanup.filter(file => isInside(rootAbs, file)).map(file => fs.rm(file, { recursive: true, force: true }).catch(() => {})));
      throw err;
    }
    if (failures.length) log.warn('old production partly upgraded', { failed: failures.length, upgraded: made.length });
    return {
      production_dir: productionDir,
      videos: made.map((video) => video.videoId),
      status: failures.length ? 'failed' : 'upgraded',
      ...(failures.length ? { reason: failures.join('; ').slice(0, 800) } : {}),
    };
  });
}

/** Upgrade every old production in a workspace. A failure stays with its production:
 *  its old files are untouched, and the next call tries again. */
export async function upgradeOldProductions(input: {
  userId: string;
  workspaceAbs: string;
  /** Only work a gate record on this machine proves VideoStudio made. */
  gateRecordsOnly?: boolean;
  signal?: AbortSignal;
}): Promise<UpgradeResult[]> {
  const workspaceAbs = path.resolve(input.workspaceAbs);
  const productions = await discoverOldProductions({ userId: input.userId, workspaceAbs, ...(input.gateRecordsOnly ? { gateRecordsOnly: true } : {}) });
  const results: UpgradeResult[] = [];
  for (const production of productions) {
    try {
      const result = await upgradeOne({ userId: input.userId, production, workspaceAbs, ...(input.signal ? { signal: input.signal } : {}) });
      if (result) results.push(result);
    } catch (err) {
      log.warn('old production upgrade failed', { error: logErrorSummary(err) });
      results.push({
        production_dir: portable(workspaceAbs, production.rootAbs),
        videos: [],
        status: 'failed',
        reason: String((err as Error).message || err).slice(0, 400),
      });
    }
  }
  return results;
}

/** Upgrade a workspace the first time anything looks at it. One pass reads every gate
 *  record, and a workspace grows no new ones once this flow is the only one. A failure
 *  is reported and tried again next time. */
export async function upgradeWorkspaceOnce(input: {
  userId: string;
  workspaceAbs: string;
  gateRecordsOnly?: boolean;
  signal?: AbortSignal;
}): Promise<UpgradeResult[]> {
  const key = `${input.userId}\0${path.resolve(input.workspaceAbs)}\0${input.gateRecordsOnly ? 'gates' : 'all'}`;
  if (upgradedWorkspaces.has(key)) return [];
  const results = await upgradeOldProductions(input);
  if (!results.some((result) => result.status === 'failed')) upgradedWorkspaces.add(key);
  return results;
}

/** What could not be carried over for a video, for whoever works on it next. */
export async function readUpgradeNotes(videoDirAbs: string): Promise<string | null> {
  if (!isPathAllowed(path.join(videoDirAbs, NOTES_FILE), [path.resolve(videoDirAbs, '../..')])) return null;
  return fs.readFile(path.join(videoDirAbs, NOTES_FILE), 'utf8').catch(() => null);
}
