'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const rawPhoto = require('./raw_photo');

const MAX_AREA = 100_000_000;
const MAX_DIMENSION = 16_384;
const MAX_OPERATIONS = 16;
const MAX_LAYERS = 16;
const MAX_BATCH_ITEMS = 128;
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
  if (!inside(root, candidate)) {
    const recovery = label === 'request'
      ? '. Create the operation JSON inside --project and pass its path to --request relative to --project.'
        + ' For a capability check, create asset-capabilities.json containing {"op":"capabilities"}.'
      : '';
    fail('E_IMAGE_ASSET_PATH', `${label} must stay inside the project${recovery}`);
  }
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
  if (type === 'modulate') {
    const result = { type };
    for (const [key, min, max] of [['brightness', 0, 4], ['saturation', 0, 4], ['hue', -180, 180], ['lightness', -100, 100]]) {
      if (raw[key] === undefined) continue;
      if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key]) || raw[key] < min || raw[key] > max) {
        fail('E_IMAGE_ASSET_ARGUMENT', `operations[${index}].${key} must be a number from ${min} to ${max}`);
      }
      result[key] = raw[key];
    }
    return result;
  }
  if (type === 'linear') {
    const coefficient = (value, fallback, key, min, max) => {
      if (value === undefined) return fallback;
      const values = Array.isArray(value) ? value : [value];
      if ((Array.isArray(value) && values.length !== 3) || values.some(v => typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max)) {
        fail('E_IMAGE_ASSET_ARGUMENT', `operations[${index}].${key} must be a number or three RGB numbers from ${min} to ${max}`);
      }
      return value;
    };
    let a = coefficient(raw.a, 1, 'a', 0, 16);
    let b = coefficient(raw.b, 0, 'b', -255, 255);
    if (Array.isArray(a) && !Array.isArray(b)) b = [b, b, b];
    if (Array.isArray(b) && !Array.isArray(a)) a = [a, a, a];
    return { type, a, b };
  }
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
  if (operation.type === 'modulate') {
    const { type, ...parameters } = operation;
    return pipeline.modulate(parameters);
  }
  if (operation.type === 'linear') return pipeline.linear(operation.a, operation.b);
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

async function formatPipeline(pipeline, extension, quality, preserveColors = false) {
  if (extension === '.png') return preserveColors ? pipeline.png() : pipeline.png({ quality });
  if (extension === '.webp') return pipeline.webp({ quality });
  if (extension === '.avif') return pipeline.avif({ quality });
  if (extension === '.jpg' || extension === '.jpeg') return pipeline.jpeg({ quality });
  return pipeline.tiff({ quality });
}

