/**
 * Built-in catalog of connector entries.
 *
 * Every entry uses OAuth 2.0 by default — Server-bridge flow with an `orkas://` deep-link
 * callback (see `oauth.ts` header). The catalog declares the provider id + default scopes;
 * the actual `client_id` / `client_secret` live on the Orkas Server and never touch the PC
 * binary.
 *
 * **About the access_token → MCP server hop**: each catalog entry pairs a `transport_template`
 * (the MCP server we spawn) with `oauth_env_key` (the env var name the server reads). At install
 * + every reconnect, the manager injects the *current* access_token into that env var before
 * spawning. Refresh is lazy — checked at boot / `connectors.refresh` / when the model's tool
 * call surfaces a 401.
 */
import { GOOGLE_ENTRIES } from './catalog-google';
import type { CatalogEntry } from './types';

export const CONNECTOR_CATALOG: CatalogEntry[] = [
  {
    id: 'github',
    display_name: 'GitHub',
    icon_svg: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="#181717" d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>',
    category: 'developer',
    description_zh: '查找和管理代码仓库、Issue、PR、文件与代码。',
    description_en: 'Find and manage repositories, issues, PRs, files, and code.',
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
    description_zh: '查找、阅读和更新 Notion 页面、数据库与内容块。',
    description_en: 'Find, read, and update Notion pages, databases, and blocks.',
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
    id: 'linear',
    display_name: 'Linear',
    icon_svg: '<svg fill="#5E6AD2" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z"/></svg>',
    category: 'productivity',
    description_zh: '查找、创建和更新 Linear Issue、项目、周期与评论。',
    description_en: 'Find, create, and update Linear issues, projects, cycles, and comments.',
    auth_mode: 'mcp_dcr',
    transport_template: {
      kind: 'streamable-http',
      url: 'https://mcp.linear.app/mcp',
      oauth_header_key: 'Authorization',
    },
  },
  {
    id: 'atlassian',
    display_name: 'Atlassian',
    icon_svg: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="#2684FF" d="M7.65 11.62c-.2-.22-.54-.21-.72.03L.2 20.12a.52.52 0 0 0 .41.84h9.36c.18 0 .34-.09.43-.24 2.02-3.5.82-6.88-2.75-9.1z"/><path fill="#0052CC" d="M12.6 3.24c-3.77 5.96-3.52 12.55.2 17.48.1.13.25.2.41.2h9.18c.42 0 .67-.47.43-.82L13.48 3.22a.52.52 0 0 0-.88.02z"/></svg>',
    category: 'productivity',
    description_zh: '连接 Jira、Confluence 等 Atlassian 工作数据，搜索、读取并更新 issue、页面与项目上下文。',
    description_en: 'Connect Jira, Confluence, and other Atlassian work data to search, read, and update issues, pages, and project context.',
    auth_mode: 'mcp_dcr',
    transport_template: {
      kind: 'streamable-http',
      url: 'https://mcp.atlassian.com/v1/mcp/authv2',
      oauth_header_key: 'Authorization',
    },
  },
  {
    id: 'airtable',
    display_name: 'Airtable',
    icon_svg: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="#FCB400" d="M10.94 3.16 2.7 6.57c-.46.19-.46.84 0 1.03l8.27 3.42c.66.27 1.4.27 2.06 0L21.3 7.6c.46-.19.46-.84 0-1.03l-8.24-3.41a2.78 2.78 0 0 0-2.12 0z"/><path fill="#18BFFF" d="M12.56 12.86v7.55c0 .36.36.6.69.46l9.22-3.58c.2-.08.33-.27.33-.48V9.27c0-.36-.36-.6-.69-.46l-9.22 3.58a.5.5 0 0 0-.33.47z"/><path fill="#F82B60" d="m10.75 13.25-2.73 1.32-.28.14-5.78 2.78a.5.5 0 0 1-.72-.45V9.31c0-.37.38-.61.71-.45l8.8 4.17c.2.1.2.32 0 .22z"/></svg>',
    category: 'data',
    description_zh: '查询和更新 Airtable bases、tables、records 与评论。',
    description_en: 'Query and update Airtable bases, tables, records, and comments.',
    auth_mode: 'mcp_dcr',
    transport_template: {
      kind: 'streamable-http',
      url: 'https://mcp.airtable.com/mcp',
      oauth_header_key: 'Authorization',
    },
  },
  {
    id: 'gitlab',
    display_name: 'GitLab',
    icon_svg: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="#E24329" d="m12 22 4.42-13.6H7.58z"/><path fill="#FC6D26" d="M12 22 7.58 8.4H1.39zM12 22l10.61-13.6h-6.19z"/><path fill="#FCA326" d="M1.39 8.4.04 12.56c-.12.38.01.8.33 1.04L12 22zM22.61 8.4l1.35 4.16c.12.38-.01.8-.33 1.04L12 22z"/><path fill="#E24329" d="M7.58 8.4 9.48 2.55c.1-.31.54-.31.64 0L12 8.4zM16.42 8.4l-1.9-5.85c-.1-.31-.54-.31-.64 0L12 8.4z"/></svg>',
    category: 'developer',
    description_zh: '连接 GitLab.com 项目、Issue、Merge Request、Pipeline 与代码上下文。',
    description_en: 'Connect GitLab.com projects, issues, merge requests, pipelines, and code context.',
    auth_mode: 'mcp_dcr',
    transport_template: {
      kind: 'streamable-http',
      url: 'https://gitlab.com/api/v4/mcp',
      oauth_header_key: 'Authorization',
    },
  },
  {
    id: 'sentry',
    display_name: 'Sentry',
    icon_svg: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="#362D59" d="M13.91 2.505c-.873-1.448-2.972-1.448-3.844 0L6.904 7.92a15.478 15.478 0 0 1 8.53 12.811h-2.221A13.301 13.301 0 0 0 5.784 9.814l-2.926 5.06a7.65 7.65 0 0 1 4.435 5.848H2.194a.365.365 0 0 1-.298-.534l1.413-2.402a5.16 5.16 0 0 0-1.614-.913L.296 19.275a2.182 2.182 0 0 0 .812 2.999 2.24 2.24 0 0 0 1.086.288h6.983a9.322 9.322 0 0 0-3.845-8.318l1.11-1.922a11.47 11.47 0 0 1 4.95 10.24h5.915a17.242 17.242 0 0 0-7.885-15.28l2.244-3.845a.37.37 0 0 1 .504-.13c.255.14 9.75 16.708 9.928 16.9a.365.365 0 0 1-.327.543h-2.287c.029.612.029 1.223 0 1.831h2.297a2.206 2.206 0 0 0 1.922-3.31z"/></svg>',
    category: 'developer',
    description_zh: '查询 Sentry 组织、项目、错误事件与调试上下文，并执行受控修复工作流。',
    description_en: 'Query Sentry organizations, projects, issues, and debugging context, with controlled remediation workflows.',
    auth_mode: 'mcp_dcr',
    transport_template: {
      kind: 'streamable-http',
      url: 'https://mcp.sentry.dev/mcp',
      oauth_header_key: 'Authorization',
    },
  },
  {
    id: 'cloudflare',
    display_name: 'Cloudflare',
    icon_svg: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="#F38020" d="M16.6 13.05a3.14 3.14 0 0 0-3.02-4.03c-.17 0-.35.02-.52.05a4.98 4.98 0 0 0-9.34 2.39c0 .28.02.55.07.82A3.71 3.71 0 0 0 4.5 19h11.64a3.05 3.05 0 0 0 .46-5.95z"/><path fill="#F6821F" d="M18.34 19H20a3 3 0 0 0 .5-5.95 3.78 3.78 0 0 0-4.1-4.86 4.42 4.42 0 0 1 2.14 5.66A3.06 3.06 0 0 1 18.34 19z"/><path fill="#fff" opacity=".86" d="M6.1 15.8h9.93c.44 0 .83-.29.95-.72.15-.56-.27-1.11-.85-1.11h-2.42l-.12-.49a2.37 2.37 0 0 0-4.56-.22l-.17.48h-2.6c-.57 0-1.04.46-1.04 1.03 0 .57.31 1.03.88 1.03z"/></svg>',
    category: 'developer',
    description_zh: '连接 Cloudflare API MCP，管理 DNS、Workers、Zero Trust、WAF、账号资源与平台上下文。',
    description_en: 'Connect Cloudflare API MCP for DNS, Workers, Zero Trust, WAF, account resources, and platform context.',
    auth_mode: 'mcp_dcr',
    transport_template: {
      kind: 'streamable-http',
      url: 'https://mcp.cloudflare.com/mcp',
      oauth_header_key: 'Authorization',
    },
  },
  {
    id: 'stripe',
    display_name: 'Stripe',
    icon_svg: '<svg fill="#635BFF" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409c0-.831.683-1.305 1.901-1.305c2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0C9.667 0 7.589.654 6.104 1.872C4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219c2.585.92 3.445 1.574 3.445 2.583c0 .98-.84 1.545-2.354 1.545c-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813c1.664-1.305 2.525-3.236 2.525-5.732c0-4.128-2.524-5.851-6.594-7.305h.003z"/></svg>',
    category: 'developer',
    description_zh: '查询和操作 Stripe 支付、客户、订阅、发票与开发者上下文。',
    description_en: 'Query and operate on Stripe payments, customers, subscriptions, invoices, and developer context.',
    auth_mode: 'mcp_dcr',
    // Stripe's MCP endpoint is the host root. Its PRM points at access.stripe.com, while
    // authorization-server metadata is also published on the MCP host; oauth-dcr.ts handles
    // that fallback.
    transport_template: {
      kind: 'streamable-http',
      url: 'https://mcp.stripe.com',
      oauth_header_key: 'Authorization',
    },
  },
  {
    id: 'supabase',
    display_name: 'Supabase',
    icon_svg: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="#3ECF8E" d="M13.4 21.7c-.8 1-2.4.4-2.4-.9v-7.4H5.7c-1 0-1.6-1.2-1-2L10.6 2c.8-1.2 2.6-.6 2.6.8v7.8h5.1c1 0 1.6 1.2 1 2z"/><path fill="#1F8A5F" d="M13.2 10.6V2.8c0-1.4-1.8-2-2.6-.8L4.7 11.4c-.6.8 0 2 1 2H11z"/></svg>',
    category: 'developer',
    description_zh: '连接 Supabase 项目、数据库、Edge Functions、Storage 与平台上下文。',
    description_en: 'Connect Supabase projects, databases, Edge Functions, Storage, and platform context.',
    auth_mode: 'mcp_dcr',
    transport_template: {
      kind: 'streamable-http',
      url: 'https://mcp.supabase.com/mcp',
      oauth_header_key: 'Authorization',
    },
  },
  {
    id: 'close',
    display_name: 'Close',
    icon_svg: '<svg viewBox="0 0 64 60" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M32 47C14.06 47 0 39.53 0 30C0 20.47 14.06 13 32 13C49.94 13 64 20.47 64 30C64 39.53 49.94 47 32 47ZM32 18C19.23 18 5 22.93 5 30C5 37.07 19.23 42 32 42C44.77 42 59 37.07 59 30C59 22.93 44.77 18 32 18Z" fill="#4EC375"/><path d="M42.83 59.04C34.81 59.04 24.55 51.11 17.27 38.5C13.14 31.35 10.63 23.8 10.19 17.23C9.71 10.03 11.77 4.73 15.99 2.29C20.21-.15 25.84.72 31.83 4.73C37.3 8.4 42.58 14.35 46.71 21.5C55.68 37.04 56.24 52.95 47.99 57.71C46.43 58.61 44.69 59.04 42.82 59.04h.01ZM21.25 5.94c-1.04 0-1.97.22-2.75.68c-2.45 1.41-3.66 5.16-3.32 10.28c.39 5.82 2.67 12.61 6.42 19.11c6.38 11.06 17.77 20.92 23.89 17.38c6.12-3.54 3.28-18.32-3.11-29.38c-3.75-6.5-8.49-11.87-13.33-15.11c-2.9-1.94-5.6-2.94-7.81-2.94l.01-.02Z" fill="#1463FF"/><path d="M21.24 59.07c-1.91 0-3.67-.45-5.24-1.36c-4.22-2.44-6.29-7.74-5.8-14.94c.44-6.57 2.95-14.12 7.08-21.27C26.25 5.96 39.75-2.48 48 2.29c8.25 4.77 7.69 20.67-1.28 36.21c-4.13 7.15-9.41 13.1-14.88 16.77c-3.76 2.52-7.38 3.8-10.6 3.8ZM42.62 5.89c-6.36 0-15.53 8.61-21.02 18.11c-3.75 6.5-6.03 13.28-6.42 19.11c-.34 5.12.87 8.86 3.32 10.28c2.45 1.41 6.29.59 10.56-2.27c4.85-3.25 9.58-8.62 13.33-15.11c6.38-11.06 9.23-25.85 3.11-29.38c-.86-.5-1.83-.73-2.88-.73v-.01Z" fill="#FFBC00"/><path d="M32 42C19.23 42 5 37.07 5 30H0c0 9.53 14.06 17 32 17v-5Z" fill="#4EC375"/><path d="M33.15 12.15c-1.34-1.24-2.71-2.34-4.09-3.27c-1.36-.91-2.68-1.62-3.92-2.11l1.66-4.72c1.64.63 3.33 1.52 5.05 2.68c1.81 1.22 3.61 2.68 5.35 4.36l-4.04 3.06h-.01Z" fill="#1463FF"/><path d="M37.16 52.48c-2.16-1.16-4.41-2.89-6.59-4.98l-3.83 3.33c2.24 2.17 4.54 3.95 6.82 5.29l3.61-3.64h-.01Z" fill="#1463FF"/><path d="M55.04 23.89C49.92 20.25 40.63 18 32 18v-5c10.05 0 18.88 2.34 24.71 6.08l-1.67 4.81Z" fill="#4EC375"/></svg>',
    category: 'productivity',
    description_zh: '查询和更新 Close CRM leads、contacts、opportunities、tasks 与沟通记录。',
    description_en: 'Query and update Close CRM leads, contacts, opportunities, tasks, and communication records.',
    auth_mode: 'mcp_dcr',
    transport_template: {
      kind: 'streamable-http',
      url: 'https://mcp.close.com/mcp',
      oauth_header_key: 'Authorization',
    },
  },
  {
    id: 'webflow',
    display_name: 'Webflow',
    icon_svg: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="#146EF5" d="m24 4.515-7.658 14.97H9.149l3.205-6.204h-.144C9.566 16.713 5.621 18.973 0 19.485v-6.118s3.596-.213 5.71-2.435H0V4.515h6.417v5.278l.144-.001 2.622-5.277h4.854v5.244h.144l2.72-5.244H24Z"/></svg>',
    category: 'productivity',
    description_zh: '查看和更新 Webflow 站点、页面、CMS 内容、SEO 信息与资源文件。',
    description_en: 'View and update Webflow sites, pages, CMS content, SEO metadata, and assets.',
    auth_mode: 'mcp_dcr',
    transport_template: {
      kind: 'streamable-http',
      url: 'https://mcp.webflow.com/mcp',
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
  ...GOOGLE_ENTRIES,
  {
    id: 'bing-webmaster',
    display_name: 'Bing Webmaster Tools',
    icon_svg: '<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve" viewBox="86.7 -0.45 338.46 512.29"><radialGradient id="bing-a" cx="-49.449" cy="651.998" r=".5" gradientTransform="matrix(-346.4626 -399.8405 -287.7029 249.2952 170863.313 -181950.234)" gradientUnits="userSpaceOnUse"><stop offset="0" style="stop-color:#00cacc"/><stop offset="1" style="stop-color:#048fce"/></radialGradient><path d="M257.9 161.5c-9.4 1.1-16.6 8.8-17.3 18.4c-.3 4.2-.2 4.4 9.2 28.7c21.5 55.3 26.7 68.6 27.6 70.4c2.1 4.5 5.1 8.8 8.8 12.6c2.9 2.9 4.7 4.5 7.9 6.6c5.6 3.7 8.4 4.8 30.2 11.2c21.2 6.3 32.8 10.5 42.8 15.4c13 6.4 22 13.7 27.7 22.4c4.1 6.2 7.7 17.4 9.3 28.6c.6 4.4.6 14.1 0 18.1c-1.3 8.6-4 15.8-8.1 21.9c-2.2 3.2-1.4 2.7 1.7-1.2c8.9-11.1 18-30 22.6-47.2c5.6-20.8 6.4-43.1 2.2-64.3c-8.1-41.2-34.1-76.7-70.7-96.7c-2.3-1.3-11.1-5.8-22.9-12c-1.8-.9-4.3-2.2-5.5-2.9c-1.2-.6-3.7-1.9-5.5-2.9c-1.8-.9-7-3.6-11.5-6s-9.6-5-11.3-5.9c-5.1-2.7-8.5-4.4-11-5.8c-11.8-6.2-16.7-8.6-18.2-9.1s-5.3-1-6.2-1c0 .5-.9.6-1.8.7" style="fill-rule:evenodd;clip-rule:evenodd;fill:url(#bing-a)"/><radialGradient id="bing-b" cx="-49.633" cy="652.268" r=".5" gradientTransform="matrix(526.0025 -225.395 -375.6281 -876.6003 271248.438 561048.813)" gradientUnits="userSpaceOnUse"><stop offset="0" style="stop-color:#00bbec"/><stop offset="1" style="stop-color:#2756a9"/></radialGradient><path d="M283.5 367.8c-.7.4-1.6.9-2 1.2c-.5.3-1.5.9-2.3 1.4c-2.9 1.8-10.8 6.6-17.5 10.8c-4.4 2.7-5.1 3.1-10.7 6.6c-2 1.2-4.1 2.6-4.7 2.9c-.6.4-3.2 1.9-5.7 3.5s-7 4.3-9.8 6.1c-2.9 1.8-8 4.9-11.4 7s-7.9 4.9-9.9 6.1c-2.1 1.3-4 2.5-4.2 2.7c-.4.3-18.8 11.7-28 17.4c-7 4.3-15.1 7.1-23.4 8.2c-3.9.5-11.2.5-15 0c-10.5-1.4-20.1-5.3-28.3-11.5c-3.2-2.4-9.3-8.5-11.7-11.6c-5.5-7.4-9-15.3-10.9-24.3c-.4-2.1-.8-3.8-.9-3.9c-.2-.2.1 3 .7 7c.6 4.2 1.8 10.4 3.2 15.6c10.3 40.7 39.8 73.8 79.6 89.5c11.5 4.5 23 7.4 35.6 8.8c4.7.5 18.1.7 23.1.4c22.6-1.7 42.4-8.4 62.6-21.2c1.8-1.1 5.2-3.3 7.5-4.7c2.3-1.5 5.3-3.3 6.6-4.2c1.3-.8 2.8-1.8 3.4-2.1c.6-.4 1.8-1.1 2.7-1.7s4.6-2.9 8.2-5.2l14.7-9.3l5-3.2l.2-.1l.6-.4l.3-.2l3.7-2.3l12.8-8.1c16.3-10.3 21.2-13.9 28.8-21.3c3.2-3.1 7.9-8.4 8.2-9.1c0-.1.9-1.4 1.9-2.9c4-5.9 6.7-13.2 8-21.8c.6-4 .6-13.7 0-18.1c-1.2-8.5-3.9-18.1-6.8-24.3c-4.8-10.1-15-19.2-29.7-26.6c-4.1-2-8.2-3.9-8.7-3.9c-.2 0-13.9 8.4-30.4 18.6s-30.8 19-31.8 19.7c-1 .6-2.7 1.7-3.8 2.3z" style="fill:url(#bing-b)"/><linearGradient id="bing-c" x1="145.867" x2="145.867" y1="512" y2="69.801" gradientTransform="matrix(1 0 0 -1 0 512)" gradientUnits="userSpaceOnUse"><stop offset="0" style="stop-color:#00bbec"/><stop offset="1" style="stop-color:#2756a9"/></linearGradient><path d="m86.7 318.8l.1 71l.9 4.1c2.9 12.9 7.9 22.2 16.5 30.8c4.1 4.1 7.2 6.5 11.6 9.1c9.3 5.5 19.4 8.3 30.4 8.2c11.5 0 21.5-2.9 31.8-9.2c1.7-1.1 8.5-5.2 15.1-9.3l11.9-7.4V170.4c0-49.2-.1-78.4-.2-80.7c-1-14.4-7-27.6-17.1-37.7c-3.1-3.1-5.8-5.1-13.7-10.6c-3.9-2.7-11.1-7.7-16-11c-4.9-3.4-12.9-8.9-17.8-12.3s-12-8.3-15.6-10.8C117 2 116.4 1.7 114 .8c-3-1.1-6.2-1.5-9.2-1.1c-8.8 1-15.9 7.3-17.7 16c-.3 1.3-.3 19.3-.3 116.7v115.1z" style="fill:url(#bing-c)"/></svg>',
    category: 'data',
    description_zh: '查看 Bing 搜索流量：关键词、点击/曝光/排名、各页面表现（ChatGPT/Copilot 检索基于 Bing 索引）。',
    description_en: 'View Bing search traffic — queries, clicks/impressions/position and per-page stats (ChatGPT/Copilot retrieval runs on the Bing index).',
    auth_mode: 'server_bridge',
    oauth: { provider_id: 'bing' },
    // Read-only Webmaster scope. Standalone connector (own provider on Server, NOT Google). Its
    // REST API is wrapped by a local stdio adapter (no hosted MCP server), mirroring the GSC
    // connector; the access_token is injected through BING_ACCESS_TOKEN at spawn time.
    required_oauth_scopes: ['webmaster.read'],
    transport_template: {
      kind: 'stdio',
      command: '${ORKAS_NODE}',
      args: ['${ORKAS_PC_DIR}/bin/bing-webmaster-mcp-server.cjs'],
      oauth_env_key: 'BING_ACCESS_TOKEN',
    },
  },
];

export function connectorCatalog(): CatalogEntry[] {
  return CONNECTOR_CATALOG;
}

export function findCatalogEntry(id: string): CatalogEntry | null {
  return connectorCatalog().find((e) => e.id === id) || null;
}
