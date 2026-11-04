# 搜索索引与启动回归 Case

## 自动化覆盖

`test/e2e/library_e2e_search.spec.ts` 已用真实 Chat、Agent、Skill 和 Library 数据覆盖全局搜索、逐类筛选、键盘导航、空结果、全局/项目资料正文命中、图片视觉描述命中，以及结果到会话/资料/详情页的跳转。该 E2E 会先建立并信任一个不含新消息的 chat 索引，再通过真实 UI 发送消息，防止“首次搜索碰巧全量修复”掩盖增量接线断开；项目正文 case 则从非项目页面搜索一个只存在于正文的标记，防止文件名匹配掩盖向量索引或跨项目接线断开。`test/main/features/group_chat/bus-integration.test.ts` 进一步从真实消息落盘入口验证用户与 Commander 消息无需修复扫描即可搜索；`test/main/features/search/*.test.ts`、`test/main/features/chats.test.ts` 和 `test/renderer/global-search-navigation.test.ts` 覆盖确定性完成边界、崩溃恢复消息、分词、CJK 噪声抑制、正文与文件名去重、项目/账号隔离、缺失向量库只读降级、真实 SQLite 损坏后的局部降级、索引损坏/旧版本自愈、删除清理、机器目录排除、查询 I/O 上限、搜索历史按账号隔离、清空查询后丢弃慢返回结果，以及深历史消息精确定位。`test/main/features/kb_indexer.test.ts` 覆盖 Markdown、PDF、DOCX、XLSX、PPTX 和图片进入可检索 chunk 的格式矩阵。

真实向量质量由 `npm run benchmark:kb-retrieval -- --no-save` 验证：使用随包 `bge-small-zh-v1.5`、sqlite-vec 和合成多语言语料，分别统计语义检索 Recall@3/MRR、交互式关键词命中率，以及无关查询拒绝率。超大真实索引、跨设备同步和不同桌面平台仍按本文人工回归。

### Resource search: Automations, To-dos and Connectors

The following cases extend the same global-search entry, rather than the
connector page's own filter or a model's web-search tools. Run the owning
deterministic selection with:

```sh
npm test -- test/main/features/search/index.test.ts test/renderer/global-search-navigation.test.ts
npm run test:e2e -- test/e2e/search_e2e_rebuild.spec.ts -g 'searches automations|finds connector cards|expands connector results'
```

| User journey / state | Required observable outcome | Owning case / independent signal |
| --- | --- | --- |
| Find personal and project work, including disabled automation and completed to-dos | All includes both resource kinds with project context; each category contains only its own hits; entering a project narrows Library only | Main `finds personal and project automations…`, renderer `expands … hits…`; real project/task creation and returned ids/status |
| Rename or remove existing work | The next query loses old matches and finds renamed work; search leaves a disabled automation disabled | Main task lifecycle and `reflects custom connector renames…`; real mutation APIs followed by fresh queries |
| Search an unconnected built-in connector or compatibility alias | Name and localized description are searchable; Lark resolves to the visible Feishu card without a duplicate hidden card | Main `finds localized catalog descriptions…`; E2E `finds connector cards…` reveals the actual card |
| Query another account while one remains active | Custom names remain account-private; catalog descriptions follow the requested account locale without changing the active language | Main populated two-account privacy and locale cases; E2E restart/account-switch case |
| Find a private custom connector | Only its display name is searchable. URL, headers, grants, account labels and tool schemas neither match nor appear in result fields; search leaves the registry unchanged | Main `searches only custom display names…` uses a separate sentinel per excluded field, a result-field whitelist, and before/after registry state |
| Search larger catalogs or work lists | Requests for 1, 30 and 31 return the requested number; 201 matching custom connectors still respect the 200-result ceiling; All preserves category diversity around its seven-kind boundary | Main `honors … result limits…` and `reserves space…`; distinct resource ids and observable result counts |
| Type CJK, quotes, regex punctuation, mixed case or surrounding whitespace | Queries remain literal, case-insensitive substring matches; a regex look-alike does not broaden the result set | Main parameterized resource-limit cases; independently authored names and nonmatching counterexample |
| Browse more than ten hits, then enter an empty category | All previews ten hits and offers View more; the category shows all eleven. Enter on an empty category or cleared query cannot activate a hidden previous hit; returning to the category restores usable hits | Renderer category-browsing cases, plus E2E `expands connector results…` through real buttons and keyboard |
| Commit an IME candidate before selecting a result | Both composition signals leave search open and prevent navigation; normal Enter submits the current query without opening any result | Renderer category-browsing cases use both `isComposing` and legacy key code 229, then normal Enter |
| Display long or HTML-like custom names | Titles stay readable with ellipsis and full hover text; HTML-like names remain text, create no executable elements, and survive restart | E2E connector layout and expansion cases inspect rendered text, attributes, absence of injected elements, and a real Electron relaunch |
| Activate a result | Mouse and keyboard reveal/highlight the owning automation, project to-do or connector card. Connector activation never starts OAuth/custom authorization | E2E automation/to-do and connector navigation; authorization handlers are prohibited and counted in the connector fixture |

