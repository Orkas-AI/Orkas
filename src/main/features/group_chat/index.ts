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
import { t } from '../../i18n';

import {
  COMMANDER_ID, USER_ID, readMembers, readState, seedReservedActors, purgeGroupDir,
  setCodingProjectDir, setStatus,
} from './state';
import { isPlaceholderTitle } from './conv_title';
import {
  abort as busAbort, dropConv as busDropConv, enqueue, subscribe, isQuiescent, runtimeSnapshot,
  type GroupEvent,
} from './bus';

/** Re-export so the IPC layer can poll the bus's true quiescent state on
 *  every state_changed event — the on-disk state.json briefly shows 'idle'
 *  in the microtask gap between turns; the bus's in-memory queues are the
 *  authoritative source. */
export const busIsQuiescent = isQuiescent;

export async function runtimeStatus(
  userId: string,
  cid: string,
): Promise<{ processing: boolean; processing_since: string | null; in_flight: string[]; active_turns: Array<{ actor: string; turn_id: string; msg_id?: string }>; active_recipient?: string }> {
  if (!safeId(cid)) return { processing: false, processing_since: null, in_flight: [], active_turns: [] };
  try {
    const state = await readState(userId, cid);
    const runtime = runtimeSnapshot(userId, cid);
    const diskInFlight = Array.isArray(state.in_flight)
      ? state.in_flight.filter(Boolean)
      : [];
    // The conversation floor — included so a renderer reload / recovery poll
    // restores the composer target (the agent the commander handed off to)
    // instead of dropping back to the commander until the next state_changed.
    const floor = state.active_recipient ? { active_recipient: state.active_recipient } : {};
    if ((state.status === 'running' || diskInFlight.length > 0) && !runtime.processing) {
      log.warn(`healing orphan running state user=${userId} cid=${cid} status=${state.status} in_flight=${diskInFlight.join(',')}`);
      await setStatus(userId, cid, 'idle');
      return { processing: false, processing_since: null, in_flight: [], active_turns: [], ...floor };
    }
    const inFlight = Array.from(new Set([
      ...diskInFlight,
      ...runtime.inFlight,
    ].filter(Boolean)));
    const processing = state.status === 'running' || inFlight.length > 0 || runtime.processing;
    return {
      processing,
      processing_since: processing ? (state.last_active_at || null) : null,
      in_flight: inFlight,
      active_turns: runtime.activeTurns,
      ...floor,
    };
  } catch {
    return { processing: false, processing_since: null, in_flight: [], active_turns: [] };
  }
}

/** Re-export so the IPC layer can subscribe to the bus BEFORE calling
 *  send(). enqueue wakes the recipient worker synchronously, which then
 *  starts emitting events on the same microtask cycle as send's return —
 *  if subscribe runs after send, those first events are lost. */
export const subscribeBus = subscribe;

import type { ChatUseSelection, GroupMessage } from './visibility';
import {
  type ChatFormPayload, encodeSubmission, buildMention,
} from './router';
import type { MarketplaceInstallRequest } from './visibility';
import * as marketplace from '../marketplace';

const log = createLogger('group_chat.facade');

function mainJsonlFile(uid: string, cid: string): string {
  return path.join(userChatsDir(uid), `${cid}.jsonl`);
}

// ── Send (from human) ────────────────────────────────────────────────────

export interface SendInput {
  userId: string;
  cid: string;
  text: string;
  model_text?: string;
  attachments?: string[];
  use_selections?: ChatUseSelection[];
}

