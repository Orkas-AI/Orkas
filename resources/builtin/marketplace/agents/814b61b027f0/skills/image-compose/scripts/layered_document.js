'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { projectPath, parseArgs, sharpFactory } = require('./image_asset');
const MAX_PIXELS = 4_194_304;
const MAX_LAYER_PIXELS = 16_777_216;
const MAX_LAYERS = 64;
const MAX_JSON_BYTES = 1_048_576;
function fail(code, message) { throw Object.assign(new Error(`${code}: ${message}`), { code }); }
function check(ok, message) { if (!ok) fail('E_LAYERED_ARGUMENT', message); }
function object(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function keys(value, allowed) {
  check(object(value) && Object.keys(value).every(key => allowed.includes(key)), 'unsupported document or layer field');
}
function integer(value, min, max) { check(Number.isInteger(value) && value >= min && value <= max, 'invalid integer or dimension'); return value; }
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function readJson(file) {
  check(fs.statSync(file).isFile() && fs.statSync(file).size <= MAX_JSON_BYTES, 'JSON must be a file of at most 1 MiB');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function xml(value) { return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]); }
async function fileHash(file) {
  const digest = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
function psdLibrary() {
  let library;
  try { library = require('ag-psd'); }
  catch (error) { if (error.code === 'MODULE_NOT_FOUND') fail('E_LAYERED_PSD_UNAVAILABLE', 'PSD export is unavailable in this app; retain the source and preview'); throw error; }
  library.initializeCanvas(() => { fail('E_LAYERED_CANVAS', 'unsupported canvas operation'); },
    (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }));
  return library;
}

