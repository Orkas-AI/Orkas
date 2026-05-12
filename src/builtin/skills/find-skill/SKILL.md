---
name: find-skill
description_zh: 按 ClawHub、skill.sh / SkillHub、GitHub 的顺序查找与需求匹配的 skill，并整理可安装候选清单；适合“帮我找一个能抓网页的 skill”“有没有处理 Excel 的 skill”“去 GitHub 找类似的技能”；触发词：找skill、查skill、安装skill、clawhub、skill.sh、skillhub、GitHub、技能市场
description_en: Find skills matching a user need in priority order across ClawHub, skill.sh / SkillHub, and GitHub, then return installable candidates; For: "find me a skill for web scraping", "is there a skill for Excel files", "look for similar skills on GitHub"; Triggers: find skill, search skill, install skill, ClawHub, skill.sh, SkillHub, GitHub, skill marketplace
---

# find-skill

Discover an installable skill that already covers a user's need, search across ClawHub → skill.sh / SkillHub → GitHub in strict priority order, and return a ranked candidate list with install hints.

## When to use

- "Find me a skill that handles PDFs / scrapes Xiaohongshu / drives a browser."
- "Is there an existing skill for X?" — before authoring a new one.
- "Look on GitHub / ClawHub / skill.sh for something similar."

**Don't do** when the user already supplied a concrete skill URL or local directory and only wants that one installed — hand it to the install path directly, no discovery needed.

## How to call

### 1. Convert the request into searchable capability terms

- Primary task: e.g. scrape webpage, process Excel, generate slides, drive browser.
- Inputs: keywords, URL, file, account, API key, etc.
- Outputs: JSON, report, file, chart, edited document.
- Platform constraints: Chinese platform, GitHub, browser login, specific SaaS, Windows / macOS, etc.

Compose 2–5 search phrases:

- Chinese: e.g. `网页抓取 skill`, `Excel 处理 skill`.
- English: e.g. `web scraping skill`, `Excel xlsx agent skill`.
- Synonyms: e.g. `browser automation` / `web automation`.

### 2. Search sources in fixed priority order

Walk the sources in order. Move to the next source **only when the current source has no acceptable candidate**.

#### Source 1 — ClawHub (try first)

ClawHub is the preferred source.

```bash
npx clawhub search "keyword"
npx clawhub browse
npx clawhub search "web search"
npx clawhub search "weather"
npx clawhub search "document"
npx clawhub search "github"
npx clawhub search --sort installs
npx clawhub search --sort stars
```

Public pages:

- `https://clawhub.ai/`
- Detail page, e.g. `https://clawhub.ai/fangkelvin/find-skills-skill`

Treat ClawHub as "has a good candidate" when **all** of the following hold:

- Capability directly covers the user's need.
- Clear README / `SKILL.md` / install instructions.
- Not a tutorial post, blog article, or empty repo.
- Dependencies are acceptable.
- At least one `fit: high`, or several `medium` candidates worth offering.

If satisfied, **stop**. Do not continue to skill.sh / SkillHub or GitHub.

#### Source 2 — skill.sh / SkillHub (only if ClawHub has nothing)

```bash
npx skills find "keyword"
npx skills add <owner/repo@skill>
npx skills add <owner/repo@skill> -g -y    # global, skip confirmation
```

Public pages:

- `https://skillhub.cn/skills/find-skills`
- `https://skillhub.cn/`
- `https://skills.sh/`

SkillHub HTTP endpoints:

```text
https://api.skillhub.cn/api/skills?page=1&pageSize=10&keyword=<keyword>
https://api.skillhub.cn/api/v1/skills/<slug>
https://api.skillhub.cn/api/v1/skills/<slug>/files
https://api.skillhub.cn/api/v1/skills/<slug>/file?path=SKILL.md
https://api.skillhub.cn/api/v1/download?slug=<slug>
```

Treat SkillHub as "has a good candidate" when:

- Result name, description, or `SKILL.md` matches the need.
- An install command, detail page, or download link is reachable.
- The hit is an installable skill, not a marketing list or curated index page.
- Install source is clear and dependency risk is explainable.

If satisfied, **stop**. Do not continue to GitHub.

#### Source 3 — GitHub (only if both above have nothing)

Prefer the `gh` CLI to search and read repositories.

Verify CLI availability first:

```bash
gh --version
gh auth status
```

If unauthenticated, public search may still work; on rate limit or permission error, ask the user to run `gh auth login`.

Search code containing `SKILL.md`:

