# VOC themes and denominators

Derive labels from the corpus. A useful starting taxonomy is quality/durability, function/usability, specification/compatibility, packaging/logistics, support, price/value, expectations and reported safety incidents. Add purchase scenario, positive driver and objection only when the text supports them. Leave demographic attributes unknown unless explicitly present; do not infer age, gender or income from writing style or product type.

Keep rating statistics separate from inferred sentiment. Disclose rating scales and the rule for any positive/neutral/negative rating bands; do not average incompatible scales. For multi-label themes, count unique reviews mentioning a theme, state the denominator, and explain why percentages can sum above 100%. Missing text is not neutral sentiment.

A negative-only export estimates themes among supplied complaints, not customer defect prevalence. Small, incentivized, default-rating, historical or selection-biased samples need explicit scope. A vivid complaint may be severe but not common. Compare variant and period groups before describing the product overall; do not let a larger healthy SKU hide a smaller failing variant.

Reference: [review-analyzer-skill](https://github.com/buluslan/review-analyzer-skill), for separating labels, evidence and actionable reports. This independently authored taxonomy does not import its runtime, fixed chapter count, demographic guesses or third-party API dependencies.
