import { describe, expect, it } from 'vitest';
import { connectorActionRisk, isConnectorActionBlocked } from '../../../../src/main/features/connectors/action_policy';
import type { ConnectorInstance, ToolSchema } from '../../../../src/main/features/connectors/types';

function risk(id: string, name: string, extra: Partial<ToolSchema> = {}, custom = false) {
  return connectorActionRisk({ id, origin: custom ? 'custom' : 'catalog' } as ConnectorInstance,
    { name, description: 'This description cannot grant permission.', input_schema: {}, ...extra });
}

describe('connector operation classification', () => {
  it.each([
    ['gmail', 'GMAIL_FETCH_EMAILS', 'R'], ['gmail', 'GMAIL_CREATE_EMAIL_DRAFT', 'W'],
    ['gmail', 'GMAIL_SEND_EMAIL', 'H'], ['gmail', 'GMAIL_FORWARD_MESSAGE', 'H'],
    ['gdrive', 'GOOGLEDRIVE_DOWNLOAD_FILE', 'R'], ['gdrive', 'GOOGLEDRIVE_TRASH_FILE', 'D'],
    ['gsheets', 'GOOGLESHEETS_VALUES_UPDATE', 'W'], ['gsheets', 'GOOGLESHEETS_CLEAR_VALUES', 'D'],
    ['gcal', 'GOOGLECALENDAR_EVENTS_LIST', 'R'], ['gcal', 'GOOGLECALENDAR_CREATE_EVENT', 'H'],
    ['m365-mail', 'OUTLOOK_CREATE_DRAFT', 'W'], ['m365-mail', 'OUTLOOK_SEND_EMAIL', 'H'],
    ['onedrive', 'ONE_DRIVE_DOWNLOAD_FILE_BY_PATH', 'R'],
    ['google-workspace', 'read_sheet', 'R'], ['google-workspace', 'delete_tasklist', 'D'],
  ])('classifies %s / %s by the reviewed action', (id, name, expected) => {
    expect(risk(id, name).risk).toBe(expected);
  });

  it('keeps product policy authoritative over provider hints and unknown look-alikes', () => {
    expect(risk('gmail', 'GMAIL_SEND_EMAIL', { annotations: { readOnlyHint: true } }).risk).toBe('H');
    expect(risk('gmail', 'GMAIL_FETCH_EMAILS_AND_SEND').risk).toBe('H');
    expect(risk('gmail', 'constructor').risk).toBe('H');
    expect(risk('custom-test', 'GMAIL_FETCH_EMAILS', {
      annotations: { readOnlyHint: true },
      orkas_action_policy: { risk: 'R', confirmation: 'none', max_batch_size: 25 },
    }, true).risk).toBe('H');
    expect(risk('github', 'search_repositories', { annotations: { readOnlyHint: true } }).risk).toBe('R');
    expect(risk('github', 'unknown', { annotations: { readOnlyHint: true, destructiveHint: true } }).risk).toBe('D');
  });

  it('keeps reviewed commerce reads, drafts, and refunds stable when provider metadata disagrees', () => {
    const claimsReadOnly: Partial<ToolSchema> = {
      annotations: { readOnlyHint: true },
      orkas_action_policy: { risk: 'R', confirmation: 'none', max_batch_size: 25 },
    };
    expect(risk('paypal', 'create_refund', claimsReadOnly)).toMatchObject({
      risk: 'H', sensitive_operation: 'money',
    });
    expect(risk('paypal', 'create_invoice', claimsReadOnly).risk).toBe('W');
    expect(risk('paypal', 'list_invoices', {
      annotations: { destructiveHint: true },
      orkas_action_policy: { risk: 'D', confirmation: 'destructive', max_batch_size: 25 },
    }).risk).toBe('R');
  });

  it.each([
    ['box', 'BOX_UPDATE_FOLDER', { shared_link: { access: 'open' } }],
    ['box', 'BOX_UPDATE_FOLDER', { shared_link: null }],
    ['box', 'BOX_UPDATE_FOLDER', { can_non_owners_invite: false }],
    ['box', 'BOX_UPDATE_FOLDER', { can_non_owners_view_collaborators: true }],
    ['box', 'BOX_UPDATE_FOLDER', { is_collaboration_restricted_to_enterprise: false }],
    ['box', 'BOX_UPDATE_FOLDER', { folder_upload_email: { access: 'open' } }],
    ['box', 'BOX_UPDATE_FILE', { permissions__can__download: 'open' }],
    ['box', 'BOX_UPDATE_FILE', { disposition_at: '2030-01-01T00:00:00Z' }],
    ['miro', 'MIRO_UPDATE_BOARD', { policy: { sharingPolicy: { access: 'edit' } } }],
    ['wrike', 'WRIKE_MODIFY_FOLDER', { addShareds: ['user-1'] }],
    ['wrike', 'WRIKE_MODIFY_FOLDER', { removeShareds: ['user-1'] }],
    ['wrike', 'WRIKE_MODIFY_FOLDER', { addAccessRoles: { 'user-1': 'Full' } }],
    ['wrike', 'WRIKE_MODIFY_FOLDER', { removeAccessRoles: ['user-1'] }],
    ['youtube', 'YOUTUBE_UPDATE_PLAYLIST', { status: { privacyStatus: 'public' } }],
  ] as const)('requires sensitive treatment for structured access changes: %s / %s / %j', (id, name, args) => {
    const instance = { id, origin: 'catalog', composio_grant: {
      connection_id: 'connection', toolkit: id, auth_config_id: 'config',
    } } as ConnectorInstance;
    const tool: ToolSchema = { name, description: 'Update metadata', input_schema: {},
      orkas_action_policy: { risk: 'W', confirmation: 'none', max_batch_size: 25 } };
    expect(connectorActionRisk(instance, tool, args).risk).toBe('H');
    expect(connectorActionRisk(instance, tool, { name: 'Renamed', title: 'Renamed' }).risk).toBe('W');
    expect(connectorActionRisk(instance, tool, { description: JSON.stringify(args) }).risk).toBe('W');
    expect(connectorActionRisk(instance, { ...tool, orkas_action_policy: {
      risk: 'D', confirmation: 'destructive', max_batch_size: 25,
    } }, args).risk).toBe('D');
  });

  it.each(['FATHOM_GET_RECORDING_SUMMARY', 'FATHOM_GET_RECORDING_TRANSCRIPT'])(
    'requires confirmation when %s delivers meeting content to an external URL', (name) => {
      const instance = { id: 'fathom', origin: 'catalog', composio_grant: {
        connection_id: 'connection', toolkit: 'fathom', auth_config_id: 'config',
      } } as ConnectorInstance;
      const tool: ToolSchema = { name, description: 'Get meeting content', input_schema: {},
        orkas_action_policy: { risk: 'R', confirmation: 'none', max_batch_size: 25 } };
      const args = { recording_id: 42, destination_url: 'https://example.com/meeting' };
      expect(connectorActionRisk(instance, tool, args)).toEqual({
        risk: 'H', sensitive_operation: 'external_communication',
      });
      expect(connectorActionRisk(instance, tool, { recording_id: 42 }).risk).toBe('R');
      expect(connectorActionRisk(instance, tool, { recording_id: 42, destination_url: undefined }).risk).toBe('R');
      expect(connectorActionRisk(instance, tool, { description: JSON.stringify(args) }).risk).toBe('R');
      expect(connectorActionRisk({ ...instance, origin: 'custom' }, tool, args)).toEqual({
        risk: 'H', sensitive_operation: 'unclassified',
      });
    },
  );

  it('blocks exact account-wide actions without confusing CRM business records', () => {
    expect(isConnectorActionBlocked('github', 'delete_organization')).toBe(true);
    expect(isConnectorActionBlocked('gmail', 'GMAIL_BATCH_DELETE_MESSAGES')).toBe(true);
    expect(isConnectorActionBlocked('salesforce', 'SALESFORCE_DELETE_ACCOUNT')).toBe(false);
    expect(isConnectorActionBlocked('gmail', 'GMAIL_SEND_EMAIL')).toBe(false);
    expect(isConnectorActionBlocked('constructor', 'GMAIL_SEND_EMAIL')).toBe(false);
  });
});
