# Orkas

**开源、本地优先的桌面应用：在一个对话里组建并指挥一支 AI agent 团队，用你自己的大模型 key，可完全离线运行。支持 macOS · Windows · Linux。**

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Stars](https://img.shields.io/github/stars/Orkas-AI/Orkas?style=social)](https://github.com/Orkas-AI/Orkas/stargazers)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue)](https://orkas.ai)
[![Download](https://img.shields.io/badge/download-orkas.ai-black)](https://orkas.ai)
[![X: @leochenpm](https://img.shields.io/badge/X-%40leochenpm-black?logo=x)](https://x.com/leochenpm)

[English](./README.md) · [简体中文](./README.zh-CN.md)

![Orkas 演示](./resources/app-ui/demo.gif)

> 一个指挥官 LLM 组建一支 sub-agent 团队，并行或串行地分派任务；agent 通过复盘自我进化。你的对话、文件和 API key 始终不离开本机。

---

## Orkas 是什么？

- **它是什么** —— 一个桌面 GUI 应用，让你组建一支专精的 AI agent 团队，并在同一个对话里指挥它们。不是代码框架，也不是托管 SaaS。
- **本地优先** —— 对话、文件、API key、知识库、自定义 agent 全部留在你的硬盘上。模型调用从你的机器直连服务商，绝不经过 Orkas 服务器。
- **多 agent（指挥官 + sub-agent）** —— 一个指挥官 LLM 并行或串行地分派 sub-agent；每个 agent 拥有自己私有的技能与记忆，并在每次任务后自我进化。
- **自带大模型 key** —— 接入 Claude、OpenAI、Gemini、DeepSeek、Kimi、GLM、Qwen、MiniMax、Doubao，不同 agent 可混用不同服务商，无厂商锁定。

> ⭐ 如果 Orkas 对你有用，点个 star 能帮助更多人发现这个项目。

---

## 你能用它做什么？

- **自动化周期性报告与市场调研** —— 一个 sub-agent 负责收集、汇总并产出每周报告。
- **把产品需求拆成开发任务** —— 指挥官把 PRD 拆成任务，分派给多个 agent。
- **与你的文档对话、做本地数据分析** —— 拖入文件，数据全程留在本机。
- **编排现有 CLI agent** —— OpenClaw、Hermes-Agent、Claude Code、Codex 等本地 CLI agent 可作为后端接入并接收任务交接。

---

## 下载

- **获取应用** → [orkas.ai](https://orkas.ai)（macOS · Windows · Linux 安装包）
- **从源码运行** → 见下方 [快速开始](#快速开始)

---

## Orkas 与同类工具对比

| 工具 | 它是什么 | Orkas 的不同之处 |
| --- | --- | --- |
| **LangChain** | 面向开发者的框架/库，用于构建 LLM 应用与 agent —— 代码优先，嵌入你自己的 Python/JS 应用中。 | Orkas 是 **无代码的桌面 GUI**：通过对话组建并指挥一支 agent 团队，而不是写编排代码。数据与 key 默认留在本地。 |
| **CrewAI** | 一个 Python 框架，用于编排扮演角色的自治 agent —— 你用代码定义 crew 和 agent。 | Orkas 提供同样的多 agent 编排，但**无需写代码**，运行在桌面应用里，内置**本地优先存储**与每个 agent 的自我进化。 |
| **云端 agent 平台**（SaaS 编排器） | 服务器托管；对话、文件、API key 都存在厂商的基础设施上。 | Orkas **本地优先**：一切留在你的机器上，模型 API 调用直连服务商 —— 绝不被 Orkas 归档。 |
| **OpenClaw** | 一个常驻的单一个人助理，跨即时通讯渠道触达你。 | Orkas 在一个桌面对话里组建并指挥一支专精 agent *团队* —— 且 OpenClaw 可作为 Orkas 的 CLI 后端接入。 |
| **Hermes-Agent** | Nous Research 的自我改进个人 agent（TUI + 多渠道网关）。 | Orkas 是桌面 GUI、团队化形态，每个 agent 拥有私有技能与元认知 —— 且 Hermes-Agent 可作为 Orkas 的 CLI 后端接入。 |

**如果你想要的是：**一支 agent *团队*（而非单个助理）、一个支持拖入文件与可视化管理 agent 的桌面 GUI、并希望数据/key/agent 都在自己的硬盘上而非厂商云端 —— 那么 Orkas 适合你。

---

## 快速开始

如果想直接安装，可以使用线上稳定安装包：

- **macOS Apple 芯片** → [Orkas-mac-arm64.dmg](https://orkas-sg-1367889399.cos.ap-singapore.myqcloud.com/public/products/mac/latest/Orkas-mac-arm64.dmg)
- **macOS Intel** → [Orkas-mac-x64.dmg](https://orkas-sg-1367889399.cos.ap-singapore.myqcloud.com/public/products/mac/latest/Orkas-mac-x64.dmg)
- **Windows x64** → [Orkas-Setup.exe](https://orkas-sg-1367889399.cos.ap-singapore.myqcloud.com/public/products/win/latest/Orkas-Setup.exe)

从源码运行：

**环境要求**：Node 20+ · Python 3 · macOS / Windows 10+ / 较新的 Linux

```bash
git clone https://github.com/Orkas-AI/Orkas.git
cd Orkas
./run.sh           # macOS / Linux
run.cmd            # Windows
```

`run.sh` / `run.cmd` 会自动安装依赖并下载嵌入模型（约 95 MB）。首次启动会在 `~/.orkas/`（macOS / Linux）或 `<最小的非系统盘>:\.orkas\`（Windows）下创建工作区。随后进入 **设置 → AI 服务商** 配置 API key 或 OAuth。

---

## 截图

![Orkas 主界面](./resources/app-ui/home-zh.jpg)

---

## 工作原理（核心设计）

> 完整设计与硬约束 → [`CLAUDE.md`](./CLAUDE.md)

### 群聊：可见性切片 + 单一调度原语

一个对话里有指挥官、N 个 agent 和你 —— 但**每个 agent 看到的对话并不相同**。

- **可见性切片** —— 主对话是一份完整 jsonl；每个 agent 只拿到属于自己的切片（`from==me ∨ to∋me ∨ mentions∋me`）。worker 永远读不到完整主对话 —— 既省 token，又防止私有上下文在 agent 间泄漏。
- **单一调度原语** —— 每一次分派（指挥官的 `dispatch_to`、用户的 `@`、计划拆出的步骤）都汇入同一个 `enqueue` 原语，没有并行的路由路径。
- **共享计划** —— 多 agent 协作时，指挥官把进度写进同一份 `plan.md`，对每个成员可见。

### Agent 分派：结构化通道，而非散文里的 `@`

- **结构化分派** —— 指挥官与 agent 之间的分派必须走 `dispatch_to({to, message})` 工具调用；散文里的 `@` 不被识别为分派信号（用户的 `@` 仍按文本识别 —— 用户体验不变）。
- **延迟唤醒** —— 一次 `dispatch_to` 只做暂存；接收方 worker 要等指挥官当前回合结束后才被唤醒，避免过早执行。
- **基于回合的安全停止** —— 失控保护计的是回合数（`MAX_WORKER_TURNS=100`）而非墙钟时间，因此一个慢但在推进的 LLM 不会被误杀。

### 自我进化：`meta/` + 自管理技能

每个 agent 在自己的目录里维护：

- **`meta/COMPETENCE.md`** —— 我擅长什么 / 不擅长什么。
- **`meta/LEARNING_STRATEGIES.md`** —— 对我有效的方法。

每次任务后 agent 复盘并更新它们；下次任务时 `meta/` 会作为系统提示的一部分回喂进去，让经验真正影响下一次运行。通过 `skill_manage` 工具，agent 还能把"我是如何解决 X 的"结晶成一个**私有**技能，下次直接复用。

---

## 致谢

本项目部分核心模块参考了以下开源项目，特此致谢：

- [OpenClaw](https://github.com/openclaw/openclaw)
- [Hermes-Agent](https://github.com/NousResearch/hermes-agent)

---

## 许可证

[MIT](./LICENSE)
