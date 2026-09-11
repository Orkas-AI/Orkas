// Native questions appear only in the composer dock.
// Drafts and submissions belong to the original turn; no answer is implicit.
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
    const visible = [...dockEntries.values()].filter(entry => entry.cid === visibleCid
      && !entry.saved && (entry.savePending || entry.submitting || (!entry.closed && activeTurns.has(entry.cid))));
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

  window.CliAsyncInput = {
    mount, showQuestion, observe,
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
  });
})();