async function processAsset(root, request, exclusivePublish = false, signal) {
  const input = projectPath(root, request.input_path, 'input_path');
  const output = projectPath(root, request.output_path, 'output_path');
  const receiptRaw = `${output}.image-normalization.json`;
  if (fs.existsSync(receiptRaw) && fs.lstatSync(receiptRaw).isSymbolicLink()) fail('E_IMAGE_ASSET_PATH', 'normalization receipt must not be a symlink');
  const receiptPath = projectPath(root, receiptRaw, 'normalization receipt');
  if (!fs.existsSync(input) || !fs.statSync(input).isFile()) fail('E_IMAGE_ASSET_MISSING', 'input_path is not a file');
  const raw = request.raw === undefined ? undefined : rawPhoto.settings(request.raw);
  const color = normalizeColor(request.color, !!raw);
  if (raw && input === output) fail('E_RAW_ARGUMENT', 'RAW development must preserve the original');
  const extension = path.extname(output).toLowerCase();
  if (!OUTPUT_EXTENSIONS.has(extension)) fail('E_IMAGE_ASSET_FORMAT', 'output_path extension is unsupported');
  if (fs.existsSync(output) && request.overwrite !== true) fail('E_IMAGE_ASSET_EXISTS', 'output_path already exists; choose a new path or explicitly set overwrite=true');
  const operations = Array.isArray(request.operations) ? request.operations : [];
  if (operations.length > MAX_OPERATIONS) fail('E_IMAGE_ASSET_LIMIT', `at most ${MAX_OPERATIONS} operations are allowed`);
  const layers = Array.isArray(request.composite_layers) ? request.composite_layers : [];
  if (layers.length > MAX_LAYERS) fail('E_IMAGE_ASSET_LIMIT', `at most ${MAX_LAYERS} composite layers are allowed`);
  const quality = request.quality === undefined ? 92 : integer(request.quality, 'quality', 1, 100);
  const sharp = await sharpFactory();
  const normalized = operations.map(normalizeOperation);
  const canNormalize = !raw && !color && input !== output && !layers.length && normalized.length <= 1
    && normalized.every(op => op.type === 'resize' && (!op.kernel || op.kernel === 'lanczos3') && !op.without_enlargement);
  const inputHash = canNormalize ? crypto.createHash('sha256').update(fs.readFileSync(input)).digest('hex') : '';
  const rawInputHash = raw ? await fileHash(input) : undefined;
  let rawDir;
  try {
    let processedInput = input;
    if (raw) {
      rawDir = await fs.promises.mkdtemp(path.join(root, '.raw-'));
      processedInput = path.join(rawDir, 'developed.tiff');
      const timeout = request.timeout_ms === undefined ? 600_000 : integer(request.timeout_ms, 'timeout_ms', 1000, 1_800_000);
      await rawPhoto.develop(input, processedInput, raw, timeout, signal);
    }
    let colorWarning = false;
    let pipeline = sharp(processedInput, { failOn: color ? 'warning' : 'error', limitInputPixels: MAX_AREA });
    if (color) pipeline.on('warning', () => { colorWarning = true; });
    if (color) {
      const metadata = await pipeline.metadata();
      validateProfile(metadata.icc);
      pipeline = pipeline.withIccProfile('srgb');
    }
    normalized.forEach((operation) => { pipeline = applyOperation(pipeline, operation); });
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
    pipeline = await formatPipeline(pipeline, extension, quality, !!color);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const temporary = `${output}.${crypto.randomUUID()}.tmp${extension}`;
    try {
      await pipeline.toFile(temporary);
      if (colorWarning) fail('E_IMAGE_ASSET_COLOR', 'color conversion emitted a diagnostic; inspect the source profile before delivery');
      const info = await inspectImage(temporary);
      if (signal?.aborted) fail('E_RAW_CANCELLED', 'RAW processing was cancelled; preserve the originals and resume unfinished photos');
      if (color) {
        const metadata = await sharp(temporary).metadata();
        if (!metadata.icc) fail('E_IMAGE_ASSET_COLOR', 'output color profile is missing');
      }
      if (rawInputHash && await fileHash(input) !== rawInputHash) fail('E_RAW_SOURCE_CHANGED', 'RAW changed during processing; preserve it and rerun with a new output');
      // Replace directly: deleting the destination first loses it if rename fails.
      if (!exclusivePublish) fs.renameSync(temporary, output);
      else {
        // A concurrent worker must not replace a delivery that appeared after
        // the preflight. A same-directory hard link publishes without clobbering.
        fs.linkSync(temporary, output);
        fs.unlinkSync(temporary);
      }
      // The host replays this hint against a recorded provider ancestor. It is
      // never an authority to mark a composite or arbitrary output as generated.
      fs.rmSync(receiptPath, { force: true });
      const format = extension === '.jpg' || extension === '.jpeg' ? 'jpeg' : extension.slice(1);
      if (canNormalize && ['png', 'jpeg', 'webp'].includes(format)) {
        const before = await inspectImage(input);
        if (before.width * info.height === before.height * info.width) {
          fs.writeFileSync(receiptPath, JSON.stringify({
            schema_version: 1, input_path: path.relative(root, input), input_sha256: inputHash,
            output_sha256: crypto.createHash('sha256').update(fs.readFileSync(output)).digest('hex'),
            format, quality, resize: normalized.length === 1,
          }));
        }
      }
      return { ok: true, op: 'process', output_path: output, ...info, engine: 'image-compose-skill-sharp', model_calls: 0,
        ...(raw ? { raw_developed: true, raw_engine: { name: 'libraw', version: rawPhoto.VERSION }, raw } : {}),
        ...(color ? { color: { output: 'srgb', icc_embedded: true } } : {}) };
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch { /* ignore */ }
      throw error;
    }
  } finally { if (rawDir) await fs.promises.rm(rawDir, { recursive: true, force: true }); }
}

