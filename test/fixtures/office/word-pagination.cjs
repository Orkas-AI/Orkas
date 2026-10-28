'use strict';
// Independent DOCX and screenshot-time observation through the production renderer.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { app, BrowserWindow, session, nativeImage } = require('electron');
const AdmZip = require('adm-zip');
const { foreignDocxBytes } = require('./foreign-docx.cjs');
const pc = process.argv[2];
const output = process.argv[3];
const root = process.env.ORKAS_WORKSPACE_ROOT;
app.setPath('userData', path.join(root, 'browser'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.on('window-all-closed', () => {});
process.on('uncaughtException', error => { console.error(error); app.exit(1); });
require(path.join(pc, 'node_modules/tsx/dist/cjs/index.cjs'));
const lines = Array.from({ length: 24 }, (_, i) => `Line ${String(i + 1).padStart(3, '0')}: confirmed handover item`);
const zip = new AdmZip(foreignDocxBytes(false));
const xml = zip.readAsText('word/document.xml');
const content = lines.map(text => '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="280" w:lineRule="exact"/></w:pPr>'
  + '<w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="24"/></w:rPr>'
  + `<w:t>${text}</w:t></w:r></w:p>`).join('');
zip.updateFile('word/document.xml', Buffer.from(xml
  .replace(/<w:body>[\s\S]*?<w:sectPr>/, '<w:body>' + content + '<w:sectPr>')
  .replace('w:w="11906" w:h="16838"', 'w:w="8000" w:h="7000"').replaceAll('1440', '720')));
const file = path.join(root, 'handover.docx');
fs.writeFileSync(file, zip.toBuffer());
const hash = () => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const before = hash();
const beforeMtime = fs.statSync(file, { bigint: true }).mtimeNs;
const rows = [];
let current;
class ObservedWindow extends BrowserWindow {
  constructor(options) {
    super(options);
    this.webContents.on('console-message', event => current.logs.push({ level: event.level, message: event.message }));
    const capture = this.webContents.capturePage.bind(this.webContents);
    this.webContents.capturePage = async rect => {
      current.paragraphs = await this.webContents.executeJavaScript(`(() => {
        const page = [...document.querySelectorAll('.page')].find(e => e.offsetParent !== null);
        const box = page.getBoundingClientRect();
        return [...page.querySelectorAll('p[data-path]')].filter(e => {
          const r = e.getBoundingClientRect();
          return r.top >= box.top && r.bottom <= box.bottom;
        }).map(e => e.innerText);
      })()`);
      return capture(rect);
    };
  }
}
app.whenReady().then(async () => {
  const { renderOfficePageToPng } = require(path.join(pc, 'src/main/features/office/office_page_renderer.ts'));
  const { runOfficeCli } = require(path.join(pc, 'src/main/features/office/office_engine.ts'));
  try {
    // Page 2 before page 1 also proves the first-page repair does not depend
    // on a preceding preview in the same browser window or resident process.
    for (const page of ['2', '1']) {
      current = { page, logs: [] };
      const png = await renderOfficePageToPng(file, root, page, undefined, {
        loadElectron: async () => ({ BrowserWindow: ObservedWindow, session }),
      });
      current.pngHeader = png.subarray(0, 8).toString('hex');
      const bitmap = nativeImage.createFromBuffer(png).toBitmap();
      current.darkPixels = 0;
      for (let i = 0; i < bitmap.length; i += 4) {
        if (bitmap[i] < 100 && bitmap[i + 1] < 100 && bitmap[i + 2] < 100) current.darkPixels++;
      }
      current.sourcePreserved = hash() === before && fs.statSync(file, { bigint: true }).mtimeNs === beforeMtime;
      rows.push(current);
    }
    fs.writeFileSync(output, JSON.stringify({ rows, remainingWindows: BrowserWindow.getAllWindows().length }));
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally {
    // The direct renderer's caller owns the per-file resident, just as the
    // production Office tool does. Close it before the parent removes cwd.
    try {
      const closed = await runOfficeCli(['close', file], { cwd: root, timeoutMs: 10_000 });
      if (closed.code !== 0 || closed.stderr) throw new Error('Office fixture resident did not close');
    } catch (error) { console.error(error); process.exitCode = 1; }
    app.exit(process.exitCode || 0);
  }
});
