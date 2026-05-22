# Connectors（MCP-based）— 方案

> 状态：草稿，按 CLAUDE.md「Plan first」流程落地后实施。
> 跨项目：仅 PC（核心改动在 main + renderer + core-agent 装配点）。
> 验收后按约定**删除本文件**。

---

## 0. 决议汇总（来自前置对话）

- **不自营 MCP server**。Orkas 客户端只做 MCP host（client），不托管任何 first-party MCP server。每个 catalog entry 指向社区/官方的 MCP server（本地 stdio 子进程或远端 URL），跑通的形态都是「Orkas 拿到 access_token → 注入到 MCP server 的 env / Authorization header → MCP server 自己代表用户调 provider API」。
- **MCP 是连接器唯一形态**。不写"原生 TS Gmail handler"，所有连接器都通过 MCP 协议接入。
- **全内置 catalog，不支持自定义安装**。所有连接器从 `features/connectors/catalog.ts::CONNECTOR_CATALOG` 这一份精选表里来；UI 没有"添加自定义 / 粘贴 URL"入口。
- **OAuth 是唯一鉴权方式**。砍掉 API-key / PAT 入口（一次性产品方向决议）。任何不能提供 OAuth 流程的服务不进 catalog。
- **OAuth 客户端在 PC 端**。PKCE + 临时 127.0.0.1 listener（§1 单点豁免），无 Server 中转。`client_id` / `client_secret` 来源：env var（Hosted Orkas 打包时注入）或 `<uid>/local/config/connector-oauth.json`（BYO）。
- **授权信息本地、不云同步**。所有 token / refresh_token / client_secret 都落 `<uid>/local/config/`（machine-private 目录，从设计上就不进 sync）。
- **加密落地**：`util/crypto-vault.ts` 走 PBKDF2 + AES-256-GCM，密钥派生 = uid + 编译期常量 salt。**保护级别：obfuscation-grade**——只挡同步泄露 / 日志泄露 / 肉眼浏览；不挡能跑 Orkas 代码的攻击者。**故意不用 keychain**（用户决议：保持 data 目录可移植、无 OS keystore 依赖）。同一 vault 同时包了 `auth-profiles.json`（模型 provider 凭据）。
- **连接器授权 ≠ 登录授权**。代码模块、存储文件、IPC namespace 全分离，不复用 `features/account/` 任何资源。
- **Phase 0 可装的内置（提供商已注册 OAuth App 后即可用）**：GitHub、Notion、Slack。**OAuth-pending（catalog 中但 MCP server 目标未选定）**：Google 套件、Microsoft 365、Discord。
- **指挥官默认全部已连接连接器可用**。智能体默认不带任何连接器，由用户在编辑页勾选。
- **新依赖**：`@modelcontextprotocol/sdk`（仅 main 端使用，client 模式）。

---

## 1. Motivation

Orkas 的指挥官 / 智能体当前能用的工具集是 `model/core-agent/` 内的固定一套（bash / write_file / kb_* / web_search / image-gen…）。要让它们使用 Gmail / Slack / Notion / GitHub / Drive 等第三方服务，**必须把工具集从静态变成可扩展的**。MCP 是为这件事设计的标准协议：

- 协议层标准化 → 一个 client 接一切 server
- 工具发现由 server 动态报告 → Orkas 不再需要为每个服务写代码
- 授权由 MCP server 维护方持有 → Orkas 公司不必去每个 provider 注册 OAuth App（除非自营 server）
- 长尾用户自定义直接复用同一条链路

最小可行形态：用户在「连接器」面板里安装/接入 MCP server，连接成功后该 server 的 tools 自动加入指挥官 / 选定智能体的可用工具集，LLM 可以像调 `bash` 一样直接调 `gmail_send`。

---

## 2. 架构总览

