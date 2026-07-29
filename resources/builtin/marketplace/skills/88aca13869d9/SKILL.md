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
- Preview write actions before executing them when the user did not explicitly ask for the exact write.
- Do not close issues, merge pull requests, rerun CI, delete branches, publish releases, or edit repository settings without explicit user approval.

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
```

For write actions, show the intended command first and wait for approval unless the user explicitly asked for that exact action.

## Default Output

When reporting GitHub data, include:

- Repository or URL inspected
- Commands or data sources used
- Current state and relevant IDs
- Any action taken, or the exact command you would run next
- Permission or authentication blockers, if any
