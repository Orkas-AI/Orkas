'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const VERSION = '0.22.3';
// Increment when the decode recipe or output interpretation changes; engine
// version alone cannot authorize reuse after an adapter change.
const RECIPE_VERSION = 1;
const fingerprints = new Map();
const fail = (code, message) => { throw Object.assign(new Error(`${code}: ${message}`), { code }); };
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);

function settings(value) {
  if (!object(value) || Object.keys(value).some(key => !['exposure_ev', 'white_balance', 'highlights', 'preserve_highlights'].includes(key))) fail('E_RAW_ARGUMENT', 'unsupported RAW settings');
  const ev = value.exposure_ev ?? 0, preserve = value.preserve_highlights ?? 0;
  if (typeof ev !== 'number' || !Number.isFinite(ev) || ev < -2 || ev > 3
    || typeof preserve !== 'number' || !Number.isFinite(preserve) || preserve < 0 || preserve > 1) fail('E_RAW_ARGUMENT', 'RAW exposure must be -2 to +3 EV and highlight preservation 0 to 1');
  const wb = value.white_balance ?? 'camera';
  if (!['camera', 'auto'].includes(wb) && (!object(wb) || Object.keys(wb).some(key => key !== 'multipliers')
    || !Array.isArray(wb.multipliers) || wb.multipliers.length !== 4
    || !wb.multipliers.every(v => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 16))) fail('E_RAW_ARGUMENT', 'white_balance needs camera, auto or four positive RGBG multipliers');
  const highlights = value.highlights ?? 'clip';
  if (!['clip', 'blend', 'rebuild'].includes(highlights)) fail('E_RAW_ARGUMENT', 'unsupported highlight mode');
  return { exposure_ev: ev, white_balance: wb, highlights, preserve_highlights: preserve };
}

function engine() {
  const key = `${process.platform}-${process.arch}`, pc = process.env.ORKAS_PC_DIR;
  const names = [process.env.ORKAS_LIBRAW, ...(pc ? [path.join(pc, 'resources/runtime/libraw', key, 'bin', process.platform === 'win32' ? 'dcraw_emu.exe' : 'dcraw_emu'),
    path.join(pc, '../runtime/libraw', key, 'bin', process.platform === 'win32' ? 'dcraw_emu.exe' : 'dcraw_emu')] : [])].filter(Boolean);
  for (const file of names) {
    try {
      const dir = path.dirname(path.dirname(file));
      const marker = JSON.parse(fs.readFileSync(path.join(dir, '.orkas-libraw-ready.json')));
      if (marker.version !== VERSION || marker.platformKey !== key || marker.schema !== 1 || !fs.statSync(file).isFile()) continue;
      const sources = [file, ...(process.platform === 'win32' ? [path.join(path.dirname(file), 'libraw.dll')] : [])];
      const identities = sources.map(source => {
        const stat = fs.statSync(source), cacheKey = `${source}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
        let hash = fingerprints.get(cacheKey);
        if (!hash) { hash = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'); if (fingerprints.size >= 8) fingerprints.clear(); fingerprints.set(cacheKey, hash); }
        return hash;
      });
      return { file, version: VERSION, identity: identities.join(':') };
    } catch { /* Missing payload never selects a system binary or embedded JPEG. */ }
  }
  fail('E_RAW_UNAVAILABLE', 'The bundled RAW engine is unavailable. Repair the app dependencies or reinstall Orkas; keep the originals.');
}

function argumentsFor(input, output, raw) {
  return ['-T', '-6', '-W', '-g', '2.4', '12.92', '-o', '1', '-q', '3',
    '-aexpo', String(2 ** raw.exposure_ev), String(raw.preserve_highlights),
    '-H', String({ clip: 0, blend: 2, rebuild: 3 }[raw.highlights]),
    ...(raw.white_balance === 'camera' ? ['-w'] : raw.white_balance === 'auto' ? ['-a'] : ['-r', ...raw.white_balance.multipliers.map(String)]),
    '-Z', output, input];
}

async function develop(input, output, raw, timeoutMs = 600_000, signal) {
  const runtime = engine();
  const stat = await fs.promises.stat(input);
  if (!stat.isFile() || stat.size > 536_870_912) fail('E_RAW_LIMIT', 'RAW input must be a file of at most 512 MiB');
  if (signal?.aborted) fail('E_RAW_CANCELLED', 'RAW processing was cancelled; completed photos and originals remain available');
  let staging;
  try {
    // The vendor Windows sample uses narrow argv/file APIs. Keep its arguments
    // ASCII and use Node's Unicode-safe filesystem APIs at the adapter boundary.
    if (process.platform === 'win32') {
      staging = await fs.promises.mkdtemp(path.join(path.dirname(output), '.decode-'));
      await fs.promises.copyFile(input, path.join(staging, 'source.raw'), fs.constants.COPYFILE_EXCL);
    }
    if (signal?.aborted) fail('E_RAW_CANCELLED', 'RAW processing was cancelled; completed photos and originals remain available');
    await new Promise((resolve, reject) => {
      const child = spawn(runtime.file, argumentsFor(staging ? 'source.raw' : input, staging ? 'developed.tiff' : output, raw), { windowsHide: true,
        ...(staging ? { cwd: staging } : {}),
        stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, OMP_NUM_THREADS: '2' } });
      let reason = '', diagnosticBytes = 0;
      // Drain all stderr without retaining raw camera paths or errors in receipts.
      child.stderr.on('data', chunk => { diagnosticBytes += chunk.length; });
      const stop = code => { reason = code; child.kill('SIGKILL'); };
      const cancel = () => stop('E_RAW_CANCELLED');
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      const timer = setTimeout(() => stop('E_RAW_TIMEOUT'), timeoutMs);
      child.once('error', () => { reason = 'E_RAW_UNAVAILABLE'; });
      child.once('close', code => {
        clearTimeout(timer); signal?.removeEventListener('abort', cancel);
        if (reason || code !== 0) reject(Object.assign(new Error(`${reason || 'E_RAW_DECODE'}: RAW was not completed; preserve the input, check camera support or repair the dependency, then resume`), { code: reason || 'E_RAW_DECODE' }));
        else if (diagnosticBytes) reject(Object.assign(new Error('E_RAW_DIAGNOSTIC: RAW engine emitted diagnostics; retain the candidate for inspection before delivery'), { code: 'E_RAW_DIAGNOSTIC' }));
        else resolve();
      });
    });
    if (staging) await fs.promises.rename(path.join(staging, 'developed.tiff'), output);
    return runtime;
  } finally { if (staging) await fs.promises.rm(staging, { recursive: true, force: true }); }
}
module.exports = { VERSION, RECIPE_VERSION, settings, engine, argumentsFor, develop };
