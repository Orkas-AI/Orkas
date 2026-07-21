// Shared Library transfer dialog.
//
// One "Move or copy to…" entry point serves single-row and batch operations
// across global/project Libraries. Move/Copy is chosen inside this dialog so
// row menus stay compact. Main owns path validation and copy/move semantics.
(function initLibraryTransfer(root) {
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
    const refreshFolders = async (value) => {
      const ref = _parseLibraryValue(value);
      if (!ref) return;
      currentRef = ref;
      loadingFolders = true;
      confirmBtn.disabled = true;
      folderEl.innerHTML = `<div class="library-transfer-loading">${escapeHtml(t('common.loading'))}</div>`;
      showError('');
      try { renderFolders(await _loadFolderTree(ref)); }
      catch (_) {
        folderEl.innerHTML = '';
        showError(t('contexts.transfer.load_failed'));
      } finally {
        loadingFolders = false;
        confirmBtn.disabled = false;
      }
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
      if (loadingFolders || confirmBtn.disabled) return;
      const startedAt = performance.now();
      confirmBtn.disabled = true;
      showError('');
      _track('library_transfer_submit', {
        mode,
        source_scope: source.scope,
        destination_scope: currentRef.scope,
        entry_count: paths.length,
      }, 'click');
      try {
        const result = await root.orkas.invoke('library.transfer', {
          mode,
          source,
          paths,
          destination: { ...currentRef, dir: targetDir },
        });
        if (!result?.ok) throw new Error(result?.error || 'transfer_failed');
        _track('library_transfer_result', {
          result: Number(result.failed || 0) === 0
            ? 'success'
            : (Number(result.succeeded || 0) > 0 ? 'partial' : 'failure'),
          mode,
          source_scope: source.scope,
          destination_scope: currentRef.scope,
          entry_count: paths.length,
          succeeded_count: Number(result.succeeded || 0),
          failed_count: Number(result.failed || 0),
          duration_ms: Math.round(performance.now() - startedAt),
        });
        if (Number(result.succeeded || 0) === 0) {
          const firstError = result.results?.find((row) => !row.ok)?.error;
          showError(_errorLabel(firstError));
          confirmBtn.disabled = false;
          return;
        }
        close();
        if (typeof opts?.onComplete === 'function') {
          await opts.onComplete({ ...result, mode, source, destination: { ...currentRef, dir: targetDir } });
        }
        const key = result.failed
          ? 'contexts.transfer.partial_result'
          : (mode === 'copy' ? 'contexts.transfer.copy_success' : 'contexts.transfer.move_success');
        if (typeof uiToast === 'function') {
          uiToast(t(key, {
            count: Number(result.succeeded || 0),
            failed: Number(result.failed || 0),
          }), { variant: result.failed ? 'warning' : 'success', timeoutMs: result.failed ? 6000 : 3200 });
        }
      } catch (err) {
        _track('library_transfer', {
          mode,
          source_scope: source.scope,
          destination_scope: currentRef.scope,
          error_type: 'exception',
          error_message: String(err?.message || 'transfer_failed').slice(0, 120),
        }, 'error');
        showError(t('contexts.transfer.error_generic'));
        confirmBtn.disabled = false;
      }
    });

    _track('library_transfer_open', {
      source_scope: source.scope,
      entry_count: paths.length,
      entry_point: opts?.entryPoint || 'menu',
    }, 'click');
    await refreshFolders(initialLibrary);
    return { close };
  }

  const api = Object.freeze({ open: openLibraryTransfer });
  root.LibraryTransfer = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { _libraryValue, _parseLibraryValue, _folderRows, _projectsFromResponse };
  }
})(typeof window !== 'undefined' ? window : globalThis);
