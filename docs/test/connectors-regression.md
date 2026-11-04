# Connector Regression

Use isolated local data and authorized test accounts. Deterministic fixtures establish local contracts; live provider authorization and external writes require separate test-account authority and do not follow from a passing fixture.

## Catalog, setup and recovery

- In Chinese, English, Japanese and Portuguese, search and category-filter the available catalog, open setup, and switch language while editing. Labels change; entered values, masked secrets and selected region remain unchanged. Cancellation creates no grant.
- Setup and credit badges remain compact metadata. Setup uses neutral colors; credit uses gold text, border and background. The badge stays left and the action stays right at desktop and narrow widths.
- Required inputs, credential fields, enum choices, prerequisites and callback ownership follow the catalog. Reject malformed keys, arbitrary callback destinations and hidden environment overrides before authorization.
- Custom MCP setup validates transport, headers and environment, establishes a real initialize/tools-list handshake, and exposes the connector only after successful connection. Disable, reconnect and disconnect must update actual tool availability, not only the card.
- The public API Key path uses a user-configured encrypted key and the locally held connection credential. Missing credentials require configuration or reconnect. It must not restore official-account login or subscription behavior.
- OAuth/DCR checks reject stale or replayed state, wrong device, denied consent and late completion after cancellation. Keep rotating grants in the local encrypted store; no account-side DCR storage or cross-device secret synchronization.
- A failure in one connector must not block unrelated connectors. Cancellation terminates the owned call without opening a transport circuit breaker. Distinguish remote operation failure from network/process failure.
- Log review covers warnings, retries, timeouts and cleanup. Credentials, callback codes, raw provider text and private user data must remain absent.

## eBay user-owned refund signing

1. Enter Production App ID, Cert ID and RuName with the displayed HTTPS accepted redirect URL registered for that RuName. Verify random state, exchange tokens, then verify seller privilege. Secrets must not enter plaintext registry, rendered errors or logs.
2. Optional signing private key and JWE are a pair. Reject an incomplete pair, malformed PKCS#8, non-Ed25519 keys other than RSA of at least 2048 bits, or malformed JWE. With both fields empty, retain existing-account compatibility.
3. Store signing credentials only in the device-encrypted credential file. OAuth exchange and privilege requests must never carry them. Token refresh retains them.
4. With signing configured, only issue_refund adds Signature, Signature-Input, Content-Digest and x-ebay-signature-key. Verify the signature independently against the actual UTF-8 body, method, encoded path and authority. Ordinary reads remain unsigned. Invalid keys prevent the refund request.
5. Seller domicile and selected marketplace are distinct. Keep existing environment/marketplace binding and operation-level approval. Test fixtures must reject malformed credentials and unauthorized writes without side effects. A real refund is outside deterministic verification and requires explicit test-store authorization.

## Shared runtime and manual canaries

- Packaged connector entrypoints must initialize without source-tree dependencies in both direct and explicit-proxy modes. Missing SDK, proxy-only dependency, or newly imported helper must fail before release.
- Official CLI connectors use managed per-connector installations, bounded authentication and cleanup. A stale remote record cannot manufacture a local installation. Invalid auth stays unavailable; a successful retry restores tools.
- Seller APIs preserve shop identity, environment and risk lanes. Unknown actions, arbitrary URLs/headers, credential-shaped arguments, oversized writes and partial failures must not become successful receipts.
- For each available provider, use its own approved test account for a safe read, denied permission, revoked grant and successful reconnect. A reversible write additionally requires explicit authorization and readback; preserve and restore the original value.
- Inspect local registry and encrypted grants after restart and disconnect. Disconnected/disabled tools stay absent from both discovery and execution, including external CLI access through the governed bridge.

## Owning evidence

Run the existing connector catalog, local API, direct-commerce adapter, manager, registry, OAuth and renderer suites through `npm run test:js`. Run `npm run test:e2e:typecheck` before `npm run test:e2e -- test/e2e/connectors_e2e_validation.spec.ts`. These checks use local fixtures and do not claim all remote services are currently reachable.

## 自动化覆盖

- **单元/集成测试**覆盖连接器可见性、子工具过滤、Google Workspace 去重、参数规范化、协议级/异常级错误传播、超时、取消、熔断、OAuth 恢复、密钥隔离、启动生命周期、并发连接及账号切换时的运行时所有权。
- MCP startup and initialization share a 30s default for both stdio and HTTP; the SDK
  initialization request receives the configured budget. Tool discovery retains 30s.
  Every tool call has a fixed 600s deadline; progress does not reset it. Composio long-call
  adapters opt into a 580s Server budget, wait 590s locally, and use the shared 600s MCP bound.
  Server sends JSON whitespace every 15s to keep HTTP proxies alive; terminal code/error
  envelopes remain authoritative after streaming headers. Old clients retain 35s/90s budgets
  and normal HTTP statuses. Completed Server failures return MCP `isError` without degrading
  the transport; no-response failures retain transport recovery without automatic action replay.
  Invalid actions return only the bounded, enabled action names through `manager.callTool`.
- **安装包黑盒门禁**不借用源码 `node_modules`：在 `afterPack`、签名前和发布产物复检时，
  从 `app.asar.unpacked` 分别以 direct / explicit-proxy 两种路由启动每个已发布的本地
  连接器入口，并完成真实 MCP `initialize` 握手。Gmail 等 Composio 连接器和
  Bing/Discord/Search Console 均须返回合法 server info + tools capability；缺 SDK、
  proxy-only 依赖、未来新 import 或 stdout 协议污染都必须阻断构建。
