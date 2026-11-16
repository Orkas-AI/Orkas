import { appTaskMediaRoute } from '../../features/app_media_route';
import { parameterError } from '../../../../bin/tool-parameter-errors.cjs';

import * as path from 'node:path';

import type { AgentTool, ToolContext, ToolResult } from '#core-agent';
import {
  generateSpeech,
  hasConfiguredTtsProvider,
  assessNarrationFit,
  estimateNarrationDuration,
  measureNarrationUnits,
} from '../../features/tts';
import { getTtsAvailabilityDetails, listTtsCapabilities, publicTtsCapabilities, listableTtsVoices } from '../../features/tts_capabilities';
import { isPathAllowed } from '../../util/path-sandbox';
import { uniquifyPathForWrite, renderRenameSignal } from '../../util/uniquify-path';
import { getWorkspacePath } from '../../features/user_workspace';
import { chatAttachmentDirForConversation } from '../../util/project-layout';
import { versionedChatMediaLocalUrl } from '../../util/chat-media-url';
import { createLogger } from '../../logger';
import { logErrorSummary } from '../../util/log-redact';
import { VIDEO_STUDIO_AGENT_ID } from './tool-catalog';
import type { ProducedFileWriteInfo } from './local-tools';

const log = createLogger('generate-speech-tool');
const VOICE_LABEL_CHARS = 40;

export interface GenerateSpeechToolOpts {
  userId: string;
  cid?: string;
  conversationTitle?: string;
  conversationTitleUpdatedAt?: number;
  turnId?: string;
  agentId?: string;
  agentName?: string;
  projectId?: string;
  onFileWritten?: (absPath: string, info?: ProducedFileWriteInfo) => void | Promise<void>;
  hasProducedPath?: (absPath: string) => boolean;
}

function allowedRoots(opts: GenerateSpeechToolOpts): string[] {
  const roots: string[] = [];
  const pushRoot = (root: string | undefined) => {
    if (!root) return;
    const resolved = path.resolve(root);
    if (!roots.includes(resolved)) roots.push(resolved);
  };
  try {
    pushRoot(getWorkspacePath(opts.userId, undefined, opts.cid));
  } catch (err) { log.warn('resolve workspace', { error: logErrorSummary(err) }); }
  if (opts.projectId) {
    try { pushRoot(getWorkspacePath(opts.userId, opts.projectId, opts.cid)); }
    catch (err) { log.warn('resolve project workspace', { error: logErrorSummary(err) }); }
  }
  if (opts.cid) {
    try { pushRoot(chatAttachmentDirForConversation(opts.userId, opts.cid)); }
    catch (err) { log.warn('resolve attachment dir', { error: logErrorSummary(err) }); }
  }
  return roots;
}

function defaultOutputRoot(opts: GenerateSpeechToolOpts, ctx: ToolContext): string {
  if (opts.cid) {
    try { return chatAttachmentDirForConversation(opts.userId, opts.cid); }
    catch (err) { log.warn('resolve default attachment dir', { error: logErrorSummary(err) }); }
  }
  try {
    const ws = getWorkspacePath(opts.userId, undefined, opts.cid);
    if (ws) return ws;
  } catch (err) { log.warn('resolve default workspace', { error: logErrorSummary(err) }); }
  if (opts.projectId) {
    try {
      const ws = getWorkspacePath(opts.userId, opts.projectId, opts.cid);
      if (ws) return ws;
    } catch (err) { log.warn('resolve fallback project workspace', { error: logErrorSummary(err) }); }
  }
  return ctx.workingDir ?? '.';
}

function isProjectRelativePath(p: string): boolean {
  const first = p.replace(/\\/g, '/').split('/').find(Boolean);
  return first === 'project';
}

/** VideoStudio keeps a production's files in its folder, so its relative paths are the
 *  workspace's, as for its video and image generation. */
function workspaceRelative(opts: GenerateSpeechToolOpts): boolean {
  return opts.agentId === VIDEO_STUDIO_AGENT_ID;
}

