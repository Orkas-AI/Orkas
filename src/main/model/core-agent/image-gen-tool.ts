import { appTaskMediaRoute } from '../../features/app_media_route';
import { parameterError } from '../../../../bin/tool-parameter-errors.cjs';
/**
 * `generate_image` tool — produces an image with whatever image-gen-capable
 * api_key entry sits highest in the user's auth-profiles priority list.
 *
 * Permission posture: shares the `localExec` local-access mode with `bash` /
 * `write_file` rather than introducing a parallel switch. The user's mental
 * model is "let this app touch my machine", and writing image bytes to a
 * workspace path is the same blast radius as `write_file`.
 *
 * Path scope: same sandbox as `read_file` / `write_file`
 * (active workspace ∪ current cid's attachment dir). `output_path` and every
 * `reference_images` entry pass through `util/path-sandbox.isPathAllowed`.
 *
 * On success fires `onFileWritten(absPath)` so the caller (chats.ts) can
 * surface a produced-files chip on the assistant message — same path the
 * other write tools use.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';

import type { AgentTool, ToolContext, ToolResult } from '#core-agent';
import { generateImage } from '../../features/image_gen';
import {
  IMAGE_REFERENCE_ROLES,
  compileImagePromptContract,
  normalizeImageReferenceBindings,
  normalizeImageStringList,
  type ImageReferenceBinding,
} from '../../features/image_prompt_contract';
import { isPathAllowed } from '../../util/path-sandbox';
import { uniquifyPath, renderRenameSignal } from '../../util/uniquify-path';
import { noteGeneration, regenerationWarning } from '../../util/generation-guard';
import { getWorkspacePath } from '../../features/user_workspace';
import { chatAttachmentDirForConversation } from '../../util/project-layout';
import { createLogger } from '../../logger';
import { logErrorRef, logPathRef, maskId } from '../../util/log-redact';
import { versionedChatMediaLocalUrl } from '../../util/chat-media-url';
import type { TimelineSpend } from '../../features/video_production_spend';
import {
  beginImageStudioGeneration,
  findReusableImageStudioGeneration,
  finishImageStudioGeneration,
  imageGenerationControlStatePath,
  type ImageGenerationTransaction,
} from '../../features/image_production_control';
import {
  checkImageProductionServices,
  type ImageProductionServiceAvailability,
} from '../../features/image_production_services';
import { IMAGE_STUDIO_AGENT_ID, VIDEO_STUDIO_AGENT_ID } from './tool-catalog';

const log = createLogger('image-gen-tool');

export interface ImageGenToolOpts {
  userId: string;
  /** Conversation id — extends the path sandbox to allow writing into
   *  the conv's attachment dir (and reading reference images from it). */
  cid?: string;
  conversationTitle?: string;
  conversationTitleUpdatedAt?: number;
  /** Project id of the current conversation, when it belongs to one.
   *  Threaded through from group_chat so workspace resolution picks up
   *  the project-scoped selection (per CLAUDE.md projects feature). */
  projectId?: string;
  turnId?: string;
  agentId?: string;
  agentName?: string;
  /** Same contract as `local-tools.LocalToolsOpts.onFileWritten`. */
  onFileWritten?: (absPath: string) => void | Promise<void>;
  /** Same contract as `local-tools.LocalToolsOpts.hasProducedPath`:
   *  caller-supplied predicate that returns true when this path was
   *  already written by the same caller this turn (refinement → overwrite
   *  in place). When false / absent, foreign collisions trigger uniquify. */
  hasProducedPath?: (absPath: string) => boolean;
}

