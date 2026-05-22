# 多设备同步（multi-device-sync）— 方案

> 状态：草稿，按批次确认中。
> 跨项目：PC（Electron 主进程 + renderer）+ Server（FastAPI + COS）。
> 验收后按 CLAUDE.md「Plan first」约定删除本文件。

---

## 0. 决议日志（按批次）

### 批次 1（COS 访问通道） — ✅ 已决议
- **方案 B：STS 直传**。PC 调 `/sync/sts` 拿 1h 临时凭据后直发 COS；manifest commit 与配额计账仍由 Server 端点（保 CAS 原子）。
- **新依赖** `cos-nodejs-sdk-v5` 加入 `PC/package.json` 的 allow-list（要在 PC/CLAUDE.md §1 同步）。
- **marketplace 上传保持 server-proxy**，不迁 STS 直传。Why：dev-only 频次极低、server 居中做 id 分配 + spec 重写、ACL public-read 维度与同步 private 不同，迁移收益负值。

### 批次 8（传输优化与增量同步） — ✅ 已决议
- **单文件 gzip**（BYO encoding 模式）：PC 两端自己加解压；COS 完全不感知压缩、永远不解压；不设 `Content-Encoding` 头（避免 SDK 自动解压）；扩展名白名单 + 明文 > 4 KB 阈值；路径不加 `.gz` 后缀（COS path 与本地一对一镜像）；sha 算明文，`size` 算压缩后字节（与配额对齐）。
- **不做 bundle zip**：会破坏 manifest per-file diff 模型。
- **配额按实际 COS 占用计**（压缩后字节，不是明文）。Why：资源被限制的应该按真实占用算；不耦合压缩策略；用户得到压缩率高的文件类型的隐性福利。
- **大文件 multipart + 续传**：> 5 MB 自动 multipart；状态进 `local/sync/state.json::pending_uploads[]`，断点续传，upload_id 7 天过期。
- **批量删除走 DeleteMultipleObjects**（≤ 1000 / 批）。
- **Rename 优化 v1 做**：local_index 维护 `sha → [paths]` 反查；命中时本地 `fs.copyFile` 或远端 `PutObjectCopy`，避免重复传输。
- **不做 byte-level dedup**（rsync 风格）：复杂度跳一档，COS 不原生支持，业界主流不暴露。
- **活跃 jsonl 整文件重传**作为 v1 已知开销接受，靠 debounce 缓解；v1.x 看带宽用量决定是否做分片。
- **增量分三层**：manifest ETag（L1）→ 文件 sha diff（L2）→ multipart part 续传（L3）。

### 批次 7（业界对照后修订） — ✅ 已决议
- **同 message_id 双侧编辑也留底**（append-only 假设的盲区）：原 plan "按 mtime 取较晚胜出" 会**默默丢失败者修改**。修订为：新 id 双侧追加直接 union；**同 id 双侧编辑 = 冲突**，败者那一条 message 写入 `local/sync/conflicts/<ts>-<rel_path>.jsonl`（仅含被覆盖的那条），走与可变 JSON 同款的恢复 UX。Why：业界（Dropbox / Obsidian / git）面对这种场景都不会默默丢——我们对外宣称"自动合并 jsonl"，必须在覆盖发生时给用户保留路径。
- **冲突留底保留期改为 profile 配置项** `sync_conflict_retention_days`（默认 30 天）。Why：Obsidian Sync 付费档最高保留 1 年，30 天硬编码偏短；改成 profile 字段后，未来按会员等级可调到 90 / 180 / 365 天（与配额分级同设计模式）。

### 批次 5（实施保障） — ✅ 已决议
- **冲突合并器单测必做**（按 PC/CLAUDE.md §9 "Hard rule for LLM-output text munging" 同标准）：set A 真实命中 + set B 似是而非不命中；走 `npm test`，绝不用 `npx vitest`（会留下 sqlite ABI 烂摊子）。
- CLAUDE.md / strip-rules 三处改动表述按 §9 草稿落地（vector.db 反转 / 新增 §N sync 引擎 / OrkasOpen strip 名单）。

### 批次 6（设置页结构 + 通知策略，追加） — ✅ 已决议
- **设置页 4 tabs**（用户指定）：
  | Tab | i18n key | 内容 |
  |---|---|---|
  | 账号 | `settings.tab.account` | Account 卡片（登录 / 退出 / profile） |
  | 数据 | `settings.tab.data` | **Sync 卡片**（含状态 / 进度 / 配额 / 冲突 / 隐私说明）+ Data root + Clear all conversations |
  | 通用 | `settings.tab.general` | Language / Commander avatar / Local Execution / Metacognition |
  | 配置 | `settings.tab.credentials` (en="Credentials") | Models & credentials + Search API Key + Image API Key |
- **Sync 归"数据"tab**：sync 是云端数据管理；与本地 data root / clear-convs 一起归口，用户不用在多处找"我的数据在哪、占多大、怎么清"。
- **完全去 toast**。所有需用户知晓的事件靠：
  1. 侧边栏 settings 按钮右上角圆点（红 = error / login_required / quota_full；橙 = warning / quota_near_full / conflict_pending / 连续失败 ≥ 3 次）
  2. 进入设置页时，对应 tab 标题也带圆点（导航到具体 tab）
  3. 卡片内部展开详情
- **连续失败阈值 N=3**（单次网络抖动不告警）。
- **v1 不做 in-flow ribbon**（编辑器内联提示）；接受"用户被覆盖时当下不知道"的弱点，靠圆点 + 进设置看到。v1.x 视反馈再决。
- **OrkasOpen 看到 3 tabs**：账号 tab 整体 strip（与 `#settings-account-group` 同进退），数据 tab 内 sync 卡片 strip（gate `typeof window.orkas?.sync !== 'undefined'`），OrkasOpen 数据 tab 只剩 data root + clear convs。

