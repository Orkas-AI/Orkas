import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(
  __dirname,
  '../../resources/builtin/marketplace/agents/bcfcb4921dce/skills/ui-design-executor/scripts/validate-html-artifact.mjs',
);
const SKILL_DIR = path.dirname(path.dirname(SCRIPT));
const PC_ROOT = path.resolve(__dirname, '../..');
const RUNNER = path.join(PC_ROOT, 'bin', 'run-skill.cjs');

const roots: string[] = [];

function makeArtifact(overrides: { html?: string; manifest?: Record<string, unknown>; asset?: boolean } = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uidesigner-validator-'));
  roots.push(root);
  const html = overrides.html ?? `<!doctype html>
<html><head><meta charset="utf-8"><style>body { color: #111; }</style></head>
<body><main><h1>Renewal risk workbench</h1><button id="save">Save changes</button></main>
<script>document.getElementById('save').addEventListener('click', () => {});</script></body></html>`;
  fs.writeFileSync(path.join(root, 'index.html'), html);
  if (overrides.asset) {
    fs.mkdirSync(path.join(root, 'assets'));
    fs.writeFileSync(path.join(root, 'assets', 'hero.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  }
  const manifest = overrides.manifest ?? {
    schema_version: 1,
    artifact_id: 'ui-renewal-risk',
    format: 'html',
    entry: 'index.html',
    revision: 1,
    files: overrides.asset ? ['artifact.json', 'assets/hero.svg', 'index.html'] : ['artifact.json', 'index.html'],
  };
  fs.writeFileSync(path.join(root, 'artifact.json'), JSON.stringify(manifest, null, 2));
  return root;
}

function run(root: string, expectations: string[] = []) {
  const result = spawnSync(process.execPath, [
    RUNNER,
    'ui-design-executor',
    'validate-html-artifact',
    '--',
    root,
    ...expectations.flatMap((expectation) => ['--expect', expectation]),
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ORKAS_PC_DIR: PC_ROOT,
      ORKAS_RUN_SKILL_DIR: SKILL_DIR,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    report: JSON.parse(result.stdout) as {
      ok: boolean;
      expectations: string[];
      inferredExpectations: string[];
      checks: Record<string, boolean>;
      errors: string[];
      warnings: string[];
    },
  };
}

function liveReadyHtml(omissions: string[] = []): string {
  const states = [
    ['loading', '<p aria-busy="true">正在加载项目状态…</p>'],
    ['empty', '<p>暂无项目。连接数据源后重试。</p>'],
    ['failed-refresh', '<p role="alert">刷新失败，请重试。</p>'],
    ['partial', '<p>部分数据暂不可用，当前结果可能不完整。</p>'],
  ].filter(([state]) => !omissions.includes(state));
  const lastUpdated = omissions.includes('last-updated')
    ? ''
    : '<p>最后更新：<time data-field="lastUpdated" datetime="2026-08-09T12:00:00Z">刚刚</time></p>';
  return `<!doctype html><html><head><title>Live project status</title></head><body><main>
    <h1>项目状态</h1>${lastUpdated}
    ${states.map(([state, body]) => `<section data-live-state="${state}" hidden>${body}</section>`).join('\n')}
    <section data-live-state="populated"><p>三个项目正在推进。</p></section>
  </main><script>
    const requestedState = new URLSearchParams(location.search).get('state') || 'populated';
    document.querySelectorAll('[data-live-state]').forEach((panel) => {
      panel.hidden = panel.dataset.liveState !== requestedState;
    });
  </script></body></html>`;
}

function rasterHandoffHtml(
  briefOverrides: Record<string, unknown> = {},
  hookPath = 'assets/hero.webp',
): string {
  const brief = {
    capability: 'raster-image-generation',
    status: 'pending',
    composition: 'isometric climate-tech city with a clear product focal point',
    aspect: '16:9',
    width: 1600,
    height: 900,
    palette: ['#123c34', '#9bdd6c'],
    background: 'opaque light mist',
    save_path: 'assets/hero.webp',
    ...briefOverrides,
  };
  return `<!doctype html><html><head><title>Climate technology</title></head><body><main>
    <h1>Climate infrastructure for resilient cities</h1>
    <figure data-raster-src="${hookPath}">
      <div class="raster-fallback">原创等距城市插画待生成；当前显示排版安全的占位背景。</div>
    </figure>
    <template class="asset-brief" type="application/json">${JSON.stringify(brief)}</template>
  </main></body></html>`;
}

function addJsonFile(root: string, relativePath: string, value: unknown): void {
  const absolutePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, JSON.stringify(value, null, 2));
  const manifestPath = path.join(root, 'artifact.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { files: string[] };
  manifest.files = [...new Set([...manifest.files, relativePath])].sort();
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('UIDesigner fast artifact validator', () => {
  it('accepts a meaningful static HTML artifact without requiring JavaScript', () => {
    const result = run(makeArtifact({
      html: `<!doctype html><html><head><title>Static renewal brief</title></head><body>
        <main><h1>Renewal planning brief</h1><p>Prioritize customer conversations before the renewal window closes.</p></main>
      </body></html>`,
    }));

    expect(result.status).toBe(0);
    expect(result.report).toMatchObject({ ok: true, errors: [] });
  });

  it('accepts a compact package with parseable HTML, script, and local asset inventory', () => {
    const result = run(makeArtifact({
      asset: true,
      html: `<!doctype html><html><head><style>main { display: grid; }</style></head><body>
        <main style="background-image: url('assets/hero.svg')"><h1>Subject-specific workspace</h1><img src="assets/hero.svg" alt="City plan"></main>
        <script>document.querySelector('main').addEventListener('click', () => {});</script>
      </body></html>`,
    }));

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.report).toMatchObject({ ok: true, errors: [] });
  });

  it('does not infer missing behavior from enabled controls', () => {
    const result = run(makeArtifact({
      html: `<!doctype html><html><head></head><body><main>
        <h1>Renewal risk workbench</h1>
        <button type="button">Export risk list</button>
        <input id="customerSearch" type="search" aria-label="Search customers">
        <select id="riskFilter" aria-label="Filter by risk"><option>All risks</option></select>
      </main></body></html>`,
    }));

    expect(result.status).toBe(0);
    expect(result.report.ok).toBe(true);
    expect(result.report.errors).toEqual([]);
    expect(result.report.warnings).toEqual([]);
  });

  it('does not reject collection-bound controls that a source regex cannot prove', () => {
    const result = run(makeArtifact({
      html: `<!doctype html><html><head></head><body><main>
        <h1>Account access</h1>
        <button type="button" data-view="login">Sign in</button>
        <button type="button" data-view="register">Create account</button>
        <section id="currentView">Sign in to continue to your account.</section>
      </main><script>
        document.querySelectorAll('[data-view]').forEach((control) => {
          control.addEventListener('click', () => {
            currentView.textContent = control.dataset.view === 'login'
              ? 'Sign in to continue to your account.'
              : 'Create an account to continue.';
          });
        });
      </script></body></html>`,
    }));

    expect(result.status).toBe(0);
    expect(result.report.ok).toBe(true);
    expect(result.report.errors).toEqual([]);
    expect(result.report.warnings).toEqual([]);
  });

  it('does not infer recovery behavior from source labels or data attributes', () => {
    const result = run(makeArtifact({
      html: `<!doctype html><html><head></head><body><main>
        <h1>Renewal risk workbench</h1>
        <div id="stateControls">
          <button type="button" data-state="populated">Populated</button>
          <button type="button" data-state="error">Error</button>
        </div>
        <section id="riskList">Unable to load renewal risks. Contact the data team.</section>
      </main><script>
        stateControls.addEventListener('click', (event) => {
          const control = event.target.closest('[data-state]');
          if (control) riskList.dataset.uiState = control.dataset.state;
        });
      </script></body></html>`,
    }));

    expect(result.status).toBe(0);
    expect(result.report.ok).toBe(true);
    expect(result.report.errors.join('\n')).not.toMatch(/interaction-control-wiring/);
    expect(result.report.errors.join('\n')).not.toMatch(/interaction-error-recovery/);
    expect(result.report.warnings).toEqual([]);
  });

  it('accepts wired workbench controls and a delegated error recovery action', () => {
    const result = run(makeArtifact({
      html: `<!doctype html><html><head></head><body><main>
        <h1>Renewal risk workbench</h1>
        <input id="customerSearch" type="search" aria-label="Search customers">
        <select id="riskFilter" aria-label="Filter by risk"><option>All risks</option></select>
        <button id="exportRisks" type="button">Export risk list</button>
        <div id="stateControls">
          <button type="button" data-state="populated">Populated</button>
          <button type="button" data-state="error">Error</button>
        </div>
        <section id="riskList">Customer renewal risks</section>
      </main><script>
        customerSearch.addEventListener('input', () => { riskList.textContent = 'Filtered customers'; });
        riskFilter.addEventListener('change', () => { riskList.textContent = 'Filtered risks'; });
        exportRisks.addEventListener('click', () => { riskList.textContent = 'Risk list exported'; });
        stateControls.addEventListener('click', (event) => {
          const control = event.target.closest('[data-state]');
          if (!control) return;
          if (control.dataset.state === 'error') {
            riskList.innerHTML = '<p>Unable to load renewal risks.</p><button type="button" data-action="retry">Retry loading</button>';
          }
        });
        riskList.addEventListener('click', (event) => {
          if (event.target.closest('[data-action]')?.dataset.action === 'retry') riskList.textContent = 'Loading renewal risks';
        });
      </script></body></html>`,
    }));

    expect(result.status).toBe(0);
    expect(result.report).toMatchObject({ ok: true, errors: [] });
  });

  it('rejects custom field errors that are not exposed through the accessibility tree', () => {
    const result = run(makeArtifact({
      html: `<!doctype html><html><head></head><body><main>
        <h1>Personal finance account access</h1>
        <form><label for="login-email">Email</label>
          <input id="login-email" name="email" type="email">
          <p id="login-email-error" class="field-error">Enter a valid email address.</p>
          <button type="submit">Sign in</button>
        </form>
      </main></body></html>`,
    }));

    expect(result.status).toBe(1);
    expect(result.report.ok).toBe(false);
    expect(result.report.errors.join('\n')).toMatch(/form-error-accessibility/);
    expect(result.report.errors.join('\n')).toContain('aria-describedby="login-email-error"');
    expect(result.report.errors.join('\n')).toContain('aria-invalid');
  });

  it('accepts a custom field error linked with aria-describedby and aria-invalid', () => {
    const result = run(makeArtifact({
      html: `<!doctype html><html><head></head><body><main>
        <h1>Personal finance account access</h1>
        <form><label for="login-email">Email</label>
          <input id="login-email" name="email" type="email" aria-invalid="false" aria-describedby="login-email-help login-email-error">
          <p id="login-email-help">Use the email linked to your account.</p>
          <p id="login-email-error" class="field-error" role="alert">Enter a valid email address.</p>
          <button type="submit">Sign in</button>
        </form>
      </main></body></html>`,
    }));

    expect(result.status).toBe(0);
    expect(result.report).toMatchObject({ ok: true, errors: [] });
  });

  it('does not cross-associate exact field errors when forms reuse id and name tokens', () => {
    const result = run(makeArtifact({
      html: `<!doctype html><html><head></head><body><main>
        <h1>Personal finance account access</h1>
        <form id="login-form">
          <label for="login-email">Email</label>
          <input id="login-email" name="email" type="email" aria-invalid="false" aria-describedby="login-email-help login-email-error">
          <p id="login-email-help">Use the email linked to your account.</p>
          <p id="login-email-error" class="field-error" role="alert">Enter a valid login email.</p>
          <label for="login-password">Password</label>
          <input id="login-password" name="password" type="password" aria-invalid="false" aria-describedby="login-password-error">
          <p id="login-password-error" class="field-error" role="alert">Enter your login password.</p>
          <button type="submit">Sign in</button>
        </form>
        <form id="register-form">
          <label for="register-email">Email</label>
          <input id="register-email" name="email" type="email" aria-invalid="false" aria-describedby="register-email-error">
          <p id="register-email-error" class="field-error" role="alert">Enter a valid registration email.</p>
          <button type="submit">Create account</button>
        </form>
        <form id="recover-form">
          <label for="recover-email">Email</label>
          <input id="recover-email" name="email" type="email" aria-invalid="false" aria-describedby="recover-email-error">
          <p id="recover-email-error" class="field-error" role="alert">Enter a valid recovery email.</p>
          <button type="submit">Recover account</button>
        </form>
      </main></body></html>`,
    }));

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.report).toEqual(expect.objectContaining({ ok: true, errors: [], warnings: [] }));
  });

  it('ignores inert script and template markup when resolving field-error ids', () => {
    const result = run(makeArtifact({
      html: `<!doctype html><html><head></head><body><main>
        <h1>Personal finance account access</h1>
        <form><label for="login-email">Email</label>
          <input id="login-email" name="email" type="email" aria-invalid="false" aria-describedby="login-email-error">
          <p id="login-email-error" class="field-error" role="alert">Enter a valid email address.</p>
          <button type="submit">Sign in</button>
        </form>
        <template><p id="login-email-error" class="field-error">A future replacement state.</p></template>
        <script>const futureError = '<p id="login-email-error" class="field-error">Try again.</p>';</script>
      </main></body></html>`,
    }));

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.report).toEqual(expect.objectContaining({ ok: true, errors: [], warnings: [] }));
  });

  it('still rejects a directly linked custom field error when aria-invalid is missing', () => {
    const result = run(makeArtifact({
      html: `<!doctype html><html><head></head><body><main>
        <h1>Personal finance account access</h1>
        <form><label for="account-email">Email</label>
          <input id="account-email" name="email" type="email" aria-describedby="account-email-error">
          <p id="account-email-error" class="field-error" role="alert">Enter a valid email address.</p>
          <button type="submit">Continue</button>
        </form>
      </main></body></html>`,
    }));

    expect(result.stderr).toBe('');
    expect(result.status).toBe(1);
    expect(result.report.errors.join('\n')).toContain('account-email -> account-email-error missing aria-invalid');
    expect(result.report.errors.join('\n')).not.toContain('missing aria-describedby');
  });

  it('warns without blocking when a semantic error has no deterministic field owner', () => {
    const result = run(makeArtifact({
      html: `<!doctype html><html><head></head><body><main>
        <h1>Personal finance account access</h1>
        <form><label for="account-email">Email</label>
          <input id="account-email" name="email" type="email">
          <p id="form-submit-error" class="field-error" role="alert">The request could not be completed.</p>
          <button type="submit">Continue</button>
        </form>
      </main></body></html>`,
    }));

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.report).toMatchObject({ ok: true, errors: [] });
    expect(result.report.warnings.join('\n')).toMatch(/form-submit-error could not be mapped deterministically/);
  });

  it('warns without blocking for missing and ambiguous error targets referenced by aria-describedby', () => {
    const cases = [
      {
        label: 'missing',
        errorMarkup: '',
        expected: 'has a missing aria-describedby target',
      },
      {
        label: 'ambiguous',
        errorMarkup: [
          '<p id="login-email-error" class="field-error">First error.</p>',
          '<p id="login-email-error" class="field-error">Second error.</p>',
        ].join(''),
        expected: 'has an ambiguous aria-describedby target (2 matching ids)',
      },
    ];

    for (const testCase of cases) {
      const result = run(makeArtifact({
        html: `<!doctype html><html><head></head><body><main>
          <h1>Personal finance account access</h1>
          <form><label for="login-email">Email</label>
            <input id="login-email" name="email" type="email" aria-invalid="false" aria-describedby="login-email-error">
            ${testCase.errorMarkup}
            <button type="submit">Sign in to your account</button>
          </form>
        </main></body></html>`,
      }));

      expect(result.stderr, testCase.label).toBe('');
      expect(result.status, testCase.label).toBe(0);
      expect(result.report.ok, testCase.label).toBe(true);
      expect(result.report.errors, testCase.label).toEqual([]);
      expect(result.report.warnings.join('\n'), testCase.label).toContain(testCase.expected);
    }
  });

  it('rejects malformed inline JavaScript and generated inline event handlers', () => {
    const result = run(makeArtifact({
      html: `<!doctype html><html><head></head><body><main>Visible static fallback content</main>
        <script>panel.innerHTML = '<button onclick="save()">Save</button>'; function broken( {</script>
      </body></html>`,
    }));

    expect(result.status).toBe(1);
    expect(result.report.ok).toBe(false);
    expect(result.report.errors.join('\n')).toMatch(/inline-script-syntax/);
    expect(result.report.errors.join('\n')).toMatch(/runtime-event-wiring/);
  });

  it('parses inline JSON data as JSON instead of JavaScript', () => {
    const valid = run(makeArtifact({
      html: `<!doctype html><html><head><title>Project preview</title></head><body><main>
        <h1>Project status preview</h1><p>Normalized sample data is available for this static render.</p>
        <script id="preview-data" type="application/json">{"projects":[],"meta":{"updatedAt":"2026-08-09"}}</script>
      </main></body></html>`,
    }));
    expect(valid.status).toBe(0);
    expect(valid.report.checks['inline-data-syntax']).toBe(true);
    expect(valid.report.errors).toEqual([]);

    const invalid = run(makeArtifact({
      html: `<!doctype html><html><head><title>Project preview</title></head><body><main>
        <h1>Project status preview</h1><p>Normalized sample data is available for this static render.</p>
        <script id="preview-data" type="application/json">{"projects": [}</script>
      </main></body></html>`,
    }));
    expect(invalid.status).toBe(1);
    expect(invalid.report.checks['inline-data-syntax']).toBe(false);
    expect(invalid.report.errors.join('\n')).toMatch(/inline-data-syntax/);
    expect(invalid.report.errors.join('\n')).not.toMatch(/inline-script-syntax/);
  });

  it('requires an interactive initializer to expose a real guarded fallback', () => {
    for (const initializerName of ['initSettings', 'setupApp', 'mountApp', 'hydrateApp']) {
      const unguarded = run(makeArtifact({
        html: `<!doctype html><html><head></head><body>
          <main><h1>Account settings</h1><button id="save">Save</button><p id="runtimeStatus" hidden>Fallback</p></main>
          <script>
            function ${initializerName}() { save.addEventListener('click', () => {}); }
            try { document.addEventListener('DOMContentLoaded', ${initializerName}); } catch (error) { runtimeStatus.hidden = false; }
          </script>
        </body></html>`,
      }));

      expect(unguarded.status, initializerName).toBe(1);
      expect(unguarded.report.ok, initializerName).toBe(false);
      expect(unguarded.report.errors.join('\n'), initializerName).toMatch(/runtime-guarded-init/);
    }

    const guarded = run(makeArtifact({
      html: `<!doctype html><html><head></head><body>
        <main><h1>Account settings</h1><button id="save">Save</button><p id="runtimeStatus" hidden>Fallback</p></main>
        <script>
          function setupApp() { save.addEventListener('click', () => {}); }
          function safeInit() {
            try { setupApp(); }
            catch (error) { runtimeStatus.hidden = false; runtimeStatus.textContent = 'Initialization failed. Retry.'; }
          }
          if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', safeInit, { once: true });
          } else {
            safeInit();
          }
        </script>
      </body></html>`,
    }));

    expect(guarded.status).toBe(0);
    expect(guarded.report).toMatchObject({ ok: true, errors: [] });

    const inlineGuard = run(makeArtifact({
      html: `<!doctype html><html><head></head><body>
        <main><h1>Account settings</h1><button id="save">Save</button><p id="runtimeStatus" hidden>Fallback</p></main>
        <script>
          function hydrateApp() { save.addEventListener('click', () => {}); }
          document.addEventListener('DOMContentLoaded', () => {
            try { hydrateApp(); }
            catch (error) { runtimeStatus.hidden = false; runtimeStatus.textContent = 'Initialization failed. Retry.'; }
          }, { once: true });
        </script>
      </body></html>`,
    }));

    expect(inlineGuard.status).toBe(0);
    expect(inlineGuard.report).toMatchObject({ ok: true, errors: [] });
  });

  it('binds guarded-initialization evidence to the registered callback', () => {
    const result = run(makeArtifact({
      html: `<!doctype html><html><head></head><body>
        <main><h1>Account settings</h1><button id="save">Save</button><p id="runtimeStatus" hidden>Fallback</p></main>
        <script>
          function setupApp() { save.addEventListener('click', () => {}); }
          function safeInit() {
            try { noop(); }
            catch (error) { runtimeStatus.hidden = false; runtimeStatus.textContent = 'Initialization failed. Retry.'; }
          }
          document.addEventListener('DOMContentLoaded', setupApp);
        </script>
      </body></html>`,
    }));

    expect(result.status).toBe(1);
    expect(result.report.ok).toBe(false);
    expect(result.report.errors.join('\n')).toMatch(/runtime-guarded-init/);
  });

  it('rejects stale manifest inventory and missing local references', () => {
    const result = run(makeArtifact({
      html: '<!doctype html><html><head></head><body><main>Visible artifact content</main><img src="assets/missing.png"></body></html>',
      manifest: {
        artifact_id: 'ui-stale',
        format: 'html',
        entry: 'index.html',
        revision: 1,
        files: ['index.html', 'artifact.json'],
      },
    }));

    expect(result.status).toBe(1);
    expect(result.report.errors.join('\n')).toMatch(/manifest-files/);
    expect(result.report.errors.join('\n')).toMatch(/local-references/);
  });

  it('does not treat an inert pending raster hook as an active local reference', () => {
    const artifact = makeArtifact({
      html: [
        '<!doctype html><html><head></head><body>',
        '<main><h1>Climate city landing page</h1>',
        '<figure data-raster-src="assets/hero.webp"><p class="fallback">Pending original city illustration</p></figure>',
        '</main></body></html>',
      ].join(''),
    });
    const result = run(artifact);

    expect(result.status).toBe(0);
    expect(result.report).toMatchObject({ ok: true, errors: [] });
  });

  it('keeps expectation profiles opt-in for ordinary HTML validation', () => {
    const result = run(makeArtifact({
      html: `<!doctype html><html><head><title>Static dashboard</title></head><body><main>
        <h1>Static project summary</h1>
        <p>Future work may include loading, empty, refresh failure, partial data, and last updated states.</p>
        <svg viewBox="0 0 100 60" role="img" aria-label="Decorative city illustration"></svg>
      </main></body></html>`,
    }));

    expect(result.status).toBe(0);
    expect(result.report).toMatchObject({ ok: true, expectations: [], errors: [] });
    expect(Object.keys(result.report.checks).some((id) => id.startsWith('expect-'))).toBe(false);
  });

  it('accepts implemented live-ready states through the task-scoped profile', () => {
    const result = run(makeArtifact({ html: liveReadyHtml() }), ['live-ready']);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.report).toMatchObject({
      ok: true,
      expectations: ['live-ready'],
      errors: [],
      checks: {
        'expect-live-loading': true,
        'expect-live-empty': true,
        'expect-live-failed-refresh': true,
        'expect-live-stale-partial': true,
        'expect-live-last-updated': true,
      },
    });
  });

  it('reports each missing live-ready state with a focused deterministic error', () => {
    const cases = [
      ['loading', 'expect-live-loading'],
      ['empty', 'expect-live-empty'],
      ['failed-refresh', 'expect-live-failed-refresh'],
      ['partial', 'expect-live-stale-partial'],
      ['last-updated', 'expect-live-last-updated'],
    ];

    for (const [omission, expectedCheck] of cases) {
      const result = run(makeArtifact({ html: liveReadyHtml([omission]) }), ['live-ready']);
      expect(result.status, omission).toBe(1);
      expect(result.report.ok, omission).toBe(false);
      expect(result.report.checks[expectedCheck], omission).toBe(false);
      expect(result.report.errors.join('\n'), omission).toContain(`${expectedCheck}:`);
    }
  });

  it('does not accept a prose or comment-only inventory as live-state implementation', () => {
    const result = run(makeArtifact({
      html: `<!doctype html><html><head><title>Live plan</title></head><body><main>
        <h1>Project status preview</h1>
        <p>The design plan mentions loading, empty, failed refresh, partial data, and last updated.</p>
        <!-- data-live-state="loading" data-live-state="empty" data-live-state="failed-refresh" data-live-state="partial" -->
      </main></body></html>`,
    }), ['live-ready']);

    expect(result.status).toBe(1);
    expect(result.report.ok).toBe(false);
    expect(result.report.checks).toMatchObject({
      'expect-live-loading': false,
      'expect-live-empty': false,
      'expect-live-failed-refresh': false,
      'expect-live-stale-partial': false,
      'expect-live-last-updated': false,
    });
  });

  it('allows safety declarations but rejects sensitive keys in persisted live JSON', () => {
    const safeRoot = makeArtifact({ html: liveReadyHtml() });
    addJsonFile(safeRoot, 'data/provenance.json', {
      security_exclusions: ['No cookies stored', 'No provider responses stored'],
    });
    const safe = run(safeRoot, ['live-ready']);
    expect(safe.status).toBe(0);
    expect(safe.report.checks['expect-live-safe-persistence']).toBe(true);

    const unsafeRoot = makeArtifact({ html: liveReadyHtml() });
    addJsonFile(unsafeRoot, 'data/data.json', {
      projects: [],
      token: 'sk-example-value-that-must-not-persist',
    });
    const unsafe = run(unsafeRoot, ['live-ready']);
    expect(unsafe.status).toBe(1);
    expect(unsafe.report.checks['expect-live-safe-persistence']).toBe(false);
    expect(unsafe.report.errors.join('\n')).toMatch(/data\/data\.json\.token/);
  });

  it('accepts a complete pending raster handoff without requiring the raster file', () => {
    const result = run(makeArtifact({ html: rasterHandoffHtml() }), ['raster-handoff']);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.report).toMatchObject({
      ok: true,
      expectations: ['raster-handoff'],
      errors: [],
      checks: {
        'expect-raster-brief-schema': true,
        'expect-raster-brief-route': true,
        'expect-raster-brief-fields': true,
        'expect-raster-brief-ratio': true,
        'expect-raster-integration': true,
        'expect-raster-fallback': true,
      },
    });
  });

  it('infers a raster handoff only for a self-described original hero SVG substitution', () => {
    const manifest = {
      schema_version: 1,
      artifact_id: 'climate-hero',
      format: 'html',
      entry: 'index.html',
      revision: 1,
      design: {
        direction: '深色气候科技页面，搭配原创等距绿色城市 hero 插画。',
        fixed_decisions: ['保留原创城市 hero 插画作为首屏视觉中心'],
      },
      files: ['artifact.json', 'index.html'],
    };
    const html = `<!doctype html><html><head><title>Climate hero</title></head><body><main>
      <h1>Climate infrastructure for resilient cities</h1>
      <svg class="hero-art" viewBox="0 0 1600 900" role="img" aria-label="原创等距城市插画"></svg>
    </main></body></html>`;
    const inferred = run(makeArtifact({ html, manifest }));

    expect(inferred.status).toBe(1);
    expect(inferred.report.expectations).toContain('raster-handoff');
    expect(inferred.report.inferredExpectations).toEqual(['raster-handoff']);
    expect(inferred.report.checks['expect-raster-brief-schema']).toBe(false);

    const explicitVector = run(makeArtifact({
      html,
      manifest: {
        ...manifest,
        design: {
          direction: '用户明确要求 SVG 矢量 hero 插画，作为 HTML 的首屏视觉中心。',
          fixed_decisions: ['保留用户要求的 SVG vector medium'],
        },
      },
    }));
    expect(explicitVector.status).toBe(0);
    expect(explicitVector.report).toMatchObject({
      ok: true,
      expectations: [],
      inferredExpectations: [],
      errors: [],
    });
  });

  it('rejects incomplete or contradictory raster handoffs with focused diagnostics', () => {
    const cases: Array<{
      label: string;
      html: string;
      expectedCheck: string;
    }> = [
      {
        label: 'missing capability route',
        html: rasterHandoffHtml({ capability: '' }),
        expectedCheck: 'expect-raster-brief-route',
      },
      {
        label: 'false completed status',
        html: rasterHandoffHtml({ status: 'completed' }),
        expectedCheck: 'expect-raster-brief-route',
      },
      {
        label: 'one-color palette',
        html: rasterHandoffHtml({ palette: ['#123c34'] }),
        expectedCheck: 'expect-raster-brief-fields',
      },
      {
        label: 'missing background treatment',
        html: rasterHandoffHtml({ background: '' }),
        expectedCheck: 'expect-raster-brief-fields',
      },
      {
        label: 'aspect ratio conflict',
        html: rasterHandoffHtml({ height: 1200 }),
        expectedCheck: 'expect-raster-brief-ratio',
      },
      {
        label: 'integration path drift',
        html: rasterHandoffHtml({}, 'assets/other.webp'),
        expectedCheck: 'expect-raster-integration',
      },
      {
        label: 'missing fallback',
        html: rasterHandoffHtml().replace('class="raster-fallback"', 'class="hero-frame"').replace('待生成；当前显示排版安全的占位背景', '视觉区域'),
        expectedCheck: 'expect-raster-fallback',
      },
    ];

    for (const testCase of cases) {
      const result = run(makeArtifact({ html: testCase.html }), ['raster-handoff']);
      expect(result.status, testCase.label).toBe(1);
      expect(result.report.ok, testCase.label).toBe(false);
      expect(result.report.checks[testCase.expectedCheck], testCase.label).toBe(false);
      expect(result.report.errors.join('\n'), testCase.label).toContain(`${testCase.expectedCheck}:`);
    }
  });

  it('rejects inline SVG-only substitution under the raster-handoff profile', () => {
    const result = run(makeArtifact({
      html: `<!doctype html><html><head><title>Climate city</title></head><body><main>
        <h1>Climate infrastructure for resilient cities</h1>
        <svg viewBox="0 0 1600 900" role="img" aria-label="Original isometric city"></svg>
      </main></body></html>`,
    }), ['raster-handoff']);

    expect(result.status).toBe(1);
    expect(result.report.ok).toBe(false);
    expect(result.report.checks).toMatchObject({
      'expect-raster-brief-schema': false,
      'expect-raster-brief-route': false,
      'expect-raster-integration': false,
      'expect-raster-fallback': false,
    });
  });

  it('rejects a manifest without stable identity and revision fields', () => {
    const result = run(makeArtifact({
      manifest: {
        entry: 'index.html',
        files: ['artifact.json', 'index.html'],
      },
    }));

    expect(result.status).toBe(1);
    expect(result.report.errors.join('\n')).toMatch(/manifest-contract/);
  });

  it('rejects revision zero instead of treating it as a pre-validation draft state', () => {
    const result = run(makeArtifact({
      manifest: {
        schema_version: 1,
        artifact_id: 'ui-revision-zero',
        format: 'html',
        entry: 'index.html',
        revision: 0,
        files: ['artifact.json', 'index.html'],
      },
    }));

    expect(result.stderr).toBe('');
    expect(result.status).toBe(1);
    expect(result.report.errors.join('\n')).toMatch(/manifest-contract/);
  });

  it('rejects an unsorted manifest inventory even when it names every file', () => {
    const result = run(makeArtifact({
      manifest: {
        schema_version: 1,
        artifact_id: 'ui-unsorted',
        format: 'html',
        entry: 'index.html',
        revision: 1,
        files: ['index.html', 'artifact.json'],
      },
    }));

    expect(result.status).toBe(1);
    expect(result.report.ok).toBe(false);
    expect(result.report.errors.join('\n')).toMatch(/manifest-files: files must be sorted/);
  });

  it('rejects a local reference that reaches outside the artifact through a symbolic link', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'uidesigner-outside-'));
    roots.push(outside);
    fs.writeFileSync(path.join(outside, 'private.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');

    const root = makeArtifact({
      html: `<!doctype html><html><head></head><body>
        <main><h1>Portable customer workspace</h1><img src="assets/hero.svg" alt="City plan"></main>
      </body></html>`,
    });
    fs.mkdirSync(path.join(root, 'assets'));
    fs.symlinkSync(path.join(outside, 'private.svg'), path.join(root, 'assets', 'hero.svg'));

    const result = run(root);

    expect(result.status).toBe(1);
    expect(result.report.ok).toBe(false);
    expect(result.report.errors.join('\n')).toMatch(/artifact-boundary/);
  });
});
