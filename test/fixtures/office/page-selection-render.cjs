// Exercise the production renderer in real Chromium with known Office HTML.
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, session } = require('electron');
const pc = process.argv[2];
const output = process.argv[3];
app.setPath('userData', path.join(process.env.ORKAS_WORKSPACE_ROOT, 'browser'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
require(path.join(pc, 'node_modules/tsx/dist/cjs/index.cjs'));
let html = '';
const engine = path.join(pc, 'src/main/features/office/office_engine.ts');
require.cache[engine] = { id: engine, filename: engine, loaded: true, exports: {
  runOfficeCli: async args => {
    fs.writeFileSync(args[args.indexOf('-o') + 1], html);
    return { code: 0, stdout: '', stderr: '' };
  },
} };
const { renderOfficePageToPng } = require(path.join(pc, 'src/main/features/office/office_page_renderer.ts'));
let security;
class ObservedWindow extends BrowserWindow {
  constructor(options) {
    super(options);
    this.webContents.on('console-message', details => security.logs.push({ level: details.level, message: details.message }));
    const capture = this.webContents.capturePage.bind(this.webContents);
    this.webContents.capturePage = async rect => {
      Object.assign(security, await this.webContents.executeJavaScript('window.securityProbe.finished.then(() => window.securityProbe.facts)'));
      return capture(rect);
    };
  }
}
app.whenReady().then(async () => {
  const rows = [];
  try {
    for (const [extension, container] of [['docx', 'page'], ['pptx', 'slide'], ['xlsx', 'sheet-content']]) {
      for (const visible of [true, false]) {
        // A real, empty page is valid. Hidden pages model an out-of-range
        // selection emitted with exit code 0 by the pinned native engine.
        security = { logs: [] };
        html = `<!doctype html><style>body{margin:0}.${container}{width:200px;height:200px;display:${visible ? 'block' : 'none'}}</style><div class="${container}"></div>
<script>
window.securityProbe = { facts: { inlineScript: true, nodeAccess: typeof require !== 'undefined', evalBlocked: false, connectBlocked: false } };
try { eval('window.securityProbe.facts.evalRan = true'); } catch { window.securityProbe.facts.evalBlocked = true; }
window.securityProbe.finished = fetch('data:text/plain,controlled-probe')
  .then(() => {}).catch(() => { window.securityProbe.facts.connectBlocked = true; });
</script>`;
        try {
          const png = await renderOfficePageToPng(path.join(process.env.ORKAS_WORKSPACE_ROOT, `fixture.${extension}`), process.env.ORKAS_WORKSPACE_ROOT, visible ? '1' : '3', undefined, {
            loadElectron: async () => ({ BrowserWindow: ObservedWindow, session }),
          });
          rows.push({ extension, visible, rendered: png.length > 0, security });
        } catch (error) {
          rows.push({ extension, visible, rendered: false, error: error.message });
        }
      }
    }
    fs.writeFileSync(output, JSON.stringify(rows));
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { app.exit(process.exitCode || 0); }
});