### 批次 4（用户体验：配额 + 冲突 UX） — ✅ 已决议
- **默认配额 5 GB / user**。Why：附件全同步场景下 1 GB 易爆、10 GB+ COS 成本走高；5 GB 覆盖 80% 用户。**未来按会员等级分档**——Orkas DB 表 `user_sync_usage` 的 `quota` 字段 per-row 可配，配额来源链路：默认值（profile 配置）→ 会员等级表（v1.x 加） → user override（管理员后台）。
- **超配额规则按 size delta 判定**（不是粗暴拒所有 push）：
  - manifest commit 计算 push 集的 net size delta（新增 - 删除 - 修改前后差）
  - `delta ≤ 0` → **允许**（删除 / 等大修改 / 缩小修改都放行；用户腾空间的路径不能被堵）
  - `delta > 0 && used + delta > quota` → **拒绝**，返回 `{ok:false, error:"QUOTA_EXCEEDED", delta, used, quota}`
  - **pull 永远允许**（不增加占用；断了用户进入"什么都看不到"死锁）
  - **manifest 自身大小**计入 used，但 tombstones 不计（30 天后自清）
- **配额满时 UI 引导**：设置页 sync 卡片满额时展开「占用 Top 10」列表（大到小，显示 path 摘要 + size + mtime），每行带「删除」按钮 → 走正常 delete + 墓碑流程。**v1 必做**——否则用户没释放路径。
- **冲突 UX = C + 可恢复**（用户提出的闭环）：
  - 写冲突时本机旧版本写入 `local/sync/conflicts/<ts>-<rel_path>`
  - **toast 提示**："`agent.json` 已被另一台设备的修改覆盖。[查看历史]"
  - 设置页 sync 卡片下有可折叠「冲突记录」列表（最近 30 天），每条带两个按钮：
    - **「恢复此版本」**：把 conflicts/ 里的旧内容覆盖回 cloud/ 路径 + `_v+1` + 标 dirty → 下次 sync 这版本胜出推到其他设备。点击前弹二次确认："这会撤销你在本机自冲突以来的修改，并把旧版本推到其他设备，确认？"
    - **「忽略并删除留底」**：清掉 conflicts/ 那条记录
  - **conflicts/ 默认保留 30 天**，改成 profile 配置项 `sync_conflict_retention_days`（批次 7 修订）；后续按会员等级可调到 90 / 180 / 365 天；到期自动清；用户也可在列表里手动清。

### 批次 3（隐私 / 加密） — ✅ 已决议
- **v1 不做应用层加密**。安全模型 = **STS + private bucket + COS SSE-COS（免费透明）**。Why：STS scope 锁死已挡住绝大多数现实威胁（外部攻击者 / 其他用户 / 网络中间人）；应用层加密的增量只在「COS / Orkas 内部威胁 + 执法调取」，v1 不投这块工程复杂度（密钥管理占 80% 成本）。
- **取消 codec.ts 抽象层**：无 v1 实现 → 抽象阅读成本反成负担。manifest 直接存**明文 sha256**，便于校验 / 去重 / 排障。v2 真要上 E2EE 时单独立项做（届时会破坏性变更数据格式，已写入 §10 风险）。
- **UI 设置页 sync 卡片**显示一行说明："数据通过加密通道（HTTPS）上传到私有云存储，仅你的账号可访问"。**不写**"端到端加密"——诚实表达能力边界。

### 批次 2（同步范围） — ✅ 已决议
- **vector.db 不同步**（方案 B）。云端只放 `contexts/` 源文件；各设备本地 `kb_indexer.reconcile` 自行 rebuild 索引。**必须改 PC/CLAUDE.md §4 constraint 5**（当前规则相反）。Why：改一篇文档触发几百 MB db 全量上传不可持续；索引按定义可重建。
- **附件三家全同步**：`chat_attachments/`、`chat_artifacts/`、`saved_apps/` 均纳入 v1 同步集。无 size 阈值、无懒拉。Why：体验一致性优先，"chats 同步了但附件缺"会让对话残缺。**代价**：单条 4K 视频可能 GB 级，几台设备并发上传会快速吃配额——批次 4 决配额时要正视这点；engine 需支持 COS 分块上传（`cos-nodejs-sdk-v5` SDK 原生支持，对 > 5MB 文件用 multipart）。
- **workspace.json 不同步**（沿用 PC/CLAUDE.md §4 既有归类）。Why：路径在异机无效；用户对"在哪台机器干什么"有直觉边界。

### 术语澄清（贯穿全文）
- **OAuth `user_id`**：登录后 server 返回，写入 `<local_uid>/local/config/account.json::user_id`，**COS 前缀就用它**。
- **本地 `uid`**：8-digit 数字、每台机器独立生成（`features/users.ts::initActiveUser`），仅用于本地容器路径 `<container>/data/<uid>/`，不上云、不做 COS scope。
- **device_id**：sync engine 首次启动时生成的 UUID，存 `<local_uid>/local/sync/state.json::device_id`，仅用于 manifest 里 `last_writer_device_id` 排障字段（不是安全凭据，与 account.json 无关）。

**Why**：同一 OAuth 账号在不同机器上有不同本地 `uid`，云端必须按 OAuth `user_id` 聚合数据，否则跨机看不到同一份云端内容。

---

## 1. Motivation

用户在登录态下使用 Orkas，希望本地数据（聊天、agent/skill 自定义、KB 源文件、preferences 等）在多设备间自动同步：
- 第二台设备登录同一账号 → 自动拉取已有数据
- 在 A 设备修改 → B 设备下次启动或运行中能看到
- 设置页有「立即同步」按钮 + 上次同步时间
- 显示当前云端占用，为后续配额限制铺路

现状利好：
- `<uid>/cloud/` vs `<uid>/local/` 切分早已落到 PC/CLAUDE.md §4，「哪些该同步」结构上已经回答
- Server 端 COS（`qcloud_cos` + private bucket + `temp/` lifecycle）已就绪
- `marketplace_reconcile.ts` 提供了"manifest → 本地状态"心智模型可复用
- IPC、启动 hook、settings 页面 Data 段位均有干净的扩展点

## 2. 设计目标 / 非目标

**目标**
- 跨设备最终一致：所有 `cloud/` 下数据可在合理时间内对齐
- 私有性：bucket 全 private；STS scope 按 OAuth `user_id` 锁死；启用 COS SSE-COS；`session_id` / API key 永不上云
- 频控 + 实时兼顾：按域 debounce + 退出/进入后台强制 flush
- 启动主动同步、运行中按需 push、配额可观察
- OrkasOpen 构建中**整套 sync 必须被 strip 掉**（与 `features/account/` 同进退，遵 PC/CLAUDE.md §4 + §11 strip-rules 约定）