### Resource search UI and platform regression

1. Populate All with automation, to-do and connector hits sharing a query. Check
   the three section labels and row badges, project attribution, and distinct
   category tabs. Tabs start with All, then follow the sidebar: Tasks, To-do,
   Automation, Agents, Skills, Connectors, Library. All result groups and
   keyboard selection follow that same category order, omitting empty groups.
   Switch to each category, then to an empty one and back; no
   prior hidden result may remain actionable.
2. At 1280×800 Chinese, 900×640 English, and 620×520 German/Arabic, check that
   all eight tabs remain on one horizontally scrollable row, with no vertical
   tab scrollbar or modal/result-row horizontal overflow. The selected tab
   must be visible and expose `aria-selected=true`. Inspect RTL ordering and
   long-title/source-label readability in retained screenshots, not only DOM
   presence. The connector E2E automates these layouts.
3. Search must not start an automation, complete a to-do, connect a server or
   request provider authorization. The isolated suites need no model, provider
   account or live connector connection.
4. Repeat the navigation/layout smoke on macOS and Windows release candidates,
   including native keyboard focus and hover titles. An Electron run on one OS
   does not certify the other OS or a packaged release.
### Interactive search latency and recovery

`test/main/features/search/resource-cost.test.ts` protects source I/O and the
inference boundary; `test/main/util/file-snapshot.test.ts` protects bounded
retention, shared reads, failures and concurrent source replacement. A cached
projection must be revalidated against file identity, size, mtime and ctime on
every use. Keep same-size rewrites with a restored mtime, deletion, account
isolation and rename cases; a TTL-only cache would return stale matches.

1. With no global or selected-project vector store, search must not start an
   embedding worker or create derived Library state. With an index, default
   feature/IPC callers still receive the complete search result; the desktop's
   explicit metadata preview skips inference and chat JSONL/snippet reads. It
   returns ranked chat identities/positions immediately and independently
   signals pending Library bodies and chat snippets. Visibility-filtered
   history callers still read source rows even if snippets were disabled.
   A live index write must not hold the preview: return committed matches as
   incomplete and request enrichment even when the new term has no hits yet.
   The ordinary follow-up still settles writes before reporting fresh history;
   the desktop stream keeps chats pending and publishes one more preview once
   the writes queued before that submit settle, so a just-sent message cannot
   settle as no results.
2. Typing only edits the draft; Enter starts a cancellable `search.global` IPC
   stream. IME candidate confirmation never submits or opens a result. The
   localized hint stays inline between the input and close button and always describes search submission.
   Enter submits even an unchanged query; clicking a result opens its source.
   Re-submission cancels the previous search and ignores its late responses.
   Each module publishes when ready, without waiting for slow task sources
   or another module's enrichment. Pending/failed status applies only to All or
   the affected category. Library bodies start independently after metadata retrieval. Chat metadata
   retains the complete candidate list; only viewport rows (plus a small margin,
   at most 20 per batch) request summaries. Scrolling loads additional rows
   without rerunning other modules. Clear, close or
   a newer input cancels the old stream; late snapshots cannot repaint newer
   results or report stale errors. Invoke/history callers retain complete results.
   Stream snapshots retain the existing 200-result ceiling, diversity quotas and
   sidebar order. Chat summaries publish at most ten intermediate snapshots
   per batch, so a slow source does not hold completed summaries. Every publication revalidates conversation deletion eligibility.
3. Completing body search must preserve the selected resource by identity,
   input focus and result scroll position. A failed follow-up keeps usable
   local hits, shows recoverable failure feedback, and records one partial
   terminal outcome. A fresh query clears that state. The renderer navigation
   suite exercises rejection, transport failure, retry and response reordering.
   When chat enrichment adds message ids, retain selection by the existing
   conversation/message position, including position zero and inserted hits.
   A page that lands between pressing and releasing a result must not lose that
   click: paints wait for the release (at most 2s). A page that only fills
   summaries or status updates the existing rows, and editing a draft with
   nothing in flight paints nothing. The E2E case `opens the pressed result`
   drives real mouse input, and the renderer suite compares in-place paints with
   a fresh render of the same state.
