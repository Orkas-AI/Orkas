// Test-owned packaged identity only. Never load the application bootstrap/account.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixture.json'), 'utf8'));
process.env.ORKAS_WORKSPACE_ROOT = path.join(config.root, 'data');
app.setPath('userData', path.join(config.root, 'electron-profile'));
app.setName(config.identity);
if (process.platform === 'win32') app.setAppUserModelId(config.identity);
if (process.platform === 'darwin') app.setActivationPolicy('prohibited');
require(path.join(config.pcRoot, 'node_modules/tsx/dist/cjs/index.cjs'));
const { createLoginStartup } = require(path.join(config.pcRoot, 'src/main/features/login_startup.ts'));
let windows = 0;
app.on('browser-window-created', () => { windows++; });
app.whenReady().then(() => {
  const phase = process.env.ORKAS_STARTUP_NATIVE_PHASE || 'read';
  const result = { phase, packaged: app.isPackaged, executable: process.execPath };
  try {
    if (!app.isPackaged || !config.identity.startsWith('org.orkas.startup-test.')) throw new Error('Unsafe test identity');
    const service = createLoginStartup({
      platform: process.platform, available: app.isPackaged, executable: process.execPath,
      get: options => app.getLoginItemSettings(options),
      set: settings => app.setLoginItemSettings(settings),
      getUser: () => 'test-only', hasEnabledAutomations: async () => false,
    });
    result.before = service.read();
    result.state = phase === 'enable' ? service.setEnabled(true) : phase === 'disable' ? service.setEnabled(false) : service.read();
  } catch (error) { result.error = error.code || error.message; }
  // Keep the independent OS observation even when the service rejects a write.
  try {
    result.native = app.getLoginItemSettings(process.platform === 'win32'
      ? { path: `"${process.execPath}"`, args: ['--orkas-startup'] } : undefined);
  } catch (error) { result.nativeError = error.code || error.message; }
  result.windows = windows + BrowserWindow.getAllWindows().length;
  fs.writeFileSync(path.join(config.root, `${phase}.json`), JSON.stringify(result, null, 2));
  app.exit(result.error ? 1 : 0);
}).catch(() => app.exit(1));