```bash
gh search code 'filename:SKILL.md web scraping skill' --limit 20
gh search code 'filename:SKILL.md browser automation' --limit 20
gh search code 'filename:SKILL.md Excel xlsx agent skill' --limit 20
gh search code 'filename:SKILL.md openclaw skill' --limit 20
gh search code 'filename:SKILL.md claude skill' --limit 20
```

Replace `<capability>` with the user's task:

```bash
gh search code 'filename:SKILL.md <capability>'
gh search code 'filename:SKILL.md <capability> skill'
gh search code 'filename:SKILL.md <capability> agent skill'
gh search code 'filename:SKILL.md <capability> openclaw skill'
gh search code 'filename:SKILL.md <capability> claude skill'
```

Search relevant repositories:

```bash
gh search repos '<capability> skill' --limit 20 --json fullName,description,url,updatedAt,stargazersCount
gh search repos '<capability> agent skill' --limit 20 --json fullName,description,url,updatedAt,stargazersCount
gh search repos '<capability> SKILL.md' --limit 20 --json fullName,description,url,updatedAt,stargazersCount
gh search repos 'awesome claude skills <capability>' --limit 20 --json fullName,description,url,updatedAt,stargazersCount
```

When `gh search code` output is not structured enough, fall back to the API:

```bash
gh api search/code -f q='filename:SKILL.md <capability>' -f per_page=20 \
  --jq '.items[] | {name: .name, path: .path, repo: .repository.full_name, url: .html_url}'
```

Inspect a candidate repo:

```bash
gh repo view OWNER/REPO --json nameWithOwner,description,url,updatedAt,stargazerCount,defaultBranchRef,licenseInfo
gh api repos/OWNER/REPO/contents --jq '.[] | {path: .path, type: .type, size: .size}'
gh api -H "Accept: application/vnd.github.raw" repos/OWNER/REPO/contents/SKILL.md
gh api -H "Accept: application/vnd.github.raw" repos/OWNER/REPO/contents/path/to/SKILL.md
gh api repos/OWNER/REPO/readme --jq '.content' | base64 -d
gh api repos/OWNER/REPO/commits -f per_page=5 \
  --jq '.[] | {sha: .sha, date: .commit.author.date, message: .commit.message}'
gh release list --repo OWNER/REPO --limit 10
```

For a quick whole-repo scan, shallow-clone to a scratch directory:

```bash
gh repo clone OWNER/REPO /tmp/skill-candidate -- --depth 1
```

Recommended search phrasing:

```text
<capability> skill SKILL.md
<capability> agent skill
<capability> openclaw skill
<capability> claude skill
filename:SKILL.md <capability>
```

When inspecting candidates, prioritize:

- Has `SKILL.md`.
- Has scripts, configs, examples, or install instructions.
- Is a single skill, not a doc inside a larger unrelated project.
- Recent commits, open issues, README completeness.
- No hard requirement on API key, login state, private service, or heavy dependency.

### 3. Pull candidate details

For every candidate, capture:

- Name and source.
- Detail page URL.
- `SKILL.md` or README.
- File listing.
- Install command or download link.
- Dependency requirements.
- Visible signals: security scan, maintenance status, downloads, stars.

### 4. Rank candidates

1. Source priority: ClawHub > skill.sh / SkillHub > GitHub.
2. Fit: directly covers the need > partial > reference only.
3. Installability: directly installable > needs assembly > reference material only.
4. Dependency risk: no extra dep > common runtime > API key / login state / private service.
5. Documentation quality: clear usage + examples > description only.
6. Maintenance signals: recent updates, downloads, stars, security scan.

If ClawHub already has one high-fit candidate, do not extend the search to GitHub just to bring back more results — unless the user explicitly asks to "search across all platforms".

### 5. Return the candidate list

State in the reply:

- The understood need.
- Sources actually searched.
- Whether the search stopped early because an earlier source already returned a fit.
- Best matches.
- Notable non-matches and reasons.
- Install-time risks.
- Recommended next step.

## Return format

On a successful find:

```json
{
  "query_understood_as": "the capability the user is looking for",
  "searched_sources": ["ClawHub"],
  "stopped_because": "ClawHub already returned a good candidate; skill.sh / SkillHub and GitHub were not searched",
  "best_matches": [
    {
      "title": "candidate name",
      "source": "ClawHub | skill.sh / SkillHub | GitHub",
      "url": "https://...",
      "install": "install command or download URL; null when unknown",
      "capability": "what it does",
      "fit": "high | medium | low",
      "why": "why it matches",
      "installability": "directly installable | needs assembly | reference only",
      "risks": ["dependency / login / API key / maintenance risks"]
    }
  ],
  "notable_non_matches": [
    {
      "title": "candidate name",
      "url": "https://...",
      "reason": "why it was skipped"
    }
  ],
  "recommendation": "next step"
}
```

