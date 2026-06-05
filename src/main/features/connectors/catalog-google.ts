/**
 * Google Workspace catalog entries — extracted from `catalog.ts` so the Google bundle and
 * per-service connectors stay isolated while still syncing to OrkasOpen. Both PC and OrkasOpen
 * include this file via a try/require in `catalog.ts`; the catch path only keeps older open-source
 * checkouts without this file from crashing.
 *
 * Includes:
 *   - `google-workspace` (one independent all-in-one connector backed by
 *     `bin/google-workspace-mcp-server.cjs`)
 *   - `gmail`, `gcal`, `gdocs`, `gsheets`, `gtasks` (5 independent per-service connectors,
 *     each backed by a local stdio adapter under `PC/bin/`)
 *
 * Adding a new Google service: drop a new entry here + `bin/<svc>-mcp-server.cjs` adapter,
 * Server's `_SCOPES_BY_CATALOG_ID` row, and wire the adapter into
 * `bin/google-workspace-mcp-server.cjs` if you want it covered by the all-in-one connector.
 */
import type { CatalogEntry } from './types';

const GOOGLE_SCOPES = {
  gmail: ['https://www.googleapis.com/auth/gmail.modify'],
  gcal: ['https://www.googleapis.com/auth/calendar'],
  gdocs: ['https://www.googleapis.com/auth/documents'],
  gsheets: ['https://www.googleapis.com/auth/drive.file'],
  gtasks: ['https://www.googleapis.com/auth/tasks'],
};

const GOOGLE_WORKSPACE_SCOPES = [
  ...GOOGLE_SCOPES.gmail,
  ...GOOGLE_SCOPES.gcal,
  ...GOOGLE_SCOPES.gdocs,
  ...GOOGLE_SCOPES.gsheets,
  ...GOOGLE_SCOPES.gtasks,
];