function allowedRoots(opts: ImageGenToolOpts): string[] {
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

function possibleImageOutputPaths(p: string): string[] {
  const lower = p.toLowerCase();
  if (lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.webp')) {
    return [p];
  }
  return [`${p}.png`, `${p}.jpg`, `${p}.webp`];
}

/** Keep every possible provider-selected extension clear of existing output. */
function unusedImagePath(requestedAbs: string): string {
  const { dir, name, ext } = path.parse(requestedAbs);
  for (let n = 1; n < 10000; n += 1) {
    const candidate = n === 1 ? requestedAbs : path.join(dir, `${name}-${n}${ext}`);
    if (!possibleImageOutputPaths(candidate).some((p) => fs.existsSync(p))) return candidate;
  }
  throw new Error(`no unused image path under ${dir}`);
}

export function createImageGenTool(opts: ImageGenToolOpts): AgentTool {
  return {
    name: 'generate_image',
    description:
      'Generate or edit an image from a prompt and save it locally.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Image description. Be specific about subject, style, composition, lighting.',
        },
        output_path: {
          type: 'string',
          description:
            'Where to write the image. Absolute or workspace-relative; must be in workspace/attachments. Extension optional; collisions auto-suffix and return <file-renamed>.',
        },
        reference_images: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional local reference image paths for editing/variations in the same scope as output_path. Up to 4 references total, including reference_image_urls.',
        },
        reference_image_urls: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional HTTPS reference image URLs for editing/variations.',
        },
        reference_bindings: {
          type: 'array',
          description: 'Optional role contract for references. Indices use reference_images first, then reference_image_urls. Use this to distinguish identity, style, composition, structure, content, mask, and edit-source references.',
          items: {
            type: 'object',
            properties: {
              index: { type: 'number' },
              role: { type: 'string', enum: IMAGE_REFERENCE_ROLES },
              strength: { type: 'number', description: 'Reference influence from 0 to 1.' },
              preserve: { type: 'array', items: { type: 'string' } },
              may_change: { type: 'array', items: { type: 'string' } },
              region: { type: 'string' },
            },
            required: ['index', 'role'],
          },
        },
        negative_prompt: {
          type: 'array',
          items: { type: 'string' },
          description: 'Explicit unwanted objects, artifacts, text failures, or style properties.',
        },
        size: {
          type: 'string',
          description:
            'Flash/Pro: 1K/1.5K/2K(default) or WIDTHxHEIGHT (921600-4624220 pixels, aspect 1:16-16:1). Lite: 2K/3K/4K. Gemini: auto(default) or exact table size. OpenAI: supported size, default 1024x1024.',
        },
        ...(opts.agentId === VIDEO_STUDIO_AGENT_ID ? {
          production_dir: {
            type: 'string',
            description: 'The production this image belongs to. Required. It holds your asset ledger.',
          },
          shot: { type: 'string', description: 'Groups retries of one shot in the ledger.' },
          label: { type: 'string', description: 'Short name for this image, for the user.' },
        } : {}),
        image_project_path: {
          type: 'string',
          description: 'ImageStudio only: image project directory whose image-manifest.json owns the route and durable per-turn generation budget.',
        },
        image_request_id: {
          type: 'string',
          description: 'ImageStudio only: stable unique id for this billable generation intent within the current user turn. Reusing a completed id in the same turn reuses its output; every new id consumes one current-turn project budget slot.',
        },
      },
      required: ['prompt', 'output_path'],
    },
    async execute(input, ctx) {
      const prompt = String(input.prompt ?? '').trim();
      const outputPathRaw = String(input.output_path ?? '').trim();
      if (!prompt)         return parameterError('prompt is required', ['prompt'], 'required');
      if (!outputPathRaw)  return parameterError('output_path is required', ['output_path'], 'required');

      // Resolve the requested path, then run conflict-uniquify against
      // the caller's `hasProducedPath` predicate (if any). Done before
      // the sandbox check so the resolved path used for both the check
      // and the write is the same one returned in the tool result.
      const requestedAbs = resolveAbs(ctx, outputPathRaw);
      const isMine: (p: string) => boolean = opts.hasProducedPath
        ? (p) => opts.hasProducedPath!(p)
        : () => false;
      const videoStudioControlled = opts.agentId === VIDEO_STUDIO_AGENT_ID;
      const imageStudioControlled = opts.agentId === IMAGE_STUDIO_AGENT_ID;
      const unique = videoStudioControlled
        ? { finalPath: unusedImagePath(requestedAbs), renamed: false }
        : await uniquifyPath(requestedAbs, isMine);
      const { finalPath: outputAbs, renamed } = unique;
      const roots = allowedRoots(opts);
      if (!isPathAllowed(outputAbs, roots)) {
        return {
          content: `E_PATH_OUT_OF_SCOPE: output_path is outside the current scope (workspace + attachments): ${outputAbs}`,
          isError: true,
        } as ToolResult;
      }
      const escapedSuffixedOutput = possibleImageOutputPaths(outputAbs).find((p) => !isPathAllowed(p, roots));
      if (escapedSuffixedOutput) {
        return {
          content: `E_PATH_OUT_OF_SCOPE: output_path with generated image extension is outside the current scope (workspace + attachments): ${escapedSuffixedOutput}`,
          isError: true,
        } as ToolResult;
      }

      const referenceImages: string[] = Array.isArray(input.reference_images)
        ? (input.reference_images as unknown[]).map(String).filter(Boolean)
        : [];
      const referenceImageUrls: string[] = Array.isArray(input.reference_image_urls)
        ? (input.reference_image_urls as unknown[]).map(String).map((s) => s.trim()).filter(Boolean)
        : [];
      if (referenceImages.length + referenceImageUrls.length > 4) {
        return parameterError('reference_images: at most 4 entries allowed', ['reference_images'], 'too_big');
      }
      const refAbs: string[] = [];
      for (const r of referenceImages) {
        const abs = resolveAbs(ctx, r);
        if (!isPathAllowed(abs, roots)) {
          return {
            content: `E_PATH_OUT_OF_SCOPE: reference image is outside the current scope: ${abs}`,
            isError: true,
          } as ToolResult;
        }
        if (!fs.existsSync(abs)) {
          return { content: `Reference image not found: ${abs}`, isError: true } as ToolResult;
        }
        refAbs.push(abs);
      }

      let referenceBindings: ImageReferenceBinding[] = [];
      let negativePrompt: string[] = [];
      try {
        referenceBindings = normalizeImageReferenceBindings(input.reference_bindings, refAbs.length + referenceImageUrls.length);
        negativePrompt = normalizeImageStringList(input.negative_prompt, 'negative_prompt');
      } catch (error) {
        return parameterError((error as Error).message);
      }
      const providerPrompt = compileImagePromptContract(prompt, referenceBindings, negativePrompt);

      const sizeRaw = typeof input.size === 'string' ? input.size : undefined;

      let imageProfileId:string|undefined;
      try{imageProfileId=await appTaskMediaRoute(opts.userId,opts.cid,'image',ctx.signal);}catch{return{content:'E_UNAVAILABLE',isError:true} as ToolResult;}
      let timelineSpend: TimelineSpend | undefined;
      if (videoStudioControlled) {
        const productionRaw = String(input.production_dir ?? '').trim();
        if (!productionRaw) {
          return parameterError('E_PRODUCTION_DIR: production_dir is required: the folder holding this production.', ['production_dir'], 'required', {}, 'E_PRODUCTION_DIR');
        }
        // Check configured services and reserve the exact local request identity.
        const { beginTimelineGeneration } = await import('../../features/video_production_spend');
        const productionDirAbs = resolveAbs(ctx, productionRaw);
        const started = await beginTimelineGeneration({
          userId: opts.userId,
          scope: opts.cid || productionDirAbs,
          productionDirAbs,
          allowedRoots: roots,
          kind: 'image',
          requestedAbs,
          ...(typeof input.shot === 'string' ? { shot: input.shot } : {}),
          request: { ...(imageProfileId?{app_media_route:imageProfileId}:{}), prompt: providerPrompt, reference_images: refAbs, reference_image_urls: referenceImageUrls, size: sizeRaw },
          referenceFiles: refAbs,
          intent: {
            segment_id: 'request',
            kind: 'image',
            prompt: providerPrompt,
            reference_images: refAbs,
            reference_image_urls: referenceImageUrls,
            ...(sizeRaw ? { size: sizeRaw } : {}),
          },
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        if ('refusal' in started) return started.refusal as ToolResult;
        if (started.reusedPath) {
          if (opts.onFileWritten) await opts.onFileWritten(started.reusedPath);
          return { content: `This exact request already finished: ${started.reusedPath}. Show it with: ![generated image](${versionedChatMediaLocalUrl(started.reusedPath)})` } as ToolResult;
        }
        timelineSpend = started.spend;
      }

      let imageProjectAbs = '';
      let imageStatePath = '';
      let imageTransaction: ImageGenerationTransaction | undefined;
      let imageServiceAvailability: ImageProductionServiceAvailability | undefined;
      if (imageStudioControlled) {
        const projectRaw = String(input.image_project_path ?? '').trim();
        const requestId = String(input.image_request_id ?? '').trim();
        if (!projectRaw || !requestId) {
          return {
            content: 'E_IMAGE_GENERATION_CONTEXT_REQUIRED: ImageStudio generate_image requires image_project_path and image_request_id.',
            isError: true,
          } as ToolResult;
        }
        imageProjectAbs = resolveAbs(ctx, projectRaw);
        if (!isPathAllowed(imageProjectAbs, roots)) {
          return { content: `E_PATH_OUT_OF_SCOPE: image_project_path is outside scope: ${imageProjectAbs}`, isError: true } as ToolResult;
        }
        if (!fs.statSync(imageProjectAbs, { throwIfNoEntry: false })?.isDirectory()) {
          return { content: 'E_IMAGE_GENERATION_PROJECT_MISSING: image_project_path is not a directory', isError: true } as ToolResult;
        }
        imageStatePath = imageGenerationControlStatePath(opts.userId, imageProjectAbs);
        try {
          const reusable = await findReusableImageStudioGeneration(imageStatePath, requestId, opts.turnId);
          if (reusable?.output_path) {
            if (opts.onFileWritten) await opts.onFileWritten(reusable.output_path);
            return {
              content: `ImageStudio reused completed generation ${requestId}: ${reusable.output_path}. Show it with: ![generated image](${versionedChatMediaLocalUrl(reusable.output_path)})`,
            } as ToolResult;
          }
          imageServiceAvailability = await checkImageProductionServices({
            requestId,
            ...(imageProfileId ? { profileId: imageProfileId } : {}),
            ...(sizeRaw ? { size: sizeRaw } : {}),
            referenceCount: refAbs.length + referenceImageUrls.length,
          }, ctx.signal);
          if (imageServiceAvailability.unavailable_segment_ids.length) {
            return {
              content: `E_IMAGE_PRODUCTION_PROVIDER_UNAVAILABLE: no configured image-generation provider for request ${requestId}. No generation transaction was started.`,
              isError: true,
            } as ToolResult;
          }
          const begun = await beginImageStudioGeneration({
            stateAbsPath: imageStatePath,
            projectDirAbs: imageProjectAbs,
            requestId,
            outputAbsPath: outputAbs,
            ...(opts.turnId ? { turnId: opts.turnId } : {}),
          });
          if (begun.status === 'reused') {
            const reusedPath = begun.transaction.output_path!;
            if (opts.onFileWritten) await opts.onFileWritten(reusedPath);
            return {
              content: `ImageStudio reused completed generation ${requestId}: ${reusedPath}. Show it with: ![generated image](${versionedChatMediaLocalUrl(reusedPath)})`,
            } as ToolResult;
          }
          imageTransaction = begun.transaction;
        } catch (err) {
          return { content: (err as Error).message, isError: true } as ToolResult;
        }
      }

      let result: Awaited<ReturnType<typeof generateImage>>;
      try {
        result = await generateImage({
          prompt: providerPrompt,
          ...(imageProfileId ? { profileId: imageProfileId } : {}),
          outputAbsPath: outputAbs,
          ...(refAbs.length ? { referenceImagePaths: refAbs } : {}),
          ...(referenceImageUrls.length ? { referenceImageUrls } : {}),
          ...(referenceBindings.length ? { referenceBindings } : {}),
          ...(negativePrompt.length ? { negativePrompt } : {}),
          ...(sizeRaw ? { size: sizeRaw } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          onProgress: (event) => {
            ctx.emitProgress?.({
              phase: event.phase,
              message: event.message,
              ...(event.data ? { data: event.data } : {}),
            });
          },
          usageContext: { conversationId: opts.cid, turnId: opts.turnId },
        });
      } catch (err) {
        return {
          content: imageTransaction
              ? `E_IMAGE_GENERATION_UNCERTAIN: provider dispatch ended without a terminal result (${(err as Error).message || String(err)}); the request remains pending and still counts toward the current turn's project budget.`
            : `[PROVIDER_EXCEPTION] ${(err as Error).message || String(err)}`,
          isError: true,
        } as ToolResult;
      }

      if (result.ok === false) {
        const notDispatched = result.dispatched === false;
        if (timelineSpend && notDispatched && timelineSpend.heldNow) {
          const { releaseProductionSpend } = await import('../../features/video_production_spend');
          await releaseProductionSpend({ userId: opts.userId, scope: timelineSpend.scope, fingerprint: timelineSpend.fingerprint });
        }
        if (imageTransaction) {
          try {
            await finishImageStudioGeneration({
              stateAbsPath: imageStatePath,
              transactionId: imageTransaction.transaction_id,
              ok: false,
              errorCode: result.errorCode,
              ...(notDispatched ? { countsTowardBudget: false } : {}),
            });
          } catch (err) {
            return { content: `${(err as Error).message}; provider error=[${result.errorCode}] ${result.message}`, isError: true } as ToolResult;
          }
        }
        return { content: `[${result.errorCode}] ${result.message}`, isError: true } as ToolResult;
      }

      if (imageTransaction) {
        try {
          await finishImageStudioGeneration({
            stateAbsPath: imageStatePath,
            transactionId: imageTransaction.transaction_id,
            ok: true,
            outputPath: result.path,
          });
        } catch (err) {
          return { content: (err as Error).message, isError: true } as ToolResult;
        }
      }

      if (opts.onFileWritten) {
        try { await opts.onFileWritten(result.path); }
        catch (err) { log.warn('onFileWritten callback failed', { path: logPathRef(result.path), error: logErrorRef(err) }); }
      }

      if (timelineSpend) {
        const { finishTimelineGeneration } = await import('../../features/video_production_spend');
        const { previewPng: _unused, ...facts } = await finishTimelineGeneration({
          spend: timelineSpend,
          userId: opts.userId,
          kind: 'image',
          fileAbs: result.path,
          prompt,
          model: `${result.provider}/${result.model}`,
          referenceFiles: refAbs,
          request: input,
          ...(typeof input.shot === 'string' ? { shot: input.shot } : {}),
          ...(typeof input.label === 'string' ? { label: input.label } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        return {
          content: [
            JSON.stringify(facts),
            `Image written to ${result.path} (${result.width}x${result.height}).`,
            `Show it to the user with: ![<alt>](${versionedChatMediaLocalUrl(result.path)})`,
          ].join('\n'),
        } as ToolResult;
      }

      // Soft guard: count (re)generations of THIS requested deliverable and
      // surface a one-line warning past the threshold — billable, never blocked.
      const guardNote = regenerationWarning(noteGeneration(opts.cid, requestedAbs), 'image');
      const summary =
        `Image written to ${result.path} `
        + `(${result.width}x${result.height}, ${result.bytes} bytes, ${result.provider}/${result.model}). `
        + (result.sourceUrl ? `Source URL: ${result.sourceUrl}. ` : '')
        + `Show it to the user with: ![<alt>](${versionedChatMediaLocalUrl(result.path)})`
        + (imageServiceAvailability ? `\nImageStudio local provider availability before dispatch: ${JSON.stringify(imageServiceAvailability)}` : '')
        + (guardNote ? `\n${guardNote}` : '');
      const content = renamed ? `${summary}${renderRenameSignal(requestedAbs, result.path)}` : summary;
      return { content } as ToolResult;
    },
  };
}
