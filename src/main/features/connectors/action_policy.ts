/** Host-owned action classifications. Exact provider identities keep ordinary
 * reads and reversible edits out of approval without interpreting tool prose.
 * Unknown/custom actions remain sensitive; custom hints cannot widen trust.
 */
import { findCatalogEntry } from './catalog';
import type { ConnectorInstance, ToolSchema } from './types';

export interface ConnectorActionRisk {
  risk: 'R' | 'W' | 'H' | 'D';
  sensitive_operation?: string;
}

const READ: ConnectorActionRisk = { risk: 'R' };
const WRITE: ConnectorActionRisk = { risk: 'W' };
const SEND: ConnectorActionRisk = { risk: 'H', sensitive_operation: 'external_communication' };
const DELETE: ConnectorActionRisk = { risk: 'D', sensitive_operation: 'delete' };
const UNKNOWN: ConnectorActionRisk = { risk: 'H', sensitive_operation: 'unclassified' };

// These are product boundaries, not a risk-name heuristic: a CRM's
// DELETE_ACCOUNT deletes one business record, not the connected user account.
const BLOCKED: Record<string, readonly string[]> = {
  gmail: ['GMAIL_BATCH_DELETE_MESSAGES', 'GMAIL_DELETE_MESSAGE', 'GMAIL_DELETE_THREAD',
    'GMAIL_CREATE_DELEGATE', 'GMAIL_CREATE_FORWARDING_ADDRESS', 'GMAIL_UPDATE_AUTO_FORWARDING'],
  gdrive: ['GOOGLEDRIVE_DELETE_SHARED_DRIVE'],
  github: ['delete_organization', 'delete_org'],
};

export function isConnectorActionBlocked(connectorId: string, toolName: string): boolean {
  return Object.hasOwn(BLOCKED, connectorId) && BLOCKED[connectorId].includes(toolName);
}

const GMAIL: Record<string, ConnectorActionRisk> = Object.create(null);
for (const name of [
  'GMAIL_FETCH_EMAILS', 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID', 'GMAIL_FETCH_MESSAGE_BY_THREAD_ID',
  'GMAIL_LIST_LABELS', 'GMAIL_LIST_DRAFTS', 'GMAIL_GET_DRAFT',
  'search_messages', 'get_message', 'list_labels', 'list_threads', 'get_thread',
  'get_attachment', 'list_drafts', 'get_draft',
]) GMAIL[name] = READ;
for (const name of [
  'GMAIL_ADD_LABEL_TO_EMAIL', 'GMAIL_CREATE_LABEL', 'GMAIL_CREATE_EMAIL_DRAFT',
  'modify_message_labels', 'batch_modify_messages', 'untrash_message', 'create_draft', 'update_draft',
]) GMAIL[name] = WRITE;
for (const name of [
  'GMAIL_SEND_DRAFT', 'GMAIL_SEND_EMAIL', 'GMAIL_REPLY_TO_THREAD', 'GMAIL_FORWARD_MESSAGE',
  'send_message', 'send_draft',
]) GMAIL[name] = SEND;
for (const name of ['trash_message', 'delete_draft']) GMAIL[name] = DELETE;