On no fit found:

```json
{
  "query_understood_as": "the capability the user is looking for",
  "searched_sources": ["ClawHub", "skill.sh / SkillHub", "GitHub"],
  "best_matches": [],
  "recommendation": "No directly installable existing skill found; suggest authoring a new skill scoped to this need with a minimum-feature outline."
}
```

## External dependencies

- Network access — required to search public skill sources and read candidate files; if unavailable, explain that online discovery cannot be completed.
- ClawHub CLI / `npx clawhub` — useful for ClawHub search and browsing; if unavailable, fall back to the public ClawHub pages and report that CLI search was not run.
- Skills CLI / `npx skills` — useful for skill.sh / skills.sh ecosystem search and install commands; if unavailable, use public pages and API results where possible.
- GitHub CLI / `gh` — required for GitHub repo search, code search, file inspection, and release checks; install from `https://cli.github.com/`, then run `gh auth login` if search is rate-limited.
- GitHub access — useful for inspecting repositories and raw files; if rate-limited or unavailable, rely on other public search results and note the limitation.
- Source availability — repositories or platforms may block access, move files, or require login; if blocked, report the inaccessible URL.

## Limits / known issues

- Search results may include tutorials, templates, README-only repositories, or marketplace listings that are not directly installable.
- ClawHub and SkillHub pages may be dynamic; if rendered text is incomplete, switch to the documented API endpoints, raw files, or CLI output.
- GitHub code search may require login and may be rate-limited; if `gh search code` fails, ask the user to authenticate with `gh auth login` or continue with repository search only.
- Some skills depend on private APIs, browser login state, or local credentials that cannot be verified from the listing alone.
- Repository popularity does not guarantee skill quality; always inspect the actual usage notes and files.
- Respect the source order. Do not search GitHub just to add more results when ClawHub already has a good match.

## Full examples

### Example 1

User request:

```text
Find me a skill that automates filling and submitting web forms.
```

Output:

```json
{
  "query_understood_as": "find a skill that drives a browser to navigate, click, fill, and submit web forms",
  "searched_sources": ["ClawHub"],
  "stopped_because": "ClawHub returned a high-fit candidate; skill.sh / SkillHub and GitHub were not searched",
  "best_matches": [
    {
      "title": "Example Browser Automation Skill",
      "source": "ClawHub",
      "url": "https://clawhub.ai/example/browser-automation",
      "install": "npx clawhub install browser-automation",
      "capability": "Drives a browser to navigate, click, fill inputs, and submit forms",
      "fit": "high",
      "why": "Capability covers web form automation and ships with explicit invocation notes",
      "installability": "directly installable",
      "risks": ["May require a local browser runtime", "Cannot reliably handle complex CAPTCHAs"]
    }
  ],
  "notable_non_matches": [],
  "recommendation": "Install the top-fit candidate; before installing, confirm a browser runtime is available locally."
}
```

### Example 2

User request:

```text
Is there a skill that analyzes the sentiment of TikTok comments?
```

GitHub search commands tried:

```bash
gh search code 'filename:SKILL.md TikTok sentiment comments skill' --limit 20
gh search repos 'TikTok sentiment comments agent skill' --limit 20 --json fullName,description,url,updatedAt,stargazersCount
gh api search/code -f q='filename:SKILL.md TikTok sentiment comments' -f per_page=20 \
  --jq '.items[] | {path: .path, repo: .repository.full_name, url: .html_url}'
```

Output:

```json
{
  "query_understood_as": "find a skill that fetches TikTok comments and produces a sentiment summary",
  "searched_sources": ["ClawHub", "skill.sh / SkillHub", "GitHub"],
  "stopped_because": "ClawHub and skill.sh / SkillHub returned no high-fit installable candidate, so GitHub was searched",
  "best_matches": [
    {
      "title": "Social Comment Analyzer",
      "source": "GitHub",
      "url": "https://github.com/example/social-comment-analyzer",
      "install": null,
      "capability": "Fetches comments from select social platforms and outputs a sentiment summary",
      "fit": "medium",
      "why": "Covers comment analysis but does not explicitly support TikTok",
      "installability": "needs assembly",
      "risks": ["TikTok scraping may require login state", "Platform access limits may cause failures"]
    }
  ],
  "notable_non_matches": [
    {
      "title": "TikTok Marketing Prompts",
      "url": "https://github.com/example/tiktok-prompts",
      "reason": "Prompt collection only; not an installable skill"
    }
  ],
  "recommendation": "No fully matching directly-installable candidate; either adapt the medium-fit candidate or author a new skill scoped to TikTok comment fetching + sentiment analysis."
}
```
