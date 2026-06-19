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
import { app } from 'electron';
import * as paths from '../../paths';
import { getCurrentLang } from '../../i18n';
import { bundledRuntimeEnv, bundledRuntimePathEntries } from '../../util/bundled-runtime';

interface NoopRecorder {
  record(event: unknown): void;
  setActiveCandidate(info: unknown): void;
  finish(output: unknown): void;
}

function startRecording(_input: unknown): NoopRecorder {
  return {
    record() {},
    setActiveCandidate() {},
    finish() {},
  };
}

export async function* stopStreamOnAbort<T>(
  events: AsyncIterable<T>,
  signal: AbortSignal,
  label = 'stream',
): AsyncGenerator<T, void, unknown> {
  const iterator = events[Symbol.asyncIterator]();
  const aborted = Symbol('aborted');
  let abortListener: (() => void) | null = null;
  const abortPromise = new Promise<typeof aborted>((resolve) => {
    abortListener = () => resolve(aborted);
    if (signal.aborted) resolve(aborted);
    else signal.addEventListener('abort', abortListener, { once: true });
  });

  try {
    while (true) {
      const next = iterator.next();
      const result = await Promise.race([next, abortPromise]);
      if (result === aborted) {
        const ret = iterator.return?.();
        if (ret) {
          void Promise.resolve(ret).catch((err) => {
            log.warn(`abortable ${label} return failed: ${(err as Error).message}`);
          });
        }
        return;
      }
      if (result.done) return;
      yield result.value;
    }
  } finally {
    if (abortListener) signal.removeEventListener('abort', abortListener);
  }
}

/**
 * Env vars injected into the sandbox child process so skill scripts can
 * run under Electron-as-Node:
 *   - `ORKAS_NODE` = Electron binary path (runs as stock Node because of
 *     `ELECTRON_RUN_AS_NODE=1` in the child env)
 *   - `ORKAS_PC_DIR` = PC root, rewritten to `app.asar.unpacked` in
 *     packaged mode so `bin/run-skill.cjs` + tsx + skills resolve on real disk
 *   - `ORKAS_WORKSPACE_ROOT` = canonical data root so `run-skill.cjs` can
 *     find installed per-user skills under `<uid>/local/marketplace/skills`
 *   - `ORKAS_PYTHON` / `ORKAS_UV` = optional bundled Python runtime and uv
 *     binary under resources/runtime, used for `.py` skills and package deps
 *   - `ELECTRON_RUN_AS_NODE` = makes the Electron binary boot as Node
 *
 * Injected via `AgentRunParams.sandboxEnv` → `ToolContext.state.sandboxEnv`
 * → `SandboxExecutor.config.env`, so the env only reaches the bash-tool
 * child process. Never set on the host `process.env`: that would leak to
 * Electron's own GPU/renderer/utility helpers and crash the app at boot.
 */
let _skillSandboxEnvStatic: Record<string, string> | null = null;
function buildSkillSandboxEnvStatic(): Record<string, string> {
  if (_skillSandboxEnvStatic) return _skillSandboxEnvStatic;
  // `app` is undefined when running under vitest (no Electron runtime). Treat
  // missing/!isPackaged the same — dev layout has everything on real disk.
  const isPackaged = !!app && app.isPackaged;
  const pcDir = isPackaged
    ? paths.PC_ROOT.replace(/\bapp\.asar\b/, 'app.asar.unpacked')
    : paths.PC_ROOT;
  _skillSandboxEnvStatic = {
    ORKAS_NODE: process.execPath,
    ORKAS_PC_DIR: pcDir,
    ORKAS_WORKSPACE_ROOT: paths.WS_ROOT,
    ELECTRON_RUN_AS_NODE: '1',
  };
  return _skillSandboxEnvStatic;
}

/**
 * Per-turn sandbox env = cached static part + uid-derived dynamic part
 * (never cached module-level — CLAUDE.md §4):
 *   - `ORKAS_UID` = the turn's user id, so `bin/orkas-pkg.cjs` (and other
 *     bash-driven CLIs) resolve the right per-user data tree without
 *     parsing users.json.
 *   - `ORKAS_PATH_PREPEND` = `<uid>/local/packages/.bin` when an enabled
 *     external package ships CLI shims, plus bundled runtime bins when
 *     present. Composed into PATH by the sandbox executor (see core-agent
 *     sandbox/executor.ts) so the augmented brew/system PATH is preserved.
 */
export function buildSkillSandboxEnv(userId?: string): Record<string, string> {
  const env = { ...buildSkillSandboxEnvStatic(), ...bundledRuntimeEnv() };
  env.ORKAS_UI_LANG = getCurrentLang();
  const pathEntries = bundledRuntimePathEntries();
  if (userId) {
    env.ORKAS_UID = userId;
    try {
      // Lazy require keeps module-load order safe (client.ts loads before
      // some features in boot paths) and avoids a static feature import in
      // the model layer beyond what's already here.
      // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
      const pkgs = require('../../features/packages') as typeof import('../../features/packages');
      const binDir = pkgs.packagesBinDirIfActive(userId);
      if (binDir) pathEntries.push(binDir);
    } catch { /* packages feature unavailable → no shim PATH this turn */ }
  }
  if (pathEntries.length) {
    env.ORKAS_PATH_PREPEND = pathEntries.join(process.platform === 'win32' ? ';' : ':');
  }
  return env;
}

type ActiveSessionAbort = {
  abort: () => void;
};

const activeSessionAborts = new Map<string, Set<ActiveSessionAbort>>();

function addActiveSessionAbort(sessionId: string, entry: ActiveSessionAbort): void {
  let set = activeSessionAborts.get(sessionId);
  if (!set) {
    set = new Set();
    activeSessionAborts.set(sessionId, set);
  }
  set.add(entry);
}

