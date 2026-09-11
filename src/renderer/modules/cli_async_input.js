// Native questions appear only in the composer dock.
// Drafts and submissions belong to the original turn; no answer is implicit.
// Two producers share the card: an asynchronous question carried by a message
// (answer steers the live turn) and a blocking request the CLI is waiting on
// (answer resolves that request over its own IPC). Only delivery differs, so
// the blocking caller passes its own controller.
(function () {
  const drafts = new Map();
  const replies = new Map();
  const pendingSaves = new Set();
  const mounts = new Map();
  const activeTurns = new Map();
  const dockEntries = new Map();
  let visibleCid = null;

  function syncDock() {
    const dock = document.getElementById('chat-cli-questions');
    if (!dock) return;
    // `pending` marks a blocking request: the CLI holds its turn open until the
    // answer arrives, so the card stays until it is answered or cancelled.
    const visible = [...dockEntries.values()].filter(entry => entry.cid === visibleCid
      && !entry.saved && !entry.cancelling && (entry.pending || entry.savePending || entry.submitting
        || (!entry.closed && activeTurns.has(entry.cid))));
    const hosts = new Set(visible.map(entry => entry.host));
    for (const child of [...dock.children]) if (!hosts.has(child)) child.remove();
    let added = null;
    for (const entry of visible) if (entry.host.parentElement !== dock) {
      dock.appendChild(entry.host);
      added = entry.host;
    }
    dock.hidden = visible.length === 0;
    // A long task list must not leave a newly arrived question below the fold.
    // Existing forms stay in place so typing and unrelated updates do not jump.
    added?.scrollIntoView?.({ block: 'start' });
  }

  function showQuestion(message, opts) {
    const questions = message.cli_question?.questions;
    if (!Array.isArray(questions) || !questions.length) return;
    const key = keyFor(opts.cid, message.id || message._msg_id);
    let entry = dockEntries.get(key);
    if (!entry) {
      entry = { cid: opts.cid, host: document.createElement('section') };
      dockEntries.set(key, entry);
      entry.host.classList.add('cli-question-panel');
      mount(entry.host, message, { ...opts, persistent: true,
        onAnswer: answer => entry.onAnswer?.(answer),
        onState: state => {
          Object.assign(entry, state);
          syncDock();
        },
      });
    }
    entry.onAnswer = opts.onAnswer;
    syncDock();
  }
  const keyFor = (cid, id) => JSON.stringify([cid, id]);

  function observe(cid, message) {
    const answer = message && message.cli_answer;
    if (!answer || !Array.isArray(answer.answers)) return;
    const key = keyFor(cid, answer.message_id);
    replies.set(key, answer.answers.slice());
    drafts.delete(key);
    pendingSaves.delete(key);
    refresh(key);
  }

  function refresh(key) {
    const list = mounts.get(key);
    if (!list) return;
    for (const mount of list) {
      if (!mount.host.isConnected && !mount.persistent) list.delete(mount);
      else mount.paint();
    }
    if (!list.size) mounts.delete(key);
  }

  function mount(host, message, opts) {
    const questions = message.cli_question && message.cli_question.questions;
    if (!Array.isArray(questions) || !questions.length) return;
    const cid = opts.cid;
    const messageId = message.id || message._msg_id;
    const turnId = message.turn_id || message._turn_id;
    const actor = message.from || message._from;
    const key = keyFor(cid, messageId);
    let submitting = false;
    let error = '';
    let expired = false;
    const state = { host, cid, paint, persistent: opts.persistent === true };
    if (!mounts.has(key)) mounts.set(key, new Set());
    mounts.get(key).add(state);

    function paint() {
      host.replaceChildren();
      host.classList.add('chat-input-form');
      const saved = replies.get(key);
      const savePending = pendingSaves.has(key);
      const answers = saved || drafts.get(key) || questions.map(() => '');
      if (!saved) drafts.set(key, answers);
      const turns = activeTurns.get(cid);
      const closed = expired || (Array.isArray(turns) && !turns.some(turn =>
        turn.actor === actor && turn.turn_id === turnId && turn.steerable === true));
      const title = document.createElement('div');
      title.className = 'form-title';
      title.textContent = t(saved || savePending ? 'chat.cli_question.answered'
        : closed ? 'chat.cli_question.expired' : 'chat.cli_question.title');
      if (opts.actorLabel) title.textContent = `${opts.actorLabel} · ${title.textContent}`;
      host.appendChild(title);
      for (let i = 0; i < questions.length; i += 1) {
        const q = questions[i];
        const row = document.createElement('div');
        row.className = 'form-field';
        const label = document.createElement('label');
        label.className = 'form-field-label';
        label.textContent = q.title;
        row.appendChild(label);
        const choices = document.createElement('div');
        choices.className = 'form-field-checkgroup';
        const input = document.createElement('textarea');
        input.className = 'form-field-input form-field-textarea';
        input.rows = 2;
        input.maxLength = 4000;
        input.value = answers[i] || '';
        input.disabled = !!saved || submitting || savePending;
        input.setAttribute('aria-label', q.title);
        input.placeholder = t('chat.cli_question.placeholder');
        const choose = value => {
          answers[i] = value;
          drafts.set(key, answers);
          input.value = value;
          updateSubmit();
        };
        for (const option of Array.isArray(q.options) ? q.options : []) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'btn';
          button.textContent = option;
          button.disabled = !!saved || submitting || savePending;
          button.addEventListener('click', () => choose(option));
          choices.appendChild(button);
        }
        row.appendChild(choices);
        input.addEventListener('input', () => choose(input.value));
        row.appendChild(input);
        host.appendChild(row);
      }
      const status = document.createElement('div');
      status.className = 'form-error';
      status.textContent = saved || (closed && !savePending) ? ''
        : error || (savePending ? t('chat.cli_question.save_failed') : '');
      host.appendChild(status);
      const submit = document.createElement('button');
      submit.type = 'button';
      submit.className = 'btn btn-primary';
      submit.textContent = t('chat.cli_question.send');
      function updateSubmit() {
        submit.disabled = !!saved || submitting || (closed && !savePending) || answers.some(value => !String(value).trim());
      }
      updateSubmit();
      if (!saved) host.appendChild(submit);
      submit.addEventListener('click', async () => {
        if (submit.disabled || submitting) return;
        submitting = true;
        error = '';
        paint();
        try {
          const result = await window.orkas.invoke('localAgents.asyncInputResponse', {
            cid, message_id: messageId, answers: answers.slice(),
          });
          if (!result || result.ok !== true) {
            expired = result && result.error === 'expired';
            if (result && result.error === 'save_failed') pendingSaves.add(key);
            error = t(expired ? 'chat.cli_question.expired'
              : result && result.error === 'save_failed' ? 'chat.cli_question.save_failed'
              : 'chat.cli_question.send_failed');
          } else {
            observe(cid, result.message);
            if (opts.onAnswer) opts.onAnswer(result.message);
          }
        } catch (_) {
          error = t('chat.cli_question.send_failed');
        } finally {
          submitting = false;
          paint();
        }
      });
      opts.onState?.({ saved, savePending, submitting, closed });
    }
    paint();
  }

  const requestCards = new Set();

  /** One field per question: the label, the options as buttons that fill the
   *  answer box, and the box itself. Same markup as the message-backed card
   *  above, so both surfaces stay one visual contract. */
  function mountRequest(host, spec) {
    const questions = Array.isArray(spec && spec.questions) ? spec.questions : [];
    if (!questions.length) return null;
    const answers = questions.map(() => '');
    const picks = questions.map(() => []);
    const optionButtons = questions.map(() => []);
    let submitting = false;
    let closed = false;

    host.classList.add('chat-input-form');
    host.replaceChildren();
    const title = document.createElement('div');
    title.className = 'form-title';
    host.appendChild(title);

    const inputs = [];
    questions.forEach((question, index) => {
      const row = document.createElement('div');
      row.className = 'form-field';
      const label = document.createElement('label');
      label.className = 'form-field-label';
      label.textContent = question.header
        ? `${question.header} · ${question.question || ''}`
        : String(question.question || '');
      row.appendChild(label);

      const options = Array.isArray(question.options) ? question.options : [];
      const described = options.filter(option => option && option.description);
      if (described.length) {
        // An option's description is the reason to pick it. The dialog used to
        // dump these into its body; keep them beside the options instead. One
        // element per option, because a description long enough to wrap must
        // not read as the beginning of the next option.
        const desc = document.createElement('div');
        desc.className = 'form-field-desc';
        for (const option of described) {
          const line = document.createElement('div');
          line.className = 'form-field-desc-option';
          const name = document.createElement('span');
          name.className = 'form-field-desc-name';
          name.textContent = `${option.label}:`;
          line.appendChild(name);
          const body = document.createElement('span');
          body.textContent = String(option.description);
          line.appendChild(body);
          desc.appendChild(line);
        }
        row.appendChild(desc);
      }

      const input = document.createElement('textarea');
      input.className = 'form-field-input form-field-textarea';
      input.rows = 2;
      input.maxLength = 4000;
      input.setAttribute('aria-label', String(question.question || ''));
      inputs.push(input);

      if (options.length) {
        const group = document.createElement('div');
        group.className = 'form-field-checkgroup';
        options.forEach((option) => {
          const label2 = String(option && option.label || '');
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'btn';
          button.textContent = label2;
          if (option && option.description) button.setAttribute('title', String(option.description));
          button.addEventListener('click', () => {
            if (submitting || closed) return;
            const selected = picks[index];
            if (question.multiSelect === true) {
              const at = selected.indexOf(label2);
              if (at >= 0) selected.splice(at, 1);
              else selected.push(label2);
            } else {
              picks[index] = selected.length === 1 && selected[0] === label2 ? [] : [label2];
            }
            answers[index] = picks[index].join(', ');
            input.value = answers[index];
            paintOptions(index);
            updateSubmit();
          });
          optionButtons[index].push({ button, label: label2 });
          group.appendChild(button);
        });
        row.appendChild(group);
      }

      input.addEventListener('input', () => {
        answers[index] = input.value;
        // Typing owns the answer from here: a stale highlight would claim the
        // CLI received a label the user has edited away.
        if (picks[index].join(', ') !== input.value) picks[index] = [];
        paintOptions(index);
        updateSubmit();
      });
      row.appendChild(input);
      host.appendChild(row);
    });

    const status = document.createElement('div');
    status.className = 'form-error';
    host.appendChild(status);
    const actions = document.createElement('div');
    actions.className = 'cli-question-actions';
    const submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'btn btn-primary';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn';
    actions.appendChild(submit);
    actions.appendChild(cancel);
    host.appendChild(actions);

    function paintOptions(index) {
      for (const entry of optionButtons[index]) {
        const active = picks[index].includes(entry.label);
        // A pick reads as a tint, not a second filled primary: the card spends
        // its one saturated fill on send, and two of them fight for the eye.
        entry.button.className = active ? 'btn is-selected' : 'btn';
        entry.button.setAttribute('aria-pressed', String(active));
        entry.button.disabled = submitting || closed;
      }
    }

    function updateSubmit() {
      submit.disabled = submitting || closed || answers.some(value => !String(value).trim());
      cancel.disabled = submitting || closed;
      for (const input of inputs) input.disabled = submitting || closed;
    }

    function paintText() {
      title.textContent = spec.actorLabel
        ? `${spec.actorLabel} · ${t('chat.cli_question.title')}`
        : t('chat.cli_question.title');
      for (const input of inputs) input.placeholder = t('chat.cli_question.placeholder');
      submit.textContent = t('chat.cli_question.send');
      cancel.textContent = t('common.cancel');
    }

    function settle() {
      if (closed) return;
      closed = true;
      requestCards.delete(paintText);
      updateSubmit();
      spec.onClosed?.();
    }

    submit.addEventListener('click', async () => {
      if (submit.disabled || submitting || closed) return;
      submitting = true;
      status.textContent = '';
      updateSubmit();
      questions.forEach((_, index) => paintOptions(index));
      let delivered = false;
      try {
        delivered = await spec.submit(answers.map(value => String(value).trim()), picks.map(list => list.slice()));
      } catch (_) {
        delivered = false;
      }
      submitting = false;
      if (delivered) {
        settle();
        return;
      }
      status.textContent = t('chat.cli_question.send_failed');
      updateSubmit();
      questions.forEach((_, index) => paintOptions(index));
    });

    cancel.addEventListener('click', async () => {
      if (cancel.disabled || submitting || closed) return;
      submitting = true;
      updateSubmit();
      questions.forEach((_, index) => paintOptions(index));
      spec.onCancelPending?.(true);
      let result = 'unknown';
      for (let attempt = 0; attempt < 2 && !closed; attempt += 1) {
        try { result = await spec.cancel(); } catch (_) { result = 'unknown'; }
        if (result !== 'failed') break;
      }
      submitting = false;
      if (closed) return;
      // Closing the local card does not claim that the CLI accepted the reply.
      // Only an explicit failure allows the user to answer this request again.
      if (result !== 'failed') { settle(); return; }
      updateSubmit();
      questions.forEach((_, index) => paintOptions(index));
      spec.onCancelPending?.(false);
    });

    requestCards.add(paintText);
    paintText();
    questions.forEach((_, index) => paintOptions(index));
    updateSubmit();
    return settle;
  }

  /** Dock a blocking request in its conversation. Returns a closer, or null
   *  when there is no dock to render into (the caller then keeps its dialog). */
  function showCliInputRequest(spec) {
    const cid = String(spec && spec.cid || '');
    const requestId = String(spec && spec.requestId || '');
    if (!cid || !requestId) return null;
    if (!document.getElementById('chat-cli-questions')) return null;
    const id = keyFor(cid, `cli-input:${requestId}`);
    if (dockEntries.has(id)) return null;
    const entry = { cid, host: document.createElement('section'), pending: true };
    entry.host.classList.add('cli-question-panel');
    const settle = mountRequest(entry.host, {
      ...spec,
      onCancelPending: cancelling => {
        entry.cancelling = cancelling;
        syncDock();
      },
      onClosed: () => {
        dockEntries.delete(id);
        entry.host.remove();
        syncDock();
        spec.onClosed?.();
      },
    });
    if (!settle) return null;
    dockEntries.set(id, entry);
    syncDock();
    return settle;
  }

  window.CliAsyncInput = {
    mount, showQuestion, observe, showCliInputRequest,
    showConversation(cid) {
      visibleCid = cid || null;
      syncDock();
    },
    setActiveTurns(cid, turns) {
      if (!Array.isArray(turns)) return;
      const old = activeTurns.get(cid);
      const identity = values => values.map(turn => [turn.actor, turn.turn_id, turn.steerable]);
      if (old && JSON.stringify(identity(old)) === JSON.stringify(identity(turns))) return;
      activeTurns.set(cid, turns);
      for (const [key, list] of mounts) if ([...list].some(item => item.cid === cid)) refresh(key);
    },
    forget(cid) {
      activeTurns.delete(cid);
      for (const [key, entry] of dockEntries) if (entry.cid === cid) dockEntries.delete(key);
      syncDock();
      for (const collection of [drafts, replies, mounts, pendingSaves]) {
        for (const key of collection.keys()) if (JSON.parse(key)[0] === cid) collection.delete(key);
      }
    },
  };
  window.addEventListener('i18n-change', () => {
    for (const key of mounts.keys()) refresh(key);
    for (const paintText of requestCards) paintText();
  });
})();
