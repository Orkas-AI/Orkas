# Native Trace Workflow

Use this reference for macOS/iOS native Time Profiler work with `xctrace`, sample export, symbolication, and hotspot ranking.

Do not use this workflow for web performance, server profiling, SwiftUI-only code review without a native trace, or generic optimization advice with no app binary, trace, or reproduction path.

## External Dependencies

Required:

- macOS.
- Xcode Command Line Tools.
- `xcrun xctrace` for recording and exporting traces.
- `xcrun atos` for symbolication.
- `vmmap` to find the runtime `__TEXT` load address.
- A working Orkas Skill Runner; it selects Python 3 for the included `.py` scripts.
- App binary with matching symbols.
- Permission to launch or attach to the target process.

Stop and report the exact blocker if any required dependency is missing.

## Scripts

- `scripts/record_time_profiler.py`: record Time Profiler by attach or launch.
- `scripts/extract_time_samples.py`: export time-sample XML from `.trace`.
- `scripts/top_hotspots.py`: filter app frames, symbolicate with `atos`, and rank hotspots.

## Workflow

1. Confirm target and reproduction:

- App name and binary path.
- Attach PID or launch binary.
- Slow interaction to exercise during capture.
- Capture duration, default 90 seconds.

2. Preflight the Apple tools and target:

```bash
xcrun xctrace help record
xcrun atos -h
kill -0 <pid>
ps -p <pid> -o pid=,comm=
test -x /path/App.app/Contents/MacOS/App
```

The PID check must succeed, and the reported process executable must resolve to the app binary whose symbols will be used. When a dSYM is supplied, compare its UUID with the app binary using `dwarfdump --uuid` before recording; do not interpret symbolicated hotspots when the UUIDs differ.

All included scripts must be invoked through the standard Orkas Skill Runner. Do not bypass it with a direct interpreter invocation or a relative path into the skill's script directory.

3. Record Time Profiler:

```bash
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" swiftui-dev record_time_profiler -- --attach <pid> --trace /tmp/App.trace --duration 90s
```

or:

```bash
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" swiftui-dev record_time_profiler -- --launch /path/App.app/Contents/MacOS/App --trace /tmp/App.trace --duration 90s
```

4. Extract samples:

```bash
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" swiftui-dev extract_time_samples -- --trace /tmp/App.trace --output /tmp/time-sample.xml
```

5. Get runtime `__TEXT` load address while the app is running:

```bash
vmmap <pid> | rg -m1 "__TEXT"
```

If `rg` is missing:

```bash
vmmap <pid> | grep -m1 "__TEXT"
```

6. Symbolicate and rank hotspots:

```bash
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" swiftui-dev top_hotspots -- --samples /tmp/time-sample.xml \
  --binary /path/App.app/Contents/MacOS/App \
  --load-address 0x100000000 \
  --top 30
```

## Interpretation Rules

- Treat CSV output as evidence, not the complete answer.
- Group repeated symbols by subsystem where useful.
- Distinguish app-owned frames from framework/system frames.
- State confidence based on capture duration, sample count, symbol match, and whether the slow path was exercised.
- If no app frames appear, check binary path, load address, symbol match, and whether the trace sampled mostly system frames.

## Stop Rules

- Non-macOS environment.
- Missing Xcode tools.
- Trace path does not exist.
- `xctrace export` produces no XML.
- XML contains no time samples.
- Binary path missing or does not match the trace.
- Load address is missing or malformed.
- `atos` fails or returns raw addresses.
- Permission denied when attaching or launching.

## Report Format

```text
Target:
- App / binary:
- Mode: attach | launch | existing trace
- Trace:
- Samples XML:
- Load address:
- Capture duration:
- Confidence: high | medium | low

Top hotspots:
| Rank | Samples | Symbol | Interpretation |
|---:|---:|---|---|

Interpretation:
- <what the hottest frames suggest>
- <whether the hot path matches the reported symptom>
- <which frames are app-owned vs framework/system>

Risks / limits:
- <symbol mismatch, short capture, missing slow path, missing source, low sample count, etc.>

Next profiling step:
- <rerun capture, collect trace around specific interaction, compare before/after, inspect source around symbol, etc.>
```
