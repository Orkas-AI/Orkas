// Interactive CLI sessions — a small floating stdin/stdout panel for commands
// that cannot complete as one-shot bash calls (OAuth, setup prompts, yes/no).

const _interactiveCliLog = createLogger('interactive-cli');

const _interactiveCliSessions = new Map();
let _interactiveCliHost = null;

// Only trusted host call sites grant presentation; labels, commands and CLI output never do.
function _iclPresentation(value) {
  return ['agent_terminal', 'browser_auth', 'connector_input'].includes(value) ? value : '';
}

function _iclCanShowSession(session) {
  if (!_iclPresentation(session.presentation)) return false;
  if (session.userId && session.userId !== _iclActiveUserId()) return false;
  if (session.presentation !== 'agent_terminal') return true;
  return !!session.userId && !!session.conversationId
    && typeof currentView === 'string' && currentView === 'conversation'
    && typeof currentCid === 'string' && currentCid === session.conversationId;
}

// Navigation detaches the card, retaining its input draft and live session. A
// prompt received off-page stays pending until its owning conversation opens.
function syncInteractiveCliVisibility() {
  for (const session of _interactiveCliSessions.values()) {
    if (!_iclCanShowSession(session)) {
      if (session.card) session.card.remove();
    } else if (session.card) {
      if (!document.body.contains(session.card)) _iclEnsureHost().appendChild(session.card);
    } else if (session.revealRequested) {
      _iclRevealSession(session);
    }
  }
}

// The reviewed Xero CLI uses Inquirer for setup. Project just its current question/choices into
// a normal form; do not turn its output transcript into another terminal presentation.
function _iclConnectorPrompt(session) {
  const lines = String(session.output || '').slice(session.promptOffset || 0)
    .replace(/\u001b\[2K/g, '\n')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*✔\s+/.test(lines[i])) return null;
    const question = lines[i].match(/^\s*\?\s+([^\n]{1,160}:)\s*(?:\(Use arrow keys\))?\s*$/);
    if (!question) continue;
    const choices = [];
    let selected = 0;
    for (const line of lines.slice(i + 1)) {
      const choice = line.match(/^(❯|>)\s+(.{1,160})$|^ {2}(.{1,160})$/);
      if (!choice) break;
      if (choice[1]) selected = choices.length;
      choices.push(choice[2] || choice[3]);
    }
    return { label: question[1], choices, selected };
  }
  return null;
}

function _iclT(key, fallback, vars) {
  try {
    const v = t(key, vars);
    return v && v !== key ? v : fallback;
  } catch (_) {
    return fallback;
  }
}

function _iclEsc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function _iclIcon(name, className) {
  if (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function') {
    return window.uiIconHtml(name, className || 'ui-icon');
  }
  return '';
}

function _iclEnsureHost() {
  if (_interactiveCliHost && document.body.contains(_interactiveCliHost)) return _interactiveCliHost;
  _interactiveCliHost = document.createElement('div');
  _interactiveCliHost.className = 'interactive-cli-host';
  _interactiveCliHost.setAttribute('aria-live', 'polite');
  document.body.appendChild(_interactiveCliHost);
  return _interactiveCliHost;
}

function _iclStatusLabel(status) {
  const s = String(status || 'running');
  return _iclT(`interactive_cli.status.${s}`, s);
}

function _iclPromptLabel(kind) {
  const k = String(kind || '');
  if (!k) return '';
  return _iclT(`interactive_cli.prompt.${k}`, k);
}

function _iclSessionTitle(session) {
  const purpose = String(session.purpose || '').trim();
  if (purpose) return purpose;
  const prompt = _iclPromptLabel(session.prompt_kind);
  if (prompt) return prompt;
  return _iclT('interactive_cli.title', 'Action required');
}

function _iclUpdateLinks(session) {
  if (!session.card) return;
  const links = session.card.querySelector('[data-icl-links]');
  let urls = Array.isArray(session.urls) ? session.urls : [];
  if (session.presentation !== 'agent_terminal') {
    urls = session.status === 'running' ? [...new Set(urls.map(_iclLocalConnectorAuthUrl).filter(Boolean))] : [];
  }
  links.innerHTML = '';
  links.hidden = urls.length === 0;
  for (const url of urls) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'interactive-cli-link';
    btn.innerHTML = `${_iclIcon('external', 'interactive-cli-link-icon')}<span>${_iclEsc(_iclT('interactive_cli.open_link', 'Open link'))}</span>`;
    btn.title = url;
    btn.addEventListener('click', () => {
      if (!window.orkas || typeof window.orkas.invoke !== 'function') return;
      window.orkas.invoke('auth.openExternal', { url }).catch(() => {
        _interactiveCliLog.warn('open external failed');
      });
    });
    links.appendChild(btn);
  }
}