function normalizeColor(value, raw = false) {
  if (value === undefined) return raw ? { output: 'srgb' } : undefined;
  if (!record(value) || Object.keys(value).some(key => key !== 'output') || value.output !== 'srgb') {
    fail('E_IMAGE_ASSET_COLOR', 'color.output must be srgb');
  }
  return { output: 'srgb' };
}

function validateProfile(icc) {
  if (!icc) return;
  if (icc.length < 132 || icc.length > 4_194_304 || icc.readUInt32BE(0) !== icc.length
    || icc.toString('ascii', 36, 40) !== 'acsp') fail('E_IMAGE_ASSET_COLOR', 'input color profile is invalid');
  const count = icc.readUInt32BE(128);
  if (count > 1024 || 132 + count * 12 > icc.length) fail('E_IMAGE_ASSET_COLOR', 'input color profile is invalid');
  for (let i = 0; i < count; i++) {
    const offset = icc.readUInt32BE(136 + i * 12), bytes = icc.readUInt32BE(140 + i * 12);
    if (offset < 132 + count * 12 || offset + bytes > icc.length) fail('E_IMAGE_ASSET_COLOR', 'input color profile is invalid');
  }
}

async function fileHash(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function maskedComposite(root, request) {
  const input = projectPath(root, request.input_path, 'input_path');
  const background = projectPath(root, request.background_path, 'background_path');
  const mask = projectPath(root, request.mask_path, 'mask_path');
  const output = projectPath(root, request.output_path, 'output_path');
  if ([input, background, mask].includes(output)) fail('E_IMAGE_ASSET_PATH', 'masked output must not replace any source');
  if (path.extname(output).toLowerCase() !== '.png') fail('E_IMAGE_ASSET_FORMAT', 'exact masked composition requires PNG output');
  if (fs.existsSync(output)) fail('E_IMAGE_ASSET_EXISTS', 'output_path already exists; choose a new path');
  const sharp = await sharpFactory();
  const metadata = [];
  for (const file of [input, background, mask]) metadata.push(await sharp(file, { failOn: 'error', limitInputPixels: 16_777_216 }).metadata());
  const [sourceInfo, replacementInfo, maskInfo] = metadata;
  if (metadata.some(info => info.width !== sourceInfo.width || info.height !== sourceInfo.height)) fail('E_IMAGE_ASSET_MASK', 'source, background and mask dimensions must match');
  if ([sourceInfo, replacementInfo].some(info => info.depth !== 'uchar' || info.space !== 'srgb')) fail('E_IMAGE_ASSET_MASK', 'exact masked composition supports only 8-bit sRGB inputs');
  if (maskInfo.depth !== 'uchar') fail('E_IMAGE_ASSET_MASK', 'mask must contain 8-bit opaque black and white pixels');
  const source = await sharp(input, { limitInputPixels: 16_777_216 }).ensureAlpha().raw().toBuffer();
  const replacement = await sharp(background, { limitInputPixels: 16_777_216 }).ensureAlpha().raw().toBuffer();
  const selection = await sharp(mask, { limitInputPixels: 16_777_216 }).ensureAlpha().raw().toBuffer();
  const pixels = sourceInfo.width * sourceInfo.height;
  if ([source, replacement, selection].some(buffer => buffer.length !== pixels * 4)) fail('E_IMAGE_ASSET_MASK', 'decoded inputs must be RGBA');
  const result = Buffer.from(source);
  let protectedPixels = 0;
  for (let offset = 0; offset < result.length; offset += 4) {
    const value = selection[offset];
    if ((value !== 0 && value !== 255) || selection[offset + 1] !== value || selection[offset + 2] !== value || selection[offset + 3] !== 255) {
      fail('E_IMAGE_ASSET_MASK', 'mask must be opaque black (preserve) or white (replace); feathered masks are unsupported');
    }
    if (value === 255) replacement.copy(result, offset, offset, offset + 4);
    else protectedPixels += 1;
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temporary = `${output}.${crypto.randomUUID()}.tmp.png`;
  try {
    await sharp(result, { raw: { width: sourceInfo.width, height: sourceInfo.height, channels: 4 } }).png().toFile(temporary);
    const decoded = await sharp(temporary).ensureAlpha().raw().toBuffer();
    if (!decoded.equals(result)) fail('E_IMAGE_ASSET_MASK', 'lossless output verification failed');
    fs.linkSync(temporary, output);
    return { ok: true, op: 'masked_composite', output_path: output, width: sourceInfo.width, height: sourceInfo.height,
      format: 'png', protected_pixels: protectedPixels, protected_pixels_verified: true, model_calls: 0 };
  } finally {
    await fs.promises.rm(temporary, { force: true });
  }
}

// A completed item's receipt binds source bytes, effective parameters and output
// bytes. Missing/stale receipts never grant permission to replace a delivery.
async function batchAssets(root, request, signal) {
  if (!Array.isArray(request.items) || request.items.length < 1 || request.items.length > MAX_BATCH_ITEMS) {
    fail('E_IMAGE_ASSET_LIMIT', `batch requires 1-${MAX_BATCH_ITEMS} items`);
  }
  const jobs = request.items.map((item, index) => {
    if (!record(item)) fail('E_IMAGE_ASSET_ARGUMENT', `items[${index}] must be an object`);
    const effective = {
      ...item, op: 'process', overwrite: false,
      operations: item.operations === undefined ? (request.operations === undefined ? [] : request.operations) : item.operations,
      quality: item.quality === undefined ? request.quality : item.quality,
      raw: item.raw === undefined ? request.raw : item.raw,
      color: item.color === undefined ? request.color : item.color,
    };
    if (!Array.isArray(effective.operations) || effective.operations.length > MAX_OPERATIONS) fail('E_IMAGE_ASSET_ARGUMENT', 'operations must be an array of at most 16 operations');
    if (item.composite_layers !== undefined) fail('E_IMAGE_ASSET_ARGUMENT', 'batch photo adjustments do not accept composite_layers');
    const operations = effective.operations.map(normalizeOperation);
    const quality = effective.quality === undefined ? 92 : integer(effective.quality, 'quality', 1, 100);
    const raw = effective.raw === undefined ? undefined : rawPhoto.settings(effective.raw);
    const color = normalizeColor(effective.color, !!raw);
    const input = projectPath(root, item.input_path, 'input_path');
    const output = projectPath(root, item.output_path, 'output_path');
    if (!OUTPUT_EXTENSIONS.has(path.extname(output).toLowerCase())) fail('E_IMAGE_ASSET_FORMAT', 'output_path extension is unsupported');
    const receiptRaw = `${output}.image-batch.json`;
    if (fs.existsSync(receiptRaw) && fs.lstatSync(receiptRaw).isSymbolicLink()) fail('E_IMAGE_ASSET_PATH', 'batch receipt must not be a symlink');
    const receipt = projectPath(root, receiptRaw, 'batch receipt');
    const normalizationReceipt = projectPath(root, `${output}.image-normalization.json`, 'normalization receipt');
    return { effective, input, output, receipt, normalizationReceipt, operations, quality, raw, color };
  });
  const sources = new Set(jobs.map(job => job.input));
  const destinations = new Set();
  for (const job of jobs) {
    for (const destination of [job.output, job.receipt, job.normalizationReceipt]) {
      if (sources.has(destination) || destinations.has(destination)) fail('E_IMAGE_ASSET_PATH', 'batch outputs must be unique and must not replace any source');
      destinations.add(destination);
    }
  }
  const results = [];
  const sharp = await sharpFactory();
  for (const job of jobs) {
    if (signal?.aborted) {
      results.push({ status: 'pending', output_path: job.output });
      continue;
    }
    let temporary;
    try {
      // Decode before processing so a corrupt input has a stable recoverable
      // signal and cannot prevent later independent photos from completing.
      if (!job.raw) await inspectImage(job.input);
      const inputHash = await fileHash(job.input);
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
        schema_version: 1, engine_versions: { sharp: sharp.versions.sharp, vips: sharp.versions.vips },
        input_path: path.relative(root, job.input), input_sha256: inputHash,
        output_path: path.relative(root, job.output), operations: job.operations, quality: job.quality,
        ...(job.raw ? { raw: job.raw, raw_engine: rawPhoto.engine().identity, raw_version: rawPhoto.VERSION, raw_recipe: rawPhoto.RECIPE_VERSION } : {}),
        ...(job.color ? { color: job.color } : {}),
      })).digest('hex');
      if (fs.existsSync(job.output)) {
        let prior;
        try { prior = JSON.parse(await fs.promises.readFile(job.receipt, 'utf8')); } catch { /* unverified output stays protected */ }
        if (prior?.schema_version === 1 && prior.request_sha256 === fingerprint && prior.output_sha256 === await fileHash(job.output)) {
          results.push({ status: 'reused', output_path: job.output });
          continue;
        }
        fail('E_IMAGE_ASSET_EXISTS', 'output differs from this request or has no valid receipt; choose a new output path');
      }
      const result = await processAsset(root, job.effective, true, signal);
      if (await fileHash(job.input) !== inputHash) fail('E_IMAGE_ASSET_SOURCE_CHANGED', 'source changed during processing; inspect the candidate before continuing');
      const receipt = {
        schema_version: 1, request_sha256: fingerprint,
        engine_versions: { sharp: sharp.versions.sharp, vips: sharp.versions.vips },
        input_path: path.relative(root, job.input), input_sha256: inputHash,
        operations: job.operations, quality: job.quality,
        ...(job.raw ? { raw: job.raw, raw_engine: { name: 'libraw', version: rawPhoto.VERSION, identity: rawPhoto.engine().identity } } : {}),
        ...(job.color ? { color: job.color } : {}),
        output_path: path.relative(root, job.output), output_sha256: await fileHash(job.output),
      };
      temporary = `${job.receipt}.${crypto.randomUUID()}.tmp`;
      await fs.promises.writeFile(temporary, JSON.stringify(receipt));
      await fs.promises.rename(temporary, job.receipt);
      results.push({ ...result, status: 'completed', receipt_path: job.receipt });
    } catch (error) {
      results.push({ status: 'failed', input_path: job.input, output_path: job.output, error_code: error.code || 'E_IMAGE_ASSET_PROCESS', message: 'Photo was not completed. Preserve existing files, repair the input or choose a new output path, then resume the batch.' });
    } finally {
      if (temporary) await fs.promises.rm(temporary, { force: true });
    }
  }
  const count = status => results.filter(item => item.status === status).length;
  return { ok: count('failed') === 0 && count('pending') === 0, op: 'batch', model_calls: 0, completed: count('completed'), reused: count('reused'), failed: count('failed'),
    ...(count('pending') ? { pending: count('pending') } : {}), items: results };
}

