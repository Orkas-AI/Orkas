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
const { profileSyncCosts } = require('../../helpers/sync-cost.cjs');
const { foreignDocxBytes, annotatedDocxBytes } = require('./foreign-docx.cjs');
const AdmZip = require('adm-zip');
const { XMLParser } = require('fast-xml-parser');
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
  if (owner?.id === 'xlsx-render') {
    owner.captures ||= [];
    const capture = win.webContents.capturePage.bind(win.webContents);
    win.webContents.capturePage = async rect => {
      owner.captures.push(await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.sheet-content'))
        .filter(el => el.offsetParent !== null).map(el => ({ index: el.dataset.sheet, text: el.textContent }))`));
      return capture(rect);
    };
  }
});
const enginePath = path.join(pc, 'src/main/features/office/office_engine.ts');
const engine = require(enginePath);
require.cache[enginePath].exports = {
  ...engine,
  runOfficeCli: async (args, opts) => {
    const started = performance.now();
    const result = await engine.runOfficeCli(args, opts);
    active?.commands.push({ verb: args[0], ...(args[0] === 'get' ? { target: args[2] } : {}), code: result.code, stderr: result.stderr, stdoutChars: result.stdout.length, elapsedMs: performance.now() - started });
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
function fourSheetWorkbook() {
  // Author independent OOXML inputs rather than using the production builder
  // to define the workbook that its own review must distinguish.
  const zip = new AdmZip(makeNamespacedDirectXlsx());
  const names = ['North', 'East', 'South', 'West'];
  names.forEach((name, index) => {
    const sheet = new AdmZip(makeNamespacedDirectXlsx({
      rows: Array.from({ length: 12 }, (_, i) => [`Review fixture ${name}`, String(i + 1), String((index + 1) * 101)]),
    }));
    zip.addFile(`xl/worksheets/sheet${index + 1}.xml`, sheet.readFile('xl/worksheets/sheet1.xml'));
  });
  zip.updateFile('xl/workbook.xml', Buffer.from(`<x:workbook xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><x:sheets>${names.map((name, index) => `<x:sheet name="${name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</x:sheets></x:workbook>`));
  zip.updateFile('xl/_rels/workbook.xml.rels', Buffer.from(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet${index + 1}.xml"/>`).join('')}</Relationships>`));
  zip.updateFile('[Content_Types].xml', Buffer.from(zip.readAsText('[Content_Types].xml').replace('</Types>',
    names.slice(1).map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 2}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>')));
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
  const scenarioIds = ['combined-review', 'partial-page-retry', 'cancel-after-check', 'invalid-document', 'edit-then-review', 'xlsx-render', 'pptx-render', 'edit-10-paragraphs', 'edit-1000-paragraphs', 'create-centered-footer', 'read-notes-foot', 'read-notes-end', 'read-notes-both', 'read-notes-none', 'read-notes-many', 'creation-recovery-pptx', 'ppt-crop-percentages', 'ppt-parameter-recovery', 'saved-before-record-docx', 'saved-before-record-xlsx', 'saved-before-record-pptx', 'ppt-native-production', 'ppt-native-recovery', 'ppt-unit-contract', 'ppt-native-append', 'create-docx-heading-outline'];
  const selectedCases = process.argv[4] === undefined ? scenarioIds : JSON.parse(process.argv[4]);
  assert(Array.isArray(selectedCases) && selectedCases.length > 0
    && new Set(selectedCases).size === selectedCases.length
    && selectedCases.every(id => scenarioIds.includes(id)), 'Select known Office review scenarios exactly once');
  for (const id of selectedCases) {
    const row = { id, logs: [], browserLogs: [], commands: [], renderErrors: [] };
    active = row;
    const format = id === 'xlsx-render' ? 'xlsx' : id === 'pptx-render' ? 'pptx' : 'docx';
    const file = path.join(root, `${id}.${format}`);
    // Use a populated worksheet: a single short cell has fewer painted dark
    // pixels than the document-oriented nonblank image oracle below.
    const original = id.startsWith('read-notes-') ? annotatedDocxBytes(
      id === 'read-notes-both' || id === 'read-notes-many' ? ['footnote', 'endnote']
        : id === 'read-notes-foot' ? ['footnote'] : id === 'read-notes-end' ? ['endnote'] : [], id === 'read-notes-many' ? 80 : 1,
    ) : format === 'xlsx' ? fourSheetWorkbook()
      : format === 'pptx' ? makeMinimalPptx({ slides: [['Review fixture content']], placed: true }) : foreignDocxBytes(true);
    if (id === 'invalid-document') {
      const zip = new AdmZip(original);
      zip.updateFile('word/document.xml', Buffer.from(zip.readAsText('word/document.xml').replace('<w:body>', '<w:body><w:invalidElement/>')));
      fs.writeFileSync(file, zip.toBuffer());
    } else fs.writeFileSync(file, original);
    const before = fs.readFileSync(file);
    const mtime = fs.statSync(file, { bigint: true }).mtimeNs;
    const writtenBefore = written.length;
    try {
      if (id === 'ppt-native-append') {
        const target = path.join(root, 'placeholder-source.pptx');
        const outputPath = path.join(root, 'placeholder-output.pptx');
        const create = tools.find(tool => tool.name === 'create_pptx');
        const titleStyle = { x: '0.8in', y: '0.5in', width: '11in', height: '0.6in', size: '28', color: '#FFFFFF' };
        const created = await create.execute({ path: target, preview: false, slides: [
          { title: 'Inherited title contrast', background: '#10243A' },
          { title: 'Styled native title', body: 'Supporting copy', background: '#10243A', titleStyle,
            bodyStyle: { x: '0.8in', y: '1.5in', width: '10in', height: '1in', size: '18', color: '#FFFFFF' } },
        ] }, context);
        assert(!created.isError, created.content);
        const sourceBytes = fs.readFileSync(target);
        const sourceZip = new AdmZip(sourceBytes);
        const styled = sourceZip.readAsText('ppt/slides/slide2.xml');
        assert.equal((styled.match(/<p:sp>/g) || []).length, 2, 'styles must not duplicate placeholders');
        assert.match(styled, /<p:ph type="title"/);
        assert.match(styled, /sz="2800"/);
        assert.match(styled, /cx="10058400" cy="548640"/);
        const sourceCheck = await review.execute({ action: 'check', path: target }, context);
        const receipt = JSON.parse(sourceCheck.content);
        assert.equal(receipt.valid, true);
        const issues = receipt.issues.data.issues;
        assert(issues.some(issue => issue.subtype === 'low_contrast' && issue.path.startsWith('/slide[1]/') && issue.severity === 'blocker'), 'native title must be audited');
        assert(!issues.some(issue => issue.subtype === 'low_contrast' && issue.path.startsWith('/slide[2]/')), 'styled placeholders must remain readable');
        const editCopy = createOfficeTools({ userId: 'readonly-fixture', extraRoots: [root],
          onFileWritten: file => written.push(file) }).find(tool => tool.name === 'edit_office');
        const rejected = await editCopy.execute({ path: target, output_path: outputPath, operations: [
          { action: 'remove', path: '/slide[1]' },
          { action: 'add', parent: '/', type: 'slide', props: { title: 'Atomic rejection', diagrams: [
            { mermaid: 'pie title Unsupported; "A": 1', x: '1in', y: '2in', width: '8in', height: '3in' },
          ] } },
        ] }, context);
        assert(rejected.isError, 'unsupported rich content must roll back the whole working copy');
        assert.equal(fs.existsSync(outputPath), false);
        assert.deepEqual(fs.readFileSync(target), sourceBytes);
        assert.deepEqual(written.slice(writtenBefore), [target]);
        const picture = path.join(root, 'append-picture.png');
        fs.writeFileSync(picture, nativeImage.createFromBitmap(Buffer.alloc(20 * 20 * 4, 100), { width: 20, height: 20 }).toPNG());
        const result = await editCopy.execute({ path: target, output_path: outputPath, operations: [
          { action: 'remove', path: '/slide[1]' },
          { action: 'add', parent: '/', type: 'slide', props: { title: 'Added page', titleStyle,
            background: '#10243A',
            shapes: [{ text: 'Editable detail', x: '0.8in', y: '1.5in', width: '4in', height: '0.5in', size: '20', color: '#FFFFFF' }],
            tables: [{ rows: [['Status', 'Draft']], x: '0.8in', y: '2.3in', width: '4in' }],
            charts: [{ type: 'column', data: 'Count:2,4', categories: 'Before,After', x: '6in', y: '1.5in', width: '5in', height: '3in' }],
            images: [{ src: picture, x: '11.5in', y: '1.5in', width: '0.5in', height: '0.5in' }],
            diagrams: [{ mermaid: 'flowchart LR; A[Input] --> B[Result]', x: '1in', y: '4.5in', width: '8in', height: '2in' }],
          } },
          { action: 'add', parent: '/', type: 'slide', props: { body: 'A separate final page',
            bodyStyle: { x: '1in', y: '2in', size: '24', color: '#10243A' }, background: '#FFFFFF' } },
        ] }, context);
        assert(!result.isError, result.content);
        assert.deepEqual(fs.readFileSync(target), sourceBytes, 'successful copy edit must preserve the source');
        const outputBytes = fs.readFileSync(outputPath);
        const zip = new AdmZip(outputBytes);
        assert.equal(zip.getEntries().filter(entry => /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName)).length, 3);
        // Part filenames are not page order: removing a page may leave holes
        // which later additions reuse. Follow the OOXML relationship list.
        const xml = new XMLParser({ ignoreAttributes: false });
        const slideIds = xml.parse(zip.readAsText('ppt/presentation.xml'))['p:presentation']['p:sldIdLst']['p:sldId'];
        const rels = xml.parse(zip.readAsText('ppt/_rels/presentation.xml.rels')).Relationships.Relationship;
        const targets = new Map([rels].flat().map(rel => [rel['@_Id'], path.posix.resolve('/ppt', rel['@_Target']).slice(1)]));
        const slideXml = [slideIds].flat().map(slide => zip.readAsText(targets.get(slide['@_r:id'])));
        assert(slideXml[0].includes('Styled native title'));
        for (const text of ['Added page', 'Editable detail', 'Status', 'Draft', 'Input', 'Result']) assert(slideXml[1].includes(text), text);
        assert(slideXml[1].includes('<p:pic>') && slideXml[1].includes('<c:chart'));
        assert(slideXml[2].includes('A separate final page') && !slideXml[1].includes('A separate final page'));
        const checked = await review.execute({ action: 'check_and_render', path: outputPath,
          pages: ['1', '2', '3'], analysis_mode: 'quality_review' }, context);
        assert(!checked.isError, checked.content);
        assert.equal(checkReceipt(checked, outputBytes).valid, true);
        assert.equal(checked.images.length, 3);
        checked.images.forEach(checkImage);
        assert.deepEqual(written.slice(writtenBefore), [target, outputPath]);
        row.measurement = { styledNativePlaceholders: 2, detectedInheritedTitle: true, appendedPages: 2,
          finalSlides: 3, sourcePreserved: true, atomicRollback: true, renderedPages: 3 };
        await noResident(target);
        await noResident(outputPath);
      } else if (id === 'ppt-unit-contract') {
        const target = path.join(root, 'unit-contract.pptx');
        const create = tools.find(tool => tool.name === 'create_pptx');
        const input = { path: target, preview: false, slides: [{ shapes: [
          { text: 'Explicit native units', x: '0.8', y: '1in', width: '8in', height: '1in', size: '24pt' },
          { text: 'Raw EMU', x: '914400', y: '3in', width: '4in', height: '1in', size: '24pt' },
          { x: '1e6', y: '5in', width: '1in', height: '1in', fill: '#12B8A6' },
        ] }] };
        const commands = row.commands.length;
        const invalid = await create.execute(input, context);
        assert.equal(invalid.isError, true);
        assert(invalid.content.includes('slides[0].shapes[0].x'));
        assert.equal(row.commands.length, commands, 'invalid syntax must not start the native engine');
        assert.equal(fs.existsSync(target), false);
        assert.equal(written.length, writtenBefore);
        input.slides[0].shapes[0].x = '0.8in';
        const result = await create.execute(input, context);
        assert(!result.isError, result.content);
        const bytes = fs.readFileSync(target);
        const xml = new AdmZip(bytes).readAsText('ppt/slides/slide1.xml');
        for (const x of ['731520', '914400', '1000000']) assert(xml.includes(`x="${x}"`), 'native coordinate meaning changed');
        assert.deepEqual(written.slice(writtenBefore), [target]);
        const checked = await review.execute({ path: target, action: 'check_and_render', pages: ['1'] }, context);
        assert(!checked.isError, checked.content);
        assert.equal(checkReceipt(checked, bytes).valid, true);
        checkImage(checked.images[0]);
        row.measurement = { inputOnlyRefusal: true, preservedRawEmu: true, renderedPages: 1 };
        await noResident(target);
      } else if (id === 'ppt-native-production' || id === 'ppt-native-recovery') {
        const recovery = id === 'ppt-native-recovery';
        const target = path.join(root, `${id}-created.pptx`);
        const create = tools.find(tool => tool.name === 'create_pptx');
        const rect = { x: '0.5in', y: '1in', width: '9in', height: '4in' };
        const input = { path: target, preview: false,
          canvas: recovery ? { width: '12in', height: '7in' } : { size: 'standard' },
          theme: { bodyFont: 'Arial', headingFont: 'Arial', accent1: '#7C3AED' },
          slides: [
            { diagrams: [{ ...rect, mermaid: recovery ? 'pie title Unsupported; "A": 1' : 'flowchart LR; A[Input] --> B[Action] --> C[Result]' }],
              shapes: [{ text: 'Custom annotation', x: '0.5in', y: '0.3in', width: '8in', height: '0.5in', size: '24pt', color: '#FF5500' }] },
            { diagrams: [{ ...rect, mermaid: 'sequenceDiagram\nAlice->>Bob: Request\nBob-->>Alice: Result' }] },
          ],
        };
        if (recovery) {
          const rejected = await create.execute(input, context);
          assert.equal(rejected.isError, true, rejected.content);
          const receipt = JSON.parse(rejected.content.match(/<office-creation>(.+)<\/office-creation>/)[1]);
          assert.equal(receipt.retry_available, true, rejected.content);
          assert.equal(fs.existsSync(target), false, 'an unsupported graph must not publish a partially built deck');
          assert.equal(written.length, writtenBefore);
          input.retry_of = receipt.operation_id;
          input.slides[0].diagrams[0].mermaid = 'flowchart LR; A[Input] --> B[Action] --> C[Result]';
        }
        const created = await create.execute(input, context);
        assert(!created.isError, created.content);
        const bytes = fs.readFileSync(target);
        const zip = new AdmZip(bytes);
        const presentation = zip.readAsText('ppt/presentation.xml');
        assert.match(presentation, recovery ? /cx="10972800" cy="6400800"/ : /cx="9144000" cy="6858000"/);
        const theme = zip.readAsText('ppt/theme/theme1.xml');
        assert.match(theme, /<a:accent1>\s*<a:srgbClr val="7C3AED"/);
        assert.match(theme, /typeface="Arial"/);
        const flow = zip.readAsText('ppt/slides/slide1.xml');
        const sequence = zip.readAsText('ppt/slides/slide2.xml');
        assert.equal((flow.match(/<p:cxnSp>/g) || []).length, 2);
        assert.equal((flow.match(/<p:sp>/g) || []).length, 4);
        for (const text of ['Input', 'Action', 'Result', 'Custom annotation']) assert(flow.includes(text));
        assert.match(flow, /val="FF5500"/, 'explicit annotation color must override shared theme styling');
        for (const text of ['Alice', 'Bob', 'Request', 'Result']) assert(sequence.includes(text));
        for (const xml of [flow, sequence]) {
          assert.match(xml, /<p:grpSp>/, 'a graph must remain a native editable group');
          assert(!xml.includes('<p:pic>'), 'no diagram may silently become a picture');
        }
        assert.deepEqual(written.slice(writtenBefore), [target]);
        const checked = await review.execute({ path: target, action: 'check_and_render', pages: ['1', '2'] }, context);
        assert(!checked.isError, checked.content);
        assert.equal(checkReceipt(checked, bytes).valid, true);
        assert.equal(checked.images.length, 2);
        checked.images.forEach(checkImage);
        assert.deepEqual(fs.readFileSync(target), bytes, 'review must preserve the created deck');
        row.measurement = { nativeGraphs: 2, editable: true, renderedPages: 2, recovery };
        await noResident(target);
      } else if (id === 'create-docx-heading-outline') {
        const target = path.join(root, 'handbook.docx');
        const create = tools.find(tool => tool.name === 'create_docx');
        const input = {
          path: target, title: 'Welcome handbook', locale: 'en-US', preview: false,
          paragraphs: [
            { text: 'Arrival', style: 'Heading2' },
            { text: 'Bring your badge.', style: 'Normal' },
            { text: 'Questions', style: 'Heading2' },
            { text: 'Contact details', style: 'Heading9' },
          ],
        };
        const created = await create.execute(input, context);
        assert(!created.isError, created.content);
        assert.deepEqual(written.slice(writtenBefore), [target]);
        const bytes = fs.readFileSync(target);
        const zip = new AdmZip(bytes);
        const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });
        const styleList = parser.parse(zip.readAsText('word/styles.xml')).styles.style;
        const styles = Array.isArray(styleList) ? styleList : [styleList];
        const headings = styles.filter(style => /^Heading[1-9]$/.test(style['@_styleId']));
        assert.deepEqual(headings.map(style => [
          style['@_styleId'], style['@_type'], style.pPr?.outlineLvl?.['@_val'],
        ]), [['Heading1', 'paragraph', '0'], ['Heading2', 'paragraph', '1'], ['Heading9', 'paragraph', '8']]);
        const body = parser.parse(zip.readAsText('word/document.xml')).document.body;
        assert.deepEqual(body.p.map(paragraph => [
          paragraph.pPr?.pStyle?.['@_val'], paragraph.r.t['#text'] ?? paragraph.r.t,
        ]), [
          ['Heading1', 'Welcome handbook'], ['Heading2', 'Arrival'], ['Normal', 'Bring your badge.'],
          ['Heading2', 'Questions'], ['Heading9', 'Contact details'],
        ]);
        const checked = await review.execute({ path: target, action: 'check' }, context);
        assert(!checked.isError, checked.content);
        assert.equal(checkReceipt(checked, bytes).valid, true);
        assert.deepEqual(fs.readFileSync(target), bytes, 'native review must preserve the generated bytes');
        await noResident(target);
      } else if (id.startsWith('saved-before-record-')) {
        const format = id.slice('saved-before-record-'.length);
        const target = path.join(root, `retained-native.${format}`);
        const { OfficeCreationJournal, OfficeCreationStateError } = require(path.join(pc, 'src/main/features/office/office_creation.ts'));
        const finish = OfficeCreationJournal.prototype.finish;
        const delivered = [];
        const create = () => createOfficeTools({ userId: 'readonly-fixture', extraRoots: [root],
          creationStateDir: path.join(root, `retained-history-${format}`),
          onFileWritten: file => { written.push(file); delivered.push(file); },
        }).find(tool => tool.name === `create_${format}`);
        const input = { path: target, preview: false,
          paragraphs: [{ text: 'Retained native document' }],
          sheets: Array.from({ length: 6 }, (_, index) => ({ name: `Sheet${index + 1}`,
            rows: [['Period', 'Revenue'], ['Before', 12 + index], ['After', 24 + index]],
            ...(index === 0 ? { charts: [{ type: 'column', dataRange: 'Sheet1!B1:B3', categories: 'Sheet1!A2:A3', anchor: 'D2:L18' }] } : {}),
          })),
          slides: [{ title: 'Retained native deck', charts: [{ type: 'column', data: 'Revenue:12,24', categories: 'Before,After' }] }],
        };
        let result;
        OfficeCreationJournal.prototype.finish = async function (operation, status) {
          if (status === 'published') throw new OfficeCreationStateError();
          return finish.call(this, operation, status);
        };
        try { result = await create().execute(input, context); }
        finally { OfficeCreationJournal.prototype.finish = finish; }
        assert.equal(result.isError, true, 'bookkeeping error must remain a failure');
        assert(result.content.includes('E_OFFICE_CREATION_STATE_UNAVAILABLE'), result.content);
        const receipt = JSON.parse(result.content.match(/<office-creation>(.+)<\/office-creation>/)[1]);
        assert.equal(receipt.publication, 'published');
        assert.equal(receipt.retry_available, false);
        assert.equal(receipt.artifact_path, target);
        assert.deepEqual(delivered, [target], 'the saved file must remain registered despite the later failure');
        const bytes = fs.readFileSync(target);
        const zip = new AdmZip(bytes);
        if (format === 'docx') assert(zip.readAsText('word/document.xml').includes('Retained native document'));
        if (format === 'xlsx') {
          const workbook = zip.readAsText('xl/workbook.xml');
          for (let n = 1; n <= 6; n++) assert(workbook.includes(`name="Sheet${n}"`), workbook);
          assert.equal(zip.getEntries().filter(entry => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.entryName)).length, 6);
          const sheet = zip.readAsText('xl/worksheets/sheet6.xml');
          assert.match(sheet, /<[^>]*v>29<\//);
        }
        if (format !== 'docx') {
          const charts = zip.getEntries().filter(entry => /^(?:xl\/(?:drawings\/)?|ppt\/(?:slides\/)?)charts\/chart\d+\.xml$/.test(entry.entryName));
          assert.equal(charts.length, 1, `retain the native editable chart: ${zip.getEntries().filter(entry => /chart/i.test(entry.entryName)).map(entry => entry.entryName).join(',')}`);
          const chart = zip.readAsText(charts[0]);
          for (const value of ['12', '24']) assert(chart.includes(`>${value}<`), chart);
        }
        const checked = await review.execute({ action: 'check', path: target }, context);
        assert(!checked.isError, checked.content);
        assert.equal(checkReceipt(checked, fs.readFileSync(target)).valid, true);
        const { onTurnFinished } = require(path.join(pc, 'src/main/features/group_chat/plan_executor.ts'));
        const { selectVisibleProducedFiles } = require(path.join(pc, 'src/main/features/produced_files.ts'));
        const outcome = await onTurnFinished('readonly-fixture', 'delivery', {
          actor: { id: 'office-worker', kind: 'agent' }, finalText: '', errText: 'Post-save operation failed',
          failureKind: 'runtime', failureCode: 'post_save_failed', aborted: false,
          activityEvents: 1, produced: selectVisibleProducedFiles(delivered),
        });
        assert.equal(outcome.kind, 'persist');
        assert.equal(outcome.failureCode, 'post_save_failed');
        assert.deepEqual(outcome.produced, [target]);
        assert(outcome.text.includes('color:var(--danger)'), 'keep the failure visible instead of claiming completion');
        assert.deepEqual(fs.readFileSync(target), bytes, 'delivery must not rewrite the saved content');
        await noResident(target);
        const commands = row.commands.length;
        fs.unlinkSync(target);
        assert.equal((await create().execute(input, context)).isError, true);
        assert.equal(row.commands.length, commands, 'deletion must not authorize recreation');
        assert.equal(fs.existsSync(target), false);
        row.measurement = { format, nativeValidated: true, registeredFiles: delivered.length, retainedFailure: outcome.failureCode };
      } else if (id === 'ppt-crop-percentages' || id === 'ppt-parameter-recovery') {
        const png = path.join(root, `${id}.png`);
        fs.writeFileSync(png, nativeImage.createFromBitmap(Buffer.alloc(32 * 32 * 4, 255), { width: 32, height: 32 }).toPNG());
        const target = path.join(root, `${id}-created.pptx`);
        const tool = createOfficeTools({ userId: 'readonly-fixture', extraRoots: [root],
          creationStateDir: path.join(root, 'creation-history'), onFileWritten: file => written.push(file),
        }).find(tool => tool.name === 'create_pptx');
        const picture = { src: png, x: '1in', y: '1in', width: '2in', height: '2in' };
        const cropRect = (zip, slide) => zip.readAsText(`ppt/slides/slide${slide}.xml`).match(/<a:srcRect\b[^>]*>/)?.[0] || '';
        if (id === 'ppt-crop-percentages') {
          const inputs = [{ crop: '10' }, { crop: '5,10' }, { crop: '10,5,10,5' },
            { cropLeft: 0 }, { cropLeft: 0.5 }, { cropLeft: 1 }, { cropLeft: 10 }];
          const result = await tool.execute({ path: target, preview: false,
            slides: inputs.map(properties => ({ images: [{ ...picture, ...properties }] })),
          }, context);
          assert(!result.isError, result.content);
          const zip = new AdmZip(fs.readFileSync(target));
          for (const [index, edges] of [[1, [10000, 10000, 10000, 10000]],
            [2, [10000, 5000, 10000, 5000]], [3, [10000, 5000, 10000, 5000]]]) {
            for (const [edge, value] of ['l', 't', 'r', 'b'].map((edge, i) => [edge, edges[i]])) {
              assert(cropRect(zip, index).includes(`${edge}="${value}"`), `slide ${index}: wrong ${edge} crop`);
            }
          }
          // The declared unit is percent: 0.5% = 500 OpenXML units, never 50%.
          for (const [slide, expected] of [[4, 0], [5, 500], [6, 1000], [7, 10000]]) {
            const left = Number(cropRect(zip, slide).match(/\bl="(\d+)"/)?.[1] || 0);
            assert.equal(left, expected, `slide ${slide}: percentage crop changed by the native fraction syntax`);
          }
          assert.deepEqual(written.slice(writtenBefore), [target]);
        } else {
          const receipt = result => JSON.parse(result.content.match(/<office-creation>(.+)<\/office-creation>/)[1]);
          const input = { path: target, preview: false, slides: [{
            images: [{ ...picture, crop: 'contain' }],
            charts: [{ type: 'column', data: 'Revenue:12,24', categories: 'Before,After', anchor: 'none' }],
          }] };
          const failed = await tool.execute(input, context);
          assert.equal(failed.isError, true);
          assert(failed.content.includes("Invalid 'crop' value 'contain'"), failed.content);
          assert.equal(receipt(failed).retry_available, true);
          assert.equal(fs.existsSync(target), false);
          assert.equal(written.length, writtenBefore);
          input.slides[0].images[0].crop = '10,5,10,5';
          input.slides[0].charts[0].anchor = '2cm,3cm,18cm,10cm';
          input.retry_of = receipt(failed).operation_id;
          const corrected = await tool.execute(input, context);
          assert(!corrected.isError, corrected.content);
          assert.equal(receipt(corrected).attempt, 2);
          const zip = new AdmZip(fs.readFileSync(target));
          const slide = zip.readAsText('ppt/slides/slide1.xml');
          assert.match(slide, /<c:chart\b/, 'the corrected deck must retain a native chart, not an image substitute');
          for (const geometry of ['x="720000"', 'y="1080000"', 'cx="6480000"', 'cy="3600000"']) assert(slide.includes(geometry), slide);
          const charts = zip.getEntries().filter(entry => /^ppt\/(?:slides\/)?charts\/chart\d+\.xml$/.test(entry.entryName));
          assert.equal(charts.length, 1);
          const chart = zip.readAsText(charts[0]);
          assert.match(chart, /<c:barChart\b/);
          for (const value of ['Revenue', 'Before', 'After', '12', '24']) assert(chart.includes(`<c:v>${value}</c:v>`), chart);
          assert.deepEqual(written.slice(writtenBefore), [target]);
        }
        await noResident(target);
      } else if (id === 'creation-recovery-pptx') {
        const tool = () => createOfficeTools({ userId: 'readonly-fixture', extraRoots: [root],
          creationStateDir: path.join(root, 'creation-history'), onFileWritten: file => written.push(file),
        }).find(tool => tool.name === 'create_pptx');
        const receipt = result => JSON.parse(result.content.match(/<office-creation>(.+)<\/office-creation>/)[1]);
        const target = path.join(root, 'corrected-native.pptx');
        const input = { path: target, preview: false, slides: [{ title: 'Recovery fixture',
          charts: [{ type: 'column', data: 'Revenue:12,24', categories: 'Before,After', gridlines: 'major' }],
        }] };
        const failed = await tool().execute(input, context);
        assert.equal(failed.isError, true);
        assert.equal(receipt(failed).retry_available, true);
        assert.equal(receipt(failed).publication, 'not_published');
        assert.equal(fs.existsSync(target), false);
        assert.equal(written.length, writtenBefore);
        input.slides[0].charts[0].gridlines = '888888';
        input.retry_of = receipt(failed).operation_id;
        const recovered = await tool().execute(input, context);
        assert(!recovered.isError, recovered.content);
        assert.equal(receipt(recovered).attempt, 2);
        const zip = new AdmZip(fs.readFileSync(target));
        const charts = zip.getEntries().filter(entry => /^ppt\/(?:slides\/)?charts\/chart\d+\.xml$/.test(entry.entryName));
        assert.equal(charts.length, 1, 'recovery must keep the requested native editable chart');
        assert.match(zip.readAsText(charts[0]), /<c:v>24<\/c:v>/);
        const gridlines = zip.readAsText(charts[0]).match(/<c:majorGridlines\b[^>]*>[\s\S]*?<\/c:majorGridlines>/)?.[0] || '';
        assert.match(gridlines, /<a:srgbClr\b[^>]*val="888888"/);
        const checked = await review.execute({ action: 'check', path: target }, context);
        assert(!checked.isError, checked.content);
        assert.equal(checkReceipt(checked, fs.readFileSync(target)).valid, true);
        await noResident(target);
        const commands = row.commands.length;
        fs.unlinkSync(target);
        delete input.retry_of;
        const deleted = await tool().execute(input, context);
        assert.equal(deleted.isError, true);
        assert.equal(receipt(deleted).publication, 'published');
        assert.equal(receipt(deleted).retry_available, false);
        assert.equal(fs.existsSync(target), false);
        assert.equal(row.commands.length, commands, 'deleted successful file must not dispatch another native create');
        assert.deepEqual(written.slice(writtenBefore), [target]);
      } else if (id.startsWith('read-notes-')) {
        const checked = await review.execute({ action: 'check', path: file }, context);
        assert(!checked.isError, checked.content);
        assert.equal(checkReceipt(checked, before).valid, true, 'authored OOXML fixture must validate');
        const bodyStart = performance.now();
        let bodyOnly;
        try { bodyOnly = await engine.runOfficeCli(['view', file, 'text'], { cwd: root }); }
        finally { await engine.closeOfficeFile(file, root); }
        const bodyOnlyMs = performance.now() - bodyStart;
        assert.equal(bodyOnly.code, 0);
        assert.equal(bodyOnly.stderr, '');
        const readStart = performance.now();
        const result = await tools.find(tool => tool.name === 'office_read').execute({ path: file }, context);
        const readMs = performance.now() - readStart;
        assert(!result.isError, result.content);
        const receipt = JSON.parse(result.content);
        assert.equal(receipt.status, 'complete');
        assert.equal(receipt.source_truncated, false);
        assert.deepEqual(receipt.unread_sections, []);
        assert.deepEqual(receipt.scope, ['/body', '/footnotes', '/endnotes']);
        assert.equal(receipt.other_regions, 'not_read');
        assert.equal(receipt.sections[0].content, bodyOnly.stdout);
        assert(receipt.sections[0].content.includes('Stable text 123'));
        for (const [index, present, text, nativeId, kind] of [
          [1, id === 'read-notes-foot' || id === 'read-notes-both' || id === 'read-notes-many', 'FOOTNOTE_RECEIPT_529', 7, 'footnote'],
          [2, id === 'read-notes-end' || id === 'read-notes-both' || id === 'read-notes-many', 'ENDNOTE_RECEIPT_731', 12, 'endnote'],
        ]) {
          const section = receipt.sections[index];
          assert.equal(section.target, `/${kind}s`);
          assert.equal(section.status, present ? 'complete' : 'absent');
          if (present) {
            const note = section.data.results[0].children.find(node => node.format.id === nativeId);
            assert(note, 'original note id must survive the default read');
            assert.equal(note.type, kind);
            assert(note.path.startsWith(`/${kind}s/${kind}[`));
            assert.equal(note.text, text);
          } else assert(!result.content.includes(text), 'absent notes must not acquire invented content');
        }
        if (id === 'read-notes-many') {
          const notes = receipt.sections[1].data.results[0].children.filter(node => node.format.id >= 7);
          assert.deepEqual(notes.map(node => node.format.id), Array.from({ length: 80 }, (_, index) => index + 7));
          assert.deepEqual(notes.map(node => node.text), ['FOOTNOTE_RECEIPT_529',
            ...Array.from({ length: 79 }, (_, index) => `FOOTNOTE_RECEIPT_${index + 8}`)]);
        }
        await noResident(file);
        row.measurement = { scope: 'native default DOCX read versus body-only command plus close control',
          bodyOnlyMs, readMs, resultChars: result.content.length,
          sourceBefore: hash(before), sourceAfter: hash(fs.readFileSync(file)),
          sections: receipt.sections.map(({ target, status }) => ({ target, status })),
          writtenFiles: written.length - writtenBefore,
        };
      } else if (id === 'create-centered-footer') {
        const source = new AdmZip(before);
        assert.equal(source.getEntries().some(entry => /word\/footer\d+\.xml/.test(entry.entryName)), false);
        const target = path.join(root, 'letterhead-with-footer.docx');
        const text = 'Example Consulting | 10 Test Street | example.invalid';
        const result = await edit.execute({ path: file, output_path: target, preview: false,
          operations: [{ action: 'add', parent: '/', type: 'footer', props: { text, align: 'center' } }],
        }, context);
        assert(!result.isError, result.content);
        assert.deepEqual(written.slice(writtenBefore), [target]);
        const zip = new AdmZip(fs.readFileSync(target));
        const parts = zip.getEntries().filter(entry => /^word\/footer\d+\.xml$/.test(entry.entryName));
        assert.equal(parts.length, 1, 'must create a true footer, not a body paragraph');
        const footer = zip.readAsText(parts[0]);
        assert(footer.includes(text));
        assert.match(footer, /<w:jc\b[^>]*w:val="center"/);
        const body = zip.readAsText('word/document.xml');
        assert(!body.includes(text), 'a body substitute is not the requested footer');
        assert(body.includes('Stable text 123') && body.includes('footerReference'));
        assert(zip.readAsText('word/_rels/document.xml.rels').includes('/footer'));
        const checked = await review.execute({ action: 'check', path: target }, context);
        assert(!checked.isError, checked.content);
        assert.equal(checkReceipt(checked, fs.readFileSync(target)).valid, true);
        await noResident(target);
      } else if (id.startsWith('edit-') && id.endsWith('-paragraphs')) {
        const count = Number(id.split('-')[1]);
        const expected = Array.from({ length: count }, (_, n) => `PF_${String(n).padStart(4, '0')}_end`);
        const target = path.join(root, `authored-${count}.docx`);
        let last = performance.now(), maxGapMs = 0;
        const timer = setInterval(() => { const now = performance.now(); maxGapMs = Math.max(maxGapMs, now - last); last = now; }, 2);
        const costs = process.env.ORKAS_PERFORMANCE_ATTRIBUTION === '1'
          ? profileSyncCosts(file => typeof file === 'string' && file.startsWith(root + path.sep)) : null;
        const rssBefore = process.memoryUsage().rss, start = performance.now();
        let result;
        try {
          result = await edit.execute({ path: file, output_path: target, preview: false,
            operations: expected.map(text => ({ action: 'add', parent: '/body', type: 'p', props: { text } })),
          }, context);
          await new Promise(resolve => setTimeout(resolve, 5));
        } finally { clearInterval(timer); costs?.stop(); }
        row.measurement = { operations: count, ...(costs ? { callerCosts: costs.report } : {}), elapsedMs: performance.now() - start, maxGapMs,
          inputBytes: before.length, outputBytes: fs.existsSync(target) ? fs.statSync(target).size : null,
          rssBefore, rssAfter: process.memoryUsage().rss, scope: 'real pinned engine, host edit/copy/validate/publish/cleanup; endpoints not peak RSS' };
        assert(!result.isError, result.content);
        assert.deepEqual(written.slice(writtenBefore), [target]);
        const xml = new AdmZip(fs.readFileSync(target)).readAsText('word/document.xml');
        assert.deepEqual(xml.match(/PF_\d{4}_end/g), expected, 'reopened OOXML must retain every ordered paragraph exactly once');
        await noResident(target);
      } else if (format !== 'docx') {
        const readback = await engine.runOfficeCli(['view', file, 'text'], { cwd: root });
        assert.equal(readback.code, 0);
        assert.equal(readback.stderr, '');
        assert(readback.stdout.includes('Review fixture'), 'native fixture must contain the intended text');
        const pages = format === 'xlsx' ? ['1', '3', '4'] : ['1'];
        const started = performance.now();
        const result = await review.execute({ action: 'render', path: file, pages }, context);
        assert(!result.isError, result.content);
        assert.equal(result.images.length, pages.length);
        result.images.forEach(checkImage);
        if (format === 'xlsx') {
          assert.deepEqual(row.captures.map(sheets => sheets.map(sheet => sheet.index)), [['0'], ['2'], ['3']]);
          for (const [index, name] of ['North', 'South', 'West'].entries()) {
            assert(row.captures[index][0].text.includes(`Review fixture ${name}`), 'visible cells must match the requested worksheet');
            assert(row.captures[index][0].text.includes(String([101, 303, 404][index])), 'visible values must match the source cells');
          }
          const imageHashes = result.images.map(image => hash(Buffer.from(image.data, 'base64')));
          assert.equal(new Set(imageHashes).size, 3, 'distinct source sheets must produce distinct images');
          row.measurement = { scope: 'native four-sheet workbook review', pages, imageHashes,
            elapsedMs: performance.now() - started, writtenFiles: written.length - writtenBefore,
            visibleSheets: row.captures };
        }
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
          const diagnostic = JSON.parse(result.content.match(/<office-render-error>(.*?)<\/office-render-error>/)[1]);
          assert.equal(diagnostic.page, id === 'partial-page-retry' ? '99' : '1');
          assert.equal(diagnostic.artifact_revision, hash(before).slice(7, 23));
          assert.equal(diagnostic.source_code, id === 'partial-page-retry'
            ? 'E_OFFICE_RENDER_PAGE_UNAVAILABLE' : 'E_OFFICE_ABORTED');
          assert(diagnostic.message.includes(diagnostic.source_code), 'retain the actual renderer error');
          assert.equal(diagnostic.exit_code, undefined, 'do not invent a process exit code');
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
      if (id !== 'edit-then-review' && id !== 'create-centered-footer' && id !== 'create-docx-heading-outline' && id !== 'creation-recovery-pptx'
        && !id.startsWith('ppt-native-') && id !== 'ppt-unit-contract' && id !== 'ppt-crop-percentages' && id !== 'ppt-parameter-recovery' && !id.startsWith('saved-before-record-') && !id.endsWith('-paragraphs')) assert.equal(written.length, writtenBefore, 'review must not register a write');
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
