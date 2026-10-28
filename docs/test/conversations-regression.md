# 对话、附件与 Artifact 模块人工回归 Case

## 评测原则与证据矩阵

对话是所有 Agent 与项目任务的持久化底座。Case 必须同时证明成功路径和失败恢复，
不能把“侧边栏消失”当作删除成功，也不能把“模型回复过”当作消息已可靠落盘。

| 核心场景 | 用户预期结果 | 单测/契约 | Electron E2E | Benchmark |
|---|---|---|---|---|
| 创建、重命名、置顶、删除 | UI、索引、消息和资源状态一致，重启后不反转 | `features/chats.test.ts` 的索引、tombstone、清理与并发更新 | `conversations_e2e_lifecycle.spec.ts` | 确定性状态，不进入 benchmark |
| 重复点击当前任务 | 已挂载的消息、滚动位置、草稿、附件和焦点保持不变；点击其他任务仍正常切换 | `conversation-sidebar.test.ts` 的当前任务 no-op 与其他任务切换反例 | “对话列表与切换”人工回归 | 确定性交互，不进入 benchmark |
| 直达智能体的新任务标题 | `@Agent` 仅参与消息路由，首次显示、刷新及持久化标题均只保留任务正文 | `features/chats.test.ts` 与 sendStream IPC 契约 | `conversations_e2e_lifecycle.spec.ts` | 确定性传输契约，不进入 benchmark |
| 指挥官分段气泡耗时 | 每个已结束的指挥官气泡显示各自执行耗时；终止式与非终止式交接、实时与刷新后均一致，且不生成空尾消息 | `group_chat/bus-integration.test.ts` 与 renderer process metadata 契约 | 聊天主链路回归 | 确定性持久化/渲染契约，不进入 benchmark |
| Office 过程动作语义 | 结构检查显示“检查文件”，像素渲染显示“渲染文件”；PDF/HTML 预览继续显示“查看文件”；恢复旧任务时旧 `office_check`/`office_render`、PDF 和进程工具事件保持相同业务标签且不展示 session id，四种语言一致 | `conversation-sidebar.test.ts` 的新旧事件差分与 renderer locale parity | 运行一次 Office 生成任务并核对过程轨道顺序 | 确定性标签，不进入 benchmark |
| 匿名与具名调度边界 | `run_worker` 只创建不可见匿名 helper；带旧版 `to` 的调用明确提示改用 `dispatch_to`，且不得启动匿名或具名 worker、加入 roster 或写入 Agent 回复 | `group_chat/bus-integration.test.ts` 的真实 bus、session、roster 与消息 JSONL 负控 | Commander 分别执行匿名辅助与具名 Agent 调度 | 语义质量另由 Commander regression 评估；边界本身为确定性契约 |
| 删除失败与恢复 | 后端未确认删除时会话保持可见并显示原因，用户可重试 | 后端删除/清理单测 | 注入 IPC 500，验证不假成功且恢复后可删除 | 确定性状态，不进入 benchmark |
| 草稿切换与消息排队 | 每个会话只恢复自己的草稿；用户点击停止时，触发该轮的消息按用户书写的原样（含内联 Skill/Connector token、接收 Agent、引用与复用附件）回到输入框，已发送消息仍留在对话中，输入框已有内容或队列项正在编辑时一律不覆盖，正常结束的轮次不得再被回填；队列消息编辑时完整恢复正文、附件、引用、Skill/Connector 与接收 Agent，保存后回到原位置，也可直接删除且永不发送该项；编辑期间不出队；目标与当前 Actor 相同且主进程标记该 CoreAgent/Codex/Claude turn 可 steer 时显示“发送”，文本、附件/图片、引用文件、Skill 与 Connector 均可同轮插入；不同 Agent、nested turn 与不支持 ingress 的 CLI 保留为后续轮次；立即发送的用户消息落入活动 AI 气泡之后时，该气泡下一次产生可见输出即移到用户消息之后，后续 token 不重复移动 DOM，最终再以服务端时间校准；未打开该会话时，上一条结束仍自动发送队首且不污染当前 tab | `queue-draft.test.ts` 覆盖按钮/点击双重准入及所有 sidecar；`composer-abort-restore.test.ts` 覆盖停止回填的内容、raw/派发文本差分、未发送输入与编辑锁保护、终态清理与非用户中断；`conversation-sidebar.test.ts` 覆盖活动气泡跨越新用户消息且每个边界只移动一次；`group_chat/bus-steer.test.ts` 覆盖 CoreAgent/CLI 富消息 hydration、ACK 后出队及 FIFO/Actor 边界；Codex/Claude backend 与 runner 单测覆盖 native ingress 生命周期、ID、图片、串行 writer 和失败回退；`agent-runner.test.ts` 覆盖 CoreAgent 结构化模型请求、持久化、去重与 ACK 重试 | `chat_e2e_model_stream.spec.ts` 覆盖 CoreAgent 引用与真实附件同轮转向，以及最终落盘前的实时消息换位；`chat_e2e_cli_recovery.spec.ts` 覆盖 Codex 同轮插入只运行一个进程，以及 OpenCode 不显示按钮并在当前进程结束后自动续跑；另保留真实附件编辑、编辑态删除和后台自动出队 | 确定性状态，不进入 benchmark |
| 后台消息与会话排序 | 后台任务按消息的真实时间排序；打开任务回放缓存事件时不得把查看时间当作新活动时间 | `conversation-sidebar.test.ts` 的后台消息回放与排序负例 | 两个先后结束的自动任务来回切换，顺序保持不变 | 确定性状态，不进入 benchmark |
| 自动任务执行状态 | 自动任务执行中同时显示呼吸状态点和自动化时钟，状态点固定在时钟左侧；结束后移除状态点，不显示静态圆点 | `conversation-sidebar.test.ts` 的运行态图标顺序与静止态无标记 | 启动自动任务后检查侧边栏和项目对话列表 | 确定性 DOM 状态，不进入 benchmark |
| 后台任务未读提示 | Orkas 在后台或用户正在查看其他任务时，任务完成、失败或等待输入后，任务标题及所属 Tasks/Projects 层级显示红点；打开该任务后清除，重启和账号切换不串线 | `task-unread-indicators.test.ts` 覆盖前后台、持久化、父级聚合和账号隔离；`preload.test.ts` 自动发现真实 Renderer 推送消费者并覆盖精确 `conversation:task_terminal` 通道、动态通道及近似通道拒绝 | `task_notifications_e2e_navigation.spec.ts` 显式隐藏 Electron 窗口后通过生产终态通道验证任务与项目标题红点 | 确定性 IPC/状态/DOM 契约，不进入 benchmark |
| 任务最终状态标签 | 已完成、等待输入或已取消的任务不显示“失败”；只有真实失败显示。成功回复、任务终态、流关闭、历史恢复与回放乱序时，最新的权威任务结果必须胜出 | `conversation-sidebar.test.ts` 的状态旅程矩阵与 `conversation-task-turn-capture.test.ts` 的桥接契约 | `chat_e2e_model_stream.spec.ts` 验证真实失败、重启保留、重试成功清除，以及普通成功重启后不误标 | 确定性状态，不进入 benchmark |
| 消息底部操作可见性 | 普通消息操作在悬停或键盘聚焦时显示，所有按钮直接外露，反馈位于末尾，其余按钮保留原顺序；失败或中断回复的恢复操作始终可用；Agent、Skill、文件等结果 chip 不受影响 | `conversation-failed-retry.test.ts` 的共享操作容器 CSS 契约及结果行反例 | 普通与项目任务分别复验用户消息、成功回复、失败回复和刷新恢复 | 确定性视觉交互，不进入 benchmark |
| 流式中断、排队与重启 | 仅本机登记的执行中任务随应用退出时显示中断；同步自其他进程/设备的 `running` 不得被本机恢复扫描误判，已持久化完整回复只清理陈旧运行态 | chats local-journal stale-state sweep、sendStream IPC、bus abort、failed-turn retry | `chat_e2e_model_stream.spec.ts` | CLI/模型恢复质量由 the separately authorized model canary 单独评测 |
| 流式期间消息列表滚动 | 新建任务即使跳过历史加载，也必须在启用发送时置顶占位前绑定消息列表手势；滚轮、触摸或滚动条移动应立即解除占位，允许继续查看下方内容 | `conversation-sidebar.test.ts` 的 fresh-history 绑定、滚轮、触摸与裸 scroll 契约 | `chat_e2e_scroll.spec.ts` 分别从普通新任务页和项目页创建任务，在首轮完成后的慢速第二轮中验证消息区滚轮解除占位 | 确定性交互，不进入 benchmark |
| 长对话轮次定位 | 对话达到 5 个用户轮次后显示轻量定位轨道；点位索引与正文独立并按 15 轮分页，轨道最多显示 12 个点；发送新轮次后当前点立即随对话前进，选中点尽量保持居中，上下仍有点位时对应边缘点渐缩渐隐；轨道内上滑加载更早的完整点位；悬浮/聚焦显示两行用户摘要和五行 AI 摘要，点击未挂载轮次时直接精确寻址且不串行加载中间正文页 | `conversation-turn-navigation.test.ts` 与 `features/chats.test.ts` 覆盖阈值、完整分页、新轮次自动跟随、选中点居中与边界夹取、双向溢出状态、可见点上限、摘要上限、旧对话懒构建、程序化滚动和缓存失效 | 视觉、轨道滚动与旧对话首次构建按“长对话首屏与历史窗口”人工复验 | 确定性索引/DOM/分页边界，不进入 benchmark |
| 对话历史连续性 | Commander 与具名 Agent 共享同一 canonical 已完成对话投影，各自保留私有执行 session 与独立压缩；CLI 接收有界完整历史或成功游标后的 diff；任何 actor 都不应收到内部 JSON/宿主标记 | canonical history 投影、Agent checkpoint、CLI history compiler/cursor、chat-history scope/边界契约 | 当前任务指代续做、项目旧会话续做与重启 | shared-conversation-context Regression、Commander project-history Regression、Claude/Codex current-history benchmark |
| 文件预览与编辑 | Markdown/文本编辑不丢草稿、不重复写、不绕过只读权限；PPT 预览首次选中第 1 页，滚动时只选中视口中心页；抽屉异常不留空壳，保存后重启仍一致 | `md-view-edit.test.ts`、`text-view-edit.test.ts`、`chat-md-drawer.test.ts`、`office-preview-rendered.test.ts` | `composer_e2e_interactions.spec.ts`；PPT 滚动保留真实浏览器手工复验 | 确定性编辑、布局与 IPC，不进入 benchmark |
| 内联 HTML 离线预览 | 自包含 HTML 的内联脚本、本地及内嵌图片正常工作；远程脚本、资源、连接和框架导航不得自动联网 | `window-security.test.ts` 的 CSP/URL/导航边界 | `html_preview_e2e_offline_policy.spec.ts` 的真实 Chromium 请求负控 | 确定性安全边界，不进入 benchmark |
| 多文件 HTML 预览 | 文件预览打开页面前先登记其所在文件夹：同文件夹及子文件夹的 CSS、JS、ES 模块、JSON、字体按正确类型加载，隐藏路径、其他文件夹、主目录及以上的文件夹一律不放行；本地存储仍被沙箱禁止。Agent 的 `html_preview` 检查按同一沙箱加载交付页面，生成应用的冒烟检查保持原方式 | `chat_attachments.test.ts` 的授权/隐藏/越界/过期；`produced-html-preview-assets.test.ts` 的真实 IPC 范围；`html_preview.test.ts` 的文件预览检查；`window-security.test.ts` 的沙箱参数一致性 | `html_preview_e2e_offline_policy.spec.ts` 的多文件站点在预览窗口与 `html_preview` 中的对照 | 确定性安全边界，不进入 benchmark |
| 任务详情文件树 | 后台文件刷新更新列表，但不折叠用户已展开的目录 | `conversation-info.test.ts` 的目录状态与刷新竞态 | 按“长对话首屏与历史窗口”人工复验 | 确定性 DOM 状态，不进入 benchmark |

