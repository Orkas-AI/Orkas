/**
 * Rotating provider wrapper — transparently tries multiple credential
 * candidates for the same `(provider, model)` before yielding any content
 * to the caller.
 *
 * ## Why a wrapper (not retry in AgentRunner)
 *
 * AgentRunner appends the user message to `PersistentSession` before the
 * first provider call. Retrying at AgentRunner level would either double-
 * commit the user message or need session rollback logic. Here we sit
 * **below** AgentRunner, so the user message is added exactly once and
 * our rotation is invisible to session state.
 *
 * ## Rotation rule
 *
 * `stream()` is the streaming entry point. We try each candidate provider
 * in order. The tricky bit is "when is it still safe to rotate?":
 *
 *   - Before any `text_delta` / `tool_use_start` / similar content event
 *     has been yielded → credential/account failure ⇒ mark cooldown, try
 *     next candidate; retryable provider/runtime failure ⇒ retry this
 *     candidate first, then rotate without cooldown. If AgentRunner is
 *     already retrying the model round, try each candidate once so the
 *     nested retry budget is not multiplied.
 *   - After first content event has been yielded → failure propagates
 *     unchanged to AgentRunner. AgentRunner owns model-call retry after
 *     visible output exists; rotating here would change credentials mid-stream.
 *
 * A "content event" is anything the caller could have rendered to the
 * user. `message_end` without prior text is also accepted as "produced
 * output" — we err on the side of NOT rotating if we've started producing
 * anything, since the model may have run a full turn before erroring.
 *
 * ## Non-key failures
 *
 * Failures that `auth-error.ts::classifyKeyFailure` returns null for
 * are handled by a blacklist-style retry classifier: request/config/safety
 * failures propagate, while unknown provider/runtime failures default to
 * retryable and may fall through to the next candidate without cooldown.
 *
 * ## Cooldown & onSuccess
 *
 * On a credential/account rotatable failure: `markCooldown(profileId, kind, reason)`.
 * Network failures are never cooled down; each new user request starts from
 * the configured entries list again.
 * On a successful first-event-yield: `onSuccess(profileId)` fires so
 * callers can clear any prior cooldown + bump lastUsed.
 */

import type { LLMProvider, CompletionParams, CompletionResult, Message } from '#core-agent';
import type { ProviderEmptyKind, ProviderTerminationCategory, StreamEvent, Usage } from '#core-agent';
import { classifyKeyFailure, formatKeyFailure, type KeyFailureKind } from './auth-error';
import { markCooldown } from './profile-cooldown';
import { createLogger } from '../../logger';
import { getRetryErrorPolicyConfig } from '../../features/client_config';
import { classifyRetryableErrorWithPolicy, type RetryableErrorKind } from '../../../core-agent/src/shared/errors';
import { maskId } from '../../util/log-redact';

const log = createLogger('rotating-provider');

const NETWORK_RETRY_ATTEMPTS = 3;
const NETWORK_RETRY_BASE_DELAY_MS = 500;
const NETWORK_RETRY_MAX_DELAY_MS = 2_000;
const PROVIDER_FIRST_EVENT_TIMEOUT_MS = 180_000;
const NORMAL_EMPTY_RETRY_ATTEMPTS = 1;
export const PROVIDER_NO_FIRST_EVENT_TIMEOUT_CODE = 'PROVIDER_NO_FIRST_EVENT_TIMEOUT';
/** Legacy code retained for older persisted errors and compatibility tests. */
export const PROVIDER_EMPTY_RESPONSE_CODE = 'PROVIDER_EMPTY_RESPONSE';
export const PROVIDER_EMPTY_TRANSPORT_CODE = 'PROVIDER_EMPTY_TRANSPORT';
export const PROVIDER_EMPTY_NORMAL_CODE = 'PROVIDER_EMPTY_NORMAL';
export const PROVIDER_EMPTY_SAFETY_CODE = 'PROVIDER_EMPTY_SAFETY';
export const PROVIDER_EMPTY_UNKNOWN_CODE = 'PROVIDER_EMPTY_UNKNOWN';

class ProviderNoFirstEventTimeoutError extends Error {
  readonly code = PROVIDER_NO_FIRST_EVENT_TIMEOUT_CODE;

  constructor(providerId: string, timeoutMs: number) {
    super(`Provider ${providerId} produced no usable stream event within ${Math.max(1, Math.round(timeoutMs))}ms`);
    this.name = 'ProviderNoFirstEventTimeoutError';
  }
}

class ProviderEmptyResponseError extends Error {
  readonly code: string;
  readonly kind: ProviderEmptyKind;

