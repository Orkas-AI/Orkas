# DeepResearcher 智能体人工回归 Case

## 范围边界

本文件覆盖内置 **DeepResearcher** 智能体（agent id `78900d8758bc`，分类 data）的端到端表现：范围 → 持久计划 → 结构化取证 → 脚本压缩 → claim 核验 → 可审计交付，以及底层 4 个确定性引擎脚本组成的共享 skill（id `ee99fbb42964`，name `deep-research`）——`caps`（子问题封顶 + 每问抓取预算 + depth 守卫 + caller-reported step 成本判停）、`academic`（并发 arXiv/OpenAlex/Crossref/Semantic Scholar/PubMed 学术检索）、`compress`（多语分块/去重/词面相关性排序/硬预算）、`citations`（来源/原句/DOI + 引用绑定 + 编号参考文献）。重点验证**差异化护栏**：禁造 quote/DOI、真实但无关的 quote 不得支撑 claim、中文压缩不越预算、幽灵源标记、无来源时 abstain、按结论置信度与矛盾如实交代。

不在本文件重复验证：智能体库通用展示/筛选/同步（见 `agents-regression.md`）、计划拆分与步骤分发的通用编排（见 `agent-orchestration-regression.md`）、连接器授权（见 `connectors-regression.md`）。引擎 skill 的纯逻辑与四件互通由 `PC/resources/builtin/marketplace/skills/ee99fbb42964/test/`（`pytest`，含 `test_pipeline.py` 确定性端到端）覆盖，本文件不重复其单测断言。

## 自动化覆盖

## Shared research and social-analysis scenarios

### SocialResearcher consolidation and investigation boundary

The requester confirmed merging SocialResearcher into DeepResearcher and keeping
DeepResearcher focused on investigation, not every search. Version 1.0.67
advertises evidence synthesis and sample analysis in both selection descriptions;
ordinary fact lookup and link finding are explicitly outside the role. Scope is
determined by the requested work and deliverable, not by a keyword matcher or a
minimum number of searches. A focused brand or social brief remains valid research
without requiring a long report.

| Request / evidence state | Intended result | Failure guarded against |
|---|---|---|
| Ordinary fact lookup or finding a link | Shared capability-boundary handback if misdirected to this Agent | Turning every search into a research project |
| Public social reputation investigation | `social-data` primary route, bounded platforms/keywords/period/sample plan, traceable themes and next experiments | Losing the retired Agent's collection boundaries or treating public samples as complete platform coverage |
| Supplied campaign data sufficient for analysis | Validate fields and analyze supported metrics without public collection | Unnecessary fetches, replacing missing denominators with guesses, or forcing deep-report ledgers |
| Platform failure or zero results | Preserve completed scope and disclose gaps; do not expand the frozen scope | Inventing discussion, concluding no discussion exists, or trying unrelated platforms |
| Social findings need brand context | Only a decision-changing brand extension | Unbounded cross-domain research |
| Brand brief or broader/durable investigation | Existing brand chat/file contract or deep-research evidence/resume/report route respectively | Replacing established research paths with a social template |

### Revenue and cost inputs

| Input / scenario | Independent expected result |
|---|---|
| Spend 100, revenue 1,000, matching non-marketing costs 600 | ROAS 10; ROI 300%, with its cost basis |
| Revenue 0 versus missing revenue | With explicit zero other costs: ROI -100%; missing revenue: return unavailable |
| Revenue known, matching costs unavailable | ROAS computable; profit ROI unavailable |
| Spend missing or zero | Return ratios unavailable; explicit zero spend can still produce zero CPC when clicks are positive |
| Declared conversion value or explicit interaction value | Separate scenario fields and basis; no substitute for observed revenue/profit and no automatic budget-scaling advice |
| Campaign totals plus post amounts | Campaign fields win, including zero/null; only complete post columns are summed when the campaign field is absent |
| Partial counters or invalid input | Preserve independently supported metrics; reject invalid numeric/corpus/JSON input with a structured error, not a partial report or traceback |

### Brand investigation

