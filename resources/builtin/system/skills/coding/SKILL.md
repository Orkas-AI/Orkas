---
name: coding
description: "Use for implementing or changing code in an existing project, including features, bug fixes, refactors, interfaces, engineering configuration, build files, and tests. Ground the work in repository guidance and surrounding code, make focused changes, verify proportionately, and review the final diff. Do not use for explanation-only requests or disposable one-line scripts."
---

# coding

The discipline for editing a real codebase well — the difference between a script that runs once and a change that is correct, conventional, and verified. The raw tools (read/edit/write, bash) are already yours; this is the engineering judgment on top of them.

## When to consult this skill

`read_file <SYSTEM_SKILLS_ROOT>/coding/SKILL.md` whenever you are about to:

- change more than one file, an interface, storage, or security-relevant code;
- fix a bug, refactor, add a feature, or add/adjust tests in a project;
- edit any project that carries its own conventions (CLAUDE/AGENT(S) guidance files, package.json, build).

Skip it for a trivial one-liner or a throwaway script whose output you can eyeball this turn.

## 1. Ground in the project first

Before editing, read the conventions that govern the files you will touch and obey them — they override these defaults:

- First discover and read project guidance files for coding agents before general code exploration: `CLAUDE.md` / `claude.md`, `AGENTS.md` / `agents.md`, and `AGENT.md` / `agent.md`, then any applicable `README`. Walk from the target file's directory up toward the project root; conventions are scoped to that directory's subtree, the most-deeply-nested one wins on conflict, and an explicit user instruction wins over all.
- The nearest well-formed sibling or similar file. Mirror its idioms: naming, structure, the i18n mechanism, the cache-bust/versioning convention, error handling, where tests live.
- Confirm a library or helper is already used here before reaching for it (check the imports and the package manifest). Never assume a dependency is available.

## 2. Plan with the structured tool, not prose

For multi-step or multi-file work, use the durable plan/TODO tool (`manage_execution_plan`). Skip planning for the easiest ~25%; never write a single-step plan. Keep exactly one step in progress, mark steps done as you finish them, and do not re-paste the plan after updating it.

## 3. Edit minimally

Fix the root cause, not the symptom. Keep the change small, focused, and in the codebase's existing style. Do not gold-plate, rename, or reformat beyond the task, and do not add license headers or comments unless the codebase or the user asks for them.

## 4. Verify — three escalating tiers

Never report success on unverified code, and never fake a green result.

- **Cheap checks on what you changed — always.** Syntax/compile of the edited files (`node --check`, `tsc --noEmit`, `python -m py_compile`), lint those files, and run the one targeted test. These are fast and catch the dumb breakages (a syntax error, a missing import).
- **Run the thing — or say you could not.** Execute the test/script/app and read the real output. If there is genuinely no way to verify (no tests, cannot run it), say so plainly rather than implying success. In an interactive turn, suggest the heavy suite/build instead of auto-running it when it is slow; in autonomous runs, run it. Do not add tests or a formatter to a project that has none, and do not fix unrelated breakage (mention it instead).
- **Adversarial pass for substantial / high-stakes changes.** For production, security, payment, data, or wide-blast-radius changes, get a second pair of eyes that the implementer is not grading: spawn an **ephemeral verification worker** — `run_worker({ task })` with no `to` — so it runs headless and hands a verdict back, then is purged. It is the commander's hands, not a standing agent. Its brief must state: (1) **do not modify the project** — read, build, run, and probe only; any throwaway script goes to a temp dir; (2) its job is to *break* the change, not confirm it — try the inputs the implementer did not (boundary, empty, idempotency, concurrency, orphan refs); (3) **every PASS must carry the exact command run and its real output** — a PASS with no command output is a skip, and "the code looks correct" / "probably fine" are not verification; (4) return a per-check PASS/FAIL with evidence. A one-off script needs none of this — match rigor to stakes.

## 5. Self-review the diff

Read your whole diff before reporting done. Check cross-file consistency: every call site, every locale, every sibling changed the same way; no dead code, duplicate keys, leftover debug output, or half-applied renames.

## 6. Ambition vs precision

Greenfield, with no prior context: be bold and creative, including UI — avoid flat, average "AI slop". An existing codebase: be surgical, preserve the established patterns and design system, and do exactly what was asked.

## When it is bigger than one turn

If the job is too large, long-running, or parallel for a single turn — a whole-repo refactor, a big migration, a multi-hour build — and a CLI coding agent (Claude Code / Codex) is configured in the agents list, hand the job to it (`dispatch_to` / `hand_off_to`) rather than grinding it inline. Default to doing the work yourself; escalate only when the scope genuinely exceeds one turn.

## Definition of done

Cheap checks green; the change run (or honestly reported as un-runnable); conventions matched; diff self-reviewed; and for outward-facing actions (commit / push / publish) confirm first. Report what you verified and what you could not, plainly.
