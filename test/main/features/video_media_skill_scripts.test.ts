import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

function pcDir() {
  return fs.existsSync(path.join(process.cwd(), 'bin', 'run-skill.cjs'))
    ? process.cwd()
    : path.resolve(process.cwd(), 'PC');
}

function skillDir(skillId: 'stage-edit' | 'stage-plan' | 'stage-compose') {
  return path.join(
    pcDir(),
    'resources',
    'builtin',
    'marketplace',
    'agents',
    '79df9cc89f5f',
    'skills',
    skillId,
  );
}

function runSkill(
  skillId: 'stage-edit' | 'stage-compose',
  script: string,
  args: string[],
  extraEnv: Record<string, string> = {},
) {
  const dir = pcDir();
  const workspaceRoot = path.join(os.tmpdir(), 'orkas-video-skill-workspace');
  return spawnSync(
    process.execPath,
    [path.join(dir, 'bin', 'run-skill.cjs'), skillId, script, '--', ...args],
    {
      cwd: path.dirname(dir),
      encoding: 'utf8',
      env: {
        ...process.env,
        ORKAS_PC_DIR: dir,
        ORKAS_RUN_SKILL_DIR: skillDir(skillId),
        ORKAS_WORKSPACE_ROOT: workspaceRoot,
        ...extraEnv,
      },
    },
  );
}

function runRenderCompositionWithMockCore(args: string[], extraEnv: Record<string, string> = {}) {
  const dir = pcDir();
  const scriptPath = path.join(skillDir('stage-compose'), 'scripts', 'render_composition.js');
  const code = [
    "const Module = require('node:module');",
    'const scriptPath = process.argv[1];',
    'const args = JSON.parse(process.argv[2]);',
    'const originalLoad = Module._load;',
    'Module._load = function(request, parent, isMain) {',
    "  if (request === './lib/video_render_core.cjs' && parent && parent.filename === scriptPath) {",
    '    return {',
    '      qaComposition: async (op) => {',
    "        if (process.env.ORKAS_MOCK_LINT_ERROR === '1' && op === 'lint') {",
    "          return { ok: true, findings: JSON.stringify({ ok: false, errorCount: 1, warningCount: 0, findings: [{ code: 'gsap_timeline_not_registered', severity: 'error', message: 'timeline missing' }] }) };",
    '        }',
    "        if (process.env.ORKAS_MOCK_INSPECT_VISUAL_ERROR === '1' && op === 'inspect') {",
    "          return { ok: true, findings: JSON.stringify({ ok: false, errorCount: 2, warningCount: 1, issueCount: 3, totalIssueCount: 3, issues: [",
    "            { code: 'text_box_overflow', severity: 'error', selector: 'p.card-copy', message: 'Text extends outside its nearest visual/container box.' },",
    "            { code: 'text_occluded', severity: 'error', selector: 'h1.headline', message: 'Text is hidden beneath an opaque element.' },",
    "            { code: 'content_overlap', severity: 'warning', selector: 'h1.headline', message: 'Two text blocks overlap.' }",
    '          ] }) };',
    '        }',
    "        if (process.env.ORKAS_MOCK_INSPECT_STRUCTURAL_ERROR === '1' && op === 'inspect') {",
    "          return { ok: true, findings: JSON.stringify({ ok: false, errorCount: 1, warningCount: 0, issueCount: 1, totalIssueCount: 1, issues: [{ code: 'timeline_runtime_missing', severity: 'error', message: 'Timeline runtime is not available.' }] }) };",
    '        }',
    "        return { ok: true, findings: JSON.stringify({ ok: true, errorCount: 0, warningCount: 0, issueCount: 0, totalIssueCount: 0, issues: [] }) };",
    '      },',
    '      renderComposition: async (p) => {',
    "        if (process.env.ORKAS_MOCK_RENDER_OK === '1') {",
    "          require('node:fs').mkdirSync(require('node:path').dirname(p.outputAbsPath), { recursive: true });",
    "          require('node:fs').writeFileSync(p.outputAbsPath, 'fake video output');",
    "          return { ok: true, path: p.outputAbsPath, bytes: 17 };",
    '        }',
    "        return { ok: false, errorCode: 'E_RENDER_FAILED', message: 'fake render failed' };",
    '      },',
    // Render-resilience helpers mirror the real pure functions; default RAM 32
    // keeps existing tests on the unconstrained "proceed" path.
    '      machineRamGB: () => (process.env.ORKAS_MOCK_RAM_GB ? Number(process.env.ORKAS_MOCK_RAM_GB) : 32),',
    "      isConstrainedMachine: (ram, gpu) => (Number(ram) <= 8 || gpu === 'software'),",
    '      estimateRenderCost: (w, h, dur, fps) => Math.round(Math.max(1, dur) * Math.max(1, fps) * Math.max(1, (w * h) / 1e6)),',
    "      renderCostDecision: (o) => (!o.constrained || o.costUnits <= 3000 ? 'proceed' : (o.isFinal ? 'fail_fast' : 'degrade')),",
    '      degradedFps: (fps) => (fps > 30 ? 30 : fps),',
    '    };',
    '  }',
    '  return originalLoad.apply(this, arguments);',
    '};',
    'const script = require(scriptPath);',
    "Promise.resolve(script({ args })).then((out) => { process.stdout.write(JSON.stringify(out)); }).catch((err) => { process.stderr.write(err && err.stack ? err.stack : String(err)); process.exit(1); });",
  ].join('\n');
  return spawnSync(
    process.execPath,
    ['-e', code, scriptPath, JSON.stringify(args)],
    {
      cwd: path.dirname(dir),
      encoding: 'utf8',
      env: {
        ...process.env,
        ORKAS_PC_DIR: dir,
        ORKAS_RUN_SKILL_DIR: skillDir('stage-compose'),
        ORKAS_WORKSPACE_ROOT: path.dirname(dir),
        ...extraEnv,
      },
    },
  );
}