```
┌──────────────────────────────────────────────────────┐
│  Renderer (panel-connectors)                          │
│  - Gallery: 推荐 + 自定义入口                          │
│  - 已连接列表 + 详情 + 断开                            │
└──────────────────────────────────────────────────────┘
                  │  window.orkas.invoke('connectors.*', …)
                  ▼
┌──────────────────────────────────────────────────────┐
│  ipc/index.ts: connectors.* handlers                  │
└──────────────────────────────────────────────────────┘
                  │
                  ▼
┌──────────────────────────────────────────────────────┐
│  features/connectors/                                 │
│  ├─ types.ts         Connector / Tool / Config shapes │
│  ├─ registry.ts      <uid>/local/config/connectors.json │
│  ├─ mcp-client.ts    MCP client wrapper（stdio + http）│
│  ├─ manager.ts       lifecycle: connect / list / call │
│  ├─ tools-adapter.ts MCP tool → core-agent AgentTool  │
│  ├─ bootstrap.ts     boot + IPC binding               │
│  └─ index.ts         feature exports                  │
└──────────────────────────────────────────────────────┘
                  │  tools 装配
                  ▼
┌──────────────────────────────────────────────────────┐
│  model/core-agent/runner.ts::buildRunner()            │
│  - 第 8 步：注入 enabled connectors 的 tools          │
└──────────────────────────────────────────────────────┘
                  │  runStream({ tools })
                  ▼
       AgentRunner (in-process LLM tool-use loop)
                  │
            ┌─────┴──────────┐
            │  Commander     │
            │  Agent worker  │
            └────────────────┘
```

**spawn 边界**（§1 单 spawn 入口原则）：MCP stdio server 子进程的 `child_process.spawn` 必须**只**在 `features/connectors/mcp-client.ts` 内调用。`features/local_agents/` 依然是 5 个编码 CLI 的唯一 spawn 入口；二者职责完全分离（编码 CLI = 派发任务的 actor；MCP server = 工具提供方）。其他 features 模块要起 MCP server，必须通过 `connectors/manager.ts` 的接口，不直接 spawn。

---

## 3. 存储 layout

**单文件**：`<uid>/local/config/connectors.json`

```json
{
  "version": 1,
  "connections": {
    "gh-pat-default": {
      "id": "gh-pat-default",
      "display_name": "GitHub",
      "icon": "github",
      "transport": {
        "kind": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-github"],
        "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "<plaintext>" }
      },
      "enabled_subtools": null,
      "tools_cache": [
        { "name": "create_issue", "description": "...", "input_schema": {...} }
      ],
      "tools_cached_at": 1747200000000,
      "status": { "kind": "connected", "since": 1747200000000 },
      "created_at": "2026-05-14T...",
      "updated_at": "2026-05-14T..."
    },
    "notion-api-key": {
      "id": "notion-api-key",
      "display_name": "Notion",
      "transport": {
        "kind": "streamable-http",
        "url": "https://mcp.notion.com/mcp",
        "headers": { "Authorization": "Bearer <token>" }
      },
      ...
    }
  }
}
```

字段说明：
- `id`：连接实例 id（不是 connector 类型 id），用户可以连同一个服务的多个账号（gmail-personal + gmail-work）
- `transport`：MCP transport 描述。Phase 0 支持 `stdio` + `streamable-http`，不实现 SSE（已 deprecated）
- `enabled_subtools`：`null` = 全部启用；`string[]` = 白名单子集（上下文预算治理）
- `tools_cache` / `tools_cached_at`：list_tools 结果缓存。冷启动时先用 cache 让 UI 立即出，后台再 reconnect 拉新
- `status`：运行时态，**也持久化**（用于 UI 显示上次状态），但每次启动重新探测

**Why 单文件不分目录**：连接器不像 skill/agent 有 blob 内容（脚本 + 多个文件），只是配置 + token + tool schema 缓存。单文件 JSON 写起来事务简单，跟 `account.json` 同档。如果未来引入 marketplace-style connector packages，再拆 `<uid>/local/marketplace/connectors/<id>/`。

**敏感度**：跟 `account.json` 同档（plaintext under machine-private dir），但**这里存的是访问 MCP server 的 token，不是 provider 的 token**（provider token 由 MCP server 维护方自己存）。失效爆炸半径比 provider token 小。Phase 0 接受，Phase 1（任何 OAuth 接入之前）必上 keytar 包一层。

**path 助手**（新增到 `paths.ts`）：

