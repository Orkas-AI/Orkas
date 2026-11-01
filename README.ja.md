# Orkas

**デスクトップで動くオープンソースの AI エージェントチーム。あなたの目標を完成した成果物に変え、仕事を前に進め続けます。**

Orkas は、オープンソース（MIT）でローカルファーストのマルチエージェント・デスクトップアプリです。チームとして働く AI アシスタントです。必要なことを **Commander** に伝えてください。多くのタスクは Commander が自分で仕上げます。大きな仕事では手順を計画し、専門エージェントに加えて、すでにお使いのコーディングエージェントやパーソナルエージェント（**Claude Code、Codex、OpenCode、OpenClaw、Hermes-Agent**）を呼び込み、協力して取り組ませます。

Orkas は、1 つのプロンプトに答えるだけでなく、プロジェクトを前に進め続けるために作られています。**プロジェクト**には目標、ルール、メモリ、ファイルが保存されるため、新しい会話はいつも前回の続きから始まります。**ToDo** は仕事を人とエージェントで分担し、**自動推進**はチームが次の ToDo に自ら取りかかれるようにし、**定期自動化**は定型作業を毎時・毎日・毎週・毎月繰り返します。データはすべてあなたのコンピューターに残り、完成した成果物はレビューのためにあなたのもとへ戻ってきます。だからこそ、ビジネスの継続的な仕事を安心して Orkas に任せられます。

**[⬇ macOS & Windows 版 Orkas をダウンロード](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)** — 無料で、内蔵の Orkas モデル用に 500 クレジットが付属するので、API キーなしで始められます。自分のキーを使いたい場合は、Claude · OpenAI · Gemini · DeepSeek · Kimi · GLM · Qwen · MiniMax · Doubao、またはローカルの OpenAI 互換エンドポイントを利用できます。