function parseJson(text: string) {
  return JSON.parse(text.trim());
}

function makeFakeFfmpegEnv(tmp: string) {
  const binDir = path.join(tmp, 'fake-bin');
  fs.mkdirSync(binDir, { recursive: true });

  const ffprobePath = path.join(binDir, 'ffprobe');
  fs.writeFileSync(ffprobePath, [
    '#!/usr/bin/env node',
    "process.stdout.write('10');",
    '',
  ].join('\n'), 'utf8');
  fs.chmodSync(ffprobePath, 0o755);

  const ffmpegPath = path.join(binDir, 'ffmpeg');
  fs.writeFileSync(ffmpegPath, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    'const out = process.argv[process.argv.length - 1];',
    "process.stderr.write('out_time_us=1000000\\nprogress=continue\\n');",
    "process.stderr.write('out_time_us=2000000\\nprogress=end\\n');",
    "fs.writeFileSync(out, 'fake video output');",
    '',
  ].join('\n'), 'utf8');
  fs.chmodSync(ffmpegPath, 0o755);

  return {
    ORKAS_BUNDLED_FFMPEG: ffmpegPath,
    ORKAS_BUNDLED_FFPROBE: ffprobePath,
  };
}

function makeFakeVideoProbeEnv(tmp: string) {
  const binDir = path.join(tmp, 'fake-probe-bin');
  fs.mkdirSync(binDir, { recursive: true });
  const ffprobePath = path.join(binDir, 'ffprobe');
  fs.writeFileSync(ffprobePath, [
    '#!/usr/bin/env node',
    'process.stdout.write(JSON.stringify({',
    "  streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, r_frame_rate: '30/1', bit_rate: '800000' }],",
    "  format: { duration: '10', size: '17', bit_rate: '800000' }",
    '}));',
    '',
  ].join('\n'), 'utf8');
  fs.chmodSync(ffprobePath, 0o755);
  return { ORKAS_BUNDLED_FFPROBE: ffprobePath };
}

function writeMinimalCompositionHtml(
  compositionDir: string,
  text = 'Orkas 1.5.0',
  attrs: { width?: number; height?: number; duration?: number } = {},
  head = '',
) {
  const width = attrs.width ?? 1920;
  const height = attrs.height ?? 1080;
  const duration = attrs.duration ?? 10;
  fs.writeFileSync(path.join(compositionDir, 'index.html'), [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="UTF-8" />',
    `<meta name="viewport" content="width=${width}, height=${height}" />`,
    head,
    '</head>',
    '<body>',
    `<div id="root" data-composition-id="main" data-start="0" data-duration="${duration}" data-width="${width}" data-height="${height}">`,
    `<div class="clip" data-start="0" data-duration="${duration}" data-track-index="1">${text}</div>`,
    '</div>',
    '<script>window.__timelines = window.__timelines || {}; window.__timelines.main = { seek() {} };</script>',
    '</body>',
    '</html>',
  ].join('\n'), 'utf8');
}

