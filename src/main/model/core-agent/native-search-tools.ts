/**
 * 模型原生 web search tool 调度。
 *
 * pi-ai 的 provider.stream() 在 `buildParams` 之后调用 `options.onPayload?(params, model)`，
 * 允许返回新 params 覆盖原 params。我们借这个 hook 把厂商 server-side web_search
 * schema 追加进 `params.tools`，不改 pi-ai 源码、不 patch node_modules。
 *
 * 调度依据 pi-ai Model.api 字段（provider.stream() 传进 onPayload 的 model 参数）。
 * 单点真相：新增支持的 api / 调整厂商 tool schema 版本号都改这里一处。
 */

/**
 * 返回 pi-ai 该 api 对应的模型原生 web search tool schema；不支持时返回 undefined。
 * schema 会直接作为 entry 追加到 `params.tools`，pi-ai 不会再碰它（它只负责转换
 * `type: "function"` 那类）。
 */
export function nativeSearchToolForApi(api: string | undefined): Record<string, unknown> | undefined {
  switch (api) {
    // OpenAI Responses 系（直连 / Azure / ChatGPT Codex OAuth）统一用 **GA** 版
    //   `web_search`，不再用老的 `web_search_preview` preview 变体。
    //   - Codex 后端（2026-04-23 实测）只接 GA，preview 会报
    //     `{"detail":"Unsupported tool type: web_search_preview"}`
    //   - 直连账户 preview 和 GA 都能通，但 GA 是正式版，schema 稳定 + 有 SLA，
    //     没理由继续用 preview
    //   - Azure 没独立实测，按 API 一致性默认走 GA；若 Azure 后端早几版不认
    //     GA，再在此单独分支回退
    case 'openai-responses':
    case 'azure-openai-responses':
    case 'openai-codex-responses':
      return { type: 'web_search' };

    // Anthropic Messages 协议 —— **故意不支持**。
    //   官方 docs 里 `web_search_20250305` server tool 是真实存在的，但 Orkas
    //   catalog 下 `anthropic` provider 大部分用户走 OAuth（Claude Pro/Max 订阅
    //   或 Claude Code 登录，token 形如 `sk-ant-oat...`），pi-ai 对 OAuth 套了
    //   `claude-code-20250219` + `oauth-2025-04-20` 这套 beta header，后端按
    //   header 限权——跟 ChatGPT Codex OAuth 拒 `web_search_preview` 是同个机制，
    //   OAuth 路径大概率拒收 server tool，注入 → 整次对话 error。
    //   以"首要不能让现有对话挂掉"为原则整条剔掉。如果用户明确用直连 API key
    //   且想开原生搜索，将来再加一条 `if isOAuth ? skip : inject` 的分支。
    //
    // case 'anthropic-messages':
    //   return { type: 'web_search_20250305', name: 'web_search', max_uses: 5 };

    // Google Gemini / Vertex —— grounding with google search。不需要额外字段。
    case 'google-generative-ai':
    case 'google-vertex':
      return { google_search: {} };

    default:
      return undefined;
  }
}

/**
 * 便于在只拿到 providerId（还没拿到 pi-ai Model 对象）的地方做"会不会注入"
 * 的提前判断，主要给 client.ts 在开始流之前 push synthetic archive event 用。
 * 这个映射是 provider → 最常见的 api 约定；极少数 provider 可能例外（azure
 * openai 走 responses），但那些不在当前 catalog 里。catalog 外的 provider
 * 不在本函数里显式列，返回 undefined 由 onPayload 做最终裁决。
 */
export function nativeSearchToolForProvider(providerId: string): Record<string, unknown> | undefined {
  const api = providerApi(providerId);
  return api ? nativeSearchToolForApi(api) : undefined;
}

/** Conservative providerId → api mapping. 未列 = 未知 = 不注入。
 *  `anthropic` 虽然有 api 映射、但 `nativeSearchToolForApi('anthropic-messages')`
 *  当前返回 undefined（见上方注释），等价于不注入。 */
function providerApi(providerId: string): string | undefined {
  switch (providerId) {
    case 'openai':                   return 'openai-responses';
    case 'openai-codex':             return 'openai-codex-responses';
    case 'azure-openai-responses':   return 'azure-openai-responses';
    case 'anthropic':                return 'anthropic-messages';
    case 'google':                   return 'google-generative-ai';
    case 'google-vertex':            return 'google-vertex';
    default:                         return undefined;
  }
}

/** Human-readable 标签（日志 / archive 事件展示用）。 */
export function nativeSearchToolName(tool: Record<string, unknown> | undefined): string | undefined {
  if (!tool) return undefined;
  const t = tool['type'];
  if (typeof t === 'string') return t;
  if ('google_search' in tool) return 'google_search';
  return undefined;
}
