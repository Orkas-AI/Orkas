# 连接器扩展：飞书 / 钉钉 / 企业微信

## Motivation

对标 Google 五件套的国内场景。三家平台都没有官方 hosted MCP, 按 §6.5 既有
stdio adapter pattern 自营: 每个 service 一个 `PC/bin/<svc>-mcp-server.cjs`,
wrap vendor REST API; OAuth 走 Server 端 bridge (同 `google.py` 模式)。

## 现状关键事实

### 飞书 (Feishu)
- 标准 OAuth 2.0 Authorization Code grant; `open.feishu.cn`; refresh_token
  **会轮换** (同 GitHub / Notion) → 沿用 `manager._refreshGrantIfStale` 的
  per-instance lock, 无新约束。
- 三种 token (app / tenant / user) — 我们要 **user_access_token**, scope 在
  用户授权时挑选。
- 海外版 Lark (`open.larksuite.com`) 接口形同 host 不同; **v1 只做国内
  feishu.cn**, 海外 host 入 v2。
- 候选 services (照 Google 模式按 service 拆 entry):
  - **feishu_im** — `im:message`, `im:chat`: list_chats / get_chat /
    list_messages / send_text_message
  - **feishu_calendar** — `calendar:calendar`, `calendar:calendar.event`:
    list_calendars / list_events / get_event / create_event
  - **feishu_docs** — `docx:document`: get_document / create_document
  - **feishu_sheets** — `sheets:spreadsheet`: list_sheets / read_range /
    write_range
  - **feishu_bitable** — `bitable:app`: list_apps / list_tables /
    list_records / create_record / update_record (低代码用户量大, 主推)
  - **feishu_task** — `task:task`: list_tasks / create_task / update_task

### 钉钉 (DingTalk)
- 标准 OAuth 2.0 Authorization Code grant (用户身份); `api.dingtalk.com`
  (v2.0)。
- API 1.0 vs 2.0 严重撕裂, **v1 完全用 2.0** (`x-acs-dingtalk-access-token`
  header, 不是 Authorization Bearer)。adapter 里硬编码 header 名, 不走通用
  Bearer helper。
- 用户级 refresh_token 30d, access_token 2h, refresh 路径标准。
- 候选 services:
  - **dingtalk_todo** — `Todo.Read.Write`: list / create / update / complete
  - **dingtalk_calendar** — `Calendar.Read.Write`: list / get / create
  - 文档 / 钉盘 API 暴露面比飞书弱, v1 不做。

### 企业微信 (WeCom) — 架构 blocker
**关键问题**: 授权模型是 `corp ↔ app` (企业管理员把 App 装到本企业,
员工在企微里授权这个 App), 不是 `user ↔ app`。三条路:

1. **ISV 第三方应用** — 腾讯资质审核, 数月级 + 需企业主体, 暂无。
2. **BYO 企业应用配置** — 用户自己当企业管理员, 创建自建应用,
   把 `corpid / agentid / corpsecret` 填给 Orkas。corpsecret 是长期密钥,
   不是 OAuth token, **强冲突 §6.5「no API-key / PAT entry」**。
3. **只做扫码登录** — `snsapi_userinfo` 拿 `userid + corpid`, 后续无工具能力,
   不值得。

**v1 建议**: catalog 加 `id: wecom` 占位 entry, 标
`unavailable_reason: '需要 ISV 资质, 敬请期待'`, 不实现 OAuth + MCP。
等 ISV 资质到位单独一波。**等用户确认这个处理**。

## Components

### 1. Catalog entries — `PC/src/main/features/connectors/catalog.ts`

新增 6 (飞书) + 2 (钉钉) + 1 占位 (企微) = 9 个 entry。

