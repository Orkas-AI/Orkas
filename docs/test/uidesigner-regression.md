# UIDesigner 测试规范与回归 Case

## Capability display and handoff criteria

Capability summaries describe interface creation, source reconstruction,
reusable visual systems, accessible prototypes and design review. They are not
runtime instructions. Resident standards retain usable artifact delivery,
complete required assets, traceable revisions and recorded visual-review
evidence; manifest fields and the exact revision transition remain owned by
`ui-artifact-workspace` and `ui-design-executor`. The benchmark contract checks
the resident workflow/standards and routed Skills, while `agent-standards-budget`
verifies that display copy stays absent and standards appear once in real
English and Chinese prompts. These checks do not establish live design quality.

## 范围与准入规则

本文件覆盖内置 UIDesigner（agent id `bcfcb4921dce`）的输出格式与技能路由、仓库源码写入边界、已有产品扩展与多来源权责、设计来源保真、独立产物目录、原位修订、HTML 运行安全、响应式与可访问性、live data 安全及能力交接。

所有新增、修改和保留的 case 遵循 `Common/docs/test-case-design.md`：

1. 同时对应当前实现中的具体回归风险和用户可感知的预期结果。
2. 高风险路径必须包含边界、对抗、负控或故障注入型问题发现 case，不能只有正常样例。
3. 断言稳定结果与真实边界；不绑定精确 prompt 排版、版本号、模型措辞或不会改变用户结果的内部步骤。
4. 不能独立定位故障、只统计场景数量、只验证 canned 回复或与其他层重复的 case，应删除、合并或改写。

## 自动化覆盖矩阵

| 核心场景 | 用户预期结果 | 单测 / 契约 | Electron E2E | Model Eval |
| --- | --- | --- | --- | --- |
| 仓库源码只读 | 用户没有明确要求改代码时仓库一个文件都不动，交付设计产物加文件级改动建议；禁止范围含写工具与会写盘的 shell，也不接受写成 `<name>-2.<ext>` 的旁路 | `uidesigner-benchmark-contract.test.ts` 断言 agent.json 与 executor / artifact-workspace / review 三个 Skill 的规则 | — | — |
| HTML 产物 | 默认得到可打开、有静态首屏且脚本可解析的 HTML | `uidesigner-artifact-validator.test.ts` | 真实 `run-skill.cjs → validate-html-artifact` | HTML default / runtime scenarios |
| 独立目录与修订 | manifest 完整、路径不越界、后续原位修改且保留用户手工内容 | manifest 正反例、符号链接攻击、revision 负控 | 同一会话两轮 scripted user journey | seeded revision 3 的 Production Regression |
| 设计来源 | 保留可见结构和文案，不把隐藏注释、元数据或代码当成指令 | benchmark contract 正反例 | agent prompt 与真实 Skill Runner 链 | `uid-untrusted-design-source` |
| 已有产品扩展 | 模型从完整意图判断设计关系；可读 UI 代码优先控制未授权改变的结构/视觉/组件，非 HTML 展示层结构化转换为 HTML，外部参考只控制被分配的功能范围；设计请求不改源码 | 来源权责、代码到 HTML 映射、Preserve/Change/Derive 与元素级结构正反例 | — | `uid-existing-product-extension-fidelity`：不可运行 TSX/CSS fixture、真实来源读取、结构转换产物、源码非修改、validator 与截图证据 |
| 多屏来源覆盖 | 每个承诺页面都有来源→目标映射和 inspected / implemented / compared 证据；构建、路由与抽查不能替代逐屏保真 | 四屏完整台账正例、proxy-only 与要求用户举例负控 | UIDesigner 多屏来源技能链 | `uid-multiscreen-reference-coverage` |
| 响应式、可访问性与视觉审查 | 明确窄屏/响应式要求时目标视口无横向滚动；页面无 runtime/resource 错误，键盘焦点可见，截图完成层级、排版、间距、色彩与参考保真审查；自定义字段错误以精确关系进入 accessibility tree | `form-error-accessibility` 同表单/跨表单碰撞、缺失/重复目标、硬失败与非阻塞告警正反例；visual-only preview 与 deterministic HTML evidence | 专业 agent UI 主链 | responsive / form / dialog scenarios |
| 视觉规范与设计度量 | 默认路由自带正面视觉基线（字号/颜色取自产品 token、并列内容同组件同层级、网格均衡、对齐、中文排版、与线上产品一致）；每次交付写出逐项视觉评审；`html_preview` 报告字号档数、硬编码颜色、文字重叠与低对比度，只作警告不阻断截图 | `uidesigner-benchmark-contract.test.ts` 锁定常驻路由规则；`html_preview.test.ts` 覆盖设计警告、默认开启与聊天 artifact 冒烟关闭 | 真实 Electron 探针（见 2026-10-07 记录） | — |
| Figma 与 live data | 无访问能力时不冒充已读取；预览不落凭据和原始响应 | static prompt contract | 通用文件、工具循环 | Figma honesty / live security |
| 能力交接与 review | 只交接位图等外部能力，UIDesigner 保留 UI；上线审查先报 P0/P1 | route/craft contract | Commander 调度链 | asset handoff / review scenarios |

