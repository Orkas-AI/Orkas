import type { NarrationDurationEstimate } from '../../util/narration-timing';
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
  narrationDurationCalibrationScale,
  NARRATION_ESTIMATE_OVER_RATIO,
  NARRATION_FILL_RETRY_LIMIT,
  NARRATION_MEASURED_OVER_RATIO,
} from '../../features/tts';
import { getTtsAvailabilityDetails, listTtsCapabilities, publicTtsCapabilities, listableTtsVoices, resolveTtsSelection } from '../../features/tts_capabilities';
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

const MAX_PREFLIGHT_LINES = 50;
const MAX_PREFLIGHT_LINE_CHARS = 4000;

function narrationOverrun(estimate: NarrationDurationEstimate, targetSec: number, scale: number | null) {
  const estimatedSec = Math.round(estimate.estimatedSec * (scale ?? 1) * 100) / 100;
  if (estimatedSec <= targetSec * (scale ? NARRATION_MEASURED_OVER_RATIO : NARRATION_ESTIMATE_OVER_RATIO)) return null;
  const keepRatio = targetSec / estimatedSec;
  return {
    estimated_sec: estimatedSec,
    target_sec: targetSec,
    over_by_sec: Math.round((estimatedSec - targetSec) * 100) / 100,
    trim_percent: Math.max(1, Math.ceil((1 - keepRatio) * 100)),
    suggested_units: Math.max(1, Math.floor(estimate.units * keepRatio)),
    unit: estimate.unit,
  };
}

function timedLines(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PREFLIGHT_LINES) return null;
  const lines: { text: string; target_duration: number }[] = [];
  for (const item of value) {
    const text = typeof item?.text === 'string' ? item.text.trim() : '';
    const duration = item?.target_duration;
    if (!text || text.length > MAX_PREFLIGHT_LINE_CHARS || typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) return null;
    lines.push({ text, target_duration: duration });
  }
  return lines;
}