```ts
{ id: 'feishu_im',
  display_name: '飞书消息',
  category: 'communication',
  description_zh: '飞书 IM: 列群组 / 读消息 / 发消息',
  description_en: 'Feishu IM: list chats / read messages / send text',
  auth_mode: 'server_bridge',
  oauth: { provider_id: 'feishu' },
  transport_template: {
    kind: 'stdio',
    command: '${ORKAS_NODE}',
    args: ['${ORKAS_PC_DIR}/bin/feishu-im-mcp-server.cjs'],
    oauth_env_key: 'FEISHU_ACCESS_TOKEN',
  },
  icon_svg: '<svg…/>' }
// 其余飞书 5 个 + 钉钉 2 个同结构, 改 id / display_name / args / env_key
{ id: 'wecom',
  display_name: '企业微信',
  category: 'communication',
  description_zh: '企业微信 (需要 ISV 资质, 敬请期待)',
  description_en: 'WeCom (requires ISV verification, coming soon)',
  auth_mode: 'server_bridge',
  oauth: { provider_id: 'wecom' },
  unavailable_reason: '需要 ISV 资质, 敬请期待',
  transport_template: null }
```

Icon SVG: 现状用 placeholder, 交付前由用户给最终 SVG 或我从 brand center
抓。沿用既有 Google 套件的简化几何风格, 不引入彩色 brand SVG。

### 2. Stdio MCP adapter scripts — `PC/bin/*.cjs`

新增 8 个 (企微不建)。每个 ~200 行, 结构同 `gmail-mcp-server.cjs`: CJS +
`@modelcontextprotocol/sdk/server/{index,stdio}` + StdioServerTransport,
token 走 env, 每个 tool fetch 对应 REST endpoint。统一约束:

- 长 list 默认 ≤50 条, 超长返回元数据 + `truncated: true`
- 写工具默认 dry-run=false, 描述里强调有 side-effect
- 错误码 → MCP tool error 解包 (复用 `gmailFetch` 同模式的小 helper)
- 钉钉 adapter 用 `x-acs-dingtalk-access-token` header (其他都是
  `Authorization: Bearer`)

#### 飞书 — 各 service 起步集 (读多写少)

| Service | Endpoint base | Tools |
|---|---|---|
| feishu_im | `/open-apis/im/v1` | list_chats, get_chat, list_messages, send_text_message |
| feishu_calendar | `/open-apis/calendar/v4` | list_calendars, list_events, get_event, create_event |
| feishu_docs | `/open-apis/docx/v1` | get_document (walk blocks → 合 textRun → plain text), create_document |
| feishu_sheets | `/open-apis/sheets/{v2,v3}` | list_sheets, read_range, write_range |
| feishu_bitable | `/open-apis/bitable/v1` | list_apps, list_tables, list_records, create_record, update_record |
| feishu_task | `/open-apis/task/v2` | list_tasks, create_task, update_task |

#### 钉钉

| Service | Endpoint base | Tools |
|---|---|---|
| dingtalk_todo | `/v1.0/todo` | list_todos, create_todo, update_todo |
| dingtalk_calendar | `/v1.0/calendar` | list_events, get_event, create_event |

### 3. OAuth provider modules — Server 端

新建 `Server/biz/connectors/oauth/{feishu,dingtalk,wecom}.py`, 实现
`start / exchange / refresh`, scope 按 `_SCOPES_BY_CATALOG_ID[catalog_id]`
选择, 照 `google.py` 既有模式。`wecom.py` v1 在 start 直接抛
`E_PROVIDER_UNAVAILABLE` (catalog 也标 unavailable_reason, 双层防护)。

环境变量:
- `ORKAS_OAUTH_FEISHU_CLIENT_ID` / `..._SECRET` (即 app_id / app_secret)
- `ORKAS_OAUTH_DINGTALK_CLIENT_ID` / `..._SECRET` (即 AppKey / AppSecret)
- `ORKAS_OAUTH_WECOM_CLIENT_ID` / `..._SECRET` (v1 留位)

### 4. apply-template.ts / manager.ts / oauth.ts / registry.ts

**不动**。占位符解析 / per-instance refresh lock / 加密存储 /
registry.update(patch) 都是通用层, 已经在 Google 套件验证过, 本批 100% 复用。

### 5. UI