### 任务最终状态标签场景矩阵（2026-08-08）

| 用户目标 / 场景 | 起始状态与变化 | 可观察结果 | 严重失败与恢复 | 层级与独立判据 | 当前风险 / 覆盖 |
|---|---|---|---|---|---|
| 查看正常完成或内部故障后已恢复的任务 | 最终回复已落盘；生命周期流随后异常关闭 | 任务行没有“失败”，回复仍可见 | 成功任务被误报失败，用户重复执行已经完成的工作 | Renderer 状态旅程；断言最终任务行状态，不断言内部调用次数 | 历史实况；覆盖“回复先到、流错误后到” |
| 从早到的传输错误恢复 | 流错误先显示失败；稍后收到同一任务的 `completed` 终态 | 失败标签自动消失，无需重新打开任务 | 状态永久停在失败 | Renderer 乱序旅程 + E2E 成功重试；最终任务行和持久化回复为判据 | 覆盖反向竞态与恢复 |
| 识别真实失败 | 无成功回复；权威任务终态为 `failed` | 当前任务行显示“失败”，重启后从失败历史恢复，成功重试后清除 | 真实失败被静默隐藏，用户失去重试线索 | Renderer + Electron E2E；可见标签、失败气泡和重试后状态是相互独立的判据 | 覆盖失败、重启、重试闭环 |
| 区分等待、取消和失败 | 终态分别为 `waiting_input`、`cancelled`、`failed` | 前两者不显示失败，只有后者显示 | 等待用户操作或主动停止被误报成系统失败 | 参数化 Renderer 状态旅程；任务行状态为判据 | 覆盖相邻状态反例 |
| 重启或打开已有任务 | 最新历史分别为成功回复、结构化失败回复、待回复用户消息；索引可带陈旧失败状态 | 仅最新结构化失败显示失败；成功和待回复状态覆盖陈旧标记 | 旧内存/索引状态压过持久化事实 | Renderer 历史恢复；以最新持久化消息和任务行状态作差分判据 | 覆盖冷恢复与兼容数据 |
| 接收重复、乱序或恶意终态 | 新任务结果已到；随后重放旧任务终态，或收到缺 cid/未知 status 的载荷 | 新结果不反转；其他任务不受影响；无效载荷不清除真实失败 | 回放把成功改成失败，或跨任务串线 | Renderer 负控；比较目标与旁路任务最终状态 | 主动问题发现：旧终态跨来源乱序、无效输入、跨 cid 隔离 |

未在自动化中伪造 Electron 主进程在成功终态之后崩溃的 IPC 通道；该精确故障由
Renderer 的双向乱序测试确定性覆盖。Electron E2E 负责独立证明真实状态能穿过
模型、总线、持久化和侧边栏，并覆盖失败重启及成功重试，不复制宿主崩溃注入。

## 自动化覆盖

`test/e2e/chat_e2e_model_stream.spec.ts` 已通过本地隔离 SSE 模型覆盖创建会话、流式回复、停止生成、失败重试、截断流不得伪完成、流式期间消息排队/顺序消费、活动轮富消息转向、消息落盘和完整重启恢复；`test/e2e/chat_e2e_scroll.spec.ts` 另从普通新任务页和项目页覆盖流式期间的滚轮、触摸与裸 `scroll` 契约。引用立即发送 case 证明结构化引用和新增文本能进入相同 CoreAgent turn，并保留完整 `<referenced-messages>`；真实附件 case 证明附件行同样显示“发送”，用户消息先落入时间线而不启动竞争流，CoreAgent 的下一次模型请求再获得新的 attachment manifest。`chat_e2e_cli_recovery.spec.ts` 用 Codex App Server stub 证明 `turn/steer` 在同一 CLI run 内生效，并用慢速 OpenCode stub 证明无 ingress 的 CLI 不显示“发送”、当前进程结束后再自动以原生 follow-up 续跑。Codex backend 进程测试固定 `expectedTurnId`、`clientUserMessageId`、`localImage`、拒绝回退和 terminal 注销；Claude Code 进程测试固定第二条 user JSONL 与 control response 的串行写入。带真实附件的队列编辑、编辑态删除、切换 tab 后后台自动出队、停止、失败恢复与重启仍分别校验无丢失、晚到重放或重复派发。

“立即发送”使用明确的执行控制：Renderer 只有在按钮通过活动 Actor/ingress 双重准入后才发送显式 `steer_active_turn: true`，IPC 仅接受严格布尔值并映射到主进程 `steerActiveTurn`；显式 `false` 或字符串伪值均不得授权介入。测试验证显式控制才允许介入；缺少控制时仍按 FIFO。按钮显示与点击之间还要重新校验活动 Actor；资格失效时不得请求后端、不得从本地队列移除，也不得降级成普通发送。任何队列侧旧元数据都不能把一次通过校验的“立即发送”覆盖成 `false`。`queue-draft.test.ts`、send IPC 契约、`group_chat/bus.test.ts` 和底层 steer 测试分别覆盖按钮载荷与竞态、跨 IPC 边界的 fail-closed 传递、真实活动 CLI 会话的同轮介入/FIFO 表现，以及未授权消息持续留在 durable FIFO 的不变量。

`test/main/features/group_chat/visibility.test.ts` 以生产中出现过的内部历史回显形状覆盖 canonical history 投影：保留用户请求、角色名、dispatch、失败代码和产物路径，但不得再生成 `[Historical group conversation …]`/整条记录 JSON；已污染的旧 Assistant 回复不得继续传播，用户主动提到的相似普通文本仍须保留。

`src/core-agent/test/session.test.ts` 还固定了 checkpoint、history exact facts、turn context、workspace ledger、completed-work ledger 与 execution-plan anchor 的模型投影边界：这些块必须保留任务续接所需事实，同时显式标记为私有运行时上下文，禁止在用户可见回复中引用、概括或确认；completed-work 投影加标记后仍不得突破原有 6000 字符上限。

## 准备

1. 准备一个普通对话、一个项目对话、一个绑定智能体/技能的对话。
2. 准备 PDF、DOCX、图片、Markdown、CSV、代码文件、较大文本文件和包含中文/空格/特殊字符的文件名。
3. 准备一个会生成 Artifact 和多个文件产物的真实模型任务。

