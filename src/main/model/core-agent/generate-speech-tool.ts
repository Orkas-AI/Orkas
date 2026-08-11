/**
 * `generate_speech` tool — text-to-speech narration via features/tts
 * (pluggable backend: Doubao or BYO OpenAI-compatible /audio/speech).
 * Generic built-in speech generation primitive; VideoStudio is one caller.
 *
 * Permission + path scope mirror the other file-writing generation tools.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { AgentTool, ToolContext, ToolResult } from '#core-agent';
import { getLocalExecGranted } from '../../features/permissions';
import {
  generateSpeech,
  hasConfiguredTtsProvider,
  assessNarrationFit,
  estimateNarrationDuration,
  measureNarrationUnits,
} from '../../features/tts';
import { getTtsAvailabilityDetails } from '../../features/tts_capabilities';
import { isPathAllowed } from '../../util/path-sandbox';
import { uniquifyPath, renderRenameSignal } from '../../util/uniquify-path';
import { getWorkspacePath } from '../../features/user_workspace';
import { chatAttachmentDirForConversation } from '../../util/project-layout';
import { versionedChatMediaLocalUrl } from '../../util/chat-media-url';
import { createLogger } from '../../logger';
import {
  recordVideoProductionNarrationLine,
  validateVideoProductionPlanApproval,
  videoProductionControlStatePath,
} from '../../features/video_production_control';

const log = createLogger('generate-speech-tool');
const VIDEO_STUDIO_AGENT_ID = '79df9cc89f5f';

const DENY_MESSAGE =
  'E_TOOL_EXECUTION_ACCESS_DISABLED: Tool execution access is disabled, so command execution and file writes were not run. ' +
  'Ask the user to open Settings > Tool Execution Access and enable "Enable Tool Execution Access", then retry.';

export interface GenerateSpeechToolOpts {
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

function allowedRoots(opts: GenerateSpeechToolOpts): string[] {
  const roots: string[] = [];
  const pushRoot = (root: string | undefined) => {
    if (!root) return;
    const resolved = path.resolve(root);
    if (!roots.includes(resolved)) roots.push(resolved);
  };
  try {
    pushRoot(getWorkspacePath(opts.userId));
  } catch (err) { log.warn(`resolve workspace: ${(err as Error).message}`); }
  if (opts.projectId) {
    try { pushRoot(getWorkspacePath(opts.userId, opts.projectId)); }
    catch (err) { log.warn(`resolve project workspace: ${(err as Error).message}`); }
  }
  if (opts.cid) {
    try { pushRoot(chatAttachmentDirForConversation(opts.userId, opts.cid)); }
    catch (err) { log.warn(`resolve attachment dir: ${(err as Error).message}`); }
  }
  return roots;
}

function defaultOutputRoot(opts: GenerateSpeechToolOpts, ctx: ToolContext): string {
  if (opts.cid) {
    try { return chatAttachmentDirForConversation(opts.userId, opts.cid); }
    catch (err) { log.warn(`resolve default attachment dir: ${(err as Error).message}`); }
  }
  try {
    const ws = getWorkspacePath(opts.userId);
    if (ws) return ws;
  } catch (err) { log.warn(`resolve default workspace: ${(err as Error).message}`); }
  if (opts.projectId) {
    try {
      const ws = getWorkspacePath(opts.userId, opts.projectId);
      if (ws) return ws;
    } catch (err) { log.warn(`resolve fallback project workspace: ${(err as Error).message}`); }
  }
  return ctx.workingDir ?? '.';
}

function isProjectRelativePath(p: string): boolean {
  const first = p.replace(/\\/g, '/').split('/').find(Boolean);
  return first === 'project';
}

function resolveOutputAbs(ctx: ToolContext, opts: GenerateSpeechToolOpts, p: string, roots: string[]): string {
  if (path.isAbsolute(p)) return path.resolve(p);
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

/** What the verified EDL binding is, so the caller can record what it produced
 * against the same plan it was just checked against. Returning only a verdict
 * left the host holding the plan identity it had already resolved and throwing
 * it away, which is why nothing recorded the narration it then synthesized. */
type VideoStudioNarrationBinding = {
  statePath: string;
  planAbs: string;
  planSignature: string;
  segmentIndex: number;
};