**非目标（v1 不做）**
- 应用层加密（含 codec 抽象层；v2 真做 E2EE 时单独立项）
- 实时多端协作（v1 最终一致 + LWW + 提示，不做 CRDT）
- 按域选择性同步 UI（数据模型留位，UI v2）
- 付费配额 / 配额升级

## 3. Components

### 3.1 COS 端布局

单一 private bucket，按 **OAuth `user_id`** 前缀强隔离（不是本地 uid，原因见 §0 术语）：

```
orkas-user-data/<oauth_user_id>/
  manifest.json              # 真值索引（见 §4.1）
  cloud/chats/<cid>.jsonl
  cloud/chats/<cid>/{members,state,plan,visibility/}
  cloud/chats/{skill,agent}/<id>/chat.jsonl
  cloud/chat_attachments/<cid>/<file>
  cloud/chat_artifacts/<cid>/<artifactId>/<files...>
  cloud/saved_apps/<appId>/<files...>
  cloud/sessions/<sid>.jsonl
  cloud/contexts/...         # KB 源文件；vector.db 策略待批次 2 决（§7.2，CLAUDE.md §4 当前规则与方案有冲突）
  cloud/memory/{MEMORY.md, USER.md}
  cloud/agents/<aid>/{agent.json, meta/, skills/}
  cloud/skills/<sid>/...
  cloud/projects/<pid>/{project.json, bindings.json}
  cloud/marketplace/installs.json
  cloud/config/{preferences.json, component-enabled.json}
  tombstones/<rel_path>      # 删除墓碑，30 天后清理
```

- pretty-path 镜像本地 `cloud/` 一对一（便于排障，不做 content-addressed dedup）
- ACL：bucket 全 private；对象 inherit
- Bucket lifecycle：`tombstones/` 30 天自动清；老版本对象不保留多版本（v1 不做时间机器）
- COS server-side encryption 启用（free）

### 3.2 本地端布局（machine-private，不上云）

```
<container>/data/<local_uid>/local/sync/
  index.json     # 上次同步成功时的快照：{rel_path: {sha256, size, mtime_ms, _v}}
  state.json     # {device_id, last_sync_ts, last_pulled_generation, in_progress, pending_uploads[]}
  conflicts/<ts>-<rel_path>           # 被覆盖的可变 JSON 整文件留底
  conflicts/<ts>-<rel_path>.jsonl     # append-only 同 id 编辑冲突，仅含被覆盖那条 message（批次 7 决议）
  preferences.json  # 按域开关（v1 仅初始化默认值，UI v2 加）
```

`device_id` 在首次启动 sync engine 时生成（UUID v4），写入 state.json 后不变；用于 manifest `last_writer_device_id` 字段，不参与鉴权。

### 3.3 模块拆分

**PC 端（新增 `PC/src/main/features/sync/`）**
- `engine.ts` — 调度、debounce 表、startup/quit hook、运行中 dirty 事件订阅
- `manifest.ts` — manifest 拉取 / diff / 三集计算（pull/push/delete）
- `transport.ts` — STS 获取 + COS SDK 调用封装（PUT/GET/DELETE/HEAD；大文件走 multipart）
- `local_index.ts` — `local/sync/index.json` 维护、本地文件 sha 缓存
- `dirty_bus.ts` — 各 feature 写入后 emit 的事件总线，按域 debounce
- `merge/` — 按数据形态划分的冲突合并器：`jsonl_append.ts`、`mutable_json.ts`、`binary.ts`

**Server 端（新增 `Server/api/sync.py` + `Server/biz/sync/`）**
- 所有 sync 端点都过现有 `utils/auth.py::check_login`（`user_id` + `session_id` 头部，SessionMgr 滑动续期）。**绝不接受请求参数里传入的 `user_id`**——scope 推导只能来自校验后的 session。
- `POST /sync/sts` — 颁发 1h COS 临时凭据，scope 锁死 `<oauth_user_id>/*`
- `POST /sync/manifest/commit` — 唯一的 manifest 写入口；CAS（按 generation）；同时算账更新 usage
- `GET /sync/usage` — 返回 `{used_bytes, quota_bytes, last_sync_ts}`
- `Server/biz/sync/quota.py` — 配额计账与软硬阈值判定
- DB 新表 `user_sync_usage(user_id PK, bytes BIGINT, quota BIGINT, updated_at)`（PK 用 OAuth `user_id`，与现有 account 体系对齐）

### 3.4 IPC 接口（新增）

| Channel | 类型 | Payload | 返回/事件 |
|---|---|---|---|
| `sync.runNow` | invoke | `{}` | `{ok, error}`；进度通过 push 事件 |
| `sync.status` | invoke | `{}` | `{state, last_sync_ts, last_error, progress}` |
| `sync.usage` | invoke | `{}` | `{used_bytes, quota_bytes}` |
| `sync.progress` | push event | — | `{state, current, total, current_path}` |
| `sync.subscribeStatus` | stream | `{}` | yields status changes |

新 features → IPC 的方向遵守 PC/CLAUDE.md §3（ipc → features，不反向）。

## 4. 关键机制

### 4.1 Manifest 格式

```jsonc
{
  "manifest_v": 1,
  "generation": 42,                      // 单调递增，CAS 用
  "last_writer_device_id": "...",
  "last_writer_ts_ms": 1731600000000,
  "entries": {
    "cloud/chats/abc.jsonl": {
      "sha256": "...",                   // 明文内容的 sha（不是压缩后字节）
      "size": 12345,                     // **实际存到 COS 的字节数**——压了就是压缩后；配额按此累加（批次 8 决议）
      "mtime_ms": 1731599000000,
      "_v": 7,                           // 文件级单调版本（每次本地写入 +1）
      "schema_v": 1,
      "compressed": "gzip"               // null | "gzip"（批次 8 决议）
    },
    "...": { ... }
  },
  "tombstones": {
    "cloud/chats/deleted.jsonl": { "deleted_at_ms": 1731500000000, "_v": 9 }
  }
}
```

**generation 作为主时序**（不信任客户端 mtime；mtime 仅作辅助二级排序）。

### 4.2 单次 sync 流程

