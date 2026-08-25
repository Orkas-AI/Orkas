---
ownerAgent: e064dca9e1bd
name: seo-keywords
description_zh: "把 agent 采集到的搜索面建议（autocomplete / 相关搜索 / People Also Ask）归一、去重、分意图、聚类并打分，产出可读的关键词池；用于从种子词发现尚未覆盖的搜索需求。不产出搜索量或难度。"
description_en: "Normalize, dedupe, intent-classify, cluster and score search-surface suggestions the agent harvested (autocomplete / related searches / People Also Ask) into a readable keyword pool. Use to discover demand a site does not yet cover, starting from seed terms. Produces no search volume or difficulty."
---

# seo-keywords

Discover the phrasings people actually use, starting from a seed. `seo-opportunity`
ranks queries a site ALREADY has console data for; this skill is the other half —
it finds queries the site has no data for yet, which is where a new page or a new
site has nothing to rank.

Deterministic and stdlib-only: it does not fetch, call models, or persist.

## The split, and why the agent has to do the harvesting

A Python skill cannot reach the network. So the AGENT harvests and this skill
processes. That division is the whole design — do not ask this skill for data it
cannot get, and do not skip the processing because the raw lists "look fine": a
pool of near-duplicate strings across three surfaces is not research.

## When to use

- The user asks what to write, what to rank for, or which keywords to target.
- A site or page is new, or `seo-opportunity` returned mostly `inferred` /
  `Estimated` rows because no Search Console data exists.

## When NOT to use

- Ranking queries the site already has impressions for → `seo-opportunity`.
- Discovering volume or difficulty. Nothing here measures those. If you HAVE them
  from a source that does, pass them in (below) — but this skill never estimates
  them, and no amount of scoring substitutes for them.

## How to call

1) Harvest with `web_search`, one call per surface per seed. Record each returned
   phrase with the surface it came from:
   - `autocomplete` — prefix suggestions
   - `related` — related searches
   - `paa` — People Also Ask questions

2) Process:
```
echo '{"seeds":["ai agent desktop app"],"brand":"Orkas","domain":"orkas.ai","harvested":[{"query":"best ai agent tools","source":"autocomplete"},{"query":"best ai agent tools for startups","source":"paa"}]}' | "$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" seo-keywords keywords -- --op expand
```
→ `{ ok, data: { summary, clusters:[{head, dominant_intent, size, score, keywords:[{query,intent,sources,score,score_reasons,data_tier,metrics?}]}], rejected:[{query,reason}], data_tier, note } }`

3) Optional — attach volume you already have. Pass `metrics` keyed by keyword (or
   a list of `{keyword, ...}` rows) with any of `search_volume`,
   `keyword_difficulty`, `cpc`, `competition`, plus a `source` label:
```
{"seeds":["crm"],"harvested":[...],"metrics":{"best crm tools":{"search_volume":2400,"keyword_difficulty":61,"source":"dataforseo"}}}
```
Matching is on the normalized keyword, so provider casing and spacing do not
matter. A row that receives metrics is tiered `Measured`; the rest stay
`Observed`. Sources that measure volume include a Search Console export, Keyword
Planner, or a paid API the user already pays for — never this skill, and never
the model's guess.

Own-brand and own-domain queries are rejected: they are brand defence, already
yours to lose, and would crowd out the demand you do not yet serve. Every
rejection names its reason — report the count, never drop them silently.

## Reading the output

- **`data_tier` is per row.** `Observed` means the phrasing exists on the search
  surface — not volume, not difficulty. `Measured` means external metrics were
  supplied for that specific row. The pool-level tier is `Measured` only when
  every kept row has them, `Mixed` when some do; one measured keyword never
  vouches for the unmeasured rest. Never write "high-volume keyword" for an
  `Observed` row, and never estimate the number yourself — say the phrasing is
  observed and name what would measure it.
- **`score` never absorbs `metrics`.** Volume is demand; the score is phrasing
  quality. They stay separate fields so a measured row and an unmeasured one
  remain distinguishable at a glance. Rank by volume when you have it, and say
  which rows you had it for.
- **`score` ranks phrasing quality, not demand** — intent depth, specificity, and
  whether more than one surface returned it. `score_reasons` carries the whole
  derivation; quote it rather than the bare number.
- **`dominant_intent` decides the page type**, not the wording: transactional →
  pricing/signup, commercial → comparison/listicle, informational → guide/answer
  block, navigational → existing owned page (usually not worth new content).
- **A cluster is one page, not one keyword.** Its `head` is the broadest member;
  write for the cluster and let the long-tail members inform the sections.