async function validateVideoStudioNarrationBinding(input: {
  opts: GenerateSpeechToolOpts;
  ctx: ToolContext;
  roots: string[];
  planPath: string;
  segmentIndex: number;
  text: string;
  routeRef: string;
  voiceRef: string;
  language: string;
  speed?: number;
  targetDuration?: number;
}): Promise<string | VideoStudioNarrationBinding> {
  const planAbs = resolveOutputAbs(input.ctx, input.opts, input.planPath, input.roots);
  if (!isPathAllowed(planAbs, input.roots)) return 'E_PATH_OUT_OF_SCOPE: production_plan_path is outside scope.';
  try {
    const statePath = videoProductionControlStatePath({
      userId: input.opts.userId,
      ...(input.opts.projectId ? { projectId: input.opts.projectId } : {}),
      planPath: planAbs,
    });
    const { identity } = await validateVideoProductionPlanApproval({ statePath, planPath: planAbs });
    const plan = JSON.parse(await fs.readFile(planAbs, 'utf8')) as Record<string, unknown>;
    const tracks = plan.tracks as Record<string, unknown> | undefined;
    const narration = tracks?.narration as Record<string, unknown> | undefined;
    const synthesis = narration?.synthesis as Record<string, unknown> | undefined;
    const segments = Array.isArray(narration?.segments) ? narration.segments : [];
    const line = segments[input.segmentIndex] as Record<string, unknown> | undefined;
    if (!synthesis || !line) {
      return 'E_TTS_PLAN_BINDING_MISSING: the approved narration synthesis or requested line is missing.';
    }
    if (String(synthesis.route_ref || '') !== input.routeRef
      || String(synthesis.voice_ref || '') !== input.voiceRef
      || String(synthesis.language || '') !== input.language
      || Number(synthesis.speed) !== (input.speed ?? 1)) {
      return 'E_TTS_SELECTION_OVERRIDE_FORBIDDEN: route_ref, voice_ref, language, and speed must match the confirmed production plan narration synthesis exactly.';
    }
    if (String(line.text || '').trim() !== input.text) {
      return 'E_TTS_PLAN_TEXT_MISMATCH: speech text must match the selected confirmed production plan narration line exactly.';
    }
    const plannedTarget = Number(line.target_sec);
    if (Number.isFinite(plannedTarget)
      && (!(typeof input.targetDuration === 'number') || Math.abs(input.targetDuration - plannedTarget) > 0.001)) {
      return 'E_TTS_PLAN_DURATION_MISMATCH: target_duration must match the selected narration line target_sec.';
    }
    return {
      statePath,
      planAbs,
      planSignature: identity.signature,
      segmentIndex: input.segmentIndex,
    };
  } catch (err) {
    return (err as Error).message;
  }
}

