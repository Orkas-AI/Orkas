/**
 * core-agent-backed implementation of `chatWithModel` / `streamChatWithModel`.
 *
 * Signatures match `main/model/client.ts` (the openclaw client) so feature
 * code (`features/chats`, `features/skills`, `features/agents`,
 * `features/contexts_organizer`) can stay unchanged — the dispatcher in
 * `model/client.ts` routes between the two backends based on
 * `process.env.ORKAS_MODEL_BACKEND`.
 *
 * Compared to the openclaw client, this one is all in-process:
 *   - No subprocess spawn
 *   - No JSON-block output parsing
 *   - No preload/bridge hooks — events come straight from core-agent
 *   - Session = `PersistentSession` file under <WS_ROOT>/<user>/sessions/
 *
 * What stays the same:
 *   - Per-session Mutex + 5-slot global Semaphore (`util/locks`)
 *   - Idle watchdog: no event for `idleTimeout` seconds → abort
 *   - External AbortSignal honored
 *   - Returned event shapes + final reply accumulation
 */

import {
  sessionLock, globalSlots,
  type Releaser,
} from '../../util/locks';
import { createLogger } from '../../logger';

const log = createLogger('model');
import { genConversationId } from '../../storage';
import type { ChatOptions, ChatResult, StreamEvent } from '../client';

import { buildRunner } from './runner';
import { mapCoreAgentEvents } from './event-mapper';
import { getSession as _getCachedSession } from './session-store';
import { extractAndSaveCompactFacts } from '../../features/memory';
import { app } from 'electron';
import * as paths from '../../paths';

/**
 * Env vars injected into the sandbox child process so skill scripts can
 * run under Electron-as-Node:
 *   - `ORKAS_NODE` = Electron binary path (runs as stock Node because of
 *     `ELECTRON_RUN_AS_NODE=1` in the child env)
 *   - `ORKAS_PC_DIR` = PC root, rewritten to `app.asar.unpacked` in
 *     packaged mode so `bin/run-skill.cjs` + tsx + skills resolve on real disk
 *   - `ELECTRON_RUN_AS_NODE` = makes the Electron binary boot as Node
 *
 * Injected via `AgentRunParams.sandboxEnv` → `ToolContext.state.sandboxEnv`
 * → `SandboxExecutor.config.env`, so the env only reaches the bash-tool
 * child process. Never set on the host `process.env`: that would leak to
 * Electron's own GPU/renderer/utility helpers and crash the app at boot.
 */
let _skillSandboxEnv: Record<string, string> | null = null;
function buildSkillSandboxEnv(): Record<string, string> {
  if (_skillSandboxEnv) return _skillSandboxEnv;
  // `app` is undefined when running under vitest (no Electron runtime). Treat
  // missing/!isPackaged the same — dev layout has everything on real disk.
  const isPackaged = !!app && app.isPackaged;
  const pcDir = isPackaged
    ? paths.PC_ROOT.replace(/\bapp\.asar\b/, 'app.asar.unpacked')
    : paths.PC_ROOT;
  _skillSandboxEnv = {
    ORKAS_NODE: process.execPath,
    ORKAS_PC_DIR: pcDir,
    ELECTRON_RUN_AS_NODE: '1',
  };
  return _skillSandboxEnv;
}

/**
 * Stream chat using core-agent. Yields the same events as the openclaw
 * client so existing consumers don't care which backend is live.
 */