- `apply-template.test.ts` 直接证明 OAuth grant 只进入声明的
  stdio env / 合成 JSON header / HTTP Bearer header，app-owned adapter
  placeholder 正确展开，普通第三方进程不会继承 Electron 专用变量，且空 token、
  模糊映射、危险 key 和未知 placeholder 在启动前失败。
- **E2E** `test/e2e/connectors_e2e_validation.spec.ts` 覆盖连接器页加载、自定义 MCP 表单校验、本地 stdio MCP 真实握手、聊天中的工具发现与调用、Renderer 密钥隔离，以及停用后模型工具表/system prompt 均不再暴露该连接器、重新启用和断开。Composer 资源选择器同时覆盖 Connector 页签。
- **Benchmark** 使用 Commander benchmark 的 `cmd-connector-slack`、`cmd-connector-unavailable`、`cmd-connector-tool-error`，评估模型是否遵循 discover-before-call、是否诚实处理缺失连接器、是否把 MCP `isError` 保持为失败。静态 preflight 只校验数据集和 prompt 契约，模型效果必须由定向 dynamic benchmark 评估。
- **人工回归**负责真实 OAuth/DCR、第三方权限、跨设备 token 刷新和外部服务写入回滚等无法在本地 fixture 稳定证明的行为。

## 国内官方 CLI 连接器

WeCom, the unified Feishu/Lark entry, DingTalk and Xero use an official CLI
through the governed stdio adapter. Installation, authorization, connection
records, status, tool caches, tool selection and enable decisions belong to the
current account on the current device. Catalog cards remain available on every
device; connecting, disabling or disconnecting one PC must not change another.

Device-storage acceptance (`device-local.test.ts`,
`device-local-upgrade.test.ts`, `sync/engine-device-connectors.test.ts`,
`connectors-render-cache.test.ts`):

- Exercise first pull, remote overwrite, concurrent merge and legacy upload with
  two device stores. Cloud bytes and item clocks contain no local CLI ids; ordinary
  connector rows and toggles retain their existing sync behavior.
- On upgrade, preserve prior local CLI installations and re-verify their status.
  A cloud row alone does not create a local connection. Existing local installations
  remain discoverable even if another upgraded PC already removed their cloud rows.
- Inject a local migration write failure: leave cloud source data intact and retry
  safely. Preserve unreadable local files; never replace them with remote state.
- Disconnect, restart and replay stale cloud data: the CLI connection must not
  reappear. Keep CLI credential files untouched during migration. Clear pre-migration
  renderer caches so imported success states cannot appear on first paint.
- Sync data version 7 prevents older clients from writing device state back into
  the account registry. Real-account installation and authorization on macOS and
  Windows remain manual checks; deterministic storage tests do not prove live consent.

Upgrade card scenarios use the real migration, connector manager and renderer;
only the external MCP process and bundled executable locations are stubbed:

| Starting state | Expected upgrade and recovery outcome |
| --- | --- |
| A foreign error or connected cloud row; no local installation | Show an available Connect card without an error or Use action; do not launch a CLI. Restart preserves this state. |
| Local installation with valid authorization and an inherited cloud error | Clear the inherited error, remain unavailable while verification is pending, then expose Use only after verification succeeds. Preserve local tool selection and provider files across restart and account switching. |
| Local installation whose authorization is rejected | Show the real local failure and Connect action; keep it out of cloud storage. Successful authorization and rechecking clear the error. |

For the release canary, use two test-device workspaces (macOS and Windows) with
the same test account: authorize Feishu on A, sync the old build to uninstalled B,
then upgrade both. Verify B shows Connect without the inherited error and A can
perform an authorized read. Connect B independently, then disconnect it and
confirm A still works. Revoke A's
authorization and confirm the next check shows an actionable failure; reconnect
and verify the read succeeds. Inspect both device logs for unexpected retries or
CLI processes left running. This canary is not covered by mocked MCP success.

自动化必须覆盖：

