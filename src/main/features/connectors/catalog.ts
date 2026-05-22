/**
 * Built-in catalog of connector entries.
 *
 * Every entry uses OAuth 2.0 by default — desktop OAuth flow with PKCE and a temporary 127.0.0.1
 * callback listener (see `oauth.ts`). The catalog declares the provider endpoints + default
 * scopes; the actual `client_id` / `client_secret` come from `oauth-config.ts` (env-var at build
 * time for the Hosted Orkas builds, file-based BYO for OrkasOpen). An entry with no usable
 * OAuth client config is rendered "需先配置 OAuth client" in the UI (still visible, not
 * installable).
 *
 * **About the access_token → MCP server hop**: each catalog entry pairs a `transport_template`
 * (the MCP server we spawn) with `oauth_env_key` (the env var name the server reads). At install
 * + every reconnect, the manager injects the *current* access_token into that env var before
 * spawning. Refresh is lazy — checked at boot / `connectors.refresh` / when the model's tool
 * call surfaces a 401.
 */
import type { CatalogEntry } from './types';

export const CONNECTOR_CATALOG: CatalogEntry[] = [
  {
    id: 'github',
    display_name: 'GitHub',
    icon_svg: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="#181717" d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>',
    category: 'developer',
    description_zh: '仓库 / Issue / PR / 文件 / 代码搜索等 GitHub API。',
    description_en: 'Repositories, issues, PRs, files, code search, and the rest of the GitHub API.',
    auth_mode: 'server_bridge',
    oauth: { provider_id: 'github' },
    // Remote MCP via GitHub's hosted Streamable HTTP endpoint. We pass the user-to-server OAuth
    // token (ghu_*) as `Authorization: Bearer <token>` — `apply-template.ts::applyTemplate`
    // builds that header from `grant.token_type + grant.access_token`. Zero local install /
    // no MCP-server subprocess.
    transport_template: {
      kind: 'streamable-http',
      url: 'https://api.githubcopilot.com/mcp/',
      oauth_header_key: 'Authorization',
    },
  },
  {
    id: 'notion',
    display_name: 'Notion',
    icon_svg: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="#000" d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z"/></svg>',
    category: 'productivity',
    description_zh: '读写 Notion 页面 / 数据库 / 块,通过官方托管的 MCP server 直连。',
    description_en: 'Read and write Notion pages, databases, and blocks via the official hosted MCP server.',
    // DCR — Notion hosts an MCP-spec OAuth authorization server. No Orkas-side pre-registered
    // integration; PC self-registers at first connect via RFC 7591. See features/connectors/
    // oauth-dcr.ts. Server's only role is the HTTPS callback intermediate (no Notion-specific
    // code on Server).
    auth_mode: 'mcp_dcr',
    transport_template: {
      kind: 'streamable-http',
      url: 'https://mcp.notion.com/mcp',
      oauth_header_key: 'Authorization',
    },
  },
  {
    id: 'slack',
    display_name: 'Slack',
    icon_svg: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="#E01E5A" d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313z"/><path fill="#36C5F0" d="M8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312z"/><path fill="#2EB67D" d="M18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312z"/><path fill="#ECB22E" d="M15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z"/></svg>',
    category: 'communication',
    description_zh: '发消息、读频道、自动化工作区任务。',
    description_en: 'Post messages, browse channels, automate workspace tasks.',
    auth_mode: 'server_bridge',
    oauth: { provider_id: 'slack' },
    // Official Slack remote MCP (launched Feb 2026). Streamable HTTP — Slack does not support
    // SSE-based MCP connections. The `xoxb-*` bot token from `oauth.v2.access` goes through
    // `Authorization: Bearer <token>`; apply-template.ts normalizes the Slack-returned
    // `token_type: "bot"` to "Bearer" before the header is built.
    transport_template: {
      kind: 'streamable-http',
      url: 'https://mcp.slack.com/mcp',
      oauth_header_key: 'Authorization',
    },
  },
  // ── Google Workspace ────────────────────────────────────────────────────
  // Five separate entries (Gmail / Calendar / Docs / Sheets / Tasks) share **one** Google OAuth
  // client (registered once in GCP console with all 5 scopes + identity scopes). Per-entry
  // scope subset is picked by `Server/biz/connectors/oauth/google.py::build_authorize_url(state,
  // catalog_id)` reading the entry's `id`. Each entry runs its own service-specific remote MCP
  // server, so a user who only installs Gmail doesn't see Sheets tools in the runner's tool list.
  {
    id: 'gmail',
    display_name: 'Gmail',
    icon_svg: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="#4285f4" d="M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z"/><path fill="#34a853" d="M5.455 21.003V11.73l-3.819-2.864v10.5c0 .904.732 1.637 1.636 1.637z"/><path fill="#ea4335" d="M18.545 21.003V11.73l3.819-2.864v10.5a1.636 1.636 0 0 1-1.636 1.637z"/><path fill="#fbbc04" d="M5.455 11.73 12 16.64l6.545-4.91V4.64L12 9.548 5.455 4.64z"/><path fill="#c5221f" d="M0 5.457v3.41l5.455 4.092V4.64L3.927 3.494C2.309 2.28 0 3.434 0 5.457z"/></svg>',
    category: 'communication',
    description_zh: '读 / 发邮件、管理标签、自动化收件箱。',
    description_en: 'Read and send mail, manage labels, automate the inbox.',
    auth_mode: 'server_bridge',
    oauth: { provider_id: 'google' },
    transport_template: {
      kind: 'streamable-http',
      url: 'https://gmailmcp.googleapis.com/mcp/v1',
      oauth_header_key: 'Authorization',
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
    transport_template: {
      kind: 'streamable-http',
      url: 'https://calendarmcp.googleapis.com/mcp/v1',
      oauth_header_key: 'Authorization',
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
    transport_template: {
      kind: 'streamable-http',
      url: 'https://docsmcp.googleapis.com/mcp/v1',
      oauth_header_key: 'Authorization',
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
    transport_template: {
      kind: 'streamable-http',
      url: 'https://sheetsmcp.googleapis.com/mcp/v1',
      oauth_header_key: 'Authorization',
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
    transport_template: {
      kind: 'streamable-http',
      url: 'https://tasksmcp.googleapis.com/mcp/v1',
      oauth_header_key: 'Authorization',
    },
  },
];

export function findCatalogEntry(id: string): CatalogEntry | null {
  return CONNECTOR_CATALOG.find((e) => e.id === id) || null;
}