4. Run `npm run test:e2e -- test/e2e/search_e2e_rebuild.spec.ts -g 'paints local hits'`.
   This real Electron/IPC case seeds an actual vector store and holds the
   inference response. It must show local task/connector hits before that
   response is released, then add the document-body hit without changing the
   selected connector or focus. Inspect the pending/complete screenshots,
   `performance.json` and complete attributed log analysis. This is retrieval
   wiring evidence using a controlled inference boundary, not model-quality
   or native-ONNX inference-speed evidence.
5. At representative sizes, measure cold and repeated input-to-paint latency,
   query CPU, main-loop delay, file reads/stats and result correctness. Include
   a frequent term in a large chat history: score ranking must precede bounded
   metadata hydration; filters must continue beyond skipped high-ranked rows.
   The cost case uses 2500 matches for five visible hits and a lower-ranked
   eligible conversation to reject both unbounded hydration and premature cuts.
6. Compare identical synthetic data and query sequences on the same host/runtime
   before/after, run benchmarks separately from heavy regression jobs, and retain
   fixture sizes, revisions and raw timing samples. Distinguish debounce,
   first usable results, final semantic completion and controlled delays. Do not
   turn one host's milliseconds into a universal pass threshold. Use the normal
   test runner for regression; preserve failing/overloaded attempts separately.
7. Run the same Electron spec with `-g 'shows cold chat matches'`. With 200 real
   indexed chat messages and a matching to-do, hold the snippet worker's actual
   source request. All must paint ten chat previews and the to-do within the
   shared first-request latency budget; Tasks expands the 199 chat hits kept
   under the overall 200-result quota. Release source reads and verify first-row
   summaries, then scroll to the last row and verify its summary. Offscreen
   summaries must not all load eagerly. Preserve all 199 candidates, input
   focus and loading-state completion. Inspect both screenshots and the saved
   first-paint measurement. This catches cold source parsing that warm-cache
   tests or an empty chat corpus would miss.
8. Slow completed queries (at least 500ms) record fixed, overlapping stage wall
   times in the local log, at most once per minute. Review preview versus full
   retrieval, chat, Library, task and catalog timings. Never log query text,
   account/resource identities, paths or source snippets. The cost suite checks
   attribution, privacy and suppression separately from host timing measurements.
   Progressive retrieval includes per-module metadata/total time and independent
   chat-snippet/Library-body time; `search-progress.test.ts` also rejects missing
   enrichment attribution and repeated failure diagnostics.

9. Automation and to-do retrieval overlap; project to-do snapshots use at most
   four concurrent reads through their canonical resolver. `resource-cost.test.ts`
   holds automation storage and asserts multiple independent scopes have started,
   a four-scope peak, exact ids/counts and unchanged final search limits.
10. Independent chat files use a lazy two-worker snippet pool with bounded source
    affinity and four in-flight requests. Each worker retains serialized parsing
    and bounded projection/offset caches. `chat-snippet-failure.test.ts` holds or
    fails one source and completes another; shared-source failure cooldown,
    shutdown, cache invalidation and source isolation remain covered. Active
    cancellation settles immediately and stops an unused worker; cancellation
    of one shared consumer retains the other consumer. The cold
    mixed-history measurement in `chat-snippets.test.ts` records small-source and
    total completion, CPU and RSS; parallelism trades extra resources for latency.
    Run measurements separately from heavy regression jobs and disclose samples.
11. `search-progress.test.ts` covers module independence, independent chat/Library
    completion, cancellation before deferred work, a failed module retaining
    healthy results, bounded snapshots, and deletion while other work is pending.
    The renderer navigation cases cover partial status, stale delivery and retained
    selection. The Electron `publishes independent modules` case holds actual
    automation-file reads and the inference boundary: to-do and connector hits,
    then enriched chat rows, must remain usable before those gates are released;
    release each gate and verify final rows, input focus and loading completion.

## Startup and one-time chat migration

