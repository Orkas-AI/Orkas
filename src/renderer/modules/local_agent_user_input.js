// Structured user-input bridge for native local CLI turns.
//
// Codex app-server may pause a running turn and ask up to three questions.
// Main pushes a bounded request here; dialogs are serialized, cancellable,
// and answers return only through IPC (never through the chat transcript).

(function () {
  const queue = [];
  const active = new Map();
  let draining = false;

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
        signal,
      });
      if (selected === null) return null;
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
          await window.orkas.invoke('localAgents.userInputResponse', {
            request_id: requestId,
            answers: {},
            cancelled: true,
          });
          return;
        }
        answers[String(question.id || '')] = value;
      }
      await window.orkas.invoke('localAgents.userInputResponse', {
        request_id: requestId,
        answers,
        cancelled: false,
      });
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
      queue.push(info);
      void drain();
    });
    window.orkas.onPushEvent('local-agent:user-input_cancelled', (payload) => {
      const ids = new Set(Array.isArray(payload && payload.request_ids)
        ? payload.request_ids.filter(id => typeof id === 'string')
        : []);
      for (const id of ids) active.get(id)?.abort();
      for (let index = queue.length - 1; index >= 0; index -= 1) {
        if (ids.has(queue[index] && queue[index].request_id)) queue.splice(index, 1);
      }
    });
  }
})();
