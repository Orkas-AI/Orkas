Bundled runtime drop-in directory.

This directory is the packaged runtime source. Dev launchers and build hooks run
`bin/ensure-runtime.cjs --root resources/runtime` before boot/packaging. The
script downloads the pinned assets from `manifest.json`, verifies `sha256`/size,
extracts them, and writes a `.orkas-runtime.json` marker under each platform
directory.

The production app does not invoke the downloader at runtime. Packaging must
finish with the required Python/uv/Node directories already present under
`resources/runtime`, and the app injects bundled runtime paths only when those
binaries are present in packaged resources. `ORKAS_RUNTIME_DIR` is an explicit
developer override, not an automatic repair cache.

Version policy:

- Python is pinned to CPython 3.12 for broad third-party wheel compatibility in
  skill/package scripts. The current lock is Python 3.12.13 from Python's 3.12
  security line, using `astral-sh/python-build-standalone` release `20260610`.
- uv is pinned to `0.11.21`, the upstream uv release checked on 2026-06-18.
- Node is pinned to Node.js 24.x Active LTS. Official Node archives include
  `node`, `npm`, and `npx`; Orkas exposes them in bash so users do not need a
  system Node/npm install.
- Updating any runtime version requires refreshing all asset URLs, sizes and
  sha256 digests in `manifest.json`, then running runtime and package-install
  smoke tests across macOS, Windows, and Linux targets.

Expected layout:

```
runtime/
  python/
    current/
      python/bin/python3        # macOS/Linux python-build-standalone
      python/python.exe         # Windows python-build-standalone
    darwin-arm64/
    darwin-x64/
    win32-x64/
  uv/
    current/
      uv
      uv.exe
    darwin-arm64/
    darwin-x64/
    win32-x64/
  node/
    current/
      bin/node                 # macOS/Linux official Node archive
      bin/npm
      bin/npx
      node.exe                 # Windows official Node archive
    darwin-arm64/
    darwin-x64/
    win32-x64/
```

The app resolves `current` first, then `<platform>-<arch>`. It injects
`ORKAS_PYTHON` / `ORKAS_UV` / `ORKAS_BUNDLED_NODE` when binaries are present
and prepends their executable directories to command PATH. `ORKAS_NODE` remains
Electron-as-Node for Orkas internal scripts; third-party package CLIs use
`ORKAS_BUNDLED_NODE` or plain `node` from PATH.

Bundled runtimes are app resources and may be replaced during app updates.
Installed package dependencies are not stored here: npm writes package-local
`node_modules` under `<data>/<uid>/local/packages/<pkg>/`, while npm
cache/prefix live under `<data>/venv/node/`. Those directories are outside the
app bundle so updates do not overwrite user-installed dependencies.

`ensure-runtime --check` uses the same per-runtime payload checks as the build
gate, so dev/start fails early when companion commands are missing. Build hooks
run the full runtime gate twice: `beforePack` checks this source runtime tree
after ensure/slim/prune, and `afterPack` checks the copied app resources before
signing. The gate verifies manifest markers, target-arch-only payloads,
canonical executables, Python pip shims, uv/uvx, and Node npm/npx.

Resolution checks an explicit `ORKAS_RUNTIME_DIR`, then packaged resources.

`ensure-runtime.cjs` also writes lightweight `pip` / `pip3` shims for the
bundled Python. They forward to `python -m pip`, because the standalone Python
asset includes the pip module but may not ship `Scripts/pip.exe`.
