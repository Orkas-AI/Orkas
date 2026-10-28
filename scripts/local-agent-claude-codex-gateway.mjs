/** Opt-in test transport only. Claude executes tools; this gateway never does.
 * It bridges text/function calls to one authenticated Codex model, with no
 * credential refresh, provider fallback, prompt additions or semantic repair. */
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

export const CLAUDE_CODEX_TEST_MODEL = 'gpt-6.1-sol';
const zeroUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const fail = (code = 'unsupported-content') => { const error = new Error('Unsupported Claude/Codex test protocol'); error.code = code; throw error; };
const textBlocks = content => {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return fail('invalid-text-container');
  return content.map(block => block?.type === 'text' && typeof block.text === 'string'
    ? { type: 'text', text: block.text } : fail('unsupported-text-block'));
};

/** Reject unsupported blocks rather than silently dropping user instructions,
 * images, deferred tools or a tool result whose identity cannot be established. */
export function anthropicContext(body) {
  if (!body || !Array.isArray(body.messages) || !body.messages.length) return fail('missing-messages');
  const context = { systemPrompt: body.system === undefined ? '' : textBlocks(body.system).map(b => b.text).join('\n'),
    tools: (body.tools ?? []).map(tool => {
      if (typeof tool.name !== 'string' || !/^[\w-]{1,128}$/.test(tool.name)
        || !tool.input_schema || typeof tool.input_schema !== 'object' || tool.type || tool.defer_loading) return fail('unsupported-tool-schema');
      return { name: tool.name, description: tool.description ?? '', parameters: tool.input_schema };
    }), messages: [] };
  const calls = new Map();
  for (const message of body.messages) {
    if (message.role === 'system') {
      context.messages.push({ role: 'system', content: textBlocks(message.content), timestamp: 0 });
      continue;
    }
    if (!['user', 'assistant'].includes(message.role)) return fail('unsupported-message-role');
    const content = typeof message.content === 'string' ? textBlocks(message.content) : message.content;
    if (!Array.isArray(content)) return fail('invalid-message-container');
    if (message.role === 'assistant') {
      const blocks = content.map(block => {
        if (block.type === 'text' && typeof block.text === 'string') return { type: 'text', text: block.text };
        if (block.type !== 'tool_use' || typeof block.id !== 'string' || typeof block.name !== 'string'
          || !block.input || typeof block.input !== 'object' || calls.has(block.id)) return fail('unsupported-assistant-block');
        calls.set(block.id, block.name);
        return { type: 'toolCall', id: block.id, name: block.name, arguments: block.input };
      });
      context.messages.push({ role: 'assistant', content: blocks, api: 'openai-codex-responses',
        provider: 'openai-codex', model: CLAUDE_CODEX_TEST_MODEL, usage: zeroUsage(), stopReason: 'stop', timestamp: 0 });
    } else {
      let pending = [];
      const flush = () => { if (pending.length) context.messages.push({ role: 'user', content: pending, timestamp: 0 }); pending = []; };
      for (const block of content) {
        if (block.type === 'text' && typeof block.text === 'string') pending.push({ type: 'text', text: block.text });
        else if (block.type === 'tool_result' && calls.has(block.tool_use_id)) {
          flush();
          context.messages.push({ role: 'toolResult', toolCallId: block.tool_use_id, toolName: calls.get(block.tool_use_id),
            content: textBlocks(block.content ?? ''), isError: block.is_error === true, timestamp: 0 });
          calls.delete(block.tool_use_id);
        } else return fail('unsupported-user-block');
      }
      flush();
    }
  }
  return context;
}