## 对话列表与切换

1. 新建、重命名、删除、归档或恢复对话后，侧边栏、对话标题、任务详情和搜索结果应一致刷新。
2. 快速切换多个对话时，消息、附件 chip、文件 tab 和输入草稿不应串线。
3. 长标题、长摘要、多语言标题在宽屏和窄屏下不应遮挡按钮或撑开布局。
4. 准备大量历史对话后重启应用：首次列表仍应正确显示指挥官/智能体头像；后续启动应复用已持久化的参与者摘要，不再逐个扫描消息日志。
5. 将一个仍在执行且已进入本机 `running-conversations.json` 的对话强制退出并重启：仅该对话应恢复为 idle 并出现一次中断提示；若主消息末尾已经持久化同一轮的完整终局回复，即使 `state.json` 错误残留为 `running` 也只能静默清理状态，不得追加或继续显示中断气泡。另准备一个仅由同步落入、未进入本机运行日志的 `running` 状态，启动维护扫描必须原样保留且不得写中断消息。
6. 在大量会话均已带记录同步版本后重启：列表应以各项目的 `_index.json` 为主数据源，不应逐个打开重复的 `meta.json`；旧版无同步版本记录和索引缺失记录仍应自动恢复。
7. 在两个项目内分别准备多个对话，重命名或置顶其中一个：只应更新该对话的 `meta.json` 和所属项目 `_index.json`，其他对话 metadata 与其他项目索引的文件时间/内容应保持不变；删除、恢复和跨项目移动后索引仍应正确。
8. 在一个项目持续收发消息，同时在另一项目准备大量对话：activity、重命名、置顶和删除只能读取/改写目标项目索引；并发执行两个不同字段更新后两个结果都必须保留，不能发生后写覆盖先写。
9. 新任务首条消息包含中英文逗号、句号、问号等标点，或包含 `https://orkas.ai`、带查询参数的 URL、`www.` 地址时，自动标题应保留标点及后续文本，仅在超过 100 个半角显示宽度（约 50 个汉字或 100 个英文字符）时截断并追加省略号，存储与重命名时省略号不得被再次截掉；项目详情的任务列表应显示完整的截断标题。带引用消息的新任务只能用用户输入的正文生成标题，不得使用引用内容；只有引用而无正文时保留默认标题。首次乐观显示、刷新后的持久化标题和回收站恢复标题应一致。
10. 新任务通过接收者选择器直达智能体时，用户消息应保留路由所需的 `@Agent`，但首次标题、列表刷新后的标题及重启恢复标题都只能使用任务正文，不得带 `@Agent`。
11. 指挥官产生多个气泡时，每个已结束气泡的“过程信息”右侧都应显示该气泡自身的执行耗时：`hand_off_to` 前的说明气泡不得计入智能体执行时间，`dispatch_to` 后的总结气泡应独立计时；刷新或重启后耗时仍应保留，终止式交接不得产生空尾消息。
12. 让两个自动任务在后台先后产生消息并结束，再打开较早结束的任务：侧边栏排序必须继续使用消息的持久化时间，不得因缓存事件在查看时回放而刷新为当前时间、跳到较晚任务之前；重复切换结果相同。
13. 打开一个已有多条消息的任务，滚动到中间并保留未发送草稿或附件，然后再次点击侧边栏中已选中的同一任务：消息区不得出现加载态或重建，滚动位置、草稿、附件、右侧详情和输入焦点均保持原状，也不得重复记录“打开任务”；随后点击另一个任务，仍应正常切换并加载目标内容。

## 长对话首屏与历史窗口

1. 准备超过 10 条消息且包含中文、多行 Markdown、附件、产物、表单和 malformed JSONL 行的对话：打开时应优先显示最新 10 条，顺序、角色、附件和状态应正确，不能长时间白屏或卡住。
2. 向上滚动到消息区顶部时，应出现内嵌“加载中”状态并自动增加紧邻的更早一页，已有消息不得重复或缺失，阅读位置不得跳动；包含整页内部 dispatch/路由记录时应自动跨过空白页，继续滚动可持续加载直至文件开头，此后不再显示 loading。
3. 对话总用户轮次少于 5 个时不显示左侧定位轨道；达到 5 个后立即加载最新 15 个短横点，即使对应正文尚未分页挂载。定位轨道最多同时显示 12 个点，单点高度 18px，因此最大高度固定为 216px，并在自身范围内滚动；选中任一点后，该点应位于轨道中央，只有最前或最后等已无法继续滚动的边界位置允许偏离中央。轨道上方或下方仍有点位（包括尚未加载的更早分页）时，对应边缘的三个实际定位点应保持原有 18px 间距和 2px 可见高度，只向外逐渐缩短、变淡，不得增加额外轨道高度；到达真实边界后所有实际定位点恢复正常样式。普通、悬浮与选中态必须围绕同一中心线改变宽度，不得横向偏移。在轨道顶部继续向上滚动时每次前置 15 个更早点位，阅读位置不跳动，直至所有轮次均可达，不得采样或合并。悬浮或键盘聚焦任一点时，用户摘要最多两行/100 个 Unicode 字符，AI 摘要最多五行/240 个 Unicode 字符；点击未挂载轮次直接读取目标锚点并居中高亮，不得串行补载中间正文页。窗口宽度小于 760px 时隐藏轨道，不遮挡消息和输入框。
   正文定位按优先级判断：真正滚到对话顶部时选第一轮；否则最后一条消息进入可视区或滚到真正底部时选最后一轮；中间按视口高度 25% 处所在的轮次定位，AI 回复属于前面的用户提问。首尾同时可见时顶部优先。历史窗口的首尾不能冒充整段对话的首尾；窗口以回复开头时仍归属其原轮次。点击点位后保持选中，直到用户继续滚动或再次跳转；消息高度变化后重新计算位置，不主动移动正文。`chat_e2e_turn_navigation.spec.ts` 覆盖上述界面行为、定位索引分页失败后的重试与阅读位置保留。
4. 准备一个在本版本之前创建且没有本地轮次索引的长对话：打开后最新正文仍先显示，主进程只为当前对话异步建立本地派生索引；索引完成后加载最新 15 个点，轨道内最多可见 12 个，第二次打开直接复用。追加消息、删除消息、同步替换源 JSONL 或移动对话归属后，旧索引必须失效并从当前源重建；由更早版本建立的索引（摘要预算不同）在升级后首次打开时同样重建一次，之后复用；删除对话时同时清除派生索引。
5. 在已加载多页后切换对话再切回：正文应重新从最新 10 条开始，定位轨道则重新加载最新 15 个点并最多显示 12 个；全局搜索定位较早消息时，不应错误高亮当前页面的其他消息。
6. 全局搜索命中首屏 10 条之外的早期消息时，点击结果应根据整份 JSONL 的消息下标计算目标页起点，一次读取“目标页起点到当前最新消息”的完整尾段，并把源下标映射到每个气泡后直接定位；目标消息之后的所有消息必须保留，更早内容仍可向上分页。旧消息即使缺少稳定 ID/时间也必须命中；定位应为瞬时跳转，且该程序化滚动不得触发“加载更早消息”继续逐页补载。
7. 打开右侧任务详情的文件 tab 并展开一个目录后，让模型生成或删除文件：文件列表应更新，已展开目录不应因静默刷新自行折叠；同一次文件刷新不应重新读取整段对话历史，附件和已有产物信息仍应保留。
8. 在包含大量项目和会话的数据集上分别打开普通对话、项目对话并继续翻页：请求应携带侧边栏已知的项目/全局归属提示，主进程只整理目标会话；模拟同步把对话移入另一项目后，旧提示仍应回退并打开正确记录。

## 输入框与 @ 选择

1. 在新建对话、普通对话、项目对话输入框中输入 `@`，分别选择多个 Skill 与 Connector 后，应在正文中以内联 chip 展示，并能与中英文/日文/葡文普通文字混排。
2. 发送后，历史用户消息和实际模型输入应把这些 chip 展开为当前语言的普通文本（如“XX 技能”“XX 连接器”），不应残留内部 token 或旧底栏单选 chip。
3. 回复 streaming 期间继续输入并排队时，队列预览应展示可读的 Skill / Connector 标签，实际派发时仍应按正文 token 展开。
4. 旧草稿或旧队列中保存的单个 `use`/`skill` 字段应能恢复为正文 chip 或按旧前缀发送，不应丢失用户输入。
5. 从资料库选择文件附加到聊天草稿时，选择器高亮不单独上报；每次真实附加只上报一次 `event_chat_library_attach_result`。失败时再配对一条 `error_chat_library_attach`，且两者都不得包含文件名或路径。
6. 在项目详情的指挥官输入框粘贴截图或图片文件时，应在当前项目的草稿区显示附件 chip，图片不得直接嵌入输入框正文；发送后附件应随新建项目对话一并迁移。
7. 回复 streaming 期间排队三条消息，让中间一条同时带附件、引用、Skill、Connector 和接收 Agent 后点击编辑：正文及所有 chip 应完整进入主输入框，队列列表仍保留该项及其取消入口，当前回复结束也不得发送任何队列项；修改后发送只把整份消息放回原顺序，不能创建额外消息。重复测试空内容、附件上传中和 Esc 取消：前两者保持编辑锁，Esc 恢复原消息及先前未发送草稿的全部内容后才继续队列。
8. 在会话 A 回复 streaming 时排队一条消息，然后切到会话 B 且不要再打开 A：A 的当前回复结束后应自动发送队首，侧边栏运行态应跟随 A；B 的输入框、发送按钮和消息历史不得出现 A 的正文或流式占位。待 A 完成后再打开它，应看到两轮用户消息和两轮回复均按原顺序落盘，队列为空。
9. 发送一条同时带附件、引用、Skill/Connector chip 和接收 Agent 的消息，执行中点击停止：输入框应还原为用户书写的原文（chip 与接收 Agent 一并复原，不得出现 `@Agent` 前缀或已展开的“XX 技能”正文），附件以复用形态回来且删除不影响已发送消息，光标落在末尾；已发送的那条消息仍留在对话中。修改后再次发送只产生一条新消息，Skill 不得被重复展开。重复以下三种情况，输入框内容都不得被覆盖：停止前已在输入框输入新内容、停止时正在编辑队列项、以及在上一轮正常结束之后才点击停止（此时不应回填任何内容）。从新建任务页和项目页发出的首条消息同样适用。