1. With several historical accounts, restart while signed into one: only the active account is scanned. Machine directories must never become pseudo-accounts.
2. A completed SQLite source stamp is reused at startup without parsing the retired JSON snapshot or statting every historical JSONL. Missing indexes are built in the existing idle disk slot, with at most 32 concurrent source-file stats.
3. Start with an old `chats.idx.json` and no database. Interrupt during a large conversation, restart, and verify the committed prefix resumes without duplication. Preserve the old JSON and `.tmp` until history and concurrent changes have been indexed successfully.
4. Append messages while migration is paused. Message persistence, display and cloud sync continue; indexing is deferred to catch-up. Search returns promptly with partial coverage, and new messages become searchable after catch-up. After completion, ordinary appends are indexed incrementally again.
5. An aborted startup slice must resume automatically when the runtime is idle. A failed batch must retain old files and retry; neither cancellation nor failure may publish a completed index.
6. Replace or delete conversations through sync during migration, including replacement after a source read and before its last batch settles. Completion must wait for a stable source; replaced/deleted text must not survive catch-up.

`test/main/features/search/migration.test.ts` owns these migration, interruption, restart, concurrent-append and sync-race scenarios using isolated temporary workspaces and real SQLite. `search/search_e2e_rebuild.test.ts` adds real-worker SQL failure/recovery, concurrent-writer exclusion, and a 9-million-character performance negative control. Rebuild work must run outside main; during that workload the main timer gap stays below 300 ms and existing-hit query P95 below 200 ms. Full execution-record content, including its final term, remains indexed; private reasoning stays excluded.

## Query recovery

1. A cold, corrupt, old-schema or stale chat index schedules background repair. Search must not synchronously rebuild history; return available results with `chat_index_complete: false`, then complete results on a later query after repair.
2. Once trusted, real user, Commander and Agent appends must be immediately searchable without a full repair, including crash-recovery records. Unchanged queries must not stat every historical JSONL.
3. Sync invalidation schedules local repair even without a subsequent search. Search remains incomplete until repair completes. The cloud protocol and dependencies are unchanged; derived search data remains local-only.
4. Deleting/cleaning a conversation removes its results immediately from both
   the metadata preview and full snippet reply, including a reply already in
   flight. Authoritative conversation tombstones take precedence over committed
   SQLite postings and late source-file arrivals. Filter before the result quota
   so deleted high-ranked hits cannot hide lower-ranked live history. Check
   missing source files as well; valid uncatalogued legacy files remain searchable.
   Rebuild/restart must not reindex tombstoned root or project files; an explicit
   recycle restore makes the conversation searchable again. The `keeps cleaned
   conversations` Electron case uses the real cleanup IPC, stale committed SQLite
   rows, All/Tasks UI and restart. Its late payload collides with one archived
   file on restore: assert one skipped file, zero failures and successful
   reactivation; retain and review the expected recycle warning. Also reproduce
   the May 23 legacy case: a missing project.json, surviving project chat index,
   and its transcripts left in the global root. Neither preview, full response,
   startup nor rebuild may expose those as new global conversations. The v3
   source stamp revalidates pre-fix snapshots once in the existing background
   path; unchanged live histories keep their file watermarks. A current
   valid owner wins over stale ownership from a moved conversation; a recovered
   project becomes searchable again. Ownership lookup failure reports partial
   coverage and preserves healthy results. The `excludes May 23` Electron case
   checks real SQLite, All/Tasks, restart and post-rebuild persisted documents.
   Project results retain their title, project name and snippet. Explicit-user queries must never
   fall back to another account's Library index.
5. Opening global search queues the repair of an unverified index; no typed query is needed. The preparation notice appears only while the account's chat index has never completed a build (first build, migration, or rebuild after a reset), as soon as the lightweight coverage response reports `chat_index_building`, without waiting for all-scope search. The Chinese copy is “正在准备中，结果暂不完整，请稍后重试。”. An index built once and only waiting for catch-up (after a restart, crash or sync) shows no notice, while `chat_index_complete` still reports verified coverage to history tools. Partial hits remain usable; completed searches remove the notice and non-chat tabs omit it. Closed/superseded requests and late status responses cannot overwrite newer results. No automatic polling is added.

`test/e2e/search_e2e_rebuild.spec.ts` verifies the real renderer/shim/IPC notice and partial results, then relaunches Electron and waits for startup to resume the committed prefix without a manual repair call, and finally checks that a built index waiting for catch-up behind busy agent work stays unannounced. Its ASAR case exercises the shipped worker/dependency layout and native SQLite loader. Run it on each release platform; a macOS pass is not a Windows execution claim.

## 删除来源与恢复回归

搜索屏蔽残留只是防线，删除成功必须同时满足源文件、目录、目录记录和本地删除记录的生命周期约束。

