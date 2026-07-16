#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Every electron-builder extraResources destination must be declared here.
// Some destinations have their own specialist verifier; this registry makes a
// package.json addition fail tests until its verification ownership is explicit.
const EXTRA_RESOURCES_CONTRACT = Object.freeze({
  'embedding-model': 'pinned-offline-resource',
  runtime: 'target-runtime-gate',
  builtin: 'builtin-resource-contract',
  officecli: 'officecli-release-gate',
  '.': 'mac-localized-metadata',
});

const EMBEDDING_MODEL_CONTRACT = Object.freeze({
  kind: 'embedding-model',
  id: 'fast-bge-small-zh-v1.5',
  source: 'https://storage.googleapis.com/qdrant-fastembed/fast-bge-small-zh-v1.5.tar.gz',
  archive: Object.freeze({
    bytes: 54_584_282,
    sha256: 'bf023219b6029148fddf764d248808816c0ca1f107f058231bb1ae0fa526f83f',
  }),
  files: Object.freeze([
    Object.freeze({ name: 'config.json', bytes: 739, sha256: '9088751d39abbf86ec3d19ffca92ad62ad19075f7e59712e6c71217fa125d1d3' }),
    Object.freeze({ name: 'model_optimized.onnx', bytes: 94_781_076, sha256: '1294ea4b6331115a353d81f96b85e8c8d7fdcc284453d5b2fab5b016230aad38' }),
    Object.freeze({ name: 'ort_config.json', bytes: 1_234, sha256: '97e78d1d21c2eb719e865b018f17915df6a12ed987446eb7f3f3a783a5afb1e1' }),
    Object.freeze({ name: 'special_tokens_map.json', bytes: 125, sha256: 'b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3' }),
    Object.freeze({ name: 'tokenizer.json', bytes: 439_125, sha256: '48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26' }),
    Object.freeze({ name: 'tokenizer_config.json', bytes: 367, sha256: 'e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a' }),
    Object.freeze({ name: 'vocab.txt', bytes: 109_540, sha256: '45bbac6b341c319adc98a532532882e91a9cefc0329aa57bac9ae761c27b291c' }),
  ]),
});

const MAC_LOCALIZED_METADATA_CONTRACT = Object.freeze([
  Object.freeze({
    directory: 'en.lproj',
    values: Object.freeze({
      NSMicrophoneUsageDescription: 'Orkas uses the microphone for voice input.',
    }),
  }),
  Object.freeze({
    directory: 'ja.lproj',
    values: Object.freeze({
      NSMicrophoneUsageDescription: 'Orkas は音声入力にマイクを使用します。',
    }),
  }),
  Object.freeze({
    directory: 'zh-Hans.lproj',
    values: Object.freeze({
      NSMicrophoneUsageDescription: 'Orkas 需要使用麦克风进行语音输入。',
    }),
  }),
]);

const MAC_LOCALIZED_METADATA_FILTERS = Object.freeze(
  MAC_LOCALIZED_METADATA_CONTRACT.map((item) => `${item.directory}/InfoPlist.strings`),
);

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function requireDirectory(label, dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`[packaged-resource-gate] missing ${label}: ${dir}`);
  }
}

function requirePinnedFile(label, file, expected) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new Error(`[packaged-resource-gate] missing ${label}: ${file}`);
  }
  if (!stat.isFile()) {
    throw new Error(`[packaged-resource-gate] ${label} is not a file: ${file}`);
  }
  if (stat.size !== expected.bytes) {
    throw new Error(`[packaged-resource-gate] ${label} size mismatch: expected ${expected.bytes}, got ${stat.size}: ${file}`);
  }
  const actualSha256 = sha256File(file);
  if (actualSha256 !== expected.sha256) {
    throw new Error(`[packaged-resource-gate] ${label} sha256 mismatch: expected ${expected.sha256}, got ${actualSha256}: ${file}`);
  }
}

