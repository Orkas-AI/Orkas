const _shimLog = createLogger('ipc-shim');
// ─── HTTP → IPC shim ─────────────────────────────────────────────────
// The original app was served over HTTP; every network call went through
// `apiFetch(url, options)` which wrapped `fetch`. In Electron we route the
// same calls through `window.orkas.invoke` (for request/response) or
// `.stream` (for SSE). The shim translates URL + method into an IPC channel
// + payload and returns a Response-like object so the rest of the file's
// 3000+ lines can stay unchanged.
//
// Auth is gone entirely — local IPC is trusted by construction, so
// password / X-Access-Password / access-denied UI all become no-ops.

// Route table. Each entry = [method, pathMatcher, channel, paramKeys?, opts?]
//   - pathMatcher: string (exact match) or RegExp (capture groups → paramKeys)
//   - channel: IPC channel name (or special objects: { fake }, { upload })
//   - paramKeys: names assigned to regex capture groups, merged into payload
//   - opts.stream: boolean (this call yields an SSE-style stream)
//   - opts.wrapAsUpdates: wrap the whole body under `updates` key
const _IPC_ROUTES = [
  // Exact routes
  ['GET',    '/api/auth/status',              { fake: { ok: true, authenticated: true } }],
  ['GET',    '/api/user/init',                'user.init'],
  ['GET',    '/api/conversations/list',       'conversations.list'],
  ['POST',   '/api/conversations/create',     'conversations.create'],
  ['GET',    '/api/agents/list',              'agents.list'],
  ['POST',   '/api/agents/create',            'agents.create'],
  ['GET',    '/api/skills/list',              'skills.list'],
  ['GET',    '/api/skills/read',              'skills.read'],
  ['PUT',    '/api/skills/write',             'skills.writeFile'],
  ['GET',    '/api/skills/tree',              'skills.tree'],
  ['POST',   '/api/skills/create',            'skills.create'],
  ['POST',   '/api/skills/pick-import-dir',   'skills.pickImportDir'],
  ['POST',   '/api/skills/create-from-url',   'skills.createFromUrl'],
  ['POST',   '/api/skills/create-from-dir',   'skills.createFromDir'],
  ['GET',    '/api/contexts/tree',            'contexts.tree'],
  ['GET',    '/api/contexts/read',            'contexts.read'],
  ['GET',    '/api/contexts/index',           'contexts.index'],
  ['POST',   '/api/contexts/write',           'contexts.write'],
  ['PUT',    '/api/contexts/update',          'contexts.update'],
  ['POST',   '/api/contexts/mkdir',           'contexts.mkdir'],
  ['POST',   '/api/contexts/rename',          'contexts.rename'],
  ['DELETE', '/api/contexts/delete',          'contexts.delete'],
  ['POST',   '/api/contexts/upload',          { upload: 'contexts.upload' }],
  ['GET',    '/api/contexts/image',           'contexts.image'],
  ['GET',    '/api/contexts/docx',            'contexts.docxHtml'],
  ['POST',   '/api/contexts/reveal',          'contexts.reveal'],
  ['POST',   '/api/search/global',            'search.global'],
  ['POST',   '/api/conversations/attachments/adopt', 'conversations.attachments.adopt'],
  ['POST',   '/api/common/pick-directory',    'common.pickDirectory'],
  ['GET',    '/api/kb/status',                'kb.status'],
  ['POST',   '/api/kb/reconcile',             'kb.reconcile'],
  ['POST',   '/api/kb/reprocess',             'kb.reprocess'],
  ['POST',   '/api/kb/events/stream',         'kb.events',                  null, { stream: true }],
  ['POST',   '/api/marketplace/categories',   'marketplace.categories'],
  ['POST',   '/api/marketplace/agents/list',  'marketplace.listAgents'],
  ['POST',   '/api/marketplace/skills/list',  'marketplace.listSkills'],
  ['POST',   '/api/marketplace/agents/install', 'marketplace.installAgent'],
  ['POST',   '/api/marketplace/skills/install', 'marketplace.installSkill'],

  // Pattern routes (with path parameters)
  ['DELETE', /^\/api\/conversations\/([^/]+)$/,            'conversations.delete',       ['cid']],
  ['GET',    /^\/api\/conversations\/([^/]+)\/history$/,   'conversations.history',      ['cid']],
  ['POST',   /^\/api\/conversations\/([^/]+)\/send$/,      'groupChat.send',             ['cid']],
  ['POST',   /^\/api\/conversations\/([^/]+)\/send\/stream$/, 'conversations.sendStream', ['cid'], { stream: true }],
  ['POST',   /^\/api\/conversations\/([^/]+)\/abort$/,     'groupChat.abort',            ['cid']],
  ['GET',    /^\/api\/conversations\/([^/]+)\/members$/,   'groupChat.listMembers',      ['cid']],
  ['GET',    /^\/api\/conversations\/([^/]+)\/plan$/,      'groupChat.readPlan',         ['cid']],
  ['POST',   /^\/api\/conversations\/([^/]+)\/plan\/steps\/(\d+)\/retry$/, 'groupChat.retryStep', ['cid', 'stepIndex']],
  ['POST',   /^\/api\/conversations\/([^/]+)\/plan\/steps\/(\d+)\/skip$/,  'groupChat.skipStep',  ['cid', 'stepIndex']],
  ['POST',   /^\/api\/conversations\/([^/]+)\/events\/stream$/, 'groupChat.events',      ['cid'], { stream: true }],
  ['POST',   /^\/api\/conversations\/([^/]+)\/form-submitted$/, 'groupChat.markFormSubmitted', ['cid']],
  ['GET',    /^\/api\/conversations\/([^/]+)\/attachments$/,      'conversations.attachments.list',   ['cid']],
  ['POST',   /^\/api\/conversations\/([^/]+)\/attachments\/upload$/, { upload: 'conversations.attachments.upload' }, ['cid']],
  ['DELETE', /^\/api\/conversations\/([^/]+)\/attachments$/,      'conversations.attachments.delete', ['cid']],
  ['GET',    /^\/api\/agents\/([^/]+)$/,                   'agents.get',                 ['agent_id']],
  ['DELETE', /^\/api\/agents\/([^/]+)$/,                   'agents.delete',              ['agent_id']],
  ['PUT',    /^\/api\/agents\/([^/]+)\/update$/,           'agents.update',              ['agent_id'], { wrapAsUpdates: true }],
  ['GET',    /^\/api\/agents\/([^/]+)\/chat$/,             'agents.chat.history',        ['agent_id']],
  ['DELETE', /^\/api\/agents\/([^/]+)\/chat$/,             'agents.chat.clear',          ['agent_id']],
  ['POST',   /^\/api\/agents\/([^/]+)\/chat\/send$/,       'agents.chat.send',           ['agent_id']],
  ['POST',   /^\/api\/agents\/([^/]+)\/chat\/send\/stream$/, 'agents.chat.sendStream',   ['id'], { stream: true }],
  ['GET',    /^\/api\/skills\/([^/]+)\/chat$/,             'skills.chat.history',        ['id']],
  ['DELETE', /^\/api\/skills\/([^/]+)\/chat$/,             'skills.chat.clear',          ['id']],
  ['POST',   /^\/api\/skills\/([^/]+)\/chat\/send$/,       'skills.chat.send',           ['id']],
  ['POST',   /^\/api\/skills\/([^/]+)\/chat\/send\/stream$/, 'skills.chat.sendStream',   ['id'], { stream: true }],
  ['PUT',    /^\/api\/skills\/([^/]+)\/update$/,           'skills.update',              ['id'], { wrapAsUpdates: true }],
  ['DELETE', /^\/api\/skills\/([^/]+)$/,                   'skills.delete',              ['id']],
];

