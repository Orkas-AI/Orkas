# Orkas 架构与分层规范
只放 LLM 读代码读不出来的内容——硬约束 / 反直觉决策的 Why / 踩过的坑。架构描述指向源码,不复述实现。

---

## 1. 项目形态

单进程 Electron 桌面应用:main = Node 后端,renderer = vanilla HTML/CSS/JS,IPC 通信,本地文件存储。启动 `bootstrap.cjs` → tsx loader → `src/main/index.ts`,无 build。

**硬约束**:
- main 不跑 HTTP / 不占端口 / 无鉴权
- renderer 走 `contextBridge` 暴露的 `window.orkas.{invoke, stream}` 白名单 API;**不引** TS / JSX / webpack / vite
- preload **必须 `.js`**(preload loader 不跑 tsx hook),路径 `src/main/preload.js`
- 所有 LLM 调用走 in-process `core-agent`(`import('#core-agent')` 动态加载),无子进程。**Why**:避开 IPC 序列化,锁/取消/事件流共享内存
- 存储以 JSON / JSONL 为主;sqlite 仅 KB 向量库一处。**Why**:用户数据要可读、可移植、对云同步友好(单文件 = 单同步单元)
- **skill / agent / contexts 是三个一等公民**;多 agent 协同走 §5 群聊架构,**不再有"主 agent 调 RPC 子 agent"**
- npm 依赖白名单见 `PC/package.json`(关键:`electron / pi-ai / better-sqlite3 / sqlite-vec / fastembed / onnxruntime-node / pdfjs-dist / pdf-lib / mammoth / jimp`)。**加新依赖需讨论**
- renderer 第三方 JS/CSS 走 `src/renderer/vendor/<name>/` 静态资源,不进 npm。**Why**:contextBridge 沙盒里 `require` 不可用;走 npm 反而绕路
- **跨平台**:macOS + Windows 双主力(Linux 社区级)。新代码优先跨平台方案(Node stdlib);需平台分支必须每分支真机验证,不得只跑通单平台

---

## 2. 目录布局

```
PC/                          Electron 项目根,唯一开发与打包入口
├── bootstrap.cjs            tsx loader 注册 → require('./src/main')
├── data/                    运行时数据(gitignored,详见 §4)
├── userWorkSpace/           主对话默认 workspace(gitignored)
├── src/main/                Node 后端(TS,tsx 运行态转译)
│   ├── index.ts             Electron 生命周期 + IPC 注册
│   ├── preload.js           contextBridge → window.orkas(必须 .js)
│   ├── paths.ts             **唯一路径来源**,严禁散落硬编码
│   ├── ipc/                 IPC handler(详见 §3)
│   ├── features/            业务层(users / chats / group_chat / skills / agents / contexts / kb_* / auth / permissions / ...)
│   ├── model/               模型调用层(in-process core-agent)
│   ├── prompts/             *.md 模板
│   └── util/                纯函数(locks / path-sandbox / extract-* / file_to_chunks / ...)
├── src/renderer/            前端 UI(vanilla,详见 §8)
├── src/core-agent/          AgentRunner / providers / PersistentSession / SkillLoader
└── src/builtin/skills/      内置技能源(启动按 hash 同步到 data/builtin/skills/)
```