/** VideoStudio's delivery check stops a video that plays none of the narration made for it,
 *  so it has to hear about each line. Losing the note costs that check, never the line. */
async function noteVideoStudioVoice(ctx: ToolContext, opts: GenerateSpeechToolOpts, fileAbs: string, seconds?: number): Promise<void> {
  try {
    const workspaceAbs = ctx.workingDir || getWorkspacePath(opts.userId, opts.projectId, opts.cid);
    if (!workspaceAbs) return;
    // Loaded on use: delivery pulls in the video stack.
    const { recordProductionVoice } = await import('../../features/video_timeline_ship');
    await recordProductionVoice({ workspaceAbs, fileAbs, ...(typeof seconds === 'number' ? { seconds } : {}) });
  } catch (err) {
    log.warn('voice not recorded for delivery', { error: logErrorSummary(err) });
  }
}

/** VideoStudio's timeline names a line by its asset id, and a line voiced again keeps its voice
 *  from the row. On 2026-11-08 the model wrote these rows itself: one left out a required label,
 *  none recorded the voice, and a line voiced again took over the old line's row. Returns the
 *  result line that says where the line is. */
async function ledgerVideoStudioVoice(
  ctx: ToolContext,
  opts: GenerateSpeechToolOpts,
  made: { path: string; routeRef?: string; voiceRef?: string },
  spoken: { text: string; language?: string; speed?: number },
): Promise<string> {
  let productionDirAbs: string | null = null;
  try {
    const workspaceAbs = ctx.workingDir || getWorkspacePath(opts.userId, opts.projectId, opts.cid);
    // Loaded on use: delivery pulls in the video stack.
    const { productionHolding } = await import('../../features/video_timeline_ship');
    if (workspaceAbs) productionDirAbs = await productionHolding(made.path, workspaceAbs);
  } catch (err) {
    log.warn('voice production not found', { error: logErrorSummary(err) });
  }
  if (!productionDirAbs) {
    return 'asset_id: none. No production folder (one holding videos/ or assets.json) contains this file. Add it to assets.json yourself, with its voice in "request".';
  }
  try {
    const { recordProductionAsset } = await import('../../features/video_production_spend');
    const characters = Array.from(spoken.text);
    const assetId = await recordProductionAsset({
      productionDirAbs,
      fileAbs: made.path,
      record: {
        kind: 'audio',
        label: characters.length > VOICE_LABEL_CHARS ? `${characters.slice(0, VOICE_LABEL_CHARS).join('')}…` : spoken.text,
        origin: 'generated',
        prompt: spoken.text,
        request: {
          ...(made.routeRef ? { route_ref: made.routeRef } : {}),
          ...(made.voiceRef ? { voice_ref: made.voiceRef } : {}),
          ...(spoken.language ? { language: spoken.language } : {}),
          ...(typeof spoken.speed === 'number' ? { speed: spoken.speed } : {}),
        },
      },
    });
    return `asset_id: ${assetId}, already in assets.json with this voice.`;
  } catch (err) {
    log.warn('voice not added to the asset ledger', { error: logErrorSummary(err) });
    return 'asset_id: none. assets.json could not be read, so this file was not added to it. Add it yourself, with its voice in "request".';
  }
}

function resolveOutputAbs(ctx: ToolContext, opts: GenerateSpeechToolOpts, p: string, roots: string[]): string {
  if (path.isAbsolute(p)) return path.resolve(p);
  if (ctx.workingDir && workspaceRelative(opts)) return path.resolve(ctx.workingDir, p);
  if (ctx.workingDir && isProjectRelativePath(p)) {
    const workspaceCandidate = path.resolve(ctx.workingDir, p);
    if (isPathAllowed(workspaceCandidate, roots)) return workspaceCandidate;
  }
  return path.resolve(defaultOutputRoot(opts, ctx), p);
}

function withAudioExtension(p: string, format?: string): string {
  if (path.extname(p)) return p;
  const ext = (format || 'mp3').toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp3';
  return `${p}.${ext}`;
}

function inferAudioFormat(outputPath: string): string | undefined {
  const ext = path.extname(outputPath).slice(1).toLowerCase();
  return ['mp3', 'wav', 'opus', 'ogg'].includes(ext) ? ext : undefined;
}