- 渲染端 `connectors.js` 卡片网格自动收新 entry, **无新代码**。
- i18n: category 标签 `category.communication` / `productivity` 已有, 无新
  key。`unavailable_reason` 在 catalog 字段直接出 zh 文本 (保持现状), 不
  i18n。

### 6. 测试

按 §9 "Don't write" 准则, **不为每个 adapter 写单元测试** (外部 API mock 价值低)。
验收靠对话手测。

`PC/test/main/features/connectors/apply-template.test.ts` 现有 placeholder
fixture 覆盖通用解析, 不需改。

## Change list

**新增** (不算企微 adapter):
- `PC/bin/feishu-{im,calendar,docs,sheets,bitable,task}-mcp-server.cjs` — 6
- `PC/bin/dingtalk-{todo,calendar}-mcp-server.cjs` — 2
- `Server/biz/connectors/oauth/feishu.py` — 新
- `Server/biz/connectors/oauth/dingtalk.py` — 新
- `Server/biz/connectors/oauth/wecom.py` — 占位 (start 抛 unavailable)

**修改**:
- `PC/src/main/features/connectors/catalog.ts` — +9 entries (含 wecom 占位)
- `Server/biz/connectors/oauth/__init__.py` (或同等注册点) — 注册 3 个
  provider

**不动**:
- `PC/src/main/features/connectors/{manager,apply-template,oauth,registry,mcp-client,oauth-config}.ts`
- `PC/src/renderer/modules/connectors.js`

## CLAUDE.md sync

§6.5 当前规则已经覆盖 stdio adapter pattern / 视野 / refresh lock / 凭据
存储, 本批是按既有规则执行, **无新约束**。

Why: stdio adapter pattern 是为绕开 vendor-blocked MCP 设计的, 三家国内
厂商都属同一类 (无 hosted MCP), pattern 直接复用, 不催生新规则。

如果未来企微走 ISV 路线, 到时给 `§6.5` 加一段 "WeCom corp-bound OAuth"
专项说明 (corpid / agentid 在 OAuth flow 中的位置)。

## Open questions

1. **企微 v1 处理**: 占位 + `unavailable_reason`, 还是冒着 §6.5 冲突走
   BYO corpsecret? 我倾向占位。
2. **飞书 / 钉钉 catalog 拆分粒度**: 6+2 个细粒度 entry vs 一个
   `feishu_workspace` umbrella? 倾向拆分 (同 Google 模式), UI 可读性好且
   单 service 故障不影响别的。
3. **Icon SVG**: 现在 placeholder, 交付前你给最终 SVG 还是我去 brand
   center 抓?
4. **飞书 IM `send_text_message`**: 算 high-impact side-effect, 是否默认从
   `enabled_subtools` 排除, 用户在连接器面板里手动启用? (同样问题: 飞书
   calendar `create_event`, bitable `create_record/update_record`, 钉钉
   `create_todo/update_todo` 等)

## 验收

每个 service 在对话里跑通一条最简 read tool:

- feishu_im: "列出我的飞书群" → `list_chats`
- feishu_calendar: "今天的飞书会议" → `list_events`
- feishu_docs: "读飞书文档 :id" → `get_document`
- feishu_sheets: "读 :token 的 A1:C10" → `read_range`
- feishu_bitable: "列 :app 的 :table 前 10 条" → `list_records`
- feishu_task: "列我的飞书任务" → `list_tasks`
- dingtalk_todo: "列我的钉钉待办" → `list_todos`
- dingtalk_calendar: "今天的钉钉日程" → `list_events`

加一条 write 路径 sanity (任选一个 service 跑通 `send` / `create`)。

通过后删本计划文件。

## 工作量预估

- 8 adapter × ~200 行 ≈ 1600 行 CJS, ~6h
- 3 Python provider 模块 ~200 行 × 3 ≈ 600 行, ~2h
- catalog + scope 表 ~100 行, ~30min
- 总计 ~1.5 个工作日 (不含飞书 / 钉钉 OAuth 应用申请 + 审核等待)