```ts
export const userConnectorsConfigFile = (uid: string) =>
  path.join(userLocalConfigDir(uid), 'connectors.json');
```

---

## 4. 组件设计

### 4.1 `types.ts`

```ts
export type Transport =
  | { kind: 'stdio'; command: string; args: string[]; env?: Record<string, string>; cwd?: string }
  | { kind: 'streamable-http'; url: string; headers?: Record<string, string> };

export interface ToolSchema {
  name: string;            // 原始 MCP tool name
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ConnectorInstance {
  id: string;              // 用户连接实例 id（业务唯一）
  display_name: string;
  icon?: string;           // 内置图标 key 或 emoji
  transport: Transport;
  enabled_subtools: string[] | null;
  tools_cache: ToolSchema[];
  tools_cached_at: number;
  status: ConnectorStatus;
  created_at: string;
  updated_at: string;
}

export type ConnectorStatus =
  | { kind: 'connected'; since: number }
  | { kind: 'connecting' }
  | { kind: 'disconnected' }
  | { kind: 'error'; message: string; at: number };
```

### 4.2 `registry.ts`

纯持久化层：`load(uid)` / `save(uid, state)` / `upsert(uid, instance)` / `remove(uid, id)`。
所有写都过 `util/locks` 串行化，避免并发覆盖。

### 4.3 `mcp-client.ts`

封装 `@modelcontextprotocol/sdk` 的 `Client`，提供：

```ts
export class McpConnection {
  constructor(private readonly cfg: Transport, private readonly log: Logger) {}
  async connect(): Promise<void>;
  async listTools(): Promise<ToolSchema[]>;
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  async close(): Promise<void>;
  get isConnected(): boolean;
}
```

实现细节：
- **stdio**：用 SDK 的 `StdioClientTransport`，内部 `child_process.spawn`。**这里是连接器 spawn 子进程的唯一调用点**（§1 单入口）。
- **streamable-http**：用 SDK 的 `StreamableHTTPClientTransport`。
- 进程退出时（`before-quit`）批量 close 所有连接（参考 §5 group_chat 的清理模式）。
- spawn 失败 / list_tools 失败 / call_tool 异常 → 各自 `log.warn`/`log.error`，按 §10 logging 规范。

### 4.4 `manager.ts`

进程级单例，持有 `Map<connectorId, McpConnection>`。提供：

```ts
export async function bootstrap(uid: string): Promise<void>;             // 启动时调用：load + reconnect all
export async function listInstances(uid: string): Promise<ConnectorInstance[]>;
export async function installInstance(uid: string, cfg: NewInstanceInput): Promise<ConnectorInstance>;
export async function removeInstance(uid: string, id: string): Promise<void>;
export async function refreshTools(uid: string, id: string): Promise<ToolSchema[]>;
export async function setEnabledSubtools(uid: string, id: string, subset: string[] | null): Promise<void>;
export async function callTool(uid: string, id: string, name: string, args: Record<string, unknown>): Promise<unknown>;
export async function shutdownAll(): Promise<void>;
```

`install` 流程：写 registry → 实例化 `McpConnection` → connect → listTools → 缓存 → 返回。任一步失败回滚 registry 写入。

### 4.5 `tools-adapter.ts`

把 `ToolSchema` 映射成 core-agent 期待的 `AgentTool` shape：

```ts
export function buildConnectorAgentTools(uid: string, instances: ConnectorInstance[]): AgentTool[] {
  return instances.flatMap(inst => {
    const allowed = inst.enabled_subtools;
    return inst.tools_cache
      .filter(t => allowed === null || allowed.includes(t.name))
      .map(t => ({
        name: `${inst.id}__${t.name}`,           // 防撞前缀
        description: t.description,
        inputSchema: t.input_schema,
        execute: async (input, _ctx) => {
          const result = await callTool(uid, inst.id, t.name, input);
          return { ok: true, output: JSON.stringify(result) };
        },
      }));
  });
}
```

**Tool 命名**：`<instance_id>__<mcp_tool_name>`（双下划线分隔）。Why：MCP tool 原名可能重复（多个 server 都有 `list`），且 instance_id 本身就是用户给的（GH-personal / GH-work），二者拼起来防撞 + 用户 / LLM 阅读时能判断"哪个连接器的"。