1. 四个内置 catalog entry（含隐藏的旧版 `lark` 兼容项）使用经过来源 URL 和 SHA-256 校验的真实品牌 SVG；飞书/Lark 在新连接列表中只能显示一张卡片，不得再显示区域、版本、Production 或 Sandbox 选择器。
2. 中文界面显示“企业微信 / 飞书 / 钉钉”，英文、日文、葡萄牙文等所有非中文界面显示“WeCom / Lark / DingTalk”；官方 CLI 根据扫码账号返回的 tenant brand 自动选择中国或海外端点，旧版创建的独立 Lark 实例仍归入统一卡片。列表、资源选择器、使用动作、断开确认和授权终端标题必须一致。
3. 点击依赖 CLI 的连接器时，先检测当前账号、设备和 catalog id 对应的 Orkas 隔离目录；不得把系统 PATH 中任意同名 CLI 当作已安装。缺失时必须在下载前询问用户，确认后按钮显示“安装中”，失败时卡片保留本地化原因并提供“重试安装”，且不能继续打开账号授权。
4. 安装只允许写入该连接器自己的 npm cache，并校验固定包名、版本、官方 registry integrity、package.json 和 executable 文件。安装完成后，账号授权、schema 发现、业务执行和 logout 一律使用 npm offline 模式；任何隐式重新下载或全局安装都应失败测试。
5. 首次授权以直接 argv 启动已经安装的固定版本官方 npm 包，退出后必须重新检查官方 auth status；取消、失败或未登录不能保存为已连接。缺少精确受管安装时，主进程也必须拒绝授权，不能只依赖 Renderer 检查。
6. Feishu/Lark authorization opens only structurally validated HTTPS URLs on exact official hosts and authorization routes; provider prose never decides completion. Explicit Connect/Reauthorize requests the complete reviewed domains/scopes, including sending, even if an old or newly initialized identity verifies. Compare actual grants with the pinned full permission contract after consent and on Connectors-page entry/manual refresh, preserving API alternatives and exact shortcut requirements. CLI cards do not display missing-permission notices or an inline Reauthorize button. The three-dot menu always offers Reauthorize for connected or degraded CLI instances, including those without recorded deficiencies and disabled instances; Use remains available for enabled connected instances. Clicking directly enters the official flow, without an Orkas administrator pre-prompt or a cached enterprise block. A verified partial identity remains usable; cancellation cannot masquerade as completion from an old token. DingTalk requests the reviewed full-domain PAT batch once with JSON output, forwarding the same execution for consent and receipt capture. The pinned CLI API error PAT_BATCH_PRODUCT_NOT_FOUND may retain a freshly reverified partial identity on first connection, with plan_missing preserved; no test-organization domain subset or full grant is inferred. Cancellation, network/unknown failures, look-alike output and unresolved explicit scope/identity recovery still fail authorization. Available operations remain usable across a denied operation and adapter restart without login or replay. Only an authoritative remote plan can clear PAT gaps; local dry-run previews remain unavailable evidence, and identity/PAT success cannot clear independent OAuth gaps. WeCom keeps native robot binding and remote identity verification; no user OAuth scope or complete business-grant list is invented. Resource/recipient-only or unclassified business-access failures stay with the task and do not create card completeness warnings. Unavailable reports retain known evidence, newer denials remain recoverable, selected tools and other usable capabilities stay available, and no failed business action is replayed. Repeated page checks coalesce for one minute; authorization/manual refresh recheck, disconnect/account switch cancel, and no startup/timer scan is added.
7. Isolate the account, device and catalog id. New Feishu/Lark connections use the unified profile; the hidden legacy `lark` id remains compatible. Disconnect waits asynchronously for provider logout, removes only the owned runtime directory and device connection record, and leaves other devices unchanged. Installation/logout timeouts terminate the full managed process tree. Unknown account-scoped connector ids remain preserved by older readers; local CLI records never enter the synced registry.
8. stdio 适配层只暴露 `list_capabilities`、`describe_action`、`execute_read`、`execute_write`、`execute_high_impact` 和 `execute_destructive`。能力发现必须从受审业务根逐级读取官方 schema，执行前再次读取 exact leaf schema。
9. auth/config/profile/schema/plugin/extension、原始 API、应用开发/发布和任意命令执行入口永久拒绝；固定域清单、包名、版本和 integrity 任一漂移都应在进程调用前失败。
10. schema 元数据和 action 动词采用最高风险合并，删除、发送、审批、共享、发布等动作不能被较低 `effect` 降级。W/H/D 必须进入对应主机确认通道，钉钉的 `--yes` 只能在确认后的非读取执行中加入。
11. Reject credentials, config/profile overrides, output paths, raw flags, excess parameters, outside files and symlink escapes. Approved local inputs must exist as absolute paths with a realpath inside Orkas-approved roots. Identify file carriers from the pinned provider parameter contract, preserving literal text and file arrays. Prepare private, per-call copies for CLI uploads and declared @file inputs, preserving bytes and filenames; serialize Lark native binary carriers as key=value and preserve WeCom media_id objects. Clean staging after success, failure or cancellation, and reject changed/non-regular sources before sending. Preserve Xero full-JSON destructive-status inspection. Use a ten-minute execution deadline for ordinary commands and transfers including staging; the host also bounds the entire call at 600s, including schema inspection. Transfer heartbeats do not extend that deadline. Cancellation must stop descendant processes and must not replay an operation. Network file inputs require HTTPS; bound and sanitize provider output.
12. MCP 取消、连接关闭和宿主结束必须传到正在执行的官方 CLI；授权检查、schema 检查和业务调用之间不得丢失取消状态。真实适配层回归应证明：等待 schema 时取消或断开后不再执行写操作，正常请求仍可完成；子进程超时、stdout/stderr 超限和非零退出均应有界结束且不泄露原始输出。

### Partial-permission acceptance matrix

The oracle is usable granted operations plus accurate recovery state, not merely
a successful login or a green transport. Exercise these journeys independently:

| Journey / initial state | Stimulus and required observation | Owning evidence |
| --- | --- | --- |
| First connection, verified identity with partial business access | Keep Use on the card and Reauthorize in the three-dot menu; an unverified/expired identity cannot establish a new connection. | `manager.test.ts`, `local-cli-files.test.ts`, `connectors-degraded-card.test.ts` |
| Connected account, one operation denied | Preserve the failed operation's error, expose only validated scope identifiers, then complete a different granted read on the same connection; no login or replay. Cover Feishu user/bot, DingTalk OAuth/PAT/admin, WeCom and Xero. | `local-cli-files.test.ts`, `manager.test.ts`, `local-cli_e2e_permissions.test.ts`, `local-cli_e2e_attachment.test.ts` |
| Error-shaped business data or unavailable provider | Success payloads, nested permission text, local-file errors, malformed JSON and timeouts must not manufacture a permission request. | `local-cli-files.test.ts` |
| Lark full consent and proactive comparison | Full domain/scope request retains old grants. Compare declared requirements before business failure; accept actual partial completion while retaining missing permissions. Cancellation/malformed receipts cannot reuse an old identity as completion. Preserve unrelated evidence and newer denials without replay. | `local-cli-files.test.ts` |
| DingTalk PAT incremental consent | Cover new/already-granted receipts, partial grants followed by retry, malformed/failed receipts, case-sensitive identifiers, mixed OAuth/PAT and changed administrator policy. Only acknowledged PAT scopes disappear. | `local-cli-files.test.ts` |
| WeCom or DingTalk identity-only login | Do not equate identity success with business access. Preserve the existing connection and internal permission evidence after cancellation or unverifiable recovery. | `local-cli-files.test.ts`, `manager.test.ts` |
| Concurrent recovery and device-local persistence | An old check/grant cannot clear a newer denial, including the same scope denied again; profiles and providers remain isolated. Malformed/oversized/symlink state and failed writes do not leak or replace provider errors. | `local-cli-files.test.ts`, `local-cli.test.ts` |
| Page entry, refresh, account switch | Listing is read-only; page checks coalesce for one minute; explicit refresh/consent completion rechecks. Switching accounts/disconnecting aborts pending checks. No startup/timer login. | `local-cli.test.ts`, `ipc/connectors.test.ts`, `connectors-render-cache.test.ts` |
| Card action and recovery | Use stays available on enabled connected cards. Missing-permission notices and inline Reauthorize are absent for empty, small and large deficiencies. Connected/degraded CLI cards always offer Reauthorize in the three-dot menu, independently of deficiencies or enabled state; clicking closes the menu and enters the existing protected flow without disconnecting or changing enablement. Actual connection errors retain their normal recovery. Only authoritative matching recovery removes internal deficiencies; selected tools remain. | `connectors-degraded-card.test.ts`, `manager.test.ts` |

Real-account canaries (macOS and Windows) remain required for each provider:
start with verified identity plus one denied capability; perform one allowed read,
cancel reauthorization, repeat the allowed read, then grant the capability and
explicitly retry the denied operation once. Verify old grants and tool selections
survive, other accounts/devices are untouched, and inspect logs for duplicate
operations, unexpected browsers, sensitive output and leftover CLI processes.
Use test recipients and reversible writes only. Repeat administrator/visibility
denials before and after the administrator changes access; never report a user
login alone as proof of that change.

DingTalk OAuth incremental consent is an **open implementation and acceptance
gap**: require a real scope-bearing request, provider-confirmed union of old/new
grants, cancellation/partial-consent recovery, and a successful explicit operation
retry. The pinned DWS 1.0.61 identity login does not implement that request; its separate full-domain PAT batch route is now used for initial business grants and reauthorization. Local identity
fixtures and PAT grant tests do not satisfy this gate. WeCom business-permission
verification likewise needs provider evidence beyond `identity whoami`.

The 2026-10-29 pinned-DWS live check verified identity and an MCP
`contact.user.get-self` read, but initial full-domain PAT authorization remains
an **open acceptance gap**: the test organization rejects `hrbrain`, `recruit`
and `whiteboard` with `PAT_BATCH_PRODUCT_NOT_FOUND`. Its other 18 domains pass
the remote plan stage; no grant was issued by those diagnostic plan calls.
Do not extrapolate that organization-specific domain set to other accounts.
The pinned CLI's `pat chmod --dry-run --format json` emits a local
`dry_run/request` preview, not a remote `allGranted` receipt. Preserve existing
permission evidence when a check returns that preview, including a preview with
success-shaped extra fields (`local-cli-files.test.ts`). Connecting available
capabilities while retaining unsupported-domain gaps was confirmed by the requester
on 2026-11-02 and implemented by `5b353084be` / `3c94665478`.

The 2026-11-02 live canary on source `0e8e24e238` exercised the current
authorization driver with the pinned native CLI and the dedicated test account.
The full 21-domain request returned the exact structured PAT/API
`PAT_BATCH_PRODUCT_NOT_FOUND` error; the driver exited 0 after identity
revalidation and persisted `plan_missing`. A fresh native `auth status` reported
authenticated. Two separate production `McpConnection`/stdio-adapter sessions
each discovered six tools, classified `contact.user.get-self` as read-only and
completed that read with provider success and one result. Both sessions closed;
the permission gap survived reconnection and successful reads. A separate
check-only invocation rejected the local preview (expected exit 1) without
clearing that gap. Repeat this sequence in an isolated workspace when changing
the initial partial-connection contract; never use a local preview as its grant
oracle or replay a business operation to recover authorization.

This is live macOS source-driver/adapter evidence, not installed-GUI connection
creation, Windows, full-domain grants, incremental OAuth consent, cancellation
or production-release acceptance. The supplier log retained two reviewed
warnings: the asserted PAT template error and an audit-actor lookup of an absent
legacy data file. Main emitted four INFO records and no warnings/errors.
Provider stderr is drained by `McpConnection`, and earlier npm debug files
rotated; complete internal-stream archival is therefore not established.
Neither a successful identity nor a local preview closes full-grant acceptance.

本轮问题挖掘发现并固定了这些缺陷：

- MCP 可以不抛异常而返回 `{ isError: true }`；旧链路会把它记录并交给模型为成功数据。现在工具结果和埋点都必须保持失败语义。
- A former 45s Composio adapter deadline could expire before Server completed an action and
  settled usage. Long-call clients now use ordered 580s/590s/600s budgets with HTTP keepalives;
  released clients keep their shorter Server budgets. Stable Server errors remain operation-level
  MCP `isError`; invalid actions still return the filtered action names for recovery.
