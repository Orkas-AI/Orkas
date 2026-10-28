'use strict';
// Real OfficeCLI + Chromium integration. Only the log sink is replaced;
// cancellation is triggered by a completed native issue scan, without timers.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { app, BrowserWindow, nativeImage } = require('electron');
// Electron otherwise turns a module-load exception into a blocking GUI dialog.
process.on('uncaughtException', error => { console.error(error); app.exit(1); });
const { foreignDocxBytes } = require('./foreign-docx.cjs');
const AdmZip = require('adm-zip');
const pc = process.argv[2];
const output = process.argv[3];
const root = process.env.ORKAS_WORKSPACE_ROOT;
app.setPath('userData', path.join(root, 'browser'));
app.disableHardwareAcceleration();
// These hidden capture windows must stay at foreground priority. Avoid
// macOS task-suppression transitions when native suites run concurrently;
// keep stderr strict rather than suppressing Chromium scheduling failures.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.on('window-all-closed', () => {});
require(path.join(pc, 'node_modules/tsx/dist/cjs/index.cjs'));
const { makeMinimalPptx, makeNamespacedDirectXlsx } = require(path.join(pc, 'test/fixtures/make-minimal-office.ts'));
let active;
const bootstrapLogs = [];
const logger = path.join(pc, 'src/main/logger.ts');
require.cache[logger] = { id: logger, filename: logger, loaded: true, exports: {
  createLogger: scope => Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level,
    (...args) => (active?.logs || bootstrapLogs).push({ scope, level, args }),
  ])),
} };
app.on('browser-window-created', (_event, win) => {
  const owner = active;
  win.webContents.on('console-message', details => {
    owner?.browserLogs.push({ level: details.level, message: details.message });
  });
});
const enginePath = path.join(pc, 'src/main/features/office/office_engine.ts');
const engine = require(enginePath);
require.cache[enginePath].exports = {
  ...engine,
  runOfficeCli: async (args, opts) => {
    const result = await engine.runOfficeCli(args, opts);
    active?.commands.push({ verb: args[0], code: result.code, stderr: result.stderr, stdoutChars: result.stdout.length });
    if (active?.cancel && args[0] === 'view' && args[2] === 'issues') active.cancel.abort();
    return result;
  },
};
const rendererPath = path.join(pc, 'src/main/features/office/office_page_renderer.ts');
const renderer = require(rendererPath);
require.cache[rendererPath].exports = {
  ...renderer,
  renderOfficePageToPng: async (...args) => {
    try { return await renderer.renderOfficePageToPng(...args); }
    catch (error) {
      active?.renderErrors.push({ page: args[2], message: String(error.message).replaceAll(root, '<fixture>').slice(0, 2048) });
      throw error;
    }
  },
};
const { createOfficeTools } = require(path.join(pc, 'src/main/model/core-agent/office-tools.ts'));
const written = [];
const tools = createOfficeTools({
  userId: 'readonly-fixture', extraRoots: [root],
  hasProducedPath: file => written.includes(file),
  onFileWritten: file => written.push(file),
});
const review = tools.find(tool => tool.name === 'office_review');
const edit = tools.find(tool => tool.name === 'edit_office');
const context = { workingDir: root };
const hash = bytes => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
function reviewPresentationBytes() {
  // The shared minimal PPTX is an extraction fixture: its text has no shape
  // geometry. Give this rendering fixture an explicitly visible text box.
  const zip = new AdmZip(makeMinimalPptx({ slides: [['Review fixture content']] }));
  zip.updateFile('ppt/slides/slide1.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree><p:sp>
    <p:nvSpPr><p:cNvPr id="2" name="Review fixture text"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
    <p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="9144000" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>
    <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr sz="2400"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:rPr><a:t>Review fixture content</a:t></a:r></a:p></p:txBody>
  </p:sp></p:spTree></p:cSld>
</p:sld>`));
  return zip.toBuffer();
}
function checkReceipt(result, bytes) {
  const block = result.content.match(/<office-check>\n([\s\S]*?)\n<\/office-check>/);
  const receipt = JSON.parse(block ? block[1] : result.content);
  assert.equal(receipt.artifact_sha256, hash(bytes), 'receipt must identify the source bytes');
  for (const observation of result.observations?.fileReads || []) assert.equal(observation.hash, hash(bytes));
  return receipt;
}
function checkImage(image) {
  assert.equal(image.mediaType, 'image/png');
  const png = Buffer.from(image.data, 'base64');
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const decoded = nativeImage.createFromBuffer(png);
  assert.equal(decoded.isEmpty(), false);
  const size = decoded.getSize();
  assert(size.width > 100 && size.height > 100 && Math.max(size.width, size.height) <= 1920);
  // A valid PNG header is insufficient: the known text page must have ink.
  const bitmap = decoded.toBitmap();
  let dark = 0;
  for (let i = 0; i < bitmap.length; i += 4) {
    if (bitmap[i] < 100 && bitmap[i + 1] < 100 && bitmap[i + 2] < 100) dark++;
  }
  assert(dark > 100, 'review image must contain the fixture text, not a blank page');
}
function preserved(file, bytes, mtime) {
  assert.deepEqual(fs.readFileSync(file), bytes, 'read-only operation changed source bytes');
  assert.equal(fs.statSync(file, { bigint: true }).mtimeNs, mtime, 'read-only operation changed source mtime');
}
async function noResident(file) {
  const result = await engine.runOfficeCli(['close', file], { cwd: root, timeoutMs: 10_000 });
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /nothing to close/, 'tool must release its own resident before returning');
}
app.whenReady().then(async () => {
  assert.deepEqual(bootstrapLogs, [], 'unexpected application logs during fixture initialization');
  // Prove that the supported Electron event reaches the audit with its named
  // severity before an empty browserLogs array can establish a clean review.
  const consoleProbe = { browserLogs: [] };
  active = consoleProbe;
  const probeWindow = new BrowserWindow({ show: false });
  try {
    await probeWindow.loadURL('data:text/html,' + encodeURIComponent(
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'"><title>Office console capture probe</title>'));
    await probeWindow.webContents.executeJavaScript('console.warn("Office console capture probe")');
    assert.deepEqual(consoleProbe.browserLogs, [{ level: 'warning', message: 'Office console capture probe' }]);
  } finally { probeWindow.destroy(); active = undefined; }
  const rows = [];
  for (const id of ['combined-review', 'partial-page-retry', 'cancel-after-check', 'invalid-document', 'edit-then-review', 'xlsx-render', 'pptx-render']) {
    const row = { id, logs: [], browserLogs: [], commands: [], renderErrors: [] };
    active = row;
    const format = id === 'xlsx-render' ? 'xlsx' : id === 'pptx-render' ? 'pptx' : 'docx';
    const file = path.join(root, `${id}.${format}`);
    // Use a populated worksheet: a single short cell has fewer painted dark
    // pixels than the document-oriented nonblank image oracle below.
    const original = format === 'xlsx' ? makeNamespacedDirectXlsx({
      rows: Array.from({ length: 12 }, (_, i) => ['Review fixture', String(i + 1), '42']),
    })
      : format === 'pptx' ? reviewPresentationBytes() : foreignDocxBytes(true);
    if (id === 'invalid-document') {
      const zip = new AdmZip(original);
      zip.updateFile('word/document.xml', Buffer.from(zip.readAsText('word/document.xml').replace('<w:body>', '<w:body><w:invalidElement/>')));
      fs.writeFileSync(file, zip.toBuffer());
    } else fs.writeFileSync(file, original);
    const before = fs.readFileSync(file);
    const mtime = fs.statSync(file, { bigint: true }).mtimeNs;
    const writtenBefore = written.length;
    try {
      if (format !== 'docx') {
        const readback = await engine.runOfficeCli(['view', file, 'text'], { cwd: root });
        assert.equal(readback.code, 0);
        assert.equal(readback.stderr, '');
        assert(readback.stdout.includes('Review fixture'), 'native fixture must contain the intended text');
        const result = await review.execute({ action: 'render', path: file, pages: ['1'] }, context);
        assert(!result.isError, result.content);
        assert.equal(result.images.length, 1);
        checkImage(result.images[0]);
      } else if (id === 'edit-then-review') {
        const target = path.join(root, 'edited-copy.docx');
        const result = await edit.execute({ path: file, output_path: target,
          operations: [{ action: 'set', path: '/body/p[1]', props: { text: 'Edited content\nSecond line' } }], preview: false,
        }, context);
        assert(!result.isError, result.content);
        assert.deepEqual(written.slice(writtenBefore), [target]);
        const saved = fs.readFileSync(target);
        assert.notEqual(hash(saved), hash(before), 'edit must persist a new revision');
        const xml = new AdmZip(saved).readAsText('word/document.xml');
        assert(xml.includes('Edited content') && xml.includes('Second line'));
        assert.equal((xml.match(/<w:br[\s/>]/g) || []).length, 1, 'edit must preserve the soft-break contract');
        const savedMtime = fs.statSync(target, { bigint: true }).mtimeNs;
        const checked = await review.execute({ action: 'check_and_render', path: target, pages: ['1'] }, context);
        assert(!checked.isError, checked.content);
        assert.equal(checkReceipt(checked, saved).valid, true);
        assert.equal(checked.images.length, 1);
        checkImage(checked.images[0]);
        preserved(target, saved, savedMtime);
        await noResident(target);
      } else if (id === 'invalid-document') {
        const result = await review.execute({ action: 'check_and_render', path: file, pages: ['1'] }, context);
        assert.equal(result.isError, true);
        assert.equal(checkReceipt(result, before).valid, false);
        assert.equal(result.images?.length || 0, 0, 'invalid document must not render');
      } else {
        let signal;
        if (id === 'cancel-after-check') {
          row.cancel = new AbortController();
          signal = row.cancel.signal;
        }
        const result = await review.execute({ action: 'check_and_render', path: file,
          pages: id === 'partial-page-retry' ? ['1', '99'] : ['1'],
        }, { ...context, ...(signal ? { signal } : {}) });
        assert.equal(checkReceipt(result, before).valid, true);
        if (id === 'combined-review') {
          assert(!result.isError, result.content);
          assert.equal(result.images.length, 1);
          checkImage(result.images[0]);
        } else {
          assert.equal(result.isError, true);
          assert.match(result.content, /E_OFFICE_RENDER_FAILED/);
          assert.equal(result.images?.length || 0, id === 'partial-page-retry' ? 1 : 0);
          if (result.images?.length) checkImage(result.images[0]);
          if (signal) assert.equal(signal.aborted, true, 'cancellation must occur after the real issue scan');
          preserved(file, before, mtime);
          await noResident(file);
          delete row.cancel;
          const retry = await review.execute({ action: 'render', path: file, pages: ['1'] }, context);
          assert(!retry.isError, retry.content);
          assert.equal(retry.images.length, 1);
          checkImage(retry.images[0]);
        }
      }
      preserved(file, before, mtime);
      if (id !== 'edit-then-review') assert.equal(written.length, writtenBefore, 'review must not register a write');
      await noResident(file);
      assert.equal(BrowserWindow.getAllWindows().length, 0, 'review must release its preview windows');
    } catch (error) {
      row.error = String(error.stack || error).replaceAll(root, '<fixture>');
    } finally {
      delete row.cancel;
      await engine.closeOfficeFile(file, root);
      for (const win of BrowserWindow.getAllWindows()) win.destroy();
    }
    rows.push(row);
  }
  fs.writeFileSync(output, JSON.stringify(rows));
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