**§3 anti-drift 妥协**：core-agent 的 `tool-catalog.ts::TOOL_CATALOG` 是静态表，MCP 工具动态无法 enumerate。处理：在 catalog 加一个 `mcp_connector` 占位条目作为类别说明，并在 catalog 头注释加上「带 `<inst>__` 前缀的工具走 connector 链路、不在本表 enumerate」。anti-drift 测试需要相应豁免前缀模式（具体改法在 §6 change list）。

### 4.6 `bootstrap.ts` + `index.ts`

- `bootstrap.ts::bootstrap()`：在 `main/index.ts` 的 `app.whenReady()` 后调用一次。读 registry → 重连所有 connections（best-effort，失败的实例 status 变 `error` 但不影响启动）。
- `before-quit` hook：调 `manager.shutdownAll()` 干净退出。
- `index.ts`：feature 公共 API re-export。

---

## 5. core-agent 集成

### 5.1 `runner.ts` 注入

在 `buildRunner()`（lines 224-322）第 7 步（caller extraTools）之后插入第 8 步：

```ts
// Step 8: connector tools (MCP-based)
const connectorTools = await loadConnectorToolsForActor({
  userId,
  agentId,           // undefined = commander
});
wrappedTools.push(...connectorTools);
```

`loadConnectorToolsForActor` 在 `features/connectors/tools-adapter.ts`：
- `agentId` 为 undefined（commander）→ 取**所有 connected 实例**的 tools
- `agentId` 存在 → 读 agent.json 的 `enabled_connectors`（见 5.2），取交集
- 任一实例 `status.kind !== 'connected'` → 跳过，写 `log.warn` 但不阻塞 buildRunner

### 5.2 `agents.ts` 字段

`Agent` interface 增加：

```ts
enabled_connectors?: string[];   // undefined = legacy（不带任何连接器）；[] = 显式空；非空 = 白名单
```

**三态语义**（对齐 §6 `skill_list` 已有约定）：
- `undefined` → **空集合**（智能体默认不带连接器）。与 `skill_list` 的「`undefined`=不过滤=全开」语义**故意不同**：连接器是用户主动赋权的能力，默认应该收紧，避免存量 agent 一升级就拿到所有连接器
- `[]` → 显式空
- `string[]` → 白名单（instance id 集合）

**为什么和 `skill_list` 语义不同**：skill 是用户预先 curate 的能力集，给 agent 多曝光风险低；connector 携带外部副作用（发邮件、改文档），保守语义更安全。这条要在 CLAUDE.md §6 同步说明。

指挥官没有 agent.json，由 `runner.ts` 内部判断 `agentId === undefined` 走「全部 connected」路径。

### 5.3 Tool descriptions 缓存稳定性

§3 提到 KV-cache 前缀稳定性。MCP tools 进 `wrappedTools` 后，pi-ai 把 description + schema 编进 tool-use API 字段，**不进 prompt 文本**——天然不破坏 prompt 前缀缓存。tool 顺序：固定按 `instances` 数组顺序 + 每个 instance 内按 `tools_cache` 顺序；`tools_cache` 写入按 MCP `list_tools` 返回顺序保持。**不要**按字母排或按使用频率排（会让 tools 数组本身飘）。

---

## 6. 变更清单（按文件）

### 新增

- `PC/src/main/features/connectors/types.ts`
- `PC/src/main/features/connectors/registry.ts`
- `PC/src/main/features/connectors/mcp-client.ts`
- `PC/src/main/features/connectors/manager.ts`
- `PC/src/main/features/connectors/tools-adapter.ts`
- `PC/src/main/features/connectors/bootstrap.ts`
- `PC/src/main/features/connectors/index.ts`
- `PC/src/renderer/modules/connectors.js`

### 改动

- `PC/package.json`
  - dependencies 加 `@modelcontextprotocol/sdk`（具体版本 install 时定）
  - §1 allow-list 注释里点名加入

- `PC/src/main/paths.ts`
  - 加 `userConnectorsConfigFile(uid)`