// The exact productivity actions shipped by Server's Composio catalog. This
// also classifies caches from older Servers that did not attach risk metadata.
const PRODUCTIVITY: Record<string, ConnectorActionRisk> = Object.create(null);
for (const name of [
  'GOOGLEDRIVE_FIND_FILE', 'GOOGLEDRIVE_FIND_FOLDER', 'GOOGLEDRIVE_GET_FILE_METADATA',
  'GOOGLEDRIVE_DOWNLOAD_FILE', 'GOOGLEDRIVE_EXPORT_GOOGLE_WORKSPACE_FILE', 'GOOGLEDRIVE_LIST_SHARED_DRIVES',
  'GOOGLEDOCS_SEARCH_DOCUMENTS', 'GOOGLEDOCS_GET_DOCUMENT_BY_ID', 'GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT', 'GOOGLEDOCS_EXPORT_DOCUMENT_AS_PDF',
  'GOOGLESHEETS_SEARCH_SPREADSHEETS', 'GOOGLESHEETS_GET_SPREADSHEET_INFO', 'GOOGLESHEETS_GET_SHEET_NAMES', 'GOOGLESHEETS_VALUES_GET', 'GOOGLESHEETS_BATCH_GET',
  'GOOGLECALENDAR_LIST_CALENDARS', 'GOOGLECALENDAR_EVENTS_LIST', 'GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS',
  'GOOGLECALENDAR_FIND_EVENT', 'GOOGLECALENDAR_EVENTS_GET', 'GOOGLECALENDAR_FIND_FREE_SLOTS', 'GOOGLECALENDAR_GET_CURRENT_DATE_TIME',
  'OUTLOOK_GET_PROFILE', 'OUTLOOK_GET_MAILBOX_SETTINGS', 'OUTLOOK_GET_USER_BY_EMAIL', 'OUTLOOK_LIST_USER_CONTACTS',
  'OUTLOOK_LIST_TO_DO_LISTS', 'OUTLOOK_LIST_TODO_TASKS', 'OUTLOOK_GET_MASTER_CATEGORIES', 'OUTLOOK_LIST_MAIL_FOLDERS',
  'OUTLOOK_LIST_MESSAGES', 'OUTLOOK_SEARCH_MESSAGES', 'OUTLOOK_QUERY_EMAILS', 'OUTLOOK_GET_MESSAGE', 'OUTLOOK_LIST_OUTLOOK_ATTACHMENTS',
  'OUTLOOK_LIST_CALENDARS', 'OUTLOOK_LIST_EVENTS', 'OUTLOOK_GET_EVENT', 'OUTLOOK_GET_CALENDAR_VIEW', 'OUTLOOK_SEARCH_EVENTS', 'OUTLOOK_GET_SCHEDULE',
  'ONE_DRIVE_ONEDRIVE_LIST_ITEMS', 'ONE_DRIVE_LIST_FOLDER_CHILDREN', 'ONE_DRIVE_ONEDRIVE_FIND_FILE',
  'ONE_DRIVE_ONEDRIVE_FIND_FOLDER', 'ONE_DRIVE_SEARCH_ITEMS', 'ONE_DRIVE_GET_ITEM', 'ONE_DRIVE_DOWNLOAD_FILE', 'ONE_DRIVE_DOWNLOAD_FILE_BY_PATH',
]) PRODUCTIVITY[name] = READ;
for (const name of [
  'GOOGLEDRIVE_CREATE_FILE_FROM_TEXT', 'GOOGLEDRIVE_CREATE_FOLDER', 'GOOGLEDRIVE_COPY_FILE_ADVANCED', 'GOOGLEDRIVE_MOVE_FILE',
  'GOOGLEDOCS_CREATE_DOCUMENT', 'GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN', 'GOOGLEDOCS_UPDATE_DOCUMENT_MARKDOWN',
  'GOOGLEDOCS_UPDATE_DOCUMENT_SECTION_MARKDOWN', 'GOOGLEDOCS_INSERT_TEXT_ACTION', 'GOOGLEDOCS_REPLACE_ALL_TEXT',
  'GOOGLESHEETS_VALUES_UPDATE', 'GOOGLESHEETS_UPDATE_VALUES_BATCH', 'GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND', 'GOOGLESHEETS_ADD_SHEET',
  'OUTLOOK_CREATE_TASK', 'OUTLOOK_CREATE_DRAFT', 'OUTLOOK_MOVE_MESSAGE', 'OUTLOOK_UPDATE_EMAIL',
  'ONE_DRIVE_ONEDRIVE_CREATE_TEXT_FILE', 'ONE_DRIVE_ONEDRIVE_CREATE_FOLDER', 'ONE_DRIVE_ONEDRIVE_UPLOAD_FILE', 'ONE_DRIVE_UPDATE_FILE_CONTENT',
]) PRODUCTIVITY[name] = WRITE;
for (const name of [
  'GOOGLECALENDAR_CREATE_EVENT', 'GOOGLECALENDAR_PATCH_EVENT', 'GOOGLECALENDAR_UPDATE_EVENT',
  'OUTLOOK_SEND_DRAFT', 'OUTLOOK_SEND_EMAIL', 'OUTLOOK_REPLY_EMAIL', 'OUTLOOK_CALENDAR_CREATE_EVENT',
  'OUTLOOK_UPDATE_CALENDAR_EVENT', 'OUTLOOK_ACCEPT_EVENT', 'OUTLOOK_DECLINE_EVENT',
]) PRODUCTIVITY[name] = SEND;
for (const name of ['GOOGLEDRIVE_TRASH_FILE', 'GOOGLESHEETS_CLEAR_VALUES', 'GOOGLECALENDAR_DELETE_EVENT', 'OUTLOOK_DELETE_CALENDAR_EVENT']) PRODUCTIVITY[name] = DELETE;
const PRODUCTIVITY_IDS = new Set(['gdrive', 'gdocs', 'gsheets', 'gcal', 'outlook', 'm365-mail', 'm365-calendar', 'onedrive']);