function requireOnlyEntries(dir, allowed, label) {
  const expected = new Set(allowed);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!expected.has(entry.name)) {
      throw new Error(`[packaged-resource-gate] unexpected ${label}: ${path.join(dir, entry.name)}`);
    }
  }
}

function parseAppleStrings(text, label = 'InfoPlist.strings') {
  text = String(text || '').replace(/^\uFEFF/, '');
  let offset = 0;
  const values = {};

  function fail(message) {
    throw new Error(`[packaged-resource-gate] invalid ${label} at offset ${offset}: ${message}`);
  }

  function skipTrivia() {
    while (offset < text.length) {
      if (/\s/.test(text[offset])) {
        offset += 1;
        continue;
      }
      if (text.startsWith('//', offset)) {
        const end = text.indexOf('\n', offset + 2);
        offset = end < 0 ? text.length : end + 1;
        continue;
      }
      if (text.startsWith('/*', offset)) {
        const end = text.indexOf('*/', offset + 2);
        if (end < 0) fail('unterminated block comment');
        offset = end + 2;
        continue;
      }
      break;
    }
  }

  function quoted() {
    skipTrivia();
    if (text[offset] !== '"') fail('expected a quoted string');
    offset += 1;
    let value = '';
    while (offset < text.length) {
      const char = text[offset++];
      if (char === '"') return value;
      if (char !== '\\') {
        value += char;
        continue;
      }
      if (offset >= text.length) fail('unterminated escape sequence');
      const escaped = text[offset++];
      const simple = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' };
      if (Object.prototype.hasOwnProperty.call(simple, escaped)) {
        value += simple[escaped];
        continue;
      }
      if (escaped === 'u' || escaped === 'U') {
        const hex = text.slice(offset, offset + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('invalid Unicode escape');
        value += String.fromCharCode(Number.parseInt(hex, 16));
        offset += 4;
        continue;
      }
      fail(`unsupported escape \\${escaped}`);
    }
    fail('unterminated quoted string');
  }

  skipTrivia();
  while (offset < text.length) {
    const key = quoted();
    skipTrivia();
    if (text[offset] !== '=') fail('expected = after key');
    offset += 1;
    const value = quoted();
    skipTrivia();
    if (text[offset] !== ';') fail('expected ; after value');
    offset += 1;
    if (Object.prototype.hasOwnProperty.call(values, key)) fail(`duplicate key ${key}`);
    values[key] = value;
    skipTrivia();
  }
  return values;
}

function verifyResourceContract(resourceRoot, contract) {
  requireDirectory(`${contract.kind} root`, resourceRoot);
  requireOnlyEntries(resourceRoot, [contract.id], `${contract.kind} payload`);
  const resourceDir = path.join(resourceRoot, contract.id);
  requireDirectory(`${contract.kind} ${contract.id}`, resourceDir);
  requireOnlyEntries(resourceDir, contract.files.map(item => item.name), `${contract.kind} file`);
  for (const item of contract.files) {
    requirePinnedFile(`${contract.kind} ${contract.id}/${item.name}`, path.join(resourceDir, item.name), item);
  }
  return `resource:${contract.kind}:${contract.id}`;
}

function verifyEmbeddingModelRoot(resourceRoot) {
  return verifyResourceContract(resourceRoot, EMBEDDING_MODEL_CONTRACT);
}

function verifyEmbeddingModelArchive(file) {
  requirePinnedFile('embedding-model archive', file, EMBEDDING_MODEL_CONTRACT.archive);
}

function verifyMacLocalizedMetadataRoot(root, options = {}) {
  requireDirectory('mac localized metadata root', root);
  if (!options.allowElectronResources) {
    requireOnlyEntries(
      root,
      MAC_LOCALIZED_METADATA_CONTRACT.map((item) => item.directory),
      'mac localized metadata locale',
    );
  }
  for (const item of MAC_LOCALIZED_METADATA_CONTRACT) {
    const localeDir = path.join(root, item.directory);
    requireDirectory(`mac localized metadata ${item.directory}`, localeDir);
    if (!options.allowElectronResources) {
      requireOnlyEntries(localeDir, ['InfoPlist.strings'], `mac localized metadata ${item.directory} file`);
    }
    const file = path.join(localeDir, 'InfoPlist.strings');
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      throw new Error(`[packaged-resource-gate] missing mac localized metadata file: ${file}`);
    }
    const actual = parseAppleStrings(text, `${item.directory}/InfoPlist.strings`);
    const actualKeys = Object.keys(actual).sort();
    const expectedKeys = Object.keys(item.values).sort();
    const matches = JSON.stringify(actualKeys) === JSON.stringify(expectedKeys)
      && expectedKeys.every((key) => actual[key] === item.values[key]);
    if (!matches) {
      throw new Error(
        `[packaged-resource-gate] mac localized metadata content mismatch: ${file}; expected ${JSON.stringify(item.values)}, got ${JSON.stringify(actual)}`,
      );
    }
  }
  return 'resource:mac-locales:v1';
}

