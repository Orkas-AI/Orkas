# Orkas

**开源的 AI 智能体团队，就在你的桌面上——把目标变成交付成果，并持续推进。**

Orkas 是一个开源（MIT）、本地优先的多智能体桌面应用，也是一支协同工作的 AI 助手团队。把要做的事告诉**指挥官**（Commander）：很多任务它自己就能直接完成；遇到更大的工作，它会拆分步骤，调动专业智能体，以及你已在使用的编程与个人智能体——**Claude Code、Codex、OpenCode、OpenClaw 和 Hermes-Agent**——一起协作完成。

Orkas 为持续推进的项目而设计，而不只是回答一次提问。**项目**汇集目标、规则、记忆和文件，每次新对话都能接着上次继续；**待办**把工作分给人和智能体；**Auto-advance**（自动推进）让团队自己接手下一项待办；**定时自动化**按小时、每天、每周或每月重复例行工作。所有数据都保存在你的电脑上，完成的成果交回给你审核——生意上需要持续推进的事，可以放心交给 Orkas。

**[⬇ 下载 Orkas：macOS 与 Windows](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)** —— 免费使用，内置 Orkas 模型赠送 500 积分，开始使用无需 API Key。也可以用自己的 Key：Claude · OpenAI · Gemini · DeepSeek · Kimi · GLM · Qwen · MiniMax · Doubao，或接入本地 OpenAI 兼容模型端点。

