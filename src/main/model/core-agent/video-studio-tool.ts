import { parameterError } from '../../../../bin/tool-parameter-errors.cjs';
/**
 * VideoStudio operations the timeline tool hands off (reference inspection, product
 * capture, voices and transcription) and the path helpers both tools use.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { AgentTool, ToolContext, ToolResult } from '#core-agent';
import { prepareLosslessModelImage } from '../../features/image_assets';
import {
  VIDEO_STUDIO_TOOL_CONTRACT,
} from '../../features/video_studio_skill_contract';
import {
  inspectVideoReference,
  transcribeSpeech,
  type VideoStudioOp,
} from '../../features/video_studio';
import {
  captureProductSource,
  normalizeProductCaptureClips,
  normalizeProductCaptureSelectors,
} from '../../features/video_studio_product_capture';
import {
  getTtsAvailabilityDetails,
  listableTtsVoices,
  listTtsCapabilities,
  publicTtsCapabilities,
} from '../../features/tts_capabilities';
import { isPathAllowed } from '../../util/path-sandbox';
import { safeExternalHttpUrl } from '../../util/window-security';
import type { PageVideoResult } from '../../features/web_assist_page_video';
import { getWorkspacePath } from '../../features/user_workspace';
import { chatAttachmentDirForConversation } from '../../util/project-layout';
import { createLogger } from '../../logger';
import { logErrorSummary, logPathRef } from '../../util/log-redact';
import { userLocalRoot } from '../../paths';

const log = createLogger('video-studio-tool');

export interface VideoStudioToolOpts {
  userId: string;
  cid?: string;
  conversationTitle?: string;
  conversationTitleUpdatedAt?: number;
  turnId?: string;
  userMessage?: string;
  /** Host-owned source; never supplied by model arguments or diagnostic metadata. */
  currentUserMessage?: { text: string };
  agentId?: string;
  agentName?: string;
  projectId?: string;
  extraRoots?: readonly string[];
  readOnlyExtraRoots?: readonly string[];
  runtimeReadOnlyRoots?: readonly string[];
  onFileWritten?: (absPath: string) => void | Promise<void>;
  onOutputsPublished?: (absPaths: string[]) => string[] | Promise<string[]>;
  hasProducedPath?: (absPath: string) => boolean;
}

export function allowedRoots(opts: VideoStudioToolOpts): string[] {
  const roots: string[] = [];
  const push = (value: string | undefined) => {
    if (!value) return;
    const resolved = path.resolve(value);
    if (!roots.includes(resolved)) roots.push(resolved);
  };
  try { push(getWorkspacePath(opts.userId, undefined, opts.cid)); }
  catch (err) { log.warn('resolve workspace failed', { error: logErrorSummary(err) }); }
  if (opts.projectId) {
    try { push(getWorkspacePath(opts.userId, opts.projectId, opts.cid)); }
    catch (err) { log.warn('resolve project workspace failed', { error: logErrorSummary(err) }); }
  }
  if (opts.cid) {
    try { push(chatAttachmentDirForConversation(opts.userId, opts.cid)); }
    catch (err) { log.warn('resolve attachment dir failed', { error: logErrorSummary(err) }); }
  }
  for (const root of opts.extraRoots || []) push(root);
  return roots;
}

function isProjectRelativePath(p: string): boolean {
  const first = p.replace(/\\/g, '/').split('/').find(Boolean);
  return first === 'project';
}

export function defaultRoot(opts: VideoStudioToolOpts, ctx: ToolContext): string {
  if (ctx.workingDir) return ctx.workingDir;
  try { return getWorkspacePath(opts.userId, opts.projectId, opts.cid); }
  catch { return '.'; }
}

export function resolvePath(ctx: ToolContext, opts: VideoStudioToolOpts, raw: string, roots: string[]): string {
  const value = String(raw || '').trim();
  if (path.isAbsolute(value)) return path.resolve(value);
  if (ctx.workingDir && isProjectRelativePath(value)) {
    const candidate = path.resolve(ctx.workingDir, value);
    if (isPathAllowed(candidate, roots)) return candidate;
  }
  return path.resolve(defaultRoot(opts, ctx), value);
}

