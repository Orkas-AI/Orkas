---
name: product-dev
description_zh: "在现有代码仓库中实现聚焦的产品工程变更，从已确认需求推进到测试、评审、调试、迁移和证据化交付；用于功能、缺陷、重构和技术决策，不用于模糊需求探索、一次性演示或仓库运营。"
description_en: "Implement focused product-engineering changes in an existing repository from accepted requirements through tests, review, debugging, migrations, and evidence-backed handoff. Use for features, bugs, refactors, and technical decisions; not vague discovery, disposable demos, or repository operations."
---

# 产品研发

把已经明确的产品行为或工程问题转成可审查的技术决策、聚焦代码变更、工程验证和真实交付证据。本 skill 负责工程执行纪律；产品方向探索、一次性 demo、产品级验收定义和 GitHub 维护分别交给对应能力。

## 何时使用

- 从 PRD、issue、设计或明确目标实现功能。
- 修复 bug、失败测试、CI/build、性能或回归问题。
- 做有行为约束的重构、代码评审或技术方案审查。
- 需要 ADR、spike/POC、迁移、兼容性、依赖或回滚决策。
- 实现后需要工程测试、diff 自审和可审计交付。

不要用于仍缺核心用户、问题或成功标准的产品探索；不要把产品验收场景等同于工程自动化测试；不要自动提交、推送、发布或操作外部系统。

## 边界先行

- 如果目标用户、核心问题、期望结果或成功证据仍是产品选择，不编造推荐 MVP、PRD、功能范围、架构或代码；只指出最小缺口，并路由到产品需求分析。
- 如果用户明确要一次性、可丢弃、用于理解度或想法验证的 demo，不生成实现工件，也不套用生产研发流程；把时间盒、可点击性、可丢弃性和验证问题原样交给原型验证能力。
- 只有当行为或工程问题明确到可以从仓库继续求证时，才进入下面的研发主线。

## Finite Input Fast Path

当任务只有用户明确列出的有限输入文件、确定的输出路径，且不要求代码或仓库行为变更时，按材料处理快速路径执行：

1. 读取一次本 skill 后，直接按工具上限批量读取全部指定输入；多个独立批次尽量在同一模型轮并行发出。
2. 写入指定交付物，只回读该交付物一次做聚焦验证，然后结束。
3. Skip generic repository discovery：不搜索仓库规则、manifest/CI，不运行 Git/分支/基线/diff 探测，也不扩展到未指定文件。
4. 不用 `manage_execution_plan` 叙述有限批次的进度；只有存在真实依赖链、跨边界实现或高风险决策时才建计划。

这个快速路径只减少与任务无关的工程仪式，不跳过用户指定输入、输出验证或安全边界。

## 执行主线

1. **建立工程合同**：区分 feature、bug/test failure、refactor、review-only、performance、decision/spike、CI/build；明确目标、非目标、不变量和完成证据。
2. **先建立仓库地图**：读取[仓库接入检查](references/repository-intake.md)，确认规则、脏工作区、构建测试入口、相关符号/调用路径和现有模式。
3. **风险分支前置**：仓库地图显示依赖、迁移、兼容、安全、外部副作用、不可逆操作或大影响面时，在首次相关安装或编辑前读取[变更安全](references/change-safety.md)；没有这些风险时跳过。
4. **先决策后编辑**：存在关键取舍时读取 ADR、spike 或 decision review；多文件/跨边界任务先写短计划，小修复直接给出最小变更路径。
5. **实现与快速反馈**：读取[实现与快速反馈](references/implementation.md)；先基线或复现，再小步编辑，每个切片后做便宜且聚焦的检查。
6. **按结果深入**：失败路径读取 debugging；实际工程测试读取 engineering-tests。
7. **提交前独立复核**：读取[评审与完成门禁](references/review-and-finish.md)，从完整 diff 和验收—证据矩阵重新判断，不沿用“实现已经正确”的假设。

## 渐进路由

| 场景 | 读取 |
|---|---|
| 仓库规则、工作区状态、命令入口、模块/符号/测试地图 | [仓库接入检查](references/repository-intake.md) |
| 技术选型、架构边界、不可逆决策、ADR | [架构决策](references/architecture-decision.md) |
| 技术预研、POC、spike、可行性结论 | [技术预研](references/technical-spike.md) |
| 上线前追问、隐藏假设、方案取舍审查 | [决策复核](references/decision-review.md) |
| 阶段、任务、直接依赖、研发交接 | [研发模板](references/product-dev-template.md) |
| 编码、TDD、小步实现、快速反馈 | [实现](references/implementation.md) |
| Bug、失败测试、回归、异常行为 | [调试](references/debugging.md) |
| 单元/集成/契约/E2E/构建等工程验证 | [工程测试](references/engineering-tests.md) |
| 依赖、迁移、兼容、安全、外部副作用、回滚 | [变更安全](references/change-safety.md) |
| diff 评审、完成门禁、证据化交付 | [评审与完成](references/review-and-finish.md) |

只读取当前分支需要的 reference，不一次加载全部材料。

## 证据状态

每个完成标准只能处于以下一种状态：

- **已验证**：本轮运行或直接观察到的新鲜证据，附命令/观察与结果。
- **静态支持**：代码、类型或配置检查支持，但未执行真实行为。
- **未验证**：缺环境、凭据、设备、服务或时间，写明阻塞和剩余风险。
- **失败**：检查真实失败，不用重试次数掩盖，也不改写为“基本通过”。

证据只证明它所对应的代码与配置版本。后续任何可能影响该验收项的修改都会使既有测试、构建、trace、渲染、截图或交互证据失效；最后一次相关修改后必须重跑同一验证链并检查新输出。无法重跑时把该项标为未验证，不沿用修改前的成功证据。

## 质量门槛

- 用户指令和最近作用域的仓库规则已读取并遵守。
- 用户已有改动得到保留，diff 中没有无关重构或格式噪音。
- 每项验收要求都有证据、明确替代证据或未验证说明。
- 新依赖、迁移、数据/安全/兼容/回滚影响得到比例化处理。
- 完成结论与本轮真实输出一致，没有伪造测试、构建、性能或 UI 结果。
