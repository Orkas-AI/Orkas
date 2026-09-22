import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { userMarketplaceAgentDir, runtimeResourcesDir } from '../paths';
import { bundledNodeExecutable } from '../util/bundled-runtime';
import { isPathAllowed } from '../util/path-sandbox';
import { sha256OfFileStream } from '../util/sha256';
import { finalizeProducedFile } from './produced_output_hooks';
import { probeDeliveredVideo } from './video_studio_delivery';
import { runVideoProcessForTest } from './video_studio';
import {
  executeVideoProductionLocalEdit, videoProductionGenerationSources,
  type VideoProductionPlanIdentity, type VideoProductionControlStateV1,
} from './video_production_control';

export async function videoProductionFileMatches(userId: string, file: string, expected: string): Promise<boolean> {
  const actual = await sha256OfFileStream(file).catch(() => '');
  return !!actual && actual === expected;
}

export async function videoProductionArtifactBinding(input: {
  userId: string; identity: VideoProductionPlanIdentity; state: VideoProductionControlStateV1; file: string; outputHash?: string;
}): Promise<'generation' | 'local_edit' | null> {
  const hash = input.outputHash || await sha256OfFileStream(input.file).catch(() => '');
  if (!hash) return null;
  const matches = (expected: string | undefined) => !!expected && expected === hash;
  const local = input.state.local_outputs?.find((item) => item.plan_signature === input.identity.signature && matches(item.output_sha256));
  if (local) return 'local_edit';
  for (const record of videoProductionGenerationSources(input.identity, input.state)) {
    if (matches(record.output_sha256)) return 'generation';
  }
  return null;
}