/** Where speech.transcribe saves a transcript nobody named: the project's
 * transcripts folder, keyed by the source path so re-transcribing a file
 * replaces its own transcript and same-named sources do not collide. A Luna
 * drive on 2026-10-31 omitted transcript_path, the transcript lived only in
 * that turn's result, and each later turn reported the ingest records missing.
 * Undefined outside the allowed roots: the transcript is then only returned. */
function defaultTranscriptAbsPath(
  ctx: ToolContext,
  opts: VideoStudioToolOpts,
  inputAbsPath: string,
  roots: string[],
): string | undefined {
  const stem = path.parse(inputAbsPath).name.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  const id = crypto.createHash('sha256').update(path.resolve(inputAbsPath)).digest('hex').slice(0, 8);
  const candidate = resolvePath(ctx, opts, path.join('project', 'transcripts', `${stem || 'media'}-${id}.json`), roots);
  return isPathAllowed(candidate, roots) ? candidate : undefined;
}

function videoStudioStateKey(opts: VideoStudioToolOpts, compositionDirAbs: string): string {
  const identity = [
    opts.userId,
    path.resolve(compositionDirAbs),
  ].join('\0');
  return crypto.createHash('sha256').update(identity).digest('hex').slice(0, 32);
}

export function videoStudioSegmentCachePath(opts: VideoStudioToolOpts, compositionDirAbs: string): string {
  return path.join(userLocalRoot(opts.userId), 'video_studio', 'segment_cache', videoStudioStateKey(opts, compositionDirAbs));
}

/** Refusal content when input_path does not name a readable file, or null when it does. */
async function ensureInputFile(absPath: string): Promise<string | null> {
  const st = await fs.stat(absPath).catch(() => null);
  if (st?.isFile()) return null;
  return resultContent({
    ok: false,
    errorCode: st ? 'E_INPUT_NOT_A_FILE' : 'E_INPUT_FILE_NOT_FOUND',
    message: st ? `input_path names a directory, not a file: ${absPath}` : `input_path does not exist here yet: ${absPath}`,
    next_action: 'retry_with_the_path_that_holds_the_file',
  });
}

export async function notifyWritten(opts: VideoStudioToolOpts, paths: Array<unknown>): Promise<void> {
  if (!opts.onFileWritten) return;
  const seen = new Set<string>();
  const queue = [...paths];
  while (queue.length) {
    const value = queue.shift();
    if (Array.isArray(value)) {
      queue.push(...value);
      continue;
    }
    if (typeof value !== 'string' || !value) continue;
    const abs = path.resolve(value);
    if (seen.has(abs)) continue;
    seen.add(abs);
    try { await opts.onFileWritten(abs); }
    catch (err) { log.warn('onFileWritten failed', { error: logErrorSummary(err) }); }
  }
}

