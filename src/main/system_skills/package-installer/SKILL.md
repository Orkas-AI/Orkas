---
name: package-installer
description_zh: 安装用户给出的 GitHub 仓库或本地 git 目录作为 Orkas 外部包，并接入其中的技能或命令行工具；适合"安装这个 GitHub 项目""把 /path/to/repo 接入 Orkas 外部包""更新或移除已安装的外部包"；触发词：外部包、安装包、GitHub 项目、本地 repo、更新包、移除包、package installer
description_en: Install a user-supplied GitHub repository or local git directory as an Orkas external package and wire up its skills or CLI tools; For: "install this GitHub project", "connect /path/to/repo as an Orkas external package", "update or remove an installed external package"; Triggers: external package, install package, GitHub project, local repo, update package, remove package, package installer
category: "general"
---

# Package Installer

Install third-party open-source projects (a GitHub URL or a local git
directory the user provides) as external packages. The project is cloned
verbatim into the per-user packages directory — never edit, normalize, or
reorganize its files.

Run the Orkas CLI command below through the command execution tool; Orkas
handles this runner form directly on Windows:

```text
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/orkas-pkg.cjs" <command> [args]
```

Commands: `install <git-url> [--name <name>] [--consent-deps]`,
`consent-deps <name>`, `update <name>`, `remove <name>`, `list`,
`info <name>`.
Every command prints a JSON result; non-zero exit prints `{ok:false,error}`.

## Install flow

1. Run `install <git-url>`. Use `--name` only when the repo basename is not
   a valid package name (the error message will say so). Never pass
   `--consent-deps` on the first attempt — dependency installs need the
   user's explicit approval first.
2. Read the JSON result:
   - `deps_pending_consent` non-empty → the package is installed but its
     dependencies are not. Show the user the exact commands listed there
     and ask for approval; after they agree, run `consent-deps <name>`.
     If they decline, leave it as is — skills that need no deps still work.
   - `error` mentioning "not installable" → tell the user the project has
     neither skills (SKILL.md) nor CLI entry points and is not supported
     (agent-driven-only projects cannot be installed).
3. Report what was installed, from the result fields:
   - `skill_roots` non-empty → its skills become available in new turns.
   - `shims` non-empty → those commands are directly callable from the host
     shell/PATH in the next turn (e.g. `hyperframes --help`). On Windows the
     installer creates `.cmd` shims for CLI entries.

## Author a usage skill for CLI-only installs

When the install result is `kind: "cli"` (empty `skill_roots`, non-empty
`bin_entries`), author a companion usage skill so future turns get curated
instructions instead of a bare command list. Do this automatically right after
a successful CLI install — the user already approved installing it. Skip for
`kind: "skill"` and `kind: "both"` (they already ship their own SKILL.md).

1. Probe usage: run the package's main binary with `--help` (and one level of
   subcommand help if cheap). Cap output; if `--help` blocks or is empty, keep
   the skill minimal and point the reader at `<bin> --help`.
2. Write the skill via stdin (the file lands outside the package tree):

   ```bash
   "$ORKAS_NODE" "$ORKAS_PC_DIR/bin/orkas-pkg.cjs" skill-write <name> <<'SKILL'
   ---
   name: <human name>
   description: <one line: what it does + when to use it>
   ---

   # <name>

   When to use, the common commands (from --help, with real examples), and any
   gotchas (e.g. a one-time setup command). End with an "External dependencies"
   line naming the package's binaries.
   SKILL
   ```

   Frontmatter is ONLY `name` + `description`; everything else is body prose.
3. Re-running `skill-write <name>` overwrites the companion (use it to fix or
   refresh after an `update`).

## Updates and removal

- `update <name>` pulls the latest version. Dependency installs re-run
  automatically only if the user already consented during install.
- `remove <name>` deletes the package and its shims.
- `list` shows installed packages with kind, enabled state, and commit.

## Rules

- Ask before installing anything the user did not explicitly request.
- Never run `npm install` / `pip install` yourself inside a package — the
  CLI owns dependency installs and the consent record.
- Do not modify files under the packages directory; treat it as read-only.
- Public GitHub repos install without git (the CLI downloads a tarball when git
  is absent). Git is only needed for private repos and non-GitHub git URLs; if
  the CLI reports git is required for such a source, relay that to the user.
