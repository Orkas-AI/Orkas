# 多 Agent 编排人工回归 Case

## 范围边界

本文件只覆盖“任务执行时”的人工判断：指挥官如何拆计划、如何分发给 Agent / Skill、如何恢复中断、消息是否挂载正确、文件产物是否串起来。

不在本文件重复验证智能体资产管理能力，例如创建/编辑智能体、分类筛选、平台上传、云同步、回收站、配置保存。这些归属 `agents-regression.md`。

## 基础准备

1. 准备至少 3 个已配置好的智能体：信息搜集、分析整理、质量 Review；图标/颜色不同，便于观察消息归属。
2. 准备至少 2 个已启用 Skill，其中一个用于搜索或资料整理，一个用于文档或代码 Review。
3. 准备 1 个带输入表单的智能体、1 个设置为数据看板输出的智能体、1 个设置为交互应用输出的智能体。这里只验证编排执行是否正确使用这些配置，不验证配置保存本身。
4. 确认模型授权、搜索、文件读写、bash 或本地工具权限处于本轮回归需要的状态。
5. 使用新建任务或干净测试会话，避免旧计划、旧 `in_flight`、旧附件污染判断。
6. 打开任务详情面板，同时观察对话顶部执行计划、任务详情-计划 tab、消息区、文件 tab 和工作区目录。

## 真实模型编排与分工

1. 输入一个需要多 Agent 协作的复杂任务，观察指挥官是否先生成合理执行计划，而不是让单个 Agent 直接完成全部任务。
2. 计划步骤的执行者、任务描述和依赖关系应符合用户意图；明显不合理的拆分、重复步骤或漏掉关键步骤需要记录。
3. 多 Agent 执行时，人工判断每个 Agent 是否按自身职责完成任务，是否出现任务串线、重复劳动或互相覆盖结论。
4. 指挥官最终汇总应整合各 Agent 结果，说明关键来源和失败/风险点，不应只拼接最后一个 Agent 的输出。

## 输出约束在编排中的生效

1. 在同一复杂任务中分别调度普通回复、数据看板、交互应用三类智能体，确认最终消息形态与被调度智能体的配置一致。
2. 指挥官需要自动选择展示方式时，人工判断是否符合任务语义：说明/总结用纯文本或 Markdown，结构化指标用数据看板，需要点击/输入/筛选/计算时用交互应用。
3. 要求“只输出 JSON / 固定章节结构 / 不要解释”时，确认约束传递到被调度智能体，且最终汇总不破坏用户明确要求。
4. 要求输出文件时，确认模型确实通过文件或附件机制产出，而不是只在聊天中声称已经生成。
5. 输出很长时，观察模型是否合理摘要或写入文件，消息区不应出现明显卡顿或不可读的大块内容。

## 输入表单与人工阻塞

1. 在计划步骤中调度带表单的 Agent，确认真实 UI 中表单字段、默认值、说明、必填标记和提交区视觉可读。
2. 必填项留空后，应看到清晰、不会遮挡输入区的错误提示；修正后提交应继续后续步骤。
3. 表单提交后，下游步骤应继续执行；原表单应呈现已提交态，刷新或重新进入会话后不应重新变成可提交。
4. 包含文件/目录输入时，确认真实文件选择、权限提示、上传等待和提交后的附件显示符合预期。

## 工具、Skill 与文件链路

