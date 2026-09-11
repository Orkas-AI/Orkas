---
ownerAgent: e064dca9e1bd
name: seo-backlink-value
description_zh: "外链价值计算器：给定对方站点的 DR/DA、月流量、自然搜索占比、流量趋势、域龄和报价，先做质量一票否决（僵尸站、刷量、链接农场、未收录），再按 DR 档×流量档给出 25/50/75 分位价格带，按外链类型折算并判定报价是捡漏、合理、可议价还是买贵了；支持多条外链排序。用于“这条外链值不值”“guest post 报价 200 美元贵不贵”“这几个外链先买哪个”。不抓取任何付费指标。"
description_en: "Backlink value calculator: from a site's DR/DA, monthly traffic, organic share, trend, domain age and the seller's quote, apply a veto quality gate (zombie, inflated traffic, link farm, de-indexed), place it in a DR x traffic bracket, return a 25th/50th/75th percentile price band adjusted by link type, and judge the quote as bargain, fair, negotiate or overpriced; ranks several offers. For 'is this backlink worth it', 'is $200 for this guest post too much'. Fetches no paid metrics."
---

# seo-backlink-value

Value a backlink offer the way a buyer should: veto bad sites first, then price
the good ones against a market band and the seller's quote. Deterministic,
stdlib-only, no network. The agent supplies the metrics; this skill only
computes.

## When to use

- The user has one or more link offers (guest post, homepage/sitewide, niche
  edit, directory listing, nofollow/sponsored) and asks whether to buy, what a
  fair price is, or which to buy first.
- A strategy or off-page recommendation needs a defensible price ceiling for a
  proposed link placement.

## When NOT to use

- Discovering candidate sites or fetching DR, traffic, or keyword data. Those
  come from the user, a connected console, or a paid tool the user already has;
  this skill has no data source of its own.
- On-page, technical, or GEO scoring of the user's own site (`seo-tech-audit`,
  `geo-score`).

## Acquire the metrics before calling (agent work)

The user should not have to look numbers up. Fill each offer's metrics in this
order and record the source of every value in `sources`:

1. **A connected SEO data provider** (Ahrefs, Semrush, Moz, DataForSEO,
   SimilarWeb, SE Ranking) through the connector tools: list the connected
   tools, call the domain-overview / backlink-profile operation, and map DR or
   DA, monthly organic traffic, organic share, trend and referring domains
   into `metrics` with `sources` naming the provider. These are the only
   figures that may be reported as provider-measured.
2. **Free public endpoints with `web_fetch`** when no provider is connected.
   Pass what they return in `proxies`; the skill converts them into
   conservative tier estimates and labels the whole result `public_proxy`:
   - Popularity rank and 30-day history: `https://tranco-list.eu/api/ranks/domain/<domain>` → `{"domain","ranks":[{"date","rank"}]}`. Put the latest `rank` in `proxies.tranco_rank` (or `null` when the response lists no ranks) and the full array in `proxies.tranco_history`.
   - Domain age: RDAP. Look up the TLD's server in `https://data.iana.org/rdap/dns.json`, then fetch `<server>/domain/<domain>` (for .com/.net: `https://rdap.verisign.com/com/v1/domain/<domain>`) and pass the `registration` event's `eventDate` as `proxies.rdap_registration`.
   - Indexation: a `web_search` for `site:<domain>`; pass the visible result count as `proxies.site_results` (0 leaves indexation unknown). Set `metrics.indexed: false` only from verified index-status evidence, not search absence.
   Organic share has no free source; leave it out and say so.
3. **Ask the user** only for what steps 1–2 could not supply, naming the
   exact field. Never scrape the web UI of Ahrefs, SimilarWeb, Semrush or Moz
   free checkers: they are login- or CAPTCHA-gated and their terms forbid it.

## Preconditions

