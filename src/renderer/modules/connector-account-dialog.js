// Host-owned authorization choices contain names and IDs only, never credentials.
(function () {
  const active = new Map();
  const log = createLogger('connector-account-dialog');
  window.addEventListener('DOMContentLoaded', () => {
    if (!window.orkas || !window.orkas.onPushEvent) return;
    window.orkas.onPushEvent('connectors:account-choice-cancelled', (info) => {
      const controller = active.get(info && info.request_id);
      if (controller) controller.abort();
    });
    window.orkas.onPushEvent('connectors:account-choice', async (info) => {
      if (!info || typeof info.request_id !== 'string' || active.has(info.request_id)) return;
      const controller = new AbortController();
      active.set(info.request_id, controller);
      let choice = null;
      try {
        choice = await uiChoice({ title: info.title, message: info.message,
          choices: info.choices, choiceLayout: 'group', signal: controller.signal });
      } catch {
        log.warn('Account selection dialog failed');
      } finally {
        active.delete(info.request_id);
      }
      if (controller.signal.aborted) return;
      try {
        await window.orkas.invoke('connectors.account_choice_response', {
          request_id: info.request_id, choice_id: choice,
        });
      } catch {
        log.warn('Account selection response failed');
      }
    });
  });
})();