1. 运行一次需要搜索、读取文件、写入文件、调用 Skill 的真实任务，观察过程信息是否能说明关键动作。
2. 关闭某类工具权限后再次运行相关任务，应看到明确权限提示；恢复权限后任务可继续正常执行。
3. 上游步骤生成多个文件后，下游步骤应能引用这些文件；文件名包含中文、空格或特殊字符时也应可读。
4. 写入产物应同时能在消息附件 chip、任务详情-文件 tab 和工作区目录中被人工确认。
5. 删除或覆盖文件类操作如需确认，必须先出现用户确认入口；未确认前不能执行真实删除或覆盖。
6. Read a custom, marketplace/builtin, agent-private, and hidden system `SKILL.md`, plus custom and marketplace/builtin `agent.json` files. Both the start and completion rows in process information must show the resource label and leaf filename, never the absolute internal path or a raw `<persisted-output>` marker.
7. Run `web_search` through Orkas Search, a configured third-party provider, and the keyless fallback. The completion row must keep the stable `web_search` tool name and prominently show the provider that actually returned the result, including after refresh or app restart.
8. Delay a model tool call after its name/id is announced but before its arguments finish streaming. Process information must immediately show one localized “Started” business action, enrich that same row when the safe target arrives, and replace it with Done/Failed on completion. Parallel same-name calls that finish out of order must keep separate rows; duplicate delivery or a late progress event must not regress a terminal row. `event-mapper.test.ts`, `conversation-sidebar.test.ts`, and `chat_e2e_model_stream.spec.ts` provide deterministic protocol, DOM, and real Electron pipeline coverage, including missing-id and `@skill/<ref>` counterexamples.
9. Replay a local CLI completion that arrives without a preceding start event. Live and restored process information must still show the bounded, redacted command target or leaf filename, expose a clear result-expansion affordance when output exists, and keep the full result out of the row text. Mouse click, Enter, and Space must expand/collapse the same result with accurate `aria-expanded`; failed tool results retain the failure style. A write completion must also produce the normal attachment/file bookkeeping, but cwd-external or traversal paths are display-only and never claim an in-project file. Spilled results persist only an opaque content ref in the conversation; their machine-local absolute path must not enter cloud JSONL or restored DOM. Repeated generic running milestones must collapse without collapsing distinct keyed tool calls.

## 中断、停止与恢复

1. 真实计划执行中点击“停止”并确认，当前输出应停止追加，后续步骤不应继续自动分发。
2. 制造真实失败场景，例如断网、关闭应用、模型临时不可用或本地工具失败；恢复后计划应进入可继续状态。
3. 点击“继续”并确认后，已完成步骤的消息、文件和摘要应被复用；失败步骤允许重新执行，但不应从头重跑已完成步骤。
4. 应用重启后，任务详情-计划 tab、对话顶部计划条和消息区状态应一致。
5. 恢复执行后重点观察是否出现历史消息重复、旧消息插到新消息下方、空气泡长期 loading 或附件 chip 重复。

## 用户定义的阶段批准门禁

1. 创建四阶段任务，并明确要求“每完成一个阶段先给简报，收到继续或批准后才能进入下一阶段”。阶段一完成后发送一次 `go`，本轮最多只能完成阶段二、给出阶段二简报并再次等待；不得同时推进阶段三。
2. 在阶段二执行中制造模型或工具失败，再发送一次 `继续`。本轮只能恢复、完成并汇报阶段二；恢复指令不得被解释为放弃后续阶段门禁。
3. 连续逐次批准直到阶段四，确认每次批准只推进一个阶段，计划状态、过程信息和最终回复均不提前声称后续阶段已完成。
4. 创建相同的四阶段任务，但只要求按顺序完成并交付最终结果，不要求阶段间暂停或批准。指挥官应在一轮内完成全部已授权范围，不得自行增加确认点。

## 项目上下文权威与记录隔离

1. 在项目说明中保存一个默认输出规则，例如“发布摘要使用英语”；随后在当前对话明确要求“这次使用中文，但不要修改项目说明”。本轮必须按中文交付，保存的默认规则保持不变，并说明这一轮存在冲突。
2. 在项目待办标题、项目记忆和可检索的历史对话中分别放入类似指令的文本。让指挥官继续一个正常项目任务，确认这些文本只作为记录呈现，不被执行，也不覆盖当前请求。
3. 为进行中的项目任务保留 `origin_cid`，在新对话要求“继续之前的方案，不要让我重复背景”。指挥官应读取已知历史引用并继续，不应要求用户重述已有上下文。

## 长周期与长流程

