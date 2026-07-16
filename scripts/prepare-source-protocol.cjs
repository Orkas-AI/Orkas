#!/usr/bin/env node
/**
 * Declare the connector callback protocol on the bundled Electron app used by macOS source runs.
 * Packaged apps receive the same declaration from package.json via electron-builder. No network
 * listener or local HTTP endpoint is created here.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.platform !== 'darwin') process.exit(0);

const root = path.resolve(__dirname, '..');
const appBundle = path.join(root, 'node_modules', 'electron', 'dist', 'Orkas.app');
const plist = path.join(appBundle, 'Contents', 'Info.plist');
const lsregister = '/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister';
const desired = {
  bundleId: 'com.orkas.desktop',
  name: 'Orkas',
  scheme: 'orkas',
};

if (!fs.existsSync(plist)) process.exit(0);

function read(key) {
  const result = spawnSync('plutil', ['-extract', key, 'raw', '-o', '-', plist], { encoding: 'utf8' });
  return result.status === 0 ? String(result.stdout || '').trim() : '';
}

function replaceString(key, value) {
  const result = spawnSync('plutil', ['-replace', key, '-string', value, plist], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`failed to set ${key}: ${String(result.stderr || '').trim()}`);
}

const currentScheme = read('CFBundleURLTypes.0.CFBundleURLSchemes.0');
const needsPatch = read('CFBundleIdentifier') !== desired.bundleId
  || read('CFBundleName') !== desired.name
  || read('CFBundleDisplayName') !== desired.name
  || currentScheme !== desired.scheme;

try {
  if (needsPatch) {
    replaceString('CFBundleIdentifier', desired.bundleId);
    replaceString('CFBundleName', desired.name);
    replaceString('CFBundleDisplayName', desired.name);
    spawnSync('plutil', ['-remove', 'CFBundleURLTypes', plist], { stdio: 'ignore' });
    const urlTypes = JSON.stringify([{
      CFBundleURLName: 'ai.orkas.connectors',
      CFBundleURLSchemes: [desired.scheme],
    }]);
    const inserted = spawnSync('plutil', ['-insert', 'CFBundleURLTypes', '-json', urlTypes, plist], {
      encoding: 'utf8',
    });
    if (inserted.status !== 0) {
      throw new Error(`failed to declare ${desired.scheme}://: ${String(inserted.stderr || '').trim()}`);
    }
    const signed = spawnSync('codesign', ['--force', '--deep', '--sign', '-', appBundle], { encoding: 'utf8' });
    if (signed.status !== 0) {
      throw new Error(`ad-hoc signing failed: ${String(signed.stderr || '').trim()}`);
    }
  }
  if (fs.existsSync(lsregister)) spawnSync(lsregister, ['-f', appBundle], { stdio: 'ignore' });
  console.log(`[Orkas] connector callback protocol ready (${desired.scheme}://)`);
} catch (err) {
  console.warn(`[Orkas] connector callback protocol setup skipped: ${err && err.message || err}`);
}