function _matchRoute(method, pathname) {
  for (const entry of _IPC_ROUTES) {
    const [m, matcher, channel, paramKeys, opts] = entry;
    if (m !== method) continue;
    if (typeof matcher === 'string') {
      if (matcher === pathname) return { channel, params: {}, opts: opts || {} };
    } else {
      const match = matcher.exec(pathname);
      if (match) {
        const params = {};
        // Path params are URL-encoded by callers (encodeURIComponent),
        // so decode them before forwarding to the IPC handler — otherwise
        // ids that contain spaces or non-ASCII chars fail backend
        // validation (e.g. skills.isValidSkillId rejects "%20").
        (paramKeys || []).forEach((k, i) => {
          const raw = match[i + 1];
          try { params[k] = decodeURIComponent(raw); }
          catch { params[k] = raw; }
        });
        return { channel, params, opts: opts || {} };
      }
    }
  }
  return null;
}

/**
 * Build a Response-like object that the original consumer code can .json() or
 * (for streams) .body.getReader() on.
 */
function _mockJsonResponse(result) {
  return {
    ok: result && result.ok !== false,
    status: result && result.ok === false ? 400 : 200,
    json: async () => result,
  };
}

function _mockErrorResponse(error, status) {
  return {
    ok: false,
    status: status || 500,
    json: async () => ({ ok: false, error }),
  };
}

/**
 * Convert a window.orkas.stream call into a Response whose body is a
 * ReadableStream of SSE-formatted bytes. The existing app.js SSE reader
 * (`res.body.getReader()` + 'data: …\\n\\n' parse) works unchanged.
 */