**运行态数据位置**:dev = `PC/data/` + `PC/userWorkSpace/`;打包后 = `<container>/{data,userWorkSpace}/`,container 选址 macOS/Linux → `~/.orkas/`,Windows → 字母最小的非系统固定盘 `<drive>:\.orkas\`(无则 `C:\`)。完整选盘逻辑详见 `src/main/packaged-data-root.ts`。

---

## 3. 分层约束

```
ipc/                IPC handler:参数校验 + 调 features;不做 IO、不做业务
features/           业务层:编排 storage + model + prompts;不知道 IPC
model/              模型调用层;client.ts re-export,实现在 model/core-agent/
model/core-agent/   本地适配 + 工具覆盖
storage.ts          文件 IO helper(只能用标准库)
prompts/            模板加载器(只能用标准库)
i18n.ts             UI 语言表 lookup(只能标准库 + locales/*.json,严禁 import features / model)
util/               纯函数工具(只能用标准库或单一第三方依赖,**禁反向 import features/model**)
```

**require 规则**:
- `index.ts` / `ipc/` → `features/` / `storage` / `paths` / `prompts`
- `features/` → `storage` / `paths` / `prompts` / `model` / `util` / 同级 features
- `model/core-agent/` → 动态 `import('#core-agent')`;锁走 `util/locks`;**禁读写 data/ 下业务数据**(仅 session jsonl)。**Why**:模型层无状态,业务编排只在 features;模型层动业务数据 = 双写 = 状态错乱

**model/core-agent 关键约束**(实现详见各 *-tool.ts 头注释):
- **新增工具** = `tool-catalog.ts::TOOL_CATALOG` 加条目(反漂移测试要用) + runner 注册;system prompt 顺序固定 `[systemPrompt → skillsBlock]`(KV cache 稳定前缀在前)。**工具说明只走 SDK tool-use 协议的 API tools 字段**(完整 description + JSON schema),**禁止再注入"## 可用工具"块到 prompt** —— 重复且消耗 input token + 可变前缀污染 cache
- **文件类工具** 入口统一过 `util/path-sandbox.isPathAllowed`
- **`sdk-timeout-patch.ts`** 必须在 `index.ts` 中 logger init 后、任何 feature import 前调,顺序不能改
- **`#core-agent` 只能 dynamic `await import('#core-agent')`,不能顶层 `import { x } from '#core-agent'`**——顶层静态 import 在 main 启动早期同步加载 core-agent + 它依赖的 pi-ai,先于 `sdk-timeout-patch` 跑;且 pi-ai package.json 没 `exports` 字段,ESM 解析路径会 `ERR_PACKAGE_PATH_NOT_EXPORTED` 直接挂掉。所有从 `#core-agent` 拿值的地方按 `getLoader()` / `getPickDescription()` 的 lazy 单例模式,首次使用时 `await import` + 缓存
- **工具产出** 经 `util/tool-result-cap.ts::wrapToolWithCap` 过 per-tool 上限(默认 100K,`read_file`/`kb_read` 豁免,超 50K 落盘 `tool-results/<sid>/`)

**features 函数约定**:返回对象 + 错误用 `{ok:false, error}` 或 throw(IPC handler 统一包装);涉及用户私域的函数 `userId` 必须是第一参数。

**IPC 通道**:`orkas.invoke`(请求/响应)/ `orkas.streamStart`(事件流 `stream:<requestId>`,以 `{type:'done'}` 终止)/ `orkas.streamCancel`。

**Prompt md 内容卫生**(`src/main/prompts/*.md` 注入 LLM,**禁止**):
1. 项目名 / 品牌字样(`Orkas` 等,改"本系统"中性词)
2. OS 真实路径字面量(`/Users/...` / `C:\Users\...`,改抽象描述或 `<abs-path>` 占位;`prompts.load(name, vars)` 注入的 `$variable` 允许)
3. 项目特定目录名(`PC/data` / `userWorkSpace`)

例外:环境变量名带项目前缀(`ORKAS_NODE` / `ORKAS_PC_DIR`)在 bash 里实际引用时允许。新增/改 prompt 前 `grep "Orkas\|/Users/\|/home/\|PC/data\|PC/src" src/main/prompts/*.md` 应当干净。

**跨 prompt 共享核心规则的同步约束**:同一领域概念在多个 prompt md 出现时(典型:`<agent>` 容器创建在 `chat_agent_setup.md`(迭代式编辑)和 `chat_commander.md`(一次性沉淀)都有),认 1 个权威 prompt 作真理源(如 `<agent>` 真理源 = `chat_agent_setup.md`),下游侧只带共性原则(workflow 拆"输入→动作→产出" / 工具优先级 / `<interactive>` 判定 / 散文禁词等),字段细则 / schema 表 / 完整翻译表不照搬。**动真理源前** `grep -E "<agent>|<workflow>|<skills>|<inputs>|<interactive>|<description_zh>|<description_en>|<<<skill-file>>>|agent-input-form|agent-input-submission" src/main/prompts/*.md` 找下游核对;新增规则若与下游相关必须同步过去。loader 不做模板组合(只 `$variable` 替换),靠 caller 主动同步 + git review 卡漏。

---

## 4. data 同步域

顶层三分:**☁️ cloud**(用户私域,跨设备同步)/ **🔒 local**(本机私域,永不同步)/ **🌐 top-level**(全局公共)。

```
PC/data/
├── users.json                 🌐 本机 uid 注册表 + current_user_id
├── logs/                      🌐 本机日志(按天滚动,多 uid 共享)
├── builtin/{agents,skills}/   🌐 启动时按 hash 同步自 src/builtin/(运行时副本,手改会被覆盖)
└── <user_id>/
    ├── cloud/                 ☁️ 云同步域
    │   ├── chats/<cid>.jsonl  + chats/<cid>/{members,state,plan,visibility/}  群聊运行态(详见 §5)
    │   ├── chats/{skill,agent}/<id>/chat.{json,jsonl}                          编辑会话
    │   ├── chat_attachments/<cid>/    主对话附件池(零预处理)
    │   ├── sessions/<sid>.jsonl       core-agent PersistentSession
    │   ├── contexts/                  KB 用户直管目录树 + .kb/vector.db(详见 §7)
    │   ├── memory/MEMORY.md + USER.md
    │   ├── agents/<aid>/              自定义 agent: agent.json(spec) + meta/(元认知) + skills/(自演进 SkillStore)
    │   ├── skills/<sid>/              自定义 skill(System A,SkillLoader 扫描)
    │   └── config/{preferences,component-enabled}.json
    └── local/                 🔒 本机域(永不同步)
        ├── config/            auth-profiles / permissions / reflection-state / web-search-cache
        ├── search/            派生索引(contexts / chats / skill_chats / agent_chats)
        ├── file_cache/<hash>/ 所有文件 lazy 缓存(详见 features/file_indexer.ts)
        └── tool-results/<sid>/ 超大工具输出落盘
```

**五点强约束**:
1. **顶层只能** `users.json` / `logs/` / `builtin/` / `<uid>/`,单用户数据必须落 `<uid>/{cloud,local}/`
2. **`data/builtin/{agents,skills}/` 是运行时副本**:启动按 hash 同步自 `src/builtin/`;agent 走目录形态(`<aid>/agent.json`),skill 走目录形态(`<sid>/SKILL.md`);loader 扫描 `[<uid>/cloud/, data/builtin/]`,custom 优先覆盖同 id builtin;`kind` 由 spec 的 root 判断(目录里**无** `custom/` / `builtin/` 层)
3. **agent 目录形态(per-agent 资产聚合)**:`<uid>/cloud/agents/<aid>/` 内含 `agent.json`(UI 唯一展示来源,纯 spec)+ `meta/`(元认知:COMPETENCE.md + LEARNING_STRATEGIES.md)+ `skills/`(SkillStore 自演进 skill,只对该 agent 可见,不进 SkillLoader system prompt block)。删 agent = `rm -rf <aid>/` 一刀切,不再 cascade。详见 docs/plans/agent-as-directory.md。**禁**回到旧的顶层 `meta/` 或 `PC/skills/`(SkillStore 默认 cwd)
4. **`search/` 索引纯派生**:永不同步;查询前 mtime+size reconcile 自愈;1s 防抖 flush + `before-quit` 强 flush;schema 变化或损坏自动 rebuild
5. **KB 向量库纳入云同步**:冲突取较新 mtime,失败方启动期 `kb_indexer.reconcile(uid)` 按 sha1 对账自愈。**journal 模式 DELETE 不 WAL**(避免 `.db-wal` / `.db-shm` 旁落文件需要也同步,实测会撕裂)

**uid 生命周期**(`features/users.ts`):启动时 `initActiveUser()` 读/建 `users.json`(8 位数字 uid);`activateUser(uid)` 负责骨架 mkdir + 注入 `process.env.CORE_AGENT_AUTH_DIR` + 清缓存。所有 user-scoped feature 通过 `getActiveUserId()` 取 uid(未激活 throw)。本期单活跃 uid。

---

## 5. 对话 / session 隔离(核心安全约束)

| 对话类型 | UI 消息列表 | session_id |
|---|---|---|
| 主对话(群聊)— commander | `<uid>/cloud/chats/<cid>.jsonl` | `<uid>-gconv-<cid>` |
| 主对话(群聊)— agent worker | `<uid>/cloud/chats/<cid>/visibility/<aid>.jsonl` | `<uid>-gmember-<cid>-<aid>` |
| 技能编辑 | `<uid>/cloud/chats/skill/<sid>/chat.jsonl` | `<uid>-skill-<sid>` |
| 智能体编辑 | `<uid>/cloud/chats/agent/<aid>/chat.jsonl` | `<uid>-agent-<aid>` |
| KB 图片理解 | (无 UI) | `<uid>-extract-img-<hex>` |

session jsonl 落 `<uid>/cloud/sessions/<session_id>.jsonl`,与 UI 消息列表是**两份独立文件**。

**安全不变量**:`session_id` 必为 `<uid>-<kind>-<tail>`,uid 必在第一段,`<kind>` ∈ `gconv | gmember | skill | agent | extract-img | reflect | memory-extract | anon`(`sub` / `organizer` / `conv` 是历史 kind,新代码不再生成,但 `migrate-session-ids` 会保留这些老文件)。`session-store.ts::sessionFileFor()` 强制断言,防止跨 uid 泄漏。**禁止**把品牌名 / 任何 app 名编进 session_id —— 改名 / 分叉时会直接断历史,启动期 `migrateLegacySessionIds(uid)` 一次性剥旧前缀,新代码绝不再加。新增 kind 必须追加本表。

**skill 注入策略**:编辑会话 + 群聊 commander = 不过滤(注入全部);群聊 agent worker = 按 `agent.skill_list` 三态过滤(详见 §6)。

**prompt cache 约定**:连续会话(`gconv-* / gmember-* / skill-* / agent-*`)默认 `cacheRetention: 'short'`;一次性调用(memory / 反思 / KB 图片)不传。pi-ai 已封装 provider 差异(features 层不做分支)。`'long'` 默认不启用(Anthropic 1h 有 2× write 溢价)。

**加新对话类型**:UI 路径含 `user_id` 段 + session_id 用 `<uid>-<kind>-<tail>` 三段格式(uid 在第一段,**不加任何品牌前缀**)+ 对话级规则走 `ChatOptions.systemPrompt`(每次重构造,**不要拼到用户消息首条前缀**)+ 更新本表。

### 群聊架构(`features/group_chat/`)

成员 = `commander` + `user` + N 个 `agent` actor(首次被 `dispatch_to` / `plan_set` 派活的 agent 自动入群)。每 actor 独立 worker loop,**无 RPC**。

**派活通道**(LLM → 系统的控制流必走结构化通道,跟 `<agent>` / `agent-input-form` 风格一致):
- 单 agent → `dispatch_to({to, message})` 工具(commander / agent 都能用)
- 多 actor 协作 → `plan_set({steps})` 工具
- user 发的消息 → 文本 `@<name>` 仍解析(user UX 不变)
- **commander / agent 写在散文里的 `@<name>` 系统不识别为派活信号**(LLM 训练惯性常把 `@` 当 markdown 装饰,以前误触发反复出 bug)
- `dispatch_to` 调用时只 stage,recipient worker 在 commander turn 完整收尾后才被唤醒(避免抢跑;同 `plan_set` 的 `pendingPlanAnnouncement` + 延迟 reconcile 模式)

**单一调度原语**:`bus.ts::enqueue(uid, cid, fromActorId, text, [forceTo], ...)` 是 group_chat 唯一对外控制流入口。`dispatch_to` / `plan_executor` / 文本 @ (仅 user) 都最终落到这一个 enqueue。**不准新建并行 enqueue 函数**;新派活路径必须经过它。

**关键约束**:
- **可见性切片**(安全不变量):agent X 只看 `from==X ∨ to∋X ∨ mentions∋X`;worker 必须只走 `visibility.readSlice`,**禁止读全量 `<cid>.jsonl`**(会跨 actor 泄漏私有上下文)
- **plan**:commander 用 `plan_set` 工具写 `<cid>/plan.md`;**禁工具外手改**(破坏首次公告语义 + UI `plan_changed` 事件链)
- **abort**:`groupChat.abort(cid)` = 唯一群级停止(清所有 actor queue + abort in-flight + 标 `state.json.status='aborted'`,plan.md 保留作进度);**无 per-stream 终止按钮**
- **死循环兜底**:`MAX_WORKER_TURNS=100`(轮次维度,**不是时间**),与外层 `idleTimeout=600s` 两层独立兜底
- **结构化输出**:commander 的 `<agent>...</agent>` 容器(创建/编辑 agent)、agent 的 ```agent-input-form` fenced 块(表单);格式与流水线详见 `bus.ts::runTurn` + `prompts/chat_*.md`
- **删除级联**:`chats.deleteConversation` → `groupChat.dropConv` 一站式

### 附件(仅主对话)

存 `<uid>/cloud/chat_attachments/<cid>/<file>`,**零预处理**;extract / 压缩 lazy 走 `<uid>/local/file_cache/<hash>/`(详见 `features/file_indexer.ts`)。

**关键约束**:
- file-tools scope = active workspace ∪ 当前 cid 附件目录,越界 `E_PATH_OUT_OF_SCOPE`
- pdf/docx 必须**先 `stat_file` 再 `read_file`**(read_file 返 `E_NEED_STAT`,职责单一,见 §9 不要做)
- `chat-media://cid/<encCid>/<encName>` per-conv 附件;`chat-media://local/<abs>` 任意本地媒体(扩展名白名单 + 大小上限,**不做目录白名单**——威胁模型是"用户跑自己的 LLM")
- 视频白名单 `.mp4/.webm/.mov/.m4v/.ogv`(200MB 上限),**纯展示不喂模型**

### 本机执行工具

`bash / write_file / markdown_to_pdf / html_to_pdf / generate_image` 共用 `localExec.granted` 权限门(设置页 grant/revoke,每次 `execute()` 重读,mid-conv 即时生效);未授权 → `isError=true`。`web_search` 走 `searchProfiles[0]` → 付费 API → fallback builtin。产出经 `ChatOptions.onFileWritten` 收集,renderer 绿色 chip → IPC `workspace.revealPath`(严格校验落 workspace 内)。详见 `model/core-agent/{local-tools, image-gen-tool, search-tools}.ts`。

**写文件防冲突**(`util/uniquify-path.ts`):`write_file / markdown_to_pdf / html_to_pdf / generate_image` 默认按模型给的路径写;**冲突时 uniquify**(basename 末尾插 `-N`)并通过 tool result 的 `<file-renamed>` 块显式回传。判定"我的"靠 caller 注入的 `ChatOptions.hasProducedPath`(group_chat 用 producedSet 当 turn 维度)——本 turn 自己写过的路径再写视为 refinement 直接覆盖,其它已存在文件视为外部冲突。**`bash` 不在保护范围**(shell 重定向是黑盒)。`read_file` ENOENT 时扫同目录 `<name>-N<ext>` 兄弟文件,有命中追加 `<file-renamed-earlier>` 提示作为第二层防护。

---

## 6. 技能(skill)

来源 = `src/builtin/skills/`(git 追踪,启动按 hash 同步到 `data/builtin/skills/`)+ `<uid>/cloud/skills/`。`SkillLoader` 扫描 `[user, builtin]` 注入 system prompt,**custom 优先覆盖同 id builtin**。内置不可编辑。

**内置 skill / agent 源文件主体统一英文**(`src/builtin/` 下的 SKILL.md 正文 / 示例 / 内置 agent spec 的 system / persona / workflow 等):面向多语言用户分发,LLM 调用时自动按对话语言回复,源文件不需要中文兜底;混用中文会让英文用户读到夹生内容。custom skill / agent 由用户自建,语言不限。

**例外:`description` 必须双语化**——SKILL.md frontmatter 用 `description_zh` + `description_en` 两份(legacy 单 `description` 字段在 loader / normalizeAgent 里按 CJK 启发式分桶迁移,但**新写一律双字段**),agent spec JSON 同样 `description_zh` + `description_en`。**Why**:简介是 commander / 主对话 LLM 的选中信号(`chat_commander.md:91/96/325`),内置 skill/agent 走全球分发,如果只英文,中文 UI 用户列表里看到的就是英文简介,误判匹配。运行时 `getSystemPromptBlock` / `_buildAgentsIndexBlock` / UI 渲染都按 `getCurrentLang()` 选哪份注入(`pickDescription` resolver 在 core-agent + renderer utils 各一份保持同步)。**双写不实时翻译**——简介质量必须可控,运行时翻译有质量波动 + 延迟成本。

**SKILL.md frontmatter 只有两个字段**:`name` + `description`。**没有** `requires` / `external_deps` / `tags` 等任何其它字段。skill 之间硬性互不依赖(无传递闭包、无跨 skill 写),外部依赖在正文"外部依赖"小节文字说明,运行时不预检不自动安装。

**`agent.skill_list` 三态**:`undefined` = 不过滤(老 agent 兼容)/ `[]` = 零 skill / 非空 = 仅子集。`updateCustomAgent` 落盘前**只**做"未知 id 过滤",不做闭包展开。字段由 agent-edit LLM 通过 `<agent><skills>` 子标签自动维护,**前端不暴露手编**。

**skill scripts 默认 `.py`**(Python 3,覆盖最广),其它允许:`.ts / .mjs / .js`(走 tsx + Node)、`.sh`(bash)、`.rb`(ruby)。**Why**:外部生态绝大多数 skill 都是 py 写的,强制改写门槛高、易引 bug;py 在 macOS/Linux 自带,Windows 安装一次即可。**调用入口统一**走 `bin/run-skill.cjs <id> <basename>`(不带扩展名),runner 按 ext 派发:`.py` → `python3`(Win: `py -3` → `python`);`.ts/.mjs/.js` → require + 默认导出;`.sh` → `bash`;`.rb` → `ruby`。子进程模式注入 `ORKAS_SKILL_ID` / `ORKAS_SKILL_DIR` env,stdio 直通退出码透传。skill 目录禁 `node_modules / package.json / requirements.txt / Gemfile` 等包管理产物;`.ts` 用 PC 已有 npm 白名单(新依赖走 §1),其它语言只用对应 runtime stdlib。

**个人启用/禁用**(agent + skill 共用,`<uid>/cloud/config/component-enabled.json`,**只存 false**):resolver 单一入口 `features/component_enabled.ts::isAgentEnabled / isSkillEnabled`。**仅 4 处 filter 应用点**(其它地方不要再判):
1. `listAgents() / listSkills()` 给 UI 挂 `enabled`(不过滤,让 UI 显示开关)
2. `chats.ts::_buildAgentsIndex` — agent picker 列表
3. `chats.ts::stream/sendToConversation` — 已绑 disabled agent 直接 `errors.agent_disabled`
4. `skill-registry.getSystemPromptBlock({disabledIds})` — render 阶段过滤

**写入入口**(改名 / URL/目录导入):详见 `features/skills.ts`。任何写入口必须调 `invalidateSkills()`。`<<<skill-file>>>` 块只能写当前 skill 目录(无跨 skill `skill=Y` 属性)。

**双 system 边界(skill 有两套)**:
- **System A — 用户/UI 管的 skill**:`<uid>/cloud/skills/<sid>/` + `data/builtin/skills/<sid>/`,`SkillLoader` 扫描后注入 system prompt 的 `## 可用技能` block;SKILL.md frontmatter 仅 `name + description`;UI / skill-edit chat / 导入流程 都改这套
- **System B — agent 自演进 skill**:`<uid>/cloud/agents/<aid>/skills/<sid>/`,core-agent SDK 的 `SkillStore` 写,`skill_manage` 工具(create / read / patch / list / delete)管;**只对所属 agent 可见**(通过 `skill_manage(list/read)` 自取),不进 SkillLoader 的 system prompt block。frontmatter 含 `id / patchCount / createdAt / updatedAt / tags` 等运行时字段
- runner.ts 给 `createConfig` 的 `evolution.skillsDir` 显式指向 `agentEvolvedSkillsDir(uid, agentId)`;**禁止**让 SkillStore 用 cwd 默认值落进 `PC/skills/`(已加 `.gitignore` 防御)

---

## 7. 知识库(contexts)

`<uid>/cloud/contexts/` 是用户直管目录树(md/txt/pdf/docx/image 混合,云同步)+ `.kb/vector.db`(派生向量库,纳入云同步)。详见 `features/{contexts, kb_indexer, vec_store, kb_vector}.ts`。

**关键约束**:
- **embedder 固定 `bge-small-zh-v1.5` 512 维**,换模型需全量重建(`config.json` 锁防误换)。模型 ~95MB 随 installer `extraResources` 出厂,零下载零网络
- **journal 模式 DELETE 不 WAL**(`.db-wal/.db-shm` 旁落文件会撕裂同步,见 §4)
- **禁用 `worker_threads` 起多 ONNX session**:实测原生层 SIGSEGV(OpenMP threadpool + 分配器并发初始化是已知危险组合);需真并行用 `child_process`
- 模型侧只能用 `kb_search` / `kb_read` 两个工具;**禁止 `cat` / `rg` 访问 `$contexts_dir/`**(写在 `chat_core.md`)
- 切块上限 `EMBED_MAX_CHARS=400` 字符(贴合 512 token 窗口);跨段不 overlap 避免主题污染
- `_INDEX.md` 仅根目录一份,自动生成给用户 Finder 浏览,**模型不读**
- 云同步冲突取 mtime 较新,失败方启动期 `reconcile` 按 sha1 补齐;`kb_files` 表即清单,无需单独 manifest

**通用向量库工具**(新场景可复用,详见各文件头注释):`util/file_to_chunks.ts`(纯函数切块)+ `features/vec_store.ts`(`openVecStore(dbDir)` 工厂,高低层双 API)+ `features/kb_vector.ts`(uid → dbDir 适配器)。

---

## 8. 前端(`src/renderer/`)

vanilla HTML/CSS/JS,classic `<script>` 多文件(非 ESM 非 build)。跨文件符号靠顶层 `let/const`,**不写** `export/import`;不挂 `window.*`(除非 HTML `onclick` 需要)。

**关键约束**:
- 加新文件 → 同时在 `index.html` 的 `<script>` 列表插入(多数排在 `ipc-shim` 之后)
- 新增 `window.orkas.*` API → 必须在 `ipc/index.ts` 加 handler;新 `/api/*` → 只能在 `modules/ipc-shim.js::_IPC_ROUTES` 追加(不写真 HTTP)
- Markdown 渲染唯一接口 `renderMarkdown(str)`(`modules/utils.js`),**不要写"简易版"**。LaTeX 公式由 `modules/math.js::typesetMath` 异步排版,**流式 delta 不排版**(避免半截 LaTeX 抖动)。具体占位/正则细节详见两文件头注释
- `index.html` 资源**不带 `?v=`**:dev `Cmd/Ctrl+R` 走 `reloadIgnoringCache()`;prod 禁 reload
- `src/renderer/` **不参与 typecheck**(vanilla + DOM,checkJs 误报多);main/ 保持 `checkJs: true`
- 过程信息行图标只用 Unicode Geometric Shapes(`▶ ● ◆ ◇ ■ ▣ ▷ ◐ ◉ ○ ◯ ▪`),**禁彩色 emoji**
- UI 共用一套 class(`.btn / .btn-sm / .btn-primary / .btn-danger / .detail-actions / .empty / .muted`),差异用 `.is-*` 修饰符,**禁开近似类**

### i18n(中/英双语)

文案在 `src/{renderer,main}/locales/{zh,en}.json`,lookup 走 `i18n.{js,ts}::t(key, vars?)`(扁平点分 key,缺失 fallback `en` → raw key)。语言偏好 `<uid>/cloud/config/preferences.json`,运行时切换派发 `i18n-change` 事件。

**硬性要求**:
- 所有用户可见文案(按钮/标题/状态/占位符/tooltip/空态/toast/dialog)**必须走 i18n** + zh/en 双份 key
- 静态 HTML 用 `data-i18n*`(`applyDomI18n()` 自动扫填);**JS 注入文本必须挂 `i18n-change` 监听重绘**——常漏:sidebar 列表 / settings 动态行 / 状态切换的按钮
- 先决定 i18n key 再写代码,**不允许中文硬编码"以后补"**
- **不 i18n 化**:LLM prompts(`prompts/*.md` 中文是 prompt 本身)、日志、用户内容

---

## 9. 开发流程

### 启动

`cd PC && ./run.sh`(唯一入口,kill 旧实例 + 前台启动)。F12 仍可手开 renderer DevTools(Chromium 自带,非 dev 也开)。

### Git commit

提交信息**一律英文**——标题 + 正文 + 任何 footer。**Why**:开源仓库面向全球协作者,中文 commit 在 GitHub 历史里阅读不连贯,贡献者追溯改动 / 写 release notes / 跑自动化工具都不友好。新代码遵守即可,历史中文提交不必返工。

### 改动后必做

- main TS / core-agent → `./run.sh` 重启(<1s,tsx 转译)
- renderer → `Cmd+R` 刷新(自动忽略缓存)
- 改存储路径 / session_id / 分层职责 / 外部依赖 → 同步更新本文件

### 单元测试

**唯一目的**:锁住易被误改的行为,**不是**凑覆盖率、不是文档、不是壮胆。

**跑测一律 `npm test`**,**禁** `npx vitest` / IDE 右键 Run。`scripts/run-tests.mjs` 跑测前 swap `better-sqlite3` 到 Node ABI、跑完无条件 swap 回 Electron。**故障恢复**(MODULE_VERSION 不匹配 / 启动 SIGKILL 无 stack):跑 `npm run rebuild:sqlite:electron`。诊断单行与详细成因见 `scripts/swap-sqlite-abi.mjs` 头注释。

**写测分级**:
- **必须写**:业务不变量(uid 隔离 / session_id 前缀 / 路径遍历 / 域边界)、故障恢复路径(损坏/并发/索引失配 → rebuild、回滚)、多分支决策函数、跨层契约、文本坑位
- **不写**:纯类型即正确的函数、薄封装、UI/DOM、getter/setter、库已保证的行为
- **禁止写**:同分支换数据反复断言、断内部实现、tautology、只换参数不换分支、测"类型/签名/存在性"、全 happy path

**组织**:`test/main/` 镜像 `src/main/`,一文件一被测模块,`describe` 嵌一层。

### 不要做

**分层 / 路径**:
- `ipc/` 写业务(跳层);`features/` 直接调 core-agent / spawn 进程
- 存储路径不含 `<uid>` 段;session_id 第二段不是 uid
- feature 模块用模块级 const 缓存 uid 路径(必须 `getActiveUserId()` 每次取)
- renderer 加 `window.orkas.*` 不在 `ipc/index.ts` 加 handler
- 绕过 `util/locks.ts` / `util/path-sandbox.isPathAllowed` / `features/file_indexer.ts`
- 给 `chat_attachments.uploadAttachment` 加 eager 预处理(extract / preview / 切块)

**超时 / 锁**:
- 给 LLM 调用加"总时长超时"(`timeout: N` / `setTimeout→abort`)。应用层唯一看门狗是 `client.ts::streamChatWithModel` 的 `idleTimeout=600s`(真空闲);SDK 1h 由 `sdk-timeout-patch.ts` 兜底;群聊死循环防护是 `bus.ts::MAX_WORKER_TURNS=100`(**轮次,不要改 timeout**)
- 给 `sessionLock.acquire()` / `globalSlots.acquire()` 加等待超时。长 LLM 任务本该无限期排队,加超时 = 伪失败

**测试 / sqlite ABI**:
- `npx vitest` / `vitest run` / IDE 右键 Run / 直接调 `scripts/swap-sqlite-abi.mjs node`(无失败回滚,网络中断会留半覆盖 `.node` → Electron 静默 SIGKILL)。一律 `npm test`,故障跑 `npm run rebuild:sqlite:electron`

**依赖 / 配置**:
- 加 npm 依赖(见 §1 白名单)
- 手改 `data/builtin/{agents,skills}/`(启动按 hash 覆盖)
- 手改 `<uid>/local/config/*.json`(走设置页 UI;`auth-profiles.json` 写入口会触发 runner 失效)

**file-tools 误用**:
- `read_file` 对 pdf/docx 自动 fallback 抽取(职责单一,必须先 `stat_file`,搜 `NeedStatError` 看强制 throw)
- `search_files` / manifest 触发 extract(必须 `getCachedMeta` peek)
- `bash grep -r` 扫 pdf/docx(走 `grep_files`)

**prompt md / 工具清单**:
- 在 `prompts/*.md` 写项目名 / OS 真实路径 / 项目源码目录字面量(详见 §3 末"内容卫生")
- 在 `chat_*.md` 硬编码工具名;新增工具用法说明 → 加 `tool-catalog.ts::TOOL_CATALOG.summary`,只有"何时用 X / X 特殊约束"才进 prompt

**skill / agent enabled**:
- 在 §6 4 处 filter 应用点之外判 `isAgentEnabled / isSkillEnabled`;把 disabled 写进 spec JSON / SKILL.md frontmatter(违反"用户偏好不擦写 spec");在 `expandSkillClosure` 内提前 filter disabled

**群聊**:
- 绕过 `bus.enqueue` 直接写 `<cid>.jsonl` 或 `visibility/<aid>.jsonl`(消息路由 / 切片 / worker 唤醒一体)
- 在 agent worker 里读全量 `<cid>.jsonl`(必须 `visibility.readSlice`,否则跨 actor 私有上下文泄漏)
- 重新引入 `call_subagent` / `subagents.ts`(已废弃;LLM 派活走 `dispatch_to`(单)/`plan_set`(多 actor)工具,无 RPC)
- 在 commander/agent 散文里写 `@<X>` 期望它派活——已不识别,只会让 user 看到一段没人接的文字
- 新建跟 `bus.enqueue` 并行的 enqueue / 调度函数——单一原语原则,任何派活路径必须经过它
- 在 `plan.ts` 工具外手改 `<cid>/plan.md`

---

## 10. 日志

**日志** `src/main/logger.ts`(electron-log 薄封装):main + renderer 共写 `data/logs/YYYY-MM-DD.log`(>10MB 切 `.old.log`,启动期 `sweepLogs()` 按 ≥7 天 / ≤100MB 清理,今天的永不删)。renderer 走 IPC 转发以 `renderer/<module>` scope 落盘。脱敏 hook + REDACT_KEYS 名单见 `logger.ts`。调级 `ORKAS_LOG_LEVEL=debug`。

**新代码必须**:用 `createLogger('<module>')` 而非 `console.log`;主流程入口落 `log.info`(start + 关键字段 userId/path/ms);**catch / 失败 return 之前必须 `log.warn`(可恢复)或 `log.error`(不变量破坏)**——只 `return {ok:false}` 不留日志 = 上层无法定位;敏感信息走 REDACT_KEYS。

开源版本不内置任何远程埋点 / 第三方分析,也不内置应用内调试面板;诊断走日志 + Chromium DevTools(F12)。