async function capabilities() {
  const sharp = await sharpFactory();
  let raw;
  try { const runtime = rawPhoto.engine(); raw = { available: true, engine: 'libraw', version: runtime.version,
    exposure_ev: [-2, 3], white_balance: ['camera', 'auto', 'rgbg_multipliers'], highlights: ['clip', 'blend', 'rebuild'],
    output_color: 'srgb', batch: true }; }
  catch { raw = { available: false, engine: 'libraw', reason: 'bundled_runtime_missing' }; }
  return {
    ok: true,
    op: 'capabilities',
    host_managed: true,
    sharp: { available: true, versions: { sharp: sharp.versions.sharp, vips: sharp.versions.vips } },
    photo_processing: {
      operations: {
        modulate: { brightness: [0, 4], saturation: [0, 4], hue: [-180, 180], lightness: [-100, 100] },
        linear: { a: [0, 16], b: [-255, 255], channels: 'scalar_or_rgb_array' },
      },
      batch: { op: 'batch', max_items: MAX_BATCH_ITEMS, shared_fields: ['operations', 'quality', 'raw', 'color'], item_fields: ['input_path', 'output_path', 'operations', 'quality', 'raw', 'color'], item_operations: 'replace_shared', resume: 'verified_source_parameters_and_output_hashes', overwrite: false },
      raw_development: raw.available,
      raw,
      color: { output: ['srgb'], icc_embedded: true, untagged_input: 'assumed_srgb' },
    },
    masked_composite: { available: true, input_fields: ['input_path', 'background_path', 'mask_path', 'output_path'], mask: 'opaque_binary_white_replaces_black_preserves', input_color: '8_bit_srgb', output_format: 'png', max_pixels: 16_777_216, protected_rgba: 'exact' },
  };
}