function removeActiveSessionAbort(sessionId: string, entry: ActiveSessionAbort): void {
  const set = activeSessionAborts.get(sessionId);
  if (!set) return;
  set.delete(entry);
  if (set.size === 0) activeSessionAborts.delete(sessionId);
}

export function abortActiveSession(sessionId: string): number {
  const set = activeSessionAborts.get(sessionId);
  if (!set || set.size === 0) return 0;
  let count = 0;
  for (const entry of Array.from(set)) {
    try {
      entry.abort();
      count += 1;
    } catch { /* already aborted */ }
  }
  return count;
}

export function abortActiveSessionsForConversation(cid: string): number {
  if (!cid) return 0;
  let count = 0;
  const commanderSession = `gconv-${cid}`;
  const memberPrefix = `gmember-${cid}-`;
  for (const sessionId of Array.from(activeSessionAborts.keys())) {
    if (sessionId === commanderSession || sessionId.startsWith(memberPrefix)) {
      count += abortActiveSession(sessionId);
    }
  }
  return count;
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
    turnId,
    projectId,
    onFileWritten,
    hasProducedPath,
    onArtifactCreated,
    onSkillAdvertised,
    onSkillInvoked,
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
  let directSessionAbort = false;
  const activeAbortEntry: ActiveSessionAbort = {
    abort: () => {
      directSessionAbort = true;
      log.info(`direct session abort ${turnTag} — releasing locks immediately`);
      controller.abort();
      releaseSlotOnce('session-abort');
      releaseSessionOnce('session-abort');
    },
  };
  addActiveSessionAbort(sessionId, activeAbortEntry);

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

  const recorder = startRecording(null);
  let finalText = '';
  let errText: string | null = null;
  let abortedFlag = false;

  try {

    // Called back when pi-ai's onPayload hook injects the native web
    // search tool. The open-source recorder is a non-null no-op object.
    const built = await buildRunner({
      sessionId,
      systemPrompt,
      userId,
      agentId,
      ...(cid ? { cid } : {}),
      ...(turnId ? { turnId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(skillList !== undefined ? { skillList } : {}),
      ...(projectAllowedSkillIds !== undefined ? { projectAllowedSkillIds } : {}),
      ...(extraTools && extraTools.length ? { extraTools } : {}),
      ...(extraRoots && extraRoots.length ? { extraRoots } : {}),
      ...(readOnlyExtraRoots && readOnlyExtraRoots.length ? { readOnlyExtraRoots } : {}),
      ...(onFileWritten ? { onFileWritten } : {}),
      ...(hasProducedPath ? { hasProducedPath } : {}),
      ...(onArtifactCreated ? { onArtifactCreated } : {}),
      ...(onSkillAdvertised ? { onSkillAdvertised } : {}),
      ...(onSkillInvoked ? { onSkillInvoked } : {}),
      onNativeSearchInjected: (info) => {
        recorder.record({
          type: 'progress',
          event: { stream: 'native_search', data: { phase: 'injected', ...info } },
        });
      },
      onCandidateChosen: (info) => {
        recorder.setActiveCandidate(info);
      },
    });
    const { runner, providerId, modelId, skillDisplayNameById, agentDisplayNameById } = built;

    const sandboxEnv = buildSkillSandboxEnv(userId);

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
    const mappedEvents = mapCoreAgentEvents(captureResult(rawEvents), { userId, skillDisplayNameById, agentDisplayNameById });
    for await (const ev of stopStreamOnAbort(mappedEvents, controller.signal, turnTag)) {
      resetIdle();
      eventCount += 1;
      recorder.record(ev as any);
      if (ev.type === 'final') finalText = (ev as any).text || finalText;
      if (ev.type === 'error') { errText = (ev as any).text || errText; if ((ev as any).aborted) abortedFlag = true; }
      // NOTE: compaction summaries are deliberately NOT mined into cross-session
      // memory. That hook persisted transient task progress (the summary is
      // work-in-progress, not durable user facts) into MEMORY.md. Memory is now
      // written only by the explicit `cross_session_memory` tool.
      yield ev;
    }
    log.info(`turn end ${turnTag} events=${eventCount} finalLen=${finalText.length} err=${errText ? 'yes' : 'no'}`);

    // Metacognitive reflection is no longer triggered per-turn — it now
    // runs from the background orchestrator on a 12h cycle. See
    // `features/reflection-orchestrator.ts`. Keeping `agentRunResult`
    // captured above for the recorder/archive payload.
    void agentRunResult;

    if (externalAbort || directSessionAbort) {
      // mapCoreAgentEvents may have already yielded 'error: empty response'
      // for the short-circuit; tag the stream as aborted for the client.
      abortedFlag = true;
      yield { type: 'error', text: 'aborted', aborted: true };
    } else if (idleHit) {
      errText = errText || `Model exceeded ${idleTimeout}s with no response (aborted)`;
      yield { type: 'error', text: errText };
    }
  } catch (err) {
    const wasAborted = externalAbort || directSessionAbort || (controller.signal.aborted && !idleHit);
    errText = wasAborted ? 'aborted' : ((err as Error).message || String(err));
    if (wasAborted) {
      abortedFlag = true;
      log.info(`stream aborted ${turnTag}`);
      yield { type: 'error', text: errText, aborted: true };
    } else {
      log.error('stream error:', err);
      yield { type: 'error', text: errText };
    }
  } finally {
    removeActiveSessionAbort(sessionId, activeAbortEntry);
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
    try { recorder.finish({ text: finalText, aborted: abortedFlag, error: errText }); }
    catch (err) { log.warn('archive finish failed:', err); }
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