```
1. GET manifest.json (带 If-None-Match / ETag)，未变跳到 5
2. diff(remote.entries, local_index)
     ├─ need_pull:  remote 新 / 本地缺
     ├─ need_push:  本地新 / remote 缺
     ├─ need_delete_local: tombstones 中有，本地存在
     └─ need_delete_remote: 本地有删除标记，remote 仍存在
3. 串行 delete local（清本地被墓碑标记的文件）
4. 并发 pull → 并发 push（受 max-concurrency 限制，单文件失败独立重试）
5. POST /sync/manifest/commit (带 base_generation = 拉到的 generation)
     ├─ 成功 → 写 local/sync/index.json + state.json
     └─ CAS 冲突 → goto 1，重试 1 次后退避到下个周期
```

### 4.3 冲突解决（按数据形态分类）

| 数据形态 | 策略 |
|---|---|
| `chats/*.jsonl`、`sessions/*.jsonl`（append-only） | 新 id 双侧追加直接 union；**同 id 双侧编辑 = 冲突**（批次 7 决议）：较晚 mtime/_v 胜出，败者那一条 message 写入 `local/sync/conflicts/<ts>-<rel_path>.jsonl`（仅含被覆盖那条），同样进设置页"冲突记录"列表 + 「恢复此版本」按钮 |
| `preferences.json` / `agent.json` / `project.json`（可变 JSON） | 文件内嵌 `_v`；双侧都 > base = 冲突，LWW（_v 大者胜，并列时 generation 大者），老版本写入 `local/sync/conflicts/<ts>-<rel_path>` 留底 30 天，toast + 设置页「冲突记录」列表（含「恢复此版本」按钮 → 把 conflicts/ 内容覆盖回去 + `_v+1` + 标 dirty，二次确认）|
| 附件（二进制） | 按 sha256 内容寻址，永不冲突（同 path 不同 sha 视作可变 JSON 同策略） |
| `marketplace/installs.json` | 视作可变 JSON；本地 reconcile 再消费 |

### 4.4 Schema 防降级

每个可变 JSON 顶层带 `_schema_v`。pull 阶段若 `remote.schema_v > local_known_v` → **拒绝覆盖本地**，UI 提示「其他设备运行的版本较新，请升级」。push 阶段不会发生（本设备只能写自己已知的 schema）。

### 4.5 频控

- **运行中**：feature 写入后 emit `dirty(domain, rel_path)` → `dirty_bus` 按 domain 启动 debounce 计时器
- **域级 debounce 默认**：
  - `preferences` 2s
  - `chats` / `sessions` / `memory` 5s
  - `agents` / `skills` / `projects` 10s
  - `chat_artifacts` / `saved_apps` 10s（小 bundle，与 agents 同档）
  - `chat_attachments` 30s（大文件域，含视频；分块上传单独并发上限）
  - `contexts`（KB 源） 15s
- **到点合并**：所有过期 timer 合并成一次 sync pass（同一窗口内多次 dirty 只触发一次 sync）
- **强制 flush 触发**：app `before-quit`、用户点「立即同步」、startup
- **全局 floor**：两次自动 sync 间至少 30s（防异常风暴）

### 4.6 启动同步 hook

`PC/src/main/index.ts` 在现有 `marketplaceReconcile` 之后追加：

```ts
setImmediate(() => syncFeature.syncNow(uid).catch(err => logger.error('sync.startup', err)));
```

fire-and-forget，与现有 KB/search/marketplace reconcile 同列。UI 通过 push 事件感知进度。

### 4.7 COS 访问通道：STS 直传（批次 1 已决议）

- 新依赖：`cos-nodejs-sdk-v5`（已确认加入 PC/package.json allow-list）
- 流程：PC → `POST /sync/sts`（带 `user_id` + `session_id` 头部，走现有 `check_login`）→ Server 从 SessionMgr 校验得到的 `user_id` 构造 scope 严格锁死 `<oauth_user_id>/*` 的临时凭据（1h）→ PC 用 SDK 直接 PUT/GET/DELETE
- **安全核心**：scope 来源**只能**是 SessionMgr 校验后的 `user_id`，**禁止**信任请求参数里传入的 uid / user_id
- Server 只保留三件事：发 STS、守 manifest CAS commit、配额计账
- manifest.json 的 PUT/DELETE **必须**走 Server 端点（保证 CAS 与计账的原子性），其余对象 PC 直发
- **marketplace 上传维持 server-proxy**（批次 1 已决议；与 sync 通道分离）

### 4.8 配额（批次 4 已决议）

- DB：`user_sync_usage(user_id PK, bytes BIGINT, quota BIGINT, updated_at)`；PK 是 OAuth `user_id`
- 默认 `quota = 5 GB`（从 profile `sync_quota_default_bytes` 读，可 per-row override，未来对接会员等级）
- 每次 `commit` 计算 push 集的 net size delta = `sum(add) - sum(del) - sum(modify_size_diff)`
- **判定规则**（批次 4 决议）：
  - `delta ≤ 0` → 允许（删除 / 等大修改 / 缩小修改放行）
  - `delta > 0 && used + delta > quota` → 拒绝，返回 `{ok:false, error:"QUOTA_EXCEEDED", delta, used, quota}`
  - `0 < delta && used + delta ≤ quota` → 允许并更新 `used`
- **pull 永远允许**，不查配额
- 软提醒 80% → manifest commit 成功响应附带 `warn: "QUOTA_NEAR_FULL"`，PC 端进侧边栏 dot（无 toast，批次 6 决议）
- manifest.json 自身大小计入 `used`；tombstones 不计（30 天后自清）
- **`used` 和 entries 的 `size` 都按"实际存到 COS 的字节"算**（压缩后字节，不是明文大小）——批次 8 决议。Why：资源被限制的东西（COS 存储）应该按实际占用计；不耦合压缩策略；用户压缩率高的文件类型隐性"白嫖"是合理福利
- 设置页：配额满时展开「占用 Top 10」列表 + 每行「删除」按钮（v1 必做）

### 4.9 设置页 UI 重构（4 tabs，批次 6 决议）

**整体改造**：把现有滚动式 `#panel-settings` 拆成 4 tab 容器。tab 切换视觉复用 `.marketplace-tabs` / `.marketplace-tab` 原语（`index.html:368` 已有；遵 PC/CLAUDE.md 「Reuse UI components」）。

**4 tabs**（中文标签按用户指定顺序）：

