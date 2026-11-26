import { appTaskMediaRoute } from '../../features/app_media_route';
/**
 * `generate_video` tool — produces an mp4 with the user's configured
 * video-generation API key.
 *
 * Permission, path scope, uniquify, and produced-file notification mirror
 * `generate_image`.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { AgentTool, ToolContext, ToolResult } from '#core-agent';
import { generateVideo } from '../../features/video_gen';
import { isPathAllowed } from '../../util/path-sandbox';
import { reserveUniquePath, renderRenameSignal } from '../../util/uniquify-path';
import { noteGeneration, regenerationWarning } from '../../util/generation-guard';
import { getWorkspacePath } from '../../features/user_workspace';
import { chatAttachmentDirForConversation } from '../../util/project-layout';
import { createLogger } from '../../logger';
import { logErrorRef, logPathRef, maskId } from '../../util/log-redact';
import { sanitizeLogTextForUpload } from '../../util/log-sanitize';
import { versionedChatMediaLocalUrl } from '../../util/chat-media-url';
import type { TimelineSpend } from '../../features/video_production_spend';
import { VIDEO_STUDIO_AGENT_ID } from './tool-catalog';

const log = createLogger('video-gen-tool');

const CREDITS_EXHAUSTED_MESSAGE =
  'E_CREDITS_EXHAUSTED: The configured Orkas API key does not have enough credits for this clip. '
  + 'Do not retry until the user tops up the API account; already-produced clips remain saved.';

export interface VideoGenToolOpts {
  userId: string;
  cid?: string;
  conversationTitle?: string;
  conversationTitleUpdatedAt?: number;
  turnId?: string;
  agentId?: string;
  agentName?: string;
  projectId?: string;
  onFileWritten?: (absPath: string) => void | Promise<void>;
  hasProducedPath?: (absPath: string) => boolean;
  /** Host-only configured service chosen on the video canvas. */
  videoRoute?: string;
}

function allowedRoots(opts: VideoGenToolOpts): string[] {
  const roots: string[] = [];
  try {
    const ws = getWorkspacePath(opts.userId, opts.projectId, opts.cid);
    if (ws) roots.push(ws);
  } catch (err) { log.warn('resolve workspace failed', { user_id: maskId(opts.userId), project_id: maskId(opts.projectId), error: logErrorRef(err) }); }
  if (opts.cid) {
    try { roots.push(chatAttachmentDirForConversation(opts.userId, opts.cid)); }
    catch (err) { log.warn('resolve attachment dir failed', { user_id: maskId(opts.userId), cid: maskId(opts.cid), error: logErrorRef(err) }); }
  }
  return roots;
}

function resolveAbs(ctx: ToolContext, p: string): string {
  return path.resolve(ctx.workingDir ?? '.', p);
}

function withMp4Extension(value: string): string {
  const extension = path.extname(value);
  if (extension.toLowerCase() === '.mp4') return value;
  return extension ? `${value.slice(0, -extension.length)}.mp4` : `${value}.mp4`;
}

function timelineEnabled(opts: VideoGenToolOpts): boolean {
  return opts.agentId === VIDEO_STUDIO_AGENT_ID;
}

