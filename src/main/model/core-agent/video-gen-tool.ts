/** `generate_video` tool backed by the configured Orkas public API key. */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { AgentTool, ToolContext, ToolResult } from '#core-agent';
import { generateVideo } from '../../features/video_gen';
import { isPathAllowed } from '../../util/path-sandbox';
import { uniquifyPath, renderRenameSignal } from '../../util/uniquify-path';
import { noteGeneration, regenerationWarning } from '../../util/generation-guard';
import { getWorkspacePath } from '../../features/user_workspace';
import { chatAttachmentDirForConversation } from '../../util/project-layout';
import { createLogger } from '../../logger';
import { logErrorRef, logPathRef, maskId } from '../../util/log-redact';
import { sanitizeLogTextForUpload } from '../../util/log-sanitize';
import { versionedChatMediaLocalUrl } from '../../util/chat-media-url';
import {
  beginVideoProductionGeneration,
  finishVideoProductionGeneration,
  videoProductionControlStatePath,
  type VideoProductionGenerationTransaction,
} from '../../features/video_production_control';
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
}

function allowedRoots(opts: VideoGenToolOpts): string[] {
  const roots: string[] = [];
  try {
    const workspace = getWorkspacePath(opts.userId, opts.projectId);
    if (workspace) roots.push(workspace);
  } catch (err) {
    log.warn('resolve workspace failed', {
      user_id: maskId(opts.userId),
      project_id: maskId(opts.projectId),
      error: logErrorRef(err),
    });
  }
  if (opts.cid) {
    try { roots.push(chatAttachmentDirForConversation(opts.userId, opts.cid)); }
    catch (err) {
      log.warn('resolve attachment dir failed', {
        user_id: maskId(opts.userId),
        cid: maskId(opts.cid),
        error: logErrorRef(err),
      });
    }
  }
  return roots;
}

function resolveAbs(ctx: ToolContext, value: string): string {
  return path.resolve(ctx.workingDir ?? '.', value);
}

function withMp4Extension(value: string): string {
  const extension = path.extname(value);
  if (extension.toLowerCase() === '.mp4') return value;
  return extension ? `${value.slice(0, -extension.length)}.mp4` : `${value}.mp4`;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(String).map((item) => item.trim()).filter(Boolean)
    : [];
}