## Agent capability handback, including CLI bridge transfer

1. Directly address an in-process Agent with a primary deliverable outside its declared workflow. The Agent should briefly name the exact capability boundary and emit `<handback reason="capability_boundary" />`; the marker must stay hidden while the commander automatically continues with the original goal and attachments. Then directly give the Agent an in-scope task that it completes successfully: it must return the result without a handback marker or Commander continuation.
2. Repeat with missing user input, a recoverable tool failure, a difficult in-scope task, and a task another Agent could merely perform better. These cases must stay with the current Agent and use its normal form/recovery path instead of handing back.
3. Make a malformed Agent reply contain both `<handback reason="capability_boundary" />` and an input form. The form must win: control stays with the Agent and no commander continuation is queued.
4. From the resumed commander turn, deliberately send the unchanged task back to the same Agent. Its second handback may return as the current dispatch result, but it must not enqueue another commander turn or create an automatic loop.
5. Exercise an existing interactive `hand_off_to(..., resume)` ledger. Its handback must keep using the ledger resume path exactly once and must not also create a direct-handback continuation.
6. Address multiple Agents in one user message and have each emit handback. The original message must wake commander at most once. If that same user message already addressed commander, handback must not enqueue an extra commander turn. Under D29, a plan that gives Commander a part (for example "最后你汇总一下") counts as addressing it: Commander runs only its planned part, with the hand-back as its predecessor result.
7. Exercise a direct legacy bare `<handback />`, an unknown/conflicting reason, and an explicit capability-boundary reply followed by a runtime error. Every marker must stay hidden. Bare, unknown, or conflicting direct markers must not fabricate a capability boundary or wake Commander; the failed runtime must surface its failure without creating a continuation. Repeat the bare marker under an existing orchestration ledger to verify backward-compatible resume exactly once.
8. Directly address an external CLI Agent with `@Agent` or the recipient chip and inspect its prompt: it must not receive capability-mismatch or lifecycle-completion handback guidance. After its reply completes, the recipient chip must stay on that Agent; send a no-mention follow-up and verify it routes to the same Agent and remains sticky. Then switch explicitly to Commander and verify the floor changes only from that user action.
9. Inspect a CLI run when the ordinary group-chat Agent connector resolver has no visible connector: `orkas_list_connector_tools` and `orkas_call_connector_tool` must be absent from MCP discovery and direct host RPC must reject them. Connect and enable one connector for the user and repeat: both methods may appear through the same user-scoped visibility used by an in-process group-chat Agent, while every CLI call still requires the existing approval gate.
10. Directly ask a user-selected CLI Agent for a Commander-only operation such as automation, Agent, or Skill creation. The CLI must call `orkas_handoff_to_commander` instead of emitting `<auto-task>`, `<agent>`, or `<skill>`. The run accepts only its first bounded reason/context request, then normalizes it into the ordinary Agent handback path: form priority, ledger resume, direct-origin dedupe, loop guards, floor reset, and original goal/attachment preservation must be identical. Have Commander emit the valid mutation container and verify the automation/object is actually created once; a form, failed/aborted CLI run, duplicate request, or user message already addressed to Commander must not create a second continuation. The live Claude/Codex model regression must additionally prove that an available custom Skill is read directly without transfer, while the combined automation/Agent/Skill mutation request produces exactly one structured handoff with all requirements preserved.
11. Have Commander `hand_off_to` an interactive external CLI Agent, then complete that handed-off interaction with a visible result plus `<handback reason="completed_handoff" />`. Unlike direct user selection, the marker must stay hidden, the Agent result must remain the only user-facing completion, the conversation floor must return to Commander, and no extra Commander model turn or stale duplicate reply may appear. A ledger-backed `hand_off_to(..., resume)` must still wake Commander exactly once, and the legacy bare marker remains accepted only for ledger/floor lifecycle compatibility.
12. After a Commander-only discussion, directly address an Agent for the first time. In-process and CLI contexts use the same scoped canonical dialogue source and latest-five-user-turn policy, excluding the current inbound task until it is added separately. CLI recovery/deltas are bounded to 30K estimated tokens without per-message byte clipping. Native CLI session history remains CLI-owned; another actor's private execution session must never be copied as canonical history.
13. Have Commander `hand_off_to` an Agent that returns a distinctive blocker, then send a follow-up such as “fix that issue.” The Agent bubble must remain the only user-facing delivery in the hand-off turn and `hand_off_to` may still return only its acknowledgement. On the follow-up, Commander's ordinary model history must be synchronized from the canonical conversation log and contain the earlier user request, the Agent identity/name, and the exact blocker text; Commander must continue from that evidence without claiming the dispatch never happened or blindly repeating it. Verify no Commander visibility-slice file is created, while private execution state remains restricted to its owning Agent/session.
14. After the first Commander synchronization, send several more turns in a long conversation and verify later turns use the persisted canonical-history checkpoint: only the tail beginning at the previous mutable user turn is read and replaced, while the older Session JSONL prefix is untouched. Replace/tombstone the canonical log, rename an already-observed actor, or reload a Session whose raw indexes were trimmed and verify the checkpoint fails closed into one full rebuild. A full rebuild first keeps at most the latest five completed user turns under 30K estimated tokens, including framing and omission notes. Before inference the core additionally applies 20% of allocatable turn-start room; current input is separate. Drop oldest whole turns without backfilling around an oversized newest turn. Omitted history remains retrievable through `chat_history`; historical summaries and fact ledgers are not injected. Same-turn tools do not move the frozen history allowance; a smaller resolved model can tighten it, retries/restarts preserve it, and a new user turn recomputes it. Active-process checkpointing retains its separate owner.
15. Seed a prior Commander/Agent reply with the exact leaked production markers `[Historical group conversation — actor responses]` and `[History retained facts — host-persisted model extraction]`, then send a short follow-up. Canonical history must omit that contaminated reply body while retaining its actor attribution and produced-file metadata. A user message containing the look-alike phrase `[Historical conversation]` must remain verbatim. New projected turns must contain readable actor headers and exact blocker text, but no host marker or whole-record JSON for the model to echo.
16. Force same-turn compaction after several successful tool calls, then continue with a checkpoint, workspace observations, completed-work ledger, and execution-plan anchor. The model must use those facts to continue without repeating completed calls, while the final user-visible answer contains none of the private context labels, bookkeeping IDs, control instructions, or acknowledgement that such blocks exist. Repeat with a near-limit completed-work ledger and verify the final marked projection remains at or below 6000 characters.
17. Run a CLI Agent Skill that keeps both a parent process and a descendant alive, then end the Orkas run, close MCP stdin, and cancel the CLI process. Every path must terminate the complete Skill process tree, settle any in-flight tool call without a timeout, emit no unexpected MCP stderr/protocol output, and remove the run-scoped output directory. Repeat with two concurrent Skill calls so shutdown cannot silently clean up only one run; use the Windows native process lane to verify the corresponding task-tree termination.
18. Directly address an in-process Agent and an external CLI Agent, and have each reply name `@指挥官`, `@commander`, `@用户`, and `@user` in ordinary prose, including inside a Markdown table cell and mid-sentence (2026-10-04 regression: a CLI reply that only described the rule woke Commander twice). Each reply must stay addressed to the user, keep the commander mention visible as display text, and create no Commander task, turn, or bubble. Then verify escalation still works only through its structured paths: an in-process `<handback reason="capability_boundary" />` and a CLI `orkas_handoff_to_commander` call each wake Commander exactly once.

## Planned dispatch (D29)

Planner calls are visible in Orkas logs as `planned dispatch cid=… tasks=… edges=… references=…`, and fallbacks as `planned dispatch fell back to commander` with a reason. Check board rows, the inputs each actor receives, and the log line for every case.