async function runImageAsset({ args }) {
  const opts = parseArgs(args || []);
  const root = realOrResolve(path.resolve(process.cwd(), opts.project));
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) fail('E_IMAGE_ASSET_PATH', 'project is not a directory');
  const requestPath = projectPath(root, opts.request, 'request');
  let requestText;
  try { requestText = fs.readFileSync(requestPath, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      fail('E_IMAGE_ASSET_READ', 'Request file not found. Create the JSON first, then pass its path as --request relative to --project.');
    }
    fail('E_IMAGE_ASSET_READ', 'Could not read the request file. Check that --request points to a readable JSON file.');
  }
  let request;
  try { request = JSON.parse(requestText); }
  catch { fail('E_IMAGE_ASSET_READ', 'Request file contains invalid JSON. Correct the JSON and rerun the request.'); }
  if (!record(request)) fail('E_IMAGE_ASSET_ARGUMENT', 'Request JSON must contain a single object.');
  const op = String(request.op || '').trim();
  if (op === 'capabilities') return await capabilities();
  if (op === 'process' || op === 'batch') {
    const usesRaw = request.raw !== undefined || (op === 'batch' && Array.isArray(request.items) && request.items.some(item => record(item) && item.raw !== undefined));
    if (!usesRaw) return op === 'process' ? await processAsset(root, request) : await batchAssets(root, request);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    // Module scripts run in the Skill process; terminate the owned decoder
    // before releasing its files, and never start another item after cancel.
    process.once('SIGTERM', cancel); process.once('SIGINT', cancel);
    try { return op === 'process' ? await processAsset(root, request, false, controller.signal) : await batchAssets(root, request, controller.signal); }
    finally { process.removeListener('SIGTERM', cancel); process.removeListener('SIGINT', cancel); }
  }
  if (op === 'masked_composite') return await maskedComposite(root, request);
  fail('E_IMAGE_ASSET_ARGUMENT', 'op must be capabilities, process, batch, or masked_composite');
}

module.exports = runImageAsset;
module.exports.processAsset = processAsset;
module.exports.inspectImage = inspectImage;
module.exports.projectPath = projectPath;
module.exports.parseArgs = parseArgs;
module.exports.sharpFactory = sharpFactory;
