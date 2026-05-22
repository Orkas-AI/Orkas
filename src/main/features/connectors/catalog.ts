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
  // Google Workspace entries (`google-workspace` bundle + 5 service members) live in
  // `catalog-google.ts` and are loaded via `_loadGoogleEntries` below. PC and OrkasOpen both
  // ship them; the try/require keeps older OrkasOpen checkouts that lack the file from crashing.
  ..._loadGoogleEntries(),
];

function _loadGoogleEntries(): CatalogEntry[] {
  try {
    // `require` (not `import`) so the path isn't statically resolved at bundle time. Older
    // OrkasOpen builds may lack this file; swallow and return [] for that compatibility case.
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const mod = require('./catalog-google') as { GOOGLE_ENTRIES?: CatalogEntry[] };
    return Array.isArray(mod.GOOGLE_ENTRIES) ? mod.GOOGLE_ENTRIES : [];
  } catch {
    return [];
  }
}

export function findCatalogEntry(id: string): CatalogEntry | null {
  return CONNECTOR_CATALOG.find((e) => e.id === id) || null;
}