1. Classification. `@A 写初稿` creates one task for A without a planner call. Bare `@A` and `@A @B`, without references or attachments, are rejected as empty: keep the draft and leave history, board tasks and floor unchanged. `先看一下现状 @指挥官 再定计划` goes straight to Commander without a planner call. `帮我翻译这段 @Translator` is planned: Translator gets the translation task and Commander gets nothing (before D29, only Commander received it). Mentions inside code spans, code blocks, or quote lines do not count toward any of these decisions.
2. Parallel, then merge. `让 @A 和 @B 分别写初稿，最后汇总成一份` starts A and B together. The Commander row shows "Waiting on A and B" and starts only after both are done. Its input contains one `<predecessor-task-result>` block for each draft, and the summary uses both.
3. Chain. `@A 写一篇介绍，然后 @B 做成 PPT` starts B only after A is done. B's input contains A's reply and produced file paths, and B's `<task-assignment>` says its result goes to the user while A's says it goes to B.
4. Reference only. `把 @A 的报告发给 @B 改一下` creates a task for B only. A gets no task or turn, and the floor moves to B.
5. Failure and run anyway. In case 2, stop A while it runs. The Commander row becomes blocked with Run anyway and Cancel. Run anyway starts it with B's result plus a `<missing-predecessor-results>` note that names A as stopped. It must never start silently or be cancelled silently.
6. Fallback. Make the planner fail (offline, or invalid output in a test build). The whole message goes to Commander with the "could not split this user message" note and the named actors, and no partial agent task is created. A planner clarifying question reaches Commander verbatim.
7. Stop while planning. On a slow network, send a planned message. Its bubble appears at once and the send button shows Stop while it is being split. Stop leaves the bubble in history and creates no task and no agent turn.
8. Send order while planning. While a planned message for a single assignee is still being planned, send a follow-up without a mention. The follow-up queues after the planned task and routes to that assignee (the new floor), never to the floor from before the plan.
9. Composer. None of the three composers (conversation, new chat, project) shows an order toggle. The mention preview lists the named actors only. A planned send to an external CLI Agent keeps the model picker enabled; a direct send to a single external CLI Agent still disables it. Text that carries a routing mention gets no injected recipient prefix.
10. User's own steps. `@Codex 先把接口写好，我来部署，部署完 @Tester 跑一遍冒烟测试` creates tasks for Codex and Tester only. No task, including a Commander task, is about the deploy, and Tester's part says it follows the deploy. Tester starts when Codex is done, because the board cannot wait for the user.
11. Choosing and sharing. `@Codex @ClaudeCode 你们俩选一个来做这个重构就行` gives the task to Codex and lists ClaudeCode as a reference. `@Codex @ClaudeCode 这两个方案哪个更好？` gives both the same question in parallel, without a clarifying question.
12. Restart. Restart Orkas while a planned successor waits or is blocked. The successor is reconciled to cancelled with the rest of the queue, and old single-value dependencies in saved boards still load.

## Waiting agents (D30)

An Agent that stops to ask the user takes a free floor (the composer chip) and keeps the user's reply in its own turn. Check the chip, board rows, the Agent's input and Commander's `<orchestration-resume>` turns for every case.

1. 09-20 replay. Without a mention, ask for one map video plus three map images. Commander dispatches VideoStudio, which stops on its plan with a question. The chip switches to VideoStudio, Commander's dispatch result ends with `<blocked-on-user agent_id="…" />`, and a second dispatch or hand-off to VideoStudio in that turn is refused as waiting for the user's reply. Reply `同意` without a mention: VideoStudio receives it as the user's own message and its plan gate accepts it on the first try. Its board row continues; no new row is created and none is cancelled.
2. Completion. VideoStudio ends the routed interaction with `<handback reason="completed_handoff" />` after delivering the final video; Commander then resumes exactly once with its `resume` steps and the chip returns to Commander. A question without the open marker (common after a gate refusal) must keep the chip on VideoStudio and must not resume Commander. A gate refusal that asks for the user (`outcome: need_user`) counts as waiting even without the marker. A reply that asks the user and also ends with `<handback />` keeps the chip and the `resume`; Commander resumes only after the real delivery.
3. Two waiting Agents. Dispatch two interactive Agents that both ask. The first to ask holds the chip; the other's question stays visible and can be answered by mentioning it. When the first finishes, the chip moves to the second. Commander resumes once per Agent, each with its own `resume`.
4. Hand-off without resume. Hand VideoStudio a single video with no `resume`. Commander is not woken. If VideoStudio hands back after delivery the chip returns to Commander (as with external CLI Agents); without a handback it stays on VideoStudio and a later "字幕再大一点" reaches it directly.
5. Planned tasks (D29). `@A 做视频 @B 做三张图，最后你合成一页` where A asks to confirm. The chip moves from Commander to A, replying continues A's row, and after A finishes the chip returns to Commander and the merge task starts with both results. A's later replies still carry its split note: A reports only its own video and never combines B's images; only Commander's merge does.
6. User speaks to Commander meanwhile. While an Agent waits, `@指挥官 换个方向` lets Commander call that Agent again; the waiting row is superseded as before. A Commander turn started by an Agent result or a resume may not call it.
7. Forms unchanged. An Agent that asks through a form does not take the chip; submitting the form resumes its task and Commander as before, and a plain reply instead of submitting still starts a new row.
8. Reminder. While an in-process Agent holds the chip because of Commander (a hand-off or its own question), its input starts with "Return control to commander"; when the user picked the Agent, it does not.
9. Restart. Restart Orkas while an Agent waits. The chip stays with it, a new message to Commander may call it again, and a resume turn may not.
10. Draft stop. With a model that tries to confirm or export the draft in the turn that rendered it, the refusal ends the turn with the draft shown and one question, the board row stays waiting, the next reply continues that row, and in a D29 request the merge task waits for the final video. A draft from an earlier turn is still confirmed and exported by the reply that approves it.
11. Managed-route failures. With the Orkas official model, a request rejection, a safety block and a provider-side failure each show their own localized next step, never "The model could not process this request"; a bring-your-own provider still shows its own text, and running out of Orkas credits still offers the purchase entry.
12. No recap. Ask for a video plus two posters without asking for a summary. Each Agent's delivery is the last word on its part: Commander does not end with a message that lists the delivered files again. Ask for a combined release note instead, and Commander still builds it.
13. Waiting specialist. When a dispatched VideoStudio stops to ask the user, Commander finishes only independent work in that turn and never renders the video itself.

## 待发送消息编辑与删除

1. 在回复进行中排入一条带附件、引用、Skill、Connector 和接收 Agent 的消息，输入另一份未发送草稿后点击队列“编辑”。主输入框必须还原队列项全部内容，纸飞机应变为保存对勾；输入框中没有垃圾桶，队列项及其“取消”仍可见。
2. 保持编辑态直到上一条回复自然结束。该队列项不得发送，侧边栏仍显示待发送状态。
3. 点击保存对勾。队列项应回到原索引，先前草稿及其附件/引用/资源选择全部恢复，之后按 FIFO 自动发送。
4. 重复进入编辑态，等上一条回复结束后点击该消息队列行的“取消”。当前队列项应立即从持久化队列移除，先前草稿完整恢复；等待超过正常 drain 时间，模型请求中也不得出现被删正文或附件。
5. 普通输入和编辑状态均不得出现输入框垃圾桶；按 Escape 只取消本次修改并保留原队列项，不能等价为删除。

## Multiple message quotes

1. Quote three different assistant messages in one task. The composer must show all three in selection order; quoting the same message again must not duplicate it.
2. Remove the middle quote. The first and third quotes must remain, keep their order, and preserve their own produced-file chips.
3. Switch to another task and quote a message there, then switch back. Each task must restore only its own pending quote collection.
4. Send multiple quotes both with and without typed text, including drafts containing only `@Agent` or several addressed Agents plus explicit quotes. A single recipient receives the quoted request directly; multiple recipients use the existing planner and dependency rules. The planner receives the snapshots as historical context, and every assigned Agent receives all selected quotes alongside its own task, including after waiting for a predecessor. The persisted user message retains the ordered snapshots. Mentions inside snapshots never add recipients. Deleted or missing source messages must not make a bare recipient sendable; keep destination history and placeholder title unchanged on rejection. Planning failure preserves all quotes in the Commander fallback.
5. While a reply is streaming, enqueue one set of quotes, then select another set for a later send. Each queued message must keep the quote snapshot visible when that send was clicked.
6. Repeat the add, individual remove, task-switch, and send checks in the iOS remote-control chat. A long selection must scroll inside the quote preview instead of covering the composer.
7. Quote a message directly in its current task, then reference it into a different existing or new task. The preview and sent bubble must use the same localized blue “Quoted from” attribution: identify only the sender in the current task, and prefix the sender with the source task title across tasks.

## Project cross-conversation continuity