| Tab | i18n key | 包含的卡片（已有 + 新） |
|---|---|---|
| 账号 | `settings.tab.account` | Account（既有 `#settings-account-group`） |
| 数据 | `settings.tab.data` | **Sync 卡片（新）** + Data root（既有）+ Clear all conversations（既有）|
| 通用 | `settings.tab.general` | Language / Commander avatar / Local Execution / Metacognition（全部既有） |
| 配置 | `settings.tab.credentials` (en="Credentials") | Models & credentials + Search API Key + Image API Key（既有 sections 合并） |

**触点**：
- `index.html#panel-settings`：包 `.settings-tabs` + 4 个 `.settings-tab-pane`；现有 4 个 `.settings-section-head` 改造成 tab pane（账号 tab 内不需 section-head 因为只有一个卡片）
- 新增 CSS：复用 `.marketplace-tabs` 配色 / 间距；新 `.has-dot::after` 圆点
- `modules/settings.js`：tab 切换逻辑 + **按 tab 懒加载**（不要进设置页就刷全部状态——现 `loadSettings()` 并行刷 7+ 个状态是浪费）
- i18n key 新增 `settings.tab.{account,data,general,credentials}`

#### Sync 卡片内容（数据 tab 内部，从上到下）

1. **整体状态徽章** + **上次同步时间**（"5 分钟前"，hover 显示绝对 UTC）+ **「立即同步」按钮**（loading 态由 `sync.progress` push 驱动）
2. **配额条** `12.4 MB / 5 GB`（≥ 80% 黄、≥ 95% 红）
3. **同步中实时刷新**：阶段（pull / push / commit）+ 进度（`上传 3/8 · 下载 1/5`）+ 当前文件路径（截断显示）
4. **异常态展开**：
   - error → 错误详情 + "查看日志"链接（打开 `data/logs/<today>.log`）
   - quota_full → 「占用 Top 10」列表 + 每行「删除」（批次 4 决议）
   - login_required → "重新登录" CTA
5. **冲突记录**（可折叠面板，标题带计数 `冲突记录 (3)`）：最近 30 天列表，每条 `时间 / path / [恢复此版本] [忽略]`（批次 4 决议）
6. **隐私说明**：i18n key `settings.sync_privacy_note`，文案 "数据通过加密通道（HTTPS）上传到私有云存储，仅你的账号可访问"（批次 3 决议，**不写"端到端加密"**）

#### 通知策略（批次 6 决议：完全去 toast）

事件 → 圆点级别映射：

| 事件 | 级别 | 显示在 |
|---|---|---|
| 同步中 / 成功 / 首次失败 | 无 | 卡片内 |
| 同步连续失败 ≥ 3 次 | 橙 | 侧边栏 dot + 数据 tab dot |
| 网络断开 | 无 | 卡片内 "⏸ 离线" |
| 登录失效 | 红 | 侧边栏 dot + 账号 tab dot |
| 配额 ≥ 80% | 橙 | 侧边栏 dot + 数据 tab dot |
| 配额满（push 拒）| 红 | 侧边栏 dot + 数据 tab dot |
| 新冲突写入 conflicts/ | 橙 | 侧边栏 dot + 数据 tab dot |

实施：新 module `modules/sidebar-status.js`——订阅 `sync.subscribeStatus` + `account:changed` push，聚合后决定侧边栏 settings 按钮的 dot 颜色（红 > 橙 > 无）。

**v1 已知弱点**：用户在 agent / project 编辑页改了内容、被另一设备覆盖——当下没 toast 提示，要等他看到圆点进设置才发现。v1 接受这个 trade-off；v1.x 视反馈再加内联 ribbon「此版本已被其他设备覆盖 · [还原]」。

#### OrkasOpen 行为

- **账号 tab 整体 strip**（与 `#settings-account-group` 同进退）
- **数据 tab 内 sync 卡片 strip**（gate `typeof window.orkas?.sync !== 'undefined'`）
- OrkasOpen 用户看到 **3 tabs**：数据（只剩 data root + clear convs）/ 通用 / 配置
- `sidebar-status.js` 在 OrkasOpen 下整体无效（永远不 dot），可一并 strip

#### 同步触发时机（汇总，批次 6 补全）

| # | 时机 | 行为 |
|---|---|---|
| 1 | **应用启动** | `setImmediate` 触发首次 sync（pull-first），与 marketplace_reconcile 同列 |
| 2 | **运行中写入** | features emit `dirty(domain, rel_path)` → 按域 debounce → 到点合并；两次自动 sync 间至少 30s |
| 3 | **应用退出** `before-quit` | 强制 flush pending |
| 4 | **用户点「立即同步」** | 立即触发 full sync，跳过 debounce |
| 5 | **登入 OAuth** | init engine + 首次 full pull（新设备场景） |
| 6 | **登出 / session 失效** | teardown engine，pending 保留 |
| 7 | **切 OAuth user_id** | teardown 旧 → 清 `local/sync/` → 按新 user 重建 |
| 8 | **从后台回前台**（browserWindow `focus` / `activate`） | 距上次成功 sync > 5min 时触发一次轻量 sync（HEAD manifest，generation 变了才走完整 sync） |
| 9 | **网络恢复**（`navigator.onLine = true`） | 重试 pending_uploads（指数退避：30s / 1min / 2min / 5min 封顶） |
| 10 | **配额释放后**（用户删大文件） | 通过 #2 dirty 路径自然重试（删除的 commit 刷新 used，下个 push 不再 QUOTA_EXCEEDED）|

### 4.10 删除 / 登录态变化

- 任何 `cloud/` 下删除操作必须经 sync engine 记墓碑（features 层直接 unlink 是 bug；要在 §6 里硬约束）
- **登录/登出/账号切换**——监听 `account:changed` push 事件：
  - 登入（首次拿到 OAuth `user_id`）：初始化 sync engine、生成或读取 `device_id`、调度首次 full pull
  - 登出 / session 失效：立即 teardown engine、停所有 in-flight、`local/sync/state.json` 保留（便于下次同账号登入续传），但 `pending_uploads` 不再触发
  - 切到另一个 OAuth `user_id`：先 teardown 旧 engine → 清 `local/sync/`（不同 OAuth user 的本地索引不能复用）→ 按新 user_id 初始化