  constructor(providerId: string, kind: ProviderEmptyKind) {
    super('empty response');
    this.name = 'ProviderEmptyResponseError';
    this.kind = kind;
    this.code = {
      transport_empty: PROVIDER_EMPTY_TRANSPORT_CODE,
      normal_end_empty: PROVIDER_EMPTY_NORMAL_CODE,
      safety_filtered_empty: PROVIDER_EMPTY_SAFETY_CODE,
      unknown_empty: PROVIDER_EMPTY_UNKNOWN_CODE,
    }[kind];
    Object.defineProperty(this, 'providerId', {
      value: providerId,
      enumerable: false,
    });
  }
}

function isProviderNoFirstEventTimeout(err: unknown): boolean {
  return !!err && typeof err === 'object'
    && (err as { code?: unknown }).code === PROVIDER_NO_FIRST_EVENT_TIMEOUT_CODE;
}

function classifyRetryableErrorLocal(err: unknown): RetryableErrorKind | null {
  return classifyRetryableErrorWithPolicy(err, getRetryErrorPolicyConfig());
}

export interface RotatingCandidate {
  profileId: string;
  /** Cooldown/unavailability identity. Defaults to profileId. Official
   * managed models set this per model because one profile fronts multiple
   * independent upstreams. */
  cooldownId?: string;
  /** The (provider, model) this candidate binds to. Required because
   *  rotation may cross provider boundaries (e.g. primary openai/gpt-5.4
   *  → fallback anthropic/claude-opus-4.7). We override `params.model`
   *  with `modelId` before calling the built provider, so the caller
   *  (AgentRunner) doesn't need to know which candidate is active. */
  providerId: string;
  modelId: string;
  /** Model-default output cap for this exact candidate. AgentRunner enters
   *  the wrapper with the primary model's generated default in params; when
   *  rotation crosses models/providers, replace that generated value with
   *  the candidate's own cap. Explicit caller caps are preserved. */
  maxTokens?: number;
  /** Maximum image blocks accepted in one request by this exact model.
   * Zero means text-only. Undefined preserves caller input for backwards
   * compatibility with non-chat/internal test candidates. */
  maxInputImages?: number;
  /** Factory is deferred-async because external providers need core-agent
   *  loaded lazily. We call it at most once per stream/complete request —
   *  if rotation happens to another candidate, we build that one too. */
  build(): Promise<LLMProvider>;
}

/**
 * Project provider-facing history to a candidate's image limit without
 * mutating the durable session messages.
 *
 * Later messages get priority so an image produced by a recent `read_file`
 * tool call remains visible in the next model round. Within one message we
 * retain source order, which keeps the first N composer attachments aligned
 * with their manifest `image_order` values.
 */
export function boundMessagesForImageLimit(
  messages: Message[],
  rawLimit: number,
): Message[] {
  const limit = Number.isFinite(rawLimit) ? Math.max(0, Math.trunc(rawLimit)) : 0;
  const totalImages = messages.reduce(
    (sum, message) => sum + message.content.filter((content) => content.type === 'image').length,
    0,
  );
  if (totalImages <= limit) return messages;

  let remaining = limit;
  const keptImageIndexes = new Map<number, Set<number>>();
  for (let messageIndex = messages.length - 1; messageIndex >= 0 && remaining > 0; messageIndex -= 1) {
    const content = messages[messageIndex].content;
    for (let contentIndex = 0; contentIndex < content.length && remaining > 0; contentIndex += 1) {
      if (content[contentIndex].type !== 'image') continue;
      const indexes = keptImageIndexes.get(messageIndex) || new Set<number>();
      indexes.add(contentIndex);
      keptImageIndexes.set(messageIndex, indexes);
      remaining -= 1;
    }
  }

  const projected: Message[] = [];
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex];
    const kept = keptImageIndexes.get(messageIndex);
    const content = message.content.filter(
      (item, contentIndex) => item.type !== 'image' || kept?.has(contentIndex),
    );
    if (content.length === 0) continue;
    projected.push(content.length === message.content.length ? message : { ...message, content });
  }
  const omittedImages = totalImages - limit;
  const notice = limit > 0
    ? `<model-image-limit max_images="${limit}" omitted_images="${omittedImages}">Only the retained image blocks in this request are visually available. Use attachment manifest paths with read_file one image at a time for omitted images; do not claim visual processing from a listed path alone.</model-image-limit>`
    : `<model-image-limit max_images="0" omitted_images="${omittedImages}" vision_supported="false">This model cannot receive image blocks, including read_file image previews. Do not claim visual analysis. When ocr_file is available it may extract text; otherwise explain that a vision-capable model is required.</model-image-limit>`;
  projected.push({
    role: 'user',
    content: [{ type: 'text', text: notice }],
  });
  return projected;
}

