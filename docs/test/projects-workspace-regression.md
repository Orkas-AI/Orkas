# 项目与工作区模块人工回归 Case

本规范覆盖本机项目、任务、资料库、工作区和恢复。使用隔离的本地用户与临时文件。

## 分层评测矩阵

| 核心场景 | 预期用户结果 | 单测 / 集成 | Electron E2E | 模型 benchmark |
| --- | --- | --- | --- | --- |
| 创建、重命名与列表刷新 | 草稿只由用户提交；后台刷新保留文本、焦点和选区，不得擅自创建或改名 | `projects.test.ts`、`projects-delete-navigation.test.ts` | 真实刷新覆盖 create/rename 草稿、重复名修正和重启持久化 | 不适用 |
| 项目运行状态 | 项目标题实时显示本项目“x 在执行”，多项目并行不串数，停止后立即消失 | `conversation-sidebar.test.ts`、`projects-delete-navigation.test.ts` | 多项目并行任务的侧栏可见状态 | 不适用 |
| 项目文件与工作区 | 所有读写、预览、移动和 reveal 都留在当前工作区，失败不留下半份目录 | `project_files.test.ts`、workspace、Library 集成与路径负例 | 上传、预览、删除和重启 | 不适用 |
| 项目 To-do、说明、记忆与绑定 | 状态持久化且按项目隔离；并发 UI/模型修改不会静默覆盖 | project task/state tool、memory、Renderer race tests | 状态、Agent 绑定及模型工具真实链路 | Commander 项目路由/优先级场景 |
| 项目删除与恢复 | 对话、任务、索引和文件一起进入回收站；失败或迟到结果不得产生半删除/复活 | projects、recycle、indexer 集成 fault cases | 取消、删除、恢复、重新索引 | 不适用 |
| 跨会话项目续做 | 模型读取本项目证据和历史，不凭参数记忆编造，也不串到其他项目 | prompt/tool contracts | 本地模型 SSE 真实对话、重启且不重放模型 | Commander Library/项目连续性 benchmark |

## 自动化覆盖

`test/e2e/projects_e2e_smoke.spec.ts` 已通过真实 Electron 覆盖项目创建、重复名称行内错误、重命名、删除确认取消、回收站恢复、项目指令、项目记忆、To-do 状态、项目 Library 上传/预览/删除、删除项目时清除派生向量、恢复后重新索引、Agent 绑定，以及项目内真实模型会话和任务归属；同时验证项目指令/记忆进入实际模型请求、自包含请求不产生多余历史检索、跨会话搜索并读取同项目证据后直接续做，以及结果在整应用重启后恢复且不重新调用模型或重放历史检索。主进程测试额外覆盖并发创建/改名仍保持名称唯一、损坏 UTF-8 文件夹拒绝且不产生半份副本、项目 Library 符号链接不能越界读写，以及索引进行中删除项目时迟到结果不能复活本地向量库；the separately authorized model canary 固定了“先检索 Library 证据、不得凭模型记忆编造总结”及项目 scope/优先级/历史连续性场景。确定性的删除/恢复存储生命周期由单测与 Electron E2E 负责，不重复放入模型 benchmark。云同步和跨进程冲突仍按本文人工回归；扩展方式见 `docs/test/e2e-testing.md`。

## 项目 UI

1. 新建、重命名、删除项目后，项目列表、项目详情、侧边栏和相关任务应一致刷新。
2. 项目内有任务执行时，侧栏对应项目标题应显示本项目的“x 在执行”；同一项目并行任务应合计，不同项目不应串数，最后一个任务完成或中止后文案应立即消失。
3. 项目详情中任务、自动化、资料库、文件 tab 切换应保持状态准确，不应串到其他项目。
4. 长项目名、多语言描述和长 chip 在宽屏/窄屏下不应溢出或遮挡。
5. 项目侧边栏及自动化等项目选择器应按项目显示名称的字母序排列；数字按自然顺序排列，例如 `Project 2` 在 `Project 10` 前。
6. 添加智能体/技能弹窗在搜索前、筛选到单条结果和无结果时应保持同一高度，列表只在弹窗内部滚动；搜索框应使用透明底色，聚焦时只改变边框。
7. 同一用户并发提交仅大小写不同的项目创建或改名请求时，只能有一个成功；列表和重启后的落盘数据中不得出现两个同名项目。

## Project to-dos and review

