Bundled runtime drop-in directory.

This directory is the packaged runtime source. Dev launchers and build hooks run
`bin/ensure-runtime.cjs --root resources/runtime` before boot/packaging. The
script downloads the pinned assets from `manifest.json`, verifies `sha256`/size,
extracts them, and writes a `.orkas-runtime.json` marker under each platform
directory.

The production app does not invoke the downloader at runtime. Packaging must
finish with the required Python/uv directories already present under
`resources/runtime`, and the app only injects `ORKAS_PYTHON` / `ORKAS_UV` when
those binaries are present in packaged resources. `ORKAS_RUNTIME_DIR` is an
explicit developer override, not an automatic repair cache.

Version policy:

- Python is pinned to CPython 3.12 for broad third-party wheel compatibility in
  skill/package scripts. The current lock is Python 3.12.13 from Python's 3.12
  security line, using `astral-sh/python-build-standalone` release `20260610`.
- uv is pinned to `0.11.21`, the upstream uv release checked on 2026-06-18.
- Updating either version requires refreshing all asset URLs, sizes and
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
```

The app resolves `current` first, then `<platform>-<arch>`, and injects
`ORKAS_PYTHON` / `ORKAS_UV` into command execution when binaries are present.
Resolution checks an explicit `ORKAS_RUNTIME_DIR`, then packaged resources.

`ensure-runtime.cjs` also writes lightweight `pip` / `pip3` shims for the
bundled Python. They forward to `python -m pip`, because the standalone Python
asset includes the pip module but may not ship `Scripts/pip.exe`.