- **本地切 active uid**（`features/users.ts::activateUser` 切 8-digit uid，常见场景：同机两个本地 profile）：teardown 当前 engine，新 uid 启动后再走「初始化 or 续传」分支
- **未登录态下不启动 sync**（无 OAuth user_id 没有云端 scope；UI 侧 sync 卡片显示"登录以启用"，登录后再启）

### 4.11 传输优化与增量同步（批次 8 决议）

#### 压缩（单文件 gzip，BYO encoding 模式）

- **谁压**：PC 端 upload 前自己 gzip，download 后自己解；COS 完全不感知压缩、永远不解压
- **协议层**：上传**不设** `Content-Encoding: gzip` 头（否则 cos-nodejs-sdk-v5 会自动解压，PC 端拿不到压缩字节）；Content-Type 设 `application/gzip`；附加自定义元数据 `x-cos-meta-compressed: gzip` 给 COS 控制台一个可见提示
- **白名单**（按扩展名匹配）：`.jsonl`、`.json`、`.md`、`.txt`、`.csv`、`.log`
- **大小阈值**：明文 > 4 KB 才压（更小的压缩 metadata 开销不划算）
- **黑名单**（永不压）：`.jpg / .jpeg / .png / .webp / .gif / .mp4 / .webm / .mov / .pdf / .docx / .xlsx / .pptx / .zip / .gz / .br`
- **sha256 算明文**（跨设备一致性可靠；gzip 输出受压缩级别 / 库版本影响不完全确定）
- **`size` 算压缩后字节**（COS 实际占用，与配额对齐 —— 批次 8 决议）
- **路径不加 `.gz` 后缀**（COS path 与本地 rel_path 一对一镜像，压缩状态由 manifest `compressed` 字段标）

#### 不做 bundle 压缩
不把目录打 zip 上传（如把整个 `agents/<aid>/` 打包）。Why：破坏 manifest per-file diff 模型——改一个文件要重打整 bundle 重传，增量同步退化成 bundle 级。

#### 大文件 multipart 上传 + 续传
- > 5 MB 文件自动走 cos-nodejs-sdk-v5 的 multipart API（SDK 内置）
- **续传状态**进 `local/sync/state.json::pending_uploads[]`，每条 `{rel_path, sha256, upload_id, part_etags[], completed_parts, total_parts}`
- 中断（网络 / 应用退出 / 配额暂时满）→ 下次 sync 从 `completed_parts` 之后继续；超过 7 天的 upload_id 视作失效，从头来过
- 并发：chat_attachments 域单独限并发 2（避免一台机器猛传堵住整个 sync pass），其他域并发 5

#### 批量操作
- **删除**走 COS `DeleteMultipleObjects`，每批 ≤ 1000 个对象（COS API 上限）
- 多文件 push 用 SDK 内置 sliced upload，复用 HTTPS 连接

#### Rename 优化（v1 必做）
- `local_index.ts` 同时维护 `path → entry` 和 `sha → [paths]` 两个索引
- diff 阶段：
  - `need_pull` 文件的 sha 已存在本地另一 path → 本地 `fs.copyFile` 即可，**不下载**
  - `need_push` 文件的 sha 已存在远端另一 path → 调 `PutObjectCopy`（COS 服务端内部 copy，**不消耗 PC 上下行带宽**）+ 之后正常 delete old
- 典型场景：用户重命名 agent / 移动 contexts 文档

#### 不做 byte-level / chunk-level dedup
- rsync 风格 rolling hash 实现复杂、COS 不原生支持、对小文件无收益，业界（Dropbox / Obsidian / OneDrive）也都不暴露
- 整文件级粒度 + multipart 续传 + rename 优化 = 已经覆盖 v1 需要的场景

#### 增量同步分三层（汇总）

| 层 | 机制 | 何时跳过传输 |
|---|---|---|
| **L1 manifest 级** | `GET manifest.json` 带 `If-None-Match: <last_etag>` | 304 → 跳过整次 sync |
| **L2 文件级** | manifest.entries 与 local_index 的 sha 对比 | sha 相同 → 跳过该文件传输 |
| **L3 multipart 级** | 大文件分块上传 + 续传状态 | 已完成的 part 跳过 |

#### 活跃 jsonl 整文件重传（已知开销）
- 一条 chat jsonl 每加一条 message → 整文件 dirty → 整文件重传
- 缓解：域级 debounce（chats 5s）把窗口内多次写并成一次传
- v1 接受这个开销；写入 §10 风险，v1.x 看带宽用量再决定要不要做 jsonl 分片（按 message_id 范围分文件）

## 5. 同步集合（明确清单）

**✅ 同步（`cloud/` 下，批次 2 决议）**
- chats（jsonl + members/state/plan + visibility/）
- chats/{skill,agent}/<id>/chat.jsonl（编辑会话）
- chat_attachments（全量同步，含视频 / PDF 等大文件；> 5MB 走 COS multipart 上传）
- chat_artifacts（全量同步，硬上限 ≤ 1MB / bundle ≤ 20 文件，体量受 PC/CLAUDE.md §5 约束）
- saved_apps（全量同步）
- sessions
- contexts **仅源文件**（vector.db 不同步，各设备本地 rebuild via `kb_indexer.reconcile`）
- memory/{MEMORY.md, USER.md}
- agents（含 meta/ + skills/，整目录）
- skills、projects
- marketplace/installs.json（仅清单，本地 reconcile 拉真包）
- config/preferences.json、config/component-enabled.json

**❌ 不同步（`local/` 下）**
- config/account.json（OAuth `user_id` + `session_id` + `user_info`，machine-private）
- config/auth-profiles.json（LLM API keys）
- config/permissions.json、reflection-state.json、web-search-cache.json
- biz/marketplace.json（24h TTL 缓存）
- local/marketplace/{agents,skills}/（reconcile 时按清单从 COS 拉）
- cache/<bucket>/（user-clearable 缓存伞）
- search/（派生索引）
- file_cache/、tool-results/（按 PC/CLAUDE.md §4 constraint 6 即将迁入 cache/）
- workspace.json（机器私有，路径异机无效；批次 2 已决议）
- test/（dev-only LLM 归档）
- **顶层** `users.json`、`logs/`（machine-private，与 OAuth 账号无关）

**`cloud/` 内 v1 跳过同步**：vector.db（只同步 `contexts/` 源文件）

## 6. Change list

