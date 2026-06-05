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
 *     next candidate; network failure ⇒ retry this candidate first, then
 *     rotate without cooldown
 *   - After first content event has been yielded → failure propagates
 *     unchanged (rotating now would mean losing/duplicating visible
 *     output, which is worse than failing)
 *
 * A "content event" is anything the caller could have rendered to the
 * user. `message_end` without prior text is also accepted as "produced
 * output" — we err on the side of NOT rotating if we've started producing
 * anything, since the model may have run a full turn before erroring.
 *
 * ## Non-key failures
 *
 * Failures that `auth-error.ts::classifyKeyFailure` returns null for
 * (400 bad request, content policy, 5xx, timeout, network) skip rotation
 * and propagate on the first candidate. No point trying another key when
 * the problem isn't key-shaped.
 *
 * ## Cooldown & onSuccess
 *
 * On a credential/account rotatable failure: `markCooldown(profileId, kind, reason)`.
 * Network failures are never cooled down; each new user request starts from
 * the configured entries list again.
 * On a successful first-event-yield: `onSuccess(profileId)` fires so
 * callers can clear any prior cooldown + bump lastUsed.
 */

import type { LLMProvider, CompletionParams, CompletionResult } from '#core-agent';
import type { StreamEvent } from '#core-agent';
import { classifyKeyFailure, formatKeyFailure } from './auth-error';
import { markCooldown } from './profile-cooldown';
import { createLogger } from '../../logger';

const log = createLogger('rotating-provider');

const NETWORK_RETRY_ATTEMPTS = 3;
const NETWORK_RETRY_BASE_DELAY_MS = 500;
const NETWORK_RETRY_MAX_DELAY_MS = 2_000;

export interface RotatingCandidate {
  profileId: string;
  /** The (provider, model) this candidate binds to. Required because
   *  rotation may cross provider boundaries (e.g. primary openai/gpt-5.4
   *  → fallback anthropic/claude-opus-4.7). We override `params.model`
   *  with `modelId` before calling the built provider, so the caller
   *  (AgentRunner) doesn't need to know which candidate is active. */
  providerId: string;
  modelId: string;
  /** Factory is deferred-async because external providers need core-agent
   *  loaded lazily. We call it at most once per stream/complete request —
   *  if rotation happens to another candidate, we build that one too. */
  build(): Promise<LLMProvider>;
}

export interface CreateRotatingProviderConfig {
  /** Ordered list of candidates. First entry is the primary (matches
   *  `pickChatEntryGroup()[0]`). Further entries are fallbacks. */
  candidates: RotatingCandidate[];
  /** Called after the wrapper commits to a candidate (first content event
   *  yielded successfully). Used by callers to clear cooldown on the
   *  winning profile and bump `lastUsed`. */
  onSuccess?: (profileId: string) => void;
  /** Called when a candidate "owns" the call's outcome — either committed
   *  (success) or surfaced the user-visible error after rotation exhausted
   *  / a non-rotatable failure. The dev archive recorder uses this to
   *  rewrite its model/provider/profile labels so the stored row reflects
   *  the candidate that actually produced the visible result, not the
   *  rotating-provider's primary label. Fires at most once per `complete`
   *  / `stream` invocation. */
  onCandidateChosen?: (info: { profileId: string; providerId: string; modelId: string }) => void;
  /** Provider id surfaced as `LLMProvider.id` — should match the group's
   *  shared provider id, e.g. "anthropic" / "moonshot". */
  providerId: string;
  /** How many times to retry a network-class failure on the same candidate
   *  before cooling it down and rotating to the next configured candidate. */
  networkRetryAttempts?: number;
  /** Test hook / tuning knob for network retry backoff. */
  networkRetryDelayMs?: (attempt: number) => number;
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