function _iclSetSensitive(session, sensitive) {
  session.sensitive = !!sensitive;
  if (!session.card) return;
  const checkbox = session.card.querySelector('[data-icl-sensitive]');
  const input = session.card.querySelector('[data-icl-input]');
  if (checkbox) checkbox.checked = session.sensitive;
  if (input) input.type = session.sensitive ? 'password' : 'text';
}

function _iclApplyState(session) {
  if (!session.card) return;
  const title = session.card.querySelector('[data-icl-title]');
  const status = session.card.querySelector('[data-icl-status]');
  const prompt = session.card.querySelector('[data-icl-prompt]');
  const output = session.card.querySelector('[data-icl-output]');
  const browserHint = session.card.querySelector('[data-icl-browser-hint]');
  const setupPrompt = session.card.querySelector('[data-icl-setup-prompt]');
  const setupChoices = session.card.querySelector('[data-icl-setup-choices]');
  const setupNavigation = session.card.querySelector('[data-icl-setup-navigation]');
  const input = session.card.querySelector('[data-icl-input]');
  const send = session.card.querySelector('[data-icl-send]');
  const stop = session.card.querySelector('[data-icl-stop]');
  const close = session.card.querySelector('[data-icl-close]');
  const sensitive = session.card.querySelector('[data-icl-sensitive]');
  const form = session.card.querySelector('[data-icl-form]');
  const isRunning = session.status === 'running';
  const isSending = !!session.sendPromise;
  const question = session.presentation === 'connector_input' && isRunning ? _iclConnectorPrompt(session) : null;

  if (title) title.textContent = _iclSessionTitle(session);
  if (status) {
    status.textContent = _iclStatusLabel(session.status);
    status.dataset.status = session.status || 'running';
  }
  const promptText = _iclPromptLabel(session.prompt_kind);
  if (prompt) {
    prompt.textContent = promptText;
    prompt.hidden = !promptText;
  }
  if (output) {
    output.textContent = session.output || _iclT('interactive_cli.output_empty', 'Waiting for output...');
    output.scrollTop = output.scrollHeight;
  }
  if (browserHint) {
    browserHint.hidden = !!question;
    browserHint.textContent = session.status === 'error'
      ? _iclT('connectors.errors.authorization_failed', 'Authorization did not finish. Reconnect and complete authorization on the official page.')
      : session.status === 'running'
        ? _iclT('interactive_cli.browser_auth_hint', 'Complete authorization in your browser. If it did not open, use the link below.')
        : _iclStatusLabel(session.status);
  }
  if (setupPrompt) {
    setupPrompt.textContent = question ? question.label : '';
    setupPrompt.hidden = !question;
    if (input && question) input.setAttribute('aria-label', question.label);
  }
  if (setupChoices) {
    const choices = question ? question.choices : [];
    setupChoices.hidden = !choices.length;
    const signature = JSON.stringify([choices, question && question.selected]);
    if (setupChoices.dataset.choices !== signature) {
      setupChoices.dataset.choices = signature;
      setupChoices.innerHTML = '';
      choices.forEach((label, index) => {
        const option = document.createElement('option');
        option.value = String(index);
        option.textContent = label;
        setupChoices.appendChild(option);
      });
      setupChoices.value = String(question ? question.selected : 0);
    }
    setupChoices.disabled = !isRunning || isSending;
    if (question) setupChoices.setAttribute('aria-label', question.label);
    if (setupNavigation) {
      setupNavigation.hidden = !choices.length;
      setupNavigation.querySelectorAll('button').forEach((button) => { button.disabled = !isRunning || isSending; });
    }
    if (input) input.hidden = !!choices.length;
  }
  if (form) form.hidden = !isRunning || (session.presentation === 'connector_input' && !question);
  if (input) input.disabled = !isRunning || isSending;
  if (send) send.disabled = !isRunning || isSending;
  if (send) send.textContent = session.presentation === 'agent_terminal'
    ? _iclT('interactive_cli.send', 'Send') : _iclT('common.confirm', 'Confirm');
  for (const [selector, key, fallback] of [
    ['[data-icl-choice-previous]', 'interactive_cli.previous_option', 'Previous option'],
    ['[data-icl-choice-next]', 'interactive_cli.next_option', 'Next option'],
  ]) {
    const button = session.card.querySelector(selector);
    if (button) button.setAttribute('aria-label', _iclT(key, fallback));
  }
  if (sensitive) sensitive.disabled = !isRunning || isSending;
  if (stop) stop.disabled = !isRunning;
  if (close) close.disabled = false;
  _iclSetSensitive(session, session.sensitive || session.sensitive_hint);
  _iclUpdateLinks(session);
}

