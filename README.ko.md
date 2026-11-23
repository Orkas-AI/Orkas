# Orkas

**데스크톱에서 일하는 오픈소스 AI 에이전트 팀. 목표를 완성된 결과물로 바꾸고, 일이 멈추지 않고 이어지게 합니다.**

Orkas는 오픈소스(MIT) 로컬 우선 멀티 에이전트 데스크톱 앱으로, 팀으로 일하는 AI 어시스턴트입니다. 필요한 일을 **지휘 에이전트**(Commander)에게 알려 주세요. 지휘 에이전트는 많은 작업을 스스로 끝내고, 더 큰 일은 단계를 계획한 뒤 전문 에이전트는 물론 이미 쓰고 있는 코딩 에이전트와 개인 에이전트(**Claude Code, Codex, OpenCode, OpenClaw, Hermes-Agent**)까지 불러 함께 작업하게 합니다.

Orkas는 프롬프트 하나에 답하는 데서 그치지 않고 프로젝트를 계속 진행시키도록 만들어졌습니다. **프로젝트**에는 목표, 규칙, 메모리, 파일이 담겨 있어, 새 대화를 시작해도 지난 대화가 끝난 지점부터 이어집니다. **할 일**은 사람과 에이전트가 일을 나누어 맡게 하고, **자동 진행**은 팀이 다음 할 일을 스스로 이어받게 하며, **예약 자동화**는 반복 업무를 매시간, 매일, 매주 또는 매월 실행합니다. 모든 데이터는 내 컴퓨터에 남고, 완성된 결과물은 검토할 수 있도록 다시 돌아옵니다. 그래서 비즈니스에서 꾸준히 이어지는 업무도 Orkas에 믿고 맡길 수 있습니다.

**[⬇ macOS 및 Windows용 Orkas 다운로드](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)** — 무료이며 내장 Orkas 모델용 500 크레딧이 제공되므로 API 키 없이 시작할 수 있습니다. 자신의 키를 쓰고 싶다면 Claude · OpenAI · Gemini · DeepSeek · Kimi · GLM · Qwen · MiniMax · Doubao 또는 로컬 OpenAI 호환 엔드포인트를 사용할 수 있습니다.