export async function publishVisibleOutputs(opts: VideoStudioToolOpts, paths: Array<unknown>): Promise<void> {
  if (!opts.onOutputsPublished) return;
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [...paths];
  while (queue.length) {
    const value = queue.shift();
    if (Array.isArray(value)) {
      queue.push(...value);
      continue;
    }
    if (typeof value !== 'string' || !value) continue;
    const abs = path.resolve(value);
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  if (!out.length) return;
  try { await opts.onOutputsPublished(out); }
  catch (err) { log.warn('onOutputsPublished failed', { error: logErrorSummary(err) }); }
}

export async function prepareVideoStudioModelVisual(
  absPath: string,
): Promise<{ data: string; mediaType: 'image/png' | 'image/webp' } | null> {
  try {
    const source = await fs.readFile(absPath);
    const prepared = await prepareLosslessModelImage(source);
    return {
      data: prepared.buf.toString('base64'),
      mediaType: prepared.mediaType,
    };
  } catch (err) {
    // Never label unreadable bytes as model-visible evidence.
    log.warn('video visual evidence attachment skipped', {
      path: logPathRef(absPath),
      error: logErrorSummary(err),
    });
    return null;
  }
}

/** `need_user` hands the turn to the user; the bus reads it off the result. */
export function deriveVideoStudioOutcome(result: Record<string, unknown>): 'continue' | 'need_user' {
  if (result.ok === true) return 'continue';
  return result.requires_user_decision === true ? 'need_user' : 'continue';
}

function resultContent(result: Record<string, unknown>): string {
  return JSON.stringify({
    contract_version: VIDEO_STUDIO_TOOL_CONTRACT,
    outcome: deriveVideoStudioOutcome(result),
    ...result,
  }, null, 2);
}

/** Where a reference inspected before any production exists keeps its frames. */
const REFERENCE_FALLBACK_DIR = 'references';

/** The sheet is an active-turn image set: six newer images or the end of the turn drop it,
 *  so only written notes carry the reference into the video. */
const REFERENCE_NOTES_MESSAGE = 'These frames stay in your context until this turn ends or six newer images arrive. '
  + 'If this video is the reference, before writing the video list in reference-notes.md what a viewer would name as its look and whether you reuse, recreate or drop each, then build the video from that list.';

type PageRefusal = { refusal: { errorCode: string; message: string } };

/**
 * reference.inspect from a page link: the task browser opens it where the user
 * can see it and saves the video it plays (web_assist_page_video). The saved file
 * lands in a fresh folder under assets/references for inspection to freeze.
 */
async function saveReferenceFromPage(opts: VideoStudioToolOpts, ctx: ToolContext, rawUrl: string, referencesDir: string, writeRoots: string[]):
Promise<{ path: string; dir: string; host: string; silent: boolean } | PageRefusal> {
  const url = safeExternalHttpUrl(rawUrl);
  if (!url) return { refusal: { errorCode: 'E_REFERENCE_INPUT', message: 'url must be a credential-free http(s) address.' } };
  if (!isPathAllowed(referencesDir, writeRoots)) {
    return { refusal: { errorCode: 'E_PATH_OUT_OF_SCOPE', message: 'Reference evidence must be written inside the writable workspace.' } };
  }
  const unavailable: PageRefusal = { refusal: { errorCode: 'E_REFERENCE_PAGE_UNAVAILABLE',
    message: 'The built-in browser is not available in this task, so the page was not opened. Ask the user to save the video and attach it.' } };
  const cid = opts.cid;
  if (!cid) return unavailable;
  const { browserTaskRunId } = await import('../../features/web_assist_lifecycle');
  const runId = browserTaskRunId(opts.userId, cid);
  const { createModelPageVideoBrowser } = await import('../../features/web_assist');
  const browser = runId
    ? createModelPageVideoBrowser(opts.userId, cid, { ...(ctx.signal ? { signal: ctx.signal } : {}), isActive: () => browserTaskRunId(opts.userId, cid) === runId })
    : null;
  if (!browser) return unavailable;
  let dir = '';
  try {
    await fs.mkdir(referencesDir, { recursive: true });
    dir = await fs.mkdtemp(path.join(referencesDir, 'page-'));
  } catch {
    browser.release();
    return { refusal: { errorCode: 'E_PATH_OUT_OF_SCOPE', message: 'Reference evidence must be written inside the writable workspace.' } };
  }
  const { savePageVideo } = await import('../../features/web_assist_page_video');
  const saved = await savePageVideo(browser, { url, targetDir: dir, ...(ctx.signal ? { signal: ctx.signal } : {}), onProgress: event => ctx.emitProgress?.(event) });
  if (saved.ok) return { path: saved.path, dir, host: saved.host, silent: saved.silent };
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  const failed = saved as Exclude<PageVideoResult, { ok: true }>;
  if (failed.code === 'unavailable') return unavailable;
  if (failed.code === 'cancelled') return { refusal: { errorCode: 'E_REFERENCE_CANCELLED', message: 'Reference inspection was cancelled or timed out.' } };
  if (failed.code === 'no_video') {
    return { refusal: { errorCode: 'E_REFERENCE_PAGE_NO_VIDEO', message: `No video started playing on ${failed.host}. The page stays open in the Browser panel: if it asks the user to sign in or pass a check, ask them to do that there, then call again. Otherwise ask them to save the video and attach it.` } };
  }
  const reason = { no_match: 'no file on the page matched its length', too_large: 'it is larger than 256 MiB', refused: 'the site refused the download' }[failed.reason];
  return { refusal: { errorCode: 'E_REFERENCE_PAGE_NOT_SAVED', message: `The video playing on ${failed.host} could not be saved: ${reason}. Ask the user to save it and attach it.` } };
}

/** The timeline tool owns the model-visible definition, and says where files go. */
export function createVideoStudioTool(opts: VideoStudioToolOpts): AgentTool {
  return {
    name: 'video_studio',
    description: 'Inspect reference videos, capture product pages, list voices and transcribe.',
    inputSchema: { type: 'object', properties: { op: { type: 'string' } }, required: ['op'] },
    async execute(input, ctx) {
      const op = String(input.op || '').trim() as VideoStudioOp;
      const roots = allowedRoots(opts);

      if (op === 'reference.inspect') {
        const refuse = (errorCode: string, message: string) => ({ content: resultContent({ ok: false, op, errorCode, message }), isError: true });
        const raw = typeof input.input_path === 'string' ? input.input_path.trim() : '';
        const rawUrl = typeof input.url === 'string' ? input.url.trim() : '';
        if (raw && rawUrl) return refuse('E_REFERENCE_INPUT', 'Pass input_path or url, not both.');
        if (!raw && !rawUrl) return refuse('E_REFERENCE_INPUT', 'input_path or url is required.');
        const readOnlyRoots = [...(opts.readOnlyExtraRoots || []), ...(opts.runtimeReadOnlyRoots || [])];
        const writeRoots = [defaultRoot(opts, ctx)].filter(root => isPathAllowed(root, [getWorkspacePath(opts.userId, opts.projectId, opts.cid)]));
        const compositionDirAbs = resolvePath(ctx, opts, String(input.composition_dir || REFERENCE_FALLBACK_DIR), roots);
        let inputAbsPath = raw ? resolvePath(ctx, opts, raw, roots) : '';
        let page: { dir: string; host: string; silent: boolean } | null = null;
        try {
          if (rawUrl) {
            const saved = await saveReferenceFromPage(opts, ctx, rawUrl, path.join(compositionDirAbs, 'assets', 'references'), writeRoots);
            if ('refusal' in saved) return refuse(saved.refusal.errorCode, saved.refusal.message);
            page = saved;
            inputAbsPath = saved.path;
          }
          const result = await inspectVideoReference({ inputAbsPath, compositionDirAbs,
            readRoots: [...roots, ...readOnlyRoots], writeRoots, sampleTimes: input.sample_times, signal: ctx.signal });
          if (!result.ok) return { content: resultContent(result), isError: true };
          const visual = await prepareVideoStudioModelVisual(String(result.contact_sheet));
          if (!visual) return { content: resultContent({ ok: false, op, errorCode: 'E_REFERENCE_IMAGE', message: 'Reference frames could not be attached for inspection.' }), isError: true };
          // A saved page video is frozen into the inspection folder; its download folder goes.
          const { input_path: _downloaded, ...inspected } = result;
          const fromPage = page ? { saved_from: page.host } : {};
          const message = page?.silent
            ? `No sound track was found for this video on the page, so the saved copy is silent. ${REFERENCE_NOTES_MESSAGE}`
            : REFERENCE_NOTES_MESSAGE;
          return { content: resultContent({ ...(page ? inspected : result), ...fromPage, message, visual_evidence: { attached: true, role: 'reference_source_frames' } }), images: [visual], imageRetention: 'active_turn' };
        } finally {
          if (page) await fs.rm(page.dir, { recursive: true, force: true }).catch(() => undefined);
        }
      }

      if (op === 'product.capture') {
        if (input.input_path !== undefined && (typeof input.input_path !== 'string' || !input.input_path.trim())) {
          return { content: resultContent({ ok: false, op, errorCode: 'E_PRODUCT_CAPTURE_INPUT', message: 'input_path must be a non-empty local HTML path.' }), isError: true };
        }
        const clips = normalizeProductCaptureClips(input.clips);
        if ('error' in clips) return { content: resultContent({ ok: false, op, errorCode: 'E_PRODUCT_CAPTURE_INPUT', message: clips.error }), isError: true };
        const selectors = normalizeProductCaptureSelectors(input.selectors);
        if ('error' in selectors) return { content: resultContent({ ok: false, op, errorCode: 'E_PRODUCT_CAPTURE_INPUT', message: selectors.error }), isError: true };
        const writeRoots = [defaultRoot(opts, ctx)].filter(root => isPathAllowed(root, [getWorkspacePath(opts.userId, opts.projectId, opts.cid)]));
        const compositionDirAbs = resolvePath(ctx, opts, String(input.composition_dir || REFERENCE_FALLBACK_DIR), roots);
        const localEntry = typeof input.input_path === 'string' && input.input_path.trim()
          ? resolvePath(ctx, opts, input.input_path, roots) : undefined;
        const result = await captureProductSource({ url: String(input.url || ''), compositionDirAbs, writeRoots,
          ...(localEntry ? { inputAbsPath: localEntry, readRoots: roots } : {}),
          clips: clips.clips, selectors: selectors.selectors, signal: ctx.signal });
        if (!result.ok) return { content: resultContent(result), isError: true };
        const { overview_abs_path: overviewAbsPath, ...report } = result;
        const visual = overviewAbsPath ? await prepareVideoStudioModelVisual(String(overviewAbsPath)) : null;
        if (!visual) return { content: resultContent({ ...report, visual_evidence: { attached: false } }) };
        return { content: resultContent({ ...report, visual_evidence: { attached: true, role: 'product_capture_overview' } }), images: [visual], imageRetention: 'active_turn' };
      }

      if (op === 'speech.capabilities') {
        const routes = await listTtsCapabilities(ctx.signal);
        const availability = routes.length > 0
          ? { available: true as const, reason: 'available' as const }
          : getTtsAvailabilityDetails(false);
        // The catalog is ~100 voices and the selection rule below is the host's
        // own; applying it here costs one optional argument and saves the model
        // a result larger than its whole inline budget. all_voices reopens the
        // full eligible catalog for a user who named a specific voice.
        const wantedLanguage = String(input.language || '').trim();
        const listingLimit = input.all_voices === true ? Number.POSITIVE_INFINITY : undefined;
        const listings = publicTtsCapabilities(routes).map((route) => ({
          route,
          listing: listableTtsVoices(route.voices, {
            ...(wantedLanguage ? { language: wantedLanguage } : {}),
            ...(listingLimit === undefined ? {} : { limit: listingLimit }),
          }),
        }));
        const eligibleTotal = listings.reduce((sum, item) => sum + item.listing.eligible, 0);
        return {
          content: resultContent({
            ok: routes.length > 0,
            op,
            status: routes.length ? 'ready' : 'unavailable',
            availability: availability.reason,
            ...(!availability.available ? {
              error_code: availability.errorCode,
              message: availability.message,
              next_action: availability.nextAction,
            } : {}),
            ...(wantedLanguage ? { requested_language: wantedLanguage } : {}),
            ...(wantedLanguage && routes.length && eligibleTotal === 0 ? {
              message: `No configured voice is verified for ${wantedLanguage}. Narrate in a language a listed route covers, or call again with all_voices true to see every voice this account has.`,
            } : {}),
            routes: listings.map(({ route, listing }) => ({
              route_ref: route.routeRef,
              provider: route.provider,
              model: route.model,
              display_name: route.displayName,
              catalog_status: route.catalogStatus,
              default_voice_ref: route.defaultVoiceRef,
              voice_count: listing.eligible,
              ...(listing.voices.length < listing.eligible
                ? { voices_shown: listing.voices.length }
                : {}),
              voices: listing.voices.map((voice) => ({
                voice_ref: voice.voiceRef,
                display_name: voice.displayName,
                locale: voice.locale,
                native_locale: voice.nativeLocale,
                supported_locales: voice.supportedLocales,
                mixed_language_support: voice.mixedLanguageSupport,
                language_confidence: voice.languageConfidence,
                // Only when nothing named the voice's language. The host lists
                // it BECAUSE it cannot be ruled out for the requested
                // language; without saying so, `supported_locales:["und"]`
                // reads as proof it speaks something else.
                ...(voice.languageDeclared === false
                  ? {
                    language_declared: false,
                    language_note: 'This endpoint publishes no voice catalog, so nothing declares what this voice speaks.'
                      + ' It is listed because it cannot be ruled out for the requested language, not because it was checked.'
                      + ' It is usable: select it, and judge the language from the first synthesized line.',
                  }
                  : {}),
                ...(voice.accent ? { accent: voice.accent } : {}),
                gender: voice.gender,
                style_tags: voice.styleTags,
                use_cases: voice.useCases,
                is_default: voice.isDefault,
              })),
              supports: route.supports,
            })),
            invariant: 'When no route is listed, narration cannot be synthesized at all: the ways out are delivering with captions and no narration track, or the setup named by this result. Choose only a returned route_ref + voice_ref pair. Pass language to list only the voices verified for the deliverable language; without it the list spans every language, a voice qualifies on native_locale or verified supported_locales, language_confidence=candidate stays unavailable for non-native production until verified EXCEPT when language_declared is false, which means nothing declares this voice\'s language at all — such a voice is listed because it cannot be ruled out and is usable, so select it rather than abandoning narration, and mixed_language_support permits inline foreign tokens rather than an unsupported narration language. voices_shown under voice_count means the list is a use-case-diverse sample of the eligible voices — pass all_voices true for the rest, as when the user named a particular voice. Never invent or pass an ad hoc provider voice id.',
          }),
          isError: routes.length === 0,
        } as ToolResult;
      }

      if (op !== 'speech.transcribe') {
        return parameterError('op must be one of: reference.inspect, product.capture, speech.capabilities, speech.transcribe', ['op'], 'invalid_value');
      }
      const inputRaw = String(input.input_path || '').trim();
      if (!inputRaw) return parameterError('input_path is required for speech.transcribe', ['input_path'], 'required');
      const inputAbsPath = resolvePath(ctx, opts, inputRaw, roots);
      if (!isPathAllowed(inputAbsPath, roots)) {
        return { content: `E_PATH_OUT_OF_SCOPE: input_path is outside scope: ${inputAbsPath}`, isError: true } as ToolResult;
      }
      const fileErr = await ensureInputFile(inputAbsPath);
      if (fileErr) return { content: fileErr, isError: true } as ToolResult;

      const requestedTranscript = typeof input.transcript_path === 'string' && input.transcript_path.trim()
        ? resolvePath(ctx, opts, input.transcript_path, roots)
        : undefined;
      if (requestedTranscript && !isPathAllowed(requestedTranscript, roots)) {
        return { content: `E_PATH_OUT_OF_SCOPE: transcript_path is outside scope: ${requestedTranscript}`, isError: true } as ToolResult;
      }
      const transcriptAbsPath = requestedTranscript ?? defaultTranscriptAbsPath(ctx, opts, inputAbsPath, roots);
      const result = await transcribeSpeech({
        inputAbsPath,
        ...(transcriptAbsPath ? { transcriptAbsPath } : {}),
        ...(typeof input.model === 'string' && input.model.trim() ? { model: input.model.trim() } : {}),
        ...(typeof input.language === 'string' && input.language.trim() ? { language: input.language.trim() } : {}),
        timestamps: input.timestamps === 'segment' ? 'segment' : 'word',
        allowModelDownload: input.allow_model_download === true,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        onProgress: (event) => ctx.emitProgress?.(event),
      });
      if (result.ok) await notifyWritten(opts, [result.transcript_path]);
      else if (result.text_path) await notifyWritten(opts, [result.text_path]);
      return { content: resultContent(result), isError: result.ok === false } as ToolResult;
    },
  };
}
