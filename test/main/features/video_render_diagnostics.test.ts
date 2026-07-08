import { describe, it, expect } from 'vitest';

import {
  parseRenderDiagnostics,
  classifyRenderCrash,
  machineRamGB,
  isConstrainedMachine,
  estimateRenderCost,
  renderCostDecision,
  degradedFps,
  LOW_RAM_GB,
  HEAVY_RENDER_COST,
} from '../../../resources/builtin/marketplace/agents/79df9cc89f5f/skills/_shared/scripts/src/video_render';

describe('parseRenderDiagnostics', () => {
  // Real line captured from `hyperframes render` (0.7.3), which has a NESTED
  // "fps":{...} object — the parser must not truncate at the first `}`.
  const REAL_PIPELINE = '[INFO] [Render] Pipeline started {"platform":"darwin","arch":"arm64","nodeVersion":"v22.22.3","fps":{"num":30,"den":1},"format":"mp4","quality":"draft","browserGpuMode":"software","forceScreenshot":false,"protocolTimeout":300000,"browserTimeout":120000,"pageNavigationTimeout":60000,"playerReadyTimeout":45000}';

  it('parses browserGpuMode + timeouts from the real (nested-object) pipeline line', () => {
    const d = parseRenderDiagnostics(`some noise\n${REAL_PIPELINE}\nmore noise`);
    expect(d.gpuMode).toBe('software');
    expect(d.protocolTimeoutMs).toBe(300000);
    expect(d.browserTimeoutMs).toBe(120000);
    expect(d.playerReadyTimeoutMs).toBe(45000);
  });

  it('reads a hardware pipeline line', () => {
    const d = parseRenderDiagnostics('[INFO] [Render] Pipeline started {"browserGpuMode":"hardware","requestedWorkers":"auto","protocolTimeout":300000}');
    expect(d.gpuMode).toBe('hardware');
    expect(d.workers).toBe('auto');
  });

  it('falls back to the gpu-probe banner when there is no pipeline line', () => {
    expect(parseRenderDiagnostics('[hyperframes] browserGpuMode auto → hardware (WebGL probe succeeded)').gpuMode).toBe('hardware');
    expect(parseRenderDiagnostics('[hyperframes] browserGpuMode auto → software (no GPU)').gpuMode).toBe('software');
  });

  it('returns no gpuMode for unrelated output', () => {
    expect(parseRenderDiagnostics('ffmpeg version 6.0\nrendering frame 12').gpuMode).toBeUndefined();
    expect(parseRenderDiagnostics('').gpuMode).toBeUndefined();
  });
});

describe('classifyRenderCrash', () => {
  // Real crash tail shape from the weak-Intel-Mac report.
  const NATIVE_CRASH = 'inspect produced no findings. node::NewIsolate(v8::Isolate::CreateParams*, uv_loop_s*, node::MultiIsolatePlatform*, ...) v8::internal::SnapshotData*, v8::internal::SnapshotData*';

  it('classifies a V8 isolate/snapshot native abort (exit null) as native_worker_crash', () => {
    expect(classifyRenderCrash(NATIVE_CRASH, null, false)).toBe('native_worker_crash');
    expect(classifyRenderCrash(NATIVE_CRASH, 134, false)).toBe('native_worker_crash'); // SIGABRT-style nonzero
  });

  it('classifies a timeout as timeout regardless of stderr', () => {
    expect(classifyRenderCrash('', null, true)).toBe('timeout');
    expect(classifyRenderCrash(NATIVE_CRASH, null, true)).toBe('timeout');
  });

  it('does not misclassify a clean exit or an ordinary error', () => {
    expect(classifyRenderCrash(NATIVE_CRASH, 0, false)).toBeNull(); // exit 0 is not a crash
    expect(classifyRenderCrash('E_EDIT_FAILED: some ffmpeg error', 1, false)).toBeNull();
    expect(classifyRenderCrash('', 1, false)).toBeNull();
  });
});

describe('machineRamGB', () => {
  it('reports a positive coarse RAM figure', () => {
    const gb = machineRamGB();
    expect(gb).toBeGreaterThan(0);
    expect(gb).toBeLessThan(4096);
  });
});

describe('render-resilience profile (P1/P2)', () => {
  it('isConstrainedMachine: low RAM or observed software GPU forces constrained', () => {
    expect(isConstrainedMachine(LOW_RAM_GB)).toBe(true);          // boundary: ≤8GB
    expect(isConstrainedMachine(LOW_RAM_GB - 1)).toBe(true);
    expect(isConstrainedMachine(16)).toBe(false);
    expect(isConstrainedMachine(64, 'software')).toBe(true);      // software GPU forces it even on a big box
    expect(isConstrainedMachine(64, 'hardware')).toBe(false);
  });

  it('estimateRenderCost: frames × megapixels — the 60s@60fps 1080x1920 case is heavy', () => {
    const heavy = estimateRenderCost(1080, 1920, 60, 60);   // ~7452
    const ok = estimateRenderCost(1080, 1920, 30, 30);      // ~1863
    expect(heavy).toBeGreaterThan(HEAVY_RENDER_COST);
    expect(ok).toBeLessThan(HEAVY_RENDER_COST);
  });

  it('renderCostDecision: capable machine or light comp proceeds; heavy+constrained draft degrades, final fails fast', () => {
    const heavy = HEAVY_RENDER_COST + 1000;
    const light = HEAVY_RENDER_COST - 1000;
    expect(renderCostDecision({ constrained: false, costUnits: heavy, isFinal: true })).toBe('proceed');
    expect(renderCostDecision({ constrained: true, costUnits: light, isFinal: true })).toBe('proceed');
    expect(renderCostDecision({ constrained: true, costUnits: heavy, isFinal: false })).toBe('degrade');
    expect(renderCostDecision({ constrained: true, costUnits: heavy, isFinal: true })).toBe('fail_fast');
  });

  it('degradedFps: lowers >30 fps to 30, leaves ≤30 as-is', () => {
    expect(degradedFps(60)).toBe(30);
    expect(degradedFps(48)).toBe(30);
    expect(degradedFps(30)).toBe(30);
    expect(degradedFps(24)).toBe(24);
  });
});
