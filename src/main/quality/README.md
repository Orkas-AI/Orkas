# `quality/` — skill / agent spec validator

Static "block obvious malice + structural breakage" gate that runs before any skill / agent spec lands on disk. **Not a sandbox** — runtime path-sandbox + permission gates remain the actual security boundary. This is the "first 60-80% of explicit malice" filter and the schema-validity check that prompt rules can't reliably enforce.

See `docs/plans/validator-phase-0.md` (deleted after acceptance) for the design rationale.

## Module boundary

All rules + persistence live inside this directory. **Outside callers import only from `quality/index.ts`** — never from `quality/rules/*` or `quality/types.ts` directly. The rule set is implementation detail.

```
quality/
├── index.ts              public API — validateSkillFile / validateSkillDir
│                         / validateAgentSpec / validateAgentDir
├── types.ts              Violation / ValidationReport / Level
├── rules/
│   ├── red-flags.ts      9 EXTREME patterns (credential reads, eval, …)
│   └── schema.ts         frontmatter + agent.json shape checks
└── report.ts             persist / read / delete the per-spec report
                          under <uid>/local/quality_reports/
```

## How to add a new red flag

1. Append a `RuleDef` entry to `rules/red-flags.ts::RED_FLAGS`.
2. Add at least one positive + one negative fixture in
   `test/main/quality/red-flags.test.ts` per `PC/CLAUDE.md` §9 fixture rule.
3. Run `npm test` (NOT `npx vitest` — the sqlite ABI swap is in `npm test` only).
4. Bump `VALIDATOR_VERSION` in `types.ts` if the change is observable by callers (existing reports written under the old version stay valid).

## Levels

| Level | Behavior |
|---|---|
| `EXTREME` | Blocks the write. Authoring path retries up to 2 times with structured feedback; install / hand-edit path rejects outright. |
| `MEDIUM` | Writes succeed. UI shows an advisory chip / suggestion. |
| `LOW` | Silent — recorded only in the persisted report. |

There is intentionally NO override for EXTREME. If a real use case triggers a red flag, restructure the spec to remove the pattern (typically: accept the path as a user-provided argument rather than hard-coding a sensitive location).

## Things this module does NOT do

- LLM calls / judgment — out of scope (validator is deterministic).
- IO outside `report.ts` — `validateSkillDir` / `validateAgentDir` read the spec they're asked to validate; that's the only allowed FS access.
- Capability cross-check against the tool catalog — deferred to phase 1.
- Similarity check — deferred to phase 2 (embedding-based).
- Outbound HTTP detection — deferred to phase 2 (runtime network sandbox is the right layer).
- User-defined red flags — not exposed; the rule list is build-time only.

## Tests

`test/main/quality/` mirrors this directory. Run with `npm test`.

Regression invariant: every existing builtin (marketplace-installed) skill must pass `validateSkillDir` cleanly — there should be no EXTREME flag on official content. If one appears after a rule change, treat it as a rule false-positive first and adjust the pattern; only flag the official skill as actually malicious after a careful re-read.
