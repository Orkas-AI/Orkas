# Orkas

**開源的 AI 智能體團隊，就在你的桌面上——把目標變成交付成果，並持續推進。**

Orkas 是一個開源（MIT）、本地優先的多智能體桌面應用，也是一支協同工作的 AI 助手團隊。把要做的事告訴**指揮官**（Commander）：很多工它自己就能直接完成；遇到更大的工作，它會拆分步驟，調動專業智能體，以及你已在使用的程式設計與個人智能體——**Claude Code、Codex、OpenCode、OpenClaw 和 Hermes-Agent**——一起協作完成。

Orkas 為持續推進的專案而設計，而不只是回答一次提問。**專案**彙集目標、規則、記憶和檔案，每次新對話都能接著上次繼續；**待辦事項**把工作分給人和智能體；**Auto-advance**（自動推進）讓團隊自己接手下一項待辦事項；**定時自動化**按小時、每天、每週或每月重複例行工作。所有資料都儲存在你的電腦上，完成的成果交回給你稽核——生意上需要持續推進的事，可以放心交給 Orkas。

**[⬇ 下載 Orkas：macOS 與 Windows](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)** —— 免費使用，內建 Orkas 模型贈送 500 積分，開始使用無需 API Key。也可以用自己的 Key：Claude · OpenAI · Gemini · DeepSeek · Kimi · GLM · Qwen · MiniMax · Doubao，或接入本地 OpenAI 相容模型端點。

