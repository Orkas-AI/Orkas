# Native dependencies when running from source

Use Node.js 24 LTS to bootstrap the checkout (minimum 22.12.0). The desktop
app and `npm test` load addons in the pinned Electron runtime, not in the
system Node that runs npm. Keep optional dependencies enabled and use a
separate checkout/dependency tree for each platform and process architecture.

From the directory containing the desktop `package.json`, stop the source
app and run the supported repair command:

```sh
npm run native:repair
```

This checks the bootstrap Node version, runs `npm install --include=optional
--no-save` using the lockfile, lets postinstall repair better-sqlite3 for the
installed Electron, and verifies all three dependencies in an Electron child:

- better-sqlite3: an in-memory SQL query.
- sqlite-vec: extension loading and a vector-distance calculation.
- sharp: PNG encoding and decoding.

Installation may download npm packages, Electron and the embedding model.
The command does not change package declarations or the lockfile. Any failed
install or final check returns nonzero; do not continue launching after a
failure. A successful installer exit is not proof that an addon can load.

For verification without installation, use `npm run native:check`. It prints
the actual Electron, Node, modules ABI, Node-API, platform and architecture.
Source startup performs the same functionality check before reporting ready.
`npm run rebuild:sqlite:electron` remains a narrower SQLite-only repair: it
tries the matching upstream Electron prebuild, then compiles better-sqlite3
from source when needed, and verifies loading again.

## Compatibility and recovery

| Dependency | Binary compatibility requirement |
| --- | --- |
| better-sqlite3 | Electron modules ABI plus OS and process architecture |
| sqlite-vec | SQLite loadable extension for the OS/architecture; not a Node addon to rebuild for every Electron ABI |
| sharp | Node-API v9 or newer plus the matching optional sharp/libvips platform packages and system libraries |

The upstream npm/native releases provide prebuilt components. A local SQLite
source-build fallback needs Python 3 and a C/C++ build toolchain: Xcode Command
Line Tools on macOS, Visual Studio C++ Build Tools on Windows, or the compiler
and make tools for the Linux distribution. Use the documented source-platform
matrix for the checkout; an upstream package supporting another architecture
does not imply the entire desktop app supports it.

If repair still fails, check network access to npm/GitHub/Electron downloads,
the compiler prerequisites, and the named native dependency. Missing shared
libraries need the target OS runtime libraries; another Electron rebuild does
not fix an incompatible libc or a missing libvips DLL. Do not copy node_modules
between Windows/macOS/Linux or between native arm64 and Rosetta x64 shells.
For a corrupted dependency tree, use a fresh checkout with `npm ci
--include=optional`, then `npm run native:check`. Keep user data unchanged.

Do not run plain `npm rebuild` to switch this shared tree to the system Node
ABI, and do not run `npx vitest` directly: `npm test`/`npm run test:js` use the
Electron test wrapper. Packaged desktop users should reinstall the correct
platform/architecture installer rather than rebuild addons locally.