const WORKSPACE: Record<string, ConnectorActionRisk> = Object.assign(Object.create(null), GMAIL);
for (const name of ['list_calendars', 'list_events', 'get_event', 'list_event_instances', 'freebusy_query',
  'get_document', 'get_document_outline', 'list_sheets', 'read_sheet', 'batch_get', 'list_tasklists', 'list_tasks', 'get_task', 'get_tasklist']) WORKSPACE[name] = READ;
for (const name of ['create_document', 'append_text', 'insert_text', 'replace_text', 'write_sheet', 'create_spreadsheet',
  'append_sheet', 'batch_update_values', 'add_sheet', 'duplicate_sheet', 'find_and_replace', 'create_task', 'update_task',
  'move_task', 'create_tasklist', 'update_tasklist', 'create_calendar']) WORKSPACE[name] = WRITE;
for (const name of ['create_event', 'quick_add_event', 'update_event', 'move_event']) WORKSPACE[name] = SEND;
for (const name of ['delete_event', 'delete_calendar', 'clear_sheet', 'delete_sheet', 'delete_task', 'clear_completed', 'delete_tasklist']) WORKSPACE[name] = DELETE;

/** Resolve only trusted Host policy or hints from a catalog service. A custom
 * server may describe its tools, but cannot grant itself read-only treatment.
 * Pinned policies and reviewed actions take precedence over provider hints.
 */
export function connectorActionRisk(
  instance: Pick<ConnectorInstance, 'id' | 'origin' | 'composio_grant'>,
  tool: ToolSchema,
): ConnectorActionRisk {
  if (instance.origin === 'custom' || instance.id.startsWith('custom-')) return UNKNOWN;
  const entry = findCatalogEntry(instance.id);
  const pinned = entry?.tool_policies && Object.hasOwn(entry.tool_policies, tool.name)
    ? entry.tool_policies[tool.name] : undefined;
  if (pinned) return pinned;
  const exact = instance.id === 'gmail' ? GMAIL[tool.name]
    : instance.id === 'google-workspace' ? WORKSPACE[tool.name]
    : PRODUCTIVITY_IDS.has(instance.id) ? PRODUCTIVITY[tool.name] || WORKSPACE[tool.name] : undefined;
  if (exact) return exact;
  if (['gsearch-console', 'bing-webmaster'].includes(instance.id)
    && ['list_sites', 'query_search_analytics', 'list_sitemaps', 'inspect_url',
      'query_keyword_stats', 'query_page_stats', 'query_traffic_stats'].includes(tool.name)) return READ;
  if (instance.id === 'discord') {
    if (['list_guilds', 'list_channels'].includes(tool.name)) return READ;
    if (tool.name === 'set_default_channel') return WRITE;
    if (['send_message', 'send_report'].includes(tool.name)) return SEND;
  }
  if (instance.composio_grant && tool.orkas_action_policy) return tool.orkas_action_policy;
  if (entry && tool.annotations?.readOnlyHint === true && tool.annotations.destructiveHint !== true) return READ;
  if (entry && tool.annotations?.destructiveHint === true) return DELETE;
  return UNKNOWN;
}