[![下載 macOS 與 Windows 版](https://img.shields.io/badge/Download-macOS%20%26%20Windows-5b57d6?style=for-the-badge)](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)

[![許可證：MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![GitHub Stars](https://img.shields.io/github/stars/Orkas-AI/Orkas?style=flat&logo=github&label=Stars&color=yellow)](https://github.com/Orkas-AI/Orkas/stargazers)
[![Release](https://img.shields.io/github/v/release/Orkas-AI/Orkas?color=blue)](https://github.com/Orkas-AI/Orkas/releases)
[![X: @leochenpm](https://img.shields.io/badge/X-%40leochenpm-black?logo=x)](https://x.com/leochenpm)
[![官網：orkas.ai](https://img.shields.io/badge/Website-orkas.ai-5b57d6)](https://orkas.ai/?source=gh-orkas)

[English](./README.en.md) · [简体中文](./README.zh-CN.md) · [日本語](./README.ja.md) · [한국어](./README.ko.md) · [Español](./README.es.md) · [Bahasa Indonesia](./README.id.md) · [Español (Latinoamérica)](./README.es-419.md) · [Русский](./README.ru.md) · [Português (Brasil)](./README.pt-BR.md) · [Türkçe](./README.tr.md) · [繁體中文](./README.zh-TW.md) · [Tiếng Việt](./README.vi.md) · [Deutsch](./README.de.md) · [ไทย](./README.th.md) · [Français](./README.fr.md) · [Italiano](./README.it.md) · [Português (Portugal)](./README.pt-PT.md) · [العربية](./README.ar.md)

---

https://github.com/user-attachments/assets/4f8b16c8-a192-45a4-b19f-80e8d02c3dab

![Orkas 桌面介面 — 任務對話與交付檔案](./resources/app-ui/task-zh.png)

---

## 團隊能交付什麼

- **影片、配音與圖片** —— [VideoStudio](https://github.com/Orkas-AI/Orkas-VideoStudio)、VoiceStudio、ImageStudio
- **研究報告、SEO 審計與市場分析** —— DeepResearcher、SeoGeoAgent、StockAnalyser
- **帖子、文章、簡報與幻燈片** —— ContentWriter、PptMaker
- **網站、UI 與程式碼** —— UIDesigner、ProductDeveloper
- **Word、Excel、PowerPoint 與 PDF 檔案** —— OfficeWorker
- **電商工作** —— 5 個電商智能體負責選品、商品文案、評價分析、經營分析與商品運營
- **需要多個智能體配合的複雜任務** —— 指揮官拆分任務，把每一部分交給合適的智能體，再把結果整合起來；比如一次市場調研，最後交付報告、幻燈片和釋出影片

16 個專業智能體隨應用內建，各有自己的技能、記憶和工具。[智能體庫](https://orkas.ai/views/marketplace/gs/agents/?source=gh-orkas)中有 30+ 個智能體可供選擇；也可以描述所需角色，讓指揮官為你建立自定義智能體。

<details>
<summary><b>全部 16 個內建智能體</b></summary>

| 領域 | 智能體 | 交付內容 |
| --- | --- | --- |
| 研究與分析 | **DeepResearcher** | 核實來源、標記矛盾，交付有依據、可追溯的研究報告 |
| | **SeoGeoAgent** | 從 URL 開始，審計技術 SEO、內容質量、Core Web Vitals 和 AI 回答引用能力（GEO），按優先順序列出修復項 |
| | **StockAnalyser** | 股票研究、因子篩選、回測與組合風險檢查，附可追溯的資料看板 |
| 內容與媒體 | **ContentWriter** | 將目標、來源或初稿寫成可釋出的帖子、文章、簡報與案例 |
| | **PptMaker** | 從主題、大綱或文件製作可編輯、可稽核的 PPTX 幻燈片 |
| | **ImageStudio** | 海報、封面、社媒圖片與資訊圖 |
| | **[VideoStudio](https://github.com/Orkas-AI/Orkas-VideoStudio)** | 影片製作與編輯，包括旁白、AI 主播、字幕、配音、片段提取、本地化，以及用自己的內容和素材復刻參考影片 |
| | **VoiceStudio** | 旁白、多角色音訊、轉寫與字幕、音訊編輯和混音 |
| | **UIDesigner** | 從產品目標、PRD、截圖或 Figma 素材製作以 HTML 為主的可編輯 UI |
| 開發與辦公 | **ProductDeveloper** | 理解程式碼倉庫，落實 PRD、修復缺陷、重構和審查程式碼，交付可驗證的結果 |
| | **OfficeWorker** | 建立、編輯、檢查和交付 Word、Excel、PowerPoint 與 PDF，支援單份或批次處理 |
| 電商 | **ECommerceResearcher** | 按預算、市場和採購限制篩選產品，給出候選、淘汰理由和驗證計劃 |
| | **ECommerceWriter** | 按品牌語氣撰寫標題、詳情頁、FAQ、圖片文案與影片指令碼 |
| | **ECommerceReviewer** | 分析評價與口碑，歸納客戶主題、差評根因和改進優先順序 |
| | **ECommerceAnalyzer** | 從匯出檔案核對銷售、利潤、廣告、退款與庫存指標，給出經營建議 |
| | **ECommerceOperator** | 規劃商品、價格、促銷與庫存調整，僅透過你已連線的工具執行 |

瞭解各智能體 → [orkas.ai/agents](https://orkas.ai/agents/?source=gh-orkas)

</details>

### 用自己的內容和素材復刻參考影片

**VideoStudio** 可以參考爆款影片的敘事結構、視覺風格和剪輯節奏，換成你的產品、文案與素材製作新片。提供參考影片檔案和自己的素材後，智能體會分析鉤子、資訊順序、畫面節拍與行動引導，先列出保留和替換的部分，再進入製作。

適合文字動效講解、SaaS 或 App 演示，以及用已有商品素材重做廣告。單獨製作的文字、字幕、配音和片段可以分別修改；AI 生成畫面裡嵌入的文字需要修改對應畫面。

> “參考 reference.mp4 做一條 30 秒豎屏宣傳片，保留它的鉤子、字型風格和節奏，換成我的產品與錄屏。先給我看拆解和製作方案。”

需要提供智能體可讀取的影片檔案，暫未內建社交平臺分享連結下載；不保證精確運鏡、真人表演或逐幀還原。詳見[參考復刻工作流](./resources/builtin/marketplace/agents/79df9cc89f5f/skills/video-craft/references/reference-recreation.md)。

---

## 讓工作持續推進

完成一項任務只是開始。Orkas 也為需要持續開展的工作而設計。

- **專案** —— 目標與規則、記憶、檔案隨專案共享，每個新對話都能接著做，不必從頭交代背景。
- **待辦事項與 Auto-advance** —— 專案中的待辦事項可交給人或智能體；開啟自動推進後，團隊會自行接手下一項工作，並將完成的成果交回給你稽核。
- **定時自動化** —— 按小時、每天、每週或每月執行任務。Orkas 在你的電腦上執行；從 1.9 起，電腦喚醒或應用啟動後，每個自動化會補跑 12 小時內最近一次錯過的任務。
- **聯結器** —— 接入 Gmail、Google Calendar、Sheets、Drive、Notion、Slack、Shopify、Stripe 等服務。預設情況下，Orkas 會在傳送、發帖或刪除前詢問你。
- **應用** —— 描述你需要的工具，Orkas 就能將它做成桌面應用內的本地應用；在安裝版中，付費會員還可以將其釋出為帶公開連結的網頁應用。
- **共享專案**（安裝版）—— 邀請同事或虛擬助理加入，將每條待辦事項分配給人或智能體。

> [!NOTE]
> 共享專案、雲同步和網頁應用釋出目前只在安裝版中提供，開源版暫不支援。需要這些功能，可以 **[下載 Orkas：macOS 與 Windows](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)**（免費，贈送 500 積分）。

原始碼版也支援語音輸入。在 **設定 → 模型** 中設定 **Orkas API Key**，然後點擊輸入框旁的麥克風。出現提示時允許存取麥克風。音訊會傳送到 Orkas 進行辨識，並消耗該 Key 擁有者的 Orkas 積分。再次點擊即可停止，檢查文字後由你自己傳送。如果先前拒絕了麥克風權限，請在系統設定中開啟。

---

## 一起執行 Claude Code、Codex、OpenCode、OpenClaw 和 Hermes-Agent

Orkas 將你已安裝的 CLI 智能體作為本地會話執行，與內建專業智能體一起工作：包括程式設計智能體 **Claude Code、Codex 和 OpenCode**，以及個人智能體 **OpenClaw 和 Hermes-Agent**。指揮官協調分工，並在它們之間保持同一份計劃，讓一個對話完成缺陷修復、變更審查和釋出說明撰寫。HyperFrames 等開源工具也可接入同一工作流。

[一起使用 Claude Code 和 Codex →](https://orkas.ai/blog/claude-code-codex-together/?source=gh-orkas)

---

## 為什麼選擇 Orkas

- **會規劃、分工，也會親自完成工作的指揮官** —— 拆解目標，選擇合適的智能體、技能、聯結器與工具；沒有更合適的專業智能體時，親自處理分析、寫作、研究和檔案工作。
- **本地優先** —— 對話、檔案、知識庫和自定義智能體預設儲存在本機，安裝版可選擇開啟雲同步。使用自己的 Key 時，模型呼叫從本機直連服務商；內建 Orkas 模型透過 Orkas 託管服務執行。
- **模型隨時可切換** —— 指揮官與內建智能體共用一個模型設定，可選擇內建 Orkas 模型、自有服務商或本地端點；外接 CLI 智能體保留各自的模型設定。
- **能積累經驗的智能體** —— 各自保留私有技能與記憶；後臺覆盤在應用空閒時檢查新活動，可改進自我評估、可複用方法與學習到的技能。
- **開源、可審查** —— MIT 許可證，可以檢視 Orkas、智能體與技能的具體實現。

> ⭐ 如果 Orkas 對你有用，點一顆 Star 能幫助更多人發現它。

---

## 下載

| | 安裝版（推薦） | 原始碼版 |
| --- | --- | --- |
| 平臺 | macOS 12+（Apple Silicon 與 Intel）、Windows 10+ | macOS、Windows、glibc 2.34+ Linux x64/arm64 |
| 賬號 | 登入即送 500 積分 | 無需賬號 |
| 模型 | 內建 Orkas 模型，或使用自己的 Key | 自己的 Key，或本地模型端點 |
| 另含 | 專案協作、應用釋出、雲端同步等 | — |
| 獲取方式 | **[下載 Orkas](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)** | [快速開始](#快速開始) |

下載連結會識別你的系統，並開始下載對應安裝包。

---

## 使用場景

- **營銷內容** —— 用你的品牌語氣製作釋出影片、產品頁面、帖子與簡報。[內容寫作](https://orkas.ai/use/content-writing/?source=gh-orkas) · [影片](https://orkas.ai/use/make-videos/?source=gh-orkas)
- **店鋪經營** —— 銷售週報、評價回覆、商品文案與競品檢查。[電商](https://orkas.ai/use/ecommerce/?source=gh-orkas)
- **研究與報告** —— 按需或定期交付帶來源的報告與幻燈片。[研究](https://orkas.ai/use/researchers/?source=gh-orkas) · [資料分析](https://orkas.ai/use/data-analysis/?source=gh-orkas)
- **和文件對話** —— 基於你自己的檔案回答問題，並標註來源段落，方便核對。[文件問答](https://orkas.ai/use/chat-with-documents/?source=gh-orkas)
- **客戶專案** —— 按你的模板製作會議簡報、客戶月報與進度幻燈片。[客戶月報模板](https://orkas.ai/blog/monthly-client-report-template/?source=gh-orkas)
- **產品釋出** —— 落地頁、帶測試的缺陷修復、更新日誌與釋出帖子。[面向開發者](https://orkas.ai/use/developers/?source=gh-orkas)
- **做應用** —— 報價計算器、預約表單、內部工具。[做應用](https://orkas.ai/use/build-apps/?source=gh-orkas)
- **小團隊協作** —— 人與智能體在同一個專案裡協作。[小團隊](https://orkas.ai/use/small-teams/?source=gh-orkas)

---

## Orkas 與同類工具對比

| 工具 | 它是什麼 | Orkas 的不同之處 |
| --- | --- | --- |
| **Claude Code** | Anthropic 的程式設計智能體，可在終端、IDE、桌面和網頁中使用，基於 Claude 模型。 | 兩者不是二選一：Orkas 把 Claude Code 作為團隊中的一個智能體來執行；在此之上，Orkas 提供不繫結模型的智能體團隊，處理程式碼之外的工作（研究、內容、影片等），並用專案、待辦事項和自動化讓工作持續推進。[Orkas 與 Claude Code 對比 →](https://orkas.ai/compare/orkas-vs-claude-code/?source=gh-orkas) |
| **Codex** | OpenAI 的程式設計智能體，可在終端、編輯器和雲端使用。 | 兩者不是二選一：Orkas 把 Codex 作為其中一個智能體來執行，與 Claude Code、OpenCode 並列。指揮官可以把編碼交給 Codex、把審查交給另一個智能體，再完成釋出中程式碼之外的部分（文件、釋出帖和影片）。[Orkas 與 Codex 對比 →](https://orkas.ai/compare/orkas-vs-codex/?source=gh-orkas) |
| **Claude Cowork** | Anthropic 面向日常工作的智能體，現已併入 Claude，可在桌面、網頁和手機上使用，需要付費 Claude 套餐。預設在 Anthropic 雲端執行，基於 Claude 模型。 | Claude Cowork 的開源（MIT）替代方案，可免費開始，贈送 500 積分。智能體在你的電腦上執行，資料預設儲存在本地，模型可以用內建 Orkas 模型、自己的服務商 Key 或本地端點。指揮官還能調動 Claude Code、Codex 等 CLI 智能體。代價是 Orkas 需要電腦保持喚醒，而 Cowork 的雲端任務可以不依賴你的電腦繼續執行。[Claude Cowork 替代方案 →](https://orkas.ai/compare/claude-cowork-alternatives/?source=gh-orkas) |
| **Manus** | 預設在 Manus 雲端規劃並執行任務的 AI 智能體。桌面應用 Manus Studio（macOS 和 Windows）也可以在你選擇的資料夾中工作，但任務仍在雲端規劃。 | Manus 的開源（MIT）替代方案。智能體在你的電腦上執行，資料預設儲存在本地，模型可以用內建 Orkas 模型、自己的服務商 Key 或本地端點，並用專案、待辦事項和自動化讓工作持續推進。代價是 Orkas 需要電腦保持喚醒，而 Manus 的雲端任務可以不依賴你的電腦繼續執行。[開源 Manus 替代方案 →](https://orkas.ai/open-source-manus-alternative/?source=gh-orkas) |
| **LangChain** | 面向開發者的 LLM 應用與智能體框架，透過程式碼嵌入 Python/JS 應用。 | Orkas 是透過對話指揮的桌面應用，資料預設儲存在本地。 |
| **CrewAI** | 透過 Python 程式碼定義團隊與角色、編排自治智能體的框架。 | Orkas 將多智能體編排做成桌面應用，內建專案、待辦事項、自動化與各智能體的經驗積累。 |
| **OpenClaw** | 提供訊息渠道整合、多智能體路由和子智能體能力的個人智能體平臺。 | Orkas 提供面向成品交付的桌面工作區，內建專業智能體，並協調 Claude Code、Codex、OpenCode 等 CLI 智能體；OpenClaw 也可作為其中一員接入。 |
| **Hermes-Agent** | Nous Research 的自我改進智能體，具備記憶與技能，提供 CLI、訊息閘道器和桌面版。 | Orkas 由指揮官協調多個專業智能體與外部 CLI 智能體，Hermes-Agent 也可作為其中一員接入。 |

**適合你，如果你希望**：讓智能體團隊協作，跨天持續推進工作，並將資料、Key 與智能體預設儲存在自己的硬碟上。

**不適合你，如果你只需要**：一個通用聊天機器人，或嵌入自己應用的純程式碼框架。

**選擇程式設計智能體？** [Codex vs OpenCode](https://orkas.ai/compare/codex-vs-opencode/?source=gh-orkas) · [Claude Code vs Codex vs OpenCode](https://orkas.ai/compare/claude-code-vs-codex-vs-opencode/?source=gh-orkas) · [Claude Code 替代方案](https://orkas.ai/compare/claude-code-alternatives/?source=gh-orkas)

**逐項對比 →** [vs Claude Code](https://orkas.ai/compare/orkas-vs-claude-code?source=gh-orkas) · [vs Codex](https://orkas.ai/compare/orkas-vs-codex?source=gh-orkas) · [vs Cline](https://orkas.ai/compare/orkas-vs-cline?source=gh-orkas) · [vs LangChain](https://orkas.ai/compare/orkas-vs-langchain?source=gh-orkas) · [vs ChatGPT](https://orkas.ai/compare/orkas-vs-chatgpt?source=gh-orkas) · [vs OpenClaw](https://orkas.ai/compare/orkas-vs-openclaw?source=gh-orkas) · [vs Hermes-Agent](https://orkas.ai/compare/orkas-vs-hermes-agent?source=gh-orkas)

---

## 快速開始

想直接用安裝包？見上方 [下載](#下載)。以下是從原始碼執行的方式 —— 也是目前在 Linux 上執行 Orkas 的方式：

**環境要求**：Node 22.12+ · macOS / Windows 10+ / 基於 glibc 2.34+ 的 Linux x64 或 arm64。建議保留 Python 3 與 C/C++ 構建工具鏈，用於少數原生模組需要原始碼編譯的兜底場景。

```bash
git clone https://github.com/Orkas-AI/Orkas.git
cd Orkas
./run.sh           # macOS / Linux
run.cmd            # Windows
```

Linux 原始碼執行需要 glibc 2.34+，不支援 Alpine 及其他基於 musl 的發行版。本地語音轉寫會在首次原始碼啟動時下載並校驗目標架構對應的 whisper.cpp 執行時及多語言模型。

`run.sh` / `run.cmd` 會在首次啟動時安裝 lockfile 固定的 npm 依賴，並準備固定版本的 Python、uv、Node、嵌入模型（約 95 MB）、OfficeCLI、FFmpeg、whisper.cpp 與多語言語音模型。Linux 啟動還會在 Electron ABI 下驗證平臺原生模組及 Whisper 執行時後再開啟應用。OCR 與 Skill 專屬 Python 包會在首次使用對應功能時安裝到隔離的本地環境。首次啟動會在 `~/.orkas/`（macOS / Linux）或 `<最小的非系統盤>:\.orkas\`（Windows）下建立工作區。隨後進入 **設定 → AI 服務商** 配置 API key 或 OAuth。

遇到原生依賴錯誤時，請使用 Node.js 24 LTS（最低 22.12.0），在此原始碼目錄執行
`npm run native:repair`。它會恢復可選依賴、修復 Electron 對應的 SQLite，並驗證 SQL、
sqlite-vec，並準備隨包 Node、在獨立程序中驗證 sharp 後才報告成功。只檢查、不安裝可執行 `npm run native:check`。
具體檢查內容見[原生依賴校驗指令碼](./scripts/verify-native-dependencies.cjs)。

---

## 工作原理

### 任務分工

指揮官親自處理通用工作，透過三種工具委派專業任務：

- **`dispatch_to`** 呼叫具名智能體，取得結果後繼續工作；既可等待結果，也可非同步執行，在任務結束後通知指揮官。
- **`hand_off_to`** 將剩餘工作交給具名智能體，並結束指揮官當前回合，由智能體直接回復；如果還有更大的任務待完成，也可設定後續步驟，讓指揮官之後恢復工作。
- **`run_worker`** 執行匿名、隔離的子任務，將結果私下回傳；它不接收對話歷史或具名智能體的技能。

具名智能體任務和匿名 worker 分別受併發控制。參見[派發實現](./src/main/features/group_chat/bus.ts)與[執行鎖](./src/main/util/locks.ts)。

### 上下文管理

執行時根據所選模型可用的輸入容量分配上下文，計入提示、工具和持續保留的執行狀態。已完成對話使用有界的近期歷史視窗；較長的當前任務透過檢查點壓縮早期過程訊息，保留近期工作。檔案讀取、檔案變更與命令執行也有結構化記錄，可在上下文壓縮後保留。

參見[上下文預算](./src/core-agent/src/agent/context-budget.ts)、[會話歷史與檢查點](./src/core-agent/src/agent/session.ts)和[工作區記錄](./src/core-agent/src/agent/workspace-state.ts)。

### 記憶與資料庫

持久記憶分別儲存使用者偏好、專案事實和各智能體可複用的知識；它們與資料庫的文件索引、已儲存的對話歷史是不同的資料來源。

資料庫將文件提取成段落，建立本地 SQLite 向量索引，嵌入模型在你的電腦上執行。智能體透過 `library` 工具列出檔案、搜尋相關段落和讀取來源內容，範圍包括全域性資料庫與當前專案資料庫；較早的對話則透過 `chat_history` 單獨檢索。

參見[分層記憶](./src/main/features/memory.ts)、[文件提取](./src/main/util/file_to_chunks.ts)、[資料庫工具](./src/main/model/core-agent/kb-tools.ts)和[對話檢索](./src/main/model/core-agent/chat-history-tools.ts)。

### 執行保護與恢復

會話鎖和併發限制控制同時執行的工作量。工具輪數預算、進度檢查點、重複呼叫檢查和分階段的空閒監測，共同約束停滯或重複執行的任務。具名智能體任務可以單獨跟蹤和取消；任務已接收或已排隊，不會被當作已經完成。

參見[角色預算](./src/main/features/group_chat/actor-budgets.ts)、[智能體執行時](./src/core-agent/src/agent/runner.ts)和[桌面模型適配層](./src/main/model/core-agent/client.ts)。

### 從工作中積累經驗

後臺覆盤在應用空閒時檢查智能體的新活動，並受冷卻間隔和執行限制控制。覆盤可更新智能體的自我評估（`COMPETENCE.md`）、可複用方法（`LEARNING_STRATEGIES.md`）或學習到的技能，也可以判斷沒有值得儲存的新內容。覆盤依據新活動安排，而非按完成任務的次數觸發。

參見[覆盤排程](./src/main/features/reflection-orchestrator.ts)與[覆盤提示](./src/core-agent/src/evolution/metacognition.ts)。

---

## 常見問題（FAQ）

**Orkas 是什麼？**
Orkas 是開源（MIT）、本地優先的多智能體桌面應用。指揮官將目標拆成待辦事項，協調 16 個內建專業智能體，以及 Claude Code、Codex、OpenCode、OpenClaw 和 Hermes-Agent，交付成品檔案。它不是單一聊天機器人，不是程式碼框架，也不是託管的 SaaS。

**需要 API Key 嗎？**
不需要。安裝版贈送 500 積分，可直接使用內建 Orkas 模型。用完後可購買積分、選擇付費會員，或新增自己的模型服務商 Key；自有服務商的費用單獨計算。

**Orkas 是本地大模型嗎？**
不是。Orkas 在你的電腦上執行，呼叫你選擇的內建 Orkas 模型、自有 API Key 或本地模型端點。它負責協調智能體與工具，本身不是模型。

**能基於我的文件回答問題，並標註出處嗎？**
可以。把 PDF 和文件加入本地資料庫，Orkas 可搜尋這些檔案，並在回答中引用來源段落，方便開啟原文核對。索引在本機建立。

**能使用 Ollama、LM Studio 等本地模型嗎？**
可以。開啟 **賬號設定 → 模型 → 對話 → 新增模型 → 自定義**，選擇 **OpenAI 相容** 或 **Anthropic 相容**，填寫基礎地址、準確的模型 ID 和 API Key，然後在任務的模型控制元件中選擇已儲存的模型。

**API Key 和資料存在哪裡？**
預設儲存在本機。你自己的服務商 Key 在本地加密儲存，並排除在雲同步之外。使用自己的 Key 時，模型呼叫從本機直連服務商；內建 Orkas 模型使用 Orkas 託管服務。安裝版的可選雲同步和共享專案會將所選資料儲存在 Orkas 伺服器上。[安全與資料處理 →](https://orkas.ai/security/?source=gh-orkas)

**Orkas 能完全離線使用嗎？**
原始碼版配合本地模型端點可以完全離線執行。安裝版需要登入，雲端模型呼叫需要聯網。

**電腦關機後還會繼續工作嗎？**
不會。Auto-advance 和定時自動化需要電腦保持喚醒，且 Orkas 正在執行。從 1.9 起，電腦喚醒或應用啟動後，每個自動化會補跑 12 小時內最近一次錯過的任務。

**能做應用和釋出應用嗎？**
可以。在 Orkas 內執行的本地應用免費。將網頁應用釋出為公開連結需要付費會員，Lite、Pro、Max 分別可釋出 5、8、15 個；公開網頁應用不包含 Orkas 桌面應用內的全部能力。

**需要 Orkas 賬號嗎？**
安裝版首次啟動時需要登入。本倉庫的原始碼版沒有賬號模組，啟動後直接進入應用。

**能驅動 Claude Code 等 CLI 智能體嗎？**
可以。Orkas 能將五個外部 CLI 智能體作為本地子程序執行：Claude Code、Codex、OpenCode、OpenClaw 和 Hermes-Agent；也可接入 HyperFrames 等開源工具，在同一個對話中協調工作。

**和 Claude Code、Codex、CrewAI、LangChain 有什麼不同？**
Claude Code 和 Codex 是程式設計智能體，Orkas 可以把它們都作為團隊成員來執行，不必二選一；CrewAI 和 LangChain 是程式碼優先的框架。Orkas 是開源桌面應用，由指揮官協調專業智能體與 CLI 智能體，可選擇不同模型服務商，資料與 Key 預設儲存在本地。[檢視完整對比](https://orkas.ai/compare/?source=gh-orkas)。

**支援哪些平臺？**
macOS 12+（Apple Silicon 與 Intel）和 Windows 10+ 提供安裝包。glibc 2.34+ Linux x64/arm64 目前透過原始碼執行，尚無安裝包；首次啟動會準備固定版本的 whisper.cpp 執行時，支援本地語音轉寫。不支援 Alpine 等基於 musl 的發行版。原始碼啟動需要 Node 22.12+；只有原生 npm 包缺少相容的預編譯檔案、需要本地重建時，才需要 Python 3 和 C/C++ 構建工具鏈。

**Orkas 免費且開源嗎？**
是的，應用採用 MIT 許可證，可免費使用。安裝版贈送 500 積分；付費會員每月 $11.99 起，增加月度積分、雲同步、更多共享專案和網頁應用釋出能力。使用自己的 Key 時，模型用量由服務商計費，Orkas 不加價。[價格 →](https://orkas.ai/pricing/?source=gh-orkas)

---

## 許可證

[MIT](./LICENSE)