- `PC/src/main/index.ts`
  - `app.whenReady()` 后 `await connectors.bootstrap(uid)`（在 `account.bootstrap()` 之后）
  - `before-quit` 调 `connectors.shutdownAll()`

- `PC/src/main/ipc/index.ts`
  - 加 channels：`connectors.list` / `connectors.install` / `connectors.remove` / `connectors.refresh` / `connectors.set_enabled_subtools` / `connectors.test_connection`

- `PC/src/main/model/core-agent/runner.ts`
  - buildRunner 装配链第 8 步注入 connector tools

- `PC/src/main/model/core-agent/tool-catalog.ts`
  - 加 `mcp_connector` 占位 entry + 头注释豁免 `<inst>__` 前缀
  - 同步 anti-drift 测试豁免规则（在 `test/main/core-agent/tool-catalog.test.ts` 或对应位置）

- `PC/src/main/features/agents.ts`
  - `Agent` interface 加 `enabled_connectors?: string[]`
  - `normalizeAgent` 默认空数组
  - `updateCustomAgent` 接收该字段

- `PC/src/renderer/index.html`
  - 第 33 行后插入 `connectors-btn`
  - 第 274 行后插入 `panel-connectors` section（grid + 详情双视图，对齐 `panel-skills`）
  - 加 `<script src="modules/connectors.js"></script>`

- `PC/src/renderer/modules/boot.js`
  - `setView` 路由加 `view === 'connectors'`
  - 按钮高亮 toggle

- `PC/src/main/locales/zh.json` + `en.json`
  - `sidebar.connectors`
  - `connectors.title` / `.empty` / `.add_custom` / `.tabs.available` / `.tabs.connected` / `.detail.*` / `.errors.*`

- `PC/CLAUDE.md`（sync items 见 §8）

### **不**改动

- `OpenSource/SyncCode/strip-rules.json`：连接器无 Server 依赖，OrkasOpen 自动可用
- `features/account/*`：完全不复用账号体系
- `features/local_agents/*`：MCP server spawn 走 connectors，不混进 CLI 派发
- 任何 prompt md：连接器 tool 通过 SDK tools 字段进 LLM，不进 prompt 文本

---

## 7. IPC contract

| channel | payload | response |
|---|---|---|
| `connectors.catalog` | `{}` | `{ ok: true, catalog: CatalogEntry[] }` |
| `connectors.list` | `{}` | `{ ok: true, instances: ConnectorInstance[] }` |
| `connectors.probe` | `{ catalog_id, fields }` | `{ ok: true, tools } \| error` |
| `connectors.install_from_catalog` | `{ catalog_id, fields }` | `{ ok: true, instance } \| error` |
| `connectors.remove` | `{ id }` | `{ ok: true, removed }` |
| `connectors.refresh` | `{ id }` | `{ ok: true, tools }` |
| `connectors.set_subtools` | `{ id, subtools: string[] \| null }` | `{ ok: true, instance }` |

UI 流程：用户在 `connectors.catalog` 返回的 catalog 卡片里点「连接」→ 渲染该 entry 的 `auth_fields[]` 表单 → 可选先调 `connectors.probe` → 调 `connectors.install_from_catalog` 落地。`probe` / `install_from_catalog` 内部都走 `apply-template.ts::applyTemplate` 把字段套进 `transport_template`（含 `env_synthesizer` 钩子处理 Notion 那种 JSON 头打包的特例）。

**没有 free-form 的 install 入口** —— `manager.installInstance` 已改为模块内部 `_installInstance`，所有公开路径都过 `installFromCatalog`。

---

## 8. CLAUDE.md sync items

实施完成后在 PC/CLAUDE.md 加 / 改：

