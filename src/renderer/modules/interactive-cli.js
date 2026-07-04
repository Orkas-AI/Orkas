// Interactive CLI sessions — a small floating stdin/stdout panel for commands
// that cannot complete as one-shot bash calls (OAuth, setup prompts, yes/no).

const _interactiveCliLog = createLogger('interactive-cli');

const _interactiveCliSessions = new Map();
let _interactiveCliHost = null;

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
  return _iclT('interactive_cli.title', 'CLI operation');
}

function _iclUpdateLinks(session) {
  if (!session.card) return;
  const links = session.card.querySelector('[data-icl-links]');
  const urls = Array.isArray(session.urls) ? session.urls : [];
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
      window.orkas.invoke('auth.openExternal', { url }).catch((err) => {
        _interactiveCliLog.warn('open external failed', { error: err && err.message });
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
  const input = session.card.querySelector('[data-icl-input]');
  const send = session.card.querySelector('[data-icl-send]');
  const stop = session.card.querySelector('[data-icl-stop]');
  const close = session.card.querySelector('[data-icl-close]');
  const form = session.card.querySelector('[data-icl-form]');
  const isRunning = session.status === 'running';

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
  if (form) form.hidden = !isRunning;
  if (input) input.disabled = !isRunning;
  if (send) send.disabled = !isRunning;
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

function _iclLooksLikeInteractiveAuthUrl(url) {
  const decoded = _iclDecodeUrlText(url);
  return /accounts\.google\.com\/o\/oauth2|login\.microsoftonline\.com|github\.com\/login\/device|\/oauth2?\/authorize|\/authorize\b|code_challenge=|redirect_uri=http/i.test(decoded);
}

function _iclOutputAsksForBrowserAction(text) {
  return /browser has been opened|has been opened to visit|complete (?:the )?(?:sign[- ]in|authorization)|finish (?:the )?(?:sign[- ]in|authorization)|copy .*browser|open (?:this )?(?:url|link)|visit (?:this )?(?:url|link)|if (?:the )?browser (?:doesn't|does not) open/i.test(String(text || ''));
}

function _iclShouldRevealForOutput(payload, session) {
  if (!session || session.status !== 'running') return false;
  if (payload && payload.prompt_kind) return true;
  const text = String((payload && payload.text) || session.output || '');
  const urls = Array.isArray(session.urls) ? session.urls : [];
  if (!urls.length) return false;
  return _iclOutputAsksForBrowserAction(text) && urls.some(_iclLooksLikeInteractiveAuthUrl);
}

function _iclEnsureSession(payload, opts) {
  const id = String(payload && payload.session_id || '');
  if (!id) return null;
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
    purpose: String(payload.purpose || ''),
    status: String(payload.status || 'running'),
    output: '',
    urls: [],
    prompt_kind: '',
    sensitive_hint: false,
    sensitive: false,
    dismissTimer: null,
  };
  _interactiveCliSessions.set(id, session);
  if (opts && opts.reveal) _iclRevealSession(session);
  return session;
}

function _iclRevealSession(session) {
  if (!session || session.card) return;
  const host = _iclEnsureHost();
  const card = document.createElement('section');
  card.className = 'interactive-cli-card';
  card.dataset.sessionId = session.id;
  card.innerHTML = `
    <div class="interactive-cli-head">
      <div class="interactive-cli-icon" aria-hidden="true">${_iclIcon('terminal', 'interactive-cli-terminal-icon')}</div>
      <div class="interactive-cli-head-main">
        <div class="interactive-cli-title" data-icl-title></div>
        <div class="interactive-cli-meta">
          <span class="interactive-cli-status" data-icl-status></span>
          <span class="interactive-cli-prompt" data-icl-prompt hidden></span>
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
    <pre class="interactive-cli-output" data-icl-output></pre>
    <div class="interactive-cli-links" data-icl-links hidden></div>
    <form class="interactive-cli-form" data-icl-form>
      <input class="interactive-cli-input" data-icl-input type="text" autocomplete="off" spellcheck="false" placeholder="${_iclEsc(_iclT('interactive_cli.input_placeholder', 'Input for the CLI'))}" />
      <label class="interactive-cli-sensitive">
        <input type="checkbox" data-icl-sensitive />
        <span>${_iclEsc(_iclT('interactive_cli.sensitive', 'Sensitive'))}</span>
      </label>
      <button type="submit" class="btn btn-primary btn-sm interactive-cli-send" data-icl-send>${_iclEsc(_iclT('interactive_cli.send', 'Send'))}</button>
    </form>
  `;
  host.appendChild(card);
  session.card = card;

  const form = card.querySelector('[data-icl-form]');
  const input = card.querySelector('[data-icl-input]');
  const sensitive = card.querySelector('[data-icl-sensitive]');
  const stop = card.querySelector('[data-icl-stop]');
  const close = card.querySelector('[data-icl-close]');

  if (sensitive) {
    sensitive.addEventListener('change', () => _iclSetSensitive(session, sensitive.checked));
  }
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!input || input.disabled) return;
      const value = input.value;
      try {
        await window.orkas.invoke('interactiveCli.send', {
          session_id: session.id,
          input: value,
          add_newline: true,
          sensitive: !!session.sensitive,
        });
        input.value = '';
      } catch (err) {
        _interactiveCliLog.warn('send input failed', { error: err && err.message });
        if (typeof uiToast === 'function') uiToast(_iclT('interactive_cli.send_failed', 'Failed to send input'), { variant: 'error' });
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

function _iclHandleEvent(payload) {
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
    if (session.output.length > 64 * 1024) session.output = session.output.slice(-64 * 1024);
  }
  if (type === 'exited' || type === 'closed' || type === 'error') {
    session.status = type;
  }
  const shouldReveal =
    !!session.card
    || type === 'waiting_input'
    || _iclShouldRevealForOutput(payload, session);
  if (shouldReveal && !session.card) _iclRevealSession(session);
  _iclApplyState(session);
  if (session.status !== 'running') _iclScheduleDismiss(session);
  if (type === 'waiting_input') {
    const input = session.card && session.card.querySelector('[data-icl-input]');
    if (input && !input.disabled) setTimeout(() => input.focus(), 0);
  }
}

if (window.orkas && typeof window.orkas.onPushEvent === 'function') {
  try {
    window.orkas.onPushEvent('interactive-cli:event', _iclHandleEvent);
  } catch (err) {
    _interactiveCliLog.warn('interactive CLI push channel unavailable', { error: err && err.message });
  }
}
