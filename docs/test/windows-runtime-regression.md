# Windows Runtime Regression

This checklist covers Windows-only runtime behavior that is easy to miss in
platform-neutral unit tests. Keep the automated cases deterministic and run the
native smoke separately because it executes the bundled Whisper model.

## Platform-difference risk map

| Boundary | Windows difference and user risk | Automated regression / discovery probe | Packaged/manual residual |
| --- | --- | --- | --- |
| Paths and filesystems | Drive letters, case-insensitive NTFS, junctions, reserved names, quoted/space-containing PATH entries, file locks, and long paths can reject valid files, escape a workspace, or leave data undeletable. | Path sandbox uses native case-insensitive containment and a real junction escape negative-control; conversation slugs reject reserved names; CLI lookup covers PATHEXT and quoted PATH; cleanup paths retry `EPERM`/`EBUSY`; source-data migration preserves the prior copy on publication failure and redacts early-boot errors. | Exercise a non-ASCII/space-containing install and workspace, a path over 260 characters, OneDrive-controlled folders, and Defender-held temporary files. |
| Processes and shells | PowerShell and cmd have different quoting, encoding, shim, signal, and descendant semantics; POSIX `mkdir -p` can bind as PowerShell `-Path` and fail after partial interpretation; killing the parent alone leaks work and locks files. | Preflight rejects high-confidence POSIX syntax (including `mkdir -p`) with PowerShell rewrite guidance; real PowerShell UTF-8 and npm-style `.cmd` argv round trips; OAuth and relaunch use bounded argv-only launch contracts; every production child-process owner has a focused suite in the serialized native lane; real parent/grandchild sentinels prove whole-tree termination. The local-CLI lane executes the governed Lark multiline/MCP stdio contracts with native Windows process semantics. | Inspect Task Manager after repeated cancel/timeout/relaunch cycles and confirm no console flashes, descendants, or locked work directories. |
| Official connector CLIs | A package may advertise Node compatibility but omit its Windows executable, fail behind `npx`, emit a startup warning as false success, or leave its cache locked after exit. | A Windows x64 canary uses the production authorization helper and direct `node npx-cli.js` path to verify the exact integrity-pinned WeCom, Feishu/Lark, DingTalk, and Xero packages: a child PATH containing only bundled Node and Windows system tools (never CI/system Node), a no-Node negative control, exact bundled-Node resolution, registry integrity, isolated download, executable discovery, real `--help` startup, clean stderr, and immediate cache removal. The owning cross-platform cases also run real offline npm lifecycle scripts with missing/shadowing system Node, space/non-ASCII runtime paths, install failure without a ready marker, and successful retry before authorization/MCP access. | Real account authorization and business API calls require provider accounts and remain release canaries; verify browser/device login, one read, one confirmed write, logout, and reconnect for each provider without using personal production data. |
| Source startup without system Node | `run.cmd` must bootstrap the pinned runtime before any JavaScript can execute; a partial download, corrupt marker, bad hash, or failed directory swap can otherwise leave development startup permanently broken. | Cross-platform wiring/manifest contract plus a real Windows PowerShell integration using an actual zip and Node executable: first install, verified cache, corrupt-marker repair, hash rejection, temp cleanup, and failed-swap rollback. | On clean x64 and Arm64 hosts with Node removed from PATH, launch `run.cmd` through Explorer and a path containing spaces/non-ASCII characters. |
| Window and OS integration | Negative monitor coordinates, DPI/topology changes, minimized close bounds, registry command parsing, AppUserModelID, notification policy, and protocol cold launch differ from macOS. | Window state preserves visible left-monitor coordinates, drops disconnected positions, and ignores minimized sentinel bounds; registry cleanup rejects executable look-alikes; notification probes are hidden/bounded and escape the app id; deep-link registration has argv/error coverage. | Verify mixed-DPI monitor removal/reconnect, sleep/resume, notification Group Policy, default-app changes, and cold/second-instance `orkas://` activation. |
| Install and packaging | App-local VC DLL closure, PE architecture, native ABI, signing, installer elevation, and antivirus scanning can make a build pass source tests but fail after install. | PE/ABI/DLL/license/package gates; Windows shutdown and installer process ownership; NSIS compilation requires an installed public compiler; installer execution remains Windows-only. | Build the public Windows package and run packaged-app/native checks; test signed upgrade/downgrade/reinstall/uninstall as standard and admin users, including data retention and interrupted installation. |
| Performance and recovery | Process creation is slower, file handles are retained longer, and native CPU dispatch can regress latency or destabilize concurrent tests. | Windows unit workers are serialized; native Whisper has a 60-second budget/90-second hard limit; high-risk process-tree cases repeat three times in isolated Vitest processes so forced handle closure cannot contaminate the next owner. | Record cold/warm startup, handle/process count, working set, Whisper latency, and cleanup time with Defender enabled and after sleep/resume. |