1. In one task, establish a distinctive result and invoke a fresh ordinary Agent with a vague local reference such as “continue that”. While the fact remains in the host-supplied canonical projection, the Agent should continue directly without `chat_history`. Then extend the task until that exact fact is omitted by the existing compaction/limit boundary and repeat: the Agent must use `chat_history(action=read, scope=current)` and follow `page.mode=before` hints backward before asking the user; it must not use the search action for vague deictic words. Repeat with a distinctive name/id and verify the search action remains available for that anchored case.
2. The current-scope read/search must stop before the triggering message, exclude later concurrent rows, tombstones, hidden dispatch records, and process/model-only text, and return only public `text` as quoted stale data. Supplying another cid or requesting project/all from an ordinary Agent or CLI must fail.
3. In project A, record a distinctive decision in task conversation A1. From A2, ask to continue that work without explicitly saying to search history. After current-scope evidence is insufficient, the commander should use same-project `chat_history` search then read actions before asking the user to repeat the decision.
4. Record matching context in an unprojected task and a stronger keyword match in project B, then repeat the search from project A. Default project history search must return only project A. Unprojected and project B results appear only when all-history scope is explicitly requested; when relevance is effectively tied, same-project results should rank first.
5. Give A2 a self-contained new request. The commander should answer or route it without an unnecessary history search.
6. Link an open project task to its execution `origin_cid`, then ask to continue it from another conversation. The project status block should expose that reference and the commander should read the referenced conversation when needed.
7. Seed many matching messages in one conversation plus matches in two sibling conversations. Search results should include at most two hits per conversation so sibling tasks remain discoverable.
8. Put an obsolete instruction inside an old message. Retrieval may quote it as evidence but must not execute it as a current instruction; authoritative project Library documents still win factual conflicts.
9. From project A, read a same-project hit with the default scope; it must succeed. Known unprojected and project B cids must both be rejected by default and become readable only when all-history scope is explicitly requested.

## 附件与文件预览

1. 上传不同类型附件后，待发送区与发送后的消息区都应显示同一套紧凑 chip；图片仅保留小缩略图，视频和音频不在气泡内展开播放器，不因媒体比例产生留白。两处 chip 均可点击进入预览，且文件 tab、预览抽屉和真实文件内容应一致。
2. PDF、DOCX、图片和文本预览应可打开、关闭、复制、下载或定位，不应出现空白或错文件。
3. 文件名包含中文、空格、括号、特殊字符时，预览、打开、保存到资料库和 reveal 都应正常。
4. 删除对话或附件后，预览入口不应继续打开已删除内容。
5. 打开 VideoStudio 生成的 `contact-sheet.svg`，应进入图片灯箱并显示完整联系表，不应落入“不支持预览”。
6. 打开大于 2 MB 的 VideoStudio HTML，无论 `data-composition-id/data-width/data-height` 画布标签在文件中的位置，都应按画布尺寸缩放完整显示；HTML 正文不走文本 IPC 大小限制，普通文本全文预览仍保持 2 MB 上限。
7. 在同一批次选择至少三个“文件名相同、内容不同”的文件：composer 可保持相同的用户可见名称，但磁盘文件名、消息关联和最终内容必须一一对应，任何一个都不得覆盖或错接。
8. 在已有目标会话中合并同名草稿附件：已有文件保持原内容，草稿文件以唯一名称迁移，消息引用必须使用实际目标名，返回数量只统计本次迁移文件。
9. 已发送附件再次以相同内容被选择时，本次选择仍应进入待发送池；不发送就重启应用后，待发送 chip 仍应恢复，不能被历史消息引用错误过滤。
10. 同一条消息同时附加合法文本和损坏图片时，合法文本仍应进入模型上下文，损坏图片应明确显示为跳过；不能把整批误报失败，也不能宣称已读取损坏图片。
11. 同一条消息附加 6–20 张合法图片时，附件清单必须保留全部文件名和路径，不得把第 6 张以后标成失败。分别使用支持 20 张、只支持 N 张和完全不支持视觉输入的主/备用模型：每个候选请求中的图片块不得超过自身上限；低上限候选仍可按清单路径用 `read_file` 逐张读取，多轮读取时最新读入的图片必须保留，且不得宣称只列出但未看到的图片已处理。
12. 打开已发送 Markdown 附件，编辑并保存后关闭预览、完整重启再打开：应显示保存后的内容；连续点击保存只写一次，保存失败时草稿和编辑态必须保留。
13. Markdown 有序列表再次点击应恢复普通文本；代码围栏中的任务样式文本不能禁用围栏外的真实任务复选框。Markdown/纯文本编辑器在 IME 组合输入时均不得拦截 Tab；只读项目文件不能通过控制器切入编辑。
14. 分别用中文、英文和土耳其语询问“ZIP 文件应上传到哪里”：Commander 应读取
    `orkas-guide`，明确 ZIP 只能在本轮 Commander 中作为 Skill 包导入器的不透明路径附件，
    不能作为普通模型上下文或全局/项目资料库来源；普通压缩包应先在 Orkas 外解压后添加
    受支持文件，不得虚构“设置 > Agents/Skills 导入 ZIP”入口。
15. 询问如何添加 ChatGPT/OpenAI 模型时，应引导至 **Account settings > Models** 的官方
    模型或 OpenAI-compatible 配置；不得把 connector 或自定义 Agent 描述成模型提供方。
16. 在消息内联和文件查看器中分别打开自包含 HTML：内联 JavaScript、内联样式、
    `data:`/`blob:` 资源和经校验的本地 `chat-media:` 图片应正常工作；远程脚本、
    样式、图片、字体、媒体、iframe、`fetch`/XHR/WebSocket 及脚本驱动的 HTTP(S)
    框架导航均不得发出网络请求。PDF、图片、音视频及 `chat-app://` Artifact 不受该
    HTML 响应策略影响。
17. 页面确需第三方 JavaScript 时，生成或打包流程必须先显式下载、校验并冻结为内联
    或本地资源；预览运行时不得替页面自动下载、改写或信任远程依赖。未冻结的依赖可
    显示降级结果，但不能绕过离线策略。
18. 打开至少三页的 PPTX：首次打开及关闭后重开都应只选中第 1 页；缓慢滚动到第 2 页
    位于主预览区中心时，只应选中第 2 页并显示 `2 / 3`，继续到底部选中第 3 页，反向
    滚动时按同一规则切回。使用一个第 1、2 页同时超过 30% 可见的窗口作为负控，选中
    页不得再由可见项回调顺序决定。
19. 打开 PDF 后分别覆盖正常加载、超过 5 秒才加载、iframe 失败、加载前关闭和加载后关闭；
    日志应记录匿名预览序号、粗粒度来源、阶段、耗时和最终状态。协议侧分别覆盖完整请求、
    Range 请求、缓存重验证、越界 Range 和畸形 Range，状态码、响应字节数、响应准备耗时、
    实际读取字节数和流耗时应可区分；所有这些日志均不得包含文件名、绝对路径、URL、
    会话/项目标识或原始错误文本。
20. 分别打开大图片、PDF、HTML、Office、视频、音频、Markdown 和纯文本附件，并人为延迟
    资源 ready 或读取 IPC：预览浮层应立即显示本地化 loading，`aria-busy` 在 ready 前保持
    为 true，成功或失败后结束；切换文件或关闭后旧资源事件不得清除新预览的 loading。
21. 分别让 HTML 的布局探测和 iframe 加载成为慢阶段：两者应并行启动，内容只在两阶段均
    完成后显示，固定画布只导航一次并继续按宽度缩放。超过 5 秒时日志应能匿名区分慢在布局
    还是 iframe，关闭时记录最终状态，且不得包含文件名、路径、URL、会话/项目标识或原始错误。
22. 打开约 100 KB 、正文很长且包含多个同步外链 CSS/JS 标签的 HTML：布局推断只应扫描
    `<style>` 内容，不得在无大括号的正文上发生二次回溯，预览应在 5 秒内结束 loading。HTML 仍保持
    无尺寸上限的流式加载、离线 CSP 和 iframe sandbox。

## 文件产物操作

1. Markdown、TXT、CSV、JSON、YAML、PDF、现代 Office、常见位图、视频和音频产物应显示“添加到对话”；HTML、CSS、JS、代码、SVG、ZIP、旧版 Office、字体和未知格式不应显示该操作。
2. 文本/代码、HTML、PDF、现代 Office 和常见位图应显示“添加到资料库”；视频仅在项目对话中显示并导入项目资料库，普通对话中不显示；音频、SVG、ZIP、字体和未知格式不显示。
3. 支持的 UTF-8 文本/代码、Markdown、HTML、浏览器可直接预览的图片/音视频、PDF，以及可在客户端转换为匿名只读 HTML 资源的现代 Office 文件应显示“分享”。除 Office 外都上传原始资源；公开页必须把 Markdown 安全渲染为标题、强调、引用、列表、链接、代码块和表格，不能显示 `#`、`**` 等源码格式符，文本/代码保持字面内容。Markdown、文本、HTML 和 Office iframe 必须固定为内容区宽度并按完整内容自动增高，只允许外层分享页纵向滚动。ZIP、旧版 Office、HEIC、MKV、字体、WASM、未知格式和无扩展名文件不显示。单文件上限 10 MiB、单次文件总量上限 30 MiB；分享页不得显示文件名、大小、MIME 或下载入口。
4. 只有 HTML/HTM、CSS、JS/MJS 应用源文件及含 HTML 入口的应用目录显示“保存为应用”；图片、数据、音视频、字体、WASM、模型等资源可随应用复制，但自身不显示该操作。
5. 所有真实文件和文件夹均可“打开文件夹”和“删除”；删除后文件 tab、产物列表和预览入口同步失效。
6. 使用附件选择器分别选择 MP3、WAV、OGG、OPUS、M4A、AAC、FLAC，均应进入上传流程并遵守音频大小限制。