async function prepare(root, documentPath) {
  const sharp = await sharpFactory();
  const stat = fs.statSync(documentPath);
  check(stat.isFile() && stat.size <= MAX_JSON_BYTES, 'document must be a file of at most 1 MiB');
  const bytes = fs.readFileSync(documentPath);
  check(bytes.length <= MAX_JSON_BYTES, 'document exceeds 1 MiB');
  const source = JSON.parse(bytes);
  keys(source, ['schema_version', 'canvas', 'layers']);
  check(source.schema_version === 1, 'unsupported schema_version');
  keys(source.canvas, ['width', 'height']);
  const width = integer(source.canvas.width, 1, 8192), height = integer(source.canvas.height, 1, 8192);
  check(width * height <= MAX_PIXELS, 'canvas exceeds 4194304 pixels');
  check(Array.isArray(source.layers) && source.layers.length > 0, 'layers must be a non-empty array in bottom-to-top order');
  const ids = new Set(), inputs = new Map(), nodes = [], visible = [];
  let count = 0, area = 0, fileBytes = 0, textCount = 0, imageCount = 0;
  async function decode(relative, mask = false) {
    const file = projectPath(root, relative, 'layer input');
    const stat = fs.statSync(file);
    check(stat.isFile() && stat.size <= 16_777_216, 'layer input exceeds 16 MiB');
    if (!inputs.has(file)) { fileBytes += stat.size; check(fileBytes <= 67_108_864, 'inputs exceed 64 MiB'); inputs.set(file, await fileHash(file)); }
    const pipeline = sharp(file, { failOn: 'error', limitInputPixels: MAX_PIXELS });
    const metadata = await pipeline.metadata();
    check(['png', 'jpeg', 'webp', 'avif', 'tiff'].includes(metadata.format) && (metadata.pages || 1) === 1, 'only single-frame raster inputs are supported');
    check(metadata.depth === 'uchar' && (metadata.space === 'srgb' || (mask && metadata.space === 'b-w')), 'inputs must be 8-bit sRGB; masks may be grayscale');
    return pipeline.toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  }
  async function visit(layer, depth, parentVisible) {
    check(depth <= 8 && ++count <= MAX_LAYERS, 'at most 64 nodes and 8 group levels are supported');
    check(object(layer), 'layer must be an object');
    keys(layer, ['id', 'type', 'name', 'visible', ...(layer.type === 'group' ? ['children'] :
      ['left', 'top', 'opacity', 'mask_path', ...(layer.type === 'image' ? ['path'] : ['text', 'width', 'height', 'font_family', 'font_postscript_name', 'font_size', 'line_height', 'color'])])]);
    check(typeof layer.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(layer.id) && !ids.has(layer.id), 'layer ids must be unique');
    ids.add(layer.id);
    check(typeof layer.name === 'string' && layer.name.trim().length > 0 && layer.name.length <= 128, 'layer name is required (at most 128 characters)');
    check(layer.visible === undefined || typeof layer.visible === 'boolean', 'visible must be boolean');
    const node = { name: layer.name, hidden: layer.visible === false };
    if (layer.type === 'group') {
      check(Array.isArray(layer.children) && layer.children.length > 0, 'group children must not be empty');
      node.opened = true; node.blendMode = 'pass through'; node.children = [];
      for (const child of layer.children) node.children.push(await visit(child, depth + 1, parentVisible && !node.hidden));
      return node;
    }
    check(layer.type === 'image' || layer.type === 'text', 'only image, text and group layers are supported');
    node.left = integer(layer.left === undefined ? 0 : layer.left, 0, width - 1);
    node.top = integer(layer.top === undefined ? 0 : layer.top, 0, height - 1);
    const opacity = layer.opacity === undefined ? 1 : layer.opacity;
    check(typeof opacity === 'number' && Number.isFinite(opacity) && opacity >= 0 && opacity <= 1, 'opacity must be from 0 to 1');
    // Quantize once to PSD's 8-bit opacity so its reopened appearance matches the preview.
    node.opacity = Math.round(opacity * 255) / 255;
    let decoded;
    if (layer.type === 'image') { decoded = await decode(layer.path); imageCount++; }
    else {
      textCount++;
      const tw = integer(layer.width, 1, width - node.left), th = integer(layer.height, 1, height - node.top);
      check(typeof layer.text === 'string' && layer.text.length > 0 && layer.text.length <= 1024 && !/[\r\t\0]/.test(layer.text), 'text must be plain horizontal text with optional LF line breaks (at most 1024 characters)');
      for (const font of [layer.font_family, layer.font_postscript_name]) check(typeof font === 'string' && font.trim().length > 0 && /^[A-Za-z0-9 _.,\-\u0080-\uffff]{1,128}$/.test(font), 'font family and PostScript name are required');
      const size = layer.font_size, leading = layer.line_height === undefined ? size * 1.2 : layer.line_height;
      check(typeof size === 'number' && Number.isFinite(size) && size >= 1 && size <= 512, 'font_size must be from 1 to 512 pixels');
      check(typeof leading === 'number' && Number.isFinite(leading) && leading >= size && leading <= 1024, 'line_height must be at least font_size and at most 1024');
      check(typeof layer.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(layer.color), 'text color must be #RRGGBB');
      const lines = layer.text.split('\n');
      check(lines.length <= 16 && size + (lines.length - 1) * leading <= th, 'text lines exceed their declared box');
      for (const line of lines) {
        if (!line.trim()) continue;
        const measured = await sharp({ text: { text: xml(line), font: `${layer.font_family} ${size}`, dpi: 72, rgba: true }, limitInputPixels: MAX_PIXELS }).metadata();
        check(measured.width <= tw && measured.height <= th, 'text exceeds its declared box; enlarge the box or shorten the text');
      }
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${tw}" height="${th}"><text font-family="${xml(layer.font_family)}" font-size="${size}" fill="${layer.color}" xml:space="preserve">${lines.map((line, i) => `<tspan x="0" y="${size + i * leading}">${xml(line)}</tspan>`).join('')}</text></svg>`;
      decoded = await sharp(Buffer.from(svg), { limitInputPixels: MAX_PIXELS }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      node.text = { text: layer.text, transform: [1, 0, 0, 1, node.left, node.top + size],
        style: { font: { name: layer.font_postscript_name }, fontSize: size, leading, autoLeading: false,
          fillColor: { r: parseInt(layer.color.slice(1, 3), 16), g: parseInt(layer.color.slice(3, 5), 16), b: parseInt(layer.color.slice(5, 7), 16) } } };
    }
    const { width: lw, height: lh } = decoded.info;
    check(node.left + lw <= width && node.top + lh <= height, 'layer must fit inside the canvas');
    area += lw * lh; check(area <= MAX_LAYER_PIXELS, 'total layer pixels exceed 16777216');
    node.imageData = { width: lw, height: lh, data: new Uint8ClampedArray(decoded.data) };
    const painted = Buffer.from(decoded.data);
    let maskData;
    if (layer.mask_path !== undefined) {
      const mask = await decode(layer.mask_path, true);
      check(mask.info.width === lw && mask.info.height === lh, 'mask dimensions must match the layer');
      for (let i = 0; i < mask.data.length; i += 4) check(mask.data[i] === mask.data[i + 1] && mask.data[i] === mask.data[i + 2] && mask.data[i + 3] === 255, 'mask must be opaque grayscale (white reveals, black hides)');
      maskData = mask.data;
      node.mask = { top: node.top, left: node.left, bottom: node.top + lh, right: node.left + lw, defaultColor: 0,
        imageData: { width: lw, height: lh, data: new Uint8ClampedArray(mask.data) } };
    }
    for (let i = 3; i < painted.length; i += 4) painted[i] = Math.round(painted[i] * node.opacity * (maskData ? maskData[i - 3] / 255 : 1));
    if (parentVisible && !node.hidden) visible.push({ input: painted, raw: { width: lw, height: lh, channels: 4 }, left: node.left, top: node.top });
    nodes.push(node);
    return node;
  }
  const children = [];
  for (const layer of source.layers) children.push(await visit(layer, 0, true));
  check(nodes.length > 0, 'document must contain an image or text layer');
  const composite = await sharp({ create: { width, height, channels: 4, background: '#00000000' } }).composite(visible).raw().toBuffer();
  const fingerprint = hash(Buffer.from(JSON.stringify({ source: hash(bytes), inputs: [...inputs].sort(), sharp: sharp.versions.sharp, vips: sharp.versions.vips })));
  return { sharp, width, height, children, nodes, composite, fingerprint, documentHash: hash(bytes), inputs, imageCount, textCount };
}

function verifyPsd(result, prepared) {
  const actual = result.imageData.data;
  // PSD's 8-bit merged preview stores a white matte. Removing it loses up to
  // one display level at partial alpha; layer channels remain byte-exact.
  check(result.width === prepared.width && result.height === prepared.height && actual.length === prepared.composite.length
    && prepared.composite.every((value, index) => index % 4 === 3 ? value === actual[index]
      : Math.abs(value - actual[index]) * prepared.composite[index - index % 4 + 3] / 255 <= 1.01), 'PSD composite verification failed');
  function visit(actual, expected) {
    check(actual.length === expected.length, 'PSD layer count verification failed');
    actual.forEach((node, i) => {
      const wanted = expected[i];
      check(node.name === wanted.name && !!node.hidden === !!wanted.hidden, 'PSD name or visibility verification failed');
      if (wanted.children) { check(Array.isArray(node.children), 'PSD group verification failed'); visit(node.children, wanted.children); return; }
      check(node.left === wanted.left && node.top === wanted.top && Math.abs(node.opacity - wanted.opacity) < 1 / 255, 'PSD position or opacity verification failed');
      check(Buffer.from(node.imageData.data).equals(Buffer.from(wanted.imageData.data)), 'PSD image pixels verification failed');
      if (wanted.text) check(node.text?.text === wanted.text.text && node.text.style.font.name === wanted.text.style.font.name && node.text.style.fontSize === wanted.text.style.fontSize
        && Math.abs(node.text.style.leading - wanted.text.style.leading) < 0.000001 && JSON.stringify(node.text.transform) === JSON.stringify(wanted.text.transform)
        && ['r', 'g', 'b'].every(channel => Math.abs(node.text.style.fillColor[channel] - wanted.text.style.fillColor[channel]) < 0.001), 'PSD native text verification failed');
      else check(!node.text, 'unexpected PSD native text');
      if (wanted.mask) check(node.mask && ['left', 'top', 'right', 'bottom'].every(key => node.mask[key] === wanted.mask[key]) && Buffer.from(node.mask.imageData.data).equals(Buffer.from(wanted.mask.imageData.data)), 'PSD mask verification failed');
    });
  }
  visit(result.children, prepared.children);
}
async function publish(file, bytes) {
  if (fs.existsSync(file) || fs.lstatSync(path.dirname(file), { throwIfNoEntry: false })?.isSymbolicLink()) fail('E_LAYERED_EXISTS', 'choose a new output path');
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try { await fs.promises.writeFile(temporary, bytes, { flag: 'wx' }); await fs.promises.link(temporary, file); return await fs.promises.stat(file); }
  finally { await fs.promises.rm(temporary, { force: true }); }
}

module.exports = async function layeredDocument({ args }) {
  const options = parseArgs(args || []);
  const root = fs.realpathSync(path.resolve(options.project));
  const requestPath = projectPath(root, options.request, 'request');
  const request = readJson(requestPath);
  if (request.op === 'capabilities') {
    let available = false;
    try { require.resolve('ag-psd'); available = true; } catch { /* Older apps retain rendering without PSD export. */ }
    return { ok: true, schema_version: 1, operations: available ? ['render', 'export_psd'] : ['render'], psd_available: available, layer_types: ['image', 'text', 'group'], native_text: 'horizontal_plain_single_style', masks: 'opaque_grayscale', max_canvas_pixels: MAX_PIXELS, max_layer_pixels: MAX_LAYER_PIXELS, max_nodes: MAX_LAYERS, model_calls: 0 };
  }
  keys(request, ['op', 'document_path', 'output_path', 'preview_path']);
  check(['render', 'export_psd'].includes(request.op), 'op must be capabilities, render or export_psd');
  const documentPath = projectPath(root, request.document_path, 'document_path');
  check(fs.statSync(documentPath).size <= MAX_JSON_BYTES, 'document exceeds 1 MiB');
  const prepared = await prepare(root, documentPath);
  const output = projectPath(root, request.output_path, 'output_path');
  const receiptPath = projectPath(root, `${output}.layered-source.json`, 'preview receipt');
  check(![requestPath, documentPath, ...prepared.inputs.keys()].includes(output) && !prepared.inputs.has(receiptPath), 'output must not replace any source or request');
  if (fs.existsSync(output)) fail('E_LAYERED_EXISTS', 'choose a new output path');
  let bytes;
  if (request.op === 'render') {
    check(path.extname(output).toLowerCase() === '.png', 'preview output must be PNG');
    if (fs.existsSync(receiptPath)) fail('E_LAYERED_EXISTS', 'preview receipt already exists; choose a new path');
    bytes = await prepared.sharp(prepared.composite, { raw: { width: prepared.width, height: prepared.height, channels: 4 } }).png().toBuffer();
  } else {
    check(path.extname(output).toLowerCase() === '.psd', 'PSD output must end in .psd');
    const preview = projectPath(root, request.preview_path, 'preview_path');
    const receipt = readJson(projectPath(root, `${preview}.layered-source.json`, 'preview receipt'));
    if (receipt.fingerprint !== prepared.fingerprint || receipt.preview_sha256 !== await fileHash(preview)) fail('E_LAYERED_STALE', 'design or preview changed; render a new preview first');
    const decoded = await prepared.sharp(preview, { limitInputPixels: MAX_PIXELS }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (decoded.info.width !== prepared.width || decoded.info.height !== prepared.height || !decoded.data.equals(prepared.composite)) fail('E_LAYERED_STALE', 'preview differs from the current design');
    const library = psdLibrary();
    // The writer's legacy 8-bit path truncates white-matte floats (255 can
    // become 254). Exact 16-bit equivalents select its rounded conversion;
    // the PSD and editable layer channels remain 8-bit. This adds at most 16 MiB.
    const mergedPreview = new Uint16Array(prepared.composite.length);
    for (let index = 0; index < prepared.composite.length; index++) mergedPreview[index] = prepared.composite[index] * 257;
    bytes = library.writePsdBuffer({ width: prepared.width, height: prepared.height, bitsPerChannel: 8,
      imageData: { width: prepared.width, height: prepared.height, data: mergedPreview }, children: prepared.children }, { generateThumbnail: false, trimImageData: false, noBackground: true });
    check(bytes.length <= 134_217_728, 'PSD output exceeds 128 MiB');
    verifyPsd(library.readPsd(bytes, { useImageData: true }), prepared);
  }
  // Detect source mutation during rendering before making a delivery visible.
  for (const [file, expected] of prepared.inputs) check(await fileHash(file) === expected, 'input changed during processing');
  check(await fileHash(documentPath) === prepared.documentHash, 'document changed during processing');
  if (request.op === 'render') {
    const receiptStat = await publish(receiptPath, Buffer.from(JSON.stringify({ schema_version: 1, fingerprint: prepared.fingerprint, preview_sha256: hash(bytes) })));
    try { await publish(output, bytes); }
    catch (error) {
      const current = await fs.promises.lstat(receiptPath).catch(() => null);
      if (current?.ino === receiptStat.ino && current?.dev === receiptStat.dev) await fs.promises.unlink(receiptPath);
      throw error;
    }
  } else await publish(output, bytes);
  return { ok: true, op: request.op, output_path: output, width: prepared.width, height: prepared.height,
    layer_count: prepared.nodes.length, image_layer_count: prepared.imageCount, text_layer_count: prepared.textCount,
    structure_verified: request.op === 'export_psd', verification: request.op === 'export_psd' ? 'local_psd_readback' : 'local_render',
    ...(request.op === 'export_psd' ? { delivery_state: 'candidate', final_export: { tool: 'image_studio', op: 'project.export', format: 'psd', input_path: output } } : {}),
    external_editor_verified: false, preview_verified: true, model_calls: 0 };
};