  /**
   * Events that are pure preamble — getting one doesn't commit us to this
   * candidate because the user hasn't seen anything yet. We keep draining
   * past them until we see either:
   *   - a content-ish event (text_*, thinking_*, tool_use_*, message_end)
   *     → commit (return iterator + buffered preamble + first content event)
   *   - an `error` event / thrown exception → classify and rotate/propagate
   *
   * pi-ai's stream always starts with `{type: 'start'}`, sometimes also
   * yields an internal `{type: 'content_block_start'}` before the real
   * text_delta. If we commit on 'start' and the actual provider call then
   * throws a 401 on the NEXT iterator.next(), we'd be past the point of
   * rotation and the user would just see "401" instead of the retry.
   */
  const PREAMBLE_TYPES = new Set<string>(['start', 'content_block_start']);

  /** Substitute in the candidate's own (provider, model) so a cross-
   *  provider fallback hits its own endpoint even though AgentRunner
   *  only knows about the primary's model. */
  function paramsFor(cand: RotatingCandidate, params: CompletionParams): CompletionParams {
    return { ...params, model: cand.modelId };
  }

  function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0 || signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener?.('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }

  function exhaustedNetworkError(lastErr: unknown): Error {
    const msg = formatKeyFailure(lastErr) || 'network error';
    return new Error(`All configured model candidates failed after network retries: ${msg.replace(/fetch[_\s-]?failed/ig, 'connection failed')}`);
  }

  async function streamOne(cand: RotatingCandidate, params: CompletionParams): Promise<{
    iterator: AsyncIterator<StreamEvent>;
    buffered: StreamEvent[];
  } | { rotatable: true; err: unknown } | { rotatable: false; err: unknown }> {
    let provider: LLMProvider;
    try {
      provider = await cand.build();
    } catch (err) {
      // Build-time failure is effectively the same as auth failure —
      // treat as rotatable if classify says so.
      if (classifyKeyFailure(err)) return { rotatable: true, err };
      return { rotatable: false, err };
    }

    const iter = provider.stream(paramsFor(cand, params));
    const iterator: AsyncIterator<StreamEvent> = (iter as AsyncIterable<StreamEvent>)[Symbol.asyncIterator]();
    const buffered: StreamEvent[] = [];

    // Drain past pure-preamble events. Bounded by PREAMBLE_MAX so a
    // misbehaving provider that endlessly emits `start`-like events can't
    // stall us forever.
    const PREAMBLE_MAX = 8;
    for (let i = 0; i < PREAMBLE_MAX; i++) {
      let step: IteratorResult<StreamEvent>;
      try {
        step = await iterator.next();
      } catch (err) {
        if (classifyKeyFailure(err)) return { rotatable: true, err };
        return { rotatable: false, err };
      }
      if (step.done) {
        // Stream ended with nothing but preamble. Not strictly a key
        // failure — treat as non-rotatable (key works, response was
        // just empty). Caller propagates an empty done state.
        return { iterator, buffered };
      }
      const ev = step.value as StreamEvent;
      const type = (ev as any)?.type;

      // In-band error event — classify like a thrown error.
      if (type === 'error') {
        const err = (ev as any).error ?? new Error(String((ev as any).text ?? 'unknown stream error'));
        if (classifyKeyFailure(err)) return { rotatable: true, err };
        return { rotatable: false, err };
      }

      // Preamble → buffer and keep draining.
      if (PREAMBLE_TYPES.has(type)) {
        buffered.push(ev);
        continue;
      }

      // First real content event — commit.
      buffered.push(ev);
      return { iterator, buffered };
    }
    // Hit PREAMBLE_MAX without seeing content or error. Commit anyway;
    // subsequent failures will propagate to the caller, not rotate.
    return { iterator, buffered };
  }

  return {
    id: providerId,
    name: providerId.charAt(0).toUpperCase() + providerId.slice(1),

    async complete(params: CompletionParams): Promise<CompletionResult> {
      let lastErr: unknown = new Error('rotating-provider: no candidates');
      let lastCand: RotatingCandidate | null = null;
      let exhaustedNetwork = false;
      for (let i = 0; i < candidates.length; i++) {
        const cand = candidates[i];
        lastCand = cand;

        for (let retry = 0; retry <= networkRetryAttempts; retry++) {
          try {
            const provider = await cand.build();
            const result = await provider.complete(paramsFor(cand, params));
            config.onCandidateChosen?.({ profileId: cand.profileId, providerId: cand.providerId, modelId: cand.modelId });
            config.onSuccess?.(cand.profileId);
            return result;
          } catch (err) {
            lastErr = err;
            const kind = classifyKeyFailure(err);
            if (!kind) {
              // Non-rotatable → this candidate owns the visible error.
              config.onCandidateChosen?.({ profileId: cand.profileId, providerId: cand.providerId, modelId: cand.modelId });
              throw err;
            }

            if (kind === 'network' && retry < networkRetryAttempts) {
              log.warn(`complete: profile=${cand.profileId} kind=network — retrying current candidate (${retry + 1}/${networkRetryAttempts})`);
              await sleep(networkRetryDelayMs(retry + 1), (params as { signal?: AbortSignal }).signal);
              continue;
            }

            const reason = formatKeyFailure(err);
            if (kind !== 'network') markCooldown(cand.profileId, kind, reason);
            exhaustedNetwork = kind === 'network';
            log.warn(`complete: profile=${cand.profileId} kind=${kind} — trying next candidate (${i + 1}/${candidates.length})`);
            break;
          }
        }
      }
      // Exhausted: surface the last candidate's failure as the call's owner.
      if (lastCand) config.onCandidateChosen?.({ profileId: lastCand.profileId, providerId: lastCand.providerId, modelId: lastCand.modelId });
      if (exhaustedNetwork) throw exhaustedNetworkError(lastErr);
      throw lastErr;
    },

    async *stream(params: CompletionParams): AsyncIterable<StreamEvent> {
      let lastErr: unknown = new Error('rotating-provider: no candidates');
      let lastCand: RotatingCandidate | null = null;
      let exhaustedNetwork = false;

      for (let i = 0; i < candidates.length; i++) {
        const cand = candidates[i];
        lastCand = cand;
        let attempt: Awaited<ReturnType<typeof streamOne>> | null = null;

        for (let retry = 0; retry <= networkRetryAttempts; retry++) {
          attempt = await streamOne(cand, params);

          if (!('rotatable' in attempt)) break;

          lastErr = attempt.err;
          if (!attempt.rotatable) break;

          const kind = classifyKeyFailure(attempt.err)!;
          if (kind === 'network' && retry < networkRetryAttempts) {
            const reason = formatKeyFailure(attempt.err);
            log.warn(`stream: profile=${cand.profileId} kind=network — retrying current candidate (${retry + 1}/${networkRetryAttempts})`);
            yield { type: 'retry', attempt: retry + 1, reason } as any;
            await sleep(networkRetryDelayMs(retry + 1), (params as { signal?: AbortSignal }).signal);
            continue;
          }

          break;
        }

        if (!attempt) continue;

        if ('rotatable' in attempt) {
          lastErr = attempt.err;
          if (!attempt.rotatable) {
            // Non-rotatable failure before any content event → this
            // candidate is what the user sees in the surfaced error.
            config.onCandidateChosen?.({ profileId: cand.profileId, providerId: cand.providerId, modelId: cand.modelId });
            throw attempt.err;
          }
          const kind = classifyKeyFailure(attempt.err)!;
          const reason = formatKeyFailure(attempt.err);
          if (kind !== 'network') markCooldown(cand.profileId, kind, reason);
          exhaustedNetwork = kind === 'network';
          log.warn(`stream: profile=${cand.profileId} kind=${kind} — trying next candidate (${i + 1}/${candidates.length})`);
          continue;
        }

        // Drained past preamble without hitting an error → commit to
        // this candidate. From here on, failures propagate to caller
        // unchanged (rotation would mean corrupting visible stream).
        const { iterator, buffered } = attempt;
        config.onCandidateChosen?.({ profileId: cand.profileId, providerId: cand.providerId, modelId: cand.modelId });
        config.onSuccess?.(cand.profileId);

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
        }
      }

      // Exhausted all candidates — surface the last one as the owner of
      // the visible failure, then throw whatever it gave us.
      if (lastCand) config.onCandidateChosen?.({ profileId: lastCand.profileId, providerId: lastCand.providerId, modelId: lastCand.modelId });
      if (exhaustedNetwork) throw exhaustedNetworkError(lastErr);
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
