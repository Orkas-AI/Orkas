// All authoring surfaces share the same explicit export/clear recovery flow.
(function () {
  'use strict';
  async function save(channel, payload, label) {
    const args = { ...payload };
    let result;
    try { result = await window.orkas.invoke(channel, args); }
    catch (error) {
      if (error?.code !== 'app_edit_data_migration') throw error;
      result = { ok: false, code: error.code };
    }
    if ((result?.code || result?.error) !== 'app_edit_data_migration' || args.mode === 'new') return result;
    const artifact = channel === 'conversations.artifacts.save';
    const impact = await window.orkas.invoke(artifact
      ? 'conversations.artifacts.dataImpact' : 'savedApps.dataImpactFromPath', args);
    if (!impact?.ok) return impact;
    const scope = impact.tables.map(table => `${table.name}: ${table.count} (${table.fields.join(', ')})`).join('\n');
    const exportFirst = await uiConfirm({
      message: label('apps.migration_export') + '\n' + scope,
      okLabel: label('apps.migration_export_action'),
      cancelLabel: label('apps.migration_continue'),
    });
    if (exportFirst) {
      const exported = await window.orkas.invoke(artifact
        ? 'conversations.artifacts.exportData' : 'savedApps.exportDataFromPath', { ...args, appId: impact.appId });
      if (!exported?.ok || exported.canceled) return exported;
    }
    const confirmed = await uiConfirmDanger({
      message: label('apps.migration_clear') + '\n' + scope,
      dangerLabel: label('apps.migration_retry'),
    });
    if (!confirmed) return { ok: true, canceled: true };
    return window.orkas.invoke(channel, {
      ...args, mode: 'update',
      recovery: { appId: impact.appId, clearVersion: impact.version, clearFingerprint: impact.fingerprint },
    });
  }
  window.OrkasAppSave = { save };
})();