- 降级连接器的远端错误原文曾直接进入 system prompt。现在只注入 host 固定的未验证提示，远端错误保留为普通工具数据，不能提升为系统指令。
- transport template 同时声明 `oauth_env_key` 与 `env_synthesizer` 时曾静默选择后者；
  全空白 access token、危险对象元键或非法 HTTP header 名也能进入启动阶段。现在这些
  配置在 token 接触子进程/网络前被稳定拒绝，避免凭据进入错误通道或形成跨平台差异。
- live connection、Composio grant、refresh lock 和首次连接 lock 曾只按 connector id
  缓存；两个账号连接同名服务时，后切换的账号可能复用前一账号的 MCP transport，
  切换过程中尚未完成的旧连接也可能在切换后重新发布。现在所有运行时资源按
  `uid + connector id` 隔离，账号切换先同步摘除敏感状态并递增 epoch，再异步关闭
  transport；旧 epoch 的迟到连接必须以 `E_CONNECTOR_ACCOUNT_CHANGED` 失败，不能进入
  新账号工具调用路径。恢复授权、断开、积分预检、交互授权和批量验证必须从业务入口
  保留同一 epoch，异步等待结束后不能读取新账号凭据或继续旧账号调用；已发起刷新
  得到的旋转 token 仍写回原账号，不能因为切换而丢失。启动入口也必须按 uid 去重，
  不能永久绑定首次启动账号。
- 1.6.2 的源码级 Composio adapter 测试直接从仓库加载入口，开发机完整的
  `node_modules` 掩盖了安装包缺少 MCP SDK 的事实；原产物 gate 又只验证人工登记的文件，
  没有执行连接器。现在受控反例会分别删除 SDK、删除仅代理分支加载的 `undici`、注入一个
  未登记的新依赖，证明黑盒握手能在发布前稳定变红，避免“文件清单绿、安装包不可用”。
- 连接器面板和工具遥测曾把任意“积分不足”/`not enough credits` 文案归为 Orkas 积分，
  第三方 OAuth、MCP 或自定义连接器因此可能误开购买弹窗并污染 credits 分类。现在只有
  声明 `usage_metering.provider=composio` 的受管调用携带结构化
  `orkas_credits_quota_exceeded` 时才成立；message-only 402 和相同文案一律按普通第三方
  错误处理。Server 保留旧 PC 使用的本地化 `msg`/`message`，新版主进程同时把嵌套
  `error.code` 原样带过 IPC，不再根据 HTTP 状态合成计费码。
- 该边界是确定性凭据映射，不新增模型 benchmark；现有 Commander connector
  benchmark 继续评估模型的 discover/call/失败解释，Electron connector E2E 继续证明
  真实 stdio 握手、启停与聊天调用。

## 自动化覆盖

`test/e2e/connectors_e2e_validation.spec.ts` 已覆盖连接器页加载、自定义 MCP 表单校验、本地 stdio MCP 真实握手与工具发现、Renderer 密钥隔离、启停和断开；Composer 资源选择器同时覆盖 Connector 页签。真实 OAuth/DCR 和外部第三方工具调用仍只在专用测试账号中回归。

## 回归准备

1. 准备一个测试账号，至少有 GitHub、Google、Notion、Linear、Cloudflare、Stripe、Supabase、Close、Webflow、Slack、Discord 几类服务的测试授权资格。
2. 准备两个独立 PC 数据目录或两台设备，用于验证连接器配置云同步、GitHub server-managed grant 和多设备行为。
3. GitHub 测试账号下准备一个可安装 Orkas GitHub App 的个人账号或组织，并准备至少一个私有仓库、一个 issue、一个 PR。
4. Google 测试账号下准备 Gmail、Calendar、Docs、Sheets、Tasks 测试数据；Sheets 需准备一个已存在表格用于 Picker 授权。
   - 验证 Google Search Console 还需：该账号在 GSC 拥有至少一个已验证资源（URL 前缀或 `sc-domain:` 域名属性，含一段时间真实搜索数据 + 已提交 sitemap），且 Server 端 Google OAuth client 的同意屏已批准 `webmasters.readonly` scope（否则授权会缺该权限）。
5. Bing Webmaster Tools 测试账号下准备至少一个已验证站点，并使用目录显示的已注册 HTTPS 回调地址。
6. Notion 准备一个可授权的 workspace，Linear 准备一个可授权的 workspace（含测试 team / project / issue），Webflow 准备一个可授权 workspace/site（含测试 CMS collection/item 或测试页面），Slack 准备一个可安装测试 app / MCP 授权的 workspace，Discord 准备一个可安装 Orkas Bot 的测试 server 和账号。
7. 回归前记录当前 PC 语言、登录 uid、device_id、`connectors.json` 是否存在，以及 GitHub App 在 GitHub 设置页的 installed / authorized 状态。

## 连接器列表与基础 UI