export function createGenerateSpeechTool(opts: GenerateSpeechToolOpts): AgentTool {
  // A successful synthesis or a dispatched request with unknown charge status
  // may be billable. Keep the requested destination as the per-turn
  // idempotency key so an agent cannot repeatedly overwrite or retry the same
  // narration while trial-and-error fitting its duration.
  const synthesizedRequestedPaths = new Set<string>();
  return {
    name: 'generate_speech',
    description:
      'Synthesize narration/voiceover audio to a workspace or attachment file. Timed media MUST pass target_duration so overlong text is rejected before any paid request; shorten it and call once. VideoStudio COMPOSE narration is stage-owned and must use video_studio composition.materialize_narration instead. Do not regenerate the same output_path in one turn. Present the returned chat_media_url so the chat renders audio.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text to speak.' },
        output_path: { type: 'string', description: 'Where to write audio. `project/...` paths resolve under the current workspace; other relative paths prefer chat attachments. Extension optional.' },
        route_ref: { type: 'string', description: 'Configured TTS route returned by video_studio speech.capabilities.' },
        voice_ref: { type: 'string', description: 'Route-bound voice returned by video_studio speech.capabilities. VideoStudio plans must use this instead of inventing provider ids.' },
        language: { type: 'string', description: 'BCP-47 narration language supported by the selected voice and signed during production plan confirmation, such as zh-CN or en-US.' },
        voice: { type: 'string', description: 'Legacy provider voice id. New VideoStudio plans use route_ref + voice_ref.' },
        speed: { type: 'number', description: 'Speech speed multiplier (1.0 = normal). Optional.' },
        format: { type: 'string', description: 'Audio format: mp3 (default) / wav / opus. Optional.' },
        target_duration: { type: 'number', description: 'Optional target clip length in seconds; result reports fit and suggested text/speed adjustment.' },
        production_plan_path: { type: 'string', description: 'For VideoStudio EDL narration, the confirmed project/plan.json that owns this synthesis selection and line.' },
        narration_segment_index: { type: 'number', description: 'Zero-based tracks.narration.segments index in production_plan_path. Required with route_ref/voice_ref for VideoStudio.' },
      },
      required: ['text', 'output_path'],
    },
    async execute(input, ctx) {
      if (!getLocalExecGranted()) {
        return { content: DENY_MESSAGE, isError: true } as ToolResult;
      }
      const text = String(input.text ?? '').trim();
      const outputPathRaw = String(input.output_path ?? '').trim();
      if (!text) return { content: 'text is required', isError: true } as ToolResult;
      if (!outputPathRaw) return { content: 'output_path is required', isError: true } as ToolResult;
      const normalizedOutputPath = outputPathRaw.replace(/\\/g, '/').toLowerCase();
      if (opts.agentId === VIDEO_STUDIO_AGENT_ID
        && /(?:^|\/)composition(?:\/|$)/.test(normalizedOutputPath)) {
        return {
          content: 'E_COMPOSE_NARRATION_STAGE_OWNED: VideoStudio must not generate speech directly inside a COMPOSE directory. Write approved scene narration_text, run composition.prepare, then use video_studio composition.materialize_narration so timing and VideoProductionStateV1 are updated atomically.',
          isError: true,
        } as ToolResult;
      }

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
      const routeRef = typeof input.route_ref === 'string' && input.route_ref.trim() ? input.route_ref.trim() : undefined;
      const voiceRef = typeof input.voice_ref === 'string' && input.voice_ref.trim() ? input.voice_ref.trim() : undefined;
      const language = typeof input.language === 'string' && input.language.trim() ? input.language.trim() : undefined;
      const voice = typeof input.voice === 'string' && input.voice.trim() ? input.voice.trim() : undefined;
      const targetDuration = typeof input.target_duration === 'number' && input.target_duration > 0 ? input.target_duration : undefined;

      const roots = allowedRoots(opts);
      let narrationBinding: VideoStudioNarrationBinding | undefined;
      if (opts.agentId === VIDEO_STUDIO_AGENT_ID && (routeRef || voiceRef)) {
        const planPath = typeof input.production_plan_path === 'string' ? input.production_plan_path.trim() : '';
        const segmentIndex = typeof input.narration_segment_index === 'number'
          ? input.narration_segment_index
          : -1;
        if (!routeRef || !voiceRef || !language || !planPath || !Number.isInteger(segmentIndex) || segmentIndex < 0) {
          return {
            content: 'E_TTS_PLAN_BINDING_REQUIRED: VideoStudio EDL narration with runtime voice refs requires route_ref, voice_ref, language, production_plan_path, and a non-negative narration_segment_index.',
            isError: true,
          } as ToolResult;
        }
        const binding = await validateVideoStudioNarrationBinding({
          opts,
          ctx,
          roots,
          planPath,
          segmentIndex,
          text,
          routeRef,
          voiceRef,
          language,
          ...(typeof speed === 'number' ? { speed } : {}),
          ...(typeof targetDuration === 'number' ? { targetDuration } : {}),
        });
        if (typeof binding === 'string') return { content: binding, isError: true } as ToolResult;
        narrationBinding = binding;
      }
      const requestedAbs = withAudioExtension(resolveOutputAbs(ctx, opts, outputPathRaw, roots), format);
      if (synthesizedRequestedPaths.has(requestedAbs)) {
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
            content: `E_TTS_TEXT_TOO_LONG: Estimated natural narration is ${estimate.estimatedSec}s for a ${targetDuration}s target. Shorten by about ${trimPercent}% (to roughly ${maxUnits} ${estimate.unit} at the same language mix) before retrying. No speech request was sent.`,
            isError: true,
          } as ToolResult;
        }
      }
      const isMine: (p: string) => boolean = opts.hasProducedPath ? (p) => opts.hasProducedPath!(p) : () => false;
      const { finalPath: outputAbs, renamed } = await uniquifyPath(requestedAbs, isMine);
      if (!isPathAllowed(outputAbs, roots)) {
        return { content: `E_PATH_OUT_OF_SCOPE: output_path is outside scope (workspace + attachments): ${outputAbs}`, isError: true } as ToolResult;
      }

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
      });
      if (result.ok === false) {
        if (result.requestDisposition === 'sent' && result.chargeStatus !== 'not_charged') {
          synthesizedRequestedPaths.add(requestedAbs);
        }
        const disposition = result.requestDisposition ? ` request_disposition=${result.requestDisposition}` : '';
        const charge = result.chargeStatus ? ` charge_status=${result.chargeStatus}` : '';
        const retry = result.retryPolicy ? ` retry_policy=${result.retryPolicy}` : '';
        return { content: `[${result.errorCode}] ${result.message}${disposition}${charge}${retry}`, isError: true } as ToolResult;
      }
      synthesizedRequestedPaths.add(requestedAbs);
      if (narrationBinding) {
        // After the bytes, never before: this records what happened and must
        // not be able to block or repeat a paid synthesis.
        await recordVideoProductionNarrationLine({
          statePath: narrationBinding.statePath,
          planPath: narrationBinding.planAbs,
          planSignature: narrationBinding.planSignature,
          line: {
            segment_index: narrationBinding.segmentIndex,
            path: result.path,
            ...(typeof result.durationSec === 'number' ? { measured_duration_sec: result.durationSec } : {}),
            backend: result.backend,
            language: language || '',
            ...(typeof speed === 'number' ? { speed } : {}),
          },
          // The binding validator has already proven these equal the approved
          // plan line, so this identity is the plan's own.
          identity: {
            text,
            routeRef: routeRef || '',
            voiceRef: voiceRef || '',
            language: language || '',
            ...(typeof speed === 'number' ? { speed } : {}),
          },
        }).catch((err) => log.warn(`narration line record failed: ${(err as Error).message}`));
      }
      if (opts.onFileWritten) {
        try { await opts.onFileWritten(result.path); }
        catch (err) { log.warn(`onFileWritten callback failed: ${(err as Error).message}`); }
      }
      const durStr = typeof result.durationSec === 'number' ? `, ${result.durationSec.toFixed(1)}s` : '';
      let fitNote = '';
      if (targetDuration !== undefined && typeof result.durationSec === 'number') {
        const { unit, units } = measureNarrationUnits(text);
        // A production-bound line is judged against the bytes that will actually
        // be mixed into its signed window. Backing `speed` out there made the
        // guidance call a line "over" while Gate B correctly saw the recorded
        // audio fit, so the promised inherited trim was refused and the user's
        // approval was invalidated. Standalone speech keeps the natural-pace
        // quality judgement because no signed production window owns it.
        const naturalSec = typeof speed === 'number' && speed > 0 ? result.durationSec * speed : result.durationSec;
        const fitBasisSec = narrationBinding ? result.durationSec : naturalSec;
        const fit = assessNarrationFit({ measuredSec: fitBasisSec, targetSec: targetDuration, wordCount: units, unit });
        if (fit) fitNote = fit.status === 'fits' ? `\n✅ ${fit.message}` : `\n⚠️ ${fit.message}`;
        if (typeof speed === 'number' && speed > 1.15) {
          fitNote += narrationBinding
            ? `\nℹ️ speed=${speed} makes this read ≈${naturalSec.toFixed(1)}s at a natural pace. This is a quality note only: measured_duration_sec remains the authority for the signed window; when the measured audio fits, changing the signed text or speed is a plan amendment.`
            : `\nℹ️ speed=${speed} is doing the fitting — at a natural pace this script is ≈${naturalSec.toFixed(1)}s for a ${targetDuration}s clip. A shorter script at speed ≈1.0 reads better than a fast one.`;
        }
        // Which timing is authoritative depends on who owns the window, and
        // `narrationBinding` is that answer: a bound line's window was signed
        // at Gate B and the video is cut to it, so retiming the plan to the
        // audio is the one thing that must not happen. The advice used to say
        // "for a standalone narrated composition" and then be appended to
        // every call regardless. On the 2026-08-10 AUTO run all seven lines
        // were plan-bound and all seven were told to retime the scene map,
        // directly against the shortfall warning printed one line above.
        fitNote += `\nmeasured_duration_sec: ${result.durationSec.toFixed(2)}`
          + (narrationBinding
            ? fit?.status === 'over'
              ? '\ntiming_action: measured_duration_sec is the authority for this approved production line and it exceeds target_duration.'
                + ' Keep the signed windows fixed; shorten only this line and re-synthesize. A trim within the plan\'s timing-repair'
                + ' budget can inherit the current approval, while a broader rewrite is a plan amendment.'
              : fit?.status === 'under'
                ? '\ntiming_action: measured_duration_sec is the authority for this approved production line and it finishes before target_duration.'
                  + ' Keep the signed text, speed, and window; leave the remaining silence and do not slow the read merely to fill it.'
                  + ' A deliberate text or speed change is a plan amendment.'
                : '\ntiming_action: measured_duration_sec is the authority for this approved production line and it fits target_duration.'
                  + ' Keep the signed text, speed, and window; do not retime the plan or trigger a timing-repair edit.'
                  + ' A quality-driven text or speed change is a plan amendment.'
            : '\ntiming_action: Use measured_duration_sec as the source of truth for this standalone narrated VideoStudio composition. '
              + 'Retime the scene map, HTML timeline, and audio track to this duration; reuse this audio and do not regenerate merely to match target_duration. '
              + 'If the user requires an exact fixed duration, ask before another paid synthesis.');
      }
      const chatMediaUrl = versionedChatMediaLocalUrl(result.path);
      const summary = `Speech written to ${result.path} (${result.bytes} bytes${durStr}, via ${result.backend}).\nchat_media_url: ${chatMediaUrl}\nPreview: [${path.basename(result.path)}](${chatMediaUrl})${fitNote}`;
      const content = renamed ? `${summary}${renderRenameSignal(requestedAbs, result.path)}` : summary;
      return { content } as ToolResult;
    },
  };
}
