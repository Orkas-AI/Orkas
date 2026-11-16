'use strict';

// VideoStudio-owned subset of ImageStudio's Sharp preparation mechanics.
// Keep the original, resolve real paths and publish a new file exclusively.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const MAX_DIMENSION = 16384;
const MAX_AREA = 100000000;
const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function shape(value, keys) {
  if (!record(value) || Object.keys(value).some(key => !keys.includes(key))) {
    fail('E_IMAGE_ASSET_ARGUMENT', 'Request contains unsupported fields or is not an object.');
  }
}
function integer(value, minimum = 0) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > MAX_DIMENSION) {
    fail('E_IMAGE_ASSET_ARGUMENT', 'Dimensions and offsets must be bounded integer pixels.');
  }
  return value;
}
function bounds(width, height) {
  integer(width, 1); integer(height, 1);
  if (width * height > MAX_AREA) fail('E_IMAGE_ASSET_LIMIT', 'Image exceeds the pixel limit.');
}
function realOrResolve(candidate) {
  try { return fs.realpathSync(candidate); } catch {
    const parent = path.dirname(candidate);
    return parent === candidate ? candidate : path.join(realOrResolve(parent), path.basename(candidate));
  }
}
function projectPath(root, raw, label) {
  if (typeof raw !== 'string' || !raw.trim()) fail('E_IMAGE_ASSET_PATH', `${label} is not a non-empty path.`);
  const resolved = realOrResolve(path.resolve(root, raw));
  const relative = path.relative(root, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail('E_IMAGE_ASSET_PATH', `${label} resolves outside the production directory.`);
  }
  return resolved;
}
function sharpFactory() {
  const sharp = require('sharp');
  // Release completed file handles on Windows, as in ImageStudio.
  if (process.platform === 'win32') sharp.cache({ files: 0 });
  return sharp;
}
async function inspect(sharp, input) {
  const metadata = await sharp(input, { failOn: 'error', limitInputPixels: MAX_AREA }).metadata();
  const rotated = metadata.orientation >= 5 && metadata.orientation <= 8;
  const width = rotated ? metadata.height : metadata.width;
  const height = rotated ? metadata.width : metadata.height;
  bounds(width, height);
  if ((metadata.pages || 1) > 1) fail('E_IMAGE_ASSET_ARGUMENT', 'Input contains multiple image pages.');
  return { width, height, encoded_width: metadata.width, encoded_height: metadata.height,
    orientation: metadata.orientation || 1, format: metadata.format,
    coordinate_space: 'oriented_original_pixels' };
}

function failure(error, stage) {
  if (error.code?.startsWith('E_IMAGE_ASSET_')) return { ok: false, errorCode: error.code, message: error.message };
  const missing = error.code === 'ENOENT';
  const denied = error.code === 'EACCES' || error.code === 'EPERM';
  const [kind, message] = {
    project: ['PROJECT', missing ? 'Production directory does not exist.' : error.code === 'ENOTDIR' ? 'Production path is not a directory.'
      : denied ? 'Production directory access was denied.' : 'Production directory could not be read.'],
    request: ['REQUEST', missing ? 'Request file does not exist.'
      : denied ? 'Request file access was denied.' : 'Request file could not be read.'],
    json: ['REQUEST', error instanceof SyntaxError ? 'Request file is not valid JSON.' : 'Request JSON could not be parsed.'],
    inline_json: ['REQUEST', error instanceof SyntaxError ? 'Request JSON is not valid JSON.' : 'Request JSON could not be parsed.'],
    input: ['INPUT', missing ? 'Input image does not exist.'
      : denied ? 'Input image access was denied.' : 'Input image could not be read.'],
    runtime: ['RUNTIME', 'Image processing runtime could not be loaded.'],
    decode: ['INPUT', 'Input image metadata could not be decoded.'],
    directory: ['OUTPUT', ['ENOTDIR', 'EEXIST'].includes(error.code) ? 'Output parent is not a directory.'
      : denied ? 'Output directory access was denied.' : 'Output directory could not be created.'],
    transform: ['PROCESS', denied ? 'Image transformation access was denied.' : 'Image transformation could not be completed.'],
    verify: ['OUTPUT', 'Prepared image metadata could not be decoded.'],
    publish: [error.code === 'EEXIST' ? 'EXISTS' : 'OUTPUT', error.code === 'EEXIST' ? 'Output file already exists.'
      : denied ? 'Output publication access was denied.' : 'Output image could not be published.'],
  }[stage] || ['PROCESS', 'Image preparation failed.'];
  // Report the known stage and structured cause, never raw paths or guessed repairs.
  return { ok: false, errorCode: `E_IMAGE_ASSET_${kind}`, message };
}