export async function send(
  input: SendInput,
): Promise<{ ok: boolean; msg?: GroupMessage; error?: string }> {
  const { userId, cid, text, model_text, attachments, use_selections } = input;
  if (!safeId(cid)) return { ok: false, error: 'invalid cid' };
  if (!text || !text.trim()) return { ok: false, error: 'empty message' };
  await seedReservedActors(userId, cid);
  // Auto-title: the first real user message in a fresh / unnamed
  // conversation overwrites the placeholder title so the sidebar item
  // becomes scannable. Lazy-imported to avoid a chats↔group_chat circular.
  try {
    const chats = await import('../chats');
    const conv = await chats.getConversation(userId, cid);
    if (conv && !conv.title_manually_set && isPlaceholderTitle(conv.title)) {
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
      ...(model_text && model_text.trim() ? { model_text } : {}),
      ...(attachments && attachments.length ? { attachments: [...attachments] } : {}),
      ...(use_selections && use_selections.length ? { use_selections } : {}),
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
  // is cheap, and "interactive follows the agent's current spec" is the
  // contract.
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
 * Returns the encoded submission text and the recipient actor id so the
 * renderer can fire the send without re-encoding client-side. Agent-owned
 * forms route back to that agent; user-owned plan forms route to `@user`
 * so the executor can close the user step without waking commander.
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

  // Expert-signals hook (plan §5 mount #4): one form_left_blank signal per
  // field the user didn't touch (kept blank OR kept default). Fire-and-
  // forget; failures never block the form submission.
  (async () => {
    try {
      const { emitSignal } = await import('../expert_signals');
      const { buildFormLeftBlankSignals } = await import('../expert_signals/extractors/event');
      const signals = buildFormLeftBlankSignals({
        cid, aid: agentId, turn_id: msgId, msg_id: msgId,
        fields: target.form.fields as any,
        values: (values || {}) as Record<string, unknown>,
      });
      for (const sig of signals) emitSignal(userId, sig);
    } catch (err) {
      log.warn(`expert-signals form_left_blank emit failed cid=${cid} msgId=${msgId}: ${(err as Error).message}`);
    }
  })();

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
        const prev = await readState(userId, cid);
        const oldDir = prev.coding_project_dir || '';
        await setCodingProjectDir(userId, cid, projDir, { explicit: true });
        if (oldDir && oldDir !== projDir) {
          // cwd is about to change — claude code's sessions are cwd-keyed,
          // so the existing binding would fail with "No conversation
          // found" on resume. Drop it; next dispatch starts a fresh CLI
          // session and bridges the prior visible transcript once so the
          // user-visible conversation continues seamlessly.
          const cliSessions = await import('../local_agents/sessions');
          await cliSessions.clearForConversation(userId, cid);
          log.info(`coding cwd changed (form) user=${userId} cid=${cid} ${oldDir} → ${projDir} — cleared cli sessions`);
        } else {
          log.info(`coding project_dir set (explicit) user=${userId} cid=${cid} agent=${agentId} dir=${projDir}`);
        }
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
  // renamed/disabled between form emit and submit. User-owned plan forms
  // deliberately keep `@user`: it is stripped from persisted text while
  // routing the replay to the user actor, which lets plan reconciliation
  // consume the answer without starting a commander turn.
  let mention = buildMention(agentId);
  if (agentId !== USER_ID) {
    try {
      const agentsFeat = await import('../agents');
      const ag = await agentsFeat.getAgent(agentId);
      if (ag && ag.name) mention = buildMention(ag.name);
    } catch (err) {
      log.warn(`form-submit name lookup failed agent=${agentId}: ${(err as Error).message}`);
    }
  }
  // Newline (not space) between the @-mention and the bullet list so the
  // markdown renderer treats them as a paragraph followed by a list. With a
  // space, the leading `- ` of the first bullet sits inline with the mention
  // and gets parsed as a hyphen in prose, dropping the first field out of
  // the list and leaving subsequent bullets visually orphaned.
  return { ok: true, submission: { text: `${mention}\n${encoded}`, agent_id: agentId } };
}

// ── Marketplace install confirmation ────────────────────────────────────

export interface ResolveMarketplaceInstallRequestInput {
  userId: string;
  cid: string;
  msgId: string;
  requestId: string;
  decision: 'install' | 'skip';
}

function _xmlAttr(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function _marketplaceResultSummary(req: MarketplaceInstallRequest, status: 'installed' | 'skipped' | 'failed', error?: string): string {
  const name = req.name || req.id;
  const kind = req.kind === 'skill'
    ? t('marketplace_install_result.kind_skill')
    : t('marketplace_install_result.kind_agent');
  if (status === 'installed') {
    return t('marketplace_install_result.installed', { kind, name });
  }
  if (status === 'skipped') {
    return t('marketplace_install_result.skipped', { kind, name });
  }
  return t('marketplace_install_result.failed', { kind, name, error: error || 'unknown error' });
}

function _encodeMarketplaceInstallResult(
  req: MarketplaceInstallRequest,
  status: 'installed' | 'skipped' | 'failed',
  error?: string,
): string {
  const payload = {
    request_id: req.request_id,
    kind: req.kind,
    id: req.id,
    name: req.name,
    version: req.version,
    published_at: req.published_at,
    ...(typeof req.updated_at === 'number' ? { updated_at: req.updated_at } : {}),
    status,
    ...(error ? { error } : {}),
  };
  const json = JSON.stringify(payload, null, 2)
    .replace(/<\/marketplace-install-result/gi, '<\\/marketplace-install-result');
  return [
    _marketplaceResultSummary(req, status, error),
    `<marketplace-install-result request_id="${_xmlAttr(req.request_id)}" kind="${_xmlAttr(req.kind)}" id="${_xmlAttr(req.id)}" status="${_xmlAttr(status)}">`,
    json,
    '</marketplace-install-result>',
  ].join('\n');
}

async function _rewriteMarketplaceRequestInFile(
  file: string,
  msgId: string,
  requestId: string,
  patch: Partial<MarketplaceInstallRequest>,
): Promise<void> {
  if (!fs.existsSync(file)) return;
  const rows = await readJsonl<GroupMessage>(file, 100_000);
  const idx = rows.findIndex((m) => m.id === msgId);
  if (idx < 0) return;
  await rewriteJsonlLine<GroupMessage>(file, idx, (rec) => {
    if (!rec || rec.id !== msgId || !Array.isArray(rec.marketplace_requests)) return null;
    const reqIdx = rec.marketplace_requests.findIndex((r) => r.request_id === requestId);
    if (reqIdx < 0) return null;
    const nextReqs = rec.marketplace_requests.slice();
    nextReqs[reqIdx] = { ...nextReqs[reqIdx], ...patch };
    return { ...rec, marketplace_requests: nextReqs };
  });
}

async function _patchMarketplaceRequest(
  userId: string,
  cid: string,
  msgId: string,
  requestId: string,
  patch: Partial<MarketplaceInstallRequest>,
): Promise<{ ok: true; request: MarketplaceInstallRequest; message: GroupMessage } | { ok: false; error: string }> {
  const file = mainJsonlFile(userId, cid);
  const all = await readJsonl<GroupMessage>(file, 100_000);
  const idx = all.findIndex((m) => m.id === msgId);
  if (idx < 0) return { ok: false, error: 'message not found' };
  const target = all[idx];
  const requests = Array.isArray(target.marketplace_requests) ? target.marketplace_requests : [];
  const reqIdx = requests.findIndex((r) => r.request_id === requestId);
  if (reqIdx < 0) return { ok: false, error: 'request not found' };

  let updatedReq: MarketplaceInstallRequest | null = null;
  const r = await rewriteJsonlLine<GroupMessage>(file, idx, (rec) => {
    if (!rec || rec.id !== msgId || !Array.isArray(rec.marketplace_requests)) return null;
    const currentIdx = rec.marketplace_requests.findIndex((x) => x.request_id === requestId);
    if (currentIdx < 0) return null;
    const nextReqs = rec.marketplace_requests.slice();
    updatedReq = { ...nextReqs[currentIdx], ...patch };
    nextReqs[currentIdx] = updatedReq;
    return { ...rec, marketplace_requests: nextReqs };
  });
  if (r.ok === false || !updatedReq) return { ok: false, error: r.ok === false ? r.error : 'request update failed' };

  // Keep the commander's replay slice in sync; other actors do not need the
  // card state for reasoning, and the main jsonl is the renderer source.
  try {
    await _rewriteMarketplaceRequestInFile(
      groupChatVisibilityFile(userId, cid, target.from),
      msgId,
      requestId,
      patch,
    );
  } catch (err) {
    log.warn(`marketplace request slice update failed user=${userId} cid=${cid} msgId=${msgId}: ${(err as Error).message}`);
  }
  return { ok: true, request: updatedReq, message: r.record };
}

async function _autoBindInstalledMarketplaceResource(
  userId: string,
  cid: string,
  req: MarketplaceInstallRequest,
): Promise<void> {
  try {
    const chats = await import('../chats');
    const conv = await chats.getConversation(userId, cid);
    const projectId = (conv as any)?.project_id;
    if (typeof projectId !== 'string' || !projectId) return;
    const projectsFeat = await import('../projects');
    if (req.kind === 'agent') {
      await projectsFeat.addAgentBinding(userId, projectId, req.id);
    } else {
      await projectsFeat.addSkillBinding(userId, projectId, req.id);
    }
    log.info(`auto-bound marketplace ${req.kind} ${req.id} to project ${projectId} after install`);
  } catch (err) {
    log.warn(`marketplace install auto-bind failed user=${userId} cid=${cid} id=${req.id}: ${(err as Error).message}`);
  }
}

export async function resolveMarketplaceInstallRequest(
  input: ResolveMarketplaceInstallRequestInput,
): Promise<{
  ok: boolean;
  error?: string;
  request?: MarketplaceInstallRequest;
  install_error?: {
    kind?: MarketplaceInstallRequest['kind'];
    id: string;
    name: string;
    reason: string;
  };
  submission?: { text: string; agent_id: string };
}> {
  const { userId, cid, msgId, requestId, decision } = input;
  if (!safeId(cid)) return { ok: false, error: 'invalid cid' };
  if (!safeId(msgId) || !safeId(requestId)) return { ok: false, error: 'invalid request' };
  if (decision !== 'install' && decision !== 'skip') return { ok: false, error: 'invalid decision' };

  const file = mainJsonlFile(userId, cid);
  const all = await readJsonl<GroupMessage>(file, 100_000);
  const target = all.find((m) => m.id === msgId);
  const req = target?.marketplace_requests?.find((r) => r.request_id === requestId) || null;
  if (!target || !req) return { ok: false, error: 'request not found' };
  if (req.status !== 'pending') return { ok: false, error: 'request already resolved' };
  if (req.kind !== 'agent' && req.kind !== 'skill') return { ok: false, error: 'invalid request kind' };
  if (!safeId(req.id) || !req.version || !Number.isFinite(req.published_at)) {
    return { ok: false, error: 'invalid marketplace request payload' };
  }

  if (decision === 'skip') {
    const patched = await _patchMarketplaceRequest(userId, cid, msgId, requestId, {
      status: 'skipped',
      resolved_at: nowIso(),
    });
    if (!patched.ok) return patched;
    return {
      ok: true,
      request: patched.request,
      submission: {
        text: _encodeMarketplaceInstallResult(patched.request, 'skipped'),
        agent_id: COMMANDER_ID,
      },
    };
  }

  try {
    if (req.kind === 'agent') {
      await marketplace.installMarketplaceAgent(req.id, {
        version: req.version,
        published_at: req.published_at,
        ...(typeof req.updated_at === 'number' ? { updated_at: req.updated_at } : {}),
      }, { name: req.name });
    } else {
      await marketplace.installMarketplaceSkill(req.id, {
        version: req.version,
        published_at: req.published_at,
        ...(typeof req.updated_at === 'number' ? { updated_at: req.updated_at } : {}),
      }, { name: req.name });
    }
    await _autoBindInstalledMarketplaceResource(userId, cid, req);
    const patched = await _patchMarketplaceRequest(userId, cid, msgId, requestId, {
      status: 'installed',
      resolved_at: nowIso(),
    });
    const request = patched.ok
      ? patched.request
      : { ...req, status: 'installed' as const, resolved_at: nowIso() };
    if (patched.ok === false) {
      log.warn(`marketplace request status update failed after install user=${userId} cid=${cid} msgId=${msgId}: ${patched.error}`);
    }
    return {
      ok: true,
      request,
      submission: {
        text: _encodeMarketplaceInstallResult(request, 'installed'),
        agent_id: COMMANDER_ID,
      },
    };
  } catch (err) {
    const installInfo = marketplace.getMarketplaceInstallErrorInfo(err);
    const failedKind = installInfo.kind || req.kind;
    const failedName = installInfo.name || (failedKind !== req.kind ? installInfo.id : '') || req.name || req.id;
    const failedKindLabel = failedKind === 'skill'
      ? t('marketplace_install_result.kind_skill')
      : t('marketplace_install_result.kind_agent');
    const error = `${failedKindLabel}: ${failedName} - ${installInfo.reason}`;
    const patched = await _patchMarketplaceRequest(userId, cid, msgId, requestId, {
      status: 'failed',
      resolved_at: nowIso(),
      error,
    });
    const request = patched.ok ? patched.request : { ...req, status: 'failed' as const, resolved_at: nowIso(), error };
    return {
      ok: true,
      request,
      install_error: {
        kind: failedKind,
        id: installInfo.id || '',
        name: failedName,
        reason: installInfo.reason,
      },
      submission: {
        text: _encodeMarketplaceInstallResult(request, 'failed', error),
        agent_id: COMMANDER_ID,
      },
    };
  }
}

// ── Read messages (UI initial load) ──────────────────────────────────────

export async function readMessages(userId: string, cid: string, limit = 500): Promise<GroupMessage[]> {
  if (!safeId(cid)) return [];
  return readJsonl<GroupMessage>(mainJsonlFile(userId, cid), limit);
}
