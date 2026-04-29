---
name: github
description_zh: "用 `gh` CLI 操作 GitHub：管理 issue / PR / CI runs，以及任意 GitHub API 高级查询。适合\"列出 X 仓库的 open PR\"\"把这个 issue 关掉\"\"看下昨晚的 CI 是不是失败了\"；触发词：github、gh、PR、issue、CI、仓库、pull request、release"
description_en: "Interact with GitHub using the `gh` CLI. Use `gh issue`, `gh pr`, `gh run`, and `gh api` for issues, PRs, CI runs, and advanced queries. For: 'list open PRs in repo X', 'close this issue', 'check whether last night's CI passed'; Triggers: github, gh, PR, issue, CI, repo, pull request, release"
---

# GitHub Skill

Use the `gh` CLI to interact with GitHub. Always specify `--repo owner/repo` when not in a git directory, or use URLs directly.

## Pull Requests

Check CI status on a PR:
```bash
gh pr checks 55 --repo owner/repo
```

List recent workflow runs:
```bash
gh run list --repo owner/repo --limit 10
```

View a run and see which steps failed:
```bash
gh run view <run-id> --repo owner/repo
```

View logs for failed steps only:
```bash
gh run view <run-id> --repo owner/repo --log-failed
```

## API for Advanced Queries

The `gh api` command is useful for accessing data not available through other subcommands.

Get PR with specific fields:
```bash
gh api repos/owner/repo/pulls/55 --jq '.title, .state, .user.login'
```

## JSON Output

Most commands support `--json` for structured output.  You can use `--jq` to filter:

```bash
gh issue list --repo owner/repo --json number,title --jq '.[] | "\(.number): \(.title)"'
```