export interface CreateRotatingProviderConfig {
  /** Ordered list of candidates. First entry is the primary (matches
   *  `pickChatEntryGroup()[0]`). Further entries are fallbacks. */
  candidates: RotatingCandidate[];
  /** Called after the wrapper commits to a candidate (first content event
   *  yielded successfully). Used by callers to clear cooldown on the
   *  winning profile and bump `lastUsed`. */
  onSuccess?: (profileId: string, candidate: RotatingCandidate) => void;
  /** Called when a candidate "owns" the call's outcome — either committed
   *  (success) or surfaced the user-visible error after rotation exhausted
   *  / a non-rotatable failure. The dev archive recorder uses this to
   *  rewrite its model/provider/profile labels so the stored row reflects
   *  the candidate that actually produced the visible result, not the
   *  rotating-provider's primary label. Fires at most once per `complete`
   *  / `stream` invocation. */
  onCandidateChosen?: (info: { profileId: string; providerId: string; modelId: string }) => void;
  /** Reports configured and currently usable candidates even when no fallback
   * occurs. This keeps `candidate_count=0` from ambiguously meaning either
   * "one candidate" or "not observed" in sampled diagnostics. */
  onCandidatesObserved?: (info: { candidateCount: number; availableCandidateCount: number }) => void;
  /** Provider id surfaced as `LLMProvider.id` — should match the group's
   *  shared provider id, e.g. "anthropic" / "moonshot". */
  providerId: string;
  /** How many times to retry a network-class failure on the same candidate
   *  before cooling it down and rotating to the next configured candidate. */
  networkRetryAttempts?: number;
  /** Test hook / tuning knob for network retry backoff. */
  networkRetryDelayMs?: (attempt: number) => number;
  /** Same-model retries after an explicitly normal terminal event with no
   * usable content. Kept independent from transport retries. */
  normalEmptyRetryAttempts?: number;
  /** Maximum time from opening a provider stream until its first meaningful
   * text/tool event. Applies only before the stream is committed, so a timed
   * out candidate can be replaced without duplicating visible output/tools. */
  firstEventTimeoutMs?: number;
}