1. 打开连接器页，应展示 GitHub、Notion、Linear、Cloudflare、Stripe、Supabase、Close、Webflow、Slack、Discord、Google Workspace、Gmail、Google Calendar、Google Docs、Google Sheets、Google Tasks、Google Search Console（GSC 为独立连接器，不属于 Workspace 套件）。
2. Unconnected connectors appear under Available with Agent-style category chips ordered for connectors: All, E-commerce, Office, R&D, Creation, Data, Education, General. General contains cross-domain payments, mail, file storage, messaging, and utilities; Office contains documents/spreadsheets, schedules/meetings, enterprise collaboration, CRM, general marketing, and accounting. Storefronts, merchandise, fulfillment, and store-specific marketing remain E-commerce. In the managed OAuth expansion, Omnisend is E-commerce; Asana, Fathom, and Miro are Office; Figma and WakaTime are R&D; Canva and YouTube are Creation; BigQuery is Data; Classroom is Education; Dropbox, Typeform, and Exist are General. Show only categories represented by visible available cards; selecting a category filters that section and updates its count. Search narrows both groups and the available categories. When a search or successful connection removes the selected category's last card, return to All. Connected cards move to Connected with their account label; disconnecting restores their available category. Category labels follow all four UI languages, and explicit connector navigation clears browse filters.
3. 已连接卡片应显示启用/停用按钮和右上角更多菜单；未连接卡片只显示连接按钮。
4. 错误状态的 GitHub 卡片应显示连接按钮，不要求用户先断开再连接。
5. 点击断开应出现二次确认；取消时连接器状态不变，确认后本地实例删除并回到可用分组。
6. 停用已连接连接器后，卡片应呈禁用视觉状态，LLM 不应再看到该连接器；再次启用后恢复可见。
7. 切换中英文界面后，连接器名称、描述、错误提示和按钮文案应跟随语言刷新。
8. 服务端 catalog 的 `requires_credits: true` 应显示金色“积分”描边标签，显式 `false` 或字段缺失应隐藏；金色文字、描边和浅金底色应与普通主题色标签有明显区别。所有带 `usage_metering` 的连接器在连接前均应执行积分预检。
   正式额度耗尽响应必须同时保留旧 PC 可显示的本地化 `msg`/`message` 和新版消费的
   `error.code=orkas_credits_quota_exceeded`。相同文案但缺码、码只出现在 message 中、
   或非受管连接器返回保留码时，都不得打开 Orkas 积分购买引导。
9. Clicking Connect immediately shows loading and `aria-busy`. Browser OAuth, including custom MCP, blocks duplicate clicks for two seconds; after that, loading remains while the user can restart authorization. Switching windows never clears loading. Official local-CLI connectors continue to reuse their unfinished main-process attempt and recover through the interactive terminal. Once an authorization callback arrives, Connect stays disabled until exchange and initialization finish. Success, failure, cancellation, or the existing ten-minute authorization expiry clears loading; expiry restores Connect without an alert or a failed-connection metric. Request timeouts also avoid alerts. Older callbacks and results must not replace or clear a newer attempt's loading.
10. 页头搜索应实时匹配连接器 ID、中英文名称及中英文描述；搜索隐藏的套件成员（例如 Gmail）时应显示其所属产品卡。无结果时显示搜索空态，清空搜索后恢复原有“已连接 / 可用”分组和 A-Z 排序。
11. 需要账号域名、环境、Client ID、Secret 等多个值的连接器，点击连接后应在同一个配置面板一次展示全部字段和准备说明；必填项由表单统一拦截，choice 必须显式选择，secret 必须使用密码框。取消时不得发起连接，确认时只发送一次包含全部字段的 `connection_parameters`。

## 启动恢复与持久化性能

1. 准备 6 个以上已连接实例后重启：同时进行的 MCP connect/list_tools 不得超过 3 个，其他实例应排队且最终全部恢复。
2. 一轮 bootstrap 的 status/tools_cache 结果应合并后只写一次 `connectors.json`；不应每恢复一张卡片就重写整个文件。
3. 仅修改 status、tools_cache、enabled_subtools 或时间戳时，各实例的 `secrets_enc` 密文应保持字节不变，不应重复调用密钥后端。
4. OAuth/DCR token 真实刷新或 transport 中的 access token 变化时，新 secret 必须立即单独持久化，不得为了合并 status 写入而延迟或丢失旋转 token。
5. bootstrap 期间某个连接器失败时，其错误状态与其他成功实例的工具缓存应在同一次合并写中正确保存。

## 安装包运行时

1. `app.asar.unpacked/bin` 中每个已发布入口必须在隔离模块路径下完成 MCP initialize；测试进程不得通过 `NODE_PATH`、`NODE_OPTIONS` 或仓库根 `node_modules` 补齐缺失依赖。
2. direct 与 explicit-proxy 两种启动模式都必须执行。只跑 direct 不足以证明 `proxy-bootstrap.cjs` 的 `undici` 分支可用。
3. 删除 `@modelcontextprotocol/sdk` 应复现 1.6.2 的 `MODULE_NOT_FOUND` 并阻断签名；删除 `undici` 应只在跑到代理模式时阻断；给 Composio adapter 增加未登记 import 也必须在黑盒启动时阻断，而不是等人工更新依赖清单。
4. 对 macOS arm64/x64 与 Windows x64 候选产物重复执行同一门禁；跨平台构建时仍用构建机 Node 验证纯 JS 模块闭包，不能以目标二进制当前不可执行为理由跳过。
5. 签名候选安装后至少真实连接一次 Gmail，刷新工具并执行一条只读调用；这一步负责 OAuth、账号和远端服务闭环，不能替代上述确定性的离线产物门禁。

## GitHub