| Request / evidence state | Intended result | Failure guarded against |
|---|---|---|
| Focused company/product profile or Brand DNA | Bounded requested-field brief via `brand-research`, with frozen source/competitor scope and at most one relevant social extension | Forcing deep-research ledgers and a published long report onto a simple brand request |
| Positioning, audience, competitors, voice, pricing, proof or content gaps | Sourced facts, company statements, third-party evidence and labeled interpretation; requested fields only | Treating marketing claims as independent proof, or filling optional fields from guesses |
| Weak, blocked or missing sources | Disclosed source caveats and missing fields | Declaring no discussion from empty social results, or implying diligence conclusions |
| Broader or complex investigation, literature review, market comparison or durable resume | Existing `deep-research` normal/resume/compact route, budget/state retention, claim checks and canonical report delivery | Replacing existing deep investigations with a shallow brand template or losing saved accounting |
| Focused brief with / without requested file | Existing `brand-research` chat/file output contract | Unsolicited saved brand files, or suppressing the canonical file on a deep-research route |


Production quality evidence identifies attached outputs from persisted host
delivery records and places their contents before working files. Earlier drafts
and verification attempts remain available as execution evidence, explicitly
distinguished from attachments; filenames never establish delivery status.


the separately authorized model canary 对全部已登记研究决策场景分别维护
完整正例和关键词齐全但结论相反的 negative control，确保 deterministic scorer
不仅拒绝空输出，也能拒绝重跑已完成取证、重置预算、丢弃部分成功结果、带着引用
错误交付、无来源编造、把旧来源当最新、给出剂量、越界启动网络研究，以及已知
独立 URL 的 `4+1+1+1` 串行尾巴等行为。
真实模型效果仍由统一 benchmark 运行并按 rubric 独立评审；该契约测试不替代动态
效果比较。

Production Regression 另有 `research-independent-fetch-batch` 执行态 case：用户直接
给出 7 个互不依赖的官方仓库 URL，只要求第一轮抓取。发布门禁要求恰好 7 次
`web_fetch` 在同一并发批次启动、0 次 `web_search`，并在暂停前生成
`fetch_ledger.jsonl`。这种显式 fetch-only checkpoint 以 `caps_plan.json` 为唯一计划，
不调用 `manage_execution_plan`、不发布产物，并在 10 个 tool loop 内暂停；证据提取、
引用核验和报告生成留到用户要求继续后再做。trace 只保留并发宽度，不存 URL 或
原始 call id，主观 judge 也会收到这个脱敏宽度，避免把真实并发误判成未证明。

`research-resume-durable-ledger` 覆盖固定来源断点续研：运行前先对 fixture 声明的
两个官方 URL 做真实可达性预检；预检报告只保留服务序号、HTTP 状态或低基数失败类，
不落 URL、响应正文或 provider 错误文本。进入模型后必须把两个 pending URL 放在同一
并发批次，每个网络尝试无论成功、超时或 provider 失败都立即消耗 `max_new_network_calls`
和对应子问题的一次额度，同轮不得重试。每个成功/失败都追加到 fetch ledger；失败来源
不生成 evidence row，而是在可见交接中标为 `Not verified`。若追加发生 `E_STALE`，只重读
目标 ledger 合并一次，不得重新抓取。生产 contract 同时要求可见交接给出此前 2 + 本轮
2 = 累计 4/4 的尝试账，并直接概括已建立的义务、官方 SME 支持措施及来源/引用，不得只
丢一个报告链接。这样可区分“运行前外部依赖不可用”的基础设施失败和“预检通过后模型
重复调用或隐藏缺口”的行为失败。

生产 oracle 还直接读取两个 JSONL 成品的字节，而不只相信模型 trace：每条追加记录必须
是一行 JSON object 加一个尾随换行，禁止用前导换行制造空记录；解析失败、内部空行、旧
fetch/evidence 记录丢失或 pending 来源未各追加一次都会失败。可见交接必须保留英文算式
`prior 2 + new 2 = cumulative 4/4 attempted network calls`，避免“4 entries”把历史记录数和
网络尝试数混为一谈。