function writeDesignContract(
  compositionDir: string,
  overrides: Record<string, unknown> = {},
) {
  const contract = {
    canvas: { width: 1920, height: 1080, duration: 10, fps: 30, language: 'en' },
    aesthetic: {
      subject_world: 'release notes',
      audience: 'product users',
      one_job: 'state the update',
      tone: ['clear'],
      signature_device: 'version lockup',
      aesthetic_risk: 'bold cover frame',
      anti_template_check: 'no generic cards',
    },
    scenes: [{ id: 'cover', start: 0, duration: 10, headline: 'Orkas 1.5.0' }],
    color_tokens: { background: '#050b18', text: '#ffffff', primary: '#3b82f6' },
    ...overrides,
  };
  fs.writeFileSync(path.join(compositionDir, 'design-contract.json'), JSON.stringify(contract), 'utf8');
}

describe('video media skill scripts', () => {
  it('keeps VideoStudio media logic local to skill scripts', () => {
    const files = [
      path.join(skillDir('stage-edit'), 'scripts', 'analyze_media.js'),
      path.join(skillDir('stage-edit'), 'scripts', 'edit_video.js'),
      path.join(skillDir('stage-edit'), 'scripts', 'lib', 'video_analyze_core.cjs'),
      path.join(skillDir('stage-edit'), 'scripts', 'lib', 'video_edit_core.cjs'),
      path.join(skillDir('stage-plan'), 'scripts', 'video_plan.js'),
      path.join(skillDir('stage-plan'), 'scripts', 'lib', 'video_decide_core.cjs'),
      path.join(skillDir('stage-plan'), 'scripts', 'lib', 'video_edl_core.cjs'),
      path.join(skillDir('stage-compose'), 'scripts', 'render_composition.js'),
      path.join(skillDir('stage-compose'), 'scripts', 'lib', 'video_render_core.cjs'),
    ];
    const forbidden = [
      /\bpcRequire\b/,
      /src\/main\/features/,
      /src\/main\/util\/uniquify/,
      /electron-log/,
      /node_modules\/electron/,
      /require\(["']electron["']\)/,
    ];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      for (const re of forbidden) expect(text, `${file} contains ${re}`).not.toMatch(re);
    }

    for (const file of [
      path.join(pcDir(), 'src', 'main', 'features', 'video_analyze.ts'),
      path.join(pcDir(), 'src', 'main', 'features', 'video_decide.ts'),
      path.join(pcDir(), 'src', 'main', 'features', 'video_edit.ts'),
      path.join(pcDir(), 'src', 'main', 'features', 'video_edl.ts'),
      path.join(pcDir(), 'src', 'main', 'features', 'video_render.ts'),
      path.join(pcDir(), 'src', 'main', 'features', 'video_craft_lint.ts'),
    ]) {
      expect(fs.existsSync(file), `${file} should not exist`).toBe(false);
    }
  });

  it('exposes analyze_media through the stage-edit skill runner', () => {
    const res = runSkill('stage-edit', 'analyze_media', ['--help']);
    expect(res.status, res.stderr).toBe(0);
    const out = parseJson(res.stdout);
    expect(out.ok).toBe(true);
    expect(out.ops).toContain('transcribe');
    expect(out.ops).toContain('quality');
  });

  it('exposes edit_video through the stage-edit skill runner', () => {
    const res = runSkill('stage-edit', 'edit_video', ['--help']);
    expect(res.status, res.stderr).toBe(0);
    const out = parseJson(res.stdout);
    expect(out.ok).toBe(true);
    expect(out.ops).toContain('trim');
    expect(out.ops).toContain('mix');
    expect(out.ops).toContain('normalize_loudness');
  });

  it('keeps edit_video stdout parseable while streaming progress JSONL on stderr', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-video-progress-'));
    const input = path.join(tmp, 'input.mp4');
    const output = path.join(tmp, 'trimmed.mp4');
    fs.writeFileSync(input, 'fake input', 'utf8');

    const res = runSkill('stage-edit', 'edit_video', [
      '--op', 'trim',
      '--input', input,
      '--output', output,
      '--start', '0',
      '--duration', '2',
    ], makeFakeFfmpegEnv(tmp));

    expect(res.status, res.stderr).toBe(0);
    expect(parseJson(res.stdout)).toMatchObject({ ok: true, op: 'trim' });
    const progress = res.stderr.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    expect(progress).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'progress', source: 'video_edit', op: 'trim', status: 'running' }),
      expect.objectContaining({ type: 'progress', source: 'video_edit', op: 'trim', status: 'completed', percent: 100 }),
    ]));
  });

  it('exposes render_composition through the stage-compose skill runner', () => {
    const res = runSkill('stage-compose', 'render_composition', ['--help']);
    expect(res.status, res.stderr).toBe(0);
    const out = parseJson(res.stdout);
    expect(out.ok).toBe(true);
    expect(out.ops).toContain('inspect');
    expect(out.ops).toContain('render');
    expect(out.ops).toContain('draft');
    expect(out.ops).not.toContain('compile');
    expect(out.usage).toContain('--strict-craft');
    expect(out.usage).toContain('--findings-output');
    expect(out.usage).toContain('--findings-inline');
    expect(out.usage).toContain('hand-authored index.html');
  });

  it('blocks draft when hand-authored composition HTML is missing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-compose-html-missing-'));
    const compositionDir = path.join(tmp, 'project', 'composition');
    fs.mkdirSync(compositionDir, { recursive: true });

    const res = runSkill('stage-compose', 'render_composition', [
      '--op', 'draft',
      '--composition-dir', compositionDir,
      '--output', path.join(tmp, 'project', 'render', 'draft.mp4'),
    ]);

    expect(res.status).toBe(1);
    const out = parseJson(res.stderr);
    expect(out.code).toBe('E_RENDER_NO_COMPOSITION');
    expect(out.message).toContain('hand-authored index.html');
  });

  it('rejects composition spec compilation so COMPOSE stays model-authored HTML', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-compose-spec-rejected-'));
    const compositionDir = path.join(tmp, 'project', 'composition');
    fs.mkdirSync(compositionDir, { recursive: true });
    fs.writeFileSync(path.join(compositionDir, 'spec.json'), JSON.stringify({ scenes: [] }), 'utf8');

    const res = runSkill('stage-compose', 'render_composition', [
      '--op', 'draft',
      '--composition-dir', compositionDir,
      '--output', path.join(tmp, 'project', 'render', 'draft.mp4'),
    ]);

    expect(res.status).toBe(1);
    const out = parseJson(res.stderr);
    expect(out.code).toBe('E_SPEC_COMPILER_REMOVED');
    expect(out.message).toContain('index.html');
  });

  it('blocks draft when model-authored HTML has no design contract', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-compose-contract-missing-'));
    const compositionDir = path.join(tmp, 'project', 'composition');
    fs.mkdirSync(compositionDir, { recursive: true });
    writeMinimalCompositionHtml(compositionDir);

    const res = runSkill('stage-compose', 'render_composition', [
      '--op', 'draft',
      '--composition-dir', compositionDir,
      '--output', path.join(tmp, 'project', 'render', 'draft.mp4'),
    ]);

    expect(res.status).toBe(1);
    const out = parseJson(res.stderr);
    expect(out.code).toBe('E_CONTRACT_HTML_BLOCKED');
    expect(out.repair_target).toBe('design-contract.json');
    expect(out.contract_html.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'DESIGN_CONTRACT_MISSING' }),
    ]));
  });

  it('warns when the contract declares narration but the composition is silent', () => {
    const runDraftIssues = (label: string, audio: Record<string, unknown> | undefined) => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `orkas-compose-${label}-`));
      const compositionDir = path.join(tmp, 'project', 'composition');
      fs.mkdirSync(compositionDir, { recursive: true });
      writeDesignContract(compositionDir, {
        scenes: [{ id: 'cover', start: 0, duration: 10, headline: 'Orkas 1.5.0 Release Highlights' }],
        ...(audio ? { audio } : {}),
      });
      // "Different title" forces HTML_MISSING_SCENE_COPY so draft blocks and
      // returns the full contract_html issue list (including any warnings).
      writeMinimalCompositionHtml(compositionDir, 'Different title', {});
      const res = runSkill('stage-compose', 'render_composition', [
        '--op', 'draft',
        '--composition-dir', compositionDir,
        '--output', path.join(tmp, 'project', 'render', 'draft.mp4'),
      ]);
      expect(res.status).toBe(1);
      const out = parseJson(res.stderr);
      expect(out.code).toBe('E_CONTRACT_HTML_BLOCKED');
      return (out.contract_html.issues as Array<{ code: string }>);
    };

    // Composition-owned narration declared, but no <audio> and no narration file → warn.
    const silent = runDraftIssues('narration-silent', { owner: 'composition', narration_path: './assets/narration.mp3', target_sec: 10 });
    expect(silent.find((i) => i.code === 'NARRATION_DECLARED_BUT_SILENT')).toBeTruthy();

    // Assembler-owned narration (composition renders silent by design) → no warn.
    const assembler = runDraftIssues('narration-assemble', { owner: 'assemble', narration_path: './assets/narration.mp3', render_silent: true });
    expect(assembler.find((i) => i.code === 'NARRATION_DECLARED_BUT_SILENT')).toBeUndefined();

    // No audio section at all → no warn.
    const none = runDraftIssues('narration-none', undefined);
    expect(none.find((i) => i.code === 'NARRATION_DECLARED_BUT_SILENT')).toBeUndefined();
  });

  it('blocks draft when HTML depends on remote runtime resources', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-compose-remote-resource-'));
    const compositionDir = path.join(tmp, 'project', 'composition');
    fs.mkdirSync(compositionDir, { recursive: true });
    writeDesignContract(compositionDir);
    writeMinimalCompositionHtml(
      compositionDir,
      'Orkas 1.5.0',
      {},
      '<script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"></script>',
    );

    const res = runSkill('stage-compose', 'render_composition', [
      '--op', 'draft',
      '--composition-dir', compositionDir,
      '--output', path.join(tmp, 'project', 'render', 'draft.mp4'),
    ]);

    expect(res.status).toBe(1);
    const out = parseJson(res.stderr);
    expect(out.code).toBe('E_CONTRACT_HTML_BLOCKED');
    expect(out.repair_target).toBe('index.html');
    expect(out.contract_html.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'REMOTE_RUNTIME_RESOURCE' }),
    ]));
  });

  it('blocks draft when GSAP is used without the local vendor script', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-compose-gsap-missing-vendor-'));
    const compositionDir = path.join(tmp, 'project', 'composition');
    fs.mkdirSync(compositionDir, { recursive: true });
    writeDesignContract(compositionDir);
    writeMinimalCompositionHtml(
      compositionDir,
      'Orkas 1.5.0',
      {},
      '<script>window.__timelines = {}; window.__timelines.main = gsap.timeline({ paused: true });</script>',
    );

    const res = runSkill('stage-compose', 'render_composition', [
      '--op', 'draft',
      '--composition-dir', compositionDir,
      '--output', path.join(tmp, 'project', 'render', 'draft.mp4'),
    ]);

    expect(res.status).toBe(1);
    const out = parseJson(res.stderr);
    expect(out.code).toBe('E_CONTRACT_HTML_BLOCKED');
    expect(out.contract_html.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'GSAP_VENDOR_SCRIPT_MISSING' }),
    ]));
  });

  it('auto-copies the local GSAP vendor when the composition references it', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-compose-gsap-vendor-copy-'));
    const compositionDir = path.join(tmp, 'project', 'composition');
    fs.mkdirSync(compositionDir, { recursive: true });
    writeDesignContract(compositionDir, {
      scenes: [{ id: 'cover', start: 0, duration: 10, headline: 'Orkas 1.5.0 Release Highlights' }],
    });
    writeMinimalCompositionHtml(
      compositionDir,
      'Different title',
      {},
      '<script src="./assets/vendor/gsap.min.js"></script><script>window.__timelines = {}; window.__timelines.main = gsap.timeline({ paused: true });</script>',
    );

    const res = runSkill('stage-compose', 'render_composition', [
      '--op', 'draft',
      '--composition-dir', compositionDir,
      '--output', path.join(tmp, 'project', 'render', 'draft.mp4'),
    ]);

    expect(res.status).toBe(1);
    expect(fs.existsSync(path.join(compositionDir, 'assets', 'vendor', 'gsap.min.js'))).toBe(true);
    const out = parseJson(res.stderr);
    expect(out.code).toBe('E_CONTRACT_HTML_BLOCKED');
    expect(out.contract_html.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'HTML_MISSING_SCENE_COPY' }),
    ]));
    expect(out.contract_html.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'MISSING_LOCAL_ASSET' }),
    ]));
  });

  it('replaces the old managed GSAP shim with the built-in official vendor', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-compose-gsap-vendor-replace-'));
    const compositionDir = path.join(tmp, 'project', 'composition');
    const vendorPath = path.join(compositionDir, 'assets', 'vendor', 'gsap.min.js');
    fs.mkdirSync(path.dirname(vendorPath), { recursive: true });
    fs.writeFileSync(vendorPath, [
      '/*',
      ' * Local HyperFrames timeline vendor.',
      ' * Provides the small GSAP-compatible surface VideoStudio compositions need.',
      ' */',
      'window.gsap = { timeline() { return { seek() {}, pause() {}, play() {}, timeScale() {}, totalTime() {}, duration() { return 0; }, totalDuration() { return 0; }, getChildren() { return []; } }; } };',
    ].join('\n'), 'utf8');
    writeDesignContract(compositionDir, {
      scenes: [{ id: 'cover', start: 0, duration: 10, headline: 'Orkas 1.5.0 Release Highlights' }],
    });
    writeMinimalCompositionHtml(
      compositionDir,
      'Different title',
      {},
      '<script src="./assets/vendor/gsap.min.js"></script><script>window.__timelines = {}; window.__timelines.main = gsap.timeline({ paused: true });</script>',
    );

    const res = runSkill('stage-compose', 'render_composition', [
      '--op', 'draft',
      '--composition-dir', compositionDir,
      '--output', path.join(tmp, 'project', 'render', 'draft.mp4'),
    ]);

    expect(res.status).toBe(1);
    const vendor = fs.readFileSync(vendorPath, 'utf8');
    expect(vendor).toContain('GSAP 3.15.0');
    expect(vendor).toContain('timeScale');
    expect(vendor).toContain('totalTime');
    expect(vendor).toContain('getChildren');
  });

  it('blocks a user-provided incompatible GSAP vendor before rendering', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-compose-gsap-vendor-incompatible-'));
    const compositionDir = path.join(tmp, 'project', 'composition');
    const vendorPath = path.join(compositionDir, 'assets', 'vendor', 'gsap.min.js');
    fs.mkdirSync(path.dirname(vendorPath), { recursive: true });
    fs.writeFileSync(vendorPath, '/* custom gsap placeholder */ window.gsap = {};', 'utf8');
    writeDesignContract(compositionDir);
    writeMinimalCompositionHtml(
      compositionDir,
      'Orkas 1.5.0',
      {},
      '<script src="./assets/vendor/gsap.min.js"></script><script>window.__timelines = {}; window.__timelines.main = gsap.timeline({ paused: true });</script>',
    );

    const res = runSkill('stage-compose', 'render_composition', [
      '--op', 'draft',
      '--composition-dir', compositionDir,
      '--output', path.join(tmp, 'project', 'render', 'draft.mp4'),
    ]);

    expect(res.status).toBe(1);
    const out = parseJson(res.stderr);
    expect(out.code).toBe('E_VENDOR_ASSETS_BLOCKED');
    expect(out.repair_target).toBe('assets/vendor/gsap.min.js');
    expect(out.vendor_assets.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'VENDOR_GSAP_INCOMPATIBLE' }),
    ]));
    expect(fs.readFileSync(vendorPath, 'utf8')).toContain('custom gsap placeholder');
  });

  it('writes the latest draft report when render fails after inspect', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-compose-draft-render-report-'));
    const compositionDir = path.join(tmp, 'project', 'composition');
    const outputPath = path.join(tmp, 'project', 'render', 'draft.mp4');
    const reportPath = path.join(tmp, 'project', 'render', 'draft-report.json');
    fs.mkdirSync(compositionDir, { recursive: true });
    writeDesignContract(compositionDir);
    writeMinimalCompositionHtml(compositionDir, 'Orkas 1.5.0');

    const res = runRenderCompositionWithMockCore([
      '--op', 'draft',
      '--composition-dir', compositionDir,
      '--output', outputPath,
      '--report', reportPath,
    ]);

    expect(res.status).toBe(1);
    const out = parseJson(res.stderr);
    expect(out.code).toBe('E_RENDER_FAILED');
    expect(out.report_path).toBe(reportPath);
    const report = parseJson(fs.readFileSync(reportPath, 'utf8'));
    expect(report.error).toMatchObject({ code: 'E_RENDER_FAILED', message: 'fake render failed' });
    expect(report.steps.inspect.ok).toBe(true);
    expect(report.steps.render).toMatchObject({ ok: false, errorCode: 'E_RENDER_FAILED', message: 'fake render failed' });
  });

  it('blocks draft on HyperFrames lint errors before inspect/render', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-compose-draft-lint-blocked-'));
    const compositionDir = path.join(tmp, 'project', 'composition');
    const outputPath = path.join(tmp, 'project', 'render', 'draft.mp4');
    const reportPath = path.join(tmp, 'project', 'render', 'draft-report.json');
    fs.mkdirSync(compositionDir, { recursive: true });
    writeDesignContract(compositionDir);
    writeMinimalCompositionHtml(compositionDir, 'Orkas 1.5.0');

    const res = runRenderCompositionWithMockCore([
      '--op', 'draft',
      '--composition-dir', compositionDir,
      '--output', outputPath,
      '--report', reportPath,
    ], { ORKAS_MOCK_LINT_ERROR: '1' });

    expect(res.status).toBe(1);
    const out = parseJson(res.stderr);
    expect(out.code).toBe('E_LINT_BLOCKED');
    expect(out.lint_summary.issueCodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'gsap_timeline_not_registered', severity: 'error' }),
    ]));
    const report = parseJson(fs.readFileSync(reportPath, 'utf8'));
    expect(report.steps.lint.ok).toBe(false);
    expect(report.steps.inspect).toBeUndefined();
    expect(report.steps.render).toBeUndefined();
  });

  it('renders draft when inspect only reports visual advisories', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-compose-draft-visual-advisory-'));
    const compositionDir = path.join(tmp, 'project', 'composition');
    const outputPath = path.join(tmp, 'project', 'render', 'draft.mp4');
    const reportPath = path.join(tmp, 'project', 'render', 'draft-report.json');
    fs.mkdirSync(compositionDir, { recursive: true });
    writeDesignContract(compositionDir);
    writeMinimalCompositionHtml(compositionDir, 'Orkas 1.5.0');

    const res = runRenderCompositionWithMockCore([
      '--op', 'draft',
      '--composition-dir', compositionDir,
      '--output', outputPath,
      '--report', reportPath,
      '--skip-video-qa',
      '--skip-normalize-audio',
    ], {
      ...makeFakeVideoProbeEnv(tmp),
      ORKAS_MOCK_INSPECT_VISUAL_ERROR: '1',
      ORKAS_MOCK_RENDER_OK: '1',
    });

    expect(res.status, res.stderr).toBe(0);
    const out = parseJson(res.stdout);
    expect(out.ok).toBe(true);
    expect(out.inspect).toMatchObject({
      ok: true,
      qa_ok: false,
      advisory_count: 3,
      blocking_error_count: 0,
    });
    const report = parseJson(fs.readFileSync(reportPath, 'utf8'));
    expect(report.ok).toBe(true);
    expect(report.steps.inspect).toMatchObject({
      ok: true,
      qa_ok: false,
      draft_disposition: {
        blocking_error_count: 0,
        advisory_count: 3,
      },
    });
    expect(report.steps.render).toMatchObject({ ok: true, path: outputPath });
  });

  it('fails a heavy FINAL render fast on a constrained machine (P2)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-compose-final-heavy-'));
    const compositionDir = path.join(tmp, 'project', 'composition');
    fs.mkdirSync(compositionDir, { recursive: true });
    // 1920x1080 × 60s → ~3726 cost units (> heavy threshold).
    writeMinimalCompositionHtml(compositionDir, 'Orkas 1.5.0', { width: 1920, height: 1080, duration: 60 });

    const res = runRenderCompositionWithMockCore([
      '--op', 'render',
      '--composition-dir', compositionDir,
      '--output', path.join(tmp, 'project', 'render', 'video.mp4'),
      '--quality', 'high',
    ], { ORKAS_MOCK_RAM_GB: '8', ORKAS_MOCK_RENDER_OK: '1' });

    expect(res.status).toBe(1);
    const out = parseJson(res.stderr);
    expect(out.code).toBe('E_RENDER_TOO_HEAVY');
    expect(out.render_profile).toMatchObject({ constrained: true, decision: 'fail_fast' });
  });

  it('degrades a heavy DRAFT render (lower fps) on a constrained machine instead of failing (P2)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-compose-draft-degrade-'));
    const compositionDir = path.join(tmp, 'project', 'composition');
    fs.mkdirSync(compositionDir, { recursive: true });
    writeDesignContract(compositionDir, { canvas: { width: 1920, height: 1080, duration: 60, fps: 60, language: 'en' } });
    writeMinimalCompositionHtml(compositionDir, 'Orkas 1.5.0', { width: 1920, height: 1080, duration: 60 });

    const res = runRenderCompositionWithMockCore([
      '--op', 'draft',
      '--composition-dir', compositionDir,
      '--output', path.join(tmp, 'project', 'render', 'draft.mp4'),
      '--report', path.join(tmp, 'project', 'render', 'draft-report.json'),
      '--skip-video-qa',
      '--skip-normalize-audio',
    ], { ...makeFakeVideoProbeEnv(tmp), ORKAS_MOCK_RAM_GB: '8', ORKAS_MOCK_RENDER_OK: '1' });

    expect(res.status, res.stderr).toBe(0);
    const out = parseJson(res.stdout);
    expect(out.ok).toBe(true);
    expect(out.render_profile).toMatchObject({ constrained: true, decision: 'degrade', degraded_fps: '60→30' });
  });

  it('blocks draft when inspect reports non-visual errors', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-compose-draft-inspect-blocked-'));
    const compositionDir = path.join(tmp, 'project', 'composition');
    const outputPath = path.join(tmp, 'project', 'render', 'draft.mp4');
    const reportPath = path.join(tmp, 'project', 'render', 'draft-report.json');
    fs.mkdirSync(compositionDir, { recursive: true });
    writeDesignContract(compositionDir);
    writeMinimalCompositionHtml(compositionDir, 'Orkas 1.5.0');

    const res = runRenderCompositionWithMockCore([
      '--op', 'draft',
      '--composition-dir', compositionDir,
      '--output', outputPath,
      '--report', reportPath,
    ], { ORKAS_MOCK_INSPECT_STRUCTURAL_ERROR: '1' });

    expect(res.status).toBe(1);
    const out = parseJson(res.stderr);
    expect(out.code).toBe('E_INSPECT_BLOCKED');
    expect(out.draft_disposition).toMatchObject({
      blocking_error_count: 1,
      advisory_count: 0,
    });
    const report = parseJson(fs.readFileSync(reportPath, 'utf8'));
    expect(report.steps.inspect).toMatchObject({
      ok: false,
      qa_ok: false,
      draft_disposition: {
        blocking_error_count: 1,
      },
    });
    expect(report.steps.render).toBeUndefined();
  });

  it('blocks draft when HTML canvas differs from the design contract', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-compose-canvas-mismatch-'));
    const compositionDir = path.join(tmp, 'project', 'composition');
    fs.mkdirSync(compositionDir, { recursive: true });
    writeDesignContract(compositionDir);
    writeMinimalCompositionHtml(compositionDir, 'Orkas 1.5.0', { width: 1080, height: 1080, duration: 10 });

    const res = runSkill('stage-compose', 'render_composition', [
      '--op', 'draft',
      '--composition-dir', compositionDir,
      '--output', path.join(tmp, 'project', 'render', 'draft.mp4'),
    ]);

    expect(res.status).toBe(1);
    const out = parseJson(res.stderr);
    expect(out.code).toBe('E_CONTRACT_HTML_BLOCKED');
    expect(out.contract_html.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'CANVAS_CONTRACT_MISMATCH' }),
    ]));
  });

  it('blocks draft when declared scene copy is not present in HTML', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-compose-scene-copy-missing-'));
    const compositionDir = path.join(tmp, 'project', 'composition');
    fs.mkdirSync(compositionDir, { recursive: true });
    writeDesignContract(compositionDir, {
      scenes: [{ id: 'cover', start: 0, duration: 10, headline: 'Orkas 1.5.0 Release Highlights' }],
    });
    writeMinimalCompositionHtml(compositionDir, 'Different title');

    const res = runSkill('stage-compose', 'render_composition', [
      '--op', 'draft',
      '--composition-dir', compositionDir,
      '--output', path.join(tmp, 'project', 'render', 'draft.mp4'),
    ]);

    expect(res.status).toBe(1);
    const out = parseJson(res.stderr);
    expect(out.code).toBe('E_CONTRACT_HTML_BLOCKED');
    expect(out.contract_html.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'HTML_MISSING_SCENE_COPY' }),
    ]));
  });

  it('blocks draft with a targeted error when scene-map JSON is invalid', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-compose-scene-map-invalid-'));
    const compositionDir = path.join(tmp, 'project', 'composition');
    fs.mkdirSync(compositionDir, { recursive: true });
    writeDesignContract(compositionDir);
    writeMinimalCompositionHtml(compositionDir);
    fs.writeFileSync(path.join(compositionDir, 'scene-map.json'), '{ nope', 'utf8');

    const res = runSkill('stage-compose', 'render_composition', [
      '--op', 'draft',
      '--composition-dir', compositionDir,
      '--output', path.join(tmp, 'project', 'render', 'draft.mp4'),
    ]);

    expect(res.status).toBe(1);
    const out = parseJson(res.stderr);
    expect(out.code).toBe('E_SCENE_MAP_PARSE_FAILED');
    expect(out.repair_target).toBe('scene-map.json');
  });

  it('fails edit_video before invoking ffmpeg when an input is missing', () => {
    const res = runSkill('stage-edit', 'edit_video', ['--op', 'probe', '--input', 'missing.mp4']);
    expect(res.status).toBe(1);
    const out = parseJson(res.stderr);
    expect(out.ok).toBe(false);
    expect(out.code).toBe('E_INPUT');
  });

  it('fails render_composition before invoking HyperFrames when the directory is missing', () => {
    const res = runSkill('stage-compose', 'render_composition', ['--op', 'inspect', '--composition-dir', 'missing-composition']);
    expect(res.status).toBe(1);
    const out = parseJson(res.stderr);
    expect(out.ok).toBe(false);
    expect(out.code).toBe('E_INPUT');
  });
});
