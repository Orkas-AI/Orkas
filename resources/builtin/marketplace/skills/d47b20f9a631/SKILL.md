---
name: ecommerce-operations
description_zh: "准备电商商品、价格、促销、库存和订单异常的具体操作方案，通过已连接且支持该动作的工具执行并核对结果；用于运营执行与变更预览，不负责选品、文案或经营归因。"
description_en: "Prepare concrete ecommerce catalog, price, promotion, stock and order-exception changes; apply and verify them only through available connected tools supporting the action. Use for operating changes and previews, not selection, copywriting or analytical diagnosis."
category: ecommerce
---

# Ecommerce Operations

1. Resolve store, channel/market, exact object/variant, desired change, effective time and existing authorization. Uploaded records support preparation; current connected reads support live preconditions.
2. Read [operations and recovery](references/changes.md). Prepare a field-level before/after preview and verify product identity, quantities, price basis, dates and relevant store conditions.
3. Discover the actual connected tool contracts. A platform name in this Skill does not provide an adapter. Without the necessary action, finish the usable preview/import draft and state the missing connection or operation. Do not claim a store change or improvise a fake API via shell/web.
4. For supported authorized actions, use the host's existing permission gates once. Preserve returned operation/item identifiers, reconcile partial or uncertain results and read back final state when supported.
5. Return per-item prepared/applied/verified/failed/unknown states with evidence and next actions. A request receipt or accepted job is not necessarily a completed write.

This Skill contains no bundled live connector. It works with supplied records across channels and conditionally with tools already available in the session. It neither adds recurring automation nor expands permissions, spend, targets or promotion budgets.
