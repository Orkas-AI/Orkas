ProseMirror composer runtime (MIT)

Pinned package versions and integrity hashes: package.json / package-lock.json.
Upstream: https://github.com/ProseMirror
License notices for every bundled dependency: LICENSES.txt.

prosemirror.min.js is the runtime IIFE script exposing OrkasEditor. No runtime
network request, npm loader or renderer application bundler is needed.

Rebuild from PC/ using the existing pinned development esbuild tool:
  npm ci --prefix src/renderer/vendor/prosemirror --ignore-scripts
  node src/renderer/vendor/prosemirror/build.cjs
Remove this vendor directory's build-only node_modules before packaging.

Local patch (build.cjs): ProseMirror view 1.42.5 focus recovery must stop after
an explicit keyboard event. Otherwise Home within 200ms of refocusing after a
picker is overwritten by the old caret. The build checks the exact upstream
guard before applying this change; dependency upgrades must review it. Real
Electron coverage lives in composer_e2e_state.spec.ts and the multi-recipient
picker scenario in composer_e2e_interactions.spec.ts.
