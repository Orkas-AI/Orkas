import type { ElectronApplication } from '@playwright/test';

/** Execute the shipped tray + restore composition with the actual main window.
 * Only the native popup is intercepted: hidden tests never display a menu. */
export async function trayMenu(electron: ElectronApplication, event: 'click' | 'right-click' = 'click') {
  return electron.evaluate(({ app, BrowserWindow }, event) => {
    const load = (process as any).mainModule.require.bind((process as any).mainModule);
    const root = app.getAppPath(), fs = load('node:fs'), path = load('node:path'), vm = load('node:vm'), ts = load(path.join(root, 'node_modules/typescript'));
    const source = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8');
    const tree = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
    const names = ['createAppTray', 'showMainWindow'];
    const functions = tree.statements.filter((node: any) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text)).map((node: any) => node.getText(tree));
    if (functions.length !== 2) throw new Error('Shipped tray composition missing');
    const main = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/renderer/index.html'))!;
    const sandbox: any = { app, process, path, paths: load(path.join(root, 'src/main/paths.ts')), APP_DISPLAY_NAME: 'Orkas',
      mainWindows: new Set([main]), createWindow: () => { throw new Error('Open must reuse the main window'); },
      createOptionalTray: load(path.join(root, 'src/main/util/app-tray.ts')).createOptionalTray,
      t: load(path.join(root, 'src/main/i18n.ts')).t, log: { warn: () => { throw new Error('Tray creation failed'); } },
      setImmediate, appTray: null };
    vm.runInNewContext(ts.transpileModule(functions.join('\n') + '\ncreateAppTray();', { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, sandbox);
    const tray = sandbox.appTray;
    if (!tray) throw new Error('Native tray was not created');
    let menu: any;
    try { tray.popUpContextMenu = (value: any) => { menu = value; }; tray.emit(event); }
    finally { tray.destroy(); }
    if (!menu) throw new Error('Tray click did not open a native menu');
    (app as any).__desktopTestMenu = menu;
    return menu.items.map((item: any) => ({ label: item.label, type: item.type, enabled: item.enabled }));
  }, event);
}
export async function selectTrayItem(electron: ElectronApplication, index: 0 | 1) {
  await electron.evaluate(({ app }, index) => {
    const menu = (app as any).__desktopTestMenu;
    if (!menu) throw new Error('Native tray menu not captured');
    const item = menu.items[index]; item.click(undefined, undefined, {});
  }, index);
}