### PC 端
- `PC/src/main/features/sync/` 新建（engine / manifest / transport / codec / local_index / dirty_bus / merge/）
- `PC/src/main/index.ts` 增加 startup hook + before-quit flush
- `PC/src/main/ipc/index.ts` 注册 `sync.runNow` / `sync.status` / `sync.usage` / stream
- `PC/src/main/features/marketplace.ts::apiBase()` 复用（同步 API 也通过它）
- `PC/src/main/features/users.ts` 切账号路径调用 `syncFeature.teardown()`
- 各 cloud 写入方 feature（chats、agents、skills、projects、preferences）写完后 emit `dirty()`：
  - `features/chats/*` 收尾处
  - `features/agents.ts` / `features/skills.ts`
  - `features/projects/*`
  - `features/app_config.ts`（preferences 写入处）
  - `features/marketplace.ts`（installs.json 写入处）
- 各 cloud 删除方 feature 改走 `syncFeature.markDeleted(rel_path)` 而不是直接 unlink
- `PC/src/renderer/modules/settings.js` **重构成 4 tab**（账号 / 数据 / 通用 / 配置），按 tab 懒加载状态；数据 tab 内新增 sync 卡片（gate `typeof window.orkas?.sync !== 'undefined'`）
- `PC/src/renderer/index.html#panel-settings` 整体改造：`.settings-tabs` + 4 个 `.settings-tab-pane`
- `PC/src/renderer/styles.css`（或对应文件）：复用 `.marketplace-tabs` 视觉，新增 `.has-dot::after` 圆点
- 新模块 `PC/src/renderer/modules/sidebar-status.js`：聚合 sync + account 状态决定侧边栏 dot
- `PC/src/renderer/locales/{zh,en}.json` 加 sync 相关字串（key 前缀 `settings.sync_*`）+ 4 个 tab 标签 key（`settings.tab.{account,data,general,credentials}`）
- `PC/package.json` 新增 `cos-nodejs-sdk-v5`（批次 1 已确认）
- `features/account/` 订阅点：监听 OAuth 登录/登出/切账号，分别触发 sync engine 的 init / teardown / reset
- `OpenSource/SyncCode/strip-rules.json` 增加整套 sync 的剥离规则（见 §9）

### Server 端
- `Server/api/sync.py` 新建（sts / manifest commit / usage 三端点）
- `Server/biz/sync/quota.py` 新建（计账 + 阈值）
- `Server/biz/sync/sts.py` 新建（COS STS 临时凭据签发，scope 强约束）
- `Server/utils/store/file_store.py` 复用 / 扩展（不动现有接口）
- DB migration：新表 `user_sync_usage`
- `Server/conf/cn.conf` 增加 `sync_quota_default_bytes`、`sync_sts_duration_seconds`、`sync_conflict_retention_days`（批次 7 决议）

### Profile / 部署
- COS bucket lifecycle 规则：`tombstones/*` 30d 过期
- COS bucket policy：默认 private（已有）
- CAM 子账号 / 角色：sync STS 所用主账号需有 sts:GetFederationToken 权限

## 7. 待决策项（按批次推进）

> ✅ = 已决议（见 §0 决议日志）；🟡 = 当前 / 下一批；⚪ = 待批次。

- ✅ **批次 1** — STS 直传 / 新依赖 / marketplace 通道分离（见 §0）
- ✅ **批次 2** — vector.db 不同步 / 附件三家全同步 / workspace.json 不同步（见 §0）
- ✅ **批次 3** — v1 不做应用层加密，靠 STS + private + SSE-COS；取消 codec 抽象；UI 加诚实隐私说明（见 §0）
- ✅ **批次 4** — 配额 5 GB（按 size delta 判定）/ 配额满时 Top 10 释放 UI / 冲突 UX = toast + 历史列表 + 可恢复（见 §0）
- 🟡 **批次 5 — 实施保障**
  - 7.9 **冲突合并器单测**：jsonl append / mutable json 合并器是「文本处理 / 解析」类代码，按 PC/CLAUDE.md §9 "Hard rule for LLM-output text munging" 必须配 fixture 单测（set A 真实命中 + set B 似是而非不命中）。
  - 7.10 **CLAUDE.md 同步**：本方案落地后需同步以下条目（见 §9），先确认表述。

## 8. Verification

实施后需通过：
- **单测**：
  - `merge/jsonl_append.ts` — 双侧追加新 id 消息（union）、**双侧改同 id（冲突 → 留底 + 较晚胜出）**、空文件 / 末行无换行 fixture（批次 7 决议要求覆盖留底分支）
  - `merge/mutable_json.ts` — 双侧 _v 同 / 异、schema_v 倒置拒绝覆盖、墓碑场景
  - `manifest.ts` — diff 三集计算、CAS 冲突重试、**rename 检测**（sha 反查命中本地 copy / 远端 PutObjectCopy 分支，批次 8）
  - `transport.ts` — gzip 白名单 / 阈值 / 黑名单决策、压缩字节与明文 sha 一致性（批次 8）
  - `dirty_bus.ts` — debounce 合并、强制 flush 优先
- **集成测**：
  - 起两个临时数据根（模拟 A/B 设备），共享同一伪 COS（local fs mock）
  - 场景：单边写入 → 另一边 pull、双边并发 → CAS 冲突、删除 → 墓碑 → 另一边删本地
  - 配额硬阻断场景
- **手工验证**：
  - 真实双设备 Mac + Win 同账号登录，跑一遍：聊天、改 agent、删聊天、配额接近上限
  - 验证 `session_id` / API key / `account.json` 内容**永远没**出现在云端任何对象里（list bucket + grep STS 直传日志）
  - OrkasOpen 构建：sync 模块整体被 strip 干净（不存在 `features/sync/`、preload 无 `sync` 命名空间、settings 页无 sync 卡片）
- **回归**：
  - 现有 KB reconcile、marketplace reconcile、search reconcile 行为不变
  - dev 包与 packaged 包行为一致（CLAUDE.md「OrkasOpen has no dev-vs-prod behavior split」）

## 9. CLAUDE.md / strip-rules 同步项

实施后需同步：