function requiredMacLocalizedMetadataVerificationEntries() {
  return ['resource:mac-locales:v1'];
}

function requiredPackagedResourceVerificationEntries() {
  return [`resource:embedding-model:${EMBEDDING_MODEL_CONTRACT.id}`];
}

function verifyExtraResourcesConfig(extraResources) {
  if (!Array.isArray(extraResources)) {
    throw new Error('[packaged-resource-gate] build.extraResources must be an array');
  }
  const seen = new Set();
  for (const entry of extraResources) {
    const destination = entry && typeof entry === 'object' ? String(entry.to || '') : '';
    if (!destination) {
      throw new Error('[packaged-resource-gate] extraResources entry is missing its destination');
    }
    if (!Object.prototype.hasOwnProperty.call(EXTRA_RESOURCES_CONTRACT, destination)) {
      throw new Error(`[packaged-resource-gate] unregistered extraResources destination: ${destination}`);
    }
    if (seen.has(destination)) {
      throw new Error(`[packaged-resource-gate] duplicate extraResources destination: ${destination}`);
    }
    seen.add(destination);
  }
  for (const destination of Object.keys(EXTRA_RESOURCES_CONTRACT)) {
    if (!seen.has(destination)) {
      throw new Error(`[packaged-resource-gate] declared extraResources destination is not packaged: ${destination}`);
    }
  }
  const macLocales = extraResources.find((entry) => entry && entry.to === '.');
  if (String(macLocales.from || '').replace(/\\/g, '/') !== 'resources/mac-locales') {
    throw new Error(
      `[packaged-resource-gate] mac localized metadata source mismatch: ${macLocales.from || '(missing)'}`,
    );
  }
  const filters = Array.isArray(macLocales.filter) ? macLocales.filter.map(String) : [];
  if (JSON.stringify(filters) !== JSON.stringify(MAC_LOCALIZED_METADATA_FILTERS)) {
    throw new Error(
      `[packaged-resource-gate] mac localized metadata filters must exactly match: ${MAC_LOCALIZED_METADATA_FILTERS.join(', ')}`,
    );
  }
  return [...seen];
}

module.exports = {
  EMBEDDING_MODEL_CONTRACT,
  EXTRA_RESOURCES_CONTRACT,
  MAC_LOCALIZED_METADATA_CONTRACT,
  MAC_LOCALIZED_METADATA_FILTERS,
  parseAppleStrings,
  requiredMacLocalizedMetadataVerificationEntries,
  requiredPackagedResourceVerificationEntries,
  verifyExtraResourcesConfig,
  verifyEmbeddingModelArchive,
  verifyEmbeddingModelRoot,
  verifyMacLocalizedMetadataRoot,
  verifyResourceContract,
};