export async function* streamChatWithModel(opts: ChatOptions): AsyncGenerator<StreamEvent, void, unknown> {
  const {
    userId, message,
    sessionId = `anon-${genConversationId().slice(0, 8)}`,
    systemPrompt,
    workingDir,
    images,
    idleTimeout = 600,
    abortSignal = null,
    skillList,
    projectAllowedSkillIds,
    extraTools,
    extraRoots,
    readOnlyExtraRoots,
    agentId,
    cid,
    projectId,
    onFileWritten,
    hasProducedPath,
    onArtifactCreated,
    cacheRetention,
    thinkingLevel,
  } = opts;

  const turnTag = `session=${sessionId}`;

  // Acquire session lock first (scoped to this conversation), then one of
  // the global slots. Release in reverse order in `finally`. Both releases
  // go through idempotent wrappers so the abort-triggered immediate
  // release (see `onExternalAbort` / idle watchdog) and the generator's
  // natural `finally` can't both flip the Mutex and get into an
  // inconsistent state — whichever fires second is a no-op. We only log
  // release when `reason !== 'finally'` (i.e. an abort path) so the happy
  // path stays quiet.
  let _releaseSession: Releaser | undefined;
  let _slotRelease: Releaser | undefined;
  let sessionReleased = false;
  let slotReleased = false;

  const releaseSessionOnce = (reason: string): void => {
    if (sessionReleased) return;
    sessionReleased = true;
    if (reason !== 'finally') log.info(`release session-lock ${turnTag} reason=${reason}`);
    try { _releaseSession?.(); } catch (err) { log.warn(`release session-lock failed: ${(err as Error).message}`); }
  };
  const releaseSlotOnce = (reason: string): void => {
    if (slotReleased) return;
    slotReleased = true;
    if (reason !== 'finally') log.info(`release global-slot ${turnTag} reason=${reason}`);
    try { _slotRelease?.(); } catch (err) { log.warn(`release global-slot failed: ${(err as Error).message}`); }
  };

  _releaseSession = await sessionLock(sessionId).acquire();
  const [, slotRelease] = await globalSlots.acquire();
  _slotRelease = slotRelease;

  // Build an AbortController that fires when:
  //   (a) no event has been produced for idleTimeout seconds, OR
  //   (b) the caller's external abortSignal fires
  // core-agent honors the signal via params.signal on every provider call.
  //
  // On either abort we release the session + global-slot locks **immediately**,
  // not waiting for the generator's `finally` to run. Some provider stream
  // implementations (observed with pi-ai's WebSocket/SSE transports) don't
  // respond to `signal.aborted` promptly, so the `await iter.next()` stays
  // parked and the generator's `finally` never runs — which would leave the
  // session lock permanently held and the next turn stuck in "thinking". Since
  // `releaseXxxOnce` is idempotent, the `finally` block calling it again
  // is a no-op.
  const controller = new AbortController();
  let idleTimer: NodeJS.Timeout | null = null;
  let idleHit = false;
  let externalAbort = false;

  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleHit = true;
      log.warn(`idle-watchdog fired ${turnTag} — no event for ${idleTimeout}s, aborting + releasing locks`);
      controller.abort();
      releaseSlotOnce('idle-watchdog');
      releaseSessionOnce('idle-watchdog');
    }, idleTimeout * 1000);
  };
  resetIdle();

  const onExternalAbort = () => {
    externalAbort = true;
    log.info(`external abort ${turnTag} — releasing locks immediately`);
    controller.abort();
    releaseSlotOnce('external-abort');
    releaseSessionOnce('external-abort');
  };
  if (abortSignal) {
    if (abortSignal.aborted) onExternalAbort();
    else abortSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  let errText: string | null = null;

  try {
    const built = await buildRunner({
      sessionId,
      systemPrompt,
      userId,
      agentId,
      ...(cid ? { cid } : {}),
      ...(projectId ? { projectId } : {}),
      ...(skillList !== undefined ? { skillList } : {}),
      ...(projectAllowedSkillIds !== undefined ? { projectAllowedSkillIds } : {}),
      ...(extraTools && extraTools.length ? { extraTools } : {}),
      ...(extraRoots && extraRoots.length ? { extraRoots } : {}),
      ...(readOnlyExtraRoots && readOnlyExtraRoots.length ? { readOnlyExtraRoots } : {}),
      ...(onFileWritten ? { onFileWritten } : {}),
      ...(hasProducedPath ? { hasProducedPath } : {}),
      ...(onArtifactCreated ? { onArtifactCreated } : {}),
    });
    const { runner, providerId, modelId } = built;

    const sandboxEnv = buildSkillSandboxEnv();

    log.info(`turn start ${turnTag} user=${userId} provider=${providerId} model=${modelId}`);
    const rawEvents = runner.runStream({
      message,
      signal: controller.signal,
      sandboxEnv,
      ...(workingDir ? { workingDir } : {}),
      ...(images && images.length ? { images } : {}),
      ...(cacheRetention ? { cacheRetention } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
    });

    // Wrap raw events to capture the AgentRunResult for post-run reflection.
    let agentRunResult: import('#core-agent').AgentRunResult | null = null;
    async function* captureResult(events: AsyncIterable<import('#core-agent').AgentRunEvent>) {
      for await (const ev of events) {
        if (ev.type === 'done') agentRunResult = ev.result;
        yield ev;
      }
    }

    // The event mapper yields Orkas-shape events and handles the
    // terminal final/error synthesis. We re-yield every event it produces,
    // resetting the idle timer on each one.
    let eventCount = 0;
    for await (const ev of mapCoreAgentEvents(captureResult(rawEvents))) {
      resetIdle();
      eventCount += 1;
      if (ev.type === 'error') errText = (ev as any).text || errText;
      // Compact-time fact extraction (fire-and-forget)
      if (ev.type === 'progress' && ev.event && (ev.event as any).stream === 'compaction') {
        const summary = (ev.event as any).data?.summary;
        if (summary && userId) {
          extractAndSaveCompactFacts(userId, summary).catch(e => log.warn('compact fact extraction failed:', e));
        }
      }
      yield ev;
    }
    log.info(`turn end ${turnTag} events=${eventCount} err=${errText ? 'yes' : 'no'}`);

    // Metacognitive reflection is no longer triggered per-turn — it now
    // runs once at app startup with a per-agent cooldown. See
    // `features/reflection-trigger.ts`.
    void agentRunResult;

    if (externalAbort) {
      // mapCoreAgentEvents may have already yielded 'error: empty response'
      // for the short-circuit; tag the stream as aborted for the client.
      yield { type: 'error', text: 'aborted', aborted: true };
    } else if (idleHit) {
      errText = errText || `Model exceeded ${idleTimeout}s with no response (aborted)`;
      yield { type: 'error', text: errText };
    }
  } catch (err) {
    errText = (err as Error).message || String(err);
    log.error('stream error:', err);
    yield { type: 'error', text: errText };
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    if (abortSignal) abortSignal.removeEventListener?.('abort', onExternalAbort);
    // Heal orphan tool_use in the cached session before releasing the
    // per-session lock. The PersistentSession instance is cached per
    // sessionId (session-store.ts) and survives across turns, so the
    // constructor's load-time heal doesn't fire again once a turn aborts
    // mid-tool-execution. Without this, the next turn would reuse a
    // memory-resident session whose last assistant message has an
    // unmatched tool_use — provider APIs silently hang on that shape,
    // which surfaces as a "thinking" state that never ends. Heal is idempotent and
    // a no-op on healthy sessions, so running it unconditionally every
    // turn is safe.
    try {
      const cached = await _getCachedSession(sessionId);
      if (cached && typeof (cached as { healAndPersist?: () => boolean }).healAndPersist === 'function') {
        if (cached.healAndPersist()) {
          log.warn(`healed orphan tool_use after turn ${turnTag}`);
        }
      }
    } catch (err) {
      log.warn(`post-turn heal failed ${turnTag}: ${(err as Error).message}`);
    }
    releaseSlotOnce('finally');
    releaseSessionOnce('finally');
    yield { type: 'done' };
  }
}

/** Blocking chat — drains the stream and picks up the final/error event. */
export async function chatWithModel(opts: ChatOptions): Promise<ChatResult> {
  let finalText: string | null = null;
  let errText: string | null = null;
  let aborted = false;
  for await (const ev of streamChatWithModel(opts)) {
    if (ev.type === 'final') finalText = ev.text || '';
    else if (ev.type === 'error' && !errText) errText = ev.text || '';
    if (ev.aborted) aborted = true;
  }
  if (finalText) return { ok: true, text: finalText, error: '', aborted: false };
  return { ok: false, text: '', error: errText || 'unknown error', aborted };
}