[![Download for macOS & Windows](https://img.shields.io/badge/Download-macOS%20%26%20Windows-5b57d6?style=for-the-badge)](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/Orkas-AI/Orkas?style=flat&logo=github&label=Stars&color=yellow)](https://github.com/Orkas-AI/Orkas/stargazers)
[![Release](https://img.shields.io/github/v/release/Orkas-AI/Orkas?color=blue)](https://github.com/Orkas-AI/Orkas/releases)
[![X: @leochenpm](https://img.shields.io/badge/X-%40leochenpm-black?logo=x)](https://x.com/leochenpm)
[![Website: orkas.ai](https://img.shields.io/badge/Website-orkas.ai-5b57d6)](https://orkas.ai/?source=gh-orkas)

[English](./README.en.md) · [简体中文](./README.zh-CN.md) · [日本語](./README.ja.md) · [한국어](./README.ko.md) · [Español](./README.es.md) · [Bahasa Indonesia](./README.id.md) · [Español (Latinoamérica)](./README.es-419.md) · [Русский](./README.ru.md) · [Português (Brasil)](./README.pt-BR.md) · [Türkçe](./README.tr.md) · [繁體中文](./README.zh-TW.md) · [Tiếng Việt](./README.vi.md) · [Deutsch](./README.de.md) · [ไทย](./README.th.md) · [Français](./README.fr.md) · [Italiano](./README.it.md) · [Português (Portugal)](./README.pt-PT.md) · [العربية](./README.ar.md)

---

https://github.com/user-attachments/assets/4f8b16c8-a192-45a4-b19f-80e8d02c3dab

![Orkas 데스크톱 — 작업 대화와 결과물](./resources/app-ui/task-en.png)

---

## 팀이 만들어 내는 결과물

- **동영상, 내레이션 음성, 이미지** — [VideoStudio](https://github.com/Orkas-AI/Orkas-VideoStudio), VoiceStudio, ImageStudio
- **리서치 보고서, SEO 진단 결과, 시장 분석** — DeepResearcher, SeoGeoAgent, StockAnalyser
- **게시물, 아티클, 뉴스레터, 프레젠테이션 자료** — ContentWriter, PptMaker
- **웹사이트, UI, 코드** — UIDesigner, ProductDeveloper
- **Word, Excel, PowerPoint, PDF 파일** — OfficeWorker
- **이커머스 업무** — 이커머스 에이전트 5개가 맡는 상품 리서치, 상품 등록, 리뷰 분석, 매출 분석, 카탈로그 변경
- **여러 에이전트가 필요한 복잡한 일** — 지휘 에이전트가 일을 나누어 각 부분을 알맞은 에이전트에게 맡기고 결과를 하나로 모읍니다. 예를 들어 시장 조사를 바탕으로 보고서, 프레젠테이션 자료, 출시 영상까지 만들어 낼 수 있습니다.

앱에는 16개의 전문 에이전트가 기본 탑재되어 있으며, 각 에이전트는 고유한 스킬, 메모리, 도구를 갖추고 있습니다. [에이전트 마켓플레이스](https://orkas.ai/views/marketplace/gs/agents/?source=gh-orkas)에서 30개 이상의 에이전트를 둘러보거나, 필요한 역할을 설명하면 지휘 에이전트가 맞춤 에이전트를 만들어 줍니다.

<details>
<summary><b>기본 제공 에이전트 16개 전체</b></summary>

| 분야 | 에이전트 | 결과물 |
| --- | --- | --- |
| 리서치 및 분석 | **DeepResearcher** | 검증된 출처, 모순점 표시, 감사 가능한 보고서를 갖춘 근거 기반 리서치 |
| | **SeoGeoAgent** | URL만 주면 기술 진단, 콘텐츠 품질, Core Web Vitals, AI 답변(GEO) 인용 가능성, 우선순위가 매겨진 수정 목록까지 |
| | **StockAnalyser** | 추적 가능한 대시보드와 함께 제공하는 주식 리서치, 팩터 스크리닝, 백테스트, 포트폴리오 리스크 점검 |
| 콘텐츠 및 미디어 | **ContentWriter** | 목표, 자료 또는 초안을 바탕으로 바로 게시할 수 있는 게시물, 아티클, 뉴스레터, 사례 연구 |
| | **PptMaker** | 주제, 개요 또는 문서를 바탕으로 편집하고 검토할 수 있는 PPTX 프레젠테이션 |
| | **ImageStudio** | 포스터, 커버 이미지, 소셜 미디어 이미지, 인포그래픽 |
| | **[VideoStudio](https://github.com/Orkas-AI/Orkas-VideoStudio)** | 내레이션, AI 프레젠터, 자막과 더빙, 하이라이트 클립, 현지화, 그리고 내 콘텐츠와 영상 소스를 활용한 레퍼런스 영상 재현 |
| | **VoiceStudio** | 내레이션, 다중 화자 오디오, 녹취록과 자막, 오디오 편집과 믹싱 |
| | **UIDesigner** | 제품 목표, PRD, 스크린샷 또는 Figma 자료를 바탕으로 만드는 편집 가능한 HTML 중심 UI |
| 개발 및 오피스 | **ProductDeveloper** | 저장소를 이해하는 엔지니어링 — PRD 구현, 버그 수정, 리팩터링, 리뷰를 검증 가능한 결과로 제공 |
| | **OfficeWorker** | Word / Excel / PowerPoint / PDF 파일을 하나씩 또는 일괄로 생성, 편집, 점검, 전달 |
| 이커머스 | **ECommerceResearcher** | 예산, 시장, 소싱 제약에 맞춘 상품 선정 — 후보, 탈락 사유, 검증 계획 |
| | **ECommerceWriter** | 브랜드 톤에 맞춘 상품명, 상세 페이지, FAQ, 이미지 문구, 영상 대본 |
| | **ECommerceReviewer** | 리뷰 및 평판 분석 — 고객 의견의 주요 주제, 부정적 리뷰의 근본 원인, 우선순위 |
| | **ECommerceAnalyzer** | 내보낸 데이터로 보는 매출, 이익, 광고, 환불, 재고 — 정합성을 맞춘 지표와 의사결정 |
| | **ECommerceOperator** | 카탈로그, 가격, 프로모션, 재고 변경을 계획하고, 연결한 도구를 통해서만 실행 |

에이전트별 자세한 정보 → [orkas.ai/agents](https://orkas.ai/agents/?source=gh-orkas)

</details>

### 내 콘텐츠로 레퍼런스 영상 재현하기

**VideoStudio**는 바이럴 영상의 서사 구조, 시각 스타일, 편집 템포를 내 제품, 대본, 영상 소스로 재현할 수 있습니다. 레퍼런스 영상 파일과 소재를 제공하면 에이전트가 훅, 정보 순서, 시각적 전개, 행동 유도(CTA)를 분석하고, 제작에 들어가기 전에 무엇을 유지하고 무엇을 바꿀지 제안합니다.

이 기능은 모션 그래픽 설명 영상, SaaS나 앱 데모, 기존 영상 소스로 만드는 제품 광고에 가장 잘 맞습니다. 로컬에서 작성한 텍스트, 자막, 내레이션, 클립은 각각 따로 수정할 수 있지만, AI가 생성한 영상에 새겨진 텍스트를 바꾸려면 그 영상 자체를 바꿔야 합니다.

> "reference.mp4를 참고해서 30초짜리 세로형 홍보 영상을 만들어 줘. 훅, 타이포그래피, 템포는 그대로 살리고, 내용은 내 제품과 화면 녹화 영상으로 바꿔 줘. 먼저 분석 결과와 계획부터 보여 줘."

에이전트가 읽을 수 있는 동영상 파일로 시작하세요. 소셜 플랫폼 공유 링크로 영상을 내려받는 기능은 내장되어 있지 않습니다. 정확한 카메라 움직임, 사람의 연기, 프레임 단위 일치는 보장되지 않습니다. [레퍼런스 재현 워크플로](./resources/builtin/marketplace/agents/79df9cc89f5f/skills/video-craft/references/reference-recreation.md)를 참고하세요.

---

## 일이 멈추지 않게

작업 하나도 좋은 출발점입니다. Orkas는 그 뒤로도 계속 이어지는 일을 위해 만들어졌습니다.

- **프로젝트** — 프로젝트 안의 모든 대화가 목표와 규칙, 메모리, 파일에서 출발하므로 매번 상황을 새로 설명할 필요가 없습니다.
- **할 일과 자동 진행** — 모든 프로젝트에는 사람과 에이전트를 위한 할 일 목록이 있습니다. 자동 진행을 켜면 팀이 다음 항목을 스스로 맡아 처리하고, 완성된 결과물을 검토할 수 있게 다시 가져옵니다.
- **예약 자동화** — 어떤 작업이든 매시간, 매일, 매주 또는 매월 실행할 수 있습니다. Orkas는 내 컴퓨터에서 실행됩니다. v1.9부터는 컴퓨터가 절전 상태에서 깨어나거나 Orkas가 시작될 때, 각 자동화가 12시간 이내에 놓친 가장 최근 실행을 한 번 보충 실행합니다.
- **커넥터** — Gmail, Google Calendar, Sheets 및 Drive, Notion, Slack, Shopify, Stripe 등 다양한 서비스를 연결할 수 있습니다. 기본적으로 Orkas는 무언가를 보내거나 게시하거나 삭제하기 전에 확인을 요청합니다.
- **앱** — 필요한 도구를 설명하면 Orkas가 데스크톱 앱 안에서 실행되는 로컬 앱으로 만들어 줍니다. 패키지 버전에서는 유료 플랜을 사용하면 공개 링크가 있는 웹 앱으로 게시할 수도 있습니다.
- **공유 프로젝트** *(패키지 버전)* — 팀원이나 가상 비서(VA)를 초대하고, 각 할 일을 사람이나 에이전트에게 맡길 수 있습니다.

> [!NOTE]
> 공유 프로젝트, 클라우드 동기화, 웹 앱 게시는 패키지 버전에서만 제공되며, 오픈소스 빌드는 아직 지원하지 않습니다. 이 기능을 사용하려면 패키지 버전을 받으세요: **[macOS 및 Windows용 Orkas 다운로드](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)** (무료, 시작 시 500 크레딧 제공).

---

## Claude Code, Codex, OpenCode, OpenClaw, Hermes-Agent를 하나의 팀으로 묶어 함께 실행하기

Orkas는 이미 설치해 둔 CLI 에이전트를 자체 전문 에이전트와 나란히 로컬 세션으로 실행합니다. 코딩 에이전트인 **Claude Code, Codex, OpenCode**와 개인 에이전트인 **OpenClaw와 Hermes-Agent**가 여기에 해당합니다. 지휘 에이전트는 각 에이전트에게 가장 잘하는 부분을 맡기고 모두를 아우르는 하나의 계획을 유지하므로, 채팅 하나로 버그를 고치고 변경 사항을 리뷰하고 릴리스 노트 초안까지 작성할 수 있습니다. HyperFrames 같은 오픈소스 도구도 같은 방식으로 연결됩니다.

[Claude Code와 Codex 함께 사용하기 →](https://orkas.ai/blog/claude-code-codex-together/?source=gh-orkas)

---

## 왜 Orkas인가

- **계획하고, 위임하고, 나머지는 직접 해내는 지휘 에이전트** — 목표를 나누고 알맞은 에이전트, 스킬, 커넥터, 도구를 고르며, 더 적합한 전문 에이전트가 없을 때는 분석, 글쓰기, 리서치, 파일 작업을 직접 처리합니다.
- **로컬 우선 설계** — 대화, 파일, 지식 베이스, 맞춤 에이전트는 기본적으로 내 디스크에 저장됩니다. 패키지 버전에서 클라우드 동기화는 선택 사항입니다. 자신의 키를 사용하면 모델 호출이 내 컴퓨터에서 제공업체로 바로 전달되며, 내장 Orkas 모델은 Orkas의 관리형 모델 서비스를 통해 실행됩니다.
- **어떤 모델이든 언제든 전환** — 지휘 에이전트와 기본 제공 에이전트는 하나의 모델 설정을 공유합니다. 내장 Orkas 모델, 자신의 제공업체, 로컬 엔드포인트 중에서 고를 수 있습니다. 외부 CLI 에이전트는 각자의 모델 설정을 그대로 유지합니다.
- **점점 나아지는 에이전트** — 각 에이전트는 자기만의 스킬과 메모리를 따로 가집니다. 앱이 유휴 상태일 때 백그라운드 리뷰가 새로운 활동을 살펴보고, 자기 평가, 재사용 가능한 방법, 학습한 스킬을 다듬을 수 있습니다.
- **오픈소스, 블랙박스 없음** — MIT 라이선스입니다. Orkas와 모든 에이전트, 스킬이 정확히 무엇을 하는지 직접 읽어 볼 수 있습니다.

> ⭐ Orkas가 유용했다면 스타를 눌러 주세요. 더 많은 사람이 이 프로젝트를 발견하는 데 도움이 됩니다.

---

## 다운로드

| | 패키지 버전 앱(권장) | 소스에서 실행 |
| --- | --- | --- |
| 지원 플랫폼 | macOS 12 이상(Apple Silicon 및 Intel 프로세서), Windows 10 이상 | macOS, Windows, glibc 2.34 이상 기반의 Linux x64 또는 arm64 |
| 계정 | 로그인 — 무료 500 크레딧 | 필요 없음 |
| 모델 | 내장 Orkas 모델 또는 자신의 키 | 자신의 키 또는 로컬 엔드포인트 |
| 추가 기능 | 프로젝트 협업, 앱 게시, 클라우드 동기화 등 | — |
| 받기 | **[Orkas 다운로드](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)** | [빠른 시작](#빠른-시작) |

다운로드 링크는 사용 중인 시스템을 감지해 알맞은 설치 프로그램을 내려받기 시작합니다.

---

## 주요 활용 사례

- **마케팅 콘텐츠** — 브랜드 톤에 맞춘 출시 영상, 제품 페이지, 게시물, 뉴스레터. [콘텐츠 작성](https://orkas.ai/use/content-writing/?source=gh-orkas) · [동영상](https://orkas.ai/use/make-videos/?source=gh-orkas)
- **스토어 운영** — 주간 매출 브리핑, 리뷰 답변, 상품 등록, 경쟁사 점검. [이커머스](https://orkas.ai/use/ecommerce/?source=gh-orkas)
- **리서치와 보고서** — 출처가 달린 보고서와 프레젠테이션 자료를 필요할 때마다 또는 매주. [리서치](https://orkas.ai/use/researchers/?source=gh-orkas) · [데이터 분석](https://orkas.ai/use/data-analysis/?source=gh-orkas)
- **문서와 대화하기** — 내 파일을 근거로 한 답변과 원문 구절로 이어지는 인용. [문서와 대화하기](https://orkas.ai/use/chat-with-documents/?source=gh-orkas)
- **클라이언트 업무** — 회의 브리핑 자료, 월간 클라이언트 보고서, 업데이트 프레젠테이션 자료를 내 템플릿으로. [월간 클라이언트 보고서 템플릿](https://orkas.ai/blog/monthly-client-report-template/?source=gh-orkas)
- **제품 출시** — 랜딩 페이지, 테스트를 포함한 버그 수정, 변경 로그, 출시 게시물. [개발자](https://orkas.ai/use/developers/?source=gh-orkas)
- **앱 만들기** — 견적 계산기, 예약 양식, 사내 도구. [앱 만들기](https://orkas.ai/use/build-apps/?source=gh-orkas)
- **소규모 팀** — 사람과 에이전트가 함께하는 하나의 프로젝트. [소규모 팀](https://orkas.ai/use/small-teams/?source=gh-orkas)

---

## Orkas와 다른 도구 비교

| 도구 | 개요 | Orkas의 차이점 |
| --- | --- | --- |
| **Claude Code** | Anthropic의 에이전트형 코딩 도구로, 터미널, IDE, 데스크톱, 웹에서 사용할 수 있으며 Claude 모델을 기반으로 합니다. | 양자택일이 아닙니다. Orkas는 Claude Code를 자신의 에이전트 중 하나로 실행합니다. 여기에 Orkas는 특정 모델에 얽매이지 않는 팀을 더해 리서치, 콘텐츠, 영상 등 코드 밖의 일까지 맡기고, 프로젝트, 할 일, 자동화로 일이 계속 진행되게 합니다. [Orkas vs Claude Code →](https://orkas.ai/compare/orkas-vs-claude-code/?source=gh-orkas) |
| **Codex** | OpenAI의 코딩 에이전트로, 터미널, 에디터, 클라우드에서 사용할 수 있습니다. | 양자택일이 아닙니다. Orkas는 Codex를 Claude Code, OpenCode와 나란히 자신의 에이전트 중 하나로 실행합니다. 지휘 에이전트는 코딩은 Codex에게, 리뷰는 다른 에이전트에게 맡긴 뒤, 문서, 출시 게시물, 영상처럼 릴리스에서 코드가 아닌 나머지 절반까지 처리할 수 있습니다. [Orkas vs Codex →](https://orkas.ai/compare/orkas-vs-codex/?source=gh-orkas) |
| **Claude Cowork** | 일상 업무를 위한 Anthropic의 에이전트로, 현재는 Claude의 일부입니다. 유료 Claude 플랜으로 데스크톱, 웹, 모바일에서 사용할 수 있으며, 기본적으로 Anthropic의 클라우드에서 실행되고 Claude 모델을 사용합니다. | 500 크레딧과 함께 무료로 시작할 수 있는 Claude Cowork의 오픈소스(MIT) 대안입니다. Orkas는 에이전트를 내 컴퓨터에서 실행하고 데이터를 기본적으로 로컬에 보관하며, 내장 Orkas 모델, 자신의 제공업체 키, 로컬 엔드포인트 중 하나를 사용합니다. 지휘 에이전트는 Claude Code, Codex 등 다른 CLI 에이전트도 불러올 수 있습니다. 다만 Orkas는 컴퓨터가 켜져 있어야 하는 반면, Cowork의 클라우드 작업은 컴퓨터 없이도 계속 실행될 수 있습니다. [Claude Cowork 대안 →](https://orkas.ai/compare/claude-cowork-alternatives/?source=gh-orkas) |
| **Manus** | 기본적으로 Manus의 클라우드에서 작업을 계획하고 실행하는 AI 에이전트입니다. Manus Studio 데스크톱 앱(macOS 및 Windows)은 사용자가 고른 폴더에서도 작업할 수 있지만, 작업 계획은 여전히 클라우드에서 이루어집니다. | Manus의 오픈소스(MIT) 대안입니다. Orkas는 에이전트를 내 컴퓨터에서 실행하고 데이터를 기본적으로 로컬에 보관하며, 내장 Orkas 모델, 자신의 제공업체 키, 로컬 엔드포인트 중 하나를 사용합니다. 프로젝트, 할 일, 자동화가 일을 계속 진행시킵니다. 다만 Orkas는 컴퓨터가 켜져 있어야 하는 반면, Manus의 클라우드 작업은 컴퓨터 없이도 계속 실행될 수 있습니다. [오픈소스 Manus 대안 →](https://orkas.ai/open-source-manus-alternative/?source=gh-orkas) |
| **LangChain** | LLM 앱과 에이전트를 만들기 위한 개발자용 프레임워크/라이브러리로, 코드 중심이며 자신의 Python/JS 앱에 내장해 사용합니다. | Orkas는 오케스트레이션 코드를 작성하는 대신 채팅으로 지시하는 데스크톱 앱입니다. 데이터는 기본적으로 로컬에 머뭅니다. |
| **CrewAI** | 역할 기반 자율 에이전트를 오케스트레이션하기 위한 Python 프레임워크로, 크루와 에이전트를 코드로 정의합니다. | Orkas는 멀티 에이전트 오케스트레이션을 데스크톱 앱에 담았으며, 프로젝트, 할 일, 자동화, 에이전트별 자기 개선 기능을 기본으로 갖추고 있습니다. |
| **OpenClaw** | 메시징 연동, 멀티 에이전트 라우팅, 하위 에이전트를 갖춘 개인 에이전트 플랫폼입니다. | Orkas는 완성된 결과물을 위한 데스크톱 작업 공간을 제공하며, 기본 제공 전문 에이전트와 함께 Claude Code, Codex, OpenCode 및 다른 CLI 에이전트를 조율합니다. OpenClaw도 CLI 에이전트로서 이 워크플로에 참여할 수 있습니다. |
| **Hermes-Agent** | Nous Research의 자기 개선형 에이전트로, 메모리와 스킬을 갖춘 단일 에이전트이며 CLI, 메시징 게이트웨이, 데스크톱 앱으로 제공됩니다. | Orkas는 팀을 조율합니다. 지휘 에이전트가 여러 전문 에이전트와 다른 CLI 에이전트를 지휘하며, Hermes-Agent도 그중 하나로 연결됩니다. |

**Orkas가 맞는 분**: 어시스턴트 한 명보다 에이전트 팀을 원하고, 며칠에 걸쳐 계속 이어지는 일을 맡기고 싶고, 데이터와 키, 에이전트를 자신의 디스크에 두고 싶은 분입니다.

**맞지 않는 분**: 다용도 챗봇 하나면 충분하거나, 자신의 앱에 넣을 순수 코드 라이브러리를 찾는 분입니다.

**코딩 에이전트를 고르고 계신가요?** [Codex와 OpenCode 비교](https://orkas.ai/compare/codex-vs-opencode/?source=gh-orkas) · [Claude Code, Codex, OpenCode 비교](https://orkas.ai/compare/claude-code-vs-codex-vs-opencode/?source=gh-orkas) · [Claude Code 대안](https://orkas.ai/compare/claude-code-alternatives/?source=gh-orkas)

**전체 상세 비교 →** [Claude Code와 비교](https://orkas.ai/compare/orkas-vs-claude-code?source=gh-orkas) · [Codex와 비교](https://orkas.ai/compare/orkas-vs-codex?source=gh-orkas) · [Cline과 비교](https://orkas.ai/compare/orkas-vs-cline?source=gh-orkas) · [LangChain과 비교](https://orkas.ai/compare/orkas-vs-langchain?source=gh-orkas) · [ChatGPT와 비교](https://orkas.ai/compare/orkas-vs-chatgpt?source=gh-orkas) · [OpenClaw와 비교](https://orkas.ai/compare/orkas-vs-openclaw?source=gh-orkas) · [Hermes-Agent와 비교](https://orkas.ai/compare/orkas-vs-hermes-agent?source=gh-orkas)

---

## 빠른 시작

패키지 설치 프로그램을 원하시나요? 위의 [다운로드](#다운로드) 섹션을 참고하세요. 소스에서 실행하는 방법은 다음과 같으며, 현재 Linux에서 Orkas를 실행하려면 이 방법을 사용해야 합니다.

**요구 사항**: Node 22.12+ · macOS / Windows 10+ / glibc 2.34+ Linux x64 또는 arm64. 드물게 네이티브 모듈을 소스에서 빌드하는 대체 경로가 필요할 수 있으므로 Python 3 및 C/C++ 빌드 도구 체인을 사용할 수 있게 해 두세요.

```bash
git clone https://github.com/Orkas-AI/Orkas.git
cd Orkas
./run.sh           # macOS / Linux
run.cmd            # Windows
```

Linux에서 소스로 실행하려면 glibc 2.34+가 필요합니다. Alpine을 비롯한 musl 기반 배포판은 지원하지 않습니다. 로컬 음성 전사 기능을 위해, 소스로 처음 실행할 때 대상 플랫폼용 네이티브 whisper.cpp 런타임과 다국어 모델을 내려받아 검증합니다.

`run.sh` / `run.cmd`는 잠금 파일에 고정된 npm 의존성 트리를 설치하고, 처음 실행할 때 버전이 고정된 Python, uv, Node, 임베딩 모델(~95 MB), OfficeCLI, FFmpeg, whisper.cpp, 다국어 음성 모델 리소스를 준비합니다. 이어서 Linux에서는 앱을 열기 전에 플랫폼 네이티브 모듈과 Whisper 런타임이 Electron의 ABI에서 동작하는지 검증합니다. OCR과 스킬별 Python 패키지는 해당 기능을 처음 사용할 때 격리된 로컬 환경에 설치됩니다. 처음 실행하면 `~/.orkas/`(macOS / Linux) 또는 `<smallest non-system drive>:\.orkas\`(Windows) 아래에 작업 공간이 만들어집니다. 그런 다음 **설정 → AI 제공업체**를 열어 API 키나 OAuth를 추가하세요.

네이티브 의존성 오류가 발생하면 Node.js 24 LTS(최소 22.12.0)를 사용한 다음,
이 체크아웃에서 `npm run native:repair`를 실행하세요. 이 명령은 선택적 패키지를 복원하고,
Electron용 SQLite를 복구하고, 격리된 이미지 처리를 위해 번들된 Node를 준비하며,
SQL, sqlite-vec, sharp를 점검한 뒤에 성공으로 마칩니다.
설치하지 않고 점검만 하려면 `npm run native:check`를 사용하세요.
수행되는 점검 항목은 [네이티브 의존성 검증 스크립트](./scripts/verify-native-dependencies.cjs)에서 확인할 수 있습니다.

---

## 작동 방식

### 작업 라우팅

지휘 에이전트는 일반적인 일은 직접 처리하고, 전문적인 일은 다음 세 가지 도구로 위임합니다.

- **`dispatch_to`** 도구는 이름이 지정된 에이전트를 실행하고, 작업을 이어 갈 수 있도록 그 결과를 돌려줍니다. 결과를 기다릴 수도 있고, 비동기로 실행한 뒤 작업이 끝나면 지휘 에이전트에게 알리게 할 수도 있습니다.
- **`hand_off_to`** 도구는 남은 작업을 이름이 지정된 에이전트에게 넘기고 지휘 에이전트의 현재 턴을 끝냅니다. 넘겨받은 에이전트가 직접 답변을 전달하며, 선택적으로 후속 처리를 지정하면 지휘 에이전트가 나중에 더 큰 작업을 다시 이어 갈 수 있습니다.
- **`run_worker`** 도구는 익명의 격리된 하위 작업을 실행하고 비공개 결과를 반환합니다. 이 하위 작업에는 대화 기록이나 이름이 지정된 에이전트의 스킬이 전달되지 않습니다.

이름이 지정된 에이전트 작업과 익명 워커에는 각각 별도의 동시 실행 제어가 적용됩니다. [디스패치 구현](./src/main/features/group_chat/bus.ts)과 [실행 잠금](./src/main/util/locks.ts)을 참고하세요.

### 컨텍스트 관리

런타임은 프롬프트, 도구, 지속되는 런타임 상태를 고려해, 선택한 모델이 실제로 쓸 수 있는 입력 용량에 맞춰 컨텍스트 예산을 배분합니다. 완료된 대화에는 길이가 제한된 최근 기록 창을 사용하고, 오래 이어지는 활성 작업은 체크포인트를 사용해 최근 작업은 유지하면서 이전 과정 메시지를 압축합니다. 파일 읽기, 파일 변경, 명령 실행에도 구조화된 기록이 남아 컨텍스트 압축 후에도 유지될 수 있습니다.

[컨텍스트 예산](./src/core-agent/src/agent/context-budget.ts), [세션 기록과 체크포인트](./src/core-agent/src/agent/session.ts), [작업 공간 기록](./src/core-agent/src/agent/workspace-state.ts)을 참고하세요.

### 메모리와 라이브러리

영구 노트는 사용자 선호, 프로젝트 정보, 각 에이전트의 재사용 가능한 지식을 각각 별도의 범위에 보관합니다. 이 노트는 라이브러리의 문서 색인이나 저장된 대화 기록과는 별개입니다.

라이브러리는 문서에서 구절을 추출해 로컬 SQLite 벡터 색인에 저장합니다. 임베딩 모델은 내 컴퓨터에서 실행되며, `library` 도구는 전역 라이브러리나 현재 프로젝트 라이브러리에서 파일 목록을 보고, 관련 구절을 검색하고, 원본 내용을 읽을 수 있습니다. 이전 대화는 `chat_history`를 통해 따로 검색합니다.

[범위별 메모리](./src/main/features/memory.ts), [문서 추출](./src/main/util/file_to_chunks.ts), [라이브러리 도구](./src/main/model/core-agent/kb-tools.ts), [대화 검색](./src/main/model/core-agent/chat-history-tools.ts)을 참고하세요.

### 실행 제한과 복구

세션 잠금과 동시 실행 한도가 병렬 작업의 범위를 제한합니다. 도구 라운드 예산, 진행 체크포인트, 반복 호출 검사, 단계를 인식하는 유휴 감시 장치는 멈추거나 같은 작업을 되풀이하는 실행을 억제하는 데 도움이 됩니다. 이름이 지정된 에이전트 작업은 개별적으로 추적하고 취소할 수 있으며, 접수되었거나 대기열에 있는 작업은 완료된 결과로 취급되지 않습니다.

[액터 예산](./src/main/features/group_chat/actor-budgets.ts), [에이전트 런타임](./src/core-agent/src/agent/runner.ts), [데스크톱 모델 어댑터](./src/main/model/core-agent/client.ts)를 참고하세요.

### 활동에서 배우기

백그라운드 리뷰는 쿨다운과 실행 제한을 지키는 범위에서, 앱이 유휴 상태일 때 새로운 에이전트 활동을 살펴봅니다. 리뷰는 에이전트의 자기 평가(`COMPETENCE.md`), 재사용 가능한 방법(`LEARNING_STRATEGIES.md`), 학습한 스킬을 업데이트할 수 있습니다. 리뷰는 작업 횟수가 아니라 새로운 활동이 있을 때 이루어지며, 저장할 만한 것이 없다고 결론 내릴 수도 있습니다.

[회고 스케줄러](./src/main/features/reflection-orchestrator.ts)와 [리뷰 프롬프트](./src/core-agent/src/evolution/metacognition.ts)를 참고하세요.

---

## 자주 묻는 질문

**Orkas란 무엇인가요?**
Orkas는 오픈소스(MIT) 로컬 우선 멀티 에이전트 데스크톱 앱입니다. 지휘 에이전트가 목표를 할 일로 바꾸고, 16개의 기본 제공 전문 에이전트에 더해 Claude Code, Codex, OpenCode, OpenClaw, Hermes-Agent까지 조율해 완성된 파일을 전달합니다.

**API 키가 필요한가요?**
아니요. 패키지 버전에는 내장 Orkas 모델용 500 크레딧이 포함되어 있습니다. 크레딧을 다 쓴 뒤에는 크레딧을 구매하거나, 유료 플랜을 선택하거나, 자신의 제공업체 키를 추가하면 됩니다. 제공업체 요금은 별도로 청구됩니다.

**Orkas는 로컬 LLM인가요?**
아니요. Orkas는 내 컴퓨터에서 실행되며, 사용자가 선택한 모델(내장 Orkas 모델, 자신의 API 키, 로컬 모델 엔드포인트)을 호출합니다. 에이전트와 도구를 오케스트레이션할 뿐, 그 자체가 모델은 아닙니다.

**Orkas가 내 문서를 바탕으로 인용과 함께 질문에 답할 수 있나요?**
네. PDF와 문서를 로컬 라이브러리에 추가하면 Orkas가 이를 검색하고 원문 구절을 인용해 답변하므로, 원본을 열어 직접 확인할 수 있습니다. 색인은 내 컴퓨터에서 만들어집니다.

**Ollama나 LM Studio 같은 로컬 모델을 사용할 수 있나요?**
네. **계정 설정 → 모델 → 채팅 → 모델 추가 → 사용자 지정**을 열고 **OpenAI 호환** 또는 **Anthropic 호환**을 선택한 다음, 기본 URL, 정확한 모델 ID, API 키를 입력하세요. 저장한 모델은 작업의 모델 선택 메뉴에서 고르면 됩니다.

**API 키와 데이터는 어디에 저장되나요?**
기본적으로 내 디스크에 저장됩니다. 자신의 제공업체 키는 로컬에서 암호화되며 클라우드 동기화 대상에서 제외됩니다. 자신의 키를 사용하면 모델 호출이 내 컴퓨터에서 제공업체로 바로 전달되며, 내장 Orkas 모델은 Orkas의 관리형 서비스를 사용합니다. 패키지 버전에서 선택적으로 쓰는 클라우드 동기화와 공유 프로젝트는 선택한 데이터를 Orkas 서버에 저장합니다. [보안 및 데이터 처리 →](https://orkas.ai/security/?source=gh-orkas)

**Orkas는 오프라인에서도 작동하나요?**
소스 빌드는 로컬 모델 엔드포인트를 사용하면 완전히 오프라인으로 실행할 수 있습니다. 패키지 버전은 로그인이 필요하며, 클라우드 모델을 쓰려면 네트워크 연결이 필요합니다.

**컴퓨터가 꺼져 있어도 계속 작동하나요?**
아니요. Orkas는 내 컴퓨터에서 실행되므로, 자동 진행과 자동화가 동작하려면 컴퓨터가 켜져 있고 Orkas가 실행 중이어야 합니다. v1.9부터는 컴퓨터가 절전 상태에서 깨어나거나 Orkas가 시작될 때, 각 자동화가 12시간 이내에 놓친 가장 최근 실행을 한 번 보충 실행합니다.

**앱을 만들고 게시할 수 있나요?**
네. Orkas 안에서 실행되는 로컬 앱은 무료입니다. 웹 앱을 공개 링크로 게시하려면 유료 플랜이 필요하며(Lite 5개, Pro 8개, Max 15개 앱), 게시된 웹 앱에는 Orkas 안에서 쓸 수 있는 모든 기능이 포함되지는 않습니다.

**Orkas 계정이 필요한가요?**
패키지 버전 데스크톱 앱은 처음 실행할 때 로그인을 요청합니다. 이 저장소의 소스 빌드에는 계정 기능이 전혀 없으며, 실행하면 바로 앱이 열립니다.

**Orkas가 Claude Code를 비롯한 CLI 에이전트를 제어할 수 있나요?**
네. Orkas는 외부 CLI 에이전트 5개, 즉 코딩 에이전트인 Claude Code, Codex, OpenCode와 개인 에이전트인 OpenClaw, Hermes-Agent를 로컬 하위 프로세스로 제어할 수 있으며, HyperFrames 같은 오픈소스 프로젝트도 도입할 수 있습니다. 모두 같은 채팅에서 지시합니다.

**Orkas는 Claude Code / Codex / CrewAI / LangChain과 비교해 어떤 점이 다른가요?**
Claude Code와 Codex는 코딩 에이전트입니다. Orkas는 둘 다 팀의 구성원으로 실행하므로 둘 중 하나를 고를 필요가 없습니다. CrewAI와 LangChain은 코드 중심 프레임워크입니다. Orkas는 지휘 에이전트가 전문 에이전트 팀과 사용자의 CLI 에이전트를 조율하는 오픈소스 데스크톱 앱으로, 어떤 모델 제공업체와도 함께 쓸 수 있고 데이터와 키를 로컬에 보관합니다. [전체 비교](https://orkas.ai/compare/?source=gh-orkas)를 참고하세요.

**Orkas는 어떤 플랫폼을 지원하나요?**
macOS 12+(Apple Silicon 및 Intel)와 Windows 10+용 패키지 설치 프로그램이 있습니다. glibc 2.34+ Linux x64/arm64는 현재 소스에서 실행할 수 있으며, 아직 설치 프로그램은 없습니다. Linux의 로컬 음성 전사는 처음 실행할 때 준비되는 고정 버전 whisper.cpp 런타임으로 지원됩니다. Alpine을 비롯한 musl 기반 배포판은 지원하지 않습니다. 소스 부트스트랩에는 Node 22.12+가 필요하며, Python 3 및 C/C++ 빌드 도구 체인은 네이티브 npm 패키지에 호환되는 사전 빌드 바이너리가 없어 로컬에서 다시 빌드해야 할 때만 필요합니다.

**Orkas는 무료 오픈소스인가요?**
네. 앱은 MIT 라이선스이며 무료로 사용할 수 있습니다. 패키지 버전에는 내장 Orkas 모델용 500 크레딧이 포함되어 있으며, 월 $11.99부터 시작하는 유료 플랜은 매월 크레딧, 클라우드 동기화, 더 많은 공유 프로젝트, 앱 게시를 추가로 제공합니다. 자신의 키를 사용하면 모델 사용료는 제공업체가 청구하며, Orkas는 별도 마진을 붙이지 않습니다. [요금제 →](https://orkas.ai/pricing/?source=gh-orkas)

---

## 라이선스

[MIT](./LICENSE)
