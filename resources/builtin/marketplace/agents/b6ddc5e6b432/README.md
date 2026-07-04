# Deep Research Agent — repo source

Version-controlled source for the built-in **Deep Research agent** (platform agent id `b6ddc5e6b432`). Design: `PC/docs/plans/data-research-engine-landing.md` (engine) and the upstream `data-research-engine-plan.md`.

A built-in agent ships as **platform marketplace content**, `default_install`-seeded into `<uid>/local/marketplace/...` at startup; the repo has no auto-loaded home for the agent.json / SKILL.md, so this directory is the reviewable, testable source of truth.

## Why this exists

The 4 data agents (DeepResearcher / KnowledgeManager / SocialResearcher / BrandResearcher) declared a `deep-research` skill but it was a methodology **guide with no code** — no sub-question decomposition, no citation/anti-fabrication pipeline, no cost caps. This bundle adds the missing **deterministic research engine** as a Python-stdlib skill, orchestrated by the agent (the model owns retrieval + synthesis; the skill owns the verification the model must not do on itself).

Three-way split (see the landing plan): **skill** = deterministic spine · **agent workflow** = orchestration (model + `web_search`/`web_fetch`) · **core-agent TS tool** = semantic embedding rerank (NOT in this stdlib skill — a Python subprocess cannot reach the embedder).

The TS tool lives OUTSIDE this bundle (it is main-process code, not a skill script):
`PC/src/main/model/core-agent/research-rerank-tool.ts` (`research_rerank`, `ownerAgent: b6ddc5e6b432` in `tool-catalog.ts`, wired in `runner.ts`). It reuses `kb_embed` (fastembed bge-small-zh, zero new dep) to rank passages by meaning — the semantic second stage after the lexical `compress` skill. Test: `test/main/model/core-agent/research-rerank-tool.test.ts` (`npm test -- --run <file>`).

## Layout

The engine is a **standalone builtin skill**, NOT bundled under the agent. This is
required: `bin/run-skill.cjs` resolves scripts only from `<uid>/cloud/skills/<id>/`
and `<uid>/local/marketplace/skills/<id>/` — it does NOT search
`<uid>/local/marketplace/agents/<agent>/skills/<skill>/`. A skill bundled under an
agent dir is advertised to the model but its scripts are unrunnable ("skill script
not found"). So the engine skill lives at `marketplace/skills/`, where the builtin
seed lands it in `local/marketplace/skills/ee99fbb42964/` (resolvable by id;
`run-skill.cjs` can still resolve the display name `deep-research`).

```
agents/b6ddc5e6b432/
  agent.json                    # thin driver: skill_list=[ee99fbb42964], inputs(task, materials), the research workflow
  README.md
skills/ee99fbb42964/            # the ENGINE (standalone). name: deep-research, shared marketplace skill, Python stdlib-only, via bin/run-skill.cjs
  scripts/caps.py               # [DONE] hard-cap plan (dedup/trim sub-questions, fetch budget, depth guard) + step-cost account
  scripts/academic.py           # [DONE] scholarly retriever: arxiv/OpenAlex/Crossref/Semantic Scholar, https host allow-list, proxy-aware
  scripts/compress.py           # [DONE] context compression: chunk, dedup (exact + near-dup), lexical relevance, budget cap
  scripts/citations.py          # [DONE] anti-fabrication: verify quotes/DOIs/sources, abstain, numbered references
  references/                   # shared research workflow, source quality, scholarly evidence, report/citation guides
  test/test_{caps,academic,compress,citations,pipeline}.py   # 74 unit tests (incl. deterministic e2e)
```

`agents/b6ddc5e6b432` is a thin in-repo driver so the engine is testable via
`@深度研究`. The standalone skill keeps the original marketplace id:
`ee99fbb42964`.

L2 manual regression: `PC/docs/test/deep-research-regression.md`.

## Test

```bash
cd PC/resources/builtin/marketplace/skills/ee99fbb42964 && python3 -m unittest discover -s test -v
```

Python skills are not run by `npm test`; run them directly with `python3 -m unittest` (Python 3.9+, stdlib only).

## Status

- **P1 (engine spine) — DONE.** `citations.py` (anti-fabrication), `compress.py` (context compression), and `caps.py` (hard caps + step-cost accounting) built and unit-tested end-to-end through stdin/stdout. The three deterministic engine steps are wired into the agent workflow.
- **P2 (academic sources) — DONE.** `academic.py` — arxiv / OpenAlex / Crossref / Semantic Scholar via stdlib HTTP over a fixed https host allow-list (a stronger positive guard than a deny-list for these fixed hosts), proxy-aware, explicit timeout, per-source error isolation. Parsers unit-tested; live-verified end-to-end through the Clash proxy (crossref returned real cited papers; slow/rate-limited sources degrade into `errors`). PubMed E-utilities is a possible follow-up.
- **P4 (orchestration + regression) — DONE.** agent.json workflow orchestrates the full 6-step flow (frame+`caps.plan` → gather+`academic`+`caps.account` → `compress` → draft → verify(`citations`) → deliver). `test_pipeline.py` is a deterministic e2e proving the four scripts compose (academic record → compress source → citations verify; caps wraps). L2 manual case list at `PC/docs/test/deep-research-regression.md`. **74 unit tests total, all green.**
- **P3 stage ① (semantic rerank) — DONE.** `research_rerank` core-agent TS tool (bi-encoder embedding similarity via `kb_embed`, zero new dep), owned by this agent, wired into the workflow after `compress`. Typecheck clean; 9 unit tests green. Stage ② (cross-encoder ms-marco rerank + evidence vector store) is deferred — it needs a new model dependency (discussion required) and the bge-small-zh embedder is Chinese-tuned, so its English-source lift needs evaluation first.
- **P4b (share to the hosted data agents) — DONE IN REPO.** The hosted Resource data agents keep depending on the original marketplace skill id `ee99fbb42964`. The old Resource source copy was removed and replaced by the platform builtin skill source at the same id.

## Publishing the engine into the shared data agents (P4b)

The Resource data agents depend on `ee99fbb42964` directly. To publish this
engine:

1. Upload the builtin skill id `ee99fbb42964` first. The Resource sync script
   scans `PC/resources/builtin/marketplace/skills/<id>/`, preserves that id on
   upload, and orders skills before agents.
2. Upload Resource and builtin agents only when their own uploaded content
   changes. A skill-only content upgrade does not require agent version bumps.
3. **Semantic rerank IS shared** (via the array `ownerAgent`). `tool-catalog.ts` widened tool `ownerAgent` to `string | string[]`, and `research_rerank`'s owner list is `DEEP_RESEARCH_AGENT_IDS`. Keep that list in sync with hosted agents that should see the tool. Keep it an array — do NOT drop `ownerAgent` entirely, or the tool leaks to the commander and every agent.
4. Verify on a dev account: reconcile pulls the upgraded skill, `run-skill.cjs deep-research <script>` resolves through each agent, and the guide `references/` still render.
