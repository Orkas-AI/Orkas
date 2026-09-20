// Shared sensitive-action copy for the main window and application hosts.
function _connectorActionMessage(info) {
  const catalogEntry = typeof _catalogEntryById === 'function' ? _catalogEntryById(info.connector_id) : null;
  const displayName = catalogEntry ? _connectorDisplayName(catalogEntry) : (info.display_name || info.connector_id);
  return [
    `${t('connectors.action_confirm.connector')}: ${displayName}`,
    `${t('connectors.action_confirm.action')}: ${info.action_name || info.tool_name}`,
  ].join('\n');
}

function _connectorActionDetails(info) {
  return String(info.arguments_preview || '{}');
}