### PC/CLAUDE.md
- §1 npm allow-list 增加 `cos-nodejs-sdk-v5`
- §4「数据同步域」修订：
  - **COS 前缀 = OAuth `user_id`**（不是本地 8-digit `uid`）；本地 `<container>/data/<uid>/cloud/` ↔ 云端 `orkas-user-data/<oauth_user_id>/cloud/` 一对一镜像
  - vector.db 策略改写——**待批次 2 决议**：若决「不同步」，需明确撤销当前 constraint 5 的 "KB vector store is part of cloud sync"，改成「只同步 `contexts/` 源文件，vector.db 每设备本地 rebuild via `kb_indexer.reconcile`」
  - `cloud/` 下任何删除**必须**经 `syncFeature.markDeleted(rel_path)`，禁止 features 层直接 unlink（否则会被其他设备复活）
- 新增「§N sync 引擎」一节：
  - manifest 是云端真值，generation 单调；客户端 mtime 仅辅助
  - `local/sync/` 结构 + 永不上云
  - 按域 debounce 表（防止有人到处加 dirty 调用而不知道频控位置）
  - schema_v 防降级语义
  - device_id 在 sync engine 首启时生成，存 `state.json`，仅作排障字段
- §9「Don't do」追加：禁止在 sync engine 外读写 manifest.json；禁止把 OAuth `user_id` 当作本地路径段；禁止用 8-digit 本地 uid 做 COS scope

### Server/CLAUDE.md
- §3 追加：`/sync/*` 全部端点必须经 `utils/auth.py::check_login`；STS scope **只能**从 SessionMgr 校验后的 `user_id` 推导，禁止信请求参数
- `/sync/manifest/commit` 是 manifest 唯一写入口，CAS + 配额计账原子

### OrkasOpen strip-rules（`OpenSource/SyncCode/strip-rules.json`）
- 与 `features/account/` 同进退——整个 `features/sync/` 目录、`ipc/sync.ts`（若拆出）、`renderer/modules/sync*.js`、`renderer/modules/sidebar-status.js`、`renderer/locales/{zh,en}.json` 里 `settings.sync_*` 键、`#settings-sync-group` 块、`window.orkas.sync` 命名空间——全部加入 strip 名单
- 数据 tab 内的 sync 卡片用 `typeof window.orkas?.sync !== 'undefined'` gate（与 `marketplace_dev` 的 `typeof openMarketplaceUpload === 'function'` 同模式），避免 sync strip 后还要手改 renderer
- 账号 tab：与既有 `#settings-account-group` 的 strip 同步——账号 tab 整体在 OrkasOpen 不显示（4 tabs → 3 tabs）；tab 切换 JS 要能优雅跳过被 strip 的 tab（不报错不空白）
- 新依赖 `cos-nodejs-sdk-v5` 仅在主仓使用；OrkasOpen 不安装（package.json 同步流程会自然过滤）

### 日志 / 遥测（PC/CLAUDE.md §10）
- sync engine 使用 `createLogger('sync')` + 子 scope（`sync:engine` / `sync:transport` / `sync:manifest` / `sync:merge`）
- 关键节点 `log.info`（startup 同步开始 / 单次 sync 起止 / 文件数 / 用时 ms）
- 失败必 `log.warn`（可恢复，如网络抖动）或 `log.error`（不变量违例，如 CAS 反复冲突）
- Umami 事件可记 `sync_started` / `sync_completed` / `sync_failed`（data 只放计数与耗时，**绝不**含 path / cid / 文件内容）

## 10. 风险与未尽事项

- **首登耗时**：新设备首次同步可能下载几百 MB ~ 数 GB 附件 + 本地 rebuild KB 索引；需要 UI 明确分段进度（聊天文本 / 附件 / KB rebuild）而非"卡住"假象
- **附件大小爆炸（批次 2 已知风险）**：附件三家全同步，单条视频可能 GB 级。配额（批次 4）必须早设硬上限；engine 必须支持 multipart 续传、并对 chat_attachments 用更窄的并发（避免一台机器猛上传把整个 sync 堵住）；超配额时 push 端点返回 `QUOTA_EXCEEDED`，UI 引导用户「删大附件」或「升级配额（未来）」
- **CAS 雪崩**：极端场景多个设备同时频繁 commit → 退避策略要好；v1 简单线性退避 + 拉抖动
- **活跃 jsonl 整文件重传**（批次 8 已知开销）：当前没做 jsonl 尾部分片协议（COS 无原生 append），每次新消息整文件重传。靠域级 debounce（chats 5s）缓解。v1.x 若带宽问题严重，考虑按 message_id 范围分片（如 1000 条一片），新片不影响旧片
- **压缩库版本漂移**：不同 Node 版本的 zlib 输出可能略有差异（同明文压出来字节级不同）→ sha 必须算明文（已锁），否则跨设备验证会假阳性。Node 自带 zlib 跨版本相对稳定，可接受
- **device_id 与隐私**：manifest 暴露 `last_writer_device_id` 给同账号其他设备；这是同账号自己的设备，可接受，但不要把它写进日志/上报
- **时区与"上次同步时间"显示**：用 UTC 存，渲染层按 OS locale 显示，沿用现有 i18n
- **多 active user（CLAUDE.md 说"framework-ready but not yet shipped"）**：v1 仍按单 active user 设计，但 sync engine 实例按 OAuth `user_id` 创建/销毁，避免后续重写
- **session 过期 → 同步中断**：`/sync/sts` 返回 401 → engine 暂停、UI 提示重新登录、`pending_uploads` 保留待恢复
- **本地 uid ↔ OAuth user_id 多对一**：同一 OAuth 账号在两台机器各有独立本地 uid；teardown 时清的是 `<local_uid>/local/sync/`，不会误删另一台
- **未登录态写入**：登录前的本地修改在登入后能否一次性 push 上去——v1 行为是「能」（首次 sync 把当前 `cloud/` 内容当作待 push），但要在 UI 上明示「首次同步可能将本机数据视为云端真值」，避免新设备误用旧机操作
- **v2 加密带破坏性变更（批次 3 决议遗留）**：若 v2 要上 E2EE，所有现存对象需重新加密 + manifest 字段扩 `cipher/iv`；老客户端拉到密文版本将无法解读。届时必须：(a) 锁老版本不能再写、(b) 服务端做全量重密迁移、(c) 提供"丢失密钥 = 丢失数据"的明示同意 UX。**v1 不预埋 codec 抽象的代价就是 v2 这一刀；预估收益（v1 简化）> 成本（v2 一次性迁移）**。