完整交付由 `research-compact-landscape-efficient-delivery` 执行态 case 保护：以“调研
适合普通用户的 AI 桌面应用，比较主要用途、系统支持、安装与上手难度、模型能力、
隐私、本地运行和价格，并根据不同需求给出选择建议”为自然输入，在隔离工作区完成
发现、官方来源抓取、证据核验、`RESEARCH-<topic>.md` 生成和一次发布。独立门禁要求：
仅一次发现搜索；最多两个抓取批次；成功抓取总量 1–8，首批最多 5 个且默认首批后
停止；只有会改变候选资格、系统兼容性、推荐顺序或适用人群的缺口才允许第二批，且
第二批最多 3 个 URL；允许只有一两个合格官方来源时交付明确标注的部分比较；除初始 Skill 加载外不再调用 `read_file`，也不使用 `read_files`
或 `stat_file` 做新任务中的重复检查；报告包含完整十一列对比表、
`Evidence used` 和明确来源/缺口边界，且总长度不超过 10,000 字符；无硬性收敛停止；
总 tool loop 不超过 16。
该 case 刻意允许多个单步 `manage_execution_plan` 调用，只约束用户结果和模型轮次，
避免把可选 `set_statuses` 误变成强制批量协议。其 negative control 会让历史上的
23-loop、重复 ledger/report 检查和串行首批抓取分别触发独立失败信号。

候选数量不是 production-outcome 的硬阈值。若发现搜索只返回一或两个合格官方
来源，Agent 必须先冻结实际发现的集合、在一个响应内抓取全部来源，并将结果标成
有限范围或部分比较；不得返回零抓取，也不得把单个来源当作 bootstrap 后再追加
候选批次。只有搜索返回零个合格官方来源时，才允许 source-unavailable advisory
fallback。静态 prompt contract 同时拒绝旧的“少于三个就不抓取”文案。

2026-08-08 的完整交付实跑从上一正式轮的 54.0 分、433.06 秒、22 loop、
953,596 token、CNY 19.7634，改善到 60.8 分、338.84 秒、13 loop、561,906 token、
CNY 12.1343；压缩从 1 次降为 0，且报告完整并只发布一次。该轮仍为 fail：抓取实际
是 `1 + 4 + 4` 三批，违反最多两批的关键门禁。随后 1.0.44 的“少于三个就零抓取”
在完整 E2E 中过度收敛为零次抓取；1.0.45 已改成冻结并抓取实际发现的一至五个来源，
只有零来源才降级。随后 `1.0.46` / `1.0.20` 又把 compact path 从 GitHub 仓库调研
泛化为普通产品调研：发现不再强制域名，每个候选先抓一个最佳官方主来源，仓库只在
开源许可或项目活跃度确实影响结论时使用，对比表改为安装、模型能力、隐私、本地
运行和价格等普通用户维度。完整记录见
the separately authorized model canary。

随后 `1.0.47` / `1.0.21` 收紧 compact 收敛和证据门禁：第二批最多 3 个且总量
最多 8 个；报告最多 10,000 字符，不得逐候选复述表格；每个事实型表格字段必须通过
`field_claims` 绑定同候选来源的 `claims[].id`。当前脚本只对缺失映射、
跨候选来源和未匹配引文做客观降级；语义错绑由 Agent 核验，具体合同见下文。

该普通用户 case 的最新 GPT-5.5 生产实跑在隔离快照完成：一次搜索、`5 + 5` 两个
并发抓取批次、9 loop、299.79 秒、393,991 token、CNY 8.1195；当时的 deterministic
production acceptance 通过，独立 Terra judge 给 58.8/100，因此总体仍 fail。当前
`1.0.47` 门禁会因第二批宽度为 5、总抓取为 10、报告超过 10,000 字符而拒绝该 trace，
尚未再次调用付费模型。trace
中 7 个 URL 被标为未发现、3 个被拒绝，但当前分类器也会拒绝合法产品官网根地址，
且无法归因从首批抓取页面学到的二级 URL，因此暂不把这些标签升级为该 case 的硬
门禁；第二批虽满足数量门禁但没有做到最小 gap convergence，报告生成的两个模型
调用分别耗时 108.4 和 83.2 秒。