function _iclRemoveSession(id) {
  const session = _interactiveCliSessions.get(id);
  if (!session) return;
  if (session.dismissTimer) clearTimeout(session.dismissTimer);
  if (session.card) session.card.remove();
  _interactiveCliSessions.delete(id);
  if (_interactiveCliHost && _interactiveCliHost.childElementCount === 0) {
    _interactiveCliHost.remove();
    _interactiveCliHost = null;
  }
}

function _iclScheduleDismiss(session) {
  if (!session || session.status === 'running' || session.dismissTimer) return;
  const delay = session.status === 'error' ? 7000 : 3500;
  session.dismissTimer = setTimeout(() => _iclRemoveSession(session.id), delay);
}

function _iclDecodeUrlText(value) {
  let out = String(value || '').replace(/\+/g, ' ');
  for (let i = 0; i < 2; i += 1) {
    try {
      const next = decodeURIComponent(out).replace(/\+/g, ' ');
      if (next === out) break;
      out = next;
    } catch (_) {
      break;
    }
  }
  return out;
}

// Keep this route table in lockstep with main/util/window-security.ts. The main-process policy is
// authoritative; this renderer copy only decides whether to request auto-open and reveal fallback UI.
const _ICL_LOCAL_CONNECTOR_AUTH_ROUTES = new Map([
  ['open.feishu.cn', new Map([['/page/cli', ['user_code']]])],
  ['open.larksuite.com', new Map([['/page/cli', ['user_code']]])],
  ['accounts.feishu.cn', new Map([['/oauth/v1/device/verify', ['flow_id', 'user_code']]])],
  ['accounts.larksuite.com', new Map([['/oauth/v1/device/verify', ['flow_id', 'user_code']]])],
  ['login.dingtalk.com', new Map([['/oauth2/device/verify.htm', ['user_code']]])],
  ['work.weixin.qq.com', new Map([['/ai/qc/gen', ['source', 'scode']]])],
  ['identity.constantcontact.com', new Map([['/activate', ['user_code']]])],
  ['authz.constantcontact.com', new Map([['/activate', ['user_code']]])],
]);

function _iclLocalConnectorAuthUrl(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value || value.length > 2048 || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.port || url.hash) {
      return null;
    }
    const routes = _ICL_LOCAL_CONNECTOR_AUTH_ROUTES.get(url.hostname.toLowerCase());
    const requiredQueryKeys = routes && routes.get(url.pathname);
    if (!requiredQueryKeys) return null;
    if (url.hostname === 'work.weixin.qq.com' && url.searchParams.get('source') !== 'wecom_cli_external') return null;
    for (const key of requiredQueryKeys) {
      const values = url.searchParams.getAll(key);
      if (values.length !== 1 || !values[0] || values[0].length > 512) return null;
      if (/[\u0000-\u001f\u007f]/u.test(values[0])) return null;
    }
    return url.toString();
  } catch (_) {
    return null;
  }
}

function _iclAutoOpenLocalConnectorAuthUrls(session) {
  if (!session || session.status !== 'running') return;
  if (!_iclPresentation(session.presentation)) return;
  if (!window.orkas || typeof window.orkas.invoke !== 'function') return;
  if (!(session.autoOpenAttempts instanceof Set)) session.autoOpenAttempts = new Set();
  const urls = Array.isArray(session.urls) ? session.urls : [];
  for (const raw of urls) {
    const url = _iclLocalConnectorAuthUrl(raw);
    if (!url || session.autoOpenAttempts.has(url)) continue;
    session.autoOpenAttempts.add(url);
    Promise.resolve()
      .then(() => window.orkas.invoke('connectors.open_local_cli_auth_url', { url }))
      .then((result) => {
        if (!result || result.ok === false || result.opened !== true) {
          throw new Error(result && result.code ? String(result.code) : 'local_cli_auth_url_open_failed');
        }
      })
      .catch(() => {
        session.autoOpenFailed = true;
        _interactiveCliLog.warn('auto-open local connector authorization failed');
        if (session.status === 'running' && typeof document.createElement === 'function') {
          if (!session.card) _iclRevealSession(session);
          _iclApplyState(session);
        }
      });
  }
}

