# Operations and recovery

## Prepare the exact change

Use store + market + object type + product/variant/order ID, current value and timestamp, proposed value, effective dates/timezone, scope and rationale. Keep actual platform field names when preparing an import; without its schema produce a neutral review table, not a claimed upload-ready file.

- Catalog: product/variant and offer are different objects; modify only requested fields. Missing attributes remain missing rather than invented. Finished copy should already carry its factual evidence.
- Price/promotion: distinguish base/sale price, currency, tax basis, coupon conditions, minimum margin supplied by the merchant, stacking and start/end times. Do not invent a discount floor or extend a campaign's budget.
- Inventory: distinguish sellable, reserved, incoming and damaged stock by location. Absolute replacement and quantity adjustment are different operations. A stock snapshot does not authorize changing every warehouse.
- Orders: bind each exception to the order/line and observed fulfillment/payment state. Cancellation, refund, reshipment and message sending are different actions; an instruction for one is not authority for all.

## Platform adaptation

Taobao/Tmall, JD, Pinduoduo, Douyin/Kuaishou, Amazon, Shopify/WooCommerce, TikTok Shop, Shopee/Lazada, AliExpress, eBay, Etsy and Walmart each require their actual market/store IDs and tool contracts. Check which read, preview, write and readback operations the available connector exposes. Distinguish a prepared plan, verified field mapping and tested online operation in the handoff. Unsupported platforms can still receive a neutral change table.

## Scheduling work with finite capacity

For a work plan, model each activity with its duration, responsible resource, earliest availability, dependencies and deadline. Attach the actual means to the activity: a connected order/stock read, a supported write, or a named manual responsibility. This makes the plan executable and prevents an unavailable action or a second worker from being assumed implicitly. Keep warehouse work separate from owner/desk work when different people can actually do them concurrently. Use the available calculator or local computation for a nontrivial sequence.

Derive each start as the latest of resource availability, dependency completion and item availability; finish is start plus the full duration. Latest feasible start is deadline minus duration. A sequence fits only if work on the same resource does not overlap and finishes inside its availability window. Show useful start/finish times and slack in the plan rather than relying on priority labels alone.

Represent a missing item as a conditional availability time: if resolved before the latest feasible start, show the resulting work slot; otherwise give the exception path while preserving other achievable deadlines. Time reserved for investigation consumes capacity when the same worker performs it. When a duration is unknown, label the planning allowance and the consequence if it overruns; an invented buffer is not an observed requirement. Inventory arriving after a promotion starts cannot solve today's availability conflict.

For an inventory/promotion conflict, connect the inventory calculation to a conditional operating action: who can reduce the offer or exposure, by when, and what happens if that capability is unavailable. Merely asking someone to consider stock risk leaves the operational decision unresolved. Separate a feasible manual escalation from an API operation the connected tool does not provide.

A plan describes manual responsibility and supported operations using the actual tool capabilities. It does not create a scheduled job or send an escalation. Use the existing execution path only when execution is requested and supported.

## Execution and uncertainty

Re-read material current values before applying changes when supported; stale or conflicting values require reconciliation with the user's intended outcome. Use the connector's version/precondition/idempotency mechanism when it provides one; do not invent support for it in prose.

Retain successful items on a partial failure. For an ambiguous timeout, query status or read current state using the operation/object identifier before considering a retry. If the result remains unknowable, mark it unknown and explain the next reconciliation step; never blindly replay a refund, stock delta or publication. Rollback is a separate change and may itself require reconciliation/authority under the existing host gates.

Report requested state, actual receipt, readback and residual action separately. No receipt means no execution evidence; a receipt without verifiable final state is applied/accepted with verification pending, not verified success.

Design references: [commerce-agents inventory and pricing Skills](https://github.com/anthropics/commerce-agents/tree/main/merchant-agent/skills) and [Shopify commerce examples](https://github.com/Shopify/claude-for-commerce-examples/tree/main/merchant). Adapted business concepts only; their server, staged-approval implementation and demo data are not installed or substituted for Orkas permissions.
