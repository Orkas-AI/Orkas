'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const MAX_AREA = 100_000_000;
const MAX_DIMENSION = 16_384;
const MAX_OPERATIONS = 16;
const MAX_LAYERS = 16;
const MAX_COMMAND_OUTPUT = 8192;
const OUTPUT_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif', '.tif', '.tiff']);

function fail(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  throw error;
}

function record(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseArgs(args) {
  const out = { project: '', request: '' };
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    const next = () => {
      if (index + 1 >= args.length) fail('E_IMAGE_ASSET_ARGS', `${current} requires a value`);
      index += 1;
      return args[index];
    };
    if (current === '--project' || current === '--project-dir') out.project = next();
    else if (current === '--request' || current === '-r') out.request = next();
    else fail('E_IMAGE_ASSET_ARGS', `unknown argument: ${current}`);
  }
  if (!out.project || !out.request) fail('E_IMAGE_ASSET_ARGS', '--project and --request are required');
  return out;
}

function realOrResolve(candidate) {
  try { return fs.realpathSync(candidate); }
  catch {
    let existing = path.resolve(candidate);
    const missing = [];
    while (existing !== path.dirname(existing)) {
      try { existing = fs.realpathSync(existing); break; }
      catch { missing.unshift(path.basename(existing)); existing = path.dirname(existing); }
    }
    return missing.length ? path.join(existing, ...missing) : existing;
  }
}

function inside(root, candidate) {
  const rel = path.relative(realOrResolve(root), realOrResolve(candidate));
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function projectPath(root, raw, label) {
  const value = String(raw || '').trim();
  if (!value) fail('E_IMAGE_ASSET_PATH', `${label} is required`);
  const candidate = realOrResolve(path.resolve(root, value));
  if (!inside(root, candidate)) fail('E_IMAGE_ASSET_PATH', `${label} must stay inside the project`);
  return candidate;
}

function integer(value, label, min = 0, max = MAX_DIMENSION) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < min || result > max) fail('E_IMAGE_ASSET_ARGUMENT', `${label} must be an integer from ${min} to ${max}`);
  return result;
}

function optionalInteger(value, label, min = 0, max = MAX_DIMENSION) {
  return value === undefined ? undefined : integer(value, label, min, max);
}

function safeCommand(raw, label, fallback = '') {
  const command = String(raw || fallback).trim();
  if (!command || /[\r\n\0]/.test(command)) fail('E_IMAGE_ASSET_CONFIG', `${label} is not configured safely`);
  return command;
}

async function sharpFactory() {
  try {
    const sharp = require('sharp');
    // libvips' file cache can keep completed inputs/outputs locked for the
    // lifetime of an Electron worker on Windows. Preserve memory/item caching,
    // but release filesystem handles as soon as each pipeline completes.
    if (process.platform === 'win32') sharp.cache({ files: 0 });
    return sharp;
  }
  catch (error) { fail('E_SHARP_UNAVAILABLE', `Sharp is unavailable: ${error.message}`); }
}

async function inspectImage(file) {
  const sharp = await sharpFactory();
  let metadata;
  try { metadata = await sharp(file, { failOn: 'error', limitInputPixels: MAX_AREA }).metadata(); }
  catch (error) { fail('E_IMAGE_ASSET_INVALID', `image is unreadable: ${error.message}`); }
  if (!metadata.format || !metadata.width || !metadata.height) fail('E_IMAGE_ASSET_INVALID', 'image has no dimensions');
  if (metadata.width > MAX_DIMENSION || metadata.height > MAX_DIMENSION || metadata.width * metadata.height > MAX_AREA) fail('E_IMAGE_ASSET_LIMIT', 'image exceeds the dimension limit');
  return { format: metadata.format, width: metadata.width, height: metadata.height, channels: metadata.channels || 0, bytes: fs.statSync(file).size };
}