function _iclLooksLikeInteractiveAuthUrl(url) {
  const decoded = _iclDecodeUrlText(url);
  return /accounts\.google\.com\/o\/oauth2|login\.microsoftonline\.com|github\.com\/login\/device|\/oauth2?\/authorize|\/authorize\b|code_challenge=|redirect_uri=http/i.test(decoded);
}

function _iclOutputAsksForBrowserAction(text) {
  return /browser has been opened|has been opened to visit|complete (?:the )?(?:sign[- ]in|authorization)|finish (?:the )?(?:sign[- ]in|authorization)|copy .*browser|open (?:this )?(?:url|link)|visit (?:this )?(?:url|link)|if (?:the )?browser (?:doesn't|does not) open/i.test(String(text || ''));
}

function _iclShouldRevealForOutput(payload, session) {
  if (!session || session.status !== 'running') return false;
  if (!_iclPresentation(session.presentation)) return false;
  if (session.presentation === 'browser_auth') return session.autoOpenFailed === true;
  if (session.presentation === 'connector_input') return !!_iclConnectorPrompt(session) || session.autoOpenFailed === true;
  if (payload && payload.prompt_kind) return true;
  const text = String((payload && payload.text) || session.output || '');
  const urls = Array.isArray(session.urls) ? session.urls : [];
  if (!urls.length) return false;
  if (urls.some(_iclLocalConnectorAuthUrl)) return session.autoOpenFailed === true;
  return _iclOutputAsksForBrowserAction(text) && urls.some(_iclLooksLikeInteractiveAuthUrl);
}

function _iclEnsureSession(payload, opts) {
  const id = String(payload && payload.session_id || '');
  if (!id) return null;
  const conversationId = typeof payload.conversation_id === 'string' ? payload.conversation_id : '';
  const presentation = _iclPresentation(payload.presentation);
  const existing = _interactiveCliSessions.get(id);
  if (existing) {
    if (payload.purpose) existing.purpose = String(payload.purpose);
    if (payload.status) existing.status = String(payload.status);
    if (opts && opts.reveal) _iclRevealSession(existing);
    return existing;
  }

  const session = {
    id,
    card: null,
    userId: String(payload.user_id || '').trim(),
    conversationId,
    revealRequested: false,
    purpose: String(payload.purpose || ''),
    status: String(payload.status || 'running'),
    presentation: presentation === 'agent_terminal' && !conversationId.trim() ? '' : presentation,
    output: '',
    urls: [],
    prompt_kind: '',
    sensitive_hint: false,
    sensitive: false,
    sendPromise: null,
    dismissTimer: null,
    autoOpenAttempts: new Set(),
    autoOpenFailed: false,
  };
  _interactiveCliSessions.set(id, session);
  if (opts && opts.reveal) _iclRevealSession(session);
  return session;
}

function _iclRevealSession(session) {
  if (!session) return;
  if (!_iclPresentation(session.presentation)) return;
  session.revealRequested = true;
  if (!_iclCanShowSession(session) || session.card) return;
  const browserAuth = session.presentation === 'browser_auth';
  const terminal = session.presentation === 'agent_terminal';
  const host = _iclEnsureHost();
  const card = document.createElement('section');
  card.className = 'interactive-cli-card';
  card.dataset.sessionId = session.id;
  card.dataset.presentation = session.presentation;
  card.innerHTML = `
    <div class="interactive-cli-head">
      <div class="interactive-cli-icon" aria-hidden="true">${_iclIcon(terminal ? 'terminal' : 'external', 'interactive-cli-terminal-icon')}</div>
      <div class="interactive-cli-head-main">
        <div class="interactive-cli-title" data-icl-title></div>
        <div class="interactive-cli-meta">
          <span class="interactive-cli-status" data-icl-status></span>
          ${terminal ? '<span class="interactive-cli-prompt" data-icl-prompt hidden></span>' : ''}
        </div>
      </div>
      <div class="interactive-cli-actions">
        <button type="button" class="interactive-cli-stop" data-icl-stop title="${_iclEsc(_iclT('interactive_cli.stop', 'Stop'))}" aria-label="${_iclEsc(_iclT('interactive_cli.stop', 'Stop'))}">
          ${_iclIcon('squareFilled', 'interactive-cli-stop-icon')}
        </button>
        <button type="button" class="interactive-cli-close" data-icl-close title="${_iclEsc(_iclT('common.close', 'Close'))}" aria-label="${_iclEsc(_iclT('common.close', 'Close'))}">
          ${_iclIcon('x', 'interactive-cli-close-icon')}
        </button>
      </div>
    </div>
    ${terminal ? '<pre class="interactive-cli-output" data-icl-output></pre>' : '<p class="ui-dialog-message" data-icl-browser-hint></p>'}
    <div class="interactive-cli-links" data-icl-links hidden></div>
    ${browserAuth ? '' : `<form class="interactive-cli-form" data-icl-form>
      ${terminal ? '' : `<label data-icl-setup-prompt></label><select class="interactive-cli-input" data-icl-setup-choices hidden></select>
      <span data-icl-setup-navigation hidden>
        <button type="button" class="btn btn-secondary btn-sm" data-icl-choice-previous aria-label="${_iclEsc(_iclT('interactive_cli.previous_option', 'Previous option'))}">↑</button>
        <button type="button" class="btn btn-secondary btn-sm" data-icl-choice-next aria-label="${_iclEsc(_iclT('interactive_cli.next_option', 'Next option'))}">↓</button>
      </span>`}
      <input class="interactive-cli-input" data-icl-input type="text" autocomplete="off" spellcheck="false" placeholder="${_iclEsc(_iclT('interactive_cli.input_placeholder', 'Enter here'))}" />
      ${terminal ? `<label class="interactive-cli-sensitive">
        <input type="checkbox" data-icl-sensitive />
        <span>${_iclEsc(_iclT('interactive_cli.sensitive', 'Hide input'))}</span>
      </label>` : ''}
      <button type="submit" class="btn btn-primary btn-sm interactive-cli-send" data-icl-send>${_iclEsc(_iclT('interactive_cli.send', 'Send'))}</button>
    </form>`}
  `;
  host.appendChild(card);
  session.card = card;

  const form = card.querySelector('[data-icl-form]');
  const input = card.querySelector('[data-icl-input]');
  const sensitive = card.querySelector('[data-icl-sensitive]');
  const send = card.querySelector('[data-icl-send]');
  const stop = card.querySelector('[data-icl-stop]');
  const close = card.querySelector('[data-icl-close]');

  // Inquirer may page a long organisation list. Move its cursor without submitting so the
  // provider can reveal the next page; the select still submits only the user's chosen row.
  for (const [selector, key] of [['[data-icl-choice-previous]', '\u001b[A'], ['[data-icl-choice-next]', '\u001b[B']]) {
    const button = card.querySelector(selector);
    if (button) button.addEventListener('click', () => {
      if (session.sendPromise || !input || input.disabled) return;
      _iclSendInput(session, input, send, { input: key, addNewline: false });
    });
  }

  if (sensitive) {
    sensitive.addEventListener('change', () => _iclSetSensitive(session, sensitive.checked));
  }
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!input || input.disabled) return;
      const question = session.presentation === 'connector_input' ? _iclConnectorPrompt(session) : null;
      if (session.presentation === 'connector_input' && !question) return;
      const promptOffset = session.output.length;
      const choices = card.querySelector('[data-icl-setup-choices]');
      const delta = question && question.choices.length ? Number(choices.value) - question.selected : 0;
      const sent = await _iclSendInput(session, input, send, question && question.choices.length ? {
        input: (delta < 0 ? '\u001b[A' : '\u001b[B').repeat(Math.abs(delta)) + '\r',
        addNewline: false,
      } : undefined);
      if (question && sent) {
        session.promptOffset = promptOffset;
        _iclApplyState(session);
      }
    });
  }
  if (close) {
    close.addEventListener('click', () => {
      _iclRemoveSession(session.id);
    });
  }
  if (stop) {
    stop.addEventListener('click', async () => {
      if (session.status !== 'running') return;
      try {
        await window.orkas.invoke('interactiveCli.close', { session_id: session.id });
      } catch (err) {
        _interactiveCliLog.warn('stop session failed', { error: err && err.message });
      }
    });
  }

  _iclApplyState(session);
}