通用计划工具另由 core-agent 单测验证 `set_statuses`：整批先校验、一次 revision
提交，重复/不存在的 step、非法 status 或多个 `in_progress` 均原子失败；原有
`set_status` 继续有效。进展门禁的 problem-discovery case 还验证空文件创建与内容
哈希不变的更新不能伪造进展，而非空内容变更仍可正常重置停滞窗口。

2026-08-08 的 fetch-only checkpoint `gpt-5.5` 实跑结果为 **90.8/100**，全部对应
production acceptance 通过：7 个 fetch 均为并发宽度 7，0 搜索、0 进度计划、0 发布，7 个 tool
loop，耗时 89.84 秒。API 等价端到端成本按官网价与固定汇率 7 为 **CNY 4.5818**。
相较同日第一轮 batching 实现的 260.13 秒、16 loop、CNY 11.4010，分别下降
65.5%、56.3%、59.8%；完整审计见
`Common/docs/evaluation/deep_researcher_agent_evaluation.md`。

## 准备

1. 确认 DeepResearcher agent（`78900d8758bc`）已装入当前账号（dev 经内置 marketplace seeding / dev 安装；正式经 marketplace `default_install`）；共享 skill `ee99fbb42964` 已同步到平台安装目录，`run-skill.cjs deep-research <script>` 能解析到它。
2. 准备一个可研究的开放式问题（如「本地优先 AI agent 的隐私权衡与最新证据」）；如验证材料输入，准备 1–2 份本地文件或链接作为第一手来源。
3. 网络确认：`academic` 需外网访问学术 API；本机若用 fake-ip 代理（Clash/Surge），确认已配 `HTTP_PROXY`/`HTTPS_PROXY`（否则直连解析到 198.18/15，学术检索会失败——属预期，应进 `errors` 而非崩溃）。
4. 记录所用模型与起始时间，便于成本/延迟与失败模式归因。

## frame — 框定与计划封顶（caps.plan）

1. `@DeepResearcher` 给一个研究问题（或填启动表单 `task`），agent 应先复述问题、确认范围/深度/必用来源；材料附件应作为一等来源纳入。
2. 应把问题拆成 3–8 个具体子问题，并调用 `deep-research caps -- --op plan` 去重/裁剪、取得 `fetch_budget_per_subquestion`；重复或超额子问题应被裁掉且在 `dropped` 中如实回报（不静默丢弃）。
3. 递归研究场景下 `depth` 超过上限时，`plan` 返回 `allowed:false / max_depth_exceeded`，agent 应停止下探、用已有材料综合，而非无限展开。

## 取证 — 网络 + 学术（academic），带预算与判停（caps.account）

1. 每个子问题应先 `web_search` 再 `web_fetch` 取回真实正文；来源应记为 `{id,url,title,date,doi?,text}`，**绝不引用未抓取的来源**。
2. 学术/论文类子问题应额外调用 `deep-research academic -- --op search`，并发从 arXiv/OpenAlex/Crossref/Semantic Scholar/PubMed 拉取带 DOI/PMID + 摘要的论文；其 `results` 已是来源形状可直接用，合并顺序不受 provider 返回先后影响。
3. **单源韧性**：某学术源限流（429）/不可用（503）/超时时，应仅记入 `errors` 并继续用其余源返回的结果，不应整体失败或崩溃。
4. 抓取应受 `fetch_budget_per_subquestion` 约束；应周期性以运行中的 `{steps:[...]}` 台账调 `caps -- --op account`，当返回 `stop:true` 时停止取证、用已有材料综合，并如实说明采样了什么。注意 `caps.account` 核算调用方上报事件，不拦截原生网络工具；这是必须遵守的 Agent ceiling，不得把它表述成平台级配额。
5. `academic` 只连固定 https 主机白名单（export.arxiv.org / api.openalex.org / api.crossref.org / api.semanticscholar.org / eutils.ncbi.nlm.nih.gov），并遵循 `HTTP(S)_PROXY`；非白名单主机 / 非 https / 重定向到白名单外应被拒绝，单个响应超过 5 MB 应显式报错而不是静默截断后继续解析。
6. 当一组官方 URL 已知且彼此独立时，模型应在一次 tool-use response 中发出全部
   `web_fetch`，让运行时并发执行；单批最多 8 个。只有后续 URL 或其必要性确实依赖
   前一个结果时才允许另起一轮，不能把已知 sibling URL 退化为逐个模型回合。
