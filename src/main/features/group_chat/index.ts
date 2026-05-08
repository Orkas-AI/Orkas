/**
 * Group-chat facade — IPC layer talks only to this module.
 *
 * Responsibilities:
 *   - Send a user message (router @ + bus enqueue + UI event stream)
 *   - Subscribe to event stream (single async generator IPC handler)
 *   - List members / read plan / mark form submitted
 *   - Abort group + drop on conv delete
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { userChatsDir, groupChatVisibilityFile } from '../../paths';
import { readJsonl, rewriteJsonlLine, nowIso, safeId } from '../../storage';
import { createLogger } from '../../logger';

import {
  USER_ID, readMembers, readState, seedReservedActors, purgeGroupDir,
  setCodingProjectDir,
} from './state';
import { isPlaceholderTitle } from './conv_workspace';
import { readPlan, type PlanFile } from './plan';
import * as planExecutor from './plan_executor';
import {
  abort as busAbort, dropConv as busDropConv, enqueue, subscribe, isQuiescent,
  type GroupEvent,
} from './bus';

/** Re-export so the IPC layer can poll the bus's true quiescent state on
 *  every state_changed event — the on-disk state.json briefly shows 'idle'
 *  in the microtask gap between turns; the bus's in-memory queues are the
 *  authoritative source. */
export const busIsQuiescent = isQuiescent;

/** Re-export so the IPC layer can subscribe to the bus BEFORE calling
 *  send(). enqueue wakes the recipient worker synchronously, which then
 *  starts emitting events on the same microtask cycle as send's return —
 *  if subscribe runs after send, those first events are lost. */
export const subscribeBus = subscribe;

export { startWatchdog, stopWatchdog } from './watchdog';
import type { GroupMessage } from './visibility';
import {
  type ChatFormPayload, encodeSubmission, buildMention,
} from './router';

const log = createLogger('group_chat.facade');

function mainJsonlFile(uid: string, cid: string): string {
  return path.join(userChatsDir(uid), `${cid}.jsonl`);
}

// ── Send (from human) ────────────────────────────────────────────────────

export interface SendInput {
  userId: string;
  cid: string;
  text: string;
  attachments?: string[];
}

export async function send(
  input: SendInput,
): Promise<{ ok: boolean; msg?: GroupMessage; error?: string }> {
  const { userId, cid, text, attachments } = input;
  if (!safeId(cid)) return { ok: false, error: 'invalid cid' };
  if (!text || !text.trim()) return { ok: false, error: 'empty message' };
  await seedReservedActors(userId, cid);
  // Auto-title: the first real user message in a fresh / unnamed
  // conversation overwrites the placeholder title so the sidebar item
  // becomes scannable. Lazy-imported to avoid a chats↔group_chat circular.
  try {
    const chats = await import('../chats');
    const conv = await chats.getConversation(userId, cid);
    if (conv && isPlaceholderTitle(conv.title)) {
      await chats.updateConversation(userId, cid, { title: chats.autoTitle(text) });
    }
  } catch (err) {
    log.warn(`auto-title failed user=${userId} cid=${cid}: ${(err as Error).message}`);
  }
  try {
    const msg = await enqueue({
      uid: userId, cid,
      fromActorId: USER_ID,
      text,
      ...(attachments && attachments.length ? { attachments: [...attachments] } : {}),
    });
    return { ok: true, msg };
  } catch (err) {
    log.error(`send failed user=${userId} cid=${cid}: ${(err as Error).message}`);
    return { ok: false, error: (err as Error).message };
  }
}

// ── Abort + drop ─────────────────────────────────────────────────────────

export async function abort(userId: string, cid: string): Promise<{ ok: boolean }> {
  await busAbort(userId, cid);
  return { ok: true };
}

export async function dropConv(userId: string, cid: string): Promise<void> {
  busDropConv(userId, cid);
  await purgeGroupDir(userId, cid);
}

// ── Members + plan ───────────────────────────────────────────────────────