async function _iclSendInput(session, input, send, options) {
  if (session.presentation === 'agent_terminal' && !_iclCanShowSession(session)) return false;
  if (session.sendPromise) return session.sendPromise;
  const value = options ? options.input : input.value;
  const operation = (async () => {
    try {
      await window.orkas.invoke('interactiveCli.send', {
        session_id: session.id,
        input: value,
        add_newline: options ? options.addNewline : true,
        sensitive: !!session.sensitive,
      });
      input.value = '';
      return true;
    } catch (err) {
      _interactiveCliLog.warn('send input failed', { error: err && err.message });
      if (typeof uiToast === 'function') {
        uiToast(_iclT('interactive_cli.send_failed', 'Failed to send input'), { variant: 'error' });
      }
      return false;
    }
  })();
  session.sendPromise = operation;
  input.disabled = true;
  if (send) send.disabled = true;
  const sensitive = session.card && session.card.querySelector('[data-icl-sensitive]');
  if (sensitive) sensitive.disabled = true;
  try {
    return await operation;
  } finally {
    if (session.sendPromise === operation) session.sendPromise = null;
    if (session.card) {
      _iclApplyState(session);
    } else {
      const isRunning = session.status === 'running';
      input.disabled = !isRunning;
      if (send) send.disabled = !isRunning;
    }
  }
}