## Embedded-browser phone passkey canary (pending hardware)

The requester deferred Windows hardware execution on 2026-10-04. The cases below
are **not run**. Run them against the integrated packaged app when a Windows
machine is available; the isolated macOS caBLE probe is not Windows evidence.
Keep official Electron. USB keys, Windows Hello enrollment, and new credential
creation are outside this phone-authentication canary.

Use an isolated `ORKAS_WORKSPACE_ROOT`, a current Windows 11 installation with
Bluetooth, and an iPhone or Android phone with a Google passkey already saved.
Record Windows build/update, Electron version, phone OS, packaged app version,
and proxy mode without account identifiers or credential/session bytes. Windows
10 and older Windows 11 builds require a separate capability check; do not infer
phone support from the presence of WebAuthn. Microsoft's documented native
passkey management experience starts at Windows 11 22H2 with KB5030310; this
does not establish a minimum hybrid-transport version. Windows 11 24H2 also adds
per-application passkey privacy consent:
[Windows passkeys](https://learn.microsoft.com/en-us/windows/security/identity-protection/passkeys/).

| ID / user goal | Procedure and variation | Independent result and recovery |
| --- | --- | --- |
| W-PK-01 / sign in with the nearby phone | In a fresh embedded-browser tab, open Google sign-in, enter the account locally, choose passkey authentication and the phone/tablet option, scan the QR, and confirm on the phone. Repeat after signing out. | Google accepts the assertion and displays the signed-in session in that same tab. A QR, capability flag, phone confirmation, or returned assertion alone is not a pass. Record both runs without copying private page content. |
| W-PK-02 / cancel and retry | Cancel the Windows authentication dialog before scanning; retry. Repeat with cancellation on the phone after scanning. | The cancelled attempt does not sign in or leave a blocking dialog. A fresh attempt can reach Google's accepted session; no delayed result from the cancelled attempt completes it. |
| W-PK-03 / unavailable credential | Scan with a phone that has no matching Google credential, then retry with the prepared phone. Do not enroll a new credential as part of this test. | The first attempt does not sign in and remains recoverable. The prepared phone succeeds on a new challenge; no wrong-account session appears. |
| W-PK-04 / Bluetooth and connection failure | Disable Bluetooth before starting, restore it and retry. In another attempt disconnect network access after scanning, allow the operation to fail/expire, restore access, and retry. | Failure never appears as login success. The dialog can be dismissed, the page remains usable, and a fresh challenge succeeds after restoration. Record the OS feedback and timeout rather than assuming a fixed duration. |
| W-PK-05 / tab and account lifetime | While phone authentication is pending, navigate the requesting tab, close it, or switch the Orkas account in separate attempts. Confirm on the phone only after teardown. | No stale authentication completes in a replacement page, another tab, or another Orkas account. No orphan dialog remains; a new tab/account can initiate an independent attempt. |
| W-PK-06 / proxy continuity | Repeat W-PK-01 with the configured system or environment proxy, including an authenticated supported proxy. Then make that proxy unavailable and retry after restoration. | Sign-in works through the intended route. A blocked proxy does not silently use a direct tunnel; the failed attempt is recoverable. Establish routing with a controlled proxy's connection counters, not private authentication payloads. |
| W-PK-07 / OS privacy consent | On Windows 11 24H2 or newer, decline the application's passkey consent on first use. Restore its access in Settings > Privacy & security > Passkey access and retry. | Denied access cannot authenticate and does not silently expand permissions. Restoring consent permits a fresh phone attempt; Google must accept it before recording recovery as passed. |

Inspect app stdout/stderr and Windows dialog outcomes for every attempt. Preserve
failed results separately from retries; report warnings and unavailable variants
explicitly. No Windows passkey support claim is valid until these real-device
results are recorded.

## Automated coverage

`npm run test:runtime-path` runs the focused environment regression entry through
the Electron test runner: missing/shadowing system Node, offline npm lifecycle
scripts, space/non-ASCII runtime paths, nested Skill commands, and bundled
runtime/reference-process contracts. This is a local focused entry; neither
public workflow currently invokes it. `Native dependency repair` runs its listed
native/ABI regression suites on Windows, macOS and Linux; `Linux source smoke`
also runs the Linux desktop/native lane. Run and retain the Windows-native,
stability and packaged-app checks separately; those workflows do not establish
their results.

The process-owner inventory covers shipped `bin` JavaScript helpers as well as
`src` modules. A new child-process owner requires a behavioral suite in each
applicable native lane; negative controls check discovery and failure propagation.

- Process lifecycle: OfficeCLI, ffmpeg/ffprobe, VideoStudio native helpers,
  package commands, and local-agent version probes use hidden windows, bounded
  output, prompt timeout/abort settlement, and whole-tree termination. Real
  parent/grandchild cases verify that a descendant cannot outlive its parent and
  write a delayed sentinel file.
- Windows paths: sandbox
  containment and skill imports compare case-insensitively without prefix false
  positives; a real junction cannot escape the workspace.
- Shell and launch integrity: local-agent `.cmd` shims round-trip hostile argv;
  quoted PATH entries remain discoverable; OAuth URLs stay a single `rundll32`
  argument; development relaunch removes frozen user/workspace environment
  state and safely quotes `run.cmd`. Local connector CLIs bypass `.cmd` shims;
  Windows reruns the Lark multiline/MCP stdio journeys and starts every exact
  official package through the production `node npx-cli.js` helper.
- No-Node source startup: `run.cmd` invokes the PowerShell bootstrap before
  dependency preparation; the pinned manifest selects x64/Arm64, cache reuse
  requires marker/files/executable version, and download size/SHA plus Node
  self-check complete before an atomic swap. The Windows bootstrap integration
  injects a failed swap and requires the prior runnable payload to return. Run
  it through `npm run test:windows-native` on Windows and retain its result;
  the existing public CI workflows do not execute that integration.
- Desktop state and installation: negative-coordinate monitor positions remain
  usable and minimized shutdown does not persist Windows sentinel bounds.
  Shutdown and installer cleanup target this installation's process tree;
  failure and retry cases preserve unrelated running applications.
- Document recognition: local OCR installation and execution are retired.
  Images use model input and scanned PDFs use bounded page rendering; a
  text-only model requests readable text or a vision-capable model.
- File locking: native dependency pruning uses retrying recursive removal, and
  asynchronous quality-report writes are serialized and drainable before a
  temporary workspace is removed.
- Packaging integrity: the Windows Whisper contract verifies every CLI, CPU
  dispatch DLL, VC runtime DLL, model, and pinned OpenBLAS license by size and
  SHA-256. The repository copy of every pinned license must satisfy that same
  contract before packaging starts.

Primary suites:

- `src/core-agent/test/oauth-flow.test.ts`
- `src/core-agent/test/process-session.test.ts`
- `test/main/features/connectors/protocol.test.ts`
- `test/main/features/connectors/oauth-dcr.test.ts`
- `test/main/features/connectors/local-cli.test.ts`
- `test/main/index-process.test.ts`
- `test/main/util/shutdown.test.ts`
- `test/main/util/windows-shutdown-processes.test.ts`
- `test/main/util/windows-installer-processes.test.ts`
- `test/main/util/nsis-installer-processes.test.ts`
- `test/main/features/local_agents/version.test.ts`
- `test/main/features/local_agents/which.test.ts`
- `test/main/features/office/office_engine.test.ts`
- `test/main/model/core-agent/file-tools.test.ts`
- `test/main/features/packages.test.ts`
- `test/main/features/skills.test.ts`
- `test/main/features/video_gen.test.ts`
- `test/main/features/video_studio_native_qa.test.ts`
- `test/main/features/window_state.test.ts`
- `test/main/util/migrate-source-data-root.test.ts`
- `test/main/ipc/app-data-root.test.ts`
- `test/main/platform-process-coverage.test.ts`
- `test/main/quality/report.test.ts`
- `test/main/util/fetch-whisper.test.ts`
- `test/main/util/media_probe.test.ts`
- `test/main/util/path-sandbox.test.ts`
- `test/main/util/prepare-win-native-deps.test.ts`
- `test/main/util/windows-node-bootstrap-contract.test.ts`
- `test/windows/windows-node-bootstrap.integration.ps1` (real Windows lane)
- `test/windows/windows-local-cli.integration.mjs` (real Windows x64 package lane)

## Required commands

The compiled NSIS suite requires a working public `makensis` on PATH, or an
absolute `ORKAS_TEST_MAKENSIS` path. For an extracted electron-builder NSIS
toolchain, set `ELECTRON_BUILDER_NSIS_DIR` to its resource root; this also supplies
`NSISDIR`. Tests do not download a compiler or depend on a private `product/`
directory. Missing or failed compilation is a test infrastructure failure, not a
skipped pass. macOS compiles the production hook and all four fault fixtures;
only Windows executes the installers and verifies file-lock release and retry.

On macOS 14 or newer, use a compiler containing the upstream
[UTF-32 conversion fix](https://github.com/NSIS-Dev/nsis/commit/2532ccae34d3fdd183575177f2486bc9e2922642)
and its [function-order correction](https://github.com/NSIS-Dev/nsis/commit/f0bfe3e0062c57dc1ef90f1d235c7c0bd5a43be4).
Unpatched 3.13 can abort while generating language tables; a successful
`makensis -VERSION` alone does not prove compilation works.

1. Run `npm run typecheck`.
2. Run `npm test` for the full JavaScript and Python resource suites.
3. Run `npm run test:platform-native` in a desktop session. The serialized
   native-host suites are followed by real Electron composition-inspect and
   background-browser-input canaries; a missing display fails the lane.
4. Run `npm run test:coverage` and investigate every failure; do not accept a
   worker crash, unhandled rejection, `EPERM`, or leaked-handle warning as an
   unrelated test issue.
5. On Windows, run `npm run test:windows-native`. The real PowerShell no-Node bootstrap
   integration runs first; the Windows x64 connector canary then downloads and
   starts every exact official CLI package without accessing an account; bundled
   Whisper must finally finish within its 60-second performance budget and
   before the 90-second hard limit.
6. On Windows, run `npm run test:windows-stability`. It repeats the real persistent-process
   and descendant-termination cases three times. After the loop, no test-owned
   `node.exe`, `cmd.exe`, ffmpeg, ffprobe, OfficeCLI, or delayed sentinel should
   remain.

The Windows-only commands report a skip on other hosts; that is not Windows
execution evidence. Record the actual OS, commands, skips, diagnostics and
process cleanup for a Windows release. These deterministic/native commands do
not call a chat or generation provider; the bundled Whisper smoke performs
local inference. Real connector authorization and phone-passkey journeys remain
the manual checks described above.

The public `Native dependency repair` workflow exercises native repair and
focused Electron regressions on Windows, macOS and Linux. The `Linux source
smoke` workflow additionally runs the Linux desktop/native lane. Windows
coverage, stability, native inference and packaged-app acceptance must be run
and recorded separately; these workflows do not establish those results.

The review found that `bootstrap-node.ps1` was a production startup entry with
no test owner. It also exited the caller on a cache hit, preventing safe
in-process fixture execution. The script now returns normally and accepts
isolated root/architecture parameters while preserving its default `run.cmd`
behavior; the Windows integration is the behavior oracle, while the
cross-platform contract only guards wiring and pinned inventory.

## Manual packaged-app checks

1. Launch from Explorer with no developer-shell PATH and confirm local CLIs,
   connector OAuth callbacks, notifications, OfficeCLI, ffmpeg/ffprobe, and
   Whisper resolve without a visible console window.
2. Cancel and time out one Office, video, media-probe, and package operation.
   Confirm Task Manager shows no descendants and the working files can be
   renamed or deleted immediately afterward.
3. Read an image and an image-only PDF on a clean profile with package-network
   access unavailable. Image input and page rendering must work without a
   Python recognition install. A text-only model must state its limitation.
4. Repeat start/cancel/timeout cycles with Microsoft Defender enabled and verify
   stable handle count, process count, latency, and temporary-directory cleanup.
5. Install and launch from paths containing spaces and non-ASCII characters;
   use a workspace path over 260 characters and confirm file tools, OfficeCLI,
   FFmpeg, and produced-file reveal/open actions still work.
6. Move the app between mixed-DPI monitors (including one left of the primary),
   minimize, sleep/resume, disconnect the secondary monitor, and relaunch.
   Confirm the window is visible and the last normal bounds remain recoverable.
7. Exercise signed NSIS upgrade, interrupted upgrade, reinstall, and uninstall
   under standard-user and admin accounts. Confirm rollback/repair is clear and
   the pinned user-data container is neither redirected nor removed.
