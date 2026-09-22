# Product selection and unit economics

## Compare a viable business, not just a popular item

- Demand: record query, geography, observation window and the sampled listings. Look for repeated purchase occasions and changes over comparable periods. Content engagement, review counts and rankings are proxies; investigate promotions, seasonality, out-of-stock intervals and paid exposure before inferring durable demand.
- Competition: compare matched pack sizes, variant specifications, realized prices, shipping promises, brand concentration and recent entrants. Define the sample and measure before interpreting; there is no universal concentration or review-count cutoff.
- Differentiation: connect a evidenced unmet use case to a deliverable improvement in product, packaging, compatibility, service or bundle. Reviews generate hypotheses, not specifications or proof that a new design works.
- Sourcing: compare the same specification and quantity across quotations. Track MOQ, sample cost, tooling, lead time, payment terms, defect allowance, inspection, packaging and replenishment. A supplier listing price is not a landed quotation; a badge is not an audit. For an untested supplier, distinguish a sample or existing inspection evidence from committing the production MOQ. Compare the cost/time of resolving quality uncertainty before bulk commitment with inspecting already-purchased stock; the latter cannot reduce the initial exposure. If sample terms are missing, request those terms as the next evidence step without assuming a free sample or an executed purchase.
- Timing and exposure: inventory cash needed, lead time versus selling season, storage, returns, warranty and category-specific requirements. Verify current applicable requirements when decisive rather than assuming one country's rules apply elsewhere.

## Economics with an explicit basis

Use one currency, tax treatment, shipment basis and scenario period. Distinguish per-ordered-unit from per-kept-unit inputs.

For a fixed total budget, add every mutually required allocation before recommending the plan. Prefer one executable base allocation with one amount per required line item and show the arithmetic total. Use ranges only when they materially help the decision; if used, show the minimum and maximum totals and keep both within the stated ceiling. Do not present independent ranges followed only by a claim that their total fits.

- Net item revenue: realized item sales less discounts and revenue reversals. Do not subtract a refund again if the supplied net revenue already includes it. Shipping revenue and taxes collected require explicit treatment.
- Gross profit: net revenue minus the chosen cost-of-goods basis.
- Contribution before acquisition: net revenue minus non-overlapping variable costs: consumed goods, channel/payment fees, fulfillment, packaging, variable support and return handling/loss not already included. Returned goods recovered into inventory and nonrefundable fees need separate treatment.
- Contribution after acquisition: the preceding result minus acquisition cost on the same basis. Do not call it gross profit or net company profit.
- Break-even acquisition cost equals contribution before acquisition. Break-even ROAS is attributable revenue divided by the corresponding available contribution, only with compatible revenue/attribution definitions and positive contribution. Fixed-cost break-even units require positive per-unit contribution; zero or negative contribution has no finite break-even volume at those economics.

Compute with the available calculator or local script for multi-row scenarios. Show base and adverse assumptions for price, acquisition cost, returns and freight. Do not import a platform's default fee rate, fixed margin target or an opaque score as a universal decision rule.

Choose go / watch / pause relative to the merchant's constraints, then choose the earliest validation stage supported by the available inputs. Category comparison narrows hypotheses and evidence gaps. Supplier/sample qualification obtains comparable quotations and tests observable product or packaging criteria. An inventory demand trial becomes actionable only after the merchant's commitment ceiling, a compatible landed-cost and fulfillment basis, and the arrival/observation window are available. At that stage, derive its quantity, spend ceiling, SKU allocation, observation window, success condition and stop condition from those inputs. If an earlier stage is all the evidence supports, make that stage useful and name the smallest result needed to advance. For the locked inventory stage, give only the missing inputs and the formula or decision rule that will use them; do not propose unit ranges, spend ranges or allocation percentages.

## Design references

Domain patterns reviewed: [Sorftime seller agent](https://github.com/DannylydST/sorftime-seller-agent) for demand/competition/cost signal separation and [1688-cli](https://github.com/superjack2050/1688-cli) for supplier discovery fields. Their APIs, commercial data, browser login and purchasing functions are not bundled. The method above is independently authored; no proprietary index or upstream execution workflow is imported.