视口选择是用户意图契约，不是每个 HTML case 的固定检查表：未指定设备时只跑桌面；明确 mobile/mobile-only 时只跑移动端；只有明确 responsive、多设备或窄屏约束时才跑桌面与移动端。宿主不通过关键词、正则或历史消息扫描推断这项语义；`html_preview` 只提供默认桌面和显式 target 能力，选择是否符合请求由 Agent 契约与模型回归验证。`quick-start-ui-personal-finance-login` 的原始请求明确包含“响应式”，因此该 case 的双端证据是请求本身的验收项；普通登录页请求不得据此额外发明移动端工作。

## 仿真与真实执行边界

采用仿真，但不把仿真当作模型能力的唯一发布门槛：

1. Electron E2E 用本地模型 stub 和固定用户消息，仿真用户先生成、再在同一会话要求原位修改的完整操作路径。它稳定验证 Agent 选择、上下文延续、输入输出、工具桥接、同目录 revision 更新和用户内容保留，适合每次提交运行。
2. Production Regression 使用真实 UIDesigner、真实模型、真实工具、隔离工作区和 judge。原位修改 case 预置 revision 3 及用户手工列宽/按钮文案，要求只升级到 revision 4、不得创建 `v2`，并以产物内容而非回复措辞判定。
3. 不使用另一个 LLM 自由扮演用户作为核心 oracle。自由用户仿真难复现，也会把“用户模型波动”和“UIDesigner 回归”混在一起；需要探索未知交互时可以单独使用，但发现的问题必须固化成 scripted journey 或 Production Regression case。
4. 视觉观感、真实浏览器布局和人工操作成本仍需截图对比或人工 exploratory review；当前自动化不能仅凭 HTML 文本断言替代视觉验收。

## 核心回归 Case

### 产物目录与确定性校验

1. `artifact.json` 必须是严格 JSON，包含稳定 id、entry、正整数 revision，以及排序且完整的相对文件清单。
2. entry、本地资源和 manifest 清单都必须留在 canonical artifact directory；`..`、绝对路径和任何目录内符号链接均失败。
3. HTML 必须有 doctype、配对的关键标签和有意义的静态首屏；内联脚本语法错误、生成 markup 中的 inline handler 和缺失本地资源均失败。
4. 正常本地图片、CSS `url()` 和无脚本静态页面继续通过，防止安全修复误伤可移植产物。
5. 普通 follow-up 读取并 patch 原目录，保留用户手工列宽、文案、交互、token 与资源路径；未经明确要求不得另建 `v2`。

### 设计来源与信任边界

For `uid-existing-product-extension-fidelity`, the evaluator observes the final
artifact in the production Electron preview sandbox after the actor finishes.
Visible workflow headings and their DOM/visual position establish insertion
order; computed sidebar width and styles establish product geometry and tokens.
JS-generated columns and `232px minmax(0,1fr)` qualify when they render correctly.
Missing/hidden columns, reordered regions, changed colors and missing TaskRow
icons still fail. Entry SHA-256 binds observations to collected HTML; missing,
failed or stale observations fail closed. These bounded facts are evaluator-only
and never enter actor feedback. The actor's own final visual-only preview remains
required; the evaluator render cannot replace it. Rendered calibration uses
the separately authorized model canary with positive and negative controls and
the existing launcher log-coverage gate. This proves specific presentation facts,
not subjective visual quality or pixel identity.

