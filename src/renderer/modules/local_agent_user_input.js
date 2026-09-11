// Structured user-input bridge for native local CLI turns.
//
// Codex and Claude Code can pause a running turn for structured questions.
// Main pushes a bounded request here; dialogs are serialized, cancellable,
// and answers return only through IPC (never through the chat transcript).

(function () {
  const queue = [];
  const active = new Map();
  const cards = new Map();
  // Main assigns each request a fresh id. Retain only ids for this renderer's
  // lifetime so replay cannot reopen answered or withdrawn questions.
  const seenRequests = new Set();
  let draining = false;

  function respond(requestId, answers, cancelled) {
    return window.orkas.invoke('localAgents.userInputResponse', {
      request_id: requestId,
      answers,
      cancelled,
    });
  }

  /** A question that belongs to a conversation renders in that conversation's
   *  composer dock — the same card a native asynchronous question uses. Secret
   *  input needs masking the card has no control for, and a request without a
   *  conversation or dock has nowhere to land, so both keep the dialog. */
  function cardEligible(info) {
    return typeof info.cid === 'string' && info.cid
      && !!(window.CliAsyncInput && typeof window.CliAsyncInput.showCliInputRequest === 'function')
      && Array.isArray(info.questions) && info.questions.length
      && info.questions.every(question => question && question.isSecret !== true);
  }

  function showCard(info) {
    const requestId = String(info.request_id || '');
    const questions = info.questions;
    const close = window.CliAsyncInput.showCliInputRequest({
      requestId,
      cid: String(info.cid || ''),
      actorLabel: String(info.agent_name || ''),
      questions,
      submit: async (values, picks) => {
        const answers = {};
        questions.forEach((question, index) => {
          const text = String(values[index] || '').trim();
          const picked = Array.isArray(picks[index]) ? picks[index] : [];
          // Keep the picked labels whole when the box still holds exactly them:
          // a multi-select answer stays several values instead of one string.
          answers[String(question.id || '')] = picked.length && picked.join(', ') === text
            ? picked.slice()
            : [text];
        });
        try {
          await respond(requestId, answers, false);
          return true;
        } catch (_) {
          return false;
        }
      },
      cancel: async () => {
        const result = await respond(requestId, {}, true);
        if (result?.cancelled === true || result?.closed === true) return 'closed';
        return result?.cancel_failed === true ? 'failed' : 'unknown';
      },
      onClosed: () => { cards.delete(requestId); },
    });
    if (!close) return false;
    cards.set(requestId, close);
    return true;
  }

  function questionMessage(question) {
    const lines = [];
    if (question.header) lines.push(String(question.header));
    lines.push(String(question.question || ''));
    for (const option of Array.isArray(question.options) ? question.options : []) {
      if (option && option.description) lines.push(`${option.label}: ${option.description}`);
    }
    return lines.filter(Boolean).join('\n');
  }

  async function askQuestion(question, signal) {
    const options = Array.isArray(question.options) ? question.options : [];
    if (options.length) {
      const choices = options.map((option, index) => ({
        id: `option-${index}`,
        label: String(option.label || ''),
      }));
      if (question.isOther === true) {
        choices.push({ id: 'other', label: t('agents.cli_user_input_other') });
      }
      const selected = await uiChoice({
        title: t('agents.cli_user_input_title'),
        message: questionMessage(question),
        choices,
        // A CLI question carries prose options (up to 12 of them, 160 chars
        // each). Render them like the native-question card in the composer
        // dock: a wrapping group above the action row, each option as wide as
        // its own label.
        choiceLayout: 'group',
        signal,
        ...(question.multiSelect === true ? { multiple: true } : {}),
      });
      if (selected === null) return null;
      if (Array.isArray(selected)) {
        const answers = selected.filter(id => id !== 'other').map(id => {
          const index = Number(String(id).replace('option-', ''));
          return Number.isInteger(index) && options[index] ? String(options[index].label || '') : '';
        }).filter(Boolean);
        if (selected.includes('other')) {
          const other = await uiPrompt(question.question || '', '', { signal });
          if (other === null) return null;
          if (String(other).trim()) answers.push(String(other));
        }
        return answers;
      }
      if (selected === 'other') {
        const other = await uiPrompt(question.question || '', '', { signal });
        return other === null ? null : [String(other)];
      }
      const index = Number(String(selected).replace('option-', ''));
      return Number.isInteger(index) && options[index]
        ? [String(options[index].label || '')]
        : [];
    }
    const value = await uiPrompt(questionMessage(question), '', {
      signal,
      secret: question.isSecret === true,
    });
    return value === null ? null : [String(value)];
  }

  async function showRequest(info) {
    const requestId = String(info && info.request_id || '');
    if (!requestId) return;
    const controller = new AbortController();
    active.set(requestId, controller);
    try {
      const answers = {};
      for (const question of Array.isArray(info.questions) ? info.questions : []) {
        const value = await askQuestion(question, controller.signal);
        if (controller.signal.aborted) return;
        if (value === null) {
          await respond(requestId, {}, true);
          return;
        }
        answers[String(question.id || '')] = value;
      }
      await respond(requestId, answers, false);
    } catch (error) {
      try {
        createLogger('local-agent-user-input').warn('structured CLI input response failed', {
          error_type: error && error.name ? error.name : 'unknown',
        });
      } catch (_) { /* diagnostics must not break the queue */ }
    } finally {
      active.delete(requestId);
    }
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length) await showRequest(queue.shift());
    } finally {
      draining = false;
    }
  }

  if (window.orkas && typeof window.orkas.onPushEvent === 'function') {
    window.orkas.onPushEvent('local-agent:user-input', (info) => {
      if (!info || typeof info.request_id !== 'string') return;
      if (seenRequests.has(info.request_id)) return;
      seenRequests.add(info.request_id);
      if (cardEligible(info) && showCard(info)) return;
      queue.push(info);
      void drain();
    });
    window.orkas.onPushEvent('local-agent:user-input_cancelled', (payload) => {
      const ids = new Set(Array.isArray(payload && payload.request_ids)
        ? payload.request_ids.filter(id => typeof id === 'string')
        : []);
      for (const id of ids) {
        seenRequests.add(id);
        active.get(id)?.abort();
        cards.get(id)?.();
        cards.delete(id);
      }
      for (let index = queue.length - 1; index >= 0; index -= 1) {
        if (ids.has(queue[index] && queue[index].request_id)) queue.splice(index, 1);
      }
    });
  }
})();