7. 首批结果落入证据台账后，应一次审计完整对比矩阵中的决策缺口，把所有已知且
   会改变推荐的官方 URL 合并为第二个、默认也是最后一个批次。第三批只允许由第二
   批新揭示 URL 和必要性的真实依赖；否则标 `Not verified` 并进入核验。
8. 同一活动运行中，刚写入且未被外部修改的 plan/ledger/command input 保留在模型
   工作状态里，不应立即重复读取。仅在任务开始、持久续跑、实际上下文压缩、外部
   修改或精确字节验证时重读。已确定的脚本输入写入与确定性命令可在同一响应按序
   发出；独立的报告片段也应在同一响应写入，最后只读一次成品验证，无需额外 stat。
9. 固定 pending-source 恢复的上限按**尝试**计，不按成功计。已知 sibling URL 必须一批
   并发；一次失败即占用该 URL 和子问题额度，同轮不得以“瞬态错误”为由再试。写 ledger
   遇到 `E_STALE` 只能修复本地追加，不能借机重启网络轮次。

## 压缩 — 长来源去噪（compress）

1. 某子问题抓回的正文很长时，应调 `deep-research compress`（传 `{query:子问题, sources:[...]}`），直接使用 `data.kept`，并确保最终证据不超过 `budget_chars`。该链路不依赖 Agent 专属宿主工具。
2. `kept` 应丢弃与子问题无关的噪声段、去除重复/近重复段，按多语言词面相关性稳定排序，并严格控制在字符预算内。中文 query 应使用 CJK bigram 参与排序，不得因为取不到 ASCII token 而整页绕过预算。总量很小且完整输入已在调用方预算内时才可原样透传。
3. 从压缩后 chunk 中摘取的引文，仍应能在原始来源正文里被 `citations` 核验通过（压缩只归一空白，核验容忍空白差异）。

## Draft, verify, and deliver

1. Preserve exact fetched quotations in narrow claims with `{source, quote, doi?}`.
   Quotes cannot be paraphrased; claims may be paraphrased or translated.
2. Run `deep-research citations -- --op verify`. Missing quotations, unknown
   sources, and malformed or source-mismatched DOIs remain deterministic failures.
   Known sources without adequate quotations are weak; zero sources abstain.
3. Quote matching does not establish claim support. The script emits no
   `supported`, `alignment_status`, or recommendation-readiness verdict. The
   Agent checks every factual part and its negation, conditions, versions, and
   limitations in the existing Verify stage. Add evidence, narrow, or remove
   uncovered parts while preserving supported facts.
   Test both an opposite claim with overlapping words and a correct translation
   with different words: both may match the quotation, neither receives a
   semantic verdict from the script.
4. Comparison cells need explicit claim bindings to quotes from the candidate's
   declared sources. Missing bindings become `Not verified`. README keywords
   and source-adapter field labels cannot automatically populate factual cells.
   Coverage reports fields with and without citations, never recommendation quality.
   Compact Evidence IDs retain ledger IDs when another row fails or is removed;
   report assembly must not redirect an existing analytical citation.
5. For compact delivery, the Agent supplies non-empty `analysis_markdown` with
   choices derived from checked claims and their choice-changing conditions.
   Inferences cite their basis; synthesis must not reintroduce unsupported
   capabilities, privacy guarantees, or comparative superlatives. Report assembly
   preserves this prose unchanged beside the comparison and evidence tables,
   never generates recommendations, and refuses to overwrite an earlier report.
   Missing or malformed analysis must fail before writing either output file.