1. 从未安装 Orkas GitHub App 的账号点击 GitHub 连接，应进入 GitHub App install 页面，并能选择账号/组织与仓库。
2. 初次安装并授权完成后，PC 应显示 GitHub 已连接，账号 label 正确，工具列表可刷新。
3. 初次授权后，使用连接器读取仓库、issue、PR、文件和代码搜索，应只访问 GitHub App installation 已选择的仓库。
4. 本地点击断开，但不在 GitHub 卸载 App，再次点击连接，应走 GitHub user authorization，不应停留在“已安装但没有授权按钮”的页面。
5. 再次授权成功后，GitHub connector 功能应与初次 install 后一致，不应出现 repo / issue / PR 功能缺失。
6. 本地存在二次授权 hint，但用户已在 GitHub 卸载 App 时，再次连接应自动回落到 install app 页面。
7. 如果 install 后仍未产生 installation，PC 不应保存坏 token，应显示授权失败或可恢复错误。
8. 在 GitHub 设置页撤销 Authorized GitHub App 后，本地重新连接应能恢复 token，不要求用户手动 uninstall。
9. 在 GitHub 设置页卸载 Installed GitHub App 后，本地重新连接应要求重新安装/选择仓库。
10. 等待 access token 过期或手动构造过期状态后，刷新工具或调用工具应通过 Server 刷新 token，不应因为多设备 refresh token 轮换导致连接器永久异常。
11. 两台设备同时使用同一 GitHub 连接器时，A 设备刷新后 B 设备仍应能通过 server grant 获取新 access token。
12. GitHub MCP 返回 unauthorized / AuthenticateToken 时，PC 应强制刷新 server grant 并重试一次；成功后卡片恢复 connected。

## Google Workspace 与单服务连接器

1. 连接 Google Workspace 时，授权页应请求 Gmail、Calendar、Docs、Sheets drive.file、Tasks 的并集权限。
2. 分别连接 Gmail、Calendar、Docs、Sheets、Tasks 时，只应请求对应服务的最小权限和 openid/email 账号信息权限。
3. 用户在 Google 授权页取消某个必需 scope 时，连接应失败并提示需要选择全部必需权限，本地不保留不可用连接。
4. Google Workspace 与单服务连接器可同时存在；当 Gmail 等单服务已连接时，LLM 可见工具中不应重复暴露 Workspace 中同名服务工具。
5. 连接 Google Sheets 后，通过更多菜单选择“Select spreadsheet”，应打开 Google Picker 并能选择已有表格。
6. Sheets Picker 授权成功后，应保留原来的 refresh token 与账号 label，并返回所选 file id。
7. Sheets 只授权 `drive.file` 后，应能访问用户通过 Picker 选中的表格；未选中的表格不应被误访问。
8. Google refresh 失败、scope 缺失或 access token 过期且无 refresh token 时，旧连接应从列表移除或进入可恢复状态，不应继续向 LLM 暴露。

## Google Search Console

1. 列表中应出现独立的 “Google Search Console”，且不随 Google Workspace 套件一起连接/断开（两者无状态联动）。
2. 点击连接，授权页应只请求 `webmasters.readonly` + openid/email 账号信息，不应请求 Gmail/Calendar/Docs/Sheets/Tasks 等其他 Google 权限。
3. 用户在 Google 授权页未勾选 Search Console 权限时，连接应失败并提示需要必需权限，本地不保留不可用连接。
4. 用 GSC 资源拥有者账号授权成功后，应显示已连接 + 账号 label；`list_sites` 应返回该账号拥有的资源（含 `sc-domain:` 与 URL 前缀两类的 siteUrl 与 permissionLevel）。
5. `query_search_analytics` 默认拉最近 28 天、按 query 维度，应返回 clicks/impressions/ctr/position；指定 dimensions=page/date、加 dimensionFilter、改 rowLimit 应生效；GSC 数据有约 2–3 天延迟属正常，不应当作错误。
6. `list_sitemaps` 应返回已提交 sitemap 的状态（lastSubmitted/lastDownloaded/errors/warnings）；`inspect_url` 对本资源下的某 URL 应返回收录判定（verdict / coverageState / robotsTxtState / google 与 user canonical / lastCrawlTime）。
7. 连接器为只读：不应出现任何写操作；对非本账号拥有的资源调用应返回可读的 403/权限错误而非崩溃或泄露。
8. 停用/断开后 LLM 不应再看到 GSC 工具；access token 过期时应经 Server 刷新（Google 不轮换 refresh token，原 refresh token 应持续可用）。
9. 回归同时确认 catalog id 为 `gsearch-console`（连字符）、Server `_SCOPES_BY_CATALOG_ID` 键同为连字符——若写成下划线，OAuth start 会因 unknown catalog_id 失败。
10. 在 seo-geo-agent 的 monitor 模式下连接 GSC 后，应能拉到真实 clicks/impressions/position 并接入趋势（见 `seo-geo-regression.md`）。

## Bing Webmaster Tools

1. 列表中应出现独立的 “Bing Webmaster Tools”，连接时应走 Server bridge OAuth，不应要求用户填写 API key。
2. 授权应使用正式的 HTTPS 服务入口，并验证回调 state 和本机协议接收方，不能由隐藏环境变量改换目的地。
3. Bing 回调即使未带 query `state`，Server 也应通过短 TTL HttpOnly state cookie 完成校验并继续 exchange；日志只应记录 `has_code` / `has_query_state` / `has_cookie_state` 布尔值，不应打印 code、state 或 Cookie 内容。
4. 授权成功后，PC 应显示已连接；`list_sites` 应返回该账号拥有的 Bing Webmaster 站点，返回空列表时应确认账号确实有已验证站点。
5. `query_keyword_stats`、`query_page_stats`、`query_traffic_stats` 对本账号站点应返回可解析数据或 Bing 的可读权限/数据为空错误，不应崩溃。
6. token response 返回 bare scope `Read` 时，应规范化为 `webmaster.read`，PC 不应因缺少 required scope 删除连接。
7. access token 过期后应通过 Server-managed grant refresh 恢复；`connectors.json` 中不应同步 Bing refresh token，只应同步 server grant id 和当前 access token。