function _streamResponse(channel, payload, signal) {
  const encoder = new TextEncoder();
  let streamHandle = null;

  const readable = new ReadableStream({
    start(controller) {
      streamHandle = window.orkas.stream(channel, payload, (ev) => {
        const chunk = encoder.encode('data: ' + JSON.stringify(ev) + '\n\n');
        try { controller.enqueue(chunk); } catch (_) { /* already closed */ }
      });
      // Always terminate the ReadableStream on promise settle, regardless of
      // whether the user aborted. Previously we gated close/error on an
      // `aborted` flag, which left the stream in a dangling state when the
      // renderer-side AbortController was tripped — reader.read() would hang
      // forever, the caller's try/catch/finally never ran, and the UI stayed
      // stuck in "streaming" state until the user clicked the stop button a
      // second time.
      streamHandle.promise
        .then(() => { try { controller.close(); } catch (_) {} })
        .catch((err) => { try { controller.error(err); } catch (_) {} });
    },
    cancel() {
      if (streamHandle) streamHandle.cancel();
    },
  });

  if (signal) {
    if (signal.aborted) {
      if (streamHandle) streamHandle.cancel();
    } else {
      signal.addEventListener('abort', () => {
        if (streamHandle) streamHandle.cancel();
      });
    }
  }

  return { ok: true, status: 200, body: readable };
}

/**
 * Special-case: binary uploads that used to be multipart/binary POSTs. In IPC
 * we serialize the ArrayBuffer to base64 and send via a regular invoke channel.
 * `channel` is the IPC channel; `extraParams` is merged into the payload
 * (e.g. `{ cid }` for per-conversation attachments).
 */
async function _uploadBinary(channel, options, extraParams) {
  const rawName = ((options.headers || {})['X-Filename']) || '';
  const name = rawName ? decodeURIComponent(rawName) : '';
  const body = options.body;
  let buf;
  if (body instanceof ArrayBuffer) buf = body;
  else if (body && body.buffer instanceof ArrayBuffer) buf = body.buffer;
  else if (body instanceof Uint8Array) buf = body.buffer;
  else return _mockJsonResponse({ ok: false, error: 'binary body required' });

  // Chunk-wise base64 to avoid stack blowup on large files.
  const bytes = new Uint8Array(buf);
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + step, bytes.length)));
  }
  const data = btoa(binary);
  const result = await window.orkas.invoke(channel, { ...(extraParams || {}), name, data });
  return _mockJsonResponse(result);
}

/**
 * Core shim — signature identical to the original `apiFetch(url, options)`.
 * Recognizes the same /api/* surface as the old HTTP server; all unknowns
 * fall through to window.fetch so static assets still load normally.
 */
function apiFetch(url, options) {
  options = options || {};
  const method = (options.method || 'GET').toUpperCase();

  // Absolute URLs and non-API paths → real fetch (e.g. static assets).
  if (typeof url !== 'string' || !url.startsWith('/api/')) {
    return fetch(url, options);
  }

  const qIdx = url.indexOf('?');
  const pathname = qIdx >= 0 ? url.slice(0, qIdx) : url;
  const searchParams = qIdx >= 0 ? new URLSearchParams(url.slice(qIdx + 1)) : new URLSearchParams();

  const route = _matchRoute(method, pathname);
  if (!route) {
    _shimLog.warn('unmatched route:', method, pathname);
    return Promise.resolve(_mockErrorResponse(`unknown route: ${method} ${pathname}`, 404));
  }

  const { channel, params, opts } = route;

  // `fake` — synthetic response used by /api/auth/status (auth is gone).
  if (channel && typeof channel === 'object' && channel.fake) {
    return Promise.resolve(_mockJsonResponse(channel.fake));
  }

  // Build query payload.
  const query = {};
  for (const [k, v] of searchParams.entries()) query[k] = v;

  // Build body payload.
  let body = {};
  if (options.body && typeof options.body === 'string') {
    try { body = JSON.parse(options.body); } catch (_) { body = {}; }
  } else if (options.body && typeof options.body === 'object' && !(options.body instanceof ArrayBuffer) && !(options.body instanceof Uint8Array)) {
    body = options.body;
  }

  // Special: binary upload. `channel.upload` is the IPC channel string to
  // invoke; path params (e.g. `cid`) are merged into the payload.
  if (channel && typeof channel === 'object' && channel.upload) {
    const uploadChannel = typeof channel.upload === 'string' ? channel.upload : 'contexts.upload';
    return _uploadBinary(uploadChannel, options, params);
  }

  // Streaming: go through window.orkas.stream + ReadableStream body.
  if (opts.stream) {
    const payload = { ...query, ...body, ...params };
    return Promise.resolve(_streamResponse(channel, payload, options.signal));
  }

  // Non-stream: single invoke. `wrapAsUpdates` re-shapes body → { updates }.
  const payload = opts.wrapAsUpdates
    ? { ...params, updates: body, ...query }
    : { ...query, ...body, ...params };

  return window.orkas.invoke(channel, payload).then(_mockJsonResponse);
}

