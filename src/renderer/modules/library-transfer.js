// Shared Library transfer dialog.
//
// One "Move or copy to…" entry point serves single-row and batch operations
// across global/project Libraries. Move/Copy is chosen inside this dialog so
// row menus stay compact. Main owns path validation and copy/move semantics.
(function initLibraryTransfer(root) {
  const transferLog = (typeof createLogger === 'function')
    ? createLogger('library-transfer')
    : { warn() {} };

  function _libraryValue(ref) {
    return ref && ref.scope === 'project' ? `project:${ref.projectId || ''}` : 'global';
  }

  function _parseLibraryValue(value) {
    const raw = String(value || '');
    if (raw === 'global') return { scope: 'global' };
    if (raw.startsWith('project:') && raw.slice(8)) {
      return { scope: 'project', projectId: raw.slice(8) };
    }
    return null;
  }

  function _folderRows(nodes, depth = 0, out = []) {
    for (const node of nodes || []) {
      if (!node || node.type !== 'dir') continue;
      const rel = String(node.relPath || node.path || '');
      if (!rel) continue;
      out.push({ path: rel, name: String(node.name || rel.split('/').pop() || rel), depth });
      _folderRows(node.children || [], depth + 1, out);
    }
    return out;
  }

  function _projectsFromResponse(response) {
    return Array.isArray(response?.projects) ? response.projects : [];
  }

  function _canSubmitTransfer(state) {
    return state?.loading === false && state?.destinationReady === true;
  }

  function _transferFailureTelemetry(error) {
    const raw = typeof error === 'string'
      ? error.trim()
      : String((error && (error.error_code || error.code || error.error || error.message)) || '').trim();
    const known = new Set([
      'account_changed',
      'invalid_batch',
      'invalid_mode',
      'invalid_path',
      'invalid_project',
      'invalid_request',
      'invalid_scope',
      'invalid_target',
      'not_found',
      'rollback_failed',
      'source_delete_failed',
      'target_exists',
      'transfer_failed',
      'unsupported_destination',
    ]);
    const errorCode = known.has(raw)
      ? raw
      : (/^E_[A-Z0-9_]{1,64}$/.test(raw) && raw !== 'E_UNKNOWN' ? raw : 'transfer_failed');
    const errorType = /invalid|unsupported/.test(errorCode)
      ? 'validation'
      : (/target_exists|account_changed/.test(errorCode) ? 'conflict' : 'operation');
    return { error_code: errorCode, error_type: errorType };
  }

  function _createLatestFolderLoader(loadTree, handlers) {
    let latestRequest = 0;
    return async (ref) => {
      const request = ++latestRequest;
      handlers.onStart(ref);
      try {
        const tree = await loadTree(ref);
        if (request !== latestRequest) return false;
        handlers.onReady(tree, ref);
        return true;
      } catch (error) {
        if (request !== latestRequest) return false;
        handlers.onError(error, ref);
        return false;
      } finally {
        if (request === latestRequest) handlers.onFinish(ref);
      }
    };
  }

  function _icon(name, cls) {
    return root && typeof root.uiIconHtml === 'function' ? root.uiIconHtml(name, cls) : '';
  }

  function _errorLabel(code) {
    const key = {
      target_exists: 'contexts.transfer.error_target_exists',
      unsupported_destination: 'contexts.transfer.error_unsupported',
      invalid_target: 'contexts.transfer.error_invalid_target',
      not_found: 'contexts.transfer.error_not_found',
      source_delete_failed: 'contexts.transfer.error_source_delete',
      rollback_failed: 'contexts.transfer.error_rollback',
      account_changed: 'contexts.transfer.error_account_changed',
    }[String(code || '')] || 'contexts.transfer.error_generic';
    return t(key);
  }

  async function _loadProjects() {
    const res = await root.orkas.invoke('projects.list', {});
    return _projectsFromResponse(res);
  }

  async function _loadFolderTree(ref) {
    if (ref.scope === 'global') {
      const res = await apiFetch('/api/contexts/tree');
      const data = await res.json();
      if (!data?.ok) throw new Error(data?.error || 'load_failed');
      return data.tree || [];
    }
    const data = await root.orkas.invoke('projects.files.tree', { projectId: ref.projectId });
    if (!Array.isArray(data?.tree)) throw new Error(data?.error || 'load_failed');
    return data.tree;
  }

  function _track(name, payload, kind = 'event') {
    void name;
    void payload;
    void kind;
  }

  async function openLibraryTransfer(opts) {
    const source = opts?.source;
    const paths = Array.from(new Set((opts?.paths || []).map((item) => String(item || '')).filter(Boolean)));
    if (!source || !paths.length) return null;
    document.getElementById('library-transfer-overlay')?.remove();

    let projects;
    try { projects = await _loadProjects(); }
    catch (_) { projects = []; }
    const libraryOptions = [
      { value: 'global', label: t('contexts.transfer.global_library'), iconName: 'folder' },
      ...projects.map((project) => ({
        value: `project:${project.project_id}`,
        label: project.name || project.project_id,
        hint: t('contexts.transfer.project_library'),
        iconName: 'folder',
      })),
    ];
    const initialLibrary = _libraryValue(source);
    const overlay = document.createElement('div');
    overlay.id = 'library-transfer-overlay';
    overlay.className = 'modal-overlay library-transfer-overlay open';
    overlay.setAttribute('aria-hidden', 'false');
    overlay.innerHTML = `
      <div class="modal modal-standard library-transfer-dialog" role="dialog" aria-modal="true" aria-labelledby="library-transfer-title">
        <div class="modal-header library-transfer-header">
          <div>
            <div class="modal-title library-transfer-title" id="library-transfer-title">${escapeHtml(t('contexts.transfer.title'))}</div>
            <div class="library-transfer-summary">${escapeHtml(t('contexts.transfer.selected_count', { count: paths.length }))}</div>
          </div>
          <button type="button" class="modal-close-btn project-library-modal-close" data-transfer-close title="${escapeHtml(t('common.close'))}" aria-label="${escapeHtml(t('common.close'))}">
            ${_icon('x', 'modal-close-icon')}
          </button>
        </div>
        <div class="modal-body library-transfer-body">
          <div class="library-transfer-label" id="library-transfer-mode-label">${escapeHtml(t('contexts.transfer.action'))}</div>
          <div class="library-transfer-mode" role="radiogroup" aria-labelledby="library-transfer-mode-label">
            <label class="library-transfer-mode-option">
              <input class="library-transfer-mode-input" type="radio" name="library-transfer-mode" value="move" data-transfer-mode="move" checked>
              <span>${escapeHtml(t('contexts.transfer.move'))}</span>
            </label>
            <label class="library-transfer-mode-option">
              <input class="library-transfer-mode-input" type="radio" name="library-transfer-mode" value="copy" data-transfer-mode="copy">
              <span>${escapeHtml(t('contexts.transfer.copy'))}</span>
            </label>
          </div>
          <label class="library-transfer-label">${escapeHtml(t('contexts.transfer.destination_library'))}</label>
          <div class="ai-select library-transfer-library-select" data-transfer-library></div>
          <label class="library-transfer-label">${escapeHtml(t('contexts.transfer.destination_folder'))}</label>
          <div class="library-transfer-folders" data-transfer-folders></div>
          <div class="library-transfer-error" data-transfer-error hidden></div>
        </div>
        <div class="modal-actions library-transfer-footer">
          <button type="button" class="btn" data-transfer-cancel>${escapeHtml(t('common.cancel'))}</button>
          <button type="button" class="btn btn-primary" data-transfer-confirm>${escapeHtml(t('contexts.transfer.move'))}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    let mode = 'move';
    let targetDir = '';
    let currentRef = _parseLibraryValue(initialLibrary) || { scope: 'global' };
    let loadingFolders = false;
    let destinationReady = false;
    const folderEl = overlay.querySelector('[data-transfer-folders]');
    const errorEl = overlay.querySelector('[data-transfer-error]');
    const confirmBtn = overlay.querySelector('[data-transfer-confirm]');

    const close = () => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
    };
    const showError = (message) => {
      errorEl.textContent = message || '';
      errorEl.hidden = !message;
    };
    const renderFolders = (tree) => {
      const rows = _folderRows(tree);
      folderEl.innerHTML = `
        <button type="button" class="library-transfer-folder active" data-folder-path="" style="padding-left:10px">
          ${_icon('folder-open', 'library-transfer-folder-icon')}
          <span>${escapeHtml(t('contexts.root_label'))}</span>
        </button>
        ${rows.map((row) => `
          <button type="button" class="library-transfer-folder" data-folder-path="${escapeHtml(row.path)}" style="padding-left:${32 + row.depth * 18}px">
            ${_icon('folder', 'library-transfer-folder-icon')}
            <span>${escapeHtml(row.name)}</span>
          </button>
        `).join('')}
      `;
      targetDir = '';
      folderEl.querySelectorAll('[data-folder-path]').forEach((row) => {
        row.addEventListener('click', () => {
          targetDir = row.dataset.folderPath || '';
          folderEl.querySelectorAll('.active').forEach((node) => node.classList.remove('active'));
          row.classList.add('active');
          showError('');
        });
      });
    };
    const loadFolders = _createLatestFolderLoader(_loadFolderTree, {
      onStart: (ref) => {
        currentRef = ref;
        loadingFolders = true;
        destinationReady = false;
        confirmBtn.disabled = true;
        folderEl.innerHTML = `<div class="library-transfer-loading">${escapeHtml(t('common.loading'))}</div>`;
        showError('');
      },
      onReady: (tree) => {
        renderFolders(tree);
        destinationReady = true;
      },
      onError: () => {
        folderEl.innerHTML = '';
        showError(t('contexts.transfer.load_failed'));
      },
      onFinish: () => {
        loadingFolders = false;
        confirmBtn.disabled = !_canSubmitTransfer({ loading: loadingFolders, destinationReady });
      },
    });
    const refreshFolders = (value) => {
      const ref = _parseLibraryValue(value);
      if (!ref) return Promise.resolve(false);
      return loadFolders(ref);
    };

    const selector = _aiSelectMount(overlay.querySelector('[data-transfer-library]'), {
      options: libraryOptions,
      value: initialLibrary,
      onChange: (value) => refreshFolders(value),
    });
    selector?.setValue(initialLibrary);
    overlay.querySelectorAll('[data-transfer-mode]').forEach((input) => {
      input.addEventListener('change', () => {
        if (!input.checked) return;
        mode = input.dataset.transferMode === 'copy' ? 'copy' : 'move';
        confirmBtn.textContent = t(mode === 'copy' ? 'contexts.transfer.copy' : 'contexts.transfer.move');
        showError('');
      });
    });
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close();
    };
    document.addEventListener('keydown', onKey, true);
    overlay.querySelector('[data-transfer-close]')?.addEventListener('click', close);
    overlay.querySelector('[data-transfer-cancel]')?.addEventListener('click', close);
    confirmBtn.addEventListener('click', async () => {
      if (!_canSubmitTransfer({ loading: loadingFolders, destinationReady }) || confirmBtn.disabled) return;
      const startedAt = performance.now();
      confirmBtn.disabled = true;
      showError('');
      _track('library_transfer_submit', {
        mode,
        source_scope: source.scope,
        destination_scope: currentRef.scope,
        entry_count: paths.length,
      }, 'click');
      let result;
      try {
        result = await root.orkas.invoke('library.transfer', {
          mode,
          source,
          paths,
          destination: { ...currentRef, dir: targetDir },
        });
      } catch (err) {
        const failure = _transferFailureTelemetry(err);
        _track('library_transfer_result', {
          result: 'failure',
          mode,
          source_scope: source.scope,
          destination_scope: currentRef.scope,
          entry_count: paths.length,
          succeeded_count: 0,
          failed_count: paths.length,
          duration_ms: Math.round(performance.now() - startedAt),
          ...failure,
        });
        transferLog.warn('library transfer failed', { mode, source_scope: source.scope, destination_scope: currentRef.scope, ...failure });
        showError(t('contexts.transfer.error_generic'));
        confirmBtn.disabled = false;
        return;
      }
      if (!result?.ok) {
        const failure = _transferFailureTelemetry(result);
        _track('library_transfer_result', {
          result: 'failure',
          mode,
          source_scope: source.scope,
          destination_scope: currentRef.scope,
          entry_count: paths.length,
          succeeded_count: 0,
          failed_count: paths.length,
          duration_ms: Math.round(performance.now() - startedAt),
          ...failure,
        });
        transferLog.warn('library transfer failed', { mode, source_scope: source.scope, destination_scope: currentRef.scope, ...failure });
        showError(_errorLabel(failure.error_code));
        confirmBtn.disabled = false;
        return;
      }
      const succeededCount = Number(result.succeeded || 0);
      const failedCount = Number(result.failed || 0);
      const resultValue = failedCount === 0
        ? 'success'
        : (succeededCount > 0 ? 'partial' : 'failure');
      const firstError = result.results?.find((row) => !row.ok)?.error;
      const failure = resultValue === 'success' ? {} : _transferFailureTelemetry(firstError || 'transfer_failed');
      _track('library_transfer_result', {
        result: resultValue,
        mode,
        source_scope: source.scope,
        destination_scope: currentRef.scope,
        entry_count: paths.length,
        succeeded_count: succeededCount,
        failed_count: failedCount,
        duration_ms: Math.round(performance.now() - startedAt),
        ...failure,
      });
      if (succeededCount === 0) {
        transferLog.warn('library transfer failed', { mode, source_scope: source.scope, destination_scope: currentRef.scope, ...failure });
        showError(_errorLabel(firstError));
        confirmBtn.disabled = false;
        return;
      }
      close();
      if (typeof opts?.onComplete === 'function') {
        try {
          await opts.onComplete({ ...result, mode, source, destination: { ...currentRef, dir: targetDir } });
        } catch (err) {
          transferLog.warn('refresh after library transfer failed', err);
        }
      }
      const key = result.failed
        ? 'contexts.transfer.partial_result'
        : (mode === 'copy' ? 'contexts.transfer.copy_success' : 'contexts.transfer.move_success');
      if (typeof uiToast === 'function') {
        uiToast(t(key, {
          count: succeededCount,
          failed: failedCount,
        }), { variant: result.failed ? 'warning' : 'success', timeoutMs: result.failed ? 6000 : 3200 });
      }
    });

    await refreshFolders(initialLibrary);
    return { close };
  }

  const api = Object.freeze({ open: openLibraryTransfer });
  root.LibraryTransfer = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      _libraryValue,
      _parseLibraryValue,
      _folderRows,
      _projectsFromResponse,
      _canSubmitTransfer,
      _transferFailureTelemetry,
      _createLatestFolderLoader,
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