- Python 3.9+ (stdlib only).
- Per offer: `domain`, and at least `dr` (or `da`) and `monthly_traffic` — supplied in `metrics` or derivable from `proxies` (a Tranco rank is enough for both).
  Optional: `organic_share` (0–1 or percent), `traffic_trend` (fraction over
  the last months, e.g. `-0.2`), `domain_age_years`, `outbound_links_on_page`,
  `relevance` (`high|medium|low` to the buyer's topic), `indexed` (bool),
  `link_type`, `quoted_price_usd`, `market_prices` (observed listing prices
  of comparable sites, at least five to replace the reference table),
  `sources` (`{metric: provider}`), `proxies` (see above) and `as_of`
  (ISO date used to turn the registration date into an age; defaults to today).
- Supplied metrics always win over proxies. Seller-claimed figures are
  `sources: "seller"` and stay Estimated. Without `dr` and `monthly_traffic`
  from any of the three steps the skill returns `insufficient_evidence` and
  names what is missing; nothing is guessed.

## How to call

Evaluate one offer (payload on stdin or `--input <file>`):
```
echo '{"domain":"example-blog.com","link_type":"guest_post","quoted_price_usd":150,"metrics":{"dr":45,"monthly_traffic":30000,"organic_share":0.62,"traffic_trend":0.05,"domain_age_years":6,"relevance":"high"}}' | "$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" seo-backlink-value backlink_value -- --op evaluate
```
With public proxies instead of provider metrics:
```
echo '{"domain":"example-blog.com","link_type":"guest_post","quoted_price_usd":150,"proxies":{"tranco_rank":120000,"tranco_history":[{"date":"2026-08-10","rank":131000},{"date":"2026-09-08","rank":120000}],"rdap_registration":"2018-04-02T00:00:00Z","site_results":860}}' | "$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" seo-backlink-value backlink_value -- --op evaluate
```
→ `{ ok, data: { domain, link_type, type_multiplier, metrics, metric_sources:{metric: "supplied"|"<provider>"|"tranco_rank_proxy"|"tranco_history_proxy"|"rdap"|"site_search_proxy"}, gate:{status:"pass"|"avoid"|"insufficient_evidence", reasons[], missing_metrics[]}, quality:{score, tier, components}, market:{bracket, dr_tier, traffic_tier, guest_post_band_usd:{p25, median, p75}, data_tier, basis}, adjustments:[{code, factor, detail}], value_band_usd:{p25, median, p75}, quoted_price_usd, quote:{verdict, detail}, data_tier:"observed_market"|"reference_table"|"public_proxy"|"insufficient_evidence", notes[] } }`

Rank several offers (a shared `market_prices` list applies to every candidate
that has none of its own):
```
echo '{"market_prices":[90,120,150,220,400],"candidates":[{"domain":"a.example","quoted_price_usd":120,"metrics":{...}},{"domain":"b.example","metrics":{...}}]}' | "$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" seo-backlink-value backlink_value -- --op rank
```
→ `{ ok, data: { candidates:[{...evaluate result, rank}], buy[], negotiate[], avoid[], needs_metrics[] } }` — passing sites first by quality per dollar, then sites missing metrics, then vetoed sites.

## Method

1. **Quality gate (veto).** `zero_traffic` (< 100 visits/month), `inflated_traffic` (organic share < 15% with material traffic), `link_farm` (DR ≥ 40 with < 500 visits), `deindexed`. Any reason → `avoid`; the band is still returned for reference only.
2. **Market band.** 8 DR tiers × 6 monthly-traffic tiers = 48 brackets. With ≥ 5 `market_prices` the band is the 25th/50th/75th percentile of those observations (`data_tier: observed_market`); otherwise an embedded guest-post reference table supplies the median with p25 = 0.6× and p75 = 1.6× (`data_tier: reference_table`, always Estimated).
3. **Refinements.** organic share ≥ 60% +10%; traffic trend ≤ −15% −15%; domain younger than 1 year −10%; more than 50 outbound links on the page −10%; relevance high +10% / low −20%.
4. **Link type.** guest post ×1.0, homepage/sitewide ×1.3, niche edit ×0.7, directory ×0.5, nofollow ×0.4. Nofollow passes no authority; its value is referral traffic and trust only.
5. **Quote verdict.** ≤ p25 `bargain`, ≤ median `fair`, ≤ p75 `negotiate`, above `overpriced`; no quote → the median is the fair offer and p75 the walk-away ceiling.

## Reporting

- Present the verdict, the three-point band with its labels (bargain ceiling / fair market / do not buy above), the quality score and tier, and the gate reasons verbatim.
- Label every input by source (`metric_sources`) and the band by `data_tier`. A reference-table or public-proxy band is Estimated and must say so; a `public_proxy` result also states that authority came from popularity rank and that the median is a ceiling until DR is confirmed. Only a band from supplied observed listings may be called market-based, and only provider figures may be called provider-measured. Never call any of it Measured.
- When the gate says `avoid`, lead with the reason; price is irrelevant.
- Quality tiers: strong ≥ 75, solid ≥ 50, weak ≥ 30, poor below; `avoid` replaces the tier when the gate fails.