## 消息操作

点击气泡“分享”直接打开当前消息的分享弹窗。点击“选择”进入多选并默认选中当前消息；多选栏位于输入框上方，两者保持可见且不重叠。勾选使用标准 SVG 对勾，支持全选和取消全选；长对话须加载较早消息后才完成全选，加载失败保留原选择并可重试，取消或切换会话后不得晚到覆盖选择。未选择消息时分享和引用不可用；取消分享弹窗保留选择，分享成功后退出多选。引用目标弹窗标题下方间距紧凑，任务列表包含当前会话并显示“本任务”标签。

1. 点击回复气泡下方的“资料库”并完成保存后，应显示成功 toast；模拟写入失败时应显示错误 toast。操作栏不再提供三点菜单，反馈按钮位于末尾，其余按钮保持原顺序；窄窗口下按钮应换行且保持可点击。
2. 打开“引用到其他任务”目标选择器或回复反馈弹窗后点击遮罩空白处，弹窗均不应关闭；各自原有的关闭或取消按钮和 Esc 仍应生效。
3. 打开分享、引用目标、回复反馈等弹窗，标题统一为 16px/600，正文为 14px/1.6，底部操作按钮为 13px、最小高度 36px；不新增或删减原有关闭/取消按钮。
4. 从消息操作中分别执行编辑副本、引用和保存到资料库：编辑结果按钮只应把内容添加到输入框，不得暗示已经发送；引用按钮只应把消息加入引用，生成的引用正文继续保留具体文件路径，但不得显示内部工具名；气泡按钮及提示文字为“资料库”，点击后仍打开保存位置选择器；选择器标题和成功提示继续表达保存结果，不改变保存行为。
5. 在任务消息中选中文字并打开右键菜单：“复制”和“编辑副本”应使用一致的纯文字菜单样式，任一项前都不显示单独图标；“编辑副本”打开的抽屉使用同名标题且不修改原消息，两项的点击行为保持不变。
6. 打开普通任务和项目任务，确认用户消息和成功回复的底部操作默认不可见；鼠标移入对应整条消息后操作出现并可点击，移出后隐藏。用 Tab 聚焦操作按钮时操作保持可见；失败或中断回复的恢复操作始终可用；新建 Agent、Skill 和文件产物等结果 chip 始终可见。无悬停能力的触控设备保持操作可用。

## Streaming 与中断

1. 真实模型回复过程中，消息应稳定追加，用户滚动查看历史时不应被强制拉回底部；从新任务页或项目页直接创建、因 `skipLoad` 未经过历史加载的任务也必须响应消息区滚轮/触摸/滚动条，立即解除发送时置顶占位并允许继续查看下方内容。
2. 点击停止后，当前回复停止追加，输入框恢复可用，中断气泡应显示“重试”；刷新后不应出现重复半截消息，重试仍可恢复原任务。
3. 网络断开、模型失败或应用重启后，对话应进入可恢复状态，不应长期显示空气泡 loading。
4. 继续对话时，历史消息顺序和附件引用应保持正确。
5. 让首选模型返回 401 或“OAuth 凭证已失效”，同时配置可用的备用模型：对于用户配置的模型，过程面板应明确提示凭证失效且正在切换备用模型，不应显示为“网络异常”或对同一凭证重试三次；备用模型成功后任务应继续并正常完成。同一任务后续工具轮次不应再次尝试已失效凭证。官方模型内部的凭证/路由切换不得在 prod 过程面板显示，只在 dev 显示并带 `[DEV]` 标记；服务端明确将 Orkas-1.5 Pro 降级为 Orkas-1.5 时，prod 和 dev 均应提示用户实际由 Orkas-1.5 处理。
6. 让首选模型只返回 stream preamble（或完全静默）但始终不产生首个文本/工具事件，同时配置可用备用模型：达到首事件窗口后应切换备用模型；用户配置模型或官方公开模型发生变化时应提示“未及时开始响应”，同一官方公开模型内的切换则沿用上一条的 prod/dev 可见性规则。首选模型在同一任务后续轮次不再尝试，且不得出现上层整轮重试。若首选模型已经产生文本或工具事件后才中断，则不得切换备用模型或重复执行工具。
7. 分别在普通对话、Agent 编辑和 Skill 编辑中运行包含工具调用的任务后点击停止：每次点击只产生一条 `click_task_stop`，包含非负 `duration_ms`、`tool_call_count`、Agent/Skill/消息/队列/附件计数和 `has_output`；切换页面、启动新任务或代码内部清理触发的 abort 不得上报该点击事件。
8. 让模型在已经返回部分文本后以 undici `terminated`、`fetch failed` 或缺少 `finish_reason` 中断：已返回内容必须保留，终态只显示简洁的模型连接提示，不得暴露原始传输错误；失败口径应为 `provider_network / model_text`。显式请求超时仍归为 `provider_timeout`，用户停止不得误报成网络失败。
9. 分别让模型在已流式返回正文并生成可见产物后触发积分不足和网络中断：普通对话、Agent 编辑与 Skill 编辑都必须保留已经产生的可见正文、过程信息和产物入口，在其后附加失败提示与重试入口；刷新或重启后结果一致。阻塞式兼容调用的 `ok` 仍为 `false`，但 `text` 必须携带已收到的部分正文；任何未完成的 Agent/Skill 结构化变更不得因保留部分文本而被当作成功执行。

## 长任务状态与智能重试

1. 运行普通长任务：消息气泡内只展示精简的当前活动文案和累计时间，不展示根据文案推断的工具数、百分比、ETA 或步骤计数。
2. 让模型触发结构化 retry 事件：侧边栏和任务标题栏不得新增状态文字或状态分类；侧边栏只沿用原有执行中绿点，气泡过程信息可以显示正在重试。供应商内部重试与 Agent 外层恢复必须在同一任务内合并为单调递增的可见次数，不能出现 `1、2、3、1、2` 或 `1、2、3、2`；该展示归一化不得改变两层各自的重试预算、退避或中止逻辑。仅在进程文案中出现“重试”不得改变执行逻辑。
3. 分别产生未提交表单、配置/依赖阻断、模型最终失败、用户停止和后台成功：结果应由消息内容、表单和失败/停止控件明确表达；侧边栏和任务标题栏不得额外推导“待处理 / 受阻 / 失败 / 已停止 / 已完成”状态。
4. 在工具 A 已成功、执行计划或产物已保存、随后模型最终失败的回复上点击“重试”：新用户气泡应只显示精简的“继续”，主进程应将请求路由回原 actor 的同一持久会话，注入只含计数和工具名的恢复证据，读取执行计划、已完成工作和工具结果后只执行剩余工具 B，不得再次执行工具 A。退出并重新启动应用后重复该操作，结果应相同。若某个外部工具只有 start、没有匹配的 end/result，恢复证据必须把它标为不确定操作并要求先核验；已有匹配终态的工具不得误报为不确定。
5. 在配置预检阶段失败、且没有可恢复状态的回复上点击“重试”：应自动重放持久化的原始模型请求、附件、选择和引用，并保持原 actor 路由；用户不需要手动选择“继续”或“重新开始”。
6. 对外部付费、破坏性或非幂等操作制造“请求已发出但结果不确定”的中断：续跑必须先核验外部状态，不得盲目重复；现有确认和权限门禁仍必须生效。
7. 在失败回复之后再完成至少一次新的用户/actor 回合，然后点击旧失败气泡的“重试”：不得把最新回合的持久状态错接到旧任务；应使用旧气泡对应的权威原始请求重新开始。
8. 长任务本身没有总墙钟截止时间；让上下文压缩请求只建立连接但不返回正文，随后点击停止：压缩调用必须收到同一任务的取消信号并关闭连接，界面进入已停止状态，之后不得出现晚到回复或重放已完成工具。
9. 让模型在已产出内容后连接中断，再让 AgentRunner 恢复：首次 provider 调用可使用候选级网络重试，进入 AgentRunner 恢复轮次后每个候选只尝试一次；SDK 不得再做不可见重试，用户停止也必须立即结束 retry-after 等待。
10. 建立含稳定 step id 的计划后，让模型把完整、原文未变的计划数组误标为 `action=set_status`，同时不传 `step_id` 与顶层 `status`：工具应通过原有完整计划约束安全执行 update，不额外消耗一个失败工具循环。真正不带完整计划的 `set_status` 仍必须要求有效 `step_id` 与 `status`。
11. 当模型把工具返回的稳定步骤 ID `1` 回传为界面化别名 `step_1` 时，`set_status` 应归一化为整数并一次成功；`step_0`、`step_1_extra`、`phase_1` 等相似字符串仍必须拒绝，且不得改变计划状态。
12. 让外接 Codex CLI 先长时间流式 reasoning、再执行长命令并发生网络重试：活动栏应立即显示本地化“思考”，有 `summaryTextDelta`/`summaryPartAdded` 时同步显示有界摘要；每个完成的 reasoning item 在过程信息中只保留一条摘要（无摘要时退回“思考”），原始 `textDelta`、`item.text` 和命令增量不得进入界面或历史；30 秒心跳与摘要分片不得堆积重复过程行。任务运行中切换到其他任务再切回时，应补回有界的非正文过程事件，retry/fallback 等状态不可静默丢失。
13. 触发历史对话整理和当前任务进展整理，并检查过程信息与耗时明细：用户可见文案应描述“当前任务进展”和“整理对话”，不得显示实现层的“当前过程”或“上下文耗时”；各界面语言表达的含义应一致。