| 场景 | 独立验收信号 | 自动化归属 |
| --- | --- | --- |
| 单任务删除、历史清理、删除项目；正文仅在旧全局目录或新旧两套目录并存 | 两套正文、meta/state、附件、产物、会话、context 和保留输出均消失；其他任务字节不变；旧全局索引没有有效重复行 | `conversation-delete-recycle.test.ts` 的三入口矩阵及 pre-v4 全局目录记录用例 |
| 删除前备份和删除后恢复 | 每个删除文件均有回收站副本；恢复无失败，内容字节相同，逻辑项目关系和实际 history 可读取；恢复版本高于全局保留的删除记录 | 同一 IPC 矩阵、`recycle_bin.test.ts`、`project-delete-recovery.test.ts` |
| 正文物理删除失败 | 返回失败并保留可重试的删除状态；解除故障重试后源文件消失 | `chats.test.ts` 的持久权限故障用例，真实文件系统加窄范围故障注入 |
| 实际搜索 UI 与应用重启 | 通过真实项目删除 IPC 清除 legacy-only 和 duplicated 两种任务；“全部/任务”仅显示保留任务；源路径在重启后仍不存在；回收站恢复后重新可搜 | `search_e2e_rebuild.spec.ts` 的 `deletes legacy project payloads`，真实 Electron、SQLite、截图及 main 日志 |

以上用例全部使用隔离临时工作区和合成内容，不对真实账号历史执行删除或恢复。历史遗留的“项目已缺失、正文仍存在”继续由可检索资格校验隔离；不能凭缺少项目元数据直接物理清空用户文件。

## 资料正文与项目范围

1. 文件名不含查询词、但已完成向量处理的全局资料应通过正文片段命中；点击后打开原文件。
2. 从首页搜索时，应覆盖所有已有向量索引的项目资料；结果显示所属项目，点击后进入该项目并打开原文件。
3. 从项目页或项目会话搜索时，只查询全局资料和当前项目资料，不得混入其他项目。
4. 同一文件同时命中文件名和正文时只显示一条；文件名精确命中保持优先，正文命中按相关度排序并过滤低相关“最近结果”。
5. 尚未建立向量库的账号或项目只返回文件名结果，查询本身不得创建空 `vector.db`、触发全项目 hash/reconcile 或显示错误。
6. 单类请求的 `limit` 大于 30 时应按请求返回；“全部”范围需为任务、智能体、技能、资料、自动化、待办和连接器预留结果窗口，单一大类不得挤掉其他类别；总返回量仍不得超过请求上限。
7. 同一规范化查询在全局和多个项目索引间只生成一次 embedding；重复查询复用有界缓存。
8. 全局索引或单个项目索引损坏/不可用时，其他健康范围和文件名结果仍应返回；embedding 不可用时只降级正文搜索。
9. 相同相对路径出现在不同项目时必须保留为不同结果；同一文件多个 chunk 仅保留分数最高的一条。
10. 中等向量分数必须同时具备有意义的正文/标题/路径词面锚点，高置信语义结果可无字面重合；真实模型负样本不得显示“仅仅最近”的资料。
11. 至少 120 个项目、240 个候选命中时仍只生成一次 embedding，并严格截断到请求的 200 条结果。
12. 已删除项目文件留下的陈旧命中无法解析绝对路径时不得打开错误的查看器或抛出未处理异常。

## 全局搜索弹窗

1. 打开 Cmd/Ctrl+K 全局搜索后点击遮罩空白处，弹窗不应关闭；右上角关闭、Esc 和再次按 Cmd/Ctrl+K 仍应关闭。
2. 输入查询后立即清空，即使旧请求随后才返回，也应保持空状态；方向键和 Enter 不得继续操作上一次的隐藏结果。
3. 搜索历史按本地账号隔离。账号 A 的查询不得出现在账号 B；旧版共享历史最多迁移给首次打开搜索的账号一次。
4. 每次通过快捷键打开后，搜索框必须取得焦点再接收输入；E2E 必须显式验证焦点接管，避免自动化输入与弹窗的延迟聚焦竞态后误写入聊天框。
5. 刚进入会话就按 Cmd/Ctrl+K：会话输入框的默认聚焦（进入会话与刷新发送区各有一次）延迟到达时不得把焦点抢回聊天框。E2E 必须等过该延迟窗口后复查焦点，否则键入会落进聊天框。
6. 未输入关键词时，有搜索历史和无搜索历史两种状态的弹窗高度必须一致；历史记录超过可用空间时只滚动内容区，不得撑高弹窗。
7. 资料正文结果按相关度排序；快速连续输入或清空时，旧 embedding 查询返回不得覆盖更新后的结果或空状态。