async function codexStream(apiKey) {
  const [{ streamSimple }, { getBuiltinModel }] = await Promise.all([
    import('@earendil-works/pi-ai/compat'), import('@earendil-works/pi-ai/providers/all'),
  ]);
  const model = getBuiltinModel('openai-codex', CLAUDE_CODEX_TEST_MODEL);
  if (!model || model.api !== 'openai-codex-responses' || new URL(model.baseUrl).hostname !== 'chatgpt.com' || !apiKey) {
    throw new Error('Authenticated Codex test route is unavailable');
  }
  return (context, options) => streamSimple(model, context, {
    apiKey, signal: options.signal, maxTokens: options.maxTokens, reasoning: 'low', transport: 'sse',
    timeoutMs: options.timeoutMs, maxRetries: 0, env: {},
  });
}

export async function createClaudeCodexGateway({ apiKey, stream, token = randomBytes(32).toString('hex'),
  requestBudget = 24, requestTimeoutMs = 120_000 } = {}) {
  if (!Number.isInteger(requestBudget) || requestBudget < 1 || requestBudget > 24
    || !Number.isFinite(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 120_000) return fail();
  const upstream = stream ?? await codexStream(apiKey);
  const stats = { model: CLAUDE_CODEX_TEST_MODEL, requests: 0, completed: 0, cancelled: 0, failed: 0,
    rejected: 0, rejectionCodes: {}, active: 0, inputTokens: 0, outputTokens: 0, textDeltas: 0, toolCalls: 0, reasoningEvents: 0 };
  const controllers = new Set(); const pending = new Set();
  const errorBody = (res, status, type, code = type) => {
    stats.rejected++;
    stats.rejectionCodes[code] = (stats.rejectionCodes[code] ?? 0) + 1;
    res.writeHead(status, { 'content-type': 'application/json', 'x-should-retry': 'false' });
    res.end(JSON.stringify({ type: 'error', error: { type, message: 'Isolated CLI test request rejected.' } }));
  };
  async function handle(req, res) {
    if (req.headers['x-api-key'] !== token && req.headers.authorization !== `Bearer ${token}`) return errorBody(res, 401, 'authentication_error');
    const route = req.url?.split('?')[0];
    if (route === '/api/hello' && req.method === 'HEAD') { res.writeHead(200); res.end(); return; }
    if (route === '/v1/models' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: CLAUDE_CODEX_TEST_MODEL, type: 'model', display_name: CLAUDE_CODEX_TEST_MODEL }], has_more: false })); return;
    }
    if (route !== '/v1/messages' || req.method !== 'POST') return errorBody(res, 404, 'not_found_error');
    let bytes = 0; const chunks = [];
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) return errorBody(res, 413, 'invalid_request_error');
      chunks.push(chunk);
    }
    let body, context;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (body.stream !== true) return errorBody(res, 400, 'invalid_request_error', 'stream-required');
      if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1) return errorBody(res, 400, 'invalid_request_error', 'invalid-token-limit');
      if (body.tool_choice && body.tool_choice.type !== 'auto') return errorBody(res, 400, 'invalid_request_error', 'unsupported-tool-choice');
      context = anthropicContext(body);
    } catch (error) { return errorBody(res, 400, 'invalid_request_error', error.code ?? 'invalid-json'); }
    if (stats.requests >= requestBudget) return errorBody(res, 429, 'rate_limit_error');
    if (stats.active) return errorBody(res, 409, 'overloaded_error');
    const controller = new AbortController(); controllers.add(controller);
    stats.requests++; stats.active++;
    let terminal = false, expired = false, clientClosed = false;
    const emit = (event, data) => {
      if (!res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
    };
    const timer = setTimeout(() => { expired = true; controller.abort(); }, requestTimeoutMs);
    const heartbeat = setInterval(() => emit('ping', {}), 10_000);
    const disconnected = () => { if (!terminal) { clientClosed = true; controller.abort(); } };
    res.on('close', disconnected);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-should-retry': 'false' });
    emit('message_start', { message: { id: `msg_${stats.requests}`, type: 'message', role: 'assistant', model: CLAUDE_CODEX_TEST_MODEL,
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
    const blocks = new Map(); let nextIndex = 0;
    try {
      for await (const event of upstream(context, { model: CLAUDE_CODEX_TEST_MODEL, signal: controller.signal,
        maxTokens: Math.min(body.max_tokens, 4096), timeoutMs: requestTimeoutMs })) {
        if (controller.signal.aborted || terminal) throw new Error('Closed gateway stream');
        if (event.type.startsWith('thinking_')) { stats.reasoningEvents++; continue; }
        if (event.type === 'text_start' || event.type === 'toolcall_start') {
          if (blocks.has(event.contentIndex)) throw new Error('Duplicate stream block');
          const block = { index: nextIndex++, kind: event.type === 'text_start' ? 'text' : 'tool', deltas: 0 };
          blocks.set(event.contentIndex, block);
          const call = event.partial?.content[event.contentIndex];
          if (block.kind === 'tool' && (!call?.id || !call.name)) throw new Error('Missing tool identity');
          emit('content_block_start', { index: block.index, content_block: block.kind === 'text'
            ? { type: 'text', text: '' } : { type: 'tool_use', id: 'call_' + createHash('sha256').update(call.id).digest('hex').slice(0, 32), name: call.name, input: {} } });
          if (block.kind === 'tool') stats.toolCalls++;
        } else if (event.type === 'text_delta' || event.type === 'toolcall_delta') {
          const block = blocks.get(event.contentIndex);
          if (!block || block.closed || typeof event.delta !== 'string') throw new Error('Invalid stream delta');
          block.deltas++;
          if (event.type === 'text_delta') stats.textDeltas++;
          emit('content_block_delta', { index: block.index, delta: event.type === 'text_delta'
            ? { type: 'text_delta', text: event.delta } : { type: 'input_json_delta', partial_json: event.delta } });
        } else if (event.type === 'text_end' || event.type === 'toolcall_end') {
          const block = blocks.get(event.contentIndex);
          if (!block || block.closed) throw new Error('Invalid stream block end');
          if (block.kind === 'tool' && !block.deltas) emit('content_block_delta', { index: block.index,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(event.toolCall.arguments) } });
          block.closed = true; emit('content_block_stop', { index: block.index });
        } else if (event.type === 'done') {
          const reason = { stop: 'end_turn', toolUse: 'tool_use', length: 'max_tokens' }[event.reason];
          if (!reason || !blocks.size || [...blocks.values()].some(b => !b.closed)) throw new Error('Incomplete upstream response');
          const usage = event.message.usage;
          stats.inputTokens += usage.input ?? 0; stats.outputTokens += usage.output ?? 0;
          emit('message_delta', { delta: { stop_reason: reason, stop_sequence: null },
            usage: { input_tokens: usage.input ?? 0, output_tokens: usage.output ?? 0 } });
          emit('message_stop', {}); terminal = true; stats.completed++; res.end();
        } else if (event.type === 'error') throw new Error('Codex request failed');
        else if (event.type !== 'start') throw new Error('Unsupported upstream event');
      }
      if (!terminal) throw new Error('Upstream ended without a terminal response');
    } catch {
      if (clientClosed && !expired) stats.cancelled++;
      else {
        stats.failed++;
        emit('error', { error: { type: 'api_error', message: expired ? 'Isolated Codex test deadline exceeded.' : 'Isolated Codex test request failed.' } });
      }
      terminal = true; res.end();
    } finally {
      clearTimeout(timer); clearInterval(heartbeat); res.off('close', disconnected);
      controller.abort(); controllers.delete(controller); stats.active--;
    }
  }
  const server = http.createServer((req, res) => {
    const task = handle(req, res).catch(() => {
      stats.failed++;
      if (!res.headersSent) errorBody(res, 500, 'api_error'); else res.destroy();
    }).finally(() => pending.delete(task));
    pending.add(task);
  });
  server.maxConnections = 8;
  server.requestTimeout = requestTimeoutMs; server.headersTimeout = Math.min(15_000, requestTimeoutMs);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`, token, stats,
    async close() {
      for (const controller of controllers) controller.abort();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await Promise.allSettled([...pending]);
    } };
}