1. 使用 4 步以上、至少 2 个 Agent、1 个 Skill、1 个表单输入和 1 个文件产出的任务，连续执行 10 分钟以上。
2. 长流程中多次切换侧边栏、任务详情 tab、文件 tab、其他任务，再回到当前任务，状态应保持准确。
3. 长流程中手动折叠/展开执行计划详情，不应影响实际执行。
4. 应用短暂失焦、系统睡眠恢复或网络短暂抖动后，应能继续展示真实状态，或清晰进入可继续状态。
5. 长流程完成后，执行计划应达到完成态，最终回复应覆盖所有关键步骤结果。
6. 模型执行过程中记录活动条耗时，随后切换到其他任务再切回、触发历史刷新或断线恢复；同一轮执行的耗时只能继续递增，不能归零或倒退。系统时钟校准后也应保持单调递增。

## Run budgets and convergence

1. A normal agent run uses the 100-round default budget, receives its convergence instruction at the relative 80% threshold (round 80), and may execute at most 100 completed rounds before returning a concise, resumable status. Explicit lower per-run overrides must retain the same relative-threshold behavior. The execution plan and checkpoint must remain available for Continue; completed work must not restart.

## Context pressure and oversized tool results

All mechanism behavior is owned by the independent
`npx tsx eval/context-mechanism/run-benchmark.ts` suite. Use `--validate` for
inventory/fixture checks and `--deterministic --no-save` for the complete
no-network runtime suite. Do not duplicate its threshold, compaction, Result
Store, failure-control, or restart assertions here.

`test/e2e/context_e2e_continuity.spec.ts` additionally drives three real
large `read_file` results through the desktop model pipeline, requires an
actual active-context compaction, verifies all exact decisions reach the final
reply, checks the process rail has one completion event, and confirms a full
app relaunch neither duplicates the reply nor replays model/tool work.

Manual orchestration regression only verifies presentation that deterministic
automation cannot fully judge:

1. Persisted-output previews remain expandable and readable with realistic large, multilingual source material.
2. Explicit incomplete-prefix and context-overflow errors explain what was retained, what was lost, and the smallest safe continuation action.

## 消息渲染与视觉体验

1. 真实 streaming 过程中，Agent 消息、指挥官消息、过程信息、附件 chip 和表单应挂在正确消息下，不应串线。
2. 同一个 Agent 的同一轮消息不应显示两次；最终回复应替换对应占位气泡，而不是新增重复气泡。**从新建会话发出第一条消息**时尤其要看：此时发送路径会先建一个还没有 turn id 的流式气泡，而指挥官若在同一轮里先叙述再嵌套派发（`dispatch_to` / `run_worker`），叙述分段的持久化记录必须落进那个已在屏幕上的气泡，不能在它旁边新增一条内容完全相同的。判断依据不是数气泡个数：打开开发者日志，出现 `keyed record found no live row` 即为异常，其 `unkeyed_content_rows` 应恒为 0。刷新后若重复消失、jsonl 里只有一条记录，说明是渲染层分叉而非数据重复。
3. 过程信息折叠/展开、复制、引用、资料库按钮在长内容和失败内容下仍应可用。
4. 数据看板、交互应用、表单、附件 chip 在同一任务内连续出现时，不应互相遮挡、错挂或重复渲染。
5. 窄屏、宽屏、中文、英文、日文界面下，执行计划条、统一控制按钮、任务详情、长 Agent 名称和附件 chip 不应互相遮挡。
6. 用户在消息区底部时，新 token 应自然跟随；用户手动滚动查看历史时，不应被强制拉回底部。
7. 指挥官把任务交给某个 Agent（尤其是 `hand_off_to` 前先 `read_file` 读了该 Agent 的 agent.json 规格时），只应看到一条指挥官叙述气泡 + 该 Agent 的回复气泡；指挥官不应额外多出一条“只有 read_file/hand_off_to 过程轨、没有正文”的空壳气泡。中断这类“只做了路由”的指挥官回合后，也不应写库/残留这条空壳气泡。必须把 Agent 响应卡在可控闸门上，分别断言：①有叙述的 `hand_off_to` 在 Agent **仍执行中**时始终只有一条指挥官气泡；②无叙述的交接在执行中始终没有指挥官占位气泡；③主发送流与 observer 重放同一 `hand_off_to:start` 时，去重必须先于边界解除/占位创建；④Agent 执行中刷新页面或切到别的 session 再切回来，从 jsonl + active turn 恢复后仍无重复；⑤任务结束、中断及冷启动历史重建后仍无空尾气泡；⑥`dispatch_to` 完成后指挥官确实继续综合时，新的合法气泡仍应出现在 Agent 回复之后，不能被交接抑制逻辑误删。

