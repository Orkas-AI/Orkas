'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readLockPackage(lockFile, name) {
  const lock = readJson(lockFile);
  if (!lock) {
    throw new Error(`cannot read package-lock.json: ${lockFile}`);
  }
  const item = lock.packages?.[`node_modules/${name}`];
  if (!item?.version) {
    throw new Error(`package-lock.json is missing node_modules/${name}`);
  }
  return item.version;
}

function readElectronVersion(pcDir) {
  const pkg = readJson(path.join(pcDir, 'package.json'));
  const spec = String(pkg?.devDependencies?.electron || '');
  const match = spec.match(/\d+(?:\.\d+){0,2}/);
  if (!match) {
    throw new Error(`package.json is missing a concrete Electron version: ${spec}`);
  }
  return match[0];
}

function packagePath(pcDir, packageName) {
  return path.join(pcDir, 'node_modules', ...packageName.split('/'));
}

function packageVersion(pcDir, packageName) {
  return readJson(path.join(packagePath(pcDir, packageName), 'package.json'))?.version || '';
}

function allFilesExist(files) {
  return files.every((file) => fs.existsSync(file) && fs.statSync(file).isFile());
}

function ensureFile(label, file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`missing ${label}: ${file}`);
  }
}

function scriptHashes(files) {
  return Object.fromEntries(
    Object.entries(files).map(([name, file]) => [name, sha256File(file)]),
  );
}

function markerFile(pcDir, platform, arch) {
  return path.join(pcDir, '.orkas-native-prepared', `${platform}-${arch}.json`);
}

function comparableState(value) {
  if (!value || typeof value !== 'object') return null;
  const out = {
    schema: value.schema,
    platform: value.platform,
    arch: value.arch,
    packages: value.packages,
    scriptHashes: value.scriptHashes,
  };
  if (Object.prototype.hasOwnProperty.call(value, 'electronVersion')) {
    out.electronVersion = value.electronVersion;
  }
  return out;
}

function statesEqual(a, b) {
  return JSON.stringify(comparableState(a)) === JSON.stringify(comparableState(b));
}

function markerMatches(pcDir, state, requiredFiles, validateFiles) {
  const marker = readJson(markerFile(pcDir, state.platform, state.arch));
  return statesEqual(marker, state)
    && allFilesExist(requiredFiles)
    && (!validateFiles || validateFiles());
}

function writeMarker(pcDir, state) {
  const file = markerFile(pcDir, state.platform, state.arch);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ ...state, preparedAt: new Date().toISOString() }, null, 2)}\n`);
}

function readPeMachine(file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  const fd = fs.openSync(file, 'r');
  try {
    const dos = Buffer.alloc(64);
    if (fs.readSync(fd, dos, 0, dos.length, 0) < dos.length || dos.toString('ascii', 0, 2) !== 'MZ') {
      return null;
    }
    const peOffset = dos.readUInt32LE(0x3c);
    const header = Buffer.alloc(6);
    if (fs.readSync(fd, header, 0, header.length, peOffset) < header.length) return null;
    if (header.toString('ascii', 0, 4) !== 'PE\0\0') return null;
    return header.readUInt16LE(4);
  } finally {
    fs.closeSync(fd);
  }
}

function isPeX64(file) {
  return readPeMachine(file) === 0x8664;
}

function machCpuTypes(file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return [];
  const data = fs.readFileSync(file);
  if (data.length < 8) return [];

  const magicBE = data.readUInt32BE(0);
  if (magicBE === 0xcafebabe || magicBE === 0xcafebabf) {
    const count = data.readUInt32BE(4);
    const out = [];
    const archSize = magicBE === 0xcafebabf ? 32 : 20;
    for (let i = 0; i < count; i += 1) {
      const offset = 8 + i * archSize;
      if (offset + 4 <= data.length) out.push(data.readUInt32BE(offset));
    }
    return out;
  }

  const magicLE = data.readUInt32LE(0);
  if (magicLE === 0xfeedface || magicLE === 0xfeedfacf) {
    return [data.readUInt32LE(4)];
  }
  if (magicBE === 0xfeedface || magicBE === 0xfeedfacf) {
    return [data.readUInt32BE(4)];
  }
  return [];
}

function isMachArch(file, arch) {
  const expected = arch === 'arm64' ? 0x0100000c : 0x01000007;
  return machCpuTypes(file).includes(expected);
}

module.exports = {
  allFilesExist,
  ensureFile,
  isMachArch,
  isPeX64,
  markerMatches,
  packagePath,
  packageVersion,
  readElectronVersion,
  readJson,
  readLockPackage,
  scriptHashes,
  writeMarker,
};
