# Reconciliation and metrics

## Normalize before aggregating

Record source, market/store, currency, timezone, date basis, grain (order, line, payment, refund event, inventory snapshot or ad aggregate), keys, reporting window and inclusion criteria. IDs are namespaced by source/store. Detect overlapping exports, missing keys, unmatched refunds, duplicate joins and canceled orders. Aggregate child rows to the appropriate grain before joining to a parent amount; shipping/tax/order-level discounts repeated on every line must not multiply.

Treat refunds as financial events and returns as physical events. Use the report's basis: a net-sales field may already include reversals; a settlement can include fees or payments for sales in another period. A date-window refund rate and an order-cohort refund rate answer different questions. Reconcile both only when linkage exists.

## Definitions to declare

- Gross item sales: item price × quantity on the specified order basis, before discounts and reversals. Do not equate paid GMV, placed GMV, net sales and bank settlement.
- Net item sales: gross item sales less discounts and sales reversals, unless the supplied source already reports this net value. Disclose shipping and tax treatment.
- Gross profit: net revenue minus the chosen goods cost basis.
- Contribution profit: net revenue less non-overlapping variable goods, channel/payment, fulfillment, packaging, return handling and acquisition costs. Report known-cost contribution when costs are incomplete; net company profit also needs overhead and the chosen accounting basis.
- AOV: declared revenue numerator divided by eligible orders, not lines or units. Conversion: declared converted population divided by the corresponding visits/clicks. Zero denominators are undefined, not zero performance.
- Refund amount ratio: refund amount / comparable sales amount. Returned-unit rate: returned units / cohort shipped units. Repeat purchase: customers with qualifying repeat orders / eligible customer cohort and window. These are distinct from one another.
- ROAS: platform-attributed revenue / spend within its attribution window. Do not sum overlapping attributed revenue across ad platforms as unique store sales. TACOS needs total compatible store sales. Neither metric proves incremental effect.
- Sell-through and turnover: declare units/cost basis and available/average inventory definition. Stock cover uses sellable available units and an explicit demand rate; zero demand makes days-of-cover undefined. Reserved, damaged and inbound stock are separate states. End-of-period stock alone is not average stock.

For channel totals sum numerators and denominators before computing a rate; do not average unequal group rates. Keep currencies separate without a dated conversion basis. Match partial periods and refund maturation before interpreting change.

## Generate the explanation from a change bridge

For a profit-change question, reuse the normalized calculation rows to build a signed bridge: revenue change minus each non-overlapping cost change equals contribution change. Sort the measured effects by absolute size to select the main drivers for the narrative; smaller effects can be grouped with their subtotal. Carry any unexplained residual explicitly instead of forcing the bridge to balance or dropping a large cost because another story seems more interesting.

Separate that accounting identity from the reason a component changed. Higher goods cost can reflect more units rather than a higher unit cost; compute per-unit values when the units are comparable. Mix shifts and advertising attribution suggest investigations, but do not identify SKU margins or incremental lift without the corresponding data. Derive the next actions from the material measured effects and those unresolved explanations.

Reference: [commerce-agents performance insights](https://github.com/anthropics/commerce-agents/tree/main/merchant-agent/skills/performance-insights) for source-grounded comparisons; [Fivetran dbt Shopify](https://github.com/fivetran/dbt_shopify) for separate order/line/refund/ad models. No dbt runtime, connector or fee assumptions are imported.
