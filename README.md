# Orkas

**Command a team of AI agents from one desktop chat — not one chatbot.**

Orkas is an open-source, local-first multi-agent desktop app. Describe a goal; its **Commander** plans the work, handles the general parts itself, and coordinates specialist agents in parallel or in sequence. **Nine specialist agents ship with the app**, ready the moment you launch it, out of 30 in the marketplace. Bring your own model keys — Claude · OpenAI · Gemini · DeepSeek · Kimi · GLM · Qwen · MiniMax · Doubao. macOS · Windows · Linux.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Stars](https://img.shields.io/github/stars/Orkas-AI/Orkas?style=social)](https://github.com/Orkas-AI/Orkas/stargazers)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue)](https://orkas.ai?source=gh-orkas)
[![Download](https://img.shields.io/badge/download-orkas.ai-black)](https://orkas.ai?source=gh-orkas)
[![X: @leochenpm](https://img.shields.io/badge/X-%40leochenpm-black?logo=x)](https://x.com/leochenpm)

[English](./README.md) · [简体中文](./README.zh-CN.md)

---

**You:** *"Research the top 5 competitors, write it up, and turn it into a deck."*

**Orkas:** the Commander breaks the goal into steps and runs them across specialists — **DeepResearcher** gathers and verifies the sources, **ContentWriter** drafts the report, **PptMaker** builds the slides. One chat, one shared plan, finished files on your disk.

![Orkas demo](./resources/app-ui/demo.gif)

---

## Agents that ship with the app

Installed and ready the first time you launch Orkas — each with its own skills, memory, and tools.

| Agent | What it does |
| --- | --- |
| **DeepResearcher** | Evidence-grounded research — plans the investigation, verifies sources, flags contradictions, ships an auditable report with citations |
| **ContentWriter** | Turns a goal, source material, or a rough draft into publish-ready posts, articles, newsletters, and case studies |
| **PptMaker** | Turns a topic, outline, or document into an attractive, editable, reviewable PPTX deck |
| **ProductDeveloper** | Repo-aware engineering — implement a PRD, fix bugs, refactor, review code, with verifiable results |
| **OfficeWorker** | Create, edit, check, and deliver Word / Excel / PowerPoint / PDF files, one at a time or in batches |
| **VideoStudio** | Make and edit video — narration, AI presenters, captions and dubbing, highlight clips, localization |
| **ImageStudio** | Posters, covers, social images, infographics — HTML/CSS/SVG first, image models when the shot needs them |
| **UIDesigner** | Product goals, PRDs, screenshots, or Figma material into editable, HTML-first UI deliverables |
| **SeoGeoAgent** | Give it a URL — technical audit, content quality, Core Web Vitals, GEO citability, health score, ranked fix list |

**More on the built-in agents →** [orkas.ai/agents](https://orkas.ai/agents/?source=gh-orkas) · **Browse all 30 →** [agent marketplace](https://orkas.ai/views/marketplace/gs/agents/?source=gh-orkas) · or just describe what you need and the Commander builds a custom agent for you.

---

## Why Orkas

- **A super-powered Commander** — understands context, breaks down goals, chooses the right agents, skills, connectors, and tools, and directly handles analysis, writing, research, file work, and automation when no specialist is a better fit.
- **Drives the open-source ecosystem** — plug in external CLI coding agents (Claude Code, Codex, OpenCode, Cline) and onboard open-source projects like HyperFrames as local tools, all coordinated by the same Commander.
- **Local-first by design** — conversations, files, API keys, knowledge bases, and custom agents all stay on your disk. Model calls go straight from your machine to the provider — never through Orkas servers.
- **No vendor lock-in** — mix providers across agents: one on Claude, another on DeepSeek, another on a local endpoint.
- **Agents that get better** — each agent has its own private skills and memory, and improves through reflection after each task.

> ⭐ If Orkas is useful to you, a star helps more people find the project.

---

## Download

Packaged installers for macOS and Windows. Linux runs from source today — see [Quick start](#quick-start).

- **macOS Apple Silicon** -> [Orkas-mac-arm64.dmg](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&os=mac&arch=arm64&download=1)
- **macOS Intel** -> [Orkas-mac-x64.dmg](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&os=mac&arch=x64&download=1)
- **Windows x64** -> [Orkas-Setup.exe](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&os=win&download=1)

---

## What can you build with it?

- **Automate recurring reports & market research** — a specialist agent gathers, summarizes, and ships a weekly report.
- **Turn a product spec into dev tasks** — the Commander breaks a PRD into tasks and dispatches them across agents.
- **Chat with your documents & run local data analysis** — drop files in, keep the data on your machine.
- **Go beyond code — video, slides, and more** — the Commander drives open-source tools like HyperFrames and hands off to CLI coding agents (Claude Code, Codex, OpenCode, Cline) and other local agents, so one chat produces code, research, video, and slide decks.

**Explore use cases →** [research workflows](https://orkas.ai/use/researchers?source=gh-orkas) · [data analysis](https://orkas.ai/use/data-analysis?source=gh-orkas) · [chat with documents](https://orkas.ai/use/chat-with-documents?source=gh-orkas) · [for developers](https://orkas.ai/use/developers?source=gh-orkas) · [automate your workspace](https://orkas.ai/use/automate-workspace?source=gh-orkas)

---

## How Orkas compares

| Tool | What it is | How Orkas differs |
| --- | --- | --- |
| **LangChain** | A developer framework/library for building LLM apps and agents — code-first, embedded in your own Python/JS app. | Orkas is a local-first multi-agent desktop app you direct through chat, not by writing orchestration code. Data and keys stay local by default. |
| **CrewAI** | A Python framework for orchestrating role-playing autonomous agents — you define crews and agents in code. | Orkas brings multi-agent orchestration into a desktop app, with **local-first storage** and per-agent self-evolution built in. |
| **Cloud agent platforms** (SaaS orchestrators) | Server-hosted; conversations, files, and API keys live on the vendor's infrastructure. | Orkas is **local-first**: everything stays on your machine, and model API calls go straight to the provider — never archived by Orkas. |
| **OpenClaw** | A single always-on personal assistant reaching you across messaging channels. | Orkas gives you a team rather than one assistant: the Commander coordinates specialist agents from one desktop chat, and OpenClaw plugs in as an Orkas CLI backend. |
| **Hermes-Agent** | Nous Research's self-improving personal agent (TUI + multi-channel gateway). | Orkas is a local-first multi-agent desktop app, with per-agent private skills and meta-cognition — and Hermes-Agent plugs in as an Orkas CLI backend. |

**Orkas is for you if** you want a team of agents rather than one assistant, a desktop GUI with file drop-in and visual agent management, and your data, keys, and agents on your own disk rather than a vendor cloud.

**Not for you if** you just want a single all-purpose chatbot, a fully hosted/cloud team where your data lives on a vendor's servers, or a pure code library to embed in your own app.

**Full side-by-side comparisons →** [vs Claude Code](https://orkas.ai/compare/orkas-vs-claude-code?source=gh-orkas) · [vs Cline](https://orkas.ai/compare/orkas-vs-cline?source=gh-orkas) · [vs LangChain](https://orkas.ai/compare/orkas-vs-langchain?source=gh-orkas) · [vs ChatGPT](https://orkas.ai/compare/orkas-vs-chatgpt?source=gh-orkas) · [vs OpenClaw](https://orkas.ai/compare/orkas-vs-openclaw?source=gh-orkas)

---

## FAQ

**What is Orkas?**
Orkas is an open-source, local-first multi-agent desktop app. A super-powered Commander plans your goal and coordinates specialist agents to complete it together — nine of them ship with the app. Not a single chatbot, not a code framework, not a hosted SaaS.

**Is Orkas a local LLM?**
No. Orkas runs on your machine but calls the models you choose through your own API keys (or a local model endpoint). It orchestrates agents and tools — it is not itself a model.

**Where are my API keys and data stored?**
On your disk. Conversations, files, knowledge bases, agents, and keys stay local; model calls go straight from your machine to the provider and are never proxied or archived by Orkas.

**Does Orkas work offline?**
The app is fully offline-capable — only the model calls need network. Point agents at a local model endpoint and you can run without the cloud.

**Can Orkas drive Claude Code and other CLI coding agents?**
Yes. Beyond its own Commander and specialist agents, Orkas can drive external CLI coding agents — Claude Code, Codex, OpenCode, Cline — as local subprocesses, and onboard open-source projects like HyperFrames, all directed from the same chat.

**How is Orkas different from Claude Desktop / CrewAI / LangChain?**
Claude Desktop is a single assistant; CrewAI and LangChain are code-first frameworks. Orkas is a local-first multi-agent desktop app: the Commander coordinates specialist agents, keeps data and keys local, and gives each agent its own private skills and memory. See the [full comparisons](https://orkas.ai/compare/orkas-vs-langchain?source=gh-orkas).

**Is Orkas free and open source?**
Yes — the app is MIT licensed and free to use. Bring your own model keys and you pay only your model providers; Orkas never takes a cut. Optionally, the desktop app also offers a built-in **Orkas model** for people who don't want to manage API keys — that one is billed by Orkas in credits (membership or credit packs). It is entirely opt-in, and every other feature works on your own keys. [Pricing →](https://orkas.ai/pricing/?source=gh-orkas)

---

## Quick start

Want a packaged installer instead? See [Download](#download) above. To run from source — currently the way to run Orkas on Linux:

**Requirements**: Node 20+ · Python 3 · macOS / Windows 10+ / recent Linux

```bash
git clone https://github.com/Orkas-AI/Orkas.git
cd Orkas
./run.sh           # macOS / Linux
run.cmd            # Windows
```

`run.sh` / `run.cmd` auto-installs dependencies and downloads the embedding model (~95 MB). First launch creates a workspace under `~/.orkas/` (macOS / Linux) or `<smallest non-system drive>:\.orkas\` (Windows). Then open **Settings → AI Providers** to add an API key or OAuth.

---

## Screenshots

![Orkas home screen](./resources/app-ui/home-en.jpg)

---

## How it works (core design)

> Full design and hard constraints → [`CLAUDE.md`](./CLAUDE.md)

### Group chat: visibility slicing + a single scheduling primitive

In one chat there's the Commander, N specialist agents, and you — but **each agent does not see the same conversation**.

- **Visibility slicing** — the main conversation is one full jsonl; each agent only gets a slice (`from==me ∨ to∋me ∨ mentions∋me`). A worker never reads the full main conversation — saves tokens and prevents private context from leaking across agents.
- **One scheduling primitive** — every dispatch (the Commander's `dispatch_to`, the user's `@`, plan steps) funnels into the same `enqueue` primitive. No parallel routing paths.
- **Shared plan** — when agents collaborate, the Commander writes progress into one `plan.md`, visible to every member.

### Agent dispatch: structured channels, not `@` in prose

- **Structured dispatch** — Commander-to-agent dispatches go through the `dispatch_to({to, message})` tool call; `@` in prose is not treated as a dispatch signal (the user's `@` is still recognized — UX unchanged).
- **Deferred wake-up** — a `dispatch_to` only stages; the recipient wakes only after the Commander's turn finishes, preventing premature execution.
- **Turn-based safety stop** — the runaway guard counts turns (`MAX_WORKER_TURNS=100`), not wall-clock time, so a slow-but-progressing LLM isn't killed.

### Self-evolution: `meta/` + self-managed skills

Each agent maintains, in its own directory:

- **`meta/COMPETENCE.md`** — what it's good / not good at.
- **`meta/LEARNING_STRATEGIES.md`** — methods that have worked for it.

After each task the agent reflects and updates these; on the next task `meta/` is fed back into the system prompt, so experience shapes the next run. Via the `skill_manage` tool an agent can also crystallize "how I solved X" into a **private** skill, reused directly next time.

---

## Acknowledgments

Some core modules draw on these open-source projects — special thanks to:

- [OpenClaw](https://github.com/openclaw/openclaw)
- [Hermes-Agent](https://github.com/NousResearch/hermes-agent)

---

## License

[MIT](./LICENSE)
