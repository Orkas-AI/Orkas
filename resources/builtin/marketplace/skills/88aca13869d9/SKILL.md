---
name: github
description: Use GitHub CLI for basic GitHub operations: inspect issues, pull requests, CI runs, releases, and GitHub API data. Use this whenever the user asks to list, view, create, update, or check GitHub repository data.
---

# GitHub

Use `gh` as the primary interface for GitHub data and actions. Keep this skill focused on basic operations and command safety, not maintainer triage strategy.

## Before Running Commands

- Confirm `gh` exists and is authenticated when live GitHub data is required.
- Prefer `--repo owner/repo` unless the current directory is clearly inside the intended GitHub repository.
- Use `--json` and `--jq` when the result will be summarized or filtered.
- Read-only inspection never needs approval. Resolve the repository, exact object, current state, policy, and relational targets before a write.
- A current user request authorizes the exact write, direct target, relational target, and stated conditions it specifies. Do not add a second confirmation after preflight succeeds.
- If the repository or target is unresolved, ask only for the missing target and retain the action authority already granted by the request.
- When owner/repository itself is missing, ask directly for `owner/repo`; do not substitute a local checkout path, account hint, account switch, or organization search for that canonical target.
- Bound target discovery to supplied references and the current repository remote. If those do not resolve owner/repository, ask immediately; do not enumerate accounts, organizations, or unrelated repositories.
- Ask for new approval only when execution requires a material scope expansion, such as a different repository or object, an extra write, force mode, or admin override. For force/admin/policy-bypass decisions, leave the choice unselected or default to stopping with state unchanged; do not offer a speculative retry or preselect escalation.
- Honor authentication, permission, deletion, billing, or other platform-required confirmation gates exactly once; do not duplicate them in prose.
- For a finite maintainer request, batch independent preflight reads in one tool round, authorized independent writes in the next, and final state verification in one last read round. Do not interleave narrative plan updates or repeat unchanged reads.
- Choose exactly one remote branch-deletion mechanism. If `gh pr merge --delete-branch` is used, verify absence afterward instead of issuing another delete; otherwise merge without that flag and delete the resolved head ref once.

## Common Commands

```bash
gh auth status
gh repo view --json nameWithOwner,url,defaultBranchRef
gh issue list --repo owner/repo --state open --limit 50 --json number,title,author,labels,updatedAt,url
gh issue view 123 --repo owner/repo --json number,title,author,body,comments,labels,state,url
gh pr list --repo owner/repo --state open --limit 50 --json number,title,author,isDraft,reviewDecision,mergeStateStatus,url
gh pr view 55 --repo owner/repo --json number,title,state,author,body,comments,files,commits,statusCheckRollup,url
gh pr diff 55 --repo owner/repo --patch
gh pr checks 55 --repo owner/repo
gh run list --repo owner/repo --limit 20
gh run view RUN_ID --repo owner/repo --log-failed
gh release list --repo owner/repo --limit 20
gh api repos/owner/repo/pulls/55 --jq '{title, state, user: .user.login}'
gh api --method DELETE repos/owner/repo/git/refs/heads/feature-branch
```

For a write not authorized by the current request, show the exact repository, object, command, and effect before asking. For an authorized write, execute once target resolution and preconditions succeed; pause only for a material scope expansion or a platform-required gate. Independent commands may run in parallel, but never parallelize actions whose target or safety depends on another command's result.

## Default Output

When reporting GitHub data, include:

- Repository or URL inspected
- Commands or data sources used
- Current state and relevant IDs
- Any action taken, or the exact command you would run next
- Permission or authentication blockers, if any
