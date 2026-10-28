(function () {
  let dialog = null;
  const text = key => t(key);
  const isFailure = value => value?.ok === false && value?.code === 'E_COMMERCIAL_REQUIRED' && value?.feature === 'web_apps';
  function webLanguage() {
    const language = typeof getLang === 'function' ? getLang() : 'en';
    if (language === 'zh' || language === 'zh-tw') return 'zh';
    if (language === 'pt-pt') return 'pt';
    return ['en', 'ja', 'pt'].includes(language) ? language : 'en';
  }
  async function download() {
    const url = new URL('https://orkas.ai/download/');
    url.searchParams.set('lang', webLanguage());
    try {
      const result = await window.orkas.invoke('auth.openExternal', { url: url.href });
      if (!result?.ok) throw new Error('open_failed');
    } catch (_) { await uiAlert(text('apps.commercial_open_failed')); }
  }
  function show() {
    if (dialog) return dialog;
    const focus = document.activeElement;
    dialog = (async () => {
      if (await uiConfirm({ message: text('apps.commercial_required'),
        okLabel: text('apps.commercial_download'), cancelLabel: text('common.cancel') })) await download();
    })().finally(() => {
      dialog = null;
      if (focus?.isConnected) focus.focus({ preventScroll: true });
    });
    return dialog;
  }
  window.OrkasCommercialEntry = { show, download, isFailure };
})();
