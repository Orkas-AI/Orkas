# SEO/GEO Agent — repo source

Version-controlled source for the built-in **SEO/GEO agent** (a platform agent, like Video Studio). Design plan: `PC/docs/plans/seo-geo-agent-design-plan.md`.

A built-in agent ships as **platform marketplace content** (DB + COS, `default_install`-seeded into `<uid>/local/marketplace/...`); the repo has no auto-loaded home for the agent.json / SKILL.md. So this directory is the reviewable, testable source of truth, and:

- **Dev / dogfood:** use the built-in marketplace seeding path or dev-mode marketplace tooling to install this packaged source into a dev account.
- **Ship:** publish to the marketplace with `default_install` (dev-mode marketplace tooling) — last-mile, not required for source review or deterministic tests.

## Layout

```
agent.json                       # workflow (4 modes) / skill_list / inputs(url, repo_path) / category=data / output_format=dashboard
skills/                          # all agent-private (ownerAgent: e064dca9e1bd), Python stdlib-only, via bin/run-skill.cjs
  seo-crawl/        crawl.py + url_safety.py   # fetch (SSRF-guarded, proxy-aware) or --file; ~30 on-page fields + text_sample + robots
  seo-tech-audit/   audit.py                   # technical findings + health score
  seo-content/      content.py                 # heuristic content / E-E-A-T / GEO-readiness findings
  seo-schema/       schema.py                  # JSON-LD lint (validate) + template generate
  geo-score/        geo_score.py               # 5-dim GEO citability score + entity-resolution status
  geo-probe/        geo_probe.py               # AI-visibility probe (query-gen + answer-scoring; agent supplies model answers)
  seo-opportunity/  opportunity.py             # one-run keyword opportunity pool + GEO gaps
  seo-monitor/      monitor.py                 # baseline snapshot + drift compare (rule engine)
  seo-report/       report.py                  # merge findings/opportunities/SoV → :::dashboard spec + ACTION-PLAN.md
```

## Modes (agent.json workflow)

- **diagnose** (default = **deep**): crawl → tech/content/schema/geo audits → keyword opportunity pool → dashboard + ACTION-PLAN, then **runs the deep continuation end to end with no confirmation gate** — the AI-visibility probe (comparative share-of-voice vs named competitors) + a bounded sitemap-sampled multi-page pass — and folds the results in. The GEO score is on-page citation-readiness (a clean page scores high) — stated honestly. Cost is just a handful of model calls on the user's own provider/keys; no paid SEO API.
- **quick diagnose** (`quick` / `on-page only` / `seo-only`): only the free single-page on-page chain — no probe, no multi-page, no confirm.
- **monitor**: re-crawl → snapshot → drift-compare vs `baseline.json` → dashboard + Alert; refresh baseline. Schedule via an `auto_task` that dispatches `monitor` (no extra infra).
- **apply** (needs a local repo path): edit source (title/meta/canonical/alt/headings/robots/sitemap/llms.txt/JSON-LD) under a confirm gate + `changelog.jsonl`, then re-test edited files via `seo-crawl --file`. Never commits/publishes.
- **content**: brief → write/optimize (answer-first, quotable, FAQ schema) → self-check → DRAFT (publishing = apply + confirmation).

## Test

```bash
for s in PC/resources/builtin/marketplace/agents/e064dca9e1bd/skills/*; do (cd "$s" && python3 -m unittest discover -s test); done
```

## Dogfood

Install the packaged agent through built-in marketplace seeding or dev-mode marketplace tooling, then run it in the app.

Then in the running app: `@SEO-GEO优化` with a URL (or fill the launch form). The diagnose pipeline runs `seo-crawl → seo-tech-audit + seo-content + seo-schema + geo-score + seo-opportunity → seo-report`, renders a `:::dashboard`, and writes `ACTION-PLAN.md`.

## Status

P0 (diagnose) · P1 (apply/content) · P2a (Core Web Vitals via PageSpeed) · P3 (GEO score + probe) · P3b (one-run keyword opportunity pool + GEO SoV snapshot in the report) · P4 (monitor/drift) — built and verified through the real `bin/run-skill.cjs` against orkas.ai. All skills are Python stdlib-only with zero paid dependency.

