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

  it('blocks exact account-wide actions without confusing CRM business records', () => {
    expect(isConnectorActionBlocked('github', 'delete_organization')).toBe(true);
    expect(isConnectorActionBlocked('gmail', 'GMAIL_BATCH_DELETE_MESSAGES')).toBe(true);
    expect(isConnectorActionBlocked('salesforce', 'SALESFORCE_DELETE_ACCOUNT')).toBe(false);
    expect(isConnectorActionBlocked('gmail', 'GMAIL_SEND_EMAIL')).toBe(false);
    expect(isConnectorActionBlocked('constructor', 'GMAIL_SEND_EMAIL')).toBe(false);
  });
});