6. Assess final recommendations with the existing live homepage case and its
   unchanged rubric. Correct attribution alone must not make unsupported advice
   acceptable. Preserve limitations, run status, named gaps, and next steps.
7. Resume handoffs still name the three durable files, prior/new/cumulative
   attempts, established obligations and support measures with official sources.
   The report link does not replace those visible findings and gaps.

The `research-provenance-is-not-support` stage case now uses a supplied desktop
brief with exact matched excerpts: opposite polarity, a faithful Chinese
paraphrase, a partially supported capability list, and local-only privacy
misapplied to remote APIs. The expected deliverable is a corrected brief and a
useful conditional choice. Its four semantic dimensions require 80 each;
keyword checks no longer determine support. It explicitly declares
`acceptanceMode: "semantic-judge"` for protocol-simulation admission; registration
does not imply a passing result, and the existing Judge must pass all dimensions.
This mode cannot replace material evidence for production outcomes.
This revised case is not comparable
to the historical Moon/cancer fixture. The homepage case remains unchanged.

the separately authorized model canary provides a grounded control
and six isolated failures, including summary re-expansion and blanket
abstention. Run its opt-in calibration with `ORKAS_RESEARCH_JUDGE_CALIBRATION=1`
and the existing authenticated Codex judge. Default deterministic tests validate
fixture isolation without calling a model. Calibration proves judge sensitivity,
not Agent completion; the actual stage and homepage runs remain separate.

## Coverage of long and companion sources (2026-10-02)

Failure class: a detailed report whose quotes all verify but which misses
decisive primary evidence. In the GPT-6 Astra case the run lowered its own caps
to 12/5 without a budget, never saw the release page's result tables beyond the
first 12,000 characters, did not fetch a companion report its main paper named,
reported a 25.5x ratio against a model two generations old, and read one of 37
entries of an awesome-list README because README compaction kept only a section
whose title contained "Memory".

1. Ask for a detailed study of a release with a long official page (results
   near the end) and a paper whose introduction names companion reports.
   `caps_input.json` keeps the default fetch caps or carries `caps_reason`;
   lowered caps without one fail `caps --op plan` with the requested and
   default values.
2. A truncated `web_fetch` result reports the shown range, remaining characters,
   detected later headings and the next `offset`. The Agent continues decisive
   primary sources by offset; those ledger rows carry `offset` and stay within
   the reported allowance. Binary or navigation-only results are `no_content`.
3. `citations --op verify` lists `coverage_leads`; the report cites a fetched
   companion report or names it as a gap. A comparative claim without
   `baseline` returns `comparison_baseline_missing`.
4. A GitHub list repository fetched with `maxChars:12000` shows its first
   entries in order, a "kept N of M sections" receipt naming omitted sections,
   and an offset that continues the README.

Deterministic coverage: core-agent `tools.test.ts`, skill `test_caps.py` and
`test_citations.py`, `deep-research-skill-scripts.test.ts` and
`deep-research-evidence.test.ts`. A replay of the original run's citation input
lists the missed companion report among its first `coverage_leads`; the effect
on a live model run is not yet measured.

## 能力边界与转交

1. Ordinary fact lookup, link finding, knowledge-base writes and final Office artifacts remain outside this research role. Social sampling and campaign analysis now belong to its `social-data` route; they no longer require a separate social Agent.
2. Use the shared capability-boundary handback for unsupported work, preserving progress and continuation facts; do not hard-code another Agent's display name or add a transfer protocol.

## 失败模式与降级

1. 学术源全部失败（网络/代理未配/全限流）时，`academic` 应返回 `ok:true` + 空 `results` + 明确 `errors`，agent 应退化为仅用 `web_search`/`web_fetch` 的来源并如实说明，而非崩溃或假造论文。
2. 输入 payload 非法 JSON / 非对象时，各 skill 应输出 `{"ok":false,"error":...}` 到 stderr 并非零退出，不打印半成品。
3. fake-ip 代理未配置导致学术检索失败属预期环境问题（非 bug），应在 `errors` 中体现。