export function createRotatingProvider(config: CreateRotatingProviderConfig): LLMProvider {
  const candidates = config.candidates;
  if (candidates.length === 0) {
    throw new Error('rotating-provider: candidates list is empty');
  }

  const providerId = config.providerId;
  const networkRetryAttempts = Math.max(0, config.networkRetryAttempts ?? NETWORK_RETRY_ATTEMPTS);
  const networkRetryDelayMs = config.networkRetryDelayMs ?? ((attempt: number) => {
    return Math.min(NETWORK_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1), NETWORK_RETRY_MAX_DELAY_MS);
  });
  const firstEventTimeoutMs = Math.max(1, config.firstEventTimeoutMs ?? PROVIDER_FIRST_EVENT_TIMEOUT_MS);
  const normalEmptyRetryAttempts = Math.max(
    0,
    Math.trunc(config.normalEmptyRetryAttempts ?? NORMAL_EMPTY_RETRY_ATTEMPTS),
  );
  // A credential/account failure or a provider that never produced its first
  // usable event is kept out of later model rounds in this agent run. This is
  // run-local only; only credential failures enter the persisted cooldown.
  const unavailableProfiles = new Set<string>();

  const cooldownIdFor = (candidate: RotatingCandidate): string => (
    candidate.cooldownId || candidate.profileId
  );

  const reportCandidates = (): void => {
    config.onCandidatesObserved?.({
      candidateCount: candidates.length,
      availableCandidateCount: candidates.filter(
        (candidate) => !unavailableProfiles.has(cooldownIdFor(candidate)),
      ).length,
    });
  };

  /**
   * Events that are pure preamble — getting one doesn't commit us to this
   * candidate because the user hasn't seen anything yet. We keep draining
   * past them until we see either:
   *   - a content-ish event (text_*, thinking_*, tool_use_*, message_end)
   *     → commit (return iterator + buffered preamble + first content event)
   *   - an `error` event / thrown exception → classify and rotate/propagate
   *
   * pi-ai's stream starts with `{type: 'start'}`; core-agent maps that to
   * `{type: 'message_start'}` before this wrapper sees it. Some transports
   * also yield an internal `{type: 'content_block_start'}` before the real
   * text_delta. If we commit on those preamble events and the actual
   * provider call then throws on the NEXT iterator.next(), we'd be past the
   * point of rotation and the user would just see the first candidate's
   * error instead of falling back.
   */
  const PREAMBLE_TYPES = new Set<string>(['start', 'message_start', 'content_block_start']);

  /** Substitute in the candidate's own model metadata so a cross-provider
   *  fallback hits its own endpoint and request limits even though
   *  AgentRunner only knows about the primary model.
   *
   *  Main turns mark their catalog-derived cap as `model_default`; only that
   *  generated default follows the candidate. Auxiliary calls (compaction,
   *  reflection, etc.) pass explicit small caps without the marker and must
   *  retain them across fallback. */
  function paramsFor(cand: RotatingCandidate, params: CompletionParams): CompletionParams {
    const next = { ...params, model: cand.modelId };
    if (typeof cand.maxInputImages === 'number' && Number.isFinite(cand.maxInputImages)) {
      next.messages = boundMessagesForImageLimit(params.messages, cand.maxInputImages);
    }
    const metadata = params.requestMetadata;
    const usesModelDefault = !!metadata
      && typeof metadata === 'object'
      && !Array.isArray(metadata)
      && metadata.outputLimitSource === 'model_default';
    if (usesModelDefault) {
      next.maxTokens = typeof cand.maxTokens === 'number'
        && Number.isFinite(cand.maxTokens)
        && cand.maxTokens > 0
        ? Math.trunc(cand.maxTokens)
        : undefined;
    }
    return next;
  }

  function abortError(signal: AbortSignal): Error {
    return signal.reason instanceof Error
      ? signal.reason
      : Object.assign(new Error('Request aborted'), { code: 'ABORT_ERR' });
  }

  function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw abortError(signal);
  }

  function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener?.('abort', onAbort);
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        cleanup();
        reject(abortError(signal!));
      };
      signal?.addEventListener?.('abort', onAbort, { once: true });
    });
  }

  function exhaustedNetworkError(lastErr: unknown): Error {
    const msg = formatKeyFailure(lastErr) || 'network error';
    return Object.assign(
      new Error(`All configured model candidates failed after network retries: ${msg.replace(/fetch[_\s-]?failed/ig, 'connection failed')}`),
      // The text above is diagnostic. Keeping the original error as `cause` is
      // what lets `classifyTransientNetworkError` walk to it and the user see
      // "the model connection is unstable, try again" instead of
      // "[network] connection failed" — 2026-08-08, a transient blip mid-run
      // showed the raw sentence, which names a transport the user cannot act on
      // and omits the one thing they can do.
      { code: 'PROVIDER_NETWORK_EXHAUSTED', cause: lastErr },
    );
  }

  function exhaustedCredentialError(lastErr: unknown, failure: PreCommitFailure): Error {
    const codeByKind: Partial<Record<KeyFailureKind | RetryableErrorKind, string>> = {
      auth: 'PROVIDER_AUTH_EXHAUSTED',
      permission: 'PROVIDER_PERMISSION_EXHAUSTED',
      rate_limit: 'PROVIDER_RATE_LIMIT_EXHAUSTED',
      balance: 'PROVIDER_BALANCE_EXHAUSTED',
    };
    const code = codeByKind[failure.kind];
    if (!code) return lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    const message = lastErr instanceof Error ? lastErr.message : (formatKeyFailure(lastErr) || String(lastErr));
    return Object.assign(new Error(message), { code, cause: lastErr });
  }

  type PreCommitFailure = {
    kind: KeyFailureKind | RetryableErrorKind;
    cooldownKind: KeyFailureKind | null;
    retryCurrent?: boolean;
  };

  function classifyPreCommitFailure(err: unknown): PreCommitFailure | null {
    if (isProviderNoFirstEventTimeout(err)) {
      return { kind: 'timeout', cooldownKind: null, retryCurrent: false };
    }
    const keyKind = classifyKeyFailure(err);
    if (keyKind) return { kind: keyKind, cooldownKind: keyKind };

    const retryableKind = classifyRetryableErrorLocal(err);
    if (retryableKind) return { kind: retryableKind, cooldownKind: null };

    return null;
  }

  function shouldRetryCurrentCandidate(failure: PreCommitFailure): boolean {
    if (failure.retryCurrent === false) return false;
    return failure.cooldownKind === null || failure.kind === 'network';
  }

  function retryAttemptsFor(params: CompletionParams): number {
    const agentAttempt = params.retryContext?.agentAttempt;
    return typeof agentAttempt === 'number' && Number.isFinite(agentAttempt) && agentAttempt > 0
      ? 0
      : networkRetryAttempts;
  }

  function normalEmptyRetriesFor(params: CompletionParams): number {
    const agentAttempt = params.retryContext?.agentAttempt;
    return typeof agentAttempt === 'number' && Number.isFinite(agentAttempt) && agentAttempt > 0
      ? 0
      : normalEmptyRetryAttempts;
  }

  function emptyKindForTermination(category: ProviderTerminationCategory | undefined): ProviderEmptyKind {
    if (category === 'normal') return 'normal_end_empty';
    if (category === 'safety') return 'safety_filtered_empty';
    return 'unknown_empty';
  }

  type EmptyObservation = {
    kind: ProviderEmptyKind;
    terminalEventSeen: boolean;
    usage?: Partial<Usage>;
  };

  async function streamOne(cand: RotatingCandidate, params: CompletionParams): Promise<{
    iterator: AsyncIterator<StreamEvent>;
    buffered: StreamEvent[];
    cleanup: () => void;
  } | { rotatable: true; err: unknown; failure: PreCommitFailure; empty?: EmptyObservation }
    | { rotatable: false; err: unknown; empty?: EmptyObservation }> {
    const parentSignal = (params as { signal?: AbortSignal }).signal;
    if (parentSignal?.aborted) {
      return { rotatable: false, err: abortError(parentSignal) };
    }

    let provider: LLMProvider;
    try {
      provider = await cand.build();
    } catch (err) {
      if (parentSignal?.aborted) {
        return { rotatable: false, err: abortError(parentSignal) };
      }
      // Build-time failure can be a bad credential or a transient provider
      // client init/network failure; rotate only for classified cases.
      const failure = classifyPreCommitFailure(err);
      if (failure) return { rotatable: true, err, failure };
      return { rotatable: false, err };
    }

    if (parentSignal?.aborted) {
      return { rotatable: false, err: abortError(parentSignal) };
    }

    const providerController = new AbortController();
    let timedOutError: ProviderNoFirstEventTimeoutError | null = null;
    let parentAbortError: Error | null = null;
    let rejectGate: (err: Error) => void = () => {};
    const preCommitGate = new Promise<never>((_resolve, reject) => { rejectGate = reject; });
    const onParentAbort = () => {
      parentAbortError = parentSignal?.reason instanceof Error
        ? parentSignal.reason
        : Object.assign(new Error('Request aborted'), { code: 'ABORT_ERR' });
      rejectGate(parentAbortError);
      providerController.abort(parentAbortError);
    };
    parentSignal?.addEventListener('abort', onParentAbort, { once: true });
    const rawRequestFirstEventTimeoutMs = params.firstEventTimeoutMs;
    const requestFirstEventTimeoutMs = Number.isFinite(rawRequestFirstEventTimeoutMs)
      && Number(rawRequestFirstEventTimeoutMs) > 0
      ? Math.max(1, Math.trunc(Number(rawRequestFirstEventTimeoutMs)))
      : firstEventTimeoutMs;
    let firstEventTimer: NodeJS.Timeout | null = setTimeout(() => {
      timedOutError = new ProviderNoFirstEventTimeoutError(cand.providerId, requestFirstEventTimeoutMs);
      rejectGate(timedOutError);
      providerController.abort(timedOutError);
    }, requestFirstEventTimeoutMs);

    const clearFirstEventTimer = () => {
      if (!firstEventTimer) return;
      clearTimeout(firstEventTimer);
      firstEventTimer = null;
    };

    let iterator: AsyncIterator<StreamEvent> | null = null;
    const cleanup = () => {
      clearFirstEventTimer();
      parentSignal?.removeEventListener('abort', onParentAbort);
    };
    const stopUncommittedStream = () => {
      cleanup();
      if (!providerController.signal.aborted) providerController.abort();
      try {
        const returned = iterator?.return?.();
        if (returned && typeof (returned as Promise<unknown>).catch === 'function') {
          void (returned as Promise<unknown>).catch(() => {});
        }
      } catch { /* best-effort disposal */ }
    };

    try {
      const iter = provider.stream(paramsFor(cand, { ...params, signal: providerController.signal }));
      iterator = (iter as AsyncIterable<StreamEvent>)[Symbol.asyncIterator]();
    } catch (err) {
      stopUncommittedStream();
      if (parentSignal?.aborted) {
        return { rotatable: false, err: abortError(parentSignal) };
      }
      const failure = classifyPreCommitFailure(err);
      if (failure) return { rotatable: true, err, failure };
      return { rotatable: false, err };
    }
    const buffered: StreamEvent[] = [];

    // Drain past pure-preamble events. Keep only a bounded prefix for the
    // caller and periodically yield to the timer queue so even a provider that
    // emits preamble synchronously forever cannot starve the deadline.
    const PREAMBLE_MAX = 8;
    let preambleCount = 0;
    while (true) {
      let step: IteratorResult<StreamEvent>;
      try {
        step = await Promise.race([iterator.next(), preCommitGate]);
        if (timedOutError) throw timedOutError;
        if (parentAbortError) throw parentAbortError;
      } catch (err) {
        const surfacedError = timedOutError || parentAbortError || err;
        stopUncommittedStream();
        if (parentAbortError || parentSignal?.aborted) return { rotatable: false, err: surfacedError };
        const failure = classifyPreCommitFailure(surfacedError);
        if (failure) return { rotatable: true, err: surfacedError, failure };
        return { rotatable: false, err: surfacedError };
      }
      if (step.done) {
        // No terminal event means the transport ended early. This is distinct
        // from a provider explicitly ending with an empty assistant message
        // and can use the ordinary transport retry/fallback path.
        stopUncommittedStream();
        const err = new ProviderEmptyResponseError(cand.providerId, 'transport_empty');
        const failure = classifyPreCommitFailure(err);
        if (failure) {
          return {
            rotatable: true,
            err,
            failure,
            empty: { kind: 'transport_empty', terminalEventSeen: false },
          };
        }
        return {
          rotatable: false,
          err,
          empty: { kind: 'transport_empty', terminalEventSeen: false },
        };
      }
      const ev = step.value as StreamEvent;
      const type = (ev as any)?.type;

      // In-band error event — classify like a thrown error.
      if (type === 'error') {
        const err = (ev as any).error ?? new Error(String((ev as any).text ?? 'unknown stream error'));
        stopUncommittedStream();
        const failure = classifyPreCommitFailure(err);
        if (failure) return { rotatable: true, err, failure };
        return { rotatable: false, err };
      }

      // Preamble → buffer and keep draining.
      if (PREAMBLE_TYPES.has(type)) {
        preambleCount += 1;
        if (buffered.length < PREAMBLE_MAX) buffered.push(ev);
        if (preambleCount % PREAMBLE_MAX === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        continue;
      }

      // Empty text deltas are transport noise, not usable output. Keep waiting
      // for actual text/tool content or a terminal event.
      if (type === 'text_delta' && !String((ev as any).text ?? '').trim()) {
        preambleCount += 1;
        if (buffered.length < PREAMBLE_MAX) buffered.push(ev);
        if (preambleCount % PREAMBLE_MAX === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        continue;
      }

      if (type === 'message_end') {
        const content = Array.isArray((ev as any).content) ? (ev as any).content : [];
        const hasUsableContent = content.some((item: any) => {
          if (!item || typeof item !== 'object') return false;
          if (item.type === 'text') return !!String(item.text ?? '').trim();
          return item.type === 'tool_use';
        });
        if (!hasUsableContent) {
          stopUncommittedStream();
          const category = (ev as Extract<StreamEvent, { type: 'message_end' }>)
            .providerTermination?.category;
          const kind = emptyKindForTermination(category);
          return {
            rotatable: false,
            err: new ProviderEmptyResponseError(cand.providerId, kind),
            empty: {
              kind,
              terminalEventSeen: true,
              ...((ev as Extract<StreamEvent, { type: 'message_end' }>).usage
                ? { usage: (ev as Extract<StreamEvent, { type: 'message_end' }>).usage }
                : {}),
            },
          };
        }
      }

      // First real content event — commit.
      buffered.push(ev);
      clearFirstEventTimer();
      return { iterator, buffered, cleanup };
    }
  }

  return {
    id: providerId,
    name: providerId.charAt(0).toUpperCase() + providerId.slice(1),

    async complete(params: CompletionParams): Promise<CompletionResult> {
      let lastErr: unknown = new Error('rotating-provider: no candidates');
      let lastCand: RotatingCandidate | null = null;
      let lastFailure: PreCommitFailure | null = null;
      let exhaustedNetwork = false;
      const retryAttempts = retryAttemptsFor(params);
      reportCandidates();
      if (params.signal?.aborted) {
        throw abortError(params.signal);
      }
      for (let i = 0; i < candidates.length; i++) {
        const cand = candidates[i];
        if (unavailableProfiles.has(cooldownIdFor(cand))) continue;
        lastCand = cand;

        for (let retry = 0; retry <= retryAttempts; retry++) {
          if (params.signal?.aborted) {
            throw abortError(params.signal);
          }
          try {
            throwIfAborted((params as { signal?: AbortSignal }).signal);
            const provider = await cand.build();
            throwIfAborted((params as { signal?: AbortSignal }).signal);
            const result = await provider.complete(paramsFor(cand, params));
            throwIfAborted((params as { signal?: AbortSignal }).signal);
            config.onCandidateChosen?.({ profileId: cand.profileId, providerId: cand.providerId, modelId: cand.modelId });
            config.onSuccess?.(cand.profileId, cand);
            return result;
          } catch (err) {
            const signal = (params as { signal?: AbortSignal }).signal;
            if (signal?.aborted) {
              config.onCandidateChosen?.({ profileId: cand.profileId, providerId: cand.providerId, modelId: cand.modelId });
              throw abortError(signal);
            }
            lastErr = err;
            const failure = classifyPreCommitFailure(err);
            if (!failure) {
              // Non-rotatable → this candidate owns the visible error.
              config.onCandidateChosen?.({ profileId: cand.profileId, providerId: cand.providerId, modelId: cand.modelId });
              throw err;
            }
            lastFailure = failure;

            if (shouldRetryCurrentCandidate(failure) && retry < retryAttempts) {
              log.warn('complete retrying current candidate', {
                profile_id: maskId(cand.profileId),
                kind: failure.kind,
                attempt: retry + 1,
                max_attempts: retryAttempts,
              });
              await sleep(networkRetryDelayMs(retry + 1), (params as { signal?: AbortSignal }).signal);
              continue;
            }

            const reason = formatKeyFailure(err);
            if (failure.cooldownKind && failure.cooldownKind !== 'network') {
              markCooldown(cooldownIdFor(cand), failure.cooldownKind, reason);
              unavailableProfiles.add(cooldownIdFor(cand));
            }
            exhaustedNetwork = !failure.cooldownKind || failure.kind === 'network';
            log.warn('complete trying next candidate', {
              profile_id: maskId(cand.profileId),
              kind: failure.kind,
              candidate_index: i + 1,
              candidate_count: candidates.length,
            });
            break;
          }
        }
      }
      // Exhausted: surface the last candidate's failure as the call's owner.
      if (lastCand) config.onCandidateChosen?.({ profileId: lastCand.profileId, providerId: lastCand.providerId, modelId: lastCand.modelId });
      if (exhaustedNetwork) throw exhaustedNetworkError(lastErr);
      if (lastFailure) throw exhaustedCredentialError(lastErr, lastFailure);
      throw lastErr;
    },

    async *stream(params: CompletionParams): AsyncIterable<StreamEvent> {
      let lastErr: unknown = new Error('rotating-provider: no candidates');
      let lastCand: RotatingCandidate | null = null;
      let lastFailure: PreCommitFailure | null = null;
      let exhaustedNetwork = false;
      const retryAttempts = retryAttemptsFor(params);
      const allowedNormalEmptyRetries = normalEmptyRetriesFor(params);
      reportCandidates();

      for (let i = 0; i < candidates.length; i++) {
        const cand = candidates[i];
        if (unavailableProfiles.has(cooldownIdFor(cand))) continue;
        lastCand = cand;
        let attempt: Awaited<ReturnType<typeof streamOne>> | null = null;
        let networkRetry = 0;
        let normalEmptyRetry = 0;
        let normalEmptyRecoveryActive = false;

        while (true) {
          attempt = await streamOne(cand, params);

          if (!('rotatable' in attempt)) break;

          if (attempt.empty) {
            yield {
              type: 'provider_empty',
              kind: attempt.empty.kind,
              providerId: cand.providerId,
              candidateIndex: i + 1,
              candidateCount: candidates.length,
              terminalEventSeen: attempt.empty.terminalEventSeen,
              ...(attempt.empty.usage ? { usage: attempt.empty.usage } : {}),
            };

            if (attempt.empty.kind === 'normal_end_empty') {
              lastErr = attempt.err;
              if (normalEmptyRetry < allowedNormalEmptyRetries) {
                normalEmptyRetry += 1;
                normalEmptyRecoveryActive = true;
                log.warn('stream retrying normal terminal empty response', {
                  profile_id: maskId(cand.profileId),
                  attempt: normalEmptyRetry,
                  max_attempts: allowedNormalEmptyRetries,
                });
                yield {
                  type: 'retry',
                  attempt: normalEmptyRetry,
                  reason: 'empty response after normal provider termination',
                };
                continue;
              }
              break;
            }

            if (attempt.empty.kind === 'safety_filtered_empty'
              || attempt.empty.kind === 'unknown_empty') {
              lastErr = attempt.err;
              break;
            }
          }

          if (!attempt.rotatable) break;

          lastErr = attempt.err;

          // Once recovery was triggered by a normal terminal empty response,
          // the exactly-one follow-up request stays on this model. Any failure
          // from that request is surfaced; it cannot consume transport retry
          // budget or cross to a fallback model.
          if (normalEmptyRecoveryActive) break;

          const failure = attempt.failure;
          lastFailure = failure;
          if (shouldRetryCurrentCandidate(failure) && networkRetry < retryAttempts) {
            networkRetry += 1;
            const reason = formatKeyFailure(attempt.err);
            log.warn('stream retrying current candidate', {
              profile_id: maskId(cand.profileId),
              kind: failure.kind,
              attempt: networkRetry,
              max_attempts: retryAttempts,
            });
            yield { type: 'retry', attempt: networkRetry, reason };
            await sleep(networkRetryDelayMs(networkRetry), (params as { signal?: AbortSignal }).signal);
            continue;
          }

          break;
        }

        if (!attempt) continue;

        if ('rotatable' in attempt) {
          lastErr = attempt.err;
          if (!attempt.rotatable || normalEmptyRecoveryActive) {
            // Non-rotatable failure before any content event → this
            // candidate is what the user sees in the surfaced error.
            config.onCandidateChosen?.({ profileId: cand.profileId, providerId: cand.providerId, modelId: cand.modelId });
            throw attempt.err;
          }
          const failure = attempt.failure;
          const reason = formatKeyFailure(attempt.err);
          const fallbackCandidate = candidates
            .slice(i + 1)
            .find((candidate) => !unavailableProfiles.has(cooldownIdFor(candidate)));
          const hasFallback = !!fallbackCandidate;
          if (failure.cooldownKind && failure.cooldownKind !== 'network') {
            markCooldown(cooldownIdFor(cand), failure.cooldownKind, reason);
            unavailableProfiles.add(cooldownIdFor(cand));
            if (failure.kind === 'auth' && hasFallback) {
              yield {
                type: 'provider_fallback',
                reason: 'auth',
                providerId: cand.providerId,
                candidateIndex: i + 1,
                candidateCount: candidates.length,
              };
            }
          } else if (isProviderNoFirstEventTimeout(attempt.err) && hasFallback) {
            unavailableProfiles.add(cooldownIdFor(cand));
            yield {
              type: 'provider_fallback',
              reason: 'no_first_event_timeout',
              providerId: cand.providerId,
              candidateIndex: i + 1,
              candidateCount: candidates.length,
            };
          } else if (isProviderNoFirstEventTimeout(attempt.err)) {
            unavailableProfiles.add(cooldownIdFor(cand));
          }
          exhaustedNetwork = !failure.cooldownKind || failure.kind === 'network';
          log.warn('stream trying next candidate', {
            profile_id: maskId(cand.profileId),
            kind: failure.kind,
            candidate_index: i + 1,
            candidate_count: candidates.length,
          });
          continue;
        }

        // Drained past preamble without hitting an error → commit to
        // this candidate. From here on, failures propagate to caller
        // unchanged (rotation would mean corrupting visible stream).
        const { iterator, buffered, cleanup } = attempt;
        config.onCandidateChosen?.({ profileId: cand.profileId, providerId: cand.providerId, modelId: cand.modelId });
        config.onSuccess?.(cand.profileId, cand);

        for (const ev of buffered) yield ev;

        try {
          while (true) {
            const { value, done } = await iterator.next();
            if (done) return;
            if (value) yield value;
          }
        } catch (err) {
          // Post-commit failure: surface upward, no rotation.
          throw err;
        } finally {
          cleanup();
        }
      }

      // Exhausted all candidates — surface the last one as the owner of
      // the visible failure, then throw whatever it gave us.
      if (lastCand) config.onCandidateChosen?.({ profileId: lastCand.profileId, providerId: lastCand.providerId, modelId: lastCand.modelId });
      if (isProviderNoFirstEventTimeout(lastErr)) throw lastErr;
      if (exhaustedNetwork) throw exhaustedNetworkError(lastErr);
      if (lastFailure) throw exhaustedCredentialError(lastErr, lastFailure);
      throw lastErr;
    },

    async validateAuth(): Promise<boolean> {
      for (const cand of candidates) {
        try {
          const provider = await cand.build();
          if (await provider.validateAuth()) return true;
        } catch { /* try next */ }
      }
      return false;
    },
  };
}