export async function listMembers(userId: string, cid: string) {
  if (!safeId(cid)) return { ok: false, error: 'invalid cid', actors: [] };
  await seedReservedActors(userId, cid);
  const m = await readMembers(userId, cid);
  // Enrich agent actors with the current `interactive` flag so the renderer
  // can decide on its own whether to auto-target the input box at this agent
  // when its plan step goes in_progress. Read from the live agent file each
  // call (no caching) — agents.ts maintains its own list cache so the read
  // is cheap, and "interactive 跟随 agent 当前配置" is the contract.
  const agentsFeat = await import('../agents');
  const enriched = await Promise.all(m.actors.map(async (a) => {
    if (a.kind !== 'agent') return a;
    try {
      const ag = await agentsFeat.getAgent(a.id);
      return ag && ag.interactive === true ? { ...a, interactive: true } : a;
    } catch {
      return a;
    }
  }));
  return { ok: true, actors: enriched };
}

export async function readPlanForCid(
  userId: string, cid: string,
): Promise<{ ok: boolean; plan?: PlanFile | null; error?: string }> {
  if (!safeId(cid)) return { ok: false, error: 'invalid cid' };
  const plan = await readPlan(userId, cid);
  return { ok: true, plan: plan || null };
}

/** User-initiated retry of a failed plan step (rail "Retry" button). */
export async function retryStep(
  userId: string, cid: string, stepIndex: number,
): Promise<{ ok: boolean; error?: string }> {
  if (!safeId(cid)) return { ok: false, error: 'invalid cid' };
  if (!Number.isFinite(stepIndex) || stepIndex < 1) return { ok: false, error: 'invalid stepIndex' };
  return planExecutor.retryStep(userId, cid, stepIndex);
}

/** User-initiated skip of a failed plan step (rail "Skip" button). */
export async function skipStep(
  userId: string, cid: string, stepIndex: number,
): Promise<{ ok: boolean; error?: string }> {
  if (!safeId(cid)) return { ok: false, error: 'invalid cid' };
  if (!Number.isFinite(stepIndex) || stepIndex < 1) return { ok: false, error: 'invalid stepIndex' };
  return planExecutor.skipStep(userId, cid, stepIndex);
}

// ── Streaming events ─────────────────────────────────────────────────────

export async function* streamEvents(
  userId: string, cid: string, opts: { abortSignal?: AbortSignal } = {},
): AsyncGenerator<GroupEvent | { type: 'done' }, void, unknown> {
  if (!safeId(cid)) {
    yield { type: 'done' };
    return;
  }

  // Subscribe FIRST — before any await — so events fired during the seed
  // (or any concurrent enqueue / worker activity) get buffered, not lost.
  // The earlier "await seedReservedActors → subscribe" order had a window
  // where the recipient worker could wake on the same microtask cycle as
  // a `groupChat.send(...)` caller and emit state_changed / process events
  // before the listener was attached.
  const buf: GroupEvent[] = [];
  let wake: (() => void) | null = null;
  let cancelled = false;

  const unsub = subscribe(userId, cid, (ev) => {
    buf.push(ev);
    const w = wake; wake = null; w?.();
  });

  const onAbort = () => { cancelled = true; const w = wake; wake = null; w?.(); };
  if (opts.abortSignal) {
    if (opts.abortSignal.aborted) cancelled = true;
    else opts.abortSignal.addEventListener('abort', onAbort, { once: true });
  }

  // Seed reserved actors AFTER subscribing — idempotent if `groupChat.send`
  // already ran it; safe if not (keeps `streamEvents` usable as a
  // standalone subscription channel from `groupChat.events` IPC).
  try { await seedReservedActors(userId, cid); }
  catch (err) { log.warn(`seed actors failed user=${userId} cid=${cid}: ${(err as Error).message}`); }

  try {
    while (!cancelled) {
      while (buf.length) {
        yield buf.shift()!;
      }
      if (cancelled) break;
      await new Promise<void>((resolve) => { wake = resolve; });
    }
  } finally {
    try { unsub(); } catch { /* ignore */ }
    if (opts.abortSignal) opts.abortSignal.removeEventListener?.('abort', onAbort);
    yield { type: 'done' };
  }
}

// ── Form submission ──────────────────────────────────────────────────────

export interface MarkFormSubmittedInput {
  userId: string; cid: string; msgId: string;
  formId: string;
  values: Record<string, unknown>;
}

/**
 * Mutate the message that owns this form (main jsonl + the agent's
 * visibility slice) to mark it submitted. Does **not** enqueue a follow-up
 * user→agent message — the renderer is responsible for replaying the
 * encoded submission through the normal send-stream pipeline so the UI
 * gets a user bubble + subscribes to the agent's reply stream. Doing both
 * here would either dispatch silently (no renderer subscription = lost
 * events) or double-enqueue (if renderer also sends).
 *
 * Returns the encoded submission text and the recipient agent_id so the
 * renderer can fire the send without re-encoding client-side.
 */