- §1 npm 依赖 allow-list：增 `@modelcontextprotocol/sdk`
- §3 spawn 边界：补一行「`features/connectors/` is the sole spawn entry point for MCP stdio servers」
- §3 tool-catalog 说明：补 `<inst>__<tool>` 前缀豁免约定
- 新增 §6.5 或扩展 §6：Connectors（连接器）—— MCP-based、`<uid>/local/config/connectors.json`、agent.enabled_connectors 三态语义、tool 命名 `<inst>__<name>` 前缀、不进 prompt（走 SDK tools 字段）、Phase 1 才上 keytar
- §9 Don't do：
  - 不在 `features/connectors/` 外 spawn MCP server
  - 不把 connector token 写进 cloud/（machine-private）
  - 不把 connector tools 注入 prompt（破坏 KV-cache）
  - 不复用 `account.*` 的 i18n / IPC namespace
- OrkasOpen：连接器不进 strip-rules（无 Server 依赖）

---

## 9. 验证路径（Phase 0 出口）

1. `npm install` 后 `./run.sh` 启动正常，无新报错
2. 侧边栏出现「连接器」tab，进入空态显示「未安装任何连接器」
3. 点「添加自定义」→ 填入 `@modelcontextprotocol/server-filesystem` stdio 配置 + 一个允许目录 → 测试连接成功 → 看到工具列表
4. 在指挥官里输入「列出 ~/Desktop 下的文件」，LLM 调用 `<inst>__list_directory` 成功，看到正确结果
5. 重启应用，连接器自动重连，工具继续可用
6. 退出应用，无 zombie 进程（`pgrep -af server-filesystem` 应该空）
7. GitHub MCP 实例（PAT 模式）：能调 `<inst>__list_repositories` 或类似 tool 拿到真实数据
8. 创建一个智能体，在编辑页勾选 GitHub 连接器→该 agent 能调，未勾选的智能体不能调

---

## 10. Phase 1+ 延后项（明确不在 Phase 0）

- **MCP authorization (OAuth) flow**：按 MCP spec 实现 Dynamic Client Registration + OAuth 2.0 + PKCE。回调走 `orkas://connectors/callback` deep link（沿用 `account/oauth_flow.ts` 的 protocol handler 模式，但**不复用代码**，新建 `features/connectors/oauth.ts`）。
- **keytar 加密**：token 包一层 AES-GCM，主密钥存 OS keychain。**OAuth 接入前必做**。
- **Marketplace 推荐列表**：从 Server 拉一个 curated 的 connectors 目录（可一键安装的 MCP server 列表），跟 marketplace skill/agent 同模式但走独立 endpoint。Phase 0 完全没有 marketplace，只有「添加自定义」。
- **Lazy tool discovery**：连接器数量上去后，暴露 meta-tool `discover_connector_tools(id, intent)` 让 LLM 按需查 tools，而不是把所有 tools 一次塞进 prompt。
- **写操作的 chat 内 confirm UI**：MCP spec 没有「读 vs 写」标注（annotations 字段是 hint），暂走「全部 auto-execute」；Phase 1 接入 MCP annotations + Orkas 现有 tool-use confirmation 通道。
- **多账号同 provider**：UI 显式支持同一服务连多个实例（gmail-personal + gmail-work），实例 id 由用户起名。Phase 0 schema 已经支持，但 UI 不重点展示。

---

## 11. 待定项 / 风险

1. **`@modelcontextprotocol/sdk` 版本兼容性**：SDK API 在快速迭代，install 时锁版本，并在 PR 描述里贴版本号。
2. **stdio server 启动开销**：每个 stdio server = 一个 Node/Python 子进程，N 个连接器 = N 个常驻进程。Phase 0 不做按需启停（首次 tool call 才 spawn），全在 bootstrap 起；用户量大时再优化。
3. **streamable-http 的健康探测**：Phase 0 不做 keepalive ping，依赖每次 callTool 的失败感知。
4. **错误传播给 LLM**：connector tool execute 失败时返回 `{ ok: false, error }`，core-agent 把 error 作为 tool result 给 LLM 看，让模型决定 retry / 切换路径。**不**把异常吃掉。
5. **Tool description 国际化**：MCP server 自己负责，Orkas 不翻译。zh 用户看到英文 description 是接受的（同 §6 skill description 早期阶段处理方式）。

---

实施按 §6 文件清单从 main 端往 renderer 推；E2E 验证按 §9 跑通后本文件删除（CLAUDE.md「Plan first」流程要求）。
