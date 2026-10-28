// "Save as app" is offered from the file preview button and the conversation
// file menu. Oracle: docs/test/my-apps-regression.md save entries 2/3 — only
// HTML/HTM, CSS and JS/MJS application sources and directories containing an
// HTML entry offer it; images, JSON, audio/video, manifests, fonts, WASM,
// models, PDF, ZIP and plain directories never do, even beside an HTML entry.
// The inspection IPC is forwarded to the real main-process inspector over real
// files, so neither surface's result is decided by the fixture.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { drainMainRuntimeForTest } from '../helpers/drain-main-runtime';

vi.mock('../../src/main/model/client', () => ({
  async *streamChatWithModel() { yield { type: 'done' }; },
  async chatWithModel() { return { ok: true, text: '', error: '', aborted: false }; },
}));

const modulesDir = path.resolve(__dirname, '../../src/renderer/modules');
const viewerSource = fs.readFileSync(path.join(modulesDir, 'chat-file-viewer.js'), 'utf8');
const policySource = fs.readFileSync(path.join(modulesDir, 'file-operation-policy.js'), 'utf8');
const infoSource = fs.readFileSync(path.join(modulesDir, 'conversation-info.js'), 'utf8');

function extractFunction(source: string, name: string): string {
  const marker = source.indexOf(`async function ${name}(`) >= 0 ? `async function ${name}(` : `function ${name}(`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`missing ${name}`);
  const braceStart = source.indexOf('{', source.indexOf(')', start));
  for (let i = braceStart, depth = 0; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

let tmpDir = '', workspace = '', previousRoot: string | undefined;
let inspect: (target: string, opts: { fenceRoots: string[] }) => Promise<any>;
const saveable: string[] = ['app/index.html', 'app/page.htm', 'app/style.css', 'app/app.js', 'app/module.mjs', 'app'];
const notSaveable: string[] = ['app/logo.png', 'app/photo.jpg', 'app/icon.svg', 'app/data.json', 'app/site.webmanifest',
  'app/sound.mp3', 'app/clip.mp4', 'app/font.woff2', 'app/module.wasm', 'app/model.glb', 'app/report.pdf', 'app/bundle.zip',
  'app/assets', 'docs'];

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-save-entry-'));
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  workspace = path.join(tmpDir, 'workspace');
  fs.mkdirSync(path.join(workspace, 'app', 'assets'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'app', 'index.html'), '<!doctype html><title>Arcade</title>');
  for (const rel of [...saveable, ...notSaveable]) {
    const abs = path.join(workspace, rel);
    if (rel === 'app' || rel === 'app/assets' || rel === 'docs' || fs.existsSync(abs)) continue;
    fs.writeFileSync(abs, `fixture ${rel}`);
  }
  fs.writeFileSync(path.join(workspace, 'app', 'assets', 'sprite.png'), 'fixture sprite');
  fs.writeFileSync(path.join(workspace, 'docs', 'notes.md'), '# notes');
  const savedApps = await import('../../src/main/features/saved_apps');
  inspect = savedApps.inspectBundleFromPath;
});