function srtTime(seconds: number): string {
  const ms = Math.round(seconds * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}

export function videoProductionIsCaptionEdit(plan: Record<string, any>): boolean {
  const segments = plan.segments;
  const tracks = plan.tracks;
  return Array.isArray(segments) && segments.length === 1
    && segments[0]?.source === 'generate' && segments[0]?.layer === 'primary'
    && segments[0]?.spec?.media_kind === 'video'
    && Array.isArray(tracks?.captions?.lines) && tracks.captions.lines.length > 0
    && Object.entries(tracks).every(([key, value]) => key === 'captions' || !value || Object.keys(value).length === 0);
}

/** The first bound local-edit operation is a caption revision of one completed
 * generated clip. Other EDL assemblies retain their existing script path.
 * The codec engine remains in the updateable private skill, in a child process. */
export async function editVideoProductionCaptions(input: {
  statePath: string; planPath: string; userId: string; cid?: string; roots: readonly string[]; signal?: AbortSignal;
}) {
  return executeVideoProductionLocalEdit({
    statePath: input.statePath, planPath: input.planPath, signal: input.signal,
    matchesHash: (file, hash) => videoProductionFileMatches(input.userId, file, hash),
    execute: async (identity, state) => {
      const segments = identity.plan.segments as Array<Record<string, any>>;
      const tracks = identity.plan.tracks as Record<string, any>;
      const lines = tracks?.captions?.lines;
      if (!videoProductionIsCaptionEdit(identity.plan) || lines.length > 500) {
        throw new Error('E_VIDEO_PRODUCTION_EDIT_UNSUPPORTED: production.edit supports caption-only revisions of one completed generated clip; other edits use the existing EDL assembly path');
      }
      const candidates = videoProductionGenerationSources(identity, state).filter((item) => item.segment_id === segments[0].id);
      const source = candidates.find((item) => isPathAllowed(item.output_path, input.roots));
      const sourceHash = source ? await sha256OfFileStream(source.output_path).catch(() => '') : '';
      if (!source || !sourceHash || sourceHash !== source.output_sha256) {
        throw new Error('E_VIDEO_PRODUCTION_EDIT_SOURCE_UNVERIFIED: the completed source is missing or changed; restore its recorded bytes before editing');
      }
      const spec = await probeDeliveredVideo(source.output_path, input.signal);
      if (!spec?.durationSec) throw new Error('E_VIDEO_PRODUCTION_EDIT_SOURCE_UNREADABLE');
      const subtitles = lines.map((line, index) => {
        if (typeof line.text !== 'string' || !line.text.trim() || line.text.length > 2000
          || /\n\s*\n/.test(line.text)
          || !Number.isFinite(line.start_sec) || line.start_sec < 0
          || !Number.isFinite(line.target_sec) || line.target_sec <= 0
          || line.start_sec + line.target_sec > spec.durationSec + 0.05) {
          throw new Error('E_VIDEO_PRODUCTION_CAPTION_INVALID: each caption needs text and a finite window inside the source video');
        }
        // Encode SRT markup characters without changing the caption wording.
        const text = line.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return `${index + 1}\n${srtTime(line.start_sec)} --> ${srtTime(line.start_sec + line.target_sec)}\n${text}\n`;
      }).join('\n');
      const node = bundledNodeExecutable();
      const core = path.join(userMarketplaceAgentDir(input.userId, '79df9cc89f5f'), 'skills/stage-edit/scripts/lib/video_edit_core.cjs');
      if (!node || !await fs.stat(core).catch(() => null)) throw new Error('E_VIDEO_PRODUCTION_EDIT_RUNTIME_MISSING: the installed editing engine is unavailable');
      const renderDir = path.join(path.dirname(identity.plan_path), 'render');
      if (!isPathAllowed(renderDir, input.roots)) throw new Error('E_PATH_OUT_OF_SCOPE: edit output directory is outside scope');
      await fs.mkdir(renderDir, { recursive: true });
      const dir = await fs.mkdtemp(path.join(renderDir, 'caption-'));
      const output = path.join(dir, 'video.mp4');
      const subtitlePath = path.join(dir, 'video.srt');
      try {
        await fs.writeFile(subtitlePath, subtitles, 'utf8');
        if (await sha256OfFileStream(source.output_path) !== sourceHash) {
          throw new Error('E_VIDEO_PRODUCTION_EDIT_SOURCE_UNVERIFIED: the source changed while preparing the edit');
        }
        const params = { op: 'burnsubs', inputAbsPath: source.output_path, subtitlesAbsPath: subtitlePath, outputAbsPath: output };
        const result = await runVideoProcessForTest(node, ['-e',
          'process.env.ORKAS_RUNTIME_DIR=process.argv[2];require(process.argv[1]).editVideo(JSON.parse(process.argv[3])).then(r=>{process.stdout.write(JSON.stringify(r));process.exitCode=r.ok?0:1}).catch(()=>{process.exitCode=1})',
          core, runtimeResourcesDir(), JSON.stringify(params),
        ], { signal: input.signal, timeoutMs: 600000, maxOutputBytes: 1024 * 1024 });
        if (result.aborted) throw new Error('E_VIDEO_PRODUCTION_EDIT_CANCELLED');
        if (result.timedOut || result.code !== 0) throw new Error('E_VIDEO_PRODUCTION_EDIT_FAILED: caption rendering failed; the original video is unchanged');
        const rendered = JSON.parse(result.stdout);
        if (!rendered.ok || rendered.path !== output || !await probeDeliveredVideo(output, input.signal)) throw new Error('E_VIDEO_PRODUCTION_EDIT_OUTPUT_UNREADABLE');
        if (input.signal?.aborted) throw new Error('E_VIDEO_PRODUCTION_EDIT_CANCELLED');
        await finalizeProducedFile(output, { userId: input.userId, cid: input.cid, source: 'video_studio' });
        return { output_path: output, output_sha256: await sha256OfFileStream(output), source_path: source.output_path, source_sha256: sourceHash };
      } catch (err) {
        await fs.rm(dir, { recursive: true, force: true });
        throw err;
      }
    },
  });
}