function normalizeOperation(raw, index) {
  if (!record(raw)) fail('E_IMAGE_ASSET_ARGUMENT', `operations[${index}] must be an object`);
  const type = String(raw.type || '').trim();
  if (['auto_orient', 'flip', 'flop', 'grayscale'].includes(type)) return { type };
  if (type === 'resize') {
    const width = optionalInteger(raw.width, `operations[${index}].width`, 1);
    const height = optionalInteger(raw.height, `operations[${index}].height`, 1);
    if (!width && !height) fail('E_IMAGE_ASSET_ARGUMENT', `operations[${index}] resize requires width or height`);
    if (width && height && width * height > MAX_AREA) fail('E_IMAGE_ASSET_LIMIT', 'resize output exceeds the area limit');
    const fit = raw.fit === undefined ? undefined : String(raw.fit);
    if (fit && !['cover', 'contain', 'fill', 'inside', 'outside'].includes(fit)) fail('E_IMAGE_ASSET_ARGUMENT', `operations[${index}].fit is invalid`);
    const kernel = raw.kernel === undefined ? undefined : String(raw.kernel);
    if (kernel && !['nearest', 'cubic', 'mitchell', 'lanczos2', 'lanczos3'].includes(kernel)) fail('E_IMAGE_ASSET_ARGUMENT', `operations[${index}].kernel is invalid`);
    return { type, width, height, fit, kernel, position: raw.position === undefined ? undefined : String(raw.position), without_enlargement: raw.without_enlargement === true };
  }
  if (type === 'extract') return {
    type,
    left: integer(raw.left, `operations[${index}].left`),
    top: integer(raw.top, `operations[${index}].top`),
    width: integer(raw.width, `operations[${index}].width`, 1),
    height: integer(raw.height, `operations[${index}].height`, 1),
  };
  if (type === 'extend') return {
    type,
    top: optionalInteger(raw.top, `operations[${index}].top`) || 0,
    bottom: optionalInteger(raw.bottom, `operations[${index}].bottom`) || 0,
    left: optionalInteger(raw.left, `operations[${index}].left`) || 0,
    right: optionalInteger(raw.right, `operations[${index}].right`) || 0,
    background: String(raw.background || '#00000000'),
  };
  if (type === 'rotate') {
    const angle = Number(raw.angle);
    if (!Number.isFinite(angle) || Math.abs(angle) > 3600) fail('E_IMAGE_ASSET_ARGUMENT', `operations[${index}].angle is invalid`);
    return { type, angle, background: String(raw.background || '#00000000') };
  }
  if (type === 'blur' || type === 'sharpen') {
    const sigma = raw.sigma === undefined ? undefined : Number(raw.sigma);
    if (sigma !== undefined && (!Number.isFinite(sigma) || sigma < 0.3 || sigma > 1000)) fail('E_IMAGE_ASSET_ARGUMENT', `operations[${index}].sigma is invalid`);
    return { type, sigma };
  }
  if (type === 'flatten' || type === 'trim') return { type, background: String(raw.background || (type === 'flatten' ? '#ffffff' : '#00000000')) };
  fail('E_IMAGE_ASSET_ARGUMENT', `operations[${index}].type is unsupported`);
}

function applyOperation(pipeline, operation) {
  if (operation.type === 'auto_orient') return pipeline.autoOrient();
  if (operation.type === 'resize') return pipeline.resize({
    width: operation.width, height: operation.height, fit: operation.fit, position: operation.position,
    kernel: operation.kernel, withoutEnlargement: operation.without_enlargement,
  });
  if (operation.type === 'extract') return pipeline.extract(operation);
  if (operation.type === 'extend') return pipeline.extend(operation);
  if (operation.type === 'rotate') return pipeline.rotate(operation.angle, { background: operation.background });
  if (operation.type === 'flip') return pipeline.flip();
  if (operation.type === 'flop') return pipeline.flop();
  if (operation.type === 'grayscale') return pipeline.grayscale();
  if (operation.type === 'blur') return operation.sigma === undefined ? pipeline.blur() : pipeline.blur(operation.sigma);
  if (operation.type === 'sharpen') return operation.sigma === undefined ? pipeline.sharpen() : pipeline.sharpen({ sigma: operation.sigma });
  if (operation.type === 'flatten') return pipeline.flatten({ background: operation.background });
  return pipeline.trim({ background: operation.background });
}

async function formatPipeline(pipeline, extension, quality) {
  if (extension === '.png') return pipeline.png({ quality });
  if (extension === '.webp') return pipeline.webp({ quality });
  if (extension === '.avif') return pipeline.avif({ quality });
  if (extension === '.jpg' || extension === '.jpeg') return pipeline.jpeg({ quality });
  return pipeline.tiff({ quality });
}