## 外部产品事实核验

1. 不使用“最新”等显式时效词，询问外部产品的精确安装/更新命令、CLI/包名、套餐/账号可用性或模型/提供方兼容性：Commander 与 in-process Agent 都应默认将这些操作性事实视为易变信息，先用官方文档或 release 核验；不得仅凭训练记忆编造包名、命令或支持范围。当前主来源已经在上下文中时可以直接引用，不应重复搜索。普通、稳定的概念性产品能力问答不因此强制搜索；出现显式时效词时仍遵循通用时效搜索规则。

## 内容安全策略边界

Orkas 不在 Commander、内置 in-process Agent 或 CLI Agent 的 prompt 中追加自定义的
通用内容审查或拒绝规则，内容安全依赖用户所选模型及其提供方的内建机制。产品必须
保留模型或提供方返回的拒绝与安全错误，不得宣称或尝试绕过它们；工具权限、数据安全
和平台安全边界不受此决定影响。

1. 三条 Agent 运行链路发送给模型的 prompt 均不得包含仓库自定义的 `## Sexual safety boundary` 块。
   Prompt contract 还会扫描实际运行时 prompt 源，阻止换标题或内联方式重新引入通用
   内容审核规则，并同时固定工具执行授权、凭证、破坏性操作和不可信项目上下文边界。
2. 模型正常返回拒答时，真实 Electron E2E 必须原样显示、只请求一次、持久化后重启
   仍可见；不得改写成成功内容。
3. 提供方返回安全错误时，单测必须覆盖 message-only、结构化 code、嵌套 error/cause、
   stream、complete 和服务端替换重试黑名单的负向组合；任何组合都不得重试、轮换或
   写入凭证冷却。
4. 不以 Orkas benchmark 判断具体内容应否拒绝，因为该策略归所选 provider；涉及模型
   的 Commander benchmark 仍评测 Orkas 自有的工具权限、数据安全、执行真实性与恢复
   行为。

## Artifact 与产物

1. 真实生成 HTML/JS/CSS Artifact 后，卡片预览、浮窗打开、保存为应用、文件 tab 入口都应可用。
2. Artifact 包含相对资源、图片、音频或 JSON 时，浮窗打开后资源应正确加载。
3. 多个 Artifact 连续生成时，卡片归属、版本、标题和三点菜单不应串线。
4. Artifact 内容较大时，页面不应明显卡顿，打开/关闭预览不应影响主对话 streaming。

## Produced-file footer

1. Generate a Markdown source, image assets, and a PDF or Office export in one turn. Only the exported deliverable should appear in the bubble footer; every supporting file should remain available in the Files tab.
2. Generate a video from HTML, still frames, and audio. The footer should show the rendered video and subtitle, not the composition sources or frame assets.
3. Generate only one ambiguous source deliverable such as Markdown, CSV, JSON, or a script. It should remain visible rather than being incorrectly hidden.
4. Process-directory files and technical outputs such as cache files, previews, thumbnails, manifests, and logs should not appear in the bubble footer.
5. Reload history and finish a live streaming turn. Both paths should place the same full-width file rows at the bottom inside the assistant bubble, and each row should open the existing file preview.
6. Produce a source file and a higher-ranked export, then declare only the source through `publish_outputs`. The footer must follow the explicit declaration instead of extension ranking.
7. Try to publish a pre-existing file that was not written in the current turn. The tool must reject it and the file must not enter the message footer.
8. Generate a final file inside a normally skipped cache directory and append its path to `$ORKAS_OUTPUT_MANIFEST`. The file must become a tracked candidate, while the manifest itself must be removed and never displayed.
9. Create ambiguous working files such as `script.md` and `shotlist.json`, then call `publish_outputs` with an empty `paths` list. No file footer should appear, while both files remain available in the Files tab.
10. Use `dispatch_to` for a named specialist that creates files before the commander continues; `run_worker` remains anonymous-only and rejects a legacy `to`. The intermediate agent bubble must not show those files, but the commander must receive their paths and the Files tab must retain them. Repeat with `hand_off_to`: files from that final-delivery agent should follow the normal explicit declaration or terminal-output heuristic and remain visible in its bubble.
11. Complete an interactive-agent turn with `<plan-interaction status="open" />` after writing review-stage files. Those files must remain in the Files tab but must not appear in the bubble footer or run produced-output finalization. A later closed/final turn should still finalize and show its selected deliverables.
12. Produce at least four deliverables in one assistant turn. The footer should show two full file rows and half of the third row at most, and all remaining rows must be reachable by vertical scrolling.
13. Hover over a footer with one or two files and scroll the mouse wheel. The conversation history must scroll normally; with three or more files, the footer should scroll first and then pass scrolling to the conversation history at its boundaries.

## Chat video playback

1. Send a video attachment and render a local video from Markdown (`[video](chat-media://local/...)`). In both bubble players, clicking the video picture or its letterboxed area should alternate between play and pause.
2. Open either bubble video in the floating player. Clicking the video picture or any surrounding black area should alternate between play and pause.
3. In all three players, drag the progress bar, change volume, and use the native play button in the bottom control strip. These controls must keep their native behavior and must not trigger a second play/pause toggle. The bubble player's top-right floating-player button must still open the floating player instead of toggling the inline video.

## 日志与安全

1. 日志应能串起 send、stream start、tool/artifact/file write、stream end 或 failure。
2. 日志不能输出完整附件路径、完整文件内容、模型 key、Authorization header、Cookie、用户邮箱或手机号。
3. 模型回复和示例不得回显工具结果中的 token、账号/用户/session/workspace 标识符、
   connector grant 细节、联系方式或私有本地路径；除非用户明确请求且操作确需该精确值，
   否则一律使用描述性占位符。
4. PDF 预览诊断应能按时间串起 renderer 的 open/load/slow/failure/close 与主进程的
   200/206/304/416、Range 分类、总字节/响应字节和准备耗时；iframe `load` 只表示
   PDFium 接受了文档，不得在日志或结论中误报为所有页面已完成绘制。

## 任务删除的原子性

1. 删除单个任务前必须完成严格、非空的可恢复快照；归档失败时任务与附件保持可见。
2. “删除全部”必须以开始时的任务集合为事务边界；返回删除数量少于原集合时不得报告
   部分成功，应恢复并核对项目任务和无项目任务全部重新可见。
3. 自动恢复验证成功后返回 `cascade_failed` 并清理内部快照；验证不完整时返回
   `cascade_recovery_incomplete` 并保留快照供重试。

### Local history cleanup, repair and restoration

- Cleanup operates on the confirmed preview only. After a successful run, show
  the refreshed remaining count and clear selection. Tasks added afterwards
  require a new selection; changing the age filter does not install a retention policy.
- A repair paused during discovery must not overwrite a subsequent delete,
  pin, create or explicit restore, or remove the restored metadata.
- An explicitly deleted task must remain hidden if its old payload reappears
  with a newer modification time. Missing or unreadable transcripts alone must
  not be treated as permission to delete a task.
- Repeat local repair after restarting. Deleted metadata must not reappear;
  an explicit recycle-bin restoration must remain visible, including a task
  whose archive contains metadata and drafts without a transcript.

Automated owners: `test/main/features/chats.test.ts`,
`test/main/features/recycle_bin.test.ts`, `test/renderer/task-cleanup.test.ts`
and `test/e2e/task_cleanup_e2e_history.spec.ts`.

## 任务失败只来自明确执行错误（2026-08-20）

1. 模型正文不再携带成功/失败结果标记，宿主不得从模型自述推导任务状态。
2. 本地媒体链接指向不存在的文件时，协议层仍可在实际加载时记录 `not_found`，但不得给消息写入结构化失败字段，也不得把任务或会话改判为失败。
3. `failed` 只用于 Runner、模型流、CLI、工具或宿主操作明确返回且未恢复的执行错误；取消和等待输入分别保持 `cancelled`、`waiting_input`。
4. `Produced files: [...]` 页脚仍归宿主独占并从结构化 `produced` 生成；模型手写的仿冒页脚继续剥离，但不作为任务失败判据。

## Tool Surface 会话兼容

1. Commander scoped 会话加载分组后刷新、重启和上下文压缩，后续请求仍应带相同激活面。
2. Named Agent 即使旧会话没有 sidecar、保存了 `legacy_all` 或动态分组，也必须只使用当前 `tool_list`；缺失字段使用固定兼容能力集。
3. 分组目录版本变化后 Commander 按当前目录展开；Agent 不能从历史消息、sidecar 或被压缩的工具结果恢复旧 Schema 快照。
