/** Isolated full Commander conversation. Only the model transport and catalog
 * input are controlled; production prompts, tools and bus remain intact. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CatalogEntry } from '../../../src/main/features/connectors/types';
import { isSavedBrowserReadback } from './connector-autonomy-evidence';
import { BrowserArgumentAudit, browserArgumentContext } from './connector-autonomy-arguments';

export const CONNECTOR_AUTONOMY_LIMITS = { requests: 24, timeoutMs: 300_000 } as const;

export async function installConnectorAutonomy(input: {
  cid: string; url: string; earlyStop?: boolean; handback?: boolean;
  silentHandback?: boolean; argumentFault?: 'omit-page' | 'blank-ref';
}) {
  const dataRoot = fs.realpathSync(process.env.ORKAS_WORKSPACE_ROOT!);
  const relative = path.relative(fs.realpathSync(os.tmpdir()), dataRoot);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Isolated evaluation root required');
  const uid = 'account-e2e';
  const auth = await import('../../../src/main/features/auth');
  const { CONNECTOR_CATALOG, findCatalogEntry } = await import('../../../src/main/features/connectors/catalog');
  const { ProviderRegistry } = await import('#core-agent');
  const bus = await import('../../../src/main/features/group_chat/bus');
  // Local service fixtures describe provider state, never the expected tool
  // sequence. No real merchant account, credential or application is changed.
  const fixtureEntry = { id: 'fixture-shop', display_name: 'Fixture shop',
      category: 'commerce', description_en: 'Merchant application setup', auth_mode: 'local_api',
      connection_setup: { requirement: 'provider_application', guide_url: input.url },
      allowed_tools: [], transport_template: null } as CatalogEntry;
  CONNECTOR_CATALOG.push(fixtureEntry);
  if (findCatalogEntry('fixture-shop')?.connection_setup?.guide_url !== input.url) throw new Error('Catalog fixture unavailable');
  const entries = (await auth.listEntries()).entries;
  if (entries.length !== 1 || entries[0].provider !== 'custom') throw new Error('Exclusive synthetic BYO route required');
  const model = entries[0].model;
  let calls = 0;
  let step = 0;
  let terminal: string | undefined;
  let overflow = false;
  let screenshotReceipts = 0;
  let savedObserved = false;
  let calibrationFailure: string | undefined;
  let groupsLoaded = false;
  let applicationFrame: string;
  let handbackForm: any;
  let challengeObserved = false;
  let pageWaitStarted = false;
  let userMessages = 0;
  const controller = new AbortController();
  const traces: Array<{ name: string; failed: boolean }> = [];
  const callsById = new Map<string, { name: string; operation?: string; action?: string; hasPageId: boolean; hasElementRef: boolean; selectsFrame: boolean }>();
  const receiptsById = new Map<string, { name?: string; operation?: string; action?: string; hasPageId?: boolean; hasElementRef?: boolean; selectsFrame?: boolean; ok?: boolean; code?: string; failed: boolean }>();
  const argumentAudit = new BrowserArgumentAudit();
  const unsubscribe = bus.subscribe(uid, input.cid, event => {
    if (event.type === 'message' && event.msg.from === 'user') userMessages++;
    const payload = event.type === 'process' ? event.data as any : null;
    const data = payload?.type === 'event' && payload.event?.stream === 'tool' ? payload.event.data : null;
    if (data && (data.execution_state === 'running' || data.execution_state === 'skipped')
      && Object.hasOwn(data, 'arguments')) {
      argumentAudit.runtime({ id: data.id, name: data.name, input: data.arguments }, data.execution_state === 'skipped');
      if (data.execution_state === 'running' && ((data.name === 'inner_browser' && data.arguments?.operation === 'wait')
        || (data.name === 'connector_setup' && data.arguments?.operation === 'page_wait'))) pageWaitStarted = true;
    }
    if (data?.phase !== 'end') return;
    if (traces.length >= 128) { overflow = true; controller.abort(); return; }
    traces.push({ name: String(data.name ?? data.toolName ?? ''), failed: data.isError === true });
  });
  const unsubscribeTerminal = bus.subscribeTaskTerminals(event => {
    if (event.user_id === uid && event.conversation_id === input.cid) terminal = event.status;
  });
  // Calibration chooses refs only from actual tool receipts. It tests the
  // harness, not autonomous model selection. Live runs never use this actor.
  const calibration: any = {
    id: 'calibration', name: 'Calibration', validateAuth: async () => true,
    complete: async () => { throw new Error('Unexpected nonstream calibration'); },
    async *stream(params: any) {
      const results = params.messages.flatMap((message: any) => message.content)
        .filter((block: any) => block.type === 'tool_result');
      const last = results.length ? JSON.parse(results.at(-1).content) : {};
      let name = 'inner_browser';
      let args: Record<string, unknown>;
      if (input.earlyStop || (input.argumentFault && step >= 8) || (step >= (input.handback ? (input.silentHandback ? 6 : 5) : 9)
        && (last.text?.includes('Application saved') || step >= 18))) {
        yield { type: 'text_delta', text: input.earlyStop ? 'Please click the console and complete the form.' : 'Application saved.' };
        yield { type: 'message_end', stopReason: 'end_turn' }; return;
      }
      if (!groupsLoaded) { name = 'tool_load'; args = { groups: ['connectors', 'web'] }; groupsLoaded = true; }
      else if (input.handback) {
        name = 'connector_setup';
        if (step === 0) args = { operation: 'show', connector_id: 'fixture-shop' };
        else if (input.silentHandback && step === 1) args = { operation: 'page_observe', connector_id: 'fixture-shop' };
        else if (step === (input.silentHandback ? 2 : 1)) args = { operation: 'page_wait', connector_id: 'fixture-shop',
          wait_condition: 'text', text: 'Verification complete', ...(input.silentHandback ? { timeout_ms: 15000 } : {}) };
        else if (step === (input.silentHandback ? 3 : 2)) args = { operation: 'page_observe', connector_id: 'fixture-shop' };
        else if (step === (input.silentHandback ? 4 : 3)) {
          handbackForm = last;
          name = 'inner_browser';
          args = { operation: 'read_value', page_id: last.page_id,
            element_ref: last.elements.find((element: any) => element.label === 'Callback').ref };
        } else if (step === (input.silentHandback ? 5 : 4)) args = { operation: 'page_act', connector_id: 'fixture-shop',
          page_id: handbackForm.page_id,
          element_ref: handbackForm.elements.find((element: any) => element.label === 'Save application').ref,
          page_action: 'click' };
        else {
          await new Promise<void>(resolve => setTimeout(resolve, 100));
          args = { operation: 'page_observe', connector_id: 'fixture-shop' };
        }
      }
      else if (step === 0) { name = 'connector_setup'; args = { operation: 'show', connector_id: 'fixture-shop' }; }
      else if (step === 1) args = { operation: 'wait' };
      else if (step === 2) args = { operation: 'screenshot' };
      else if (step === 3) args = { operation: 'act', page_id: last.page_id, page_action: 'click', point: [140, 100] };
      else if (step === 4) args = { operation: 'observe' };
      else if (step === 5) {
        applicationFrame = last.frames.find((frame: any) => frame.display_url.endsWith('/application')).frame_id;
        args = { operation: 'observe', frame_id: applicationFrame };
      }
      else if (step === 6) args = { operation: 'act', page_id: last.page_id,
        element_ref: last.elements.find((element: any) => element.label === 'Callback').ref,
        page_action: 'fill', text: 'https://merchant.example/callback' };
      else if (step === 7) {
        const form = JSON.parse(results.at(-2).content);
        name = 'connector_setup';
        args = { operation: 'page_act', connector_id: 'fixture-shop', page_id: form.page_id,
          element_ref: form.elements.find((element: any) => element.label === 'Save application').ref, page_action: 'click' };
      } else {
        // The calibration transport has zero inference latency. Poll only the
        // readback; it must not outrun the page's asynchronous save response.
        await new Promise<void>(resolve => setTimeout(resolve, 100));
        args = { operation: 'observe', frame_id: applicationFrame };
      }
      if (!params.tools.some((tool: any) => tool.name === name)) throw new Error('Production tool missing');
      if (input.argumentFault && step === 7) {
        // Calibrate the sampled browser tool's own missing/blank argument
        // guards. This mutation is never applied to live provider output.
        name = 'inner_browser'; args.operation = 'act'; delete args.connector_id;
        if (input.argumentFault === 'omit-page') delete args.page_id;
        else args.element_ref = ' ';
      }
      const id = name === 'tool_load' ? 'calibration-load' : 'calibration-' + step++;
      yield { type: 'tool_use_start', id, name };
      yield { type: 'tool_use_delta', id, input: JSON.stringify(args) };
      yield { type: 'tool_use_end', id };
      yield { type: 'message_end', stopReason: 'tool_use', content: [{ type: 'tool_use', id, name, input: args }] };
    },
  };
  const upstream = calibration;
  const reserve = (params: any) => {
    const argumentContext = browserArgumentContext(params.tools ?? []);
    // Retain structured protocol facts before cleanup, including the last
    // receipt when the request cap is reached. Never retain field values,
    // URLs, refs, session ids, model prose or arbitrary error strings.
    for (const message of params.messages) for (const block of message.content) {
      if (block.type === 'tool_use') argumentAudit.history(block);
      if (block.type === 'tool_use' && !callsById.has(block.id)) {
        if (callsById.size >= 128) { overflow = true; controller.abort(); break; }
        const args = block.input || {};
        callsById.set(block.id, { name: block.name, operation: args.operation, action: args.page_action,
          hasPageId: typeof args.page_id === 'string', hasElementRef: typeof args.element_ref === 'string', selectsFrame: typeof args.frame_id === 'string' });
      }
      if (block.type !== 'tool_result') continue;
      const seen = receiptsById.has(block.toolUseId);
      const name = callsById.get(block.toolUseId)?.name;
      // Existing browser receipts are re-read from this exact request, since
      // an Agent handoff or history projection may omit or replace old data.
      if (seen && name !== 'inner_browser' && name !== 'connector_setup') continue;
      if (!seen && receiptsById.size >= 128) { overflow = true; controller.abort(); break; }
      if (!seen && block.images?.length) screenshotReceipts++;
      try {
        const receipt = JSON.parse(block.content);
        if ((name === 'inner_browser' || name === 'connector_setup') && !block.isError && receipt.ok === true
          && Array.isArray(receipt.elements) && receipt.elements.some((element: any) => element.sensitive === true)) {
          challengeObserved = true;
        }
        argumentContext.addReceipt(name, receipt, block.isError === true);
        if (seen) continue;
        receiptsById.set(block.toolUseId, { ...callsById.get(block.toolUseId), ok: receipt.ok,
          ...(typeof receipt.code === 'string' ? { code: receipt.code } : {}), failed: block.isError === true });
        savedObserved ||= isSavedBrowserReadback(callsById.get(block.toolUseId), receipt, block.isError === true);
      } catch { if (!seen) receiptsById.set(block.toolUseId, { ...callsById.get(block.toolUseId), failed: block.isError === true }); }
    }
    if (controller.signal.aborted || params.signal?.aborted || params.retryContext?.agentAttempt > 0
      || calls >= CONNECTOR_AUTONOMY_LIMITS.requests || params.model !== model) {
      controller.abort(); throw new Error('Connector evaluation request boundary exceeded');
    }
    calls++;
    return { request: calls, argumentContext, params: { ...params, maxTokens: 4096, signal: params.signal
      ? AbortSignal.any([params.signal, controller.signal]) : controller.signal } };
  };
  const recordArguments = (reserved: ReturnType<typeof reserve>, content: any[] = []) => {
    for (const block of content) if (block.type === 'tool_use') {
      argumentAudit.record(reserved.request, reserved.argumentContext, block);
    }
  };
  const bounded: any = { id: upstream.id, name: upstream.name, validateAuth: () => upstream.validateAuth(),
    complete: async (params: any) => {
      try {
        const reserved = reserve(params);
        const result = await upstream.complete(reserved.params);
        recordArguments(reserved, result.content);
        return result;
      } catch (error) { controller.abort(); throw error; }
    },
    async *stream(params: any) {
      try {
        const reserved = reserve(params);
        for await (const event of upstream.stream(reserved.params)) {
          if (event.type === 'message_end') recordArguments(reserved, event.content);
          yield event;
        }
      }
      catch (error) {
        if (!calibrationFailure) calibrationFailure = (error as Error).name;
        controller.abort(); throw error;
      }
    },
  };
  const original = ProviderRegistry.prototype.get;
  // Replace transport at the existing registry boundary, including cached
  // providers. Never fall through to account routes, retries or another model.
  ProviderRegistry.prototype.get = function (id) {
    if (id !== 'custom') { controller.abort(); throw new Error('Unexpected provider route'); }
    return bounded;
  };
  const timer = setTimeout(() => { controller.abort(); void bus.abort(uid, input.cid); }, CONNECTOR_AUTONOMY_LIMITS.timeoutMs);
  return {
    snapshot: () => ({ calls, terminal, overflow, screenshotReceipts, savedObserved, calibrationFailure,
      challengeObserved, pageWaitStarted, userMessages,
      argumentAudits: argumentAudit.snapshot(), argumentAuditOverflow: argumentAudit.overflow,
      receipts: [...receiptsById.values()], traces: [...traces], provider: 'calibration',
      model: 'local', evidenceClass: 'protocol-simulation' }),
    async restore() {
      controller.abort(); clearTimeout(timer);
      await bus.abort(uid, input.cid);
      ProviderRegistry.prototype.get = original;
      const index = CONNECTOR_CATALOG.indexOf(fixtureEntry);
      if (index >= 0) CONNECTOR_CATALOG.splice(index, 1);
      unsubscribe(); unsubscribeTerminal();
    },
  };
}
