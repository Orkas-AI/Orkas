# `quality/` — skill / agent spec validator

Static "block obvious malice + structural breakage" gate that runs before any skill / agent spec lands on disk. **Not a sandbox** — runtime path-sandbox + permission gates remain the actual security boundary. This is the "first 60-80% of explicit malice" filter and the schema-validity check that prompt rules can't reliably enforce.

Agent field ownership and official-source review rules live in
`Common/docs/agent-authoring.md`. This module enforces portable structural
advisories; owning Resource or built-in tests may apply a stricter official
prompt budget.

Skill description shapes are source-specific and mutually exclusive. A user
custom or external portable Skill uses one `description`; a repository-managed
System, Marketplace, or official Agent-private Skill uses both
`description_zh` and `description_en`. The schema rule reports a mixed triple
or an incomplete localized pair, while the official resource inventories make
the bilingual shape a release-blocking contract.

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
│   ├── skill-runner.ts   standard Skill Runner invocation contract
│   └── schema.ts         frontmatter + agent.json shape and guidance checks
└── report.ts             persist / read / delete the per-spec report
                          under <uid>/local/quality_reports/
```

## How to add a new red flag

1. Append a `RuleDef` entry to `rules/red-flags.ts::RED_FLAGS`.
2. Add at least one positive + one negative fixture in
   `test/main/quality/red-flags.test.ts` per `PC/CLAUDE.md` §9 fixture rule.
3. Run `npm test` (NOT `npx vitest` — the wrapper runs Vitest through Electron's embedded Node so native addons use the app ABI).
4. Bump `VALIDATOR_VERSION` in `types.ts` if the change is observable by callers (existing reports written under the old version stay valid).

## Operator policy rules

Custom validation is disabled by default. In Settings → General, select **Rule
file** to reveal the current account's device-local `operator-policy.json`, edit
it, then enable custom validation. **Reload** checks the file again. The file is
not synchronized. It has this format:

```json
{"version":1,"rules":[{"id":"internal_bucket","level":"EXTREME","pattern":"s3://acme-internal","message":"Internal buckets are off limits."}]}
```

Up to 50 rules are accepted. Each pattern is at most 500 characters; optional
flags are a unique subset of `imsu`, and messages are at most 300 characters.
Unknown fields, wrong types, duplicate ids, unsupported versions and invalid
regexes reject the entire file. Rule ids use `[a-z0-9][a-z0-9_.-]{0,63}` and
findings use the separate `operator:` namespace with `source: 'operator-policy'`.
Operator messages are displayed as text, never as a built-in translated hint.

The `features/operator-policy.ts` coordinator owns configuration reads; the
stateless `runOperatorPolicy` API executes compilation and validation in a
terminable Worker. Direct synchronous validator calls with operator rules fail
closed on the main thread. No custom regex executes there. Scans have a two-second
wall deadline, two concurrent slots (no waiting queue), a 64 KiB policy limit,
a 2 MiB input limit, at most 512 findings, and 512 directory entries with depth 32. Linked, oversized
or unreadable directories fail closed. Limits apply only when enabled.

`appliesTo` defaults to `skill_md`, `script`, and `agent_json`. `skill_md` scans
executable fenced blocks, not prose; `script` scans recognized script extensions;
`skill_meta` scans `_meta.json`; `agent_json` scans serialized Agent JSON. This is
static content validation, not runtime access enforcement.

Create, edit, directory/ZIP import and Marketplace installation use the shared
coordinator. Imports validate staging before publication; Agent private Skills
are checked with their owner. EXTREME operator findings, configuration errors,
timeouts and overload cannot be bypassed with force. Repair the file or disable
custom validation to recover. Built-in checks remain additive and unchanged
when disabled; existing built-in-only force behavior remains compatible.

This capability is host-only: configuration is a local desktop preference, not
a Web application SDK or model-visible tool. It does not retroactively scan
already installed content, global/external-package Skills, synchronization or
runtime-generated learned Skills.

## Levels

| Level | Behavior |
|---|---|
| `EXTREME` | Blocks the write. Authoring path retries up to 2 times with structured feedback; install / hand-edit path rejects outright. |
| `MEDIUM` | Writes succeed. UI shows an advisory chip / suggestion. |
| `LOW` | Silent — recorded only in the persisted report. |

The `skill_script_requires_runner` rule is an authoring/publishing contract, not an install migration. Creation, editing, import, and Marketplace upload enforce it. Marketplace installation validates the existing security/schema rules while explicitly omitting this one rule, so historical bundles are restored verbatim rather than rejected or rewritten.

Directory validation is source-aware. Custom and standalone Marketplace Skills
own `_meta.json`; system freshness belongs to the system manifest, and an
Agent-private Skill inherits category and freshness from its parent Agent.
Callers that know the latter sources pass `source: 'system'` or
`source: 'agent-private'` instead of manufacturing standalone metadata.

There is intentionally NO override for EXTREME. If a real use case triggers a red flag, restructure the spec to remove the pattern (typically: accept the path as a user-provided argument rather than hard-coding a sensitive location).

## Things this module does NOT do

- LLM calls / judgment — out of scope (validator is deterministic).
- IO outside `report.ts` — `validateSkillDir` / `validateAgentDir` read the spec they're asked to validate; that's the only allowed FS access.
- Capability cross-check against the tool catalog — deferred to phase 1.
- Similarity check — deferred to phase 2 (embedding-based).
- Outbound HTTP detection — deferred to phase 2 (runtime network sandbox is the right layer).
- Rule *authoring* for the built-in floor is still build-time; teams that need
  their own extra rules use the additive operator layer below.

## Tests

`test/main/quality/` mirrors this directory. Run with `npm test`.

Regression invariant: every existing builtin (marketplace-installed) skill must pass `validateSkillDir` cleanly — there should be no EXTREME flag on official content. If one appears after a rule change, treat it as a rule false-positive first and adjust the pattern; only flag the official skill as actually malicious after a careful re-read.