async function processAsset(root, request) {
  const input = projectPath(root, request.input_path, 'input_path');
  const output = projectPath(root, request.output_path, 'output_path');
  if (!fs.existsSync(input) || !fs.statSync(input).isFile()) fail('E_IMAGE_ASSET_MISSING', 'input_path is not a file');
  const extension = path.extname(output).toLowerCase();
  if (!OUTPUT_EXTENSIONS.has(extension)) fail('E_IMAGE_ASSET_FORMAT', 'output_path extension is unsupported');
  if (fs.existsSync(output) && request.overwrite !== true) fail('E_IMAGE_ASSET_EXISTS', 'output_path already exists; choose a new path or explicitly set overwrite=true');
  const operations = Array.isArray(request.operations) ? request.operations : [];
  if (operations.length > MAX_OPERATIONS) fail('E_IMAGE_ASSET_LIMIT', `at most ${MAX_OPERATIONS} operations are allowed`);
  const layers = Array.isArray(request.composite_layers) ? request.composite_layers : [];
  if (layers.length > MAX_LAYERS) fail('E_IMAGE_ASSET_LIMIT', `at most ${MAX_LAYERS} composite layers are allowed`);
  const quality = request.quality === undefined ? 92 : integer(request.quality, 'quality', 1, 100);
  const sharp = await sharpFactory();
  let pipeline = sharp(input, { failOn: 'error', limitInputPixels: MAX_AREA });
  operations.map(normalizeOperation).forEach((operation) => { pipeline = applyOperation(pipeline, operation); });
  if (layers.length) {
    pipeline = pipeline.composite(layers.map((layer, index) => {
      if (!record(layer)) fail('E_IMAGE_ASSET_ARGUMENT', `composite_layers[${index}] must be an object`);
      return {
        input: projectPath(root, layer.path, `composite_layers[${index}].path`),
        left: optionalInteger(layer.left, `composite_layers[${index}].left`),
        top: optionalInteger(layer.top, `composite_layers[${index}].top`),
        blend: layer.blend === undefined ? undefined : String(layer.blend),
      };
    }));
  }
  pipeline = await formatPipeline(pipeline, extension, quality);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.${Date.now()}.tmp${extension}`;
  try {
    await pipeline.toFile(temporary);
    if (request.overwrite === true && fs.existsSync(output)) fs.unlinkSync(output);
    fs.renameSync(temporary, output);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* ignore */ }
    throw error;
  }
  return { ok: true, op: 'process', output_path: output, ...(await inspectImage(output)), engine: 'image-compose-skill-sharp', model_calls: 0 };
}

function runCommand(command, args, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false; let stdout = ''; let stderr = ''; let timer;
    const finish = (ok, detail) => {
      if (settled) return; settled = true; clearTimeout(timer); resolve({ ok, detail: String(detail || '').trim().slice(0, 2048) });
    };
    let child;
    try { child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); }
    catch (error) { finish(false, error.message); return; }
    child.stdout.on('data', (chunk) => { stdout = (stdout + String(chunk)).slice(-MAX_COMMAND_OUTPUT); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-MAX_COMMAND_OUTPUT); });
    child.once('error', (error) => finish(false, error.message));
    child.once('close', (code) => finish(code === 0, stdout || stderr || `process exited with code ${code}`));
    timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } finish(false, `process timed out after ${timeoutMs} ms`); }, timeoutMs);
  });
}

async function externalTransform(root, request, kind) {
  const input = projectPath(root, request.input_path, 'input_path');
  const output = projectPath(root, request.output_path, 'output_path');
  if (!fs.existsSync(input) || !fs.statSync(input).isFile()) fail('E_IMAGE_ASSET_MISSING', 'input_path is not a file');
  if (fs.existsSync(output) && request.overwrite !== true) fail('E_IMAGE_ASSET_EXISTS', 'output_path already exists; choose a new path or explicitly set overwrite=true');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.${Date.now()}.tmp${path.extname(output) || '.png'}`;
  let command; let args; let engine;
  if (kind === 'remove_background') {
    command = safeCommand(process.env.ORKAS_REMBG_BIN, 'ORKAS_REMBG_BIN', 'rembg');
    args = ['i', input, temporary]; engine = 'rembg';
  } else {
    command = safeCommand(process.env.ORKAS_REALESRGAN_BIN, 'ORKAS_REALESRGAN_BIN');
    const scale = integer(request.scale === undefined ? 4 : request.scale, 'scale', 2, 4);
    const model = String(request.model || 'realesrgan-x4plus').trim();
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(model)) fail('E_IMAGE_ASSET_ARGUMENT', 'model is invalid');
    const extension = path.extname(output).toLowerCase().replace(/^\./, '') || 'png';
    if (!['png', 'jpg', 'jpeg', 'webp'].includes(extension)) fail('E_IMAGE_ASSET_FORMAT', 'Real-ESRGAN output must be png, jpg, jpeg, or webp');
    args = ['-i', input, '-o', temporary, '-s', String(scale), '-n', model, '-f', extension === 'jpeg' ? 'jpg' : extension]; engine = 'real-esrgan-ncnn-vulkan';
  }
  const result = await runCommand(command, args, integer(request.timeout_ms === undefined ? 600_000 : request.timeout_ms, 'timeout_ms', 1_000, 1_800_000));
  if (!result.ok || !fs.existsSync(temporary)) {
    try { fs.unlinkSync(temporary); } catch { /* ignore */ }
    fail(kind === 'remove_background' ? 'E_REMBG_UNAVAILABLE' : 'E_REALESRGAN_UNAVAILABLE', result.detail || `${engine} did not write output`);
  }
  await inspectImage(temporary);
  if (request.overwrite === true && fs.existsSync(output)) fs.unlinkSync(output);
  fs.renameSync(temporary, output);
  return { ok: true, op: kind, output_path: output, ...(await inspectImage(output)), engine, model_calls: 0 };
}