export const GOOGLE_ENTRIES: CatalogEntry[] = [
  // ── Google Workspace ────────────────────────────────────────────────────
  // Optional one-click suite (`google-workspace`) requests the union of the 5 service scopes and
  // exposes all tools through one independent connector instance. The individual service entries
  // are also shown so users can grant only the Google product they need. There is intentionally
  // no state sync between the suite card and the 5 single-service cards. Bypasses Google's MCP
  // wrapper service
  // (`gmailmcp.googleapis.com`) which is in Developer Preview with a project-level allowlist
  // that third-party OAuth clients can't reach. See `bin/gmail-mcp-server.cjs` header for
  // rationale and PC/CLAUDE.md §6.5.
  {
    id: 'google-workspace',
    display_name: 'Google Workspace',
    icon_svg: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="#4285f4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34a853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#fbbc05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#ea4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>',
    category: 'productivity',
    description_zh: '一次授权接入 Gmail、日历、文档、表格和任务；也可以单独连接各项服务。',
    description_en: 'Connect Gmail, Calendar, Docs, Sheets, and Tasks in one consent; individual services can also be connected separately.',
    auth_mode: 'server_bridge',
    oauth: { provider_id: 'google' },
    required_oauth_scopes: GOOGLE_WORKSPACE_SCOPES,
    transport_template: {
      kind: 'stdio',
      command: '${ORKAS_NODE}',
      args: ['${ORKAS_PC_DIR}/bin/google-workspace-mcp-server.cjs'],
      oauth_env_key: 'GOOGLE_ACCESS_TOKEN',
    },
  },
  {
    id: 'gmail',
    display_name: 'Gmail',
    icon_svg: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="#4285f4" d="M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z"/><path fill="#34a853" d="M5.455 21.003V11.73l-3.819-2.864v10.5c0 .904.732 1.637 1.636 1.637z"/><path fill="#ea4335" d="M18.545 21.003V11.73l3.819-2.864v10.5a1.636 1.636 0 0 1-1.636 1.637z"/><path fill="#fbbc04" d="M5.455 11.73 12 16.64l6.545-4.91V4.64L12 9.548 5.455 4.64z"/><path fill="#c5221f" d="M0 5.457v3.41l5.455 4.092V4.64L3.927 3.494C2.309 2.28 0 3.434 0 5.457z"/></svg>',
    category: 'communication',
    description_zh: '读 / 发邮件、管理标签、自动化收件箱。',
    description_en: 'Read and send mail, manage labels, automate the inbox.',
    auth_mode: 'server_bridge',
    oauth: { provider_id: 'google' },
    required_oauth_scopes: GOOGLE_SCOPES.gmail,
    transport_template: {
      kind: 'stdio',
      command: '${ORKAS_NODE}',
      args: ['${ORKAS_PC_DIR}/bin/gmail-mcp-server.cjs'],
      oauth_env_key: 'GOOGLE_ACCESS_TOKEN',
    },
  },
  {
    id: 'gcal',
    display_name: 'Google Calendar',
    icon_svg: '<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg"><path fill="#fff" d="M152.6 47.4H47.4v105.2h105.2z"/><path fill="#1a73e8" d="M152.6 200 200 152.6l-23.7-4.2-23.7 4.2-4.6 21.6z"/><path fill="#ea4335" d="M0 152.6v32.6c0 8.4 6.8 15.3 15.3 15.3h32.6l4.9-23.7-4.9-23.7-25-4.9z"/><path fill="#188038" d="M200 47.4V14.7c0-8.4-6.8-15.3-15.3-15.3h-32.6q-4.45 22.05-4.9 24.6.45 2.65 4.9 23.4 25 4.45 23.7 0z"/><path fill="#fbbc04" d="M200 47.4h-47.4v105.2H200z"/><path fill="#34a853" d="M152.6 152.6H47.4V200h105.2z"/><path fill="#4285f4" d="M152.6 0H15.3C6.8 0 0 6.8 0 15.3v137.3h47.4V47.4h105.2z"/><path fill="#4285f4" d="m69 130.5c-3.9-2.7-6.7-6.5-8.2-11.6l9.1-3.8c.8 3.2 2.4 5.7 4.5 7.5 2.1 1.8 4.7 2.7 7.7 2.7s5.7-.9 7.8-2.8 3.2-4.2 3.2-7-1.1-5.3-3.4-7.2-5.1-2.8-8.5-2.8h-5.3v-9h4.7c2.9 0 5.4-.8 7.5-2.4 2-1.6 3.1-3.8 3.1-6.5 0-2.5-.9-4.4-2.6-5.9s-3.9-2.2-6.5-2.2-4.6.7-6 2-2.5 3-3.1 4.9l-9-3.7c1.1-3.1 3.1-5.9 6.1-8.3 3-2.4 6.8-3.6 11.4-3.6 3.4 0 6.5.7 9.2 2 2.7 1.3 4.9 3.2 6.4 5.5 1.6 2.4 2.3 5 2.3 8 0 3-.7 5.5-2.2 7.6s-3.3 3.7-5.4 4.8v.5q4.05 1.65 6.6 5.1c2.55 3.45 2.6 5.1 2.6 8.5s-.8 6.2-2.5 8.8c-1.7 2.6-3.9 4.6-6.8 6.1q-4.35 2.25-9.6 2.25c-4.05 0-7.7-.9-10.8-2.6zm47.7-37.8-10 7.3-5-7.6 18-13h6.9v61.3h-10z"/></svg>',
    category: 'productivity',
    description_zh: '查看、创建、修改日历事件与会议。',
    description_en: 'View, create, and update calendar events and meetings.',
    auth_mode: 'server_bridge',
    oauth: { provider_id: 'google' },
    required_oauth_scopes: GOOGLE_SCOPES.gcal,
    transport_template: {
      kind: 'stdio',
      command: '${ORKAS_NODE}',
      args: ['${ORKAS_PC_DIR}/bin/gcal-mcp-server.cjs'],
      oauth_env_key: 'GOOGLE_ACCESS_TOKEN',
    },
  },
  {
    id: 'gdocs',
    display_name: 'Google Docs',
    icon_svg: '<svg viewBox="0 0 47 65" xmlns="http://www.w3.org/2000/svg"><path fill="#4285F4" d="M29.375 0H4.4063C1.9688 0 0 1.96875 0 4.40625V60.5938C0 63.0313 1.9688 65 4.4063 65H42.5938C45.0313 65 47 63.0313 47 60.5938V17.625L36.7188 10.2813z"/><path fill="#1967D2" d="m30.6406 16.3906 16.3594 16.3594v-15.125z"/><path fill="#fff" d="M11.75 47.0625H35.25V44.125H11.75zm0-5.875H35.25V38.25H11.75zm0-11.75v2.9375H35.25V29.4375zm0 8.8125H35.25V32.375H11.75z"/><path fill="#FFF" d="M29.375 0v13.2188c0 2.4375 1.9687 4.4062 4.4062 4.4062H47z"/></svg>',
    category: 'productivity',
    description_zh: '读 / 写 Google Docs 文档,自动化文档工作流。',
    description_en: 'Read, create, and manage Google Docs from your workflows.',
    auth_mode: 'server_bridge',
    oauth: { provider_id: 'google' },
    required_oauth_scopes: GOOGLE_SCOPES.gdocs,
    transport_template: {
      kind: 'stdio',
      command: '${ORKAS_NODE}',
      args: ['${ORKAS_PC_DIR}/bin/gdocs-mcp-server.cjs'],
      oauth_env_key: 'GOOGLE_ACCESS_TOKEN',
    },
  },
  {
    id: 'gsheets',
    display_name: 'Google Sheets',
    icon_svg: '<svg viewBox="0 0 47 65" xmlns="http://www.w3.org/2000/svg"><path fill="#0F9D58" d="M29.375 0H4.4063C1.9688 0 0 1.96875 0 4.40625V60.5938C0 63.0313 1.9688 65 4.4063 65H42.5938C45.0313 65 47 63.0313 47 60.5938V17.625L36.7188 10.2813z"/><path fill="#0B8043" d="m30.6406 16.3906 16.3594 16.3594v-15.125z"/><path fill="#fff" d="M35.25 29.4375h-23.5v17.625H35.25zm-13.2188 14.875h-8.0937v-4.2188h8.0937zm0-6.4063h-8.0937v-4.2187h8.0937zm10.5625 6.4063h-8.0937v-4.2188h8.0937zm0-6.4063h-8.0937v-4.2187h8.0937z"/><path fill="#FFF" d="M29.375 0v13.2188c0 2.4375 1.9687 4.4062 4.4062 4.4062H47z"/></svg>',
    category: 'data',
    description_zh: '把电子表格当作数据源,读写单元格与公式。',
    description_en: 'Use spreadsheets as a data source — read and write cells and formulas.',
    auth_mode: 'server_bridge',
    oauth: { provider_id: 'google' },
    required_oauth_scopes: GOOGLE_SCOPES.gsheets,
    transport_template: {
      kind: 'stdio',
      command: '${ORKAS_NODE}',
      args: ['${ORKAS_PC_DIR}/bin/gsheets-mcp-server.cjs'],
      oauth_env_key: 'GOOGLE_ACCESS_TOKEN',
    },
  },
  {
    id: 'gtasks',
    display_name: 'Google Tasks',
    icon_svg: '<svg viewBox="0 0 192 192" xmlns="http://www.w3.org/2000/svg"><path fill="#FBBC04" d="m139.8 60.6 19.5 19.5 32.7-32.6L172.5 28z"/><path fill="#34A853" d="M88.5 111.9 67 90.5l-19.6 19.6 41 41 84.1-84-19.5-19.6z"/><path fill="#1A73E8" d="M97 192c52.7 0 95.5-42.8 95.5-95.6 0-2.5-.2-5-.4-7.5-2 2.4-83 83-83 83l-41.7-41.7-67 67c17.3 17 41 27.8 67 27.8z"/><path fill="#188038" d="M30 162c-37.6-37.6-37.6-98.6 0-136.2s98.6-37.6 136.2 0z"/></svg>',
    category: 'productivity',
    description_zh: '把任务管理直接接入工作流。',
    description_en: 'Integrate task management directly into your workflows.',
    auth_mode: 'server_bridge',
    oauth: { provider_id: 'google' },
    required_oauth_scopes: GOOGLE_SCOPES.gtasks,
    transport_template: {
      kind: 'stdio',
      command: '${ORKAS_NODE}',
      args: ['${ORKAS_PC_DIR}/bin/gtasks-mcp-server.cjs'],
      oauth_env_key: 'GOOGLE_ACCESS_TOKEN',
    },
  },
];
