# Test infrastructure regression

This module follows `Common/docs/test-case-design.md`. Repository-wide claims
must be derived from the Git-owned and unignored source inventory, and the
discovery mechanism must have its own negative controls. A high file count is
not evidence of coverage.

## Automated evaluation matrix

| Core scenario | Expected result | Unit / contract evidence | E2E | Benchmark |
| --- | --- | --- | --- | --- |
| Production-module discovery | Every tracked or new unignored production artifact under the declared PC roots has an explicit product owner, including code, prompts, locale/data JSON, UI HTML/CSS, known vendored runtimes, built-in Agent/Skill content, launchers, manifests, icons and packaging assets | `test/main/quality/module-review-inventory.test.ts` exercises the real 925-artifact discovery plus synthetic unowned code/resource paths | Not applicable; this is repository infrastructure | Not applicable |
| Ignored/generated trees | Build caches, tests, fixtures, and missing files do not inflate the reviewed inventory; shipped vendored runtimes and their required fonts remain visible | The inventory test includes ignored `.build-cache`/test negative controls, a vendored-runtime positive control, and bounds the real artifact count | Not applicable | Not applicable |
| Discovery failure | A broken Git query or unexpected file-inspection error fails the suite instead of silently reporting an empty or partial inventory; only a real `ENOENT` disappearance race is skipped | Injected non-zero `git ls-files`, `ENOENT`, and `EACCES` results | Not applicable | Not applicable |
| Test entry discovery | New tracked or unignored tests and production-like data/build paths are not skipped by broad directory names | `test/main/util/check-line-endings.test.ts`, runner discovery contracts | Not applicable | Not applicable |
| Agent test-case policy loading | A repository agent must read the complete scenario-first policy in the current task before proposing, defining, reviewing, or changing cases, whether its runtime loads `CLAUDE.md` or `AGENTS.md` | `test/main/quality/test-case-design-policy.test.ts` checks both real entry points and uses apply-only wording plus a code-bounded policy as negative controls | Not applicable; this is an authoring-policy contract | Not applicable |
| Prompt-change governance | Prompt-facing commits declare an explicit audit; direct system-prompt and prompt-producing-code commits also carry confirmed scope, whether they enter through the local hook or pull-request CI | `test/main/quality/agent-engineering-contracts.test.ts` checks file/deletion coverage, producer-code detection, metadata parsing, hook wiring and CI wiring | Not applicable; this is a repository-governance contract | Not applicable |
| Git-hook setup | Repository paths are passed literally, missing Git/hooks remain a harmless no-op, and a locked config does not break dependency installation | `test/main/util/install-git-hooks.test.ts` injects all four outcomes | Not applicable | Not applicable |
| Staged language completeness | Locale-resource or language-registry edits run the existing Main/Renderer i18n cases for the full supported registry; failed cases block the commit. Unstaged validation inputs and inputs changed during checks are rejected, preserving unrelated work | `test/main/util/staged-i18n-gate.test.ts` exercises real Git/hook execution, incomplete translations, placeholder mismatch, partial staging, unavailable runtime and changed inputs; `test/main/i18n.test.ts` and `test/renderer/i18n.test.ts` own language semantics | Not applicable; local commit workflow | Not applicable |
| Windows CLI fixture runtime | A desktop test process that can see `git.exe` but resolves `bash` to the System32 WSL placeholder must still execute Git for Windows shell contracts; command fixtures with `.cmd` launchers must be invoked through their real Windows entry point | `test/main/util/test-runtime-env.test.ts`, the separately authorized model canary, and the separately authorized model canary | Not applicable | Not applicable |


## Full non-model runs and recovery

From the application root, run the existing typecheck, unit/resource, E2E,
platform-native and smoke lanes in sequence:

```bash
npm run test:non-model -- --checkpoint-dir=/tmp/orkas-non-model
npm run test:non-model -- --checkpoint-dir=/tmp/orkas-non-model --resume
```

Native, Office and Electron tests share desktop processes. Do not run another
native or GUI suite concurrently on the same host. The unified entry preserves
its existing lanes and stops at a failed lane. No live model evaluation is added.
Checkpoints cover JS, builtin Python resources and desktop E2E; typechecks,
platform-native and smoke lanes execute afresh. Each family uses a separate
checkpoint namespace so its evidence cannot overwrite another family's progress.
The JS runner uses native Vitest discovery and eight sequential shards by default,
with the existing per-file isolation and worker limit. Use `--batch-count=N`
(1–32) to change granularity; it does not increase concurrency. A direct JS run
can also use `npm run test:js -- --checkpoint-dir=/tmp/orkas-unit-run`.
For JS, file filters and `--maxWorkers=N` are supported; coverage, watch mode,
custom configs/reporters and test-name filters use the ordinary runner.

Python and E2E also use sequential file batches, preserving parameterized cases,
module fixtures and serial tests within a file. Each batch creates a fresh process;
a partial file restarts from its beginning. Every invocation rediscovers actual
case IDs, and their final union must exactly match discovery. Python fingerprints
include its interpreter, standard library and external import dependencies.
Python accepts test paths and `-q`/`-v`; E2E accepts file filters with the default
Playwright config. Debugging, custom configs and other flags use the ordinary entry.
For example, from the application root:

```bash
node scripts/run-python-tests.mjs resources/test -q --checkpoint-dir=test-results/checkpoint --resume
npm run test:e2e -- app_e2e_smoke.spec.ts --checkpoint-dir=test-results/checkpoint --resume
```

Python captures per-case setup/call/teardown output, logging and warnings. E2E
retains worker output, Electron log snapshots and attachments in unique batch
output directories, with structured JSON reports instead of the ordinary HTML
report. The existing log policy gates unexpected errors and unclassified stderr;
warnings remain reviewable. Retry attempts do not qualify an E2E batch for reuse.
Missing or modified reports, captured events, logs or attachments force a rerun.
Tests that consume their own captured output, or dependencies that never send logs
to these captured streams, still need their owning assertions/log review; a
checkpoint does not create evidence for an unobserved stream.

`--resume` reuses only completed batches with intact stdout/stderr and structured
log-analysis artifacts. Failed, interrupted or uncertified batches run again;
warnings remain visible, and skips remain distinct from passes. Each invocation
rediscovers files and verifies that the final batch union exactly covers that
inventory. Source metadata, installed dependency metadata, runtime, environment,
selection or inventory changes invalidate reuse. Private configuration contents
are never read for the fingerprint. Checkpoints expire after 12 hours and are
local to the same host. External service state, native application updates or
OS permission changes are not certified by this fingerprint: start a fresh run
without `--resume` after such changes.

Each invocation keeps a separate report directory, including original failed
attempts, file setup/collection/test durations and log summaries. Successful-case
console replay is suppressed in checkpoint mode, but every record still passes
through the existing worker log analyzer. Exact-line aggregate digests reconcile
raw process stderr with worker-analyzed output; missing or additional bytes fail
the batch without storing raw text in the structured summary. Inspect the reported
warning signatures and raw failure logs; a timing
report alone is not verification evidence. `summary.json` separates newly executed
and reused results, wall time, input-scan overhead and avoided batch execution
time. Input scanning adds overhead, so use checkpoints for long/full runs rather
than tiny local selections. The root entry also records per-lane durations under
`test-results/non-model-*.json`.

Only one invocation may write a checkpoint directory. Cancellation releases its
lock; after a forced kill, confirm no associated run remains before removing
`run.lock`. Old attempt directories are deliberately retained for diagnosis;
remove the whole checkpoint directory when that evidence is no longer needed.