module.exports = async function imageAsset({ args }) {
  let temporary;
  let stage = 'arguments';
  try {
    if (args.length !== 4 || args[0] !== '--project'
      || !['--request', '--request-file', '--request-json'].includes(args[2]) || !args[1] || !args[3]) {
      fail('E_IMAGE_ASSET_ARGS', 'Usage: image_asset --project production (--request-file request.json | --request-json JSON). --request remains a file-only alias.');
    }
    stage = 'project';
    const root = fs.realpathSync(path.resolve(args[1]));
    if (!fs.statSync(root).isDirectory()) fail('E_IMAGE_ASSET_PROJECT', 'Production path is not a directory.');
    stage = 'request';
    const inline = args[2] === '--request-json';
    let bytes;
    if (inline) bytes = args[3];
    else {
      const requestFile = projectPath(root, args[3], args[2]);
      const requestStat = fs.statSync(requestFile);
      if (!requestStat.isFile()) fail('E_IMAGE_ASSET_REQUEST', 'Request path is not a file.');
      if (requestStat.size > 65536) fail('E_IMAGE_ASSET_LIMIT', 'Request JSON exceeds 64 KiB.');
      bytes = fs.readFileSync(requestFile, 'utf8');
    }
    if (Buffer.byteLength(bytes, 'utf8') > 65536) fail('E_IMAGE_ASSET_LIMIT', 'Request JSON exceeds 64 KiB.');
    stage = inline ? 'inline_json' : 'json';
    const request = JSON.parse(bytes);
    shape(request, ['op', 'input_path', 'output_path', 'source_size', 'crop', 'resize', 'padding']);
    if (!['inspect', 'process'].includes(request.op)) fail('E_IMAGE_ASSET_ARGUMENT', 'op must be inspect or process.');
    stage = 'input';
    const input = projectPath(root, request.input_path, 'input_path');
    if (!fs.statSync(input).isFile()) fail('E_IMAGE_ASSET_INPUT', 'Input image path is not a file.');
    stage = 'runtime';
    const sharp = sharpFactory();
    stage = 'decode';
    const original = await inspect(sharp, input);
    if (request.op === 'inspect') return { ok: true, op: 'inspect', ...original, model_calls: 0 };
    const output = projectPath(root, request.output_path, 'output_path');
    if (input === output) fail('E_IMAGE_ASSET_PATH', 'Input and output resolve to the same file.');
    if (fs.existsSync(output)) fail('E_IMAGE_ASSET_EXISTS', 'Output file already exists.');
    const extension = path.extname(output).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.webp'].includes(extension)) fail('E_IMAGE_ASSET_ARGUMENT', 'Output must be PNG, JPEG or WebP.');
    stage = 'transform';
    let { width, height } = original;
    let pipeline = sharp(input, { failOn: 'error', limitInputPixels: MAX_AREA }).autoOrient();
    if (request.crop !== undefined) {
      shape(request.source_size, ['width', 'height']);
      if (request.source_size.width !== width || request.source_size.height !== height) {
        fail('E_IMAGE_ASSET_COORDINATES', 'source_size must match inspect dimensions, not a compressed preview.');
      }
      shape(request.crop, ['left', 'top', 'width', 'height']);
      const crop = request.crop;
      integer(crop.left); integer(crop.top); bounds(crop.width, crop.height);
      if (crop.left + crop.width > width || crop.top + crop.height > height) {
        fail('E_IMAGE_ASSET_COORDINATES', 'Crop must fit the oriented original image.');
      }
      pipeline = pipeline.extract(crop);
      width = crop.width; height = crop.height;
    }
    if (request.resize !== undefined) {
      shape(request.resize, ['width', 'height', 'fit']);
      const resize = request.resize;
      if (resize.width === undefined && resize.height === undefined) fail('E_IMAGE_ASSET_ARGUMENT', 'Resize needs width or height.');
      if (resize.width !== undefined) integer(resize.width, 1);
      if (resize.height !== undefined) integer(resize.height, 1);
      const fit = resize.fit === undefined ? 'inside' : resize.fit;
      if (!['inside', 'contain', 'cover', 'fill'].includes(fit)) fail('E_IMAGE_ASSET_ARGUMENT', 'Unsupported resize fit.');
      let nextWidth = resize.width, nextHeight = resize.height;
      if (!nextWidth) nextWidth = Math.max(1, Math.round(width * nextHeight / height));
      else if (!nextHeight) nextHeight = Math.max(1, Math.round(height * nextWidth / width));
      else if (fit === 'inside') {
        const scale = Math.min(nextWidth / width, nextHeight / height);
        nextWidth = Math.max(1, Math.round(width * scale)); nextHeight = Math.max(1, Math.round(height * scale));
      }
      bounds(nextWidth, nextHeight);
      pipeline = pipeline.resize({ ...resize, fit, background: '#00000000' });
      width = nextWidth; height = nextHeight;
    }
    if (request.padding !== undefined) {
      shape(request.padding, ['left', 'right', 'top', 'bottom', 'background']);
      const padding = { top: 0, bottom: 0, left: 0, right: 0, background: '#00000000', ...request.padding };
      for (const edge of ['top', 'bottom', 'left', 'right']) integer(padding[edge]);
      bounds(width + padding.left + padding.right, height + padding.top + padding.bottom);
      pipeline = pipeline.extend(padding);
    }
    if (extension === '.png') pipeline = pipeline.png();
    else if (extension === '.webp') pipeline = pipeline.webp({ quality: 92 });
    else pipeline = pipeline.jpeg({ quality: 92 });
    stage = 'directory';
    fs.mkdirSync(path.dirname(output), { recursive: true });
    temporary = `${output}.${crypto.randomUUID()}.tmp`;
    stage = 'transform';
    await pipeline.toFile(temporary);
    stage = 'verify';
    const prepared = await inspect(sharp, temporary);
    // Same-directory exclusive publication keeps earlier deliveries intact.
    stage = 'publish';
    fs.linkSync(temporary, output);
    return { ok: true, op: 'process', output_path: output, ...prepared, model_calls: 0 };
  } catch (error) {
    return failure(error, stage);
  } finally {
    if (temporary) await fs.promises.rm(temporary, { force: true });
  }
};