afterAll(async () => {
  await drainMainRuntimeForTest();
  if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// The renderer sends only its payload; main applies the workspace fence.
const inspectionIpc = vi.fn(async (channel: string, payload: { path: string }) => {
  if (channel !== 'savedApps.inspectBundleFromPath') throw new Error(`unexpected channel: ${channel}`);
  return inspect(payload.path, { fenceRoots: [workspace] });
});

function fileViewer(invoke: (channel: string, payload: any) => Promise<any>) {
  const warnings: unknown[] = [];
  const context: any = { window: { orkas: { invoke } }, warnings };
  vm.createContext(context);
  vm.runInContext(`
    function button() { return { hidden: true, disabled: true, dataset: {}, attributes: {},
      setAttribute(name, value) { this.attributes[name] = value; } }; }
    var _viewerSaveAppBtn = button(), _viewerSaveNewAppBtn = button();
    var _viewerCurrentPath = null, _viewerCurrentCid = 'conversation-1', _viewerCurrentProjectId = null;
    var _viewerRenderSeq = 0;
    var _viewerLog = { warn: (...args) => warnings.push(args) };
    function _isViewerOpen() { return true; }
    ${extractFunction(viewerSource, '_viewerLabel')}
    ${extractFunction(viewerSource, '_setViewerButtonLabel')}
    ${extractFunction(viewerSource, '_viewerFileActionPayload')}
    ${extractFunction(viewerSource, '_setSaveAppVisible')}
    ${extractFunction(viewerSource, '_refreshSaveAppButton')}
    async function previewSaveAppVisible(target) {
      _viewerCurrentPath = target;
      await _refreshSaveAppButton(target);
      return !_viewerSaveAppBtn.hidden && !_viewerSaveAppBtn.disabled;
    }`, context, { filename: 'chat-file-viewer.js' });
  return {
    visible: (target: string) => context.previewSaveAppVisible(target) as Promise<boolean>, warnings,
    copyVisible: () => !context._viewerSaveNewAppBtn.hidden && !context._viewerSaveNewAppBtn.disabled,
  };
}

class MenuNode {
  id = ''; className = '';
  readonly classList = { add() {}, remove() {}, toggle() {} };
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly children: MenuNode[] = [];
  set innerHTML(value: string) {
    this.children.length = 0;
    for (const match of value.matchAll(/data-action="([^"]+)"/g)) {
      const child = new MenuNode(); child.dataset.action = match[1]; this.children.push(child);
    }
  }
  appendChild(child: MenuNode) { this.children.push(child); return child; }
  addEventListener() {} removeEventListener() {} setAttribute() {}
  querySelectorAll(selector: string) { return selector === '.ctx-row-menu-item' ? this.children : []; }
  closest() { return null; }
  contains() { return false; }
  getBoundingClientRect() { return { left: 20, right: 220, top: 20, bottom: 52, width: 200, height: 180 }; }
}

function conversationFileMenu(invoke: (channel: string, payload: any) => Promise<any>) {
  const elements = new Map<string, MenuNode>();
  const body = new MenuNode();
  body.appendChild = (child: MenuNode) => { if (child.id) elements.set(child.id, child); return child; };
  const context: any = {
    console, setTimeout, clearTimeout, encodeURIComponent, Date, Map, Set, Array, String, Number, RegExp,
    currentView: 'conversation', conversations: [{ conversation_id: 'conversation-1', project_id: '' }],
    createLogger: () => ({ warn() {}, info() {}, error() {} }),
    escapeHtml: (value: unknown) => String(value ?? ''),
    t: (key: string) => key,
    document: {
      readyState: 'complete', body, getElementById: (id: string) => elements.get(id) || null,
      createElement: () => new MenuNode(), querySelectorAll: () => [], addEventListener() {}, removeEventListener() {},
    },
    window: { innerWidth: 1200, innerHeight: 800, addEventListener() {}, removeEventListener() {}, orkas: { invoke } },
  };
  context.window.window = context.window;
  vm.createContext(context);
  vm.runInContext(policySource, context, { filename: 'file-operation-policy.js' });
  vm.runInContext(infoSource, context, { filename: 'conversation-info.js' });
  return async (target: string) => {
    await context.window.ConversationInfo.openFileMenu(new MenuNode(), target, path.basename(target), { cid: 'conversation-1' });
    const actions = elements.get('conversation-info-file-menu')!.children.map(item => item.dataset.action);
    await context.window.ConversationInfo.openFileMenu(new MenuNode(), target, path.basename(target), { cid: 'conversation-1' });
    return actions.includes('save-as-app');
  };
}

describe('Save as app entry visibility by file type', () => {
  const table = [...saveable.map(rel => [rel, true] as const), ...notSaveable.map(rel => [rel, false] as const)];

  it.each(table)('file preview offers Save as app for %s: %s', async (rel, expected) => {
    const viewer = fileViewer(inspectionIpc);
    expect(await viewer.visible(path.join(workspace, rel))).toBe(expected);
    expect(viewer.copyVisible()).toBe(false);
    expect(viewer.warnings).toEqual([]);
  });

  it.each(table)('conversation file menu offers Save as app for %s: %s', async (rel, expected) => {
    const menu = conversationFileMenu(inspectionIpc);
    expect(await menu(path.join(workspace, rel))).toBe(expected);
  });

  it('keeps both root-level entries discoverable so the user can receive recovery guidance', async () => {
    const invoke=async()=>({ok:true,canSave:false,reason:'app_bundle_root'});
    expect(await fileViewer(invoke).visible(path.join(workspace,'index.html'))).toBe(true);
    expect(await conversationFileMenu(invoke)(path.join(workspace,'index.html'))).toBe(true);
  });

  it('offers a copy only for an eligible source with a saved destination and clears it for the next file', async () => {
    const viewer = fileViewer(async (channel, payload) => ({
      ...await inspectionIpc(channel, payload), target: { appId: 'existing-app' },
    }));
    expect(await viewer.visible(path.join(workspace, 'app', 'index.html'))).toBe(true);
    expect(viewer.copyVisible()).toBe(true);
    expect(await viewer.visible(path.join(workspace, 'app', 'logo.png'))).toBe(false);
    expect(viewer.copyVisible()).toBe(false);
  });

  it('keeps both entries hidden when inspection fails or reports a refusal', async () => {
    const target = path.join(workspace, 'app', 'index.html');
    for (const invoke of [async () => { throw new Error('path is outside the user workspace'); },
      async () => ({ ok: false, error: 'path required' }), async () => ({ canSave: false })]) {
      const viewer = fileViewer(invoke);
      expect(await viewer.visible(target)).toBe(false);
      expect(await conversationFileMenu(invoke)(target)).toBe(false);
    }
  });
});
