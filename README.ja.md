# Orkas

**オープンソースのAIエージェントが デスクトップに 目標を完成した作業に変え 動き続けるのです**

Orkas はオープンソース (MIT) の 局所初の 多代理デスクトップ アプリ**Commander** 必要なのは: 作業を自分で完成させ,より大きな作業のために ステップを計画し, プログラムや個人エージェントと共に 専門的なエージェントを招集します**Claude Code,Codex,OpenCode,OpenClawおよびHermes-Agent** 協力して取り組む

プロジェクトを動かすためではなく 提示に答えるために作られています**プロジェクト** 目標,ルール,メモリ,ファイルを保持します だから新しい会話は 前回の話が終わった場所から始まります**準備する** 人と代理人の間で仕事を分け,**Auto-advance** チームに次の作業を自分でやるように**予定された自動化** 作業を毎時間,毎週,週毎月繰り返します. すべてのデータがコンピュータに保存され,完成した作業がレビューのために戻ります.

**[macOS & Windows に Orkas をダウンロードする](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)** ◎無料,Orkasモデルに500 creditsが付属されているので,起動するにはAPI keyは必要ありません.自分のキーを選ぶか?

[![Download for macOS & Windows](https://img.shields.io/badge/Download-macOS%20%26%20Windows-5b57d6?style=for-the-badge)](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/Orkas-AI/Orkas?style=flat&logo=github&label=Stars&color=yellow)](https://github.com/Orkas-AI/Orkas/stargazers)
[![Release](https://img.shields.io/github/v/release/Orkas-AI/Orkas?color=blue)](https://github.com/Orkas-AI/Orkas/releases)
[![X: @leochenpm](https://img.shields.io/badge/X-%40leochenpm-black?logo=x)](https://x.com/leochenpm)
[![Website: orkas.ai](https://img.shields.io/badge/Website-orkas.ai-5b57d6)](https://orkas.ai/?source=gh-orkas)

[English](./README.en.md) · [简体中文](./README.zh-CN.md) · [日本語](./README.ja.md) · [한국어](./README.ko.md) · [Español](./README.es.md) · [Bahasa Indonesia](./README.id.md) · [Español (Latinoamérica)](./README.es-419.md) · [Русский](./README.ru.md) · [Português (Brasil)](./README.pt-BR.md) · [Türkçe](./README.tr.md) · [繁體中文](./README.zh-TW.md) · [Tiếng Việt](./README.vi.md) · [Deutsch](./README.de.md) · [ไทย](./README.th.md) · [Français](./README.fr.md) · [Italiano](./README.it.md) · [Português (Portugal)](./README.pt-PT.md) · [العربية](./README.ar.md)

---

https://github.com/user-attachments/assets/4f8b16c8-a192-45a4-b19f-80e8d02c3dab

![Orkas デスクトップ 作業会話と成果物](./resources/app-ui/task-en.png)

---

## チームがもたらすもの

- **ビデオ,声伝達および画像** — [VideoStudio](https://github.com/Orkas-AI/Orkas-VideoStudio),声スタジオ,ImageStudio
- **調査報告,SEO監査および市場分析** — DeepResearcher,セオSeoGeoAgent,ストックアナライザー
- **投稿,記事,ニュースレター,スライドデッキ** — 内容作家,PptMaker
- **ウェブサイト,UIとコード** — UIDesigner,ProductDeveloper
- **ワード,Excel, PowerPoint,PDFファイル** — OfficeWorker
- **電子商取引** — 商品調査,リストアップ,レビュー分析,販売分析およびカタログ変更,五人の電子商取引代理店から
- **複雑な作業で複数の代理人が必要** — Commanderはそれを分割し,各部体を適切なエージェントに委ね,結果を組み合わせます. 例えば,市場調査がレポート,スライドデッキと打ち上げビデオになる

独自のスキル,メモリ,ツールを持つ 16人の専門家がアプリを搭載しています[代理市場](https://orkas.ai/views/marketplace/gs/agents/?source=gh-orkas)役目を説明して Commanderはあなたのためにカスタムエージェントを 作ります

<details>
<summary><b>16人のエージェントが集まった</b></summary>

| 面積 | 代理人 | 提供するもの |
| --- | --- | --- |
| 研究と分析 | **DeepResearcher** | 検証された情報源,標識された矛盾と監査可能な報告を備えた証拠に基づく研究 |
| | **SeoGeoAgent** | ウェブのコア・バイタルズ,AI-応答 (GEO) の引用可能性,ランク付け修正リスト |
| | **StockAnalyser** | 株式調査,ファクタースクリーン,バックテスト,ポートフォリオリスクチェック,追跡可能なダッシュボード |
| コンテンツ &メディア | **ContentWriter** | 目標,情報源または概要から出版準備が整った記事,ニュースレター,ケーススタディ |
| | **PptMaker** | 編集可能でレビュー可能な PPTX デッキは,テーマ,概要または文書から |
| | **ImageStudio** | ポスター,カバー,ソーシャル画像,インフォグラフィック |
| | **[VideoStudio](https://github.com/Orkas-AI/Orkas-VideoStudio)** | 物語,AIプレゼンター,キャプションとダビング,ハイライトクリップ,ローカル化,そして参照ビデオリクリエーション |
| | **VoiceStudio** | 物語,多音声オーディオ,トランスクリプトと字幕,オーディオ編集およびミックス |
| | **UIDesigner** | 編集可能,製品目標,PRD,スクリーンショットまたはFigma素材からHTML初級UI |
| 建物 & オフィス | **ProductDeveloper** | 復習意識のエンジニアリング  PRD を実装し,バグを修正し,リファクター,レビューし,検証可能な結果 |
| | **OfficeWorker** | Word/Excel/PowerPoint/PDFファイルを作成,編集,チェックおよび配信する |
| 電子商取引 | **ECommerceResearcher** | 予算,市場及び調達制限による製品選択 候補者,拒否理由,検証計画 |
| | **ECommerceWriter** | タイトル,詳細ページ,FAQ,画像コピー,ビデオスクリプトはブランドの声で |
| | **電子商取引審査員** | 評価と評判分析 顧客テーマ,悪いレビューの根本原因,優先事項 |
| | **ECommerceAnalyzer** | 輸出からの売上,利益,広告,返金および物件 調整された指標と決定 |
| | **ECommerceOperator** | カタログ,価格,プロモーション,インベクトリー変更を計画する.接続したツールを通じてのみ実行する |

代理人についてもっと[orkasス.ai/エージェント](https://orkas.ai/agents/?source=gh-orkas)

</details>

### 自分のコンテンツで参考ビデオを再作成する

**VideoStudio** ビデオのリファレンスの動画ファイルと資産を供給:エージェントはフック,情報順序,視覚拍数,行動への呼びかけを分析し,その後,制作前に何を保存し,何を置き換えるべきかを提案します.

これは,ムービーグラフィック説明器,SaaSまたはアプリデモ,および既存の映像から作成された製品広告に最適です.本地的に作成されたテキスト,字幕,物語,クリップは別々に修正できます.AIで生成された映像に焼いたテキストは,その映像を変更する必要があります.

> "30秒間の垂直プロモーションの参考として Reference.mp4 を使って下さい. ハック,タイプ,ペースを保持し,コンテンツを私の製品と画面の録音で置き換えて,まず分解と計画を教えて下さい".

メディアの情報源は,このビデオファイルから開始します.[参照・レクリエーションのワークフロー](./resources/builtin/marketplace/agents/79df9cc89f5f/skills/video-craft/references/reference-recreation.md).

---

## 作業を進め

Orkasは継続的な作業のために作られています

- **プロジェクト** — 目標とルール,メモリ,ファイルなどです. プロジェクトでの会話が始まるので,ゼロから簡単に説明することはありません.
- **作業と自動進捗** — プロジェクトには,人や代理人のタスクリストがあります. Auto-advanceは,次の項目を自分で拾い,完成した作業をあなたのレビューのために持ち帰ります.
- **予定された自動化** — Orkasはコンピュータで実行されます.v1.9から,各自動化がコンピューターが目覚めた時やOrkasが起動した時から12 hours以内に最新の失われた実行を追いつきます.
- **接続器** — Gmail,Google Calendar,シートとDrive,Notion,Slack,Shopify,Stripeなど多くのもの.デフォルトでは,Orkasは送信,投稿または削除する前に尋ねます.
- **アプリ** — ツールを記述し,Orkasはデスクトップアプリ内のローカルアプリとして構築します.パッケージ化されたアプリでは,付費プランは公開リンクを持つウェブアプリケーションとしても公開できます.
- **共有プロジェクト** — *(パッケージアプリ)*チームメイトやVAを招待し 各作業を相手や代理人に委ねます

> [!NOTE]
> オープンソースのビルドはまだサポートしていません.**[macOS & Windows の Orkas をダウンロードする](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)** (無料で500 creditsからスタート)

---

## Claude Code,Codex,OpenCode,OpenClawとHermes-Agentを一緒に実行する

Orkas は既に設置した CLI 代理を局所セッションとして運営しています**Claude Code,Codex,OpenCode** 個人的な代理人**OpenClawとHermes-Agent** Commanderはそれぞれに最も良い部分を委ねて,すべての計画に1つの計画を保持します.それで,単一のチャットでバグを修正し,変更をレビューし,リリースノートを書き込むことができます.

[Claude CodeとCodexを一緒に使って →](https://orkas.ai/blog/claude-code-codex-together/?source=gh-orkas)

---

## なぜOrkas

- **計画,委託,残りをするCommander** — 目標を分解し,適切な代理人,スキル,コネクタやツールを選び,分析,書き込み,研究,ファイル作業を自分で処理する.
- **デザインの先端は地方** — 交談,ファイル,知識ベース,カスタムエージェントはデフォルトでディスクに保存されます.クラウド同期はパッケージアプリでオプションです.独自のキーを使用して,モデルコールが直接マシンからプロバイダーへ移動します.内蔵のOrkasモデルはOrkasの管理されたモデルサービスを介して実行されます.
- **モデルならいつでも交換する** — Commanderと内蔵エージェントは,内蔵のOrkasモデル,あなたの独自のプロバイダー,またはローカルエンドポイントを同じモデル設定で設定しています.外部CLIエージェントは独自のモデル設定を維持します.
- **改善するエージェント** — 背景レビューは,アプリが無効で新しい活動を調査し,自己評価,再利用可能な方法,学習されたスキルを磨き出すことができます.
- **オープンソース,ブラックボックスなし** — Orkasや全てのエージェントや技能が何をしているか正確に読む

> ⭐ Orkasが役に立つなら,スターはより多くの人がプロジェクトを見つけるのを助けます.

---

## ダウンロード

| | パッケージ化されたアプリ (推奨) | 源から実行する |
| --- | --- | --- |
| プラットフォーム | macOS 12+ (Apple Silicon & Intel),Windows 10+ | macOS,Windows,glibc 2.34+ Linux x64/arm64 |
| 口座 | 登録 ₹500無料クレジット | どれも |
| モデル | Orkasのモデル内蔵 または自分の鍵 | 鍵やローカルエンドポイント |
| 含有する | プロジェクトコラボレーション,アプリ公開,クラウドシンクロレーションなど | — |
| 持って来 | **[Orkasダウンロード](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)** | [早くスタート](#早くスタート) |

ダウンロードリンクは,あなたのシステムを検出し,適切なインストーラを起動します.

---

## 何のために使ってるんだ

- **マーケティングコンテンツ** — 声でビデオ,製品ページ,投稿,ニュースレターを公開します[コンテンツの書き込み](https://orkas.ai/use/content-writing/?source=gh-orkas) · [ビデオ](https://orkas.ai/use/make-videos/?source=gh-orkas)
- **倉庫業務** — 週刊の販売報告,レビュー回答,リストアップ,競合他社チェック[電子商取引](https://orkas.ai/use/ecommerce/?source=gh-orkas)
- **研究と報告** — 需要に応じてまたは毎週提供される報告やデッキ[研究](https://orkas.ai/use/researchers/?source=gh-orkas) · [データ分析](https://orkas.ai/use/data-analysis/?source=gh-orkas)
- **文書でチャット** — 回答は,自分のファイルに基いて,ソースの文献を引用する.[文書でチャット](https://orkas.ai/use/chat-with-documents/?source=gh-orkas)
- **顧客業務** — 会議報告,月間クライアントレポート,テンプレート更新デッキ[顧客報告の月額模様](https://orkas.ai/blog/monthly-client-report-template/?source=gh-orkas)
- **製品開始** — ランディングページ,テスト,チャングログ,ランニングポストのバグ修正[開発者](https://orkas.ai/use/developers/?source=gh-orkas)
- **アプリを作成する** — 引票計算機,予約フォーム,内部ツール[アプリを作成する](https://orkas.ai/use/build-apps/?source=gh-orkas)
- **小規模なチーム** — 社員が代理人[小規模なチーム](https://orkas.ai/use/small-teams/?source=gh-orkas)

---

## Orkas の 比較

| ツール | 何なのか | Orkas の 違い |
| --- | --- | --- |
| **Claude Code** | アントロピックの代理コードツール ターミナル,IDE,デスクトップ,ウェブで,クロードモデルに基づいて構築された. | Orkasはクロード・コードを代理人として運営している.その周りに,Orkasはコードの研究,コンテンツ,ビデオなど以上の作業のためにモデルアグノスティックチームを追加し,プロジェクトやタスクと自動化でそれを動かし続ける.[Orkas vs クロード・コード](https://orkas.ai/compare/orkas-vs-claude-code/?source=gh-orkas) |
| **Codex** | 端末に,編集者とクラウドに 代码を出すエージェント | Codexは,クロード・コードとオਪਨ・コードの隣接して,コデックスを運営する. コマンドーはコードをコデックスに,レビューを他のエージェントに譲り,その後リリース文書,打ち上げポスト,ビデオの非コード半部分をカバーすることができます.[Orkas vs Codex →](https://orkas.ai/compare/orkas-vs-codex/?source=gh-orkas) |
| **クロッド・コワーク** | アントロピックの日常業務のエージェント,現在デスクトップ,ウェブ,モバイルで Claude への付与プランの一部. デフォルトとしてAnthropicのクラウドで実行され,Claudeモデルを使用します. | クロード・コワークへのオープンソースの代替品 (MIT) は,500 creditsで無料です.Orkasはコンピュータ上でエージェントを実行し,データもデフォルトでローカルに保存します.内蔵された Orkas モデル,独自のプロバイダーキーまたはローカルエンドポイントを使用します.コマンドーはまた,Claude Code,Codexおよび他の CLI エージェントを導入できます.トレードオフ:Orkasはコンピューターが覚醒する必要があります.[クロッド・コワークの代替品](https://orkas.ai/compare/claude-cowork-alternatives/?source=gh-orkas) |
| **マヌス** | マナスクラウドでデフォルトでタスクを計画し実行するAIエージェント.マナススタジオデスクトップアプリ (macOSとWindows) は,あなたが選択したフォルダーでも動作し,タスクがまだクラウドで計画されている. | Orkasは,あなたのコンピュータでエージェントを実行し,データをデフォルトでローカルに保存します.内蔵されたOrkasのモデル,あなたの独自のプロバイダーキーまたはローカルエンドポイントです.プロジェクト,タスク,自動化により作業が動きます.トレードオフ:Orkasはあなたのコンピューターが覚醒する必要があります.マヌスのクラウドタスクは,それなしで実行し続けることができます.[オープンソースのマヌス代替 →](https://orkas.ai/open-source-manus-alternative/?source=gh-orkas) |
| **ラングチェイン** | 開発者フレームワーク/ライブラリでLLMアプリやエージェントを構築します 代码先, Python/JSアプリに組み込まれています. | Orkas は,チャットを通じて操作するデスクトップアプリで,オーケストラコードを書くのではなく,デフォルトでローカルに保存されます. |
| **乗組員** | ロールプレイの自律的なエージェントをオーケストラするための Python フレームワーク コードでクルーとエージェントを定義します | Orkas は デスクトップアプリに 多エージェントのオーケストレーションを 組み込みました プロジェクトやタスク,自動化,各エージェントの 自己改善などです |
| **OpenClaw** | メッセージング統合,マルチエージェントルーティング,サブエージェントのパーソナル・エージェントプラットフォーム | Orkas は,Claude Code,Codex,オਪਨ・コードなどのCLIエージェントに内蔵した専門家と連携を備えた完成品のデスクトップワークスペースを提供しています.OpenClawは,CLIエージェントとしてそのワークフローに加わることができます. |
| **Hermes-Agent** | ヌス・リサーチの自己改善エージェント 記憶力とスキルを持つエージェントが CLI,メッセージングゲートウェイ,デスクトップアプリとして利用できます | Orkasはチームを調整し,Commanderは多くの専門家や他の CLI 代理人を指揮し,Hermes-Agentがそれらのうちの1つとして介入する. |

**Orkasなら** スタッフではなく スタッフを雇い 数日間動いている作業と 自分のデータ,鍵,エージェントを

**じゃなくて** 単一の汎用チャットボットや 純粋なコードライブラリを 自分のアプリに組み込むだけです

**プログラミング代理人を選ぶか?** [Codex対OpenCode](https://orkas.ai/compare/codex-vs-opencode/?source=gh-orkas) · [Claude Code vs Codex vs OpenCode](https://orkas.ai/compare/claude-code-vs-codex-vs-opencode/?source=gh-orkas) · [Claude Codeの代替品](https://orkas.ai/compare/claude-code-alternatives/?source=gh-orkas)

**完全な横対面比較 →** [クロード・コード vs](https://orkas.ai/compare/orkas-vs-claude-code?source=gh-orkas) · [Codex](https://orkas.ai/compare/orkas-vs-codex?source=gh-orkas) · [クライン vs カーネ](https://orkas.ai/compare/orkas-vs-cline?source=gh-orkas) · [ラングチェイン](https://orkas.ai/compare/orkas-vs-langchain?source=gh-orkas) · [チェットGPT](https://orkas.ai/compare/orkas-vs-chatgpt?source=gh-orkas) · [OpenClawと対照](https://orkas.ai/compare/orkas-vs-openclaw?source=gh-orkas) · [エルメス・エージェント vs.](https://orkas.ai/compare/orkas-vs-hermes-agent?source=gh-orkas)

---

## 早くスタート

代わりにパッケージのインストーラーが欲しいですか?[ダウンロード](#ダウンロード)ソースから実行するには,現在 Linux で Orkas を実行する方法:

**要求**:ノード 22.12+ · macOS / Windows 10+ / glibc 2.34+ Linux x64 または arm64. Python 3 と C/C++ のビルドツールチェーンを珍しいネイティブモジュールソースビルドバックのために利用可能にしておく.

```bash
git clone https://github.com/Orkas-AI/Orkas.git
cd Orkas
./run.sh           # macOS / Linux
run.cmd            # Windows
```

Linux のソース実行には glibc 2.34+ が必要です.アルペン版および他のmuslベースのディストリビューションはサポートされていません.ローカルスピーチトランスクリプションがダウンロードされ,最初のソース起動時にターゲットネイティブの whisper.cpp 実行時間と多言語モデルを検証します.

`run.sh` / `run.cmd`起動時にロックされたnpm依存度木をインストールし,ピースン,UV,ノード,インベディングモデル (~95MB),OfficeCLI,FFmpeg,whisper.cpp,および多言語スピーチモデルリソースを初打ちに準備します.Linuxのスタートアップは,アプリケーションを開く前に,ElectronのABIの下でのプラットフォームネイティブモジュールとWhisper実行時間を検証します.OCRとスキル特有のPythonパッケージは,これらの機能が最初に使用されたときに孤立した地元の環境にインストールされます.初打ちは,作業空間を作成します`~/.orkas/`(macOS / Linux) または`<smallest non-system drive>:\.orkas\`(ウィンドウズ) オープン**設定 → AI プロバイダー** API keyまたはOAuthを追加する

ネイティブ依存性エラー: Node.js 24 LTS (最小 22.12.0) を使用して実行する
`npm run native:repair`選択式パッケージを復元します
ElectronのためのSQLiteを修復し,孤立した画像処理のためにバンドルノードを準備する
テストは SQL,SQL,SQLとSquareを成功する前に
使用`npm run native:check`設置なしのチェックについて
参照[ネイティブ依存性検証スクリプト](./scripts/verify-native-dependencies.cjs)実施された検査について

---

## 機能する仕組み

### 任務のルーティング

Commanderは一般作業を自分で担当し,専門家の作業を3つのツールで委任する.

- **`dispatch_to`** — 実行するエージェントを指定し,その結果を継続的な作業のために返します. 結果を待つことができます.または無同期で実行して,任務が完了するとCommanderに通知します.
- **`hand_off_to`** — 代理人は自発的な返事を提供し,オプションの継続により,Commanderはより広範な任務を再開することができます.
- **`run_worker`** — 匿名で孤立したサブタスクを実行し,プライベートの結果を返します. 会話履歴や名前のエージェントのスキルを受信しません.

代理人名と匿名労働者は,別々の同時制御をします.[派遣実施](./src/main/features/group_chat/bus.ts)及び[実行ロック](./src/main/util/locks.ts).

### 文脈管理

実行時間の予算は,選択されたモデルの可用入力容量,提示,ツールおよび持続的な実行時間の状態を考慮するコンテキストです.完了ディオログは,制限された最近の歴史ウィンドウを使用します.長時間アクティブタスクは,以前のプロセスメッセージを凝縮するためにチェックポイントを使用して,最近の作業を維持します.ファイル読み込み,ファイル変更,コマンド実行はまた,コンテキスト圧縮を生き残る構造化されたレコードを持っています.

見て[文脈予算](./src/core-agent/src/agent/context-budget.ts), [セッションの歴史とチェックポイント](./src/core-agent/src/agent/session.ts)及び[作業場記録](./src/core-agent/src/agent/workspace-state.ts).

### 記憶 と 図書館

耐用メモは,ユーザーの好みやプロジェクト情報,各エージェントの再利用可能な知識を別々の範囲に保存します.これらのメモは,図書館の文書インデックスと保存された会話史とは異なります.

図書室は文書を段落に抽出し,地元の SQLite ベクトルインデックスを保存します.その埋め込みモデルはコンピュータ上で実行されます.`library`ツールでは,ファイルをリストし,関連する段落を探し,グローバルまたは現在のプロジェクトライブラリからソースコンテンツを読み取ることができます.`chat_history`.

見て[範囲内メモリ](./src/main/features/memory.ts), [文書の抽出](./src/main/util/file_to_chunks.ts), [図書館の道具](./src/main/model/core-agent/kb-tools.ts)及び[会話の復元](./src/main/model/core-agent/chat-history-tools.ts).

### 執行制限と回収

セッションロックと同時作業制限は,並行作業を結びつける.ツールラウンド予算,進捗チェックポイント,繰り返し通話チェック,段階意識の無動監視犬は,作業を停止または繰り返す実行を抑制するのに役立ちます.指定されたエージェントタスクは個別に追跡しキャンセルできます.承認されたまたはキューされたタスクは完了した結果として扱われません.

見て[俳優の予算](./src/main/features/group_chat/actor-budgets.ts)年間[代理の実行時間](./src/core-agent/src/agent/runner.ts)及び[デスクトップモデルアダプター](./src/main/model/core-agent/client.ts).

### 活動から学ぶ

背景レビューは,アプリが無効で,冷却および実行制限の対象となる新しいエージェント活動の調査です.`COMPETENCE.md`),再利用可能な方法 (`LEARNING_STRATEGIES.md`) または学習された技能. レビューは,課題の数よりも新しい活動に依存し,省く価値がないと結論づけることができます.

参照[反映スケジュラー](./src/main/features/reflection-orchestrator.ts)及び[レビュー速報](./src/core-agent/src/evolution/metacognition.ts).

---

## 常識

**Orkasって?**
Orkas はオープンソースの (MIT) 局所初のマルチエージェントデスクトップアプリです.そのコマンドは,完成したファイルを提供するために目標をタダに変換し,16個の内蔵専門エージェントを調整します.

**API keyが必要か?**
パッケージアプリは,Orkasモデルに内蔵された500 credits付与されています.その後,クレジットを購入し,有料プランを選択するか,独自のプロバイダーキーを追加してください.プロバイダー料金は別途です.

**Orkas大学は地元のLLMですか?**
Orkasはあなたのマシンで実行され,あなたが選択したモデルに Orkasの組み込みモデル,あなたの独自のAPI key,またはローカルモデルのエンドポイントを呼びます.それはエージェントとツールをオーケストラします.それ自体はモデルではありません.

**Orkasも私の書類から 引用文で答えられるか?**
Orkasは本棚に PDF ファイルや文書を追加し,引用で答えることができます.

**オルマやLMスタジオのような ローカルモデルを使ってもいいですか?**
オープン**アカウント設定 → モデル → チャット → モデルを追加 → カスタム**,選択する** OpenAI対応**及び** ヒトロピック・互換性**作業のモデル制御から保存されたモデルを選択します.

**API keyとデータはどこに保管されているか?**
デバイスのプロダクトは,プロダクトのプロダクトを表示する. デバイスのプロパクトは,プロパクトのプロパクトに設定されています. デバイスの プロパクトは,インストールされている.[安全とデータ処理](https://orkas.ai/security/?source=gh-orkas)

**Orkasもオフラインで動いているのか?**
ソースビルドは,ローカルモデルエンドポイントに対して完全にオフラインで実行できます.パッケージ化されたアプリはログインする必要があります.クラウドモデルはネットワーク接続が必要です.

**パソコンがオフになった時も 動作し続けますか?**
Orkasはコンピュータで実行されるので,自動進行と自動化にはコンピューターが覚醒し,Orkasも動作する必要があります.v1.9から,各自動化がコンピュータが目覚めたかOrkasも起動したときの12 hours以内に最新の失われた実行を追いつく.

**アプリを作って公開できますか?**
Orkas内でのローカルアプリは無料です.公開リンクへのウェブアプリを公開するには,付費プランが必要です (Lite 5, Pro 8, Max 15 アプリ),そして公開されたウェブアプリには,Orkas内にあるすべての機能が含まれていません.

**Orkas口座が必要か?**
パッケージ化されたデスクトップアプリは,最初に起動するとサインインするよう要求します.このリポジトリに組み込まれたソースにはアカウントレイヤがありません.

**OrkasがClaude Codeと他の情報捜査官を 運転できるのか?**
Orkasは5つの外部 CLI エージェントをローカルサブプロセスとして操作できます コードエージェント クロード・コード,コдексとオਪਨコード,個人エージェント オਪਨクラウとハーメス・エージェント そしてハイパーフレームのようなオープンソースプロジェクトに組み込まれています

**Orkas は Claude Code / Codex / クルー・AI / ラングチェイン と どんな違いがあるのでしょうか?**
Claude CodeとCodexはコーディングエージェントです. Orkasはチームメンバーとして両方を実行します. そのため,どちらかを選ぶ必要はありません. クルーAIとラングチェインはコードファーストフレームワークです. Orkasはオープンソースのデスクトップアプリで,コマンドーは専門エージェントとあなたのCLIエージェントを,どのモデルプロバイダーとも連携し,データと鍵をローカルに保持します.[完全な比較](https://orkas.ai/compare/?source=gh-orkas).

**Orkasにはどのプラットフォームがサポートされているか?**
macOS 12+ (Apple Silicon, Intel) と Windows 10+ にはパッケージインストールが用意されている. glibc 2.34+ Linux x64/arm64 は今日もソースから実行されており,インストールはまだありません.Linuxでは最初の起動時に準備されたピンされた whisper.cpp 実行時間を通じてローカルスピーチトランスクリプトがサポートされています.Alpine および他のmuslベースのディストリビューションはサポートされていません.ソースブートストラップには Node 22.12+ が必要です. Python 3 と C / C++ ビルドチャインのツールが必要なのは,ネイティブ npm パッケージに先構築バイナリがない場合のみで,本地的に再構築する必要があります.

**Orkasにはオープンソースが無料ですか?**
プログラムには,MITのライセンスがあり,使用無料です.パッケージ化されたアプリには,Orkasモデルに500 creditsが含まれています.付費プランは19.99ドル/月から月額クレジットを追加,クラウドシンクロ化,より多くの共有プロジェクトおよびアプリケーション公開.独自のキーで,モデルの利用料はプロバイダーによって請求されます.Orkasはマークアップを追加しません.[価格設定](https://orkas.ai/pricing/?source=gh-orkas)

---

## ライセンス

[MIT](./LICENSE)
