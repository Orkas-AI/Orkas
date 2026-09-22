---
ownerAgent: 1040b336306f
name: trade-control
description_zh: 生成并校验 A 股、港股、美股订单草稿，覆盖行情时效、现金与持仓、手数、T+1、限额、集中度和 live 授权；默认分析或模拟，不在校验脚本中下单。
description_en: Build and validate A/HK/US order drafts for quote freshness, cash, holdings, lot size, T+1, limits, concentration, and live authorization; default to analysis or paper mode and never submit from the validator.
---

# Trade Control

Read with `market-data` whenever an order, paper trade, broker account, or live
execution is mentioned. Analysis permission is not trading permission.

## Draft and validate

Prepare JSON with `order`, `quote`, `account`, and `policy`. Quote timestamps
must be ISO-8601 with timezone. `mode` defaults to `paper`; a live draft also
needs `explicit_user_authorization: true` and `policy.allow_live: true`.

```bash
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" market-data stock -- validate-order --input order.json
```

The deterministic validator checks positive integer quantity, order price,
quote staleness, buying power or sellable shares, configured order/position
limits, A-share buy lots and T+1 sellable quantity, and explicit live mode. Hong
Kong lot size is security-specific and must come from current instrument data;
absence blocks a buy rather than assuming 100.

An `allowed` result means only that the declared checks passed. Reconfirm the
symbol/listing, side, quantity, order type, limit, time-in-force, market session,
fees, currency, mode, and connector account in the visible order summary.

## Execution boundary

- Default to an order draft or the broker's paper environment.
- Submit live only after the user explicitly authorizes that exact visible
  order in the current task and the connected broker exposes the permission.
- Never put credentials in chat, files, commands, or reports.
- Never bypass a violation, convert an order type, split an order, or retry a
  rejected live order without new authorization.
- After any submission, read back broker order ID, state, filled/remaining
  quantity, average price, timestamp, and rejection reason. Report uncertainty
  instead of claiming success when readback fails.

The Skill does not implement unattended/autonomous live trading.