1. Create and edit a task from the project board. Saving persists its complete content, owner, and status; cancelling an edit leaves the stored task unchanged. A refresh must preserve an unsaved draft and must not overwrite a concurrent model status update.
2. The board and status selector expose exactly `todo`, `progress`, `review`, and `done`. Status selection moves the card to the corresponding column and updates counts. Clicking card content or padding expands the full text; clicking again collapses it. Enter/Space on the content performs the same toggle. Refresh retains the reading state without writing task data; editing is available through the overflow menu. Agent, status and attachment controls keep their own actions.
3. The overflow menu offers immediate processing for `todo`, `progress`, and `review`. For `todo` and `progress`, verified delivery advances to `review`. Explicit processing of `review` advances to `done` only after successful verification. Failed or incomplete processing must not claim completion. A `done` task has no immediate-processing entry.
4. Native Agents and CLI Agents can create, edit, and complete tasks within the bound project. Their tool schema exposes only content for task text and exactly the four statuses. Verify multiline content beyond 200 characters survives creation, editing, execution, and restart; reject content beyond 4,000 characters without mutation. Writes using `blocked`, `cancelled`, `in_progress`, or `in_review` fail without changing the task; another project's target is rejected.
5. Seed legacy task files in an isolated project and account-global scope: `in_progress` reads as `progress`, `in_review` as `review`, and `blocked`/`cancelled` as `todo`. Reading leaves source bytes unchanged; an ordinary edit persists the canonical status. Preserve content, owner, dependencies, attachments, and original conversation association. Ignore a legacy result_ref without rewriting the file on read; ordinary saves omit it. Legacy title/detail fields combine into content on read without rewriting the file; subsequent saves store only content. A canonical content field takes precedence over stale legacy fields. Reopened tasks count as open and have no completion timestamp; restart retains the edited result.
6. A task referencing a formerly cancelled dependency must wait for that dependency to finish. Completing the reopened dependency makes the dependent task actionable.
7. Completing a task requires only its task ID and must not create a Library copy. Native and CLI schemas omit `result_ref`; old caller extras are ignored and reported. Reopening retains attachments and the execution conversation. When the user explicitly requests a Library save, verify the saved file is readable there and an out-of-scope source is rejected. Anonymous workers return their result to their dispatcher for the backlog update.
8. In the To-dos tab, search a content keyword across global and multiple project backlogs, including completed tasks and tasks with the same ID in different scopes. Matching is literal and case-insensitive; project badges and row actions retain the original task scope. Check Chinese IME input, no-match feedback, live task updates, and Show more beyond 100 matches. Clearing the field or pressing Escape restores the previous grouping and selected project without writes. An external link focusing a specific to-do clears any stale search. A pending or failed initial load must not claim that no tasks match.


## Project automatic advancement (off by default)

1. The project board's automatic-advancement control uses the shared compact button style and persists its enabled state when the project is reopened.
2. When enabled, select one `todo` whose dependencies are `done` (or whose stale dependency references no longer exist). Start its conversation, mark it `progress`, and let the executor verify delivery before advancing it to `review`.
3. With only `progress`, `review`, and `done` tasks, or unfinished dependencies, no task is actionable. An old `cancelled` task reopens as `todo` and follows normal selection and cooldown rules.
4. Once a selected task leaves `todo`, later independent tasks may advance after the cooldown even while its conversation continues. Overlapping attempts to admit the same task must not create duplicate conversations. The daily limit remains enforced.
5. Disabling advancement prevents new automatic starts. Configuration, counts and leases remain device-local; another device cannot acquire this local execution.

## 工作区与文件

1. 选择真实目录作为工作区后，文件 tab、reveal、预览、读写文件应指向同一目录。
2. 读写文件时，工作区外路径、符号链接越权和路径穿越应被拒绝并显示可理解提示。
3. 模型生成文件后，消息附件 chip、文件 tab、工作区目录和系统 reveal 应一致。
4. 删除或移动真实文件后，UI 应刷新或提示文件不存在，不应打开旧缓存。
5. 向项目 Library 复制含合法文件和损坏 UTF-8 文本的嵌套目录时，应拒绝整个目录且不留下半份目标；已落盘的符号链接不得被预览、读取或编辑到项目目录外。
6. Project Library text uploads/imports accept files up to 200 MiB, matching chat attachments. Text over 5 MiB remains saved but cannot use whole-text preview/edit or automatic search indexing; the indexing message must explain that the assistant can read selected sections. Verify the source bytes remain intact, a file exceeding 200 MiB is rejected, a formerly indexed file growing beyond 5 MiB no longer returns stale search chunks, and replacing it with text of at most 5 MiB restores indexing.

## 项目联动

1. 从项目内新建对话、自动化、资料库文件，应带项目归属，并只显示在对应项目列表。
2. 项目删除进入回收站后，关联任务、自动化、资料库文件应从 UI 移除；恢复后回到原项目。
4. 完成一次 v4 项目目录迁移后连续重启，后续正常启动不应重复扫描/搬运旧目录；恢复旧版本地数据后，强制修复仍应将旧路径迁入项目目录。

## 项目说明与项目记忆

1. 打开项目详情，右侧“上下文”卡片：标题显示“上下文”，说明和记忆分别位于卡片内的 tab；说明输入框可编辑并保存，保存后该项目每个对话的系统提示都应带上这段说明。
2. 指挥官（项目主对话）中让其"把这条写进项目说明/更新项目目标"，应通过 `project_instructions` 工具写入 `ORKAS.md`，UI 项目说明同步刷新；让其"记住这个项目决策"，应写入项目记忆（`cross_session_memory` target `project`）。
3. 被指挥官派发的子 agent 对话中，子 agent 尝试写项目说明或项目记忆应被拒绝（只读），但能读取/list；子 agent 应把项目级事实交回结果，由指挥官记录。
4. 非项目对话中不应出现 `project` 记忆层，也不应有 `project_instructions`、`project_tasks` 工具。

## 日志与安全

1. 日志应能定位项目 id 掩码、工作区 path hash、操作类型和错误摘要。
2. 日志不能输出完整本地路径、完整文件名、文件内容、模型 key、邮箱或手机号。

## 邀请成员入口

项目菜单保留“邀请成员”。点击只打开商业版说明，取消保持项目、工作区、草稿和焦点；只有明确点击下载才打开带当前有效语言的官方下载页。不得联系成员服务、发邀请或改写项目身份。所有界面语言以及窄窗口均应保持可操作。待办卡片和编辑器不显示真人责任人；可选 Agent 指派和“未指定”继续可用。