function _iclActiveUserId() {
  const lexical = typeof currentUserId === 'string' ? currentUserId.trim() : '';
  const global = typeof globalThis.currentUserId === 'string'
    ? globalThis.currentUserId.trim()
    : '';
  return lexical || global;
}

function _iclHandleEvent(payload) {
  const owner = String(payload && payload.user_id || '').trim();
  const activeUser = _iclActiveUserId();
  if (!owner || !activeUser || owner !== activeUser) return;
  const type = String(payload && payload.type || '');
  const session = _iclEnsureSession(payload, { reveal: false });
  if (!session) return;
  if (payload.status) session.status = String(payload.status);
  if (payload.purpose) session.purpose = String(payload.purpose);
  if (payload.prompt_kind) session.prompt_kind = String(payload.prompt_kind);
  if (typeof payload.sensitive_hint === 'boolean') session.sensitive_hint = payload.sensitive_hint;
  if (Array.isArray(payload.urls)) session.urls = payload.urls.map(String).filter(Boolean);
  if (type === 'output' && typeof payload.text === 'string') {
    session.output += payload.text;
    const overflow = session.output.length - 64 * 1024;
    if (overflow > 0) {
      session.output = session.output.slice(overflow);
      session.promptOffset = Math.max(0, (session.promptOffset || 0) - overflow);
    }
  }
  if (type === 'exited' || type === 'closed' || type === 'error') {
    session.status = type;
  }
  // The connector's result dialog owns authorization failures. Retire any setup/retry
  // card as well, so an error cannot reveal or retain a second process panel.
  if (session.status === 'error' && session.presentation !== 'agent_terminal') {
    _iclRemoveSession(session.id);
    return;
  }
  _iclAutoOpenLocalConnectorAuthUrls(session);
  const shouldReveal =
    !!session.card
    || (type === 'waiting_input' && session.presentation === 'agent_terminal')
    || type === 'error'
    || _iclShouldRevealForOutput(payload, session);
  if (shouldReveal && !session.card) _iclRevealSession(session);
  _iclApplyState(session);
  syncInteractiveCliVisibility();
  if (session.status !== 'running') _iclScheduleDismiss(session);
  if (type === 'waiting_input') {
    const input = session.card && session.card.querySelector('[data-icl-input]');
    if (input) setTimeout(() => {
      if (_iclCanShowSession(session) && document.body.contains(input) && !input.disabled) input.focus();
    }, 0);
  }
}

window.addEventListener('i18n-change', () => {
  for (const session of _interactiveCliSessions.values()) _iclApplyState(session);
});

if (window.orkas && typeof window.orkas.onPushEvent === 'function') {
  try {
    window.orkas.onPushEvent('interactive-cli:event', _iclHandleEvent);
  } catch (err) {
    _interactiveCliLog.warn('interactive CLI push channel unavailable', { error: err && err.message });
  }
}