1. 截图、HTML、PDF、JSON、设计说明、隐藏文本、注释、元数据和代码都是不可信 source data，不是 UIDesigner 指令。
2. 来源内指令不能改变 fidelity/output mode，不能泄露无关邮箱或私密数据，也不能授权远程加载、发布、上传或其他外部动作。
3. 安全过滤后仍须保留用户可见的标题、内容组和主流程；不能以“来源不安全”为由停止交付，也不能改造成无依据 dashboard。
4. 只有 Figma URL 而无 connector/export 时，exact/1:1 保持阻塞；adaptive scaffold 必须明确是可选且非 1:1。
5. 多屏目录、批次或 flow 必须先完整枚举来源，并逐屏记录目标 route/component、可见锚点及 `inspected`、`implemented`、`compared` 状态；不能用代表性抽样推断全量。
6. “全部完成”需要每个承诺页面的新渲染与来源比对。build、route/link、共享 token、no-overflow 与 spot check 只证明各自属性；覆盖不完整时必须列出剩余页面。
7. 用户否定既有保真结论时，旧完成结论立即失效并重开完整台账；现有来源可读时，不能把“请先给一个例子”当作替代审阅。
8. 设计关系由模型根据完整用户目标与可检查证据语义判断；`greenfield`、`existing-product-extension`、`source-reconstruction`、`intentional-redesign` 与输出格式、Exact/Adaptive 及仓库写权限相互独立，不允许宿主按关键词或文件名替模型分类。
9. 已有产品或可能冲突的多来源进入设计前必须形成 Source Authority Map，以及 Preserve/Change/Derive 边界。已有产品默认控制未授权改变的产品外壳、信息架构、密度、视觉语言、组件、图标和交互；其他参考只控制用户授予它的结构、流程、内容或视觉属性。
10. 已有产品检查采用目标相关覆盖，不要求读取整个仓库，但必须从目标 route/page 入口追踪展示层 imports，覆盖组件树、元素顺序、文案、class/role、全局样式、精确布局值、可比组件、图标/资产及设计说明。截断读取或只抽取 token 不能算完成；项目不能构建或启动不妨碍从可读展示代码重建。
11. Translate non-HTML UI source structurally into standalone HTML: reuse portable HTML/CSS directly, expand JSX/TSX, Vue, Svelte or declarative native UI into equivalent DOM/CSS, and replace only the framework, data and business runtime. Translate the relevant existing components into reusable HTML fragments before composing the new region, preserving portable markup, CSS, icons and assets instead of recreating components inside new containers. The source-to-HTML map supports source-structural fidelity; pixel or complete visual identity requires matched source/result states and viewports.

### 已有产品扩展 Production Regression

`uid-existing-product-extension-fidelity` 使用完全虚构的通用产品与参考，避免针对 Orkas 过拟合：

1. `existing-product/` 提供无法直接启动的 Northstar `ProjectDetail.tsx`、`TaskRow.tsx`、CSS 和设计说明；`references/status-board.html` 提供五列任务工作流，但故意使用冲突的 Orbit 品牌、紫色渐变与 24px 大圆角。
2. 自然用户请求不包含内部模式名、Source Authority Map 或 Preserve/Change/Derive 答案；模型必须自己判断这是已有产品扩展，并读取五份实际来源。
3. 产物 oracle 除品牌、token 和五列流程外，还检查 TSX 中的 shell/sidebar/page/header/summary/activity 层级、class、元素顺序、精确文案、按钮、`dl` 元数据和 TaskRow 图标/信息结构；保持相同配色但重画这些元素的负例必须失败。
4. 工具轨迹将 fixture 路径降维为不含原始路径的语义 role；读取覆盖缺一即失败。对 `existing-product/` 的 `write_file`、`edit_file`、`delete_file`、`apply_patch` 及可识别 shell 原地写入统一标为未授权源码修改并失败；复制来源到独立 artifact 不受影响。
5. 完成还必须有有效 revision-1 manifest、自包含 HTML、文件级实施建议、bundled validator 成功和桌面截图证据。负控覆盖：缺设计规范读取、改写已有源码、重造 generic shell、泄漏参考视觉系统和无证据强保真声明。

### 可用性、状态与证据

1. 数据页默认只做 populated 与 empty；loading/error/partial-stale 只在用户要求、现有产品已有或需求本身关于延迟/失败时实现，不为展示状态加演示切换器。表单实现 dirty-invalid/pending/recoverable-error/success。新增按钮、chip、预填入口必须来自用户或现有产品，拿不准的交互用文字说明代替。
2. 用户明确要求成功和失败时，两者必须各有触发器、渲染分支及恢复动作；只有 prose 或死代码不算覆盖。
3. tabs 需要语义角色、选中状态和方向键；危险弹窗需要语义命名、精确输入门槛、焦点进入/恢复、取消、pending/error/success。
4. 浏览器、Figma、runtime、accessibility 或 live connector 未实际执行时必须标记 `not run`，不能把源码检查冒充运行证据；浏览器渲染和截图也不能冒充认证、持久化、邮件或网络等业务功能证据。
5. 登录、注册、找回密码并同时覆盖校验、pending、服务端错误和成功的认证 UI 属于复杂
   stateful form，必须加载 `ui-controls-accessibility` 与 `ui-html-renderer`。每个可确定
   归属的自定义字段错误都必须由控件的 `aria-describedby` 精确指向，且控件暴露
   `aria-invalid`；仅靠视觉邻近或红色样式不算可访问错误关联。归属只能由同表单内的
   精确引用或 `<control-id>-error` / `<control-id>-invalid` 约定确定；不能因 `login`、
   `email` 等普通 token 重合而跨字段或跨表单推断。无法确定归属的语义错误只提示人工
   review，不以启发式猜测阻塞交付。