## 日志与诊断

1. 一次完整真实编排日志应能串起：用户输入、计划生成、步骤分发、Agent turn start、模型过程、步骤完成、下游分发、计划完成。
2. 失败日志应包含 cid、actor、step index、错误摘要和 transient/permanent 判断，方便定位。
3. 点击停止/继续时，应能在日志中看到 action、确认结果和后续状态变化。
4. 真实日志中不应出现模型密钥、OAuth token、Cookie、完整 Authorization header、COS 临时密钥或用户隐私明文。

## 建议人工回归提示词

1. `搜索下产品研发和代码相关的 agent/skill，做好分析和整合优化，然后进行质量 review`
2. `搜集整理用户增长相关的 agent 和 skill，先候选搜集，再深度分析，最后输出可迁移清单和 review`
3. `帮我分析当前项目中智能体编排相关代码，整理风险点、修复建议和回归测试清单`
4. `用多个智能体协作完成一个包含搜索、文件写入、分析、复核的长任务，中途我会手动停止后继续`
5. `先让一个智能体生成材料，再让另一个智能体基于材料做审查，最后由指挥官汇总`
6. `调度带输入表单的智能体收集必填项、可选项、单选、多选和文件路径，等我提交后再继续分析`
7. `调度数据看板智能体输出渠道指标，再让质量 Review 智能体检查结论是否充分`
8. `调度交互应用智能体生成一个可调整参数的 ROI 计算应用，并由指挥官说明使用场景`
9. `只输出 JSON，字段必须包含 title、risks、next_steps，不要输出额外解释`
10. `生成一份 Markdown 表格和一份同名 md 文件，表格列为 Agent、Skill、适用场景、风险、验证方式`
11. `使用指定 Skill 完成一次代码审查，输出必须包含 P0/P1/P2 分级和文件引用`
12. `创建一个需要用户确认后才能删除文件的流程，未确认前不要执行删除`

## 记录要求

1. 每次人工回归记录 cid、使用的提示词、涉及 Agent / Skill、是否发生停止/继续、失败步骤 index 和最终状态。
2. 涉及中断恢复时，记录中断方式、恢复时间、点击继续前后的截图或关键日志。
3. 涉及文件产物时，记录文件名、附件 chip、任务详情-文件 tab 和工作区路径是否一致。
4. 回归结束后清理测试会话和工作区产物，避免污染下一轮计划上下文。

## 编排 Actor 的工具面

1. Commander 的 Context、Orchestration、Runtime 保持宿主管理，`workspace.read`、`web` 默认预加载；Management 和其他低频分类通过 `tool_load` 激活，动态分组只在当前用户轮次有效。
2. Named Agent 以各自 `tool_list` 作为初始工具面，并只把 `tool_load` 用作低优先级、当前用户轮次的 Agent-dependency 兜底；匿名 Worker 固定使用 `workspace`、`web`、`library` 且不提供 `tool_load`。两者都不能发现 Commander 的 dispatch、marketplace 或 connector-install 能力。
3. Commander 加载的分类不得传播给 Agent/Worker；Named Agent 自己加载的分类也不得跨用户轮次或传播给其他 Actor，每轮均按当前配置重建。
4. `dispatch_to`、`hand_off_to`、`run_worker` 仍作为三个不同编排语义存在，不因分类加载而合并或改变终止边界。

## Queued admission during Renderer reload

Keep the preceding synthetic reply held while editing an attached queued message.
Preserve an independent composer draft, reload, and let queue admission occur
between the first history snapshot and the future-only event subscription.
The subscription reconciliation must restore the canonical user bubble with both
attachments exactly once alongside its reply, without forcing the reading position.
Deleted, routing-only and unpersisted records remain absent; an aborted or
superseded conversation read must not paint into another conversation. This is
Renderer presentation recovery only and does not replay execution or alter model
history. Deterministic sidebar cases cover the missed-record window and exact
identity; the task-board E2E retains real reload, attachment and draft assertions.