[![下载 macOS 与 Windows 版](https://img.shields.io/badge/Download-macOS%20%26%20Windows-5b57d6?style=for-the-badge)](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)

[![许可证：MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![GitHub Stars](https://img.shields.io/github/stars/Orkas-AI/Orkas?style=flat&logo=github&label=Stars&color=yellow)](https://github.com/Orkas-AI/Orkas/stargazers)
[![Release](https://img.shields.io/github/v/release/Orkas-AI/Orkas?color=blue)](https://github.com/Orkas-AI/Orkas/releases)
[![X: @leochenpm](https://img.shields.io/badge/X-%40leochenpm-black?logo=x)](https://x.com/leochenpm)
[![官网：orkas.ai](https://img.shields.io/badge/Website-orkas.ai-5b57d6)](https://orkas.ai/?source=gh-orkas)

[English](./README.md) · [简体中文](./README.zh-CN.md)

---

https://github.com/user-attachments/assets/4f8b16c8-a192-45a4-b19f-80e8d02c3dab

![Orkas 桌面界面 — 任务对话与交付文件](./resources/app-ui/task-zh.png)

---

## 团队能交付什么

- **视频、配音与图片** —— VideoStudio、VoiceStudio、ImageStudio
- **研究报告、SEO 审计与市场分析** —— DeepResearcher、SeoGeoAgent、StockAnalyser
- **帖子、文章、简报与幻灯片** —— ContentWriter、PptMaker
- **网站、UI 与代码** —— UIDesigner、ProductDeveloper
- **Word、Excel、PowerPoint 与 PDF 文件** —— OfficeWorker
- **电商工作** —— 5 个电商智能体负责选品、商品文案、评价分析、经营分析与商品运营
- **需要多个智能体配合的复杂任务** —— 指挥官拆分任务，把每一部分交给合适的智能体，再把结果整合起来；比如一次市场调研，最后交付报告、幻灯片和发布视频

16 个专业智能体随应用内置，各有自己的技能、记忆和工具。[智能体库](https://orkas.ai/views/marketplace/gs/agents/?source=gh-orkas)中有 30+ 个智能体可供选择；也可以描述所需角色，让指挥官为你创建自定义智能体。

<details>
<summary><b>全部 16 个内置智能体</b></summary>

| 领域 | 智能体 | 交付内容 |
| --- | --- | --- |
| 研究与分析 | **DeepResearcher** | 核实来源、标记矛盾，交付有依据、可追溯的研究报告 |
| | **SeoGeoAgent** | 从 URL 开始，审计技术 SEO、内容质量、Core Web Vitals 和 AI 回答引用能力（GEO），按优先级列出修复项 |
| | **StockAnalyser** | 股票研究、因子筛选、回测与组合风险检查，附可追溯的数据看板 |
| 内容与媒体 | **ContentWriter** | 将目标、来源或初稿写成可发布的帖子、文章、简报与案例 |
| | **PptMaker** | 从主题、大纲或文档制作可编辑、可审核的 PPTX 幻灯片 |
| | **ImageStudio** | 海报、封面、社媒图片与信息图 |
| | **VideoStudio** | 视频制作与编辑，包括旁白、AI 主播、字幕、配音、片段提取、本地化，以及用自己的内容和素材复刻参考视频 |
| | **VoiceStudio** | 旁白、多角色音频、转写与字幕、音频编辑和混音 |
| | **UIDesigner** | 从产品目标、PRD、截图或 Figma 素材制作以 HTML 为主的可编辑 UI |
| 开发与办公 | **ProductDeveloper** | 理解代码仓库，落实 PRD、修复缺陷、重构和审查代码，交付可验证的结果 |
| | **OfficeWorker** | 创建、编辑、检查和交付 Word、Excel、PowerPoint 与 PDF，支持单份或批量处理 |
| 电商 | **ECommerceResearcher** | 按预算、市场和采购限制筛选产品，给出候选、淘汰理由和验证计划 |
| | **ECommerceWriter** | 按品牌语气撰写标题、详情页、FAQ、图片文案与视频脚本 |
| | **ECommerceReviewer** | 分析评价与口碑，归纳客户主题、差评根因和改进优先级 |
| | **ECommerceAnalyzer** | 从导出文件核对销售、利润、广告、退款与库存指标，给出经营建议 |
| | **ECommerceOperator** | 规划商品、价格、促销与库存调整，仅通过你已连接的工具执行 |

了解各智能体 → [orkas.ai/agents](https://orkas.ai/agents/?source=gh-orkas)

</details>

### 用自己的内容和素材复刻参考视频

**VideoStudio** 可以参考爆款视频的叙事结构、视觉风格和剪辑节奏，换成你的产品、文案与素材制作新片。提供参考视频文件和自己的素材后，智能体会分析钩子、信息顺序、画面节拍与行动引导，先列出保留和替换的部分，再进入制作。

适合文字动效讲解、SaaS 或 App 演示，以及用已有商品素材重做广告。单独制作的文字、字幕、配音和片段可以分别修改；AI 生成画面里嵌入的文字需要修改对应画面。

> “参考 reference.mp4 做一条 30 秒竖屏宣传片，保留它的钩子、字体风格和节奏，换成我的产品与录屏。先给我看拆解和制作方案。”

需要提供智能体可读取的视频文件，暂未内置社交平台分享链接下载；不保证精确运镜、真人表演或逐帧还原。详见[参考复刻工作流](./resources/builtin/marketplace/agents/79df9cc89f5f/skills/video-craft/references/reference-recreation.md)。

---

## 让工作持续推进

完成一项任务只是开始。Orkas 也为需要持续开展的工作而设计。

- **项目** —— 目标与规则、记忆、文件随项目共享，每个新对话都能接着做，不必从头交代背景。
- **待办与 Auto-advance** —— 项目中的待办可交给人或智能体；开启自动推进后，团队会自行接手下一项工作，并将完成的成果交回给你审核。
- **定时自动化** —— 按小时、每天、每周或每月执行任务。Orkas 在你的电脑上运行；从 1.9 起，电脑唤醒或应用启动后，每个自动化会补跑 12 小时内最近一次错过的任务。
- **连接器** —— 接入 Gmail、Google Calendar、Sheets、Drive、Notion、Slack、Shopify、Stripe 等服务。默认情况下，Orkas 会在发送、发帖或删除前询问你。
- **应用** —— 描述你需要的工具，Orkas 就能将它做成桌面应用内的本地应用；在安装版中，付费会员还可以将其发布为带公开链接的网页应用。
- **共享项目**（安装版）—— 邀请同事或虚拟助理加入，将每条待办分配给人或智能体。

> [!NOTE]
> 共享项目、云同步和网页应用发布目前只在安装版中提供，开源版暂不支持。需要这些功能，可以 **[下载 Orkas：macOS 与 Windows](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)**（免费，赠送 500 积分）。

---

## 一起运行 Claude Code、Codex、OpenCode、OpenClaw 和 Hermes-Agent

Orkas 将你已安装的 CLI 智能体作为本地会话运行，与内置专业智能体一起工作：包括编程智能体 **Claude Code、Codex 和 OpenCode**，以及个人智能体 **OpenClaw 和 Hermes-Agent**。指挥官协调分工，并在它们之间保持同一份计划，让一个对话完成缺陷修复、变更审查和发布说明撰写。HyperFrames 等开源工具也可接入同一工作流。

[一起使用 Claude Code 和 Codex →](https://orkas.ai/blog/claude-code-codex-together/?source=gh-orkas)

---

## 为什么选择 Orkas

- **会规划、分工，也会亲自完成工作的指挥官** —— 拆解目标，选择合适的智能体、技能、连接器与工具；没有更合适的专业智能体时，亲自处理分析、写作、研究和文件工作。
- **本地优先** —— 对话、文件、知识库和自定义智能体默认保存在本机，安装版可选择开启云同步。使用自己的 Key 时，模型调用从本机直连服务商；内置 Orkas 模型通过 Orkas 托管服务运行。
- **模型随时可切换** —— 指挥官与内置智能体共用一个模型设置，可选择内置 Orkas 模型、自有服务商或本地端点；外接 CLI 智能体保留各自的模型设置。
- **能积累经验的智能体** —— 各自保留私有技能与记忆；后台复盘在应用空闲时检查新活动，可改进自我评估、可复用方法与学习到的技能。
- **开源、可审查** —— MIT 许可证，可以查看 Orkas、智能体与技能的具体实现。

> ⭐ 如果 Orkas 对你有用，点一颗 Star 能帮助更多人发现它。

---

## 下载

| | 安装版（推荐） | 源码版 |
| --- | --- | --- |
| 平台 | macOS 12+（Apple Silicon 与 Intel）、Windows 10+ | macOS、Windows、glibc 2.34+ Linux x64/arm64 |
| 账号 | 登录即送 500 积分 | 无需账号 |
| 模型 | 内置 Orkas 模型，或使用自己的 Key | 自己的 Key，或本地模型端点 |
| 另含 | 项目协作、应用发布、云端同步等 | — |
| 获取方式 | **[下载 Orkas](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)** | [快速开始](#快速开始) |

下载链接会识别你的系统，并开始下载对应安装包。

---

## 使用场景

- **营销内容** —— 用你的品牌语气制作发布视频、产品页面、帖子与简报。[内容写作](https://orkas.ai/use/content-writing/?source=gh-orkas) · [视频](https://orkas.ai/use/make-videos/?source=gh-orkas)
- **店铺经营** —— 销售周报、评价回复、商品文案与竞品检查。[电商](https://orkas.ai/use/ecommerce/?source=gh-orkas)
- **研究与报告** —— 按需或定期交付带来源的报告与幻灯片。[研究](https://orkas.ai/use/researchers/?source=gh-orkas) · [数据分析](https://orkas.ai/use/data-analysis/?source=gh-orkas)
- **和文档对话** —— 基于你自己的文件回答问题，并标注来源段落，方便核对。[文档问答](https://orkas.ai/use/chat-with-documents/?source=gh-orkas)
- **客户项目** —— 按你的模板制作会议简报、客户月报与进度幻灯片。[客户月报模板](https://orkas.ai/blog/monthly-client-report-template/?source=gh-orkas)
- **产品发布** —— 落地页、带测试的缺陷修复、更新日志与发布帖子。[面向开发者](https://orkas.ai/use/developers/?source=gh-orkas)
- **做应用** —— 报价计算器、预约表单、内部工具。[做应用](https://orkas.ai/use/build-apps/?source=gh-orkas)
- **小团队协作** —— 人与智能体在同一个项目里协作。[小团队](https://orkas.ai/use/small-teams/?source=gh-orkas)

---

## Orkas 与同类工具对比

| 工具 | 它是什么 | Orkas 的不同之处 |
| --- | --- | --- |
| **Claude Code** | Anthropic 的编程智能体，可在终端、IDE、桌面和网页中使用，基于 Claude 模型。 | 两者不是二选一：Orkas 把 Claude Code 作为团队中的一个智能体来运行；在此之上，Orkas 提供不绑定模型的智能体团队，处理代码之外的工作（研究、内容、视频等），并用项目、待办和自动化让工作持续推进。[Orkas 与 Claude Code 对比 →](https://orkas.ai/compare/orkas-vs-claude-code/?source=gh-orkas) |
| **Codex** | OpenAI 的编程智能体，可在终端、编辑器和云端使用。 | 两者不是二选一：Orkas 把 Codex 作为其中一个智能体来运行，与 Claude Code、OpenCode 并列。指挥官可以把编码交给 Codex、把审查交给另一个智能体，再完成发布中代码之外的部分（文档、发布帖和视频）。[Orkas 与 Codex 对比 →](https://orkas.ai/compare/orkas-vs-codex/?source=gh-orkas) |
| **LangChain** | 面向开发者的 LLM 应用与智能体框架，通过代码嵌入 Python/JS 应用。 | Orkas 是通过对话指挥的桌面应用，数据默认保存在本地。 |
| **CrewAI** | 通过 Python 代码定义团队与角色、编排自治智能体的框架。 | Orkas 将多智能体编排做成桌面应用，内置项目、待办、自动化与各智能体的经验积累。 |
| **OpenClaw** | 提供消息渠道集成、多智能体路由和子智能体能力的个人智能体平台。 | Orkas 提供面向成品交付的桌面工作区，内置专业智能体，并协调 Claude Code、Codex、OpenCode 等 CLI 智能体；OpenClaw 也可作为其中一员接入。 |
| **Hermes-Agent** | Nous Research 的自我改进智能体，具备记忆与技能，提供 CLI、消息网关和桌面版。 | Orkas 由指挥官协调多个专业智能体与外部 CLI 智能体，Hermes-Agent 也可作为其中一员接入。 |

**适合你，如果你希望**：让智能体团队协作，跨天持续推进工作，并将数据、Key 与智能体默认保存在自己的硬盘上。

**不适合你，如果你只需要**：一个通用聊天机器人，或嵌入自己应用的纯代码框架。

**选择编程智能体？** [Codex vs OpenCode](https://orkas.ai/compare/codex-vs-opencode/?source=gh-orkas) · [Claude Code vs Codex vs OpenCode](https://orkas.ai/compare/claude-code-vs-codex-vs-opencode/?source=gh-orkas) · [Claude Code 替代方案](https://orkas.ai/compare/claude-code-alternatives/?source=gh-orkas)

**逐项对比 →** [vs Claude Code](https://orkas.ai/compare/orkas-vs-claude-code?source=gh-orkas) · [vs Codex](https://orkas.ai/compare/orkas-vs-codex?source=gh-orkas) · [vs Cline](https://orkas.ai/compare/orkas-vs-cline?source=gh-orkas) · [vs LangChain](https://orkas.ai/compare/orkas-vs-langchain?source=gh-orkas) · [vs ChatGPT](https://orkas.ai/compare/orkas-vs-chatgpt?source=gh-orkas) · [vs OpenClaw](https://orkas.ai/compare/orkas-vs-openclaw?source=gh-orkas) · [vs Hermes-Agent](https://orkas.ai/compare/orkas-vs-hermes-agent?source=gh-orkas)

---

## 快速开始

想直接用安装包？见上方 [下载](#下载)。以下是从源码运行的方式 —— 也是目前在 Linux 上运行 Orkas 的方式：

**环境要求**：Node 22.12+ · macOS / Windows 10+ / 基于 glibc 2.34+ 的 Linux x64 或 arm64。建议保留 Python 3 与 C/C++ 构建工具链，用于少数原生模块需要源码编译的兜底场景。

```bash
git clone https://github.com/Orkas-AI/Orkas.git
cd Orkas
./run.sh           # macOS / Linux
run.cmd            # Windows
```

Linux 源码运行需要 glibc 2.34+，不支持 Alpine 及其他基于 musl 的发行版。本地语音转写会在首次源码启动时下载并校验目标架构对应的 whisper.cpp 运行时及多语言模型。

`run.sh` / `run.cmd` 会在首次启动时安装 lockfile 固定的 npm 依赖，并准备固定版本的 Python、uv、Node、嵌入模型（约 95 MB）、OfficeCLI、FFmpeg、whisper.cpp 与多语言语音模型。Linux 启动还会在 Electron ABI 下验证平台原生模块及 Whisper 运行时后再打开应用。OCR 与 Skill 专属 Python 包会在首次使用对应功能时安装到隔离的本地环境。首次启动会在 `~/.orkas/`（macOS / Linux）或 `<最小的非系统盘>:\.orkas\`（Windows）下创建工作区。随后进入 **设置 → AI 服务商** 配置 API key 或 OAuth。

遇到原生依赖错误时，请使用 Node.js 24 LTS（最低 22.12.0），在此源码目录执行
`npm run native:repair`。它会恢复可选依赖、修复 Electron 对应的 SQLite，并验证 SQL、
sqlite-vec，并准备随包 Node、在独立进程中验证 sharp 后才报告成功。只检查、不安装可运行 `npm run native:check`。
具体检查内容见[原生依赖校验脚本](./scripts/verify-native-dependencies.cjs)。

---

## 工作原理

### 任务分工

指挥官亲自处理通用工作，通过三种工具委派专业任务：

- **`dispatch_to`** 调用具名智能体，取得结果后继续工作；既可等待结果，也可异步运行，在任务结束后通知指挥官。
- **`hand_off_to`** 将剩余工作交给具名智能体，并结束指挥官当前回合，由智能体直接回复；如果还有更大的任务待完成，也可设置后续步骤，让指挥官之后恢复工作。
- **`run_worker`** 执行匿名、隔离的子任务，将结果私下回传；它不接收对话历史或具名智能体的技能。

具名智能体任务和匿名 worker 分别受并发控制。参见[派发实现](./src/main/features/group_chat/bus.ts)与[执行锁](./src/main/util/locks.ts)。

### 上下文管理

运行时根据所选模型可用的输入容量分配上下文，计入提示、工具和持续保留的运行状态。已完成对话使用有界的近期历史窗口；较长的当前任务通过检查点压缩早期过程消息，保留近期工作。文件读取、文件变更与命令执行也有结构化记录，可在上下文压缩后保留。

参见[上下文预算](./src/core-agent/src/agent/context-budget.ts)、[会话历史与检查点](./src/core-agent/src/agent/session.ts)和[工作区记录](./src/core-agent/src/agent/workspace-state.ts)。

### 记忆与资料库

持久记忆分别保存用户偏好、项目事实和各智能体可复用的知识；它们与资料库的文档索引、已保存的对话历史是不同的数据来源。

资料库将文档提取成段落，建立本地 SQLite 向量索引，嵌入模型在你的电脑上运行。智能体通过 `library` 工具列出文件、搜索相关段落和读取来源内容，范围包括全局资料库与当前项目资料库；较早的对话则通过 `chat_history` 单独检索。

参见[分层记忆](./src/main/features/memory.ts)、[文档提取](./src/main/util/file_to_chunks.ts)、[资料库工具](./src/main/model/core-agent/kb-tools.ts)和[对话检索](./src/main/model/core-agent/chat-history-tools.ts)。

### 执行保护与恢复

会话锁和并发限制控制同时运行的工作量。工具轮数预算、进度检查点、重复调用检查和分阶段的空闲监测，共同约束停滞或重复执行的任务。具名智能体任务可以单独跟踪和取消；任务已接收或已排队，不会被当作已经完成。

参见[角色预算](./src/main/features/group_chat/actor-budgets.ts)、[智能体运行时](./src/core-agent/src/agent/runner.ts)和[桌面模型适配层](./src/main/model/core-agent/client.ts)。

### 从工作中积累经验

后台复盘在应用空闲时检查智能体的新活动，并受冷却间隔和执行限制控制。复盘可更新智能体的自我评估（`COMPETENCE.md`）、可复用方法（`LEARNING_STRATEGIES.md`）或学习到的技能，也可以判断没有值得保存的新内容。复盘依据新活动安排，而非按完成任务的次数触发。

参见[复盘调度](./src/main/features/reflection-orchestrator.ts)与[复盘提示](./src/core-agent/src/evolution/metacognition.ts)。

---

## 常见问题（FAQ）

**Orkas 是什么？**
Orkas 是开源（MIT）、本地优先的多智能体桌面应用。指挥官将目标拆成待办，协调 16 个内置专业智能体，以及 Claude Code、Codex、OpenCode、OpenClaw 和 Hermes-Agent，交付成品文件。

**需要 API Key 吗？**
不需要。安装版赠送 500 积分，可直接使用内置 Orkas 模型。用完后可购买积分、选择付费会员，或添加自己的模型服务商 Key；自有服务商的费用单独计算。

**Orkas 是本地大模型吗？**
不是。Orkas 在你的电脑上运行，调用你选择的内置 Orkas 模型、自有 API Key 或本地模型端点。它负责协调智能体与工具，本身不是模型。

**能基于我的文档回答问题，并标注出处吗？**
可以。把 PDF 和文档加入本地资料库，Orkas 可搜索这些文件，并在回答中引用来源段落，方便打开原文核对。索引在本机建立。

**能使用 Ollama、LM Studio 等本地模型吗？**
可以。打开 **账号设置 → 模型 → 对话 → 添加模型 → 自定义**，选择 **OpenAI 兼容** 或 **Anthropic 兼容**，填写基础地址、准确的模型 ID 和 API Key，然后在任务的模型控件中选择已保存的模型。

**API Key 和数据存在哪里？**
默认保存在本机。你自己的服务商 Key 在本地加密保存，并排除在云同步之外。使用自己的 Key 时，模型调用从本机直连服务商；内置 Orkas 模型使用 Orkas 托管服务。安装版的可选云同步和共享项目会将所选数据保存在 Orkas 服务器上。[安全与数据处理 →](https://orkas.ai/security/?source=gh-orkas)

**Orkas 能完全离线使用吗？**
源码版配合本地模型端点可以完全离线运行。安装版需要登录，云端模型调用需要联网。

**电脑关机后还会继续工作吗？**
不会。Auto-advance 和定时自动化需要电脑保持唤醒，且 Orkas 正在运行。从 1.9 起，电脑唤醒或应用启动后，每个自动化会补跑 12 小时内最近一次错过的任务。

**能做应用和发布应用吗？**
可以。在 Orkas 内运行的本地应用免费。将网页应用发布为公开链接需要付费会员，Lite、Pro、Max 分别可发布 5、8、15 个；公开网页应用不包含 Orkas 桌面应用内的全部能力。

**需要 Orkas 账号吗？**
安装版首次启动时需要登录。本仓库的源码版没有账号模块，启动后直接进入应用。

**能驱动 Claude Code 等 CLI 智能体吗？**
可以。Orkas 能将五个外部 CLI 智能体作为本地子进程运行：Claude Code、Codex、OpenCode、OpenClaw 和 Hermes-Agent；也可接入 HyperFrames 等开源工具，在同一个对话中协调工作。

**和 Claude Code、Codex、CrewAI、LangChain 有什么不同？**
Claude Code 和 Codex 是编程智能体，Orkas 可以把它们都作为团队成员来运行，不必二选一；CrewAI 和 LangChain 是代码优先的框架。Orkas 是开源桌面应用，由指挥官协调专业智能体与 CLI 智能体，可选择不同模型服务商，数据与 Key 默认保存在本地。[查看完整对比](https://orkas.ai/compare/?source=gh-orkas)。

**支持哪些平台？**
macOS 12+（Apple Silicon 与 Intel）和 Windows 10+ 提供安装包。glibc 2.34+ Linux x64/arm64 目前通过源码运行，尚无安装包；首次启动会准备固定版本的 whisper.cpp 运行时，支持本地语音转写。不支持 Alpine 等基于 musl 的发行版。源码启动需要 Node 22.12+；只有原生 npm 包缺少兼容的预编译文件、需要本地重建时，才需要 Python 3 和 C/C++ 构建工具链。

**Orkas 免费且开源吗？**
是的，应用采用 MIT 许可证，可免费使用。安装版赠送 500 积分；付费会员每月 $11.99 起，增加月度积分、云同步、更多共享项目和网页应用发布能力。使用自己的 Key 时，模型用量由服务商计费，Orkas 不加价。[价格 →](https://orkas.ai/pricing/?source=gh-orkas)

---

## 许可证

[MIT](./LICENSE)