async function capabilities() {
  const sharp = await sharpFactory();
  const rembg = await runCommand(safeCommand(process.env.ORKAS_REMBG_BIN, 'ORKAS_REMBG_BIN', 'rembg'), ['--version'], 2_000);
  let realesrgan = { ok: false, detail: 'ORKAS_REALESRGAN_BIN is not configured' };
  if (String(process.env.ORKAS_REALESRGAN_BIN || '').trim()) realesrgan = await runCommand(safeCommand(process.env.ORKAS_REALESRGAN_BIN, 'ORKAS_REALESRGAN_BIN'), ['-v'], 2_000);
  return {
    ok: true,
    op: 'capabilities',
    host_managed: true,
    sharp: { available: true, versions: { sharp: sharp.versions.sharp, vips: sharp.versions.vips } },
    background_removal: { available: rembg.ok, engine: 'rembg', ...(rembg.ok ? { version: rembg.detail } : { reason: rembg.detail }) },
    upscale: { available: realesrgan.ok, engine: 'real-esrgan-ncnn-vulkan', ...(realesrgan.ok ? { version: realesrgan.detail } : { reason: realesrgan.detail }) },
  };
}

async function runImageAsset({ args }) {
  const opts = parseArgs(args || []);
  const root = realOrResolve(path.resolve(process.cwd(), opts.project));
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) fail('E_IMAGE_ASSET_PATH', 'project is not a directory');
  const requestPath = projectPath(root, opts.request, 'request');
  let request;
  try { request = JSON.parse(fs.readFileSync(requestPath, 'utf8')); }
  catch (error) { fail('E_IMAGE_ASSET_READ', `could not read request JSON: ${error.message}`); }
  if (!record(request)) fail('E_IMAGE_ASSET_ARGUMENT', 'request must be an object');
  const op = String(request.op || '').trim();
  if (op === 'capabilities') return await capabilities();
  if (op === 'process') return await processAsset(root, request);
  if (op === 'remove_background') return await externalTransform(root, request, op);
  if (op === 'upscale') return await externalTransform(root, request, op);
  fail('E_IMAGE_ASSET_ARGUMENT', 'op must be capabilities, process, remove_background, or upscale');
}

module.exports = runImageAsset;
module.exports.processAsset = processAsset;
module.exports.inspectImage = inspectImage;