export function createGenerateSpeechTool(opts: GenerateSpeechToolOpts): AgentTool {
  // A successful synthesis or a dispatched request with unknown charge status
  // may be billable. Keep the requested destination as the per-turn
  // idempotency key so an agent cannot repeatedly overwrite or retry the same
  // narration while trial-and-error fitting its duration. A line whose result
  // asked for a longer one may take its path again, up to the fill limit below.
  const synthesizedRequestedPaths = new Set<string>();
  const pendingRequestedPaths = new Set<string>();
  // Estimated and measured seconds of each voice's lines this turn. The estimate reads one
  // fixed pace for every voice; on 2026-11-14 a voice read Chinese about 1.5x faster, so lines
  // that fit were refused and a longer retry after a measured line was refused again.
  // Summing by length keeps a short line's leading and trailing silence from setting the pace.
  const voicePace = new Map<string, { estimatedSec: number; measuredSec: number }>();
  const measuredScale = (key: string) => {
    const pace = voicePace.get(key);
    return pace ? narrationDurationCalibrationScale({ genericEstimatedSec: pace.estimatedSec, measuredSec: pace.measuredSec }) : null;
  };
  // Short lines this turn asked to be generated again, by requested path: how many fills each
  // was asked for, and which may take the next one. A fill goes to the same file, so the path
  // names the line (2026-11-15: counting by voice and target length took three scenes of one
  // length for one line, and missed a line whose target changed).
  const fillsRequested = new Map<string, number>();
  const fillOpenPaths = new Set<string>();
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
        action: { type: 'string', enum: ['generate', 'capabilities', 'preflight'], description: 'Default generate requires text and output_path. preflight checks timed narration without synthesis. capabilities lists the configured voices.' },
        lines: {
          type: 'array', minItems: 1, maxItems: MAX_PREFLIGHT_LINES,
          description: 'For preflight: ordered timed lines sharing the top-level voice settings. The result uses 1-based input indexes.',
          items: { type: 'object', required: ['text', 'target_duration'], properties: {
            text: { type: 'string', minLength: 1, maxLength: MAX_PREFLIGHT_LINE_CHARS },
            target_duration: { type: 'number', exclusiveMinimum: 0, description: 'Seconds available for this line.' },
          } },
        },
        text: { type: 'string', description: 'The text to speak.' },
        output_path: {
          type: 'string',
          description: workspaceRelative(opts)
            ? 'Where to write audio. Absolute or workspace-relative; must be in workspace/attachments. Extension optional. Each requested path may be used once per turn, or again when its result asks for a longer line.'
            : 'Where to write audio. `project/...` resolves under the workspace; other relative paths prefer chat attachments. Extension optional. Each requested path may be used once per turn, or again when its result asks for a longer line.',
        },
        route_ref: { type: 'string', description: 'Configured TTS route returned by capabilities; optionally filters capability listings.' },
        voice_ref: { type: 'string', description: 'Route-bound voice returned by capabilities. Never invent a provider id.' },
        offset: { type: 'integer', minimum: 0, description: 'Zero-based voice offset per route for capabilities; defaults to 0. Returns up to 20 eligible voices per route.' },
        language: { type: 'string', description: 'BCP-47 speech language, such as zh-CN or en-US; filters capabilities.' },
        voice: { type: 'string', description: 'Legacy provider voice id. Prefer route_ref + voice_ref.' },
        speed: { type: 'number', description: 'Speech speed multiplier (1.0 = normal). Optional.' },
        format: { type: 'string', description: 'Audio format: mp3 (default) / wav / opus. Optional.' },
        target_duration: { type: 'number', description: 'Target clip length in seconds. Required for timed media so overlong text is rejected before a paid request; result reports fit and suggested adjustment.' },
      },
    },
    async execute(input, ctx) {
      const action = input.action ?? 'generate';
      if (action !== 'generate' && action !== 'capabilities' && action !== 'preflight') {
        return parameterError('action must be generate, capabilities or preflight', ['action'], 'invalid_value');
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
      const speed = typeof input.speed === 'number' ? input.speed : undefined;
      const routeRef = appRoute || (typeof input.route_ref === 'string' && input.route_ref.trim() ? input.route_ref.trim() : undefined);
      const voiceRef = typeof input.voice_ref === 'string' && input.voice_ref.trim() ? input.voice_ref.trim() : undefined;
      const language = typeof input.language === 'string' && input.language.trim() ? input.language.trim() : undefined;
      const voice = typeof input.voice === 'string' && input.voice.trim() ? input.voice.trim() : undefined;
      const paceKey = `${routeRef ?? ''}\0${voiceRef ?? voice ?? ''}\0${language ?? ''}`;
      if (action === 'preflight') {
        const lines = timedLines(input.lines);
        if (!lines) return parameterError('lines must contain 1 to 50 timed lines, each with non-empty text up to 4000 characters and a positive target_duration in seconds.', ['lines'], 'invalid_value');
        const selection = await resolveTtsSelection({ routeRef, voiceRef, legacyVoice: voice, language, signal: ctx.signal });
        if (selection.ok === false) return {
          isError: true,
          content: JSON.stringify({
            ok: false, code: selection.errorCode, message: selection.message,
            synthesis_sent: false,
          }),
        };
        const scale = measuredScale(paceKey);
        const overruns = lines.flatMap(({ text, target_duration }, index) => {
          const overrun = narrationOverrun(estimateNarrationDuration(text, speed), target_duration, scale);
          return overrun ? [{ index: index + 1, ...overrun }] : [];
        });
        return { content: JSON.stringify({
          ok: !overruns.length, calibrated: scale !== null, lines: overruns, synthesis_sent: false,
          ...(overruns.length ? { code: 'E_TTS_TEXT_TOO_LONG', message: 'Shorten the flagged lines or give their scenes more time before generating them.' } : {}),
        }) };
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
      const targetDuration = typeof input.target_duration === 'number' && input.target_duration > 0 ? input.target_duration : undefined;
      const roots = allowedRoots(opts);
      const requestedAbs = withAudioExtension(resolveOutputAbs(ctx, opts, outputPathRaw, roots), format);
      if ((synthesizedRequestedPaths.has(requestedAbs) && !fillOpenPaths.has(requestedAbs)) || pendingRequestedPaths.has(requestedAbs)) {
        return {
          content: 'E_TTS_ALREADY_GENERATED_THIS_TURN: This output_path already has a successful or potentially billable speech request in the current turn. Reuse the result, or wait for explicit user action before starting a later retry. To voice a changed line, give it a new output_path, such as voice/hook-2.mp3.',
          isError: true,
        } as ToolResult;
      }
      const estimate = estimateNarrationDuration(text, speed);
      if (targetDuration !== undefined) {
        const overrun = narrationOverrun(estimate, targetDuration, measuredScale(paceKey));
        if (overrun) {
          return {
            content: `E_TTS_TEXT_TOO_LONG: Estimated natural narration is ${overrun.estimated_sec}s for a ${targetDuration}s target. Shorten by about ${overrun.trim_percent}% (to roughly ${overrun.suggested_units} ${estimate.unit} at the same language mix) before retrying. No speech request was sent.`,
            isError: true,
          } as ToolResult;
        }
      }
      const isMine: (p: string) => boolean = opts.hasProducedPath ? (p) => opts.hasProducedPath!(p) : () => false;
      pendingRequestedPaths.add(requestedAbs);
      fillOpenPaths.delete(requestedAbs);
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
          if (typeof result.durationSec === 'number' && result.durationSec > 0 && estimate.estimatedSec > 0) {
            const pace = voicePace.get(paceKey);
            voicePace.set(paceKey, {
              estimatedSec: (pace?.estimatedSec ?? 0) + estimate.estimatedSec,
              measuredSec: (pace?.measuredSec ?? 0) + result.durationSec,
            });
          }
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
            const { unit, units } = measureNarrationUnits(text);
            const naturalSec = typeof speed === 'number' && speed > 0 ? result.durationSec * speed : result.durationSec;
            const fills = fillsRequested.get(requestedAbs) ?? 0;
            const fillLimitReached = fills >= NARRATION_FILL_RETRY_LIMIT;
            const fit = assessNarrationFit({ measuredSec: naturalSec, targetSec: targetDuration, wordCount: units, unit, fillLimitReached });
            if (fit?.status === 'under' && !fillLimitReached) {
              fillsRequested.set(requestedAbs, fills + 1);
              fillOpenPaths.add(requestedAbs);
            }
            if (fit) fitNote = fit.status === 'fits' ? `\n✅ ${fit.message}` : `\n⚠️ ${fit.message}`;
            if (typeof speed === 'number' && speed > 1.15) {
              fitNote += `\nℹ️ speed=${speed} is doing the fitting — at a natural pace this script is ≈${naturalSec.toFixed(1)}s for a ${targetDuration}s clip. A shorter script at speed ≈1.0 reads better than a fast one.`;
            }
            // A short line is filled by a longer one, not by cutting its scene, when the user asked
            // for a length (2026-11-15: trimming scenes to short lines took the average video from
            // 15.1s to 11.7s). Otherwise the scene ends with its line (2026-11-16: a 72 s explainer
            // kept every planned scene and had 1.2-2.6 s of silence before each cut).
            fitNote += `\nmeasured_duration_sec: ${result.durationSec.toFixed(2)}`
              + (fit?.status !== 'under'
                ? '\ntiming_action: This is the audio\'s real length. Its scene must be at least that long: lengthen the scene or shorten the line. When the user did not ask for this video\'s length, make the scene this audio plus about half a second. Reuse this audio; do not regenerate it just to change the timing.'
                : fillLimitReached
                  ? '\ntiming_action: This is the audio\'s real length. Keep this audio and the scene\'s planned length; do not generate this line again this turn.'
                  : '\ntiming_action: This is the audio\'s real length. When the user asked for this video\'s length, keep the scene at its planned length: replace this line with the longer one rather than cutting the scene to this audio. Otherwise make the scene this audio plus about half a second and keep this audio.');
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