export function createVideoGenTool(opts: VideoGenToolOpts): AgentTool {
  return {
    name: 'generate_video',
    description: 'Generate or edit a short MP4 with the configured video service and save it locally.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Video description, including subject, motion, camera movement, scene, style, and timing.',
        },
        output_path: {
          type: 'string',
          description: 'Workspace/attachment output path. .mp4 is optional and collisions are auto-suffixed.',
        },
        reference_image_urls: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional public HTTPS image URLs, up to nine.',
        },
        reference_image_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional local image paths. A reusable provider URL must be available for each file.',
        },
        reference_video_urls: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional public HTTPS video URLs, up to three.',
        },
        reference_video_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional local video paths. A reusable provider URL must be available for each file.',
        },
        operation: {
          type: 'string',
          description: 'generate (default) or edit. edit requires a reference video.',
        },
        ratio: {
          type: 'string',
          description: '16:9, 9:16, 1:1, 4:3, 3:4, or 21:9.',
        },
        duration: {
          type: 'number',
          description: 'Duration from 4 to 15 seconds. Default 5.',
        },
        resolution: {
          type: 'string',
          description: '480p, 720p (default), or 1080p.',
        },
        quality: {
          type: 'string',
          description: 'balanced (default) or quality.',
        },
        generate_audio: {
          type: 'boolean',
          description: 'Whether to request generated audio. Default true.',
        },
        production_plan_path: {
          type: 'string',
          description: 'VideoStudio only: approved project/plan.json for this billable segment.',
        },
        production_segment_id: {
          type: 'string',
          description: 'VideoStudio only: approved generate-segment id.',
        },
      },
      required: ['prompt', 'output_path'],
    },
    async execute(input, ctx) {
      const prompt = String(input.prompt ?? '').trim();
      const outputPathRaw = String(input.output_path ?? '').trim();
      if (!prompt) return { content: 'prompt is required', isError: true } as ToolResult;
      if (!outputPathRaw) return { content: 'output_path is required', isError: true } as ToolResult;

      const requestedAbs = withMp4Extension(resolveAbs(ctx, outputPathRaw));
      const videoStudioControlled = opts.agentId === VIDEO_STUDIO_AGENT_ID;
      const unique = videoStudioControlled
        ? { finalPath: requestedAbs, renamed: false }
        : await uniquifyPath(requestedAbs, opts.hasProducedPath || (() => false));
      const outputAbs = unique.finalPath;
      const roots = allowedRoots(opts);
      if (!isPathAllowed(outputAbs, roots)) {
        return {
          content: `E_PATH_OUT_OF_SCOPE: output_path is outside the current scope (workspace + attachments): ${outputAbs}`,
          isError: true,
        } as ToolResult;
      }

      const referenceImageUrls = stringList(input.reference_image_urls);
      const referenceImageInputs = stringList(input.reference_image_paths);
      const referenceVideoUrls = stringList(input.reference_video_urls);
      const referenceVideoInputs = stringList(input.reference_video_paths);
      if (referenceImageUrls.length + referenceImageInputs.length > 9) {
        return { content: 'reference images: at most 9 entries allowed', isError: true } as ToolResult;
      }
      if (referenceVideoUrls.length + referenceVideoInputs.length > 3) {
        return { content: 'reference videos: at most 3 entries allowed', isError: true } as ToolResult;
      }
      const operation = input.operation === 'edit' ? 'edit' : 'generate';
      if (operation === 'edit' && referenceVideoUrls.length + referenceVideoInputs.length < 1) {
        return { content: 'operation=edit requires at least one reference video', isError: true } as ToolResult;
      }

      const resolveReferencePaths = async (values: string[], field: string): Promise<string[]> => {
        const out: string[] = [];
        for (const raw of values) {
          const absolute = resolveAbs(ctx, raw);
          if (!isPathAllowed(absolute, roots)) {
            throw new Error(`E_PATH_OUT_OF_SCOPE: ${field} is outside scope: ${absolute}`);
          }
          const stat = await fs.stat(absolute).catch(() => null);
          if (!stat?.isFile()) throw new Error(`${field} entry is not a file: ${absolute}`);
          out.push(absolute);
        }
        return out;
      };

      let referenceImagePaths: string[];
      let referenceVideoPaths: string[];
      try {
        referenceImagePaths = await resolveReferencePaths(referenceImageInputs, 'reference_image_paths');
        referenceVideoPaths = await resolveReferencePaths(referenceVideoInputs, 'reference_video_paths');
      } catch (err) {
        return { content: (err as Error).message, isError: true } as ToolResult;
      }

      let productionPlanAbs = '';
      let productionStatePath = '';
      let productionTransaction: VideoProductionGenerationTransaction | undefined;
      if (videoStudioControlled) {
        const planRaw = String(input.production_plan_path ?? '').trim();
        const segmentId = String(input.production_segment_id ?? '').trim();
        if (!planRaw || !segmentId) {
          return {
            content: 'E_VIDEO_PRODUCTION_CONTEXT_REQUIRED: VideoStudio generate_video requires production_plan_path and production_segment_id.',
            isError: true,
          } as ToolResult;
        }
        productionPlanAbs = resolveAbs(ctx, planRaw);
        if (!isPathAllowed(productionPlanAbs, roots)) {
          return { content: `E_PATH_OUT_OF_SCOPE: production_plan_path is outside scope: ${productionPlanAbs}`, isError: true } as ToolResult;
        }
        const planStat = await fs.stat(productionPlanAbs).catch(() => null);
        if (!planStat?.isFile()) {
          return { content: 'E_VIDEO_PRODUCTION_PLAN_MISSING: production_plan_path is not a file', isError: true } as ToolResult;
        }
        productionStatePath = videoProductionControlStatePath({
          userId: opts.userId,
          ...(opts.projectId ? { projectId: opts.projectId } : {}),
          planPath: productionPlanAbs,
        });
        try {
          const begun = await beginVideoProductionGeneration({
            statePath: productionStatePath,
            planPath: productionPlanAbs,
            segmentId,
            kind: 'video',
            outputPath: outputAbs,
            request: {
              prompt,
              operation,
              reference_image_urls: referenceImageUrls,
              reference_image_paths: referenceImageInputs,
              reference_video_urls: referenceVideoUrls,
              reference_video_paths: referenceVideoInputs,
              ...(typeof input.ratio === 'string' ? { ratio: input.ratio } : {}),
              ...(typeof input.duration === 'number' ? { duration: input.duration } : {}),
              ...(typeof input.resolution === 'string' ? { resolution: input.resolution } : {}),
              ...(typeof input.quality === 'string' ? { quality: input.quality } : {}),
              generate_audio: input.generate_audio !== false,
            },
          });
          if (begun.status === 'reused') {
            if (opts.onFileWritten) await opts.onFileWritten(begun.transaction.output_path);
            return {
              content: `VideoStudio reused the completed transaction for segment ${segmentId}: ${begun.transaction.output_path}. Show it with: [video](${versionedChatMediaLocalUrl(begun.transaction.output_path)})`,
            } as ToolResult;
          }
          productionTransaction = begun.transaction;
        } catch (err) {
          return { content: (err as Error).message, isError: true } as ToolResult;
        }
      }

      let result: Awaited<ReturnType<typeof generateVideo>>;
      try {
        result = await generateVideo({
        prompt,
        outputAbsPath: outputAbs,
        ...(referenceImageUrls.length ? { referenceImageUrls } : {}),
        ...(referenceImagePaths.length ? { referenceImagePaths } : {}),
        ...(referenceVideoUrls.length ? { referenceVideoUrls } : {}),
        ...(referenceVideoPaths.length ? { referenceVideoPaths } : {}),
        operation,
        ...(typeof input.ratio === 'string' ? { ratio: input.ratio } : {}),
        ...(typeof input.duration === 'number' ? { duration: input.duration } : {}),
        ...(typeof input.resolution === 'string' ? { resolution: input.resolution } : {}),
        ...(input.quality === 'balanced' || input.quality === 'quality' ? { quality: input.quality } : {}),
        generateAudio: input.generate_audio !== false,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        usageContext: {
          conversationId: opts.cid,
          turnId: opts.turnId,
        },
        onProgress: (event) => ctx.emitProgress?.({
          phase: event.phase,
          message: event.message,
          ...(event.data ? { data: event.data } : {}),
        }),
      });
      } catch (err) {
        const safeError = sanitizeLogTextForUpload((err as Error).message || String(err));
        return {
          content: productionTransaction
            ? `E_VIDEO_PRODUCTION_GENERATION_UNCERTAIN: provider dispatch ended without a terminal result (${safeError}); keep the pending transaction and do not retry without a new explicit Gate C approval.`
            : `[PROVIDER_EXCEPTION] ${safeError}`,
          isError: true,
        } as ToolResult;
      }

      if (result.ok === false) {
        if (productionTransaction) {
          try {
            await finishVideoProductionGeneration({
              statePath: productionStatePath,
              planPath: productionPlanAbs,
              transactionId: productionTransaction.transaction_id,
              segmentId: productionTransaction.segment_id,
              kind: 'video',
              ok: false,
              errorCode: result.errorCode,
              ...(result.taskId ? { providerTaskId: result.taskId } : {}),
            });
          } catch (err) {
            return {
              content: `${sanitizeLogTextForUpload((err as Error).message)}; provider error=[${result.errorCode}] ${sanitizeLogTextForUpload(result.message)}`,
              isError: true,
            } as ToolResult;
          }
        }
        return {
          content: result.errorCode === 'CREDITS_EXHAUSTED'
            ? CREDITS_EXHAUSTED_MESSAGE
            : `[${result.errorCode}] ${sanitizeLogTextForUpload(result.message)}`,
          isError: true,
        } as ToolResult;
      }

      if (productionTransaction) {
        try {
          await finishVideoProductionGeneration({
            statePath: productionStatePath,
            planPath: productionPlanAbs,
            transactionId: productionTransaction.transaction_id,
            segmentId: productionTransaction.segment_id,
            kind: 'video',
            ok: true,
            outputPath: result.path,
            providerTaskId: result.taskId,
          });
        } catch (err) {
          return { content: sanitizeLogTextForUpload((err as Error).message), isError: true } as ToolResult;
        }
      }

      if (opts.onFileWritten) {
        try { await opts.onFileWritten(result.path); }
        catch (err) {
          log.warn('onFileWritten callback failed', { path: logPathRef(result.path), error: logErrorRef(err) });
        }
      }
      const guardNote = regenerationWarning(noteGeneration(opts.cid, requestedAbs), 'video');
      const summary = `Video written to ${result.path} (${result.bytes} bytes, task ${result.taskId}, ${result.provider}/${result.model}). `
        + `Show it to the user with: [video](${versionedChatMediaLocalUrl(result.path)})`
        + (guardNote ? `\n${guardNote}` : '');
      return {
        content: unique.renamed ? `${summary}${renderRenameSignal(requestedAbs, result.path)}` : summary,
      } as ToolResult;
    },
  };
}