**P2b Google Search Console — wired into the agent; needs live GCP config to use.** Standalone `gsearch-console` connector: PC catalog (`connectors/catalog-google.ts`), Server scope (`connectors/oauth/google.py`, `webmasters.readonly`), adapter `bin/gsearch-console-mcp-server.cjs` (list_sites / query_search_analytics / list_sitemaps / inspect_url). The agent now consumes it through the connector umbrella meta-tools (`list_connector_tools` / `call_connector_tool`), which `gconv`/`gmember` sessions can reach: `monitor` pulls real clicks/impressions/avg-position for the URL into the `seo-monitor` snapshot and drifts them as **Measured** findings (`gsc_impressions_dropped` / `gsc_clicks_dropped` / `gsc_position_worsened`, traffic-floored to avoid low-traffic noise); `diagnose` (deep) grounds traffic/keyword/position findings in GSC when connected. Both degrade silently to the on-page-only path when GSC is absent / not the owner / errors.

To use it: (1) approve `https://www.googleapis.com/auth/webmasters.readonly` on the Server's Google OAuth client (GCP consent screen) and enable the Search Console API; (2) in the app, connect "Google Search Console" with a Google account that owns the GSC property.

Note: `gsearch-console` is intentionally NOT in `availability.ts::GOOGLE_CONNECTOR_IDS`. That set is default-off and gates the Gmail-family Google connectors behind their heavier OAuth verification; GSC's `webmasters.readonly` is non-sensitive, so it stays available independently of that switch (and of Gmail's pending verification). Do not "fix" this by adding it to the set — that would hide GSC by default.

**P2c Bing Webmaster Tools — connector + agent wiring landed; needs live config.** Its own provider (NOT Google): Server `connectors/oauth/bing.py` (registered in `oauth/__init__`, scope `webmaster.read`) + `proj_conf.bing_connector_oauth()`; PC catalog entry `bing-webmaster` + adapter `bin/bing-webmaster-mcp-server.cjs` (GetUserSites / GetQueryStats / GetPageStats / GetRankAndTrafficStats; WCF `{d}` unwrap + `/Date(ms)/` normalize). Matters most for **GEO** — ChatGPT/Copilot retrieval runs on the Bing index. The agent uses it symmetrically to GSC: `monitor` pulls per-page clicks/impressions into the snapshot and drifts them (`bing_impressions_dropped` / `bing_clicks_dropped`, **counts only** — Bing's avg-position scale is ambiguous so position is NOT drift-tracked); `diagnose` deep grounds GEO in Bing coverage. Gotchas: Bing has no `http://localhost` loopback exception, so its dev callback uses `127.0.0.1.sslip.io` via a per-provider redirect override (`<PROVIDER>_CONNECTOR_OAUTH_REDIRECT_URI[_DEBUG]` in `connector_oauth_redirect_uri`); the refresh endpoint/grant_type is doc-ambiguous and flagged UNVERIFIED in `bing.py` (verify a real ~1h refresh). Creds live in the global profile only (orkas.ai); `global.secret` is skip-worktree so secret edits never show in git diff.

**Deferred (product decision):** P5 paid sources (Ahrefs / SE Ranking / DataForSEO); marketplace publish as a `default_install` platform agent; multi-page (BFS) crawl.

## Security / cost / stability notes

- Crawl is SSRF-guarded (scheme allow-list, private/loopback/metadata + obfuscated-IP rejection, IP-pinned connections, per-redirect re-validation) and proxy-aware (works through fake-ip proxies; in proxy mode it best-effort rejects hostnames that resolve to real internal IPs while trusting the 198.18/15 fake-ip range). All network calls set explicit timeouts.
- Zero paid APIs. PageSpeed is free (keyless is rate-limited → set `ORKAS_PAGESPEED_KEY`; CWV degrades gracefully and never fails the diagnose). GSC is free/first-party. The GEO visibility probe makes a small, bounded, opt-in set of model calls only when explicitly requested.
- Findings are honest: `Measured` vs `Estimated` vs `User-provided`; every recommendation carries a leading indicator + a failure criterion.