export function createGenerateSpeechTool(opts: GenerateSpeechToolOpts): AgentTool {
  // A successful synthesis or a dispatched request with unknown charge status
  // may be billable. Keep the requested destination as the per-turn
  // idempotency key so an agent cannot repeatedly overwrite or retry the same
  // narration while trial-and-error fitting its duration.
  const synthesizedRequestedPaths = new Set<string>();
  const pendingRequestedPaths = new Set<string>();
  return {
    name: 'generate_speech',
    // Requester-approved narration exception: host has two slots and per-path ownership.
    executionMode: 'parallel',
    parallelWhen: input => input.action === undefined || input.action === 'generate',
    description:
      'Discover configured speech services or synthesize narration and save it locally.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['generate', 'capabilities'], description: 'Default generate requires text and output_path. capabilities lists the configured voices.' },
        text: { type: 'string', description: 'The text to speak.' },
        output_path: {
          type: 'string',
          description: workspaceRelative(opts)
            ? 'Where to write audio. Absolute or workspace-relative; must be in workspace/attachments. Extension optional. Each requested path may be used once per turn.'
            : 'Where to write audio. `project/...` resolves under the workspace; other relative paths prefer chat attachments. Extension optional. Each requested path may be used once per turn.',
        },
        route_ref: { type: 'string', description: 'Configured TTS route returned by capabilities; optionally filters capability listings.' },
        voice_ref: { type: 'string', description: 'Route-bound voice returned by capabilities. Never invent a provider id.' },
        offset: { type: 'integer', minimum: 0, description: 'Zero-based voice offset per route for capabilities; defaults to 0. Returns up to 20 eligible voices per route.' },
        language: { type: 'string', description: 'BCP-47 speech language, such as zh-CN or en-US; filters capabilities.' },
        voice: { type: 'string', description: 'Legacy provider voice id. Prefer route_ref + voice_ref.' },
        speed: { type: 'number', description: 'Speech speed multiplier (1.0 = normal). Optional.' },
        format: { type: 'string', description: 'Audio format: mp3 (default) / wav / opus. Optional.' },
        target_duration: { type: 'number', description: workspaceRelative(opts)
          ? 'Target clip length in seconds. Required for timed media; overlong text estimates are rejected before a paid request. The result reports measured duration, not an exact-duration guarantee.'
          : 'Target clip length in seconds. Required for timed media so overlong text is rejected before a paid request; result reports fit and suggested adjustment.' },
      },
    },
    async execute(input, ctx) {
      const action = input.action ?? 'generate';
      if (action !== 'generate' && action !== 'capabilities') {
        return parameterError('action must be generate or capabilities', ['action'], 'invalid_value');
      }
      const appRoute=await appTaskMediaRoute(opts.userId,opts.cid,'audio',ctx.signal);
      if (action === 'capabilities') {
        const offset = input.offset ?? 0;
        if (!Number.isSafeInteger(offset) || Number(offset) < 0) {
          return parameterError('offset must be a non-negative integer', ['offset'], 'invalid_value');
        }
        const availability = getTtsAvailabilityDetails();
        if (!availability.available) return { content: JSON.stringify(availability), isError: true } as ToolResult;
        const routes = publicTtsCapabilities(await listTtsCapabilities(ctx.signal))
          .filter(route => (!appRoute || route.routeRef === appRoute) && (!input.route_ref || route.routeRef === input.route_ref))
          .map(route => {
            const eligible = listableTtsVoices(route.voices, {
              language: typeof input.language === 'string' ? input.language : undefined,
              limit: Infinity,
            });
            const voices = eligible.voices.slice(Number(offset), Number(offset) + 20);
            return { ...route, voices, total_voices: eligible.eligible,
              next_offset: Number(offset) + voices.length < eligible.eligible ? Number(offset) + voices.length : null };
          });
        return { content: JSON.stringify({ routes }) } as ToolResult;
      }
      const text = String(input.text ?? '').trim();
      const outputPathRaw = String(input.output_path ?? '').trim();
      if (!text) return parameterError('text is required', ['text'], 'required');
      if (!outputPathRaw) return parameterError('output_path is required', ['output_path'], 'required');
      if (!hasConfiguredTtsProvider()) {
        const availability = getTtsAvailabilityDetails(false);
        return {
          content: `[${availability.errorCode || 'E_TTS_NO_PROVIDER'}] ${availability.message || 'No speech provider is available.'}`,
          isError: true,
        } as ToolResult;
      }

      const explicitFormat = typeof input.format === 'string' && input.format.trim() ? input.format.trim().toLowerCase() : undefined;
      const format = explicitFormat || inferAudioFormat(outputPathRaw);
      const speed = typeof input.speed === 'number' ? input.speed : undefined;
      const routeRef = appRoute || (typeof input.route_ref === 'string' && input.route_ref.trim() ? input.route_ref.trim() : undefined);
      const voiceRef = typeof input.voice_ref === 'string' && input.voice_ref.trim() ? input.voice_ref.trim() : undefined;
      const language = typeof input.language === 'string' && input.language.trim() ? input.language.trim() : undefined;
      const voice = typeof input.voice === 'string' && input.voice.trim() ? input.voice.trim() : undefined;
      const targetDuration = typeof input.target_duration === 'number' && input.target_duration > 0 ? input.target_duration : undefined;

      const roots = allowedRoots(opts);
      const requestedAbs = withAudioExtension(resolveOutputAbs(ctx, opts, outputPathRaw, roots), format);
      if (synthesizedRequestedPaths.has(requestedAbs) || pendingRequestedPaths.has(requestedAbs)) {
        return {
          content: 'E_TTS_ALREADY_GENERATED_THIS_TURN: This output_path already has a successful or potentially billable speech request in the current turn. Reuse the result, or wait for explicit user action before starting a later retry.',
          isError: true,
        } as ToolResult;
      }
      if (targetDuration !== undefined) {
        const estimate = estimateNarrationDuration(text, speed);
        if (estimate.estimatedSec > targetDuration * 1.05) {
          const keepRatio = Math.min(1, targetDuration / estimate.estimatedSec);
          const maxUnits = Math.max(1, Math.floor(estimate.units * keepRatio));
          const trimPercent = Math.max(1, Math.ceil((1 - keepRatio) * 100));
          return {
            content: workspaceRelative(opts)
              ? `E_TTS_TEXT_TOO_LONG: Estimated natural narration is ${estimate.estimatedSec}s for a ${targetDuration}s target. This is a pre-synthesis estimate, not a measured audio duration. No speech request was sent.`
              : `E_TTS_TEXT_TOO_LONG: Estimated natural narration is ${estimate.estimatedSec}s for a ${targetDuration}s target. Shorten by about ${trimPercent}% (to roughly ${maxUnits} ${estimate.unit} at the same language mix) before retrying. No speech request was sent.`,
            isError: true,
          } as ToolResult;
        }
      }
      const isMine: (p: string) => boolean = opts.hasProducedPath ? (p) => opts.hasProducedPath!(p) : () => false;
      pendingRequestedPaths.add(requestedAbs);
      try {
        return await uniquifyPathForWrite(requestedAbs, isMine, async ({ finalPath: outputAbs, renamed }) => {
          if (ctx.signal?.aborted) return { content: 'E_TTS_ABORTED', isError: true } as ToolResult;
          if (!isPathAllowed(outputAbs, roots)) {
            return { content: `E_PATH_OUT_OF_SCOPE: output_path is outside scope (workspace + attachments): ${outputAbs}`, isError: true } as ToolResult;
          }

          synthesizedRequestedPaths.add(requestedAbs);
          const result = await generateSpeech({
            text,
            outputAbsPath: outputAbs,
            ...(routeRef ? { routeRef } : {}),
            ...(voiceRef ? { voiceRef } : {}),
            ...(language ? { language } : {}),
            ...(voice ? { voice } : {}),
            ...(typeof speed === 'number' ? { speed } : {}),
            ...(format ? { format } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
            onProgress: (event) => ctx.emitProgress?.({ phase: event.phase, message: event.message }),
            usageContext: { conversationId: opts.cid, turnId: opts.turnId },
          });
          if (result.ok === false) {
            if (result.requestDisposition !== 'sent' || result.chargeStatus === 'not_charged') synthesizedRequestedPaths.delete(requestedAbs);
            if (result.requestDisposition === 'sent' && result.chargeStatus !== 'not_charged') {
              synthesizedRequestedPaths.add(requestedAbs);
            }
            const disposition = result.requestDisposition ? ` request_disposition=${result.requestDisposition}` : '';
            const charge = result.chargeStatus ? ` charge_status=${result.chargeStatus}` : '';
            const retry = result.retryPolicy ? ` retry_policy=${result.retryPolicy}` : '';
            return { content: `[${result.errorCode}] ${result.message}${disposition}${charge}${retry}`, isError: true } as ToolResult;
          }
          synthesizedRequestedPaths.add(requestedAbs);
          if (opts.onFileWritten) {
            try {
              if (result.billedToOwnAccount) await opts.onFileWritten(result.path, { billedToOwnAccount: true });
              else await opts.onFileWritten(result.path);
            } catch (err) { log.warn('onFileWritten callback failed', { error: logErrorSummary(err) }); }
          }
          let ledgerLine = '';
          if (workspaceRelative(opts)) {
            await noteVideoStudioVoice(ctx, opts, result.path, result.durationSec);
            ledgerLine = await ledgerVideoStudioVoice(ctx, opts, result, { text, ...(language ? { language } : {}), ...(typeof speed === 'number' ? { speed } : {}) });
          }
          const durStr = typeof result.durationSec === 'number' ? `, ${result.durationSec.toFixed(1)}s` : '';
          let fitNote = '';
          if (targetDuration !== undefined && typeof result.durationSec === 'number') {
            if (workspaceRelative(opts)) {
              fitNote = `\nmeasured_duration_sec: ${result.durationSec.toFixed(2)}`
                + `\ntarget_duration_sec: ${targetDuration.toFixed(2)}`
                + `\nduration_delta_sec: ${(result.durationSec - targetDuration).toFixed(2)}`
                + '\nThe target is a planning duration, not a provider-enforced output length. The duration difference alone does not establish missing speech or whether pauses are intentional.';
            } else {
              const { unit, units } = measureNarrationUnits(text);
              const naturalSec = typeof speed === 'number' && speed > 0 ? result.durationSec * speed : result.durationSec;
              const fit = assessNarrationFit({ measuredSec: naturalSec, targetSec: targetDuration, wordCount: units, unit });
              if (fit) fitNote = fit.status === 'fits' ? `\n✅ ${fit.message}` : `\n⚠️ ${fit.message}`;
              if (typeof speed === 'number' && speed > 1.15) {
                fitNote += `\nℹ️ speed=${speed} is doing the fitting — at a natural pace this script is ≈${naturalSec.toFixed(1)}s for a ${targetDuration}s clip. A shorter script at speed ≈1.0 reads better than a fast one.`;
              }
              fitNote += `\nmeasured_duration_sec: ${result.durationSec.toFixed(2)}`
                + '\ntiming_action: This is the audio\'s real length. Its scene must be at least that long: lengthen the scene or shorten the line. Reuse this audio; do not regenerate it just to change the timing.';
            }
          }
          const chatMediaUrl = versionedChatMediaLocalUrl(result.path);
          const summary = `Speech written to ${result.path} (${result.bytes} bytes${durStr}, via ${result.backend}).\n${ledgerLine ? `${ledgerLine}\n` : ''}chat_media_url: ${chatMediaUrl}\nPreview: [${path.basename(result.path)}](${chatMediaUrl})${fitNote}`;
          const content = renamed ? `${summary}${renderRenameSignal(requestedAbs, result.path)}` : summary;
          return { content } as ToolResult;
        }, ctx.signal);
      } finally {
        pendingRequestedPaths.delete(requestedAbs);
      }
    },
  };
}