[![Download for macOS & Windows](https://img.shields.io/badge/Download-macOS%20%26%20Windows-5b57d6?style=for-the-badge)](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/Orkas-AI/Orkas?style=flat&logo=github&label=Stars&color=yellow)](https://github.com/Orkas-AI/Orkas/stargazers)
[![Release](https://img.shields.io/github/v/release/Orkas-AI/Orkas?color=blue)](https://github.com/Orkas-AI/Orkas/releases)
[![X: @leochenpm](https://img.shields.io/badge/X-%40leochenpm-black?logo=x)](https://x.com/leochenpm)
[![Website: orkas.ai](https://img.shields.io/badge/Website-orkas.ai-5b57d6)](https://orkas.ai/?source=gh-orkas)

[English](./README.md) · [简体中文](./README.zh-CN.md) · [日本語](./README.ja.md)

---

https://github.com/user-attachments/assets/4f8b16c8-a192-45a4-b19f-80e8d02c3dab

![Orkas デスクトップ — タスクの会話と成果物](./resources/app-ui/task-en.png)

---

## チームが届けるもの

- **動画、ナレーション、画像** — VideoStudio、VoiceStudio、ImageStudio
- **リサーチレポート、SEO 監査、市場分析** — DeepResearcher、SeoGeoAgent、StockAnalyser
- **投稿、記事、ニュースレター、スライド資料** — ContentWriter、PptMaker
- **Web サイト、UI、コード** — UIDesigner、ProductDeveloper
- **Word、Excel、PowerPoint、PDF ファイル** — OfficeWorker
- **EC 業務** — 5 つの EC エージェントによる商品リサーチ、出品、レビュー分析、売上分析、カタログ変更
- **複数のエージェントが必要な複雑な仕事** — Commander が仕事を分割し、各部分を適切なエージェントに渡して結果をまとめます。たとえば、市場調査からレポート、スライド資料、ローンチ動画までを作成できます

アプリには 16 の専門エージェントが同梱されており、それぞれが独自のスキル、メモリ、ツールを持っています。[エージェントマーケットプレイス](https://orkas.ai/views/marketplace/gs/agents/?source=gh-orkas)で 30 以上のエージェントを探せるほか、必要な役割を説明すれば Commander がカスタムエージェントを作成します。

<details>
<summary><b>16 の内蔵エージェント一覧</b></summary>

| 分野 | エージェント | 提供するもの |
| --- | --- | --- |
| リサーチ・分析 | **DeepResearcher** | 検証済みの出典、矛盾点の指摘、監査可能なレポートを備えた、根拠に基づくリサーチ |
| | **SeoGeoAgent** | URL を渡すだけで、技術監査、コンテンツ品質、Core Web Vitals、AI 回答（GEO）での引用されやすさ、優先順位付きの修正リストを提供 |
| | **StockAnalyser** | 株式リサーチ、ファクタースクリーニング、バックテスト、ポートフォリオのリスクチェックを、追跡可能なダッシュボード付きで提供 |
| コンテンツ・メディア | **ContentWriter** | 目標、資料、ラフ原稿から、そのまま公開できる投稿、記事、ニュースレター、事例紹介を作成 |
| | **PptMaker** | トピック、アウトライン、ドキュメントから、編集・レビュー可能な PPTX 資料を作成 |
| | **ImageStudio** | ポスター、カバー画像、SNS 用画像、インフォグラフィック |
| | **VideoStudio** | ナレーション、AI プレゼンター、字幕と吹き替え、ハイライトクリップ、ローカライズ、そして自分のコンテンツと映像を使った参考動画の再現 |
| | **VoiceStudio** | ナレーション、複数話者の音声、文字起こしと字幕、音声の編集とミキシング |
| | **UIDesigner** | プロダクトの目標、PRD、スクリーンショット、Figma の素材から、編集可能な HTML ファーストの UI を作成 |
| 開発・オフィス | **ProductDeveloper** | リポジトリを理解したエンジニアリング — PRD の実装、バグ修正、リファクタリング、レビューを、検証可能な結果とともに実施 |
| | **OfficeWorker** | Word / Excel / PowerPoint / PDF ファイルの作成、編集、チェック、納品を、1 件ずつまたは一括で実施 |
| EC | **ECommerceResearcher** | 予算、市場、仕入れ条件に応じた商品選定 — 候補、除外理由、検証計画 |
| | **ECommerceWriter** | ブランドのトーンに合わせたタイトル、商品詳細ページ、FAQ、画像用コピー、動画台本 |
| | **ECommerceReviewer** | レビューと評判の分析 — 顧客の声の傾向、低評価の根本原因、優先順位 |
| | **ECommerceAnalyzer** | エクスポートしたデータから売上、利益、広告、返金、在庫を分析 — 整合済みの指標と意思決定 |
| | **ECommerceOperator** | カタログ、価格、プロモーション、在庫の変更を計画し、接続したツールを通じてのみ実行 |

各エージェントの詳細 → [orkas.ai/agents](https://orkas.ai/agents/?source=gh-orkas)

</details>

### 自分のコンテンツで参考動画を再現する

**VideoStudio** は、バズった動画の構成、映像スタイル、編集のテンポを、あなた自身の製品、台本、映像素材で再現できます。参考動画ファイルと素材を渡すと、エージェントがフック、情報の順序、映像の展開、CTA（行動喚起）を分析し、制作に入る前に何を残して何を差し替えるかを提案します。

この機能は、モーショングラフィックスの解説動画、SaaS やアプリのデモ、既存の映像から作る製品広告に最も適しています。ローカルで作成したテキスト、字幕、ナレーション、クリップは個別に修正できますが、AI 生成映像に焼き込まれたテキストを変えるには、その映像自体を変更する必要があります。

> 「reference.mp4 を参考に、30 秒の縦型プロモーション動画を作って。フック、タイポグラフィ、テンポはそのままに、内容は私の製品と画面録画に差し替えて。まず分析結果と計画を見せて。」

まずはエージェントが読み込める動画ファイルから始めてください。SNS の共有リンクからのダウンロード機能は内蔵されていません。正確なカメラワーク、人物の演技、フレーム単位での一致は保証されません。詳しくは[参考動画再現ワークフロー](./resources/builtin/marketplace/agents/79df9cc89f5f/skills/video-craft/references/reference-recreation.md)をご覧ください。

---

## 仕事を前に進め続ける

1 つのタスクは良いスタートです。Orkas は、その先も続いていく仕事のために作られています。

- **プロジェクト** — 目標とルール、メモリ、ファイルを、プロジェクト内のすべての会話の出発点にします。毎回ゼロから説明し直す必要はありません。
- **ToDo と自動推進** — すべてのプロジェクトに、人とエージェントのための ToDo リストがあります。自動推進をオンにすると、チームが次の項目に自ら取りかかり、完成した成果物をレビューのために戻してくれます。
- **定期自動化** — どんなタスクでも毎時・毎日・毎週・毎月実行できます。Orkas はあなたのコンピューター上で動作します。v1.9 以降、コンピューターのスリープ解除時や Orkas の起動時に、各自動化は 12 時間以内に逃した直近の実行を 1 回分取り戻します。
- **コネクター** — Gmail、Google Calendar、Sheets、Drive、Notion、Slack、Shopify、Stripe など多数に対応しています。デフォルトでは、Orkas は何かを送信、投稿、削除する前に確認を求めます。
- **アプリ** — ツールの内容を説明すると、Orkas がデスクトップアプリ内のローカルアプリとして構築します。パッケージ版アプリでは、有料プランなら公開リンク付きの Web アプリとして公開することもできます。
- **共有プロジェクト** *（パッケージ版アプリ）* — チームメイトやアシスタント（VA）を招待し、各 ToDo を人またはエージェントに割り当てられます。

> [!NOTE]
> 共有プロジェクト、クラウド同期、Web アプリの公開はパッケージ版アプリのみの機能で、オープンソース版はまだ対応していません。利用するには、**[macOS & Windows 版 Orkas をダウンロード](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)**してください（無料、開始時に 500 クレジット付き）。

音声入力はソースビルドでも利用できます。**設定 → モデル**で **Orkas API Key** を設定し、入力欄の横にあるマイクをクリックしてください。確認が表示されたらマイクへのアクセスを許可します。音声は認識のために Orkas へ送信され、キー所有者の Orkas クレジットを消費します。もう一度クリックすると停止するので、テキストを確認してから自分で送信してください。アクセスを拒否してしまった場合は、システム設定でマイクを有効にしてください。

---

## Claude Code、Codex、OpenCode、OpenClaw、Hermes-Agent を一緒に動かす

Orkas は、すでにインストール済みの CLI エージェント（コーディングエージェントの **Claude Code、Codex、OpenCode**、パーソナルエージェントの **OpenClaw と Hermes-Agent**）を、独自の専門エージェントと並べてローカルセッションとして実行します。Commander は各エージェントに得意な部分を任せつつ、全体で 1 つの計画を保つので、1 つのチャットでバグを修正し、変更をレビューし、リリースノートの下書きまで作れます。HyperFrames などのオープンソースツールも同じ方法で組み込めます。

[Claude Code と Codex を一緒に使う →](https://orkas.ai/blog/claude-code-codex-together/?source=gh-orkas)

---

## Orkas を選ぶ理由

- **計画し、任せ、残りは自分でこなす Commander** — 目標を分解し、適切なエージェント、スキル、コネクター、ツールを選びます。より適した専門エージェントがいない場合は、分析、執筆、リサーチ、ファイル作業を自分で処理します。
- **ローカルファースト設計** — 会話、ファイル、ナレッジベース、カスタムエージェントは、デフォルトでディスク上に保存されます。パッケージ版アプリでは、クラウド同期は任意です。自分のキーを使う場合、モデルの呼び出しはあなたのマシンからプロバイダーへ直接送られます。内蔵の Orkas モデルは、Orkas のマネージドモデルサービスを経由して動作します。
- **どのモデルでも、いつでも切り替え可能** — Commander と内蔵エージェントは 1 つのモデル設定を共有します。内蔵の Orkas モデル、自分のプロバイダー、ローカルエンドポイントのいずれでも選べます。外部 CLI エージェントは、それぞれ独自のモデル設定を維持します。
- **成長するエージェント** — 各エージェントは専用のスキルとメモリを持ちます。アプリがアイドル状態のときにバックグラウンドレビューが新しいアクティビティを確認し、自己評価、再利用可能な手法、学習したスキルを改善できます。
- **オープンソースでブラックボックスなし** — MIT ライセンスです。Orkas と、すべてのエージェントやスキルが何をしているかを正確に確認できます。

> ⭐ Orkas が役に立ったら、スターを付けていただくと、より多くの人がこのプロジェクトを見つけられるようになります。

---

## ダウンロード

| | パッケージ版アプリ（推奨） | ソースから実行 |
| --- | --- | --- |
| プラットフォーム | macOS 12+（Apple Silicon & Intel）、Windows 10+ | macOS、Windows、glibc 2.34+ Linux x64/arm64 |
| アカウント | サインイン — 500 クレジット無料 | 不要 |
| モデル | 内蔵の Orkas モデル、または自分のキー | 自分のキーまたはローカルエンドポイント |
| その他の機能 | プロジェクトでの共同作業、アプリの公開、クラウド同期など | — |
| 入手方法 | **[Orkas をダウンロード](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)** | [クイックスタート](#クイックスタート) |

ダウンロードリンクはお使いのシステムを判別し、適切なインストーラーのダウンロードを開始します。

---

## 主な用途

- **マーケティングコンテンツ** — あなたらしいトーンのローンチ動画、製品ページ、投稿、ニュースレター。[コンテンツ執筆](https://orkas.ai/use/content-writing/?source=gh-orkas) · [動画](https://orkas.ai/use/make-videos/?source=gh-orkas)
- **ストア運営** — 週次の売上レポート、レビューへの返信、出品、競合チェック。[EC](https://orkas.ai/use/ecommerce/?source=gh-orkas)
- **リサーチとレポート** — 出典付きのレポートや資料を、必要なときに、または毎週。[リサーチ](https://orkas.ai/use/researchers/?source=gh-orkas) · [データ分析](https://orkas.ai/use/data-analysis/?source=gh-orkas)
- **ドキュメントとのチャット** — 自分のファイルに基づき、出典箇所への引用付きで回答します。[ドキュメントとのチャット](https://orkas.ai/use/chat-with-documents/?source=gh-orkas)
- **クライアントワーク** — 会議の資料、クライアント向け月次レポート、アップデート資料を、あなたのテンプレートで。[クライアント月次レポートのテンプレート](https://orkas.ai/blog/monthly-client-report-template/?source=gh-orkas)
- **プロダクトのローンチ** — ランディングページ、テスト付きのバグ修正、変更履歴、ローンチ投稿。[開発者向け](https://orkas.ai/use/developers/?source=gh-orkas)
- **アプリの構築** — 見積もり計算ツール、予約フォーム、社内ツール。[アプリを作る](https://orkas.ai/use/build-apps/?source=gh-orkas)
- **小規模チーム** — 人とエージェントのための 1 つのプロジェクト。[小規模チーム](https://orkas.ai/use/small-teams/?source=gh-orkas)

---

## 他ツールとの比較

| ツール | 概要 | Orkas との違い |
| --- | --- | --- |
| **Claude Code** | Anthropic のエージェント型コーディングツール。ターミナル、IDE、デスクトップ、Web で利用でき、Claude モデルを基盤としています。 | どちらか一方を選ぶ必要はありません。Orkas は Claude Code をエージェントの 1 つとして実行します。その周りに、リサーチ、コンテンツ、動画など、コード以外の仕事を担うモデル非依存のチームを加え、プロジェクト、ToDo、自動化で仕事を前に進め続けます。[Orkas vs Claude Code →](https://orkas.ai/compare/orkas-vs-claude-code/?source=gh-orkas) |
| **Codex** | OpenAI のコーディングエージェント。ターミナル、エディター、クラウドで利用できます。 | どちらか一方を選ぶ必要はありません。Orkas は Codex を、Claude Code や OpenCode と並ぶエージェントの 1 つとして実行します。Commander はコーディングを Codex に、レビューを別のエージェントに任せたうえで、ドキュメント、ローンチ投稿、動画といったリリースのコード以外の半分もカバーできます。[Orkas vs Codex →](https://orkas.ai/compare/orkas-vs-codex/?source=gh-orkas) |
| **LangChain** | LLM アプリやエージェントを構築するための開発者向けフレームワーク／ライブラリ。コードファーストで、自分の Python/JS アプリに組み込んで使います。 | Orkas はオーケストレーションのコードを書くのではなく、チャットで指示するデスクトップアプリです。データはデフォルトでローカルに保存されます。 |
| **CrewAI** | ロールプレイ型の自律エージェントをオーケストレーションするための Python フレームワーク。クルーとエージェントをコードで定義します。 | Orkas はマルチエージェントのオーケストレーションをデスクトップアプリで提供し、プロジェクト、ToDo、自動化、エージェントごとの自己改善を標準で備えています。 |
| **OpenClaw** | メッセージング連携、マルチエージェントのルーティング、サブエージェントを備えたパーソナルエージェントプラットフォーム。 | Orkas は、完成した成果物のためのデスクトップワークスペースを提供し、内蔵の専門エージェントと、Claude Code、Codex、OpenCode などの CLI エージェントとの連携を備えています。OpenClaw も CLI エージェントとしてそのワークフローに参加できます。 |
| **Hermes-Agent** | Nous Research による自己改善型エージェント。メモリとスキルを持つ単一のエージェントで、CLI、メッセージングゲートウェイ、デスクトップアプリとして利用できます。 | Orkas はチームを統括します。Commander が多くの専門エージェントやほかの CLI エージェントを指揮し、Hermes-Agent もその 1 つとして組み込まれます。 |

**Orkas が向いているのは**、1 人のアシスタントではなくエージェントのチームが欲しい方、何日にもわたって仕事を前に進めたい方、データ、キー、エージェントを自分のディスクに置いておきたい方です。

**向いていないのは**、汎用チャットボットが 1 つあれば十分な方や、自分のアプリに組み込む純粋なコードライブラリを求めている方です。

**コーディングエージェントを比較検討中ですか？** [Codex vs OpenCode](https://orkas.ai/compare/codex-vs-opencode/?source=gh-orkas) · [Claude Code vs Codex vs OpenCode](https://orkas.ai/compare/claude-code-vs-codex-vs-opencode/?source=gh-orkas) · [Claude Code の代替ツール](https://orkas.ai/compare/claude-code-alternatives/?source=gh-orkas)

**詳しい比較はこちら →** [vs Claude Code](https://orkas.ai/compare/orkas-vs-claude-code?source=gh-orkas) · [vs Codex](https://orkas.ai/compare/orkas-vs-codex?source=gh-orkas) · [vs Cline](https://orkas.ai/compare/orkas-vs-cline?source=gh-orkas) · [vs LangChain](https://orkas.ai/compare/orkas-vs-langchain?source=gh-orkas) · [vs ChatGPT](https://orkas.ai/compare/orkas-vs-chatgpt?source=gh-orkas) · [vs OpenClaw](https://orkas.ai/compare/orkas-vs-openclaw?source=gh-orkas) · [vs Hermes-Agent](https://orkas.ai/compare/orkas-vs-hermes-agent?source=gh-orkas)

---

## クイックスタート

パッケージ版のインストーラーを使いたい場合は、上記の[ダウンロード](#ダウンロード)をご覧ください。ソースから実行する場合（現在、Linux で Orkas を動かす方法はこれだけです）は次のとおりです。

**動作要件**: Node 22.12+ · macOS / Windows 10+ / glibc 2.34+ Linux x64 または arm64。まれにネイティブモジュールのソースビルドへのフォールバックが発生する場合に備えて、Python 3 と C/C++ のビルドツールチェーンを利用できるようにしておいてください。

```bash
git clone https://github.com/Orkas-AI/Orkas.git
cd Orkas
./run.sh           # macOS / Linux
run.cmd            # Windows
```

Linux でソースから実行するには glibc 2.34+ が必要です。Alpine など musl ベースのディストリビューションはサポートされていません。ローカルの音声文字起こしでは、ソースからの初回起動時に、ターゲット環境ネイティブの whisper.cpp ランタイムと多言語モデルがダウンロード・検証されます。

`run.sh` / `run.cmd` は、ロックされた npm 依存関係ツリーをインストールし、初回起動時に固定バージョンの Python、uv、Node、埋め込みモデル（約 95 MB）、OfficeCLI、FFmpeg、whisper.cpp、多言語音声モデルのリソースを準備します。Linux では、アプリを開く前に、プラットフォームネイティブのモジュールと Whisper ランタイムが Electron の ABI で動作するかを検証します。OCR とスキル固有の Python パッケージは、それらの機能を初めて使うときに、分離されたローカル環境へインストールされます。初回起動時には、`~/.orkas/`（macOS / Linux）または `<smallest non-system drive>:\.orkas\`（Windows）の下にワークスペースが作成されます。その後、**設定 → AI プロバイダー**を開いて API キーまたは OAuth を追加してください。

ネイティブ依存関係のエラーが出た場合: Node.js 24 LTS（最低 22.12.0）を使い、
このチェックアウトで `npm run native:repair` を実行してください。オプションのパッケージを復元し、
Electron 用に SQLite を修復し、分離された画像処理用に同梱の Node を準備したうえで、
SQL、sqlite-vec、sharp をチェックしてから完了します。
インストールを行わずにチェックだけをするには `npm run native:check` を使います。
実行されるチェックの内容は、[ネイティブ依存関係の検証スクリプト](./scripts/verify-native-dependencies.cjs)をご覧ください。

---

## 仕組み

### タスクのルーティング

Commander は一般的な仕事を自分で処理し、専門的な仕事は次の 3 つのツールで委任します。

- **`dispatch_to`** は、名前付きのエージェントを実行し、その結果を返して作業を続けます。結果を待つことも、非同期で実行してタスク完了時に Commander へ通知させることもできます。
- **`hand_off_to`** は、残りの作業を名前付きのエージェントに引き継ぎ、現在の Commander のターンを終了します。エージェントが自ら返信します。オプションの継続設定を使うと、その後で Commander がより大きなタスクを再開できます。
- **`run_worker`** は、匿名で分離されたサブタスクを実行し、非公開の結果を返します。会話履歴や名前付きエージェントのスキルは受け取りません。

名前付きエージェントのタスクと匿名ワーカーには、別々の並行実行制御があります。[ディスパッチの実装](./src/main/features/group_chat/bus.ts)と[実行ロック](./src/main/util/locks.ts)をご覧ください。

### コンテキスト管理

ランタイムは、プロンプト、ツール、永続的なランタイム状態を考慮したうえで、選択したモデルが実際に使える入力容量に合わせてコンテキストの予算を配分します。完了した対話には上限付きの直近履歴ウィンドウを使い、長く続くアクティブなタスクでは、チェックポイントを使って以前のプロセスメッセージを圧縮しつつ、直近の作業は保持します。ファイルの読み込み、ファイルの変更、コマンドの実行には構造化された記録もあり、コンテキストの圧縮後も残すことができます。

[コンテキスト予算](./src/core-agent/src/agent/context-budget.ts)、[セッション履歴とチェックポイント](./src/core-agent/src/agent/session.ts)、[ワークスペースの記録](./src/core-agent/src/agent/workspace-state.ts)をご覧ください。

### メモリとライブラリ

永続的なノートは、ユーザーの好み、プロジェクトの事実、各エージェントの再利用可能な知識を、それぞれ別のスコープで保持します。これらのノートは、ライブラリのドキュメントインデックスや保存された会話履歴とは別のものです。

ライブラリはドキュメントをパッセージに分割して抽出し、ローカルの SQLite ベクトルインデックスに保存します。埋め込みモデルはあなたのマシン上で動作します。`library` ツールは、グローバルまたは現在のプロジェクトのライブラリから、ファイルの一覧表示、関連パッセージの検索、元のコンテンツの読み込みを行えます。過去の会話は `chat_history` を通じて別途取得されます。

[スコープ付きメモリ](./src/main/features/memory.ts)、[ドキュメントの抽出](./src/main/util/file_to_chunks.ts)、[ライブラリのツール](./src/main/model/core-agent/kb-tools.ts)、[会話の取得](./src/main/model/core-agent/chat-history-tools.ts)をご覧ください。

### 実行の制限と復旧

セッションロックと並行実行数の上限が、並列作業を制限します。ツールのラウンド数の予算、進捗チェックポイント、繰り返し呼び出しのチェック、フェーズを考慮したアイドル監視が、停止したり同じ作業を繰り返したりする実行を抑えます。名前付きエージェントのタスクは個別に追跡・キャンセルでき、受け付け済みまたはキューに入ったタスクが完了した結果として扱われることはありません。

[アクターの予算](./src/main/features/group_chat/actor-budgets.ts)、[エージェントランタイム](./src/core-agent/src/agent/runner.ts)、[デスクトップ用モデルアダプター](./src/main/model/core-agent/client.ts)をご覧ください。

### アクティビティからの学習

バックグラウンドレビューは、クールダウンと実行制限の範囲内で、アプリがアイドル状態のときに新しいエージェントのアクティビティを確認します。レビューでは、エージェントの自己評価（`COMPETENCE.md`）、再利用可能な手法（`LEARNING_STRATEGIES.md`）、学習したスキルを更新することがあります。レビューはタスクの数ではなく新しいアクティビティに基づいて行われ、保存する価値のあるものは何もないと結論づけることもあります。

[振り返りスケジューラー](./src/main/features/reflection-orchestrator.ts)と[レビュープロンプト](./src/core-agent/src/evolution/metacognition.ts)をご覧ください。

---

## よくある質問

**Orkas とは何ですか？**
Orkas は、オープンソース（MIT）でローカルファーストのマルチエージェント・デスクトップアプリです。Commander があなたの目標を ToDo に変え、16 の内蔵専門エージェントに加えて Claude Code、Codex、OpenCode、OpenClaw、Hermes-Agent を連携させて、完成したファイルを届けます。単一のチャットボットでも、コードフレームワークでも、ホスト型の SaaS でもありません。

**API キーは必要ですか？**
いいえ。パッケージ版アプリには、内蔵の Orkas モデル用の 500 クレジットが付属しています。使い切った後は、クレジットを購入するか、有料プランを選ぶか、自分のプロバイダーのキーを追加してください。プロバイダーの料金は別途かかります。

**Orkas はローカル LLM ですか？**
いいえ。Orkas はあなたのマシン上で動作し、選択したモデル（内蔵の Orkas モデル、自分の API キー、ローカルモデルのエンドポイント）を呼び出します。エージェントとツールをオーケストレーションするものであり、それ自体はモデルではありません。

**自分のドキュメントをもとに、引用付きで質問に答えられますか？**
はい。PDF やドキュメントをローカルのライブラリに追加すると、Orkas はそれらを検索し、出典箇所への引用付きで回答できます。元の資料を開いて確認できます。インデックスはあなたのマシン上で作成されます。

**Ollama や LM Studio などのローカルモデルは使えますか？**
はい。**アカウント設定 → モデル → チャット → モデルを追加 → カスタム**を開き、**OpenAI 互換**または **Anthropic 互換**を選択して、ベース URL、正確なモデル ID、API キーを入力します。保存したモデルを、タスクのモデル選択から選んでください。

**API キーとデータはどこに保存されますか？**
デフォルトではあなたのディスク上です。自分のプロバイダーのキーはローカルで暗号化され、クラウド同期の対象外です。自分のキーを使う場合、モデルの呼び出しはあなたのマシンからプロバイダーへ直接送られます。内蔵の Orkas モデルは、Orkas のマネージドサービスを使います。パッケージ版アプリのオプションのクラウド同期と共有プロジェクトでは、選択したデータが Orkas のサーバーに保存されます。[セキュリティとデータの取り扱い →](https://orkas.ai/security/?source=gh-orkas)

**Orkas はオフラインで使えますか？**
ソースビルドは、ローカルモデルのエンドポイントを使えば完全にオフラインで動作します。パッケージ版アプリはサインインが必要で、クラウドモデルにはネットワーク接続が必要です。

**コンピューターの電源が切れていても動き続けますか？**
いいえ。Orkas はあなたのコンピューター上で動作するため、自動推進と自動化には、コンピューターが起動していて Orkas が実行中である必要があります。v1.9 以降、コンピューターのスリープ解除時や Orkas の起動時に、各自動化は 12 時間以内に逃した直近の実行を 1 回分取り戻します。

**アプリを作成して公開できますか？**
はい。Orkas 内で動作するローカルアプリは無料です。Web アプリを公開リンクで公開するには有料プランが必要です（Lite は 5 個、Pro は 8 個、Max は 15 個まで）。また、公開された Web アプリでは、Orkas 内で使えるすべての機能が利用できるわけではありません。

**Orkas のアカウントは必要ですか？**
パッケージ版のデスクトップアプリでは、初回起動時にサインインが求められます。このリポジトリのソースビルドにはアカウント機能がまったくなく、そのままアプリが起動します。

**Orkas は Claude Code などの CLI エージェントを操作できますか？**
はい。Orkas は 5 つの外部 CLI エージェント（コーディングエージェントの Claude Code、Codex、OpenCode と、パーソナルエージェントの OpenClaw、Hermes-Agent）をローカルのサブプロセスとして操作でき、HyperFrames などのオープンソースプロジェクトも取り込めます。すべて同じチャットから指示できます。

**Orkas は Claude Code / Codex / CrewAI / LangChain とどう違いますか？**
Claude Code と Codex はコーディングエージェントです。Orkas はその両方をチームのメンバーとして実行するので、どちらかを選ぶ必要はありません。CrewAI と LangChain はコードファーストのフレームワークです。Orkas はオープンソースのデスクトップアプリで、Commander が専門エージェントのチームとあなたの CLI エージェントを統括します。どのモデルプロバイダーでも使え、データとキーはローカルに保たれます。[詳しい比較](https://orkas.ai/compare/?source=gh-orkas)をご覧ください。

**Orkas はどのプラットフォームに対応していますか？**
macOS 12+（Apple Silicon および Intel）と Windows 10+ にはパッケージ版のインストーラーがあります。glibc 2.34+ の Linux x64/arm64 では現在ソースから実行でき、インストーラーはまだありません。Linux でのローカル音声文字起こしは、初回起動時に準備される固定バージョンの whisper.cpp ランタイムによってサポートされています。Alpine など musl ベースのディストリビューションはサポートされていません。ソースからのブートストラップには Node 22.12+ が必要です。Python 3 と C/C++ のビルドツールチェーンは、ネイティブ npm パッケージに互換性のあるビルド済みバイナリがなく、ローカルで再ビルドする必要がある場合にのみ必要です。

**Orkas は無料でオープンソースですか？**
はい。アプリは MIT ライセンスで、無料で使えます。パッケージ版アプリには内蔵の Orkas モデル用の 500 クレジットが付属しています。月額 $11.99 からの有料プランでは、毎月のクレジット、クラウド同期、より多くの共有プロジェクト、アプリの公開が追加されます。自分のキーを使う場合、モデルの利用料金はプロバイダーから請求され、Orkas が上乗せすることはありません。[料金 →](https://orkas.ai/pricing/?source=gh-orkas)

---

## ライセンス

[MIT](./LICENSE)