## Notion DCR

1. 点击 Notion 连接，应先发现 Notion MCP protected resource metadata 和 authorization server metadata，再完成 DCR client registration。
2. 浏览器授权 URL 应包含 `client_id`、`redirect_uri`、PKCE `code_challenge`、`state` 和 `resource`。
3. 授权回调后，PC 应通过 Server 的 DCR exchange 取回 provider code/state，并在本地校验 state。
4. state 不匹配时应拒绝授权，不应调用 Notion token endpoint，也不应保存连接器。
5. Notion token refresh 时应携带原始 `resource`，并保存旋转后的 refresh token。
6. Notion 连接成功后，读取/搜索页面、数据库和块应正常，停用或断开后 LLM 不应再看到 Notion。

## Linear DCR

| Confirm a high-impact/destructive operation | The existing title is retained; the visible body shows the connector and operation identifier. First-party CLI/direct API execution lanes use the singular `action` parameter; other tools use their actual tool name. Only redacted parameters appear in the expandable details, collapsed by default; account, risk, tool metadata and explanatory notes are omitted. Allow once affects only that call. Allow for this task covers every action for the same connector account, including deletion, without changing global permissions; other tasks/accounts/connectors still ask. Concurrent prompts covered by the grant close as approved. Completion, stop, account switch and connector replacement/removal revoke the grant. | `action-confirm.test.ts`, `registry.test.ts`, `bash-permission.test.ts`, `bus-integration.test.ts`, `connectors_e2e_validation.spec.ts` |

6. Feishu/Lark authorization opens only structurally validated HTTPS URLs on exact official hosts and authorization routes; provider prose does not determine success. A successful automatic browser launch keeps the interactive terminal hidden; show manual recovery only if opening fails, the CLI requests input, or authorization fails. Fixed domains must remain a subset accepted by the pinned CLI auth login command. Reuse a pending attempt for the same account and catalog id. Feishu/Lark offers **Reauthorize** for confirmed missing user scopes. Bot availability, app-permission and unknown resource denials remain separate access advisories; they do not offer OAuth as their remedy. Other official CLI providers retain their existing reauthorization entry. Structured failure envelopes and pinned provider status protocols drive this state; successful business data, arbitrary prose and transport failures do not. Clicking starts the applicable authorization flow even with a valid old login. DingTalk retains structured missing OAuth and PAT scope identifiers. PAT recovery grants only the missing scopes and requires a structured granted/already-granted receipt; plain login success never clears PAT, unknown-access or administrator denials. WeCom identity-only reauthorization also retains the permission notice; it must not imply that business access was restored. Known DingTalk PAT scopes may be retried after an administrator changes policy; cached policy denials must not permanently block recovery. The pinned DWS 1.0.61 login does not implement incremental OAuth scope requests, so those deficiencies remain visible after login. Lark requests confirmed missing user scopes explicitly and retains existing granted scopes (including unprefixed OAuth scopes). After verified consent it reports authorization success and clears only confirmed user scope deficiencies, while preserving bot/resource advisories. Legacy unresolved records become unknown-access advisories, without guessing an identity or claiming access was restored. Selected tools remain unchanged. On Connectors-page entry, inspect verified Lark user scopes for message sending and previously reported missing scopes, even when its transport is live. Repeated opens within one minute reuse the check; explicit refresh and completed authorization check again. There is no startup or timer scan. For Feishu/Lark, DingTalk and WeCom, a failed business operation or a cancelled/failed reauthorization leaves other authorized operations usable without replaying the failure. A missing scope adds a concise advisory card notice (localized names for known scopes, identifiers for other reported scopes, a generic notice if absent) and Reauthorize alongside Use; it never disables the whole connector. Unavailable checks retain prior evidence, confirmed grants clear only scope deficiencies, and resource/admin denials remain unresolved. Disconnect or account switch cancels an in-flight check. Cancellation or failed grant verification retains recovery; success clears only the request handled by that attempt. Newer denials remain recoverable. Feishu/Lark bot visibility and application-owned permission failures show administrator configuration guidance alongside Use; unknown access shows resource-access guidance. A mixed user-scope and access denial shows both the consent action and the independent advisory. Advisories describe historical failures and are not proof of current resource access. No failed business action is replayed automatically.

11. Reject credentials, config/profile overrides, output paths, raw flags, excess parameters, outside files and symlink escapes. Approved local inputs must exist as absolute paths with a realpath inside Orkas-approved roots. Identify file carriers from the pinned provider parameter contract, preserving literal text and file arrays. Prepare private, per-call copies for CLI uploads and declared @file inputs, preserving bytes and filenames; serialize Lark native binary carriers as key=value and preserve WeCom media_id objects. Clean staging after success, failure or cancellation, and reject changed/non-regular sources before sending. Preserve Xero full-JSON destructive-status inspection. Use 60s execution deadlines for ordinary commands and 10min for transfers including staging; only active transfers emit periodic progress to extend the 90s MCP inactivity window, with a 13min total bound. Cancellation must stop descendant processes and must not replay an operation. Network file inputs require HTTPS; bound and sanitize provider output.