export function createVideoGenTool(opts: VideoGenToolOpts): AgentTool {
  return {
    name: 'generate_video',
    executionMode: 'parallel',
    description:
      'Generate or edit a short MP4 with the configured video service and save it locally.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Video description. Include subject, motion, camera movement, scene, style, and timing.',
        },
        output_path: {
          type: 'string',
          description:
            'Where to write the MP4. Absolute or workspace-relative; must be in workspace/attachments. .mp4 optional; collisions auto-suffix.',
        },
        reference_image_urls: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional public image or asset:// URLs for image-to-video/reference generation.',
        },
        reference_image_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional local image paths inside workspace/attachment scope.',
        },
        reference_video_urls: {
          type: 'array',
          items: { type: 'string' },
          description: 'Public HTTPS or asset:// video URLs. Supply videos as references for generation or as source footage for editing.',
        },
        reference_video_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Local video paths inside the workspace or attachments, for the same uses as reference_video_urls.',
        },
        first_frame: {
          type: 'string',
          description: 'Image the video must open on: a local path in workspace/attachments, or an https or asset:// URL. Some models cannot also take reference images or videos.',
        },
        last_frame: {
          type: 'string',
          description: 'Image the video must end on, given like first_frame. Requires first_frame; not every model supports it.',
        },
        operation: {
          type: 'string',
          description: 'Defaults to generate. An edit requires a reference video. Put the source video first (URLs precede local paths) and describe the change in the prompt. First and last frames apply to generation.',
        },
        ratio: {
          type: 'string',
          description: 'Output aspect ratio, such as 16:9 or 9:16. Omit when the model takes the ratio from the first frame or edit source. Use adaptive only where supported.',
        },
        duration: {
          type: 'number',
          description: 'Clip length in whole seconds. Omit for the service default or when the source video or prompt determines the length. Use -1 for automatic duration where supported.',
        },
        resolution: {
          type: 'string',
          description: 'Output resolution, such as 480p, 768p, 1080p or 2k. Omit for the service default. Available resolutions depend on the model.',
        },
        quality: {
          type: 'string',
          description:
            'Optional quality intent where supported by the configured service: economy, balanced (default), or quality.',
        },
        generate_audio: {
          type: 'boolean',
          description: 'Omit to request audio by default. Set false for silent output where supported.',
        },
        ...(timelineEnabled(opts) ? {
          production_dir: {
            type: 'string',
            description: 'The production this clip belongs to. Required. It holds your asset ledger.',
          },
          shot: { type: 'string', description: 'Groups retries of one shot in the ledger.' },
          label: { type: 'string', description: 'Short name for this clip, for the user.' },
        } : {}),
      },
      required: ['prompt', 'output_path'],
    },
    async execute(input, ctx) {
      const reserved: Array<() => void> = [];
      try {
        return await generate(input, ctx, reserved);
      } finally {
        for (const release of reserved) release();
      }
    },
  };

  async function generate(input: Record<string, unknown>, ctx: ToolContext, reserved: Array<() => void>): Promise<ToolResult> {
    const prompt = String(input.prompt ?? '').trim();
    const outputPathRaw = String(input.output_path ?? '').trim();
    if (!prompt)        return { content: 'prompt is required', isError: true } as ToolResult;
    if (!outputPathRaw) return { content: 'output_path is required', isError: true } as ToolResult;

    const requestedAbs = withMp4Extension(resolveAbs(ctx, outputPathRaw));
    const isMine: (p: string) => boolean = opts.hasProducedPath
      ? (p) => opts.hasProducedPath!(p)
      : () => false;
    const videoStudioControlled = opts.agentId === VIDEO_STUDIO_AGENT_ID;
    // A completed shot stays intact; all producers share the same name claims.
    const claim = await reserveUniquePath(requestedAbs, videoStudioControlled ? () => false : isMine, ctx.signal);
    reserved.push(claim.release);
    const { finalPath: outputAbs, renamed } = claim;
    const roots = allowedRoots(opts);
    if (!isPathAllowed(outputAbs, roots)) {
      return {
        content: `E_PATH_OUT_OF_SCOPE: output_path is outside the current scope (workspace + attachments): ${outputAbs}`,
        isError: true,
      } as ToolResult;
    }

    const referenceImageUrls: string[] = Array.isArray(input.reference_image_urls)
      ? (input.reference_image_urls as unknown[]).map(String).map((s) => s.trim()).filter(Boolean)
      : [];
    const referenceImagePathInputs: string[] = Array.isArray(input.reference_image_paths)
      ? (input.reference_image_paths as unknown[]).map(String).map((s) => s.trim()).filter(Boolean)
      : [];
    const referenceVideoUrls: string[] = Array.isArray(input.reference_video_urls)
      ? (input.reference_video_urls as unknown[]).map(String).map((s) => s.trim()).filter(Boolean)
      : [];
    const referenceVideoPathInputs: string[] = Array.isArray(input.reference_video_paths)
      ? (input.reference_video_paths as unknown[]).map(String).map((s) => s.trim()).filter(Boolean)
      : [];
    if (referenceImageUrls.length + referenceImagePathInputs.length > 30) {
      return { content: 'reference images: at most 30 entries allowed; the configured model may allow fewer', isError: true } as ToolResult;
    }
    if (referenceVideoUrls.length + referenceVideoPathInputs.length > 10) {
      return { content: 'reference videos: at most 10 entries allowed; the configured model may allow fewer', isError: true } as ToolResult;
    }
    const operation = input.operation === 'edit' ? 'edit' : 'generate';
    if (operation === 'edit' && referenceVideoUrls.length + referenceVideoPathInputs.length < 1) {
      return { content: 'operation=edit requires at least one reference video', isError: true } as ToolResult;
    }

    const referenceImagePaths: string[] = [];
    for (const rawPath of referenceImagePathInputs) {
      const abs = resolveAbs(ctx, rawPath);
      if (!isPathAllowed(abs, roots)) {
        return {
          content: `E_PATH_OUT_OF_SCOPE: reference_image_paths is outside the current scope (workspace + attachments): ${abs}`,
          isError: true,
        } as ToolResult;
      }
      const st = await fs.stat(abs).catch(() => null);
      if (!st || !st.isFile()) {
        return { content: `reference_image_paths entry is not a file: ${abs}`, isError: true } as ToolResult;
      }
      referenceImagePaths.push(abs);
    }
    const referenceVideoPaths: string[] = [];
    for (const rawPath of referenceVideoPathInputs) {
      const abs = resolveAbs(ctx, rawPath);
      if (!isPathAllowed(abs, roots)) {
        return {
          content: `E_PATH_OUT_OF_SCOPE: reference_video_paths is outside the current scope (workspace + attachments): ${abs}`,
          isError: true,
        } as ToolResult;
      }
      const st = await fs.stat(abs).catch(() => null);
      if (!st || !st.isFile()) {
        return { content: `reference_video_paths entry is not a file: ${abs}`, isError: true } as ToolResult;
      }
      referenceVideoPaths.push(abs);
    }
    // A frame is a link or a file in scope, like a reference.
    const frameOf = async (field: 'first_frame' | 'last_frame'): Promise<{ url?: string; path?: string } | ToolResult> => {
      const raw = typeof input[field] === 'string' ? (input[field] as string).trim() : '';
      if (!raw) return {};
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return { url: raw };
      const abs = resolveAbs(ctx, raw);
      if (!isPathAllowed(abs, roots)) {
        return { content: `E_PATH_OUT_OF_SCOPE: ${field} is outside the current scope (workspace + attachments): ${abs}`, isError: true } as ToolResult;
      }
      const st = await fs.stat(abs).catch(() => null);
      if (!st || !st.isFile()) return { content: `${field} is not a file: ${abs}`, isError: true } as ToolResult;
      return { path: abs };
    };
    let appRoute:string|undefined;
    try{appRoute=await appTaskMediaRoute(opts.userId,opts.cid,'video',ctx.signal);}catch{return{content:'E_UNAVAILABLE',isError:true} as ToolResult;}
    const selectedRoute=appRoute||opts.videoRoute;
    const firstFrame = await frameOf('first_frame');
    if ('content' in firstFrame) return firstFrame;
    const lastFrame = await frameOf('last_frame');
    if ('content' in lastFrame) return lastFrame;
    const frameFiles = { ...(firstFrame.path ? { first_frame: firstFrame.path } : {}), ...(lastFrame.path ? { last_frame: lastFrame.path } : {}) };
    // Added only when given, so a call without frames keeps the request it had.
    const frameRequest = {
      ...(firstFrame.url || firstFrame.path ? { first_frame: firstFrame.url ?? firstFrame.path } : {}),
      ...(lastFrame.url || lastFrame.path ? { last_frame: lastFrame.url ?? lastFrame.path } : {}),
    };

    let timelineSpend: TimelineSpend | undefined;
    if (timelineEnabled(opts)) {
      const productionRaw = String(input.production_dir ?? '').trim();
      if (!productionRaw) {
        return { content: 'E_PRODUCTION_DIR: production_dir is required: the folder holding this production.', isError: true } as ToolResult;
      }
      const request = {
        prompt,
        operation,
        reference_image_urls: referenceImageUrls,
        reference_image_paths: referenceImagePaths,
        reference_video_urls: referenceVideoUrls,
        reference_video_paths: referenceVideoPaths,
        ...frameRequest,
        ratio: input.ratio,
        duration: input.duration,
        resolution: input.resolution,
        quality: input.quality,
        generate_audio: input.generate_audio !== false,
      };
      // Load the shared configured-service and durable request check only for Studio.
      const { beginTimelineGeneration } = await import('../../features/video_production_spend');
      const productionDirAbs = resolveAbs(ctx, productionRaw);
      const started = await beginTimelineGeneration({
        userId: opts.userId,
        scope: opts.cid || productionDirAbs,
        productionDirAbs,
        allowedRoots: roots,
        kind: 'video',
        requestedAbs,
        ...(typeof input.shot === 'string' ? { shot: input.shot } : {}),
        request:{...request,...appRoute?{app_media_route:appRoute}:{}},
        referenceFiles: [...referenceImagePaths, ...referenceVideoPaths, ...Object.values(frameFiles)],
        ...(selectedRoute ? { videoProfileId: selectedRoute } : {}),
        intent: {
          segment_id: 'request',
          kind: 'video',
          prompt,
          operation,
          reference_image_paths: referenceImagePaths,
          reference_image_urls: referenceImageUrls,
          reference_video_paths: referenceVideoPaths,
          reference_video_urls: referenceVideoUrls,
          ...(firstFrame.path ? { first_frame_path: firstFrame.path } : {}),
          ...(firstFrame.url ? { first_frame_url: firstFrame.url } : {}),
          ...(lastFrame.path ? { last_frame_path: lastFrame.path } : {}),
          ...(lastFrame.url ? { last_frame_url: lastFrame.url } : {}),
          generate_audio: input.generate_audio !== false,
          ...(typeof input.ratio === 'string' ? { ratio: input.ratio } : {}),
          ...(typeof input.duration === 'number' ? { duration: input.duration } : {}),
          ...(typeof input.resolution === 'string' ? { resolution: input.resolution } : {}),
          ...(typeof input.quality === 'string' ? { quality: input.quality } : {}),
        },
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      if ('refusal' in started) return started.refusal as ToolResult;
      if (started.reusedPath) {
        if (opts.onFileWritten) await opts.onFileWritten(started.reusedPath);
        return { content: `This exact request already finished: ${started.reusedPath}. Show it with: [video](${versionedChatMediaLocalUrl(started.reusedPath)})` } as ToolResult;
      }
      timelineSpend = started.spend;
    }

    // A repeat of a request made on a chosen service goes back there, whoever repeats it.
    const videoRoute = timelineSpend?.videoRoute ?? selectedRoute;
    let result: Awaited<ReturnType<typeof generateVideo>>;
    try {
      result = await generateVideo({
        prompt,
        outputAbsPath: outputAbs,
        ...(videoRoute ? { profileId: videoRoute } : {}),
        ...(referenceImageUrls.length ? { referenceImageUrls } : {}),
        ...(referenceImagePaths.length ? { referenceImagePaths } : {}),
        ...(referenceVideoUrls.length ? { referenceVideoUrls } : {}),
        ...(referenceVideoPaths.length ? { referenceVideoPaths } : {}),
        ...(firstFrame.url ? { firstFrameUrl: firstFrame.url } : {}),
        ...(firstFrame.path ? { firstFramePath: firstFrame.path } : {}),
        ...(lastFrame.url ? { lastFrameUrl: lastFrame.url } : {}),
        ...(lastFrame.path ? { lastFramePath: lastFrame.path } : {}),
        operation,
        ...(typeof input.ratio === 'string' ? { ratio: input.ratio } : {}),
        ...(typeof input.duration === 'number' ? { duration: input.duration } : {}),
        ...(typeof input.resolution === 'string' ? { resolution: input.resolution } : {}),
        ...(input.quality === 'economy' || input.quality === 'balanced' || input.quality === 'quality'
          ? { quality: input.quality }
          : {}),
        generateAudio: input.generate_audio !== false,
        usageContext: { conversationId: opts.cid || '', turnId: opts.turnId || '' },
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        onProgress: (event) => {
          ctx.emitProgress?.({
            phase: event.phase,
            message: event.message,
            ...(event.data ? { data: event.data } : {}),
          });
        },
      });
    } catch (err) {
      const safeError = sanitizeLogTextForUpload((err as Error).message || String(err));
      return {
        content: `[PROVIDER_EXCEPTION] ${safeError}`,
        isError: true,
      } as ToolResult;
    }

    if (result.ok === false) {
      // Only a structured pre-dispatch failure releases admission. An uncertain request stays pending.
      if (timelineSpend && result.dispatched === false && timelineSpend.heldNow) {
        const { releaseProductionSpend } = await import('../../features/video_production_spend');
        await releaseProductionSpend({ userId: opts.userId, scope: timelineSpend.scope, fingerprint: timelineSpend.fingerprint });
      }
      if (result.errorCode === 'CREDITS_EXHAUSTED') {
        return { content: CREDITS_EXHAUSTED_MESSAGE, isError: true } as ToolResult;
      }
      return {
        content: `[${result.errorCode}] ${sanitizeLogTextForUpload(result.message)}`,
        isError: true,
      } as ToolResult;
    }

    if (opts.onFileWritten) {
      try { await opts.onFileWritten(result.path); }
      catch (err) { log.warn('onFileWritten callback failed', { path: logPathRef(result.path), error: logErrorRef(err) }); }
    }

    if (timelineSpend) {
      const { finishTimelineGeneration } = await import('../../features/video_production_spend');
      const finished = await finishTimelineGeneration({
        spend: timelineSpend,
        userId: opts.userId,
        kind: 'video',
        fileAbs: result.path,
        prompt,
        model: `${result.provider}/${result.model}`,
        referenceFiles: [...referenceImagePaths, ...referenceVideoPaths],
        frameFiles,
        request: input,
        ...(typeof input.shot === 'string' ? { shot: input.shot } : {}),
        ...(typeof input.label === 'string' ? { label: input.label } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      const { previewPng, ...facts } = finished;
      const { prepareLosslessModelImage } = await import('../../features/image_assets');
      const image = previewPng ? await prepareLosslessModelImage(previewPng).catch(() => null) : null;
      const lines = [
        JSON.stringify(facts),
        `Video written to ${result.path}.`,
        `Show it to the user with: [video](${versionedChatMediaLocalUrl(result.path)})`,
      ];
      return {
        content: lines.join('\n'),
        ...(image ? { images: [{ data: image.buf.toString('base64'), mediaType: image.mediaType }], imageRetention: 'active_turn' as const } : {}),
      } as ToolResult;
    }

    // Soft guard: count (re)generations of THIS requested deliverable and
    // surface a one-line warning past the threshold — billable, never blocked.
    const guardNote = regenerationWarning(noteGeneration(opts.cid, requestedAbs), 'video');
    const summary =
      `Video written to ${result.path} `
      + `(${result.bytes} bytes, task ${result.taskId}, ${result.provider}/${result.model}). `
      + `Show it to the user with: [video](${versionedChatMediaLocalUrl(result.path)})`
      + (guardNote ? `\n${guardNote}` : '');
    const content = renamed ? `${summary}${renderRenameSignal(requestedAbs, result.path)}` : summary;
    return { content } as ToolResult;
  }
}