export async function markFormSubmittedAndDispatch(
  input: MarkFormSubmittedInput,
): Promise<{ ok: boolean; error?: string; submission?: { text: string; agent_id: string } }> {
  const { userId, cid, msgId, formId, values } = input;
  if (!safeId(cid)) return { ok: false, error: 'invalid cid' };

  const file = mainJsonlFile(userId, cid);
  const all = await readJsonl<GroupMessage>(file, 100_000);
  const idx = all.findIndex((m) => m.id === msgId);
  if (idx < 0) return { ok: false, error: 'message not found' };
  const target = all[idx];
  if (!target.form || target.form.form_id !== formId) return { ok: false, error: 'form id mismatch' };

  const agentId = target.form.agent_id;
  const updated: ChatFormPayload = {
    ...target.form,
    submitted: true,
    values,
    submitted_at: nowIso(),
  };

  const r = await rewriteJsonlLine<GroupMessage>(file, idx, (rec) => {
    if (!rec || rec.id !== msgId) return null;
    return { ...rec, form: updated };
  });
  if (r.ok === false) {
    log.warn(`form mark failed user=${userId} cid=${cid} msgId=${msgId}: ${r.error}`);
    return { ok: false, error: r.error };
  }
  log.info(`form-submitted user=${userId} cid=${cid} msgId=${msgId} agent=${agentId} fields=${target.form.fields.length}`);

  // Coding-agent contract: when a `project_dir` field is present in the
  // submitted form for an external claude / codex agent, persist it to
  // conv state so `_runCliAgentTurn` can spawn the CLI inside that
  // directory. Other form values stay only in the message log — the
  // agent extracts them from the encoded submission text.
  try {
    const projDir = values && typeof (values as any).project_dir === 'string'
      ? String((values as any).project_dir).trim()
      : '';
    if (projDir) {
      const agentsFeat = await import('../agents');
      const ag = await agentsFeat.getAgent(agentId);
      const cli = ag?.runtime?.kind === 'cli' ? ag.runtime.cli : '';
      if (agentsFeat.cliIsCodingAgent(cli)) {
        await setCodingProjectDir(userId, cid, projDir);
        log.info(`coding project_dir set user=${userId} cid=${cid} agent=${agentId} dir=${projDir}`);
      }
    }
  } catch (err) {
    log.warn(`form-submit project_dir hook failed: ${(err as Error).message}`);
  }

  const sliceFile = groupChatVisibilityFile(userId, cid, agentId);
  if (fs.existsSync(sliceFile)) {
    const slice = await readJsonl<GroupMessage>(sliceFile, 100_000);
    const sIdx = slice.findIndex((m) => m.id === msgId);
    if (sIdx >= 0) {
      await rewriteJsonlLine<GroupMessage>(sliceFile, sIdx, (rec) => {
        if (!rec || rec.id !== msgId) return null;
        return { ...rec, form: updated };
      });
    }
  }

  const encoded = encodeSubmission(
    { form_id: formId, agent_id: agentId, fields: target.form.fields },
    values,
  );
  // `buildMention` keeps the display name verbatim (whitespace included);
  // falling back to the id keeps the dispatch working if the agent was
  // renamed/disabled between form emit and submit.
  let mention = buildMention(agentId);
  try {
    const agentsFeat = await import('../agents');
    const ag = await agentsFeat.getAgent(agentId);
    if (ag && ag.name) mention = buildMention(ag.name);
  } catch (err) {
    log.warn(`form-submit name lookup failed agent=${agentId}: ${(err as Error).message}`);
  }
  // Newline (not space) between the @-mention and the bullet list so the
  // markdown renderer treats them as a paragraph followed by a list. With a
  // space, the leading `- ` of the first bullet sits inline with the mention
  // and gets parsed as a hyphen in prose, dropping the first field out of
  // the list and leaving subsequent bullets visually orphaned.
  return { ok: true, submission: { text: `${mention}\n${encoded}`, agent_id: agentId } };
}

// ── Read messages (UI initial load) ──────────────────────────────────────

export async function readMessages(userId: string, cid: string, limit = 500): Promise<GroupMessage[]> {
  if (!safeId(cid)) return [];
  return readJsonl<GroupMessage>(mainJsonlFile(userId, cid), limit);
}
