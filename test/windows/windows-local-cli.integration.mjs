#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  console.log('[windows-local-cli] skipped: Windows-only official CLI canary');
  process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const pcRoot = path.resolve(here, '..', '..');
const require = createRequire(import.meta.url);
const authHelper = path.join(pcRoot, 'bin', 'local-cli-auth.cjs');
const { MANIFESTS } = require(authHelper);
const EXPECTED_PROVIDERS = Object.freeze(['wecom', 'lark', 'dingtalk', 'xero']);
const PROVIDER_LABELS = Object.freeze({
  wecom: 'WeCom',
  lark: 'Feishu/Lark',
  dingtalk: 'DingTalk',
  xero: 'Xero',
});

function requireCondition(condition, message) {
  if (!condition) throw Object.assign(new Error(message), { publicCanaryMessage: true });
}

function bundledNpxCli(nodeExecutable) {
  const candidate = path.join(path.dirname(nodeExecutable), 'node_modules', 'npm', 'bin', 'npx-cli.js');
  requireCondition(fs.existsSync(candidate), 'the Windows Node runtime does not contain npm/bin/npx-cli.js');
  requireCondition(fs.existsSync(path.join(path.dirname(candidate), 'npm-cli.js')),
    'the Windows Node runtime does not contain npm/bin/npm-cli.js');
  return candidate;
}

function sanitizedEnvironment(runtimeDir, provider, manifest, npxCli) {
  const home = path.join(runtimeDir, 'isolated home');
  const appData = path.join(home, 'AppData', 'Roaming');
  const localAppData = path.join(home, 'AppData', 'Local');
  const workDir = path.join(runtimeDir, 'work');
  const npmCache = path.join(runtimeDir, 'npm-cache');
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(localAppData, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });

  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|AUTHORIZATION)/i.test(key)) delete env[key];
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    ORKAS_NODE: process.execPath,
    ORKAS_LOCAL_CLI_PROVIDER: provider,
    ORKAS_LOCAL_CLI_BRAND: provider === 'lark' ? 'feishu' : '',
    ORKAS_LOCAL_CLI_PACKAGE: manifest.package,
    ORKAS_LOCAL_CLI_PACKAGE_INTEGRITY: manifest.integrity,
    ORKAS_LOCAL_CLI_EXECUTABLE: manifest.executable,
    ORKAS_LOCAL_CLI_ALLOWED_DOMAINS_JSON: JSON.stringify(manifest.domains),
    ORKAS_LOCAL_CLI_NPX_CLI: npxCli,
    ORKAS_LOCAL_CLI_RUNTIME_DIR: runtimeDir,
    ORKAS_LOCAL_CLI_WORK_DIR: workDir,
    ORKAS_LOCAL_CLI_INTEGRITY_MARKER: path.join(runtimeDir, '.orkas-cli-integrity.json'),
    ORKAS_LOCAL_CLI_PROFILE: `orkas-windows-${provider}`,
    ORKAS_LOCAL_CLI_INSTALL_ONLY: '1',
    WECOM_CLI_CONFIG_DIR: runtimeDir,
    WECOM_CLI_TMP_DIR: path.join(runtimeDir, 'tmp'),
    WECOM_CLI_LOG_DIR: path.join(runtimeDir, 'logs'),
    LARKSUITE_CLI_CONFIG_DIR: runtimeDir,
    DWS_CONFIG_DIR: runtimeDir,
    DWS_AGENT_PRODUCT: 'Orkas',
    DWS_AUDIT: '1',
    DWS_RUNTIME_CONTENT_SCAN: '1',
    DWS_RUNTIME_CONTENT_SCAN_ENFORCE: '1',
    NO_UPDATE_NOTIFIER: '1',
    NPM_CONFIG_CACHE: npmCache,
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_LOGLEVEL: 'error',
    NPM_CONFIG_USERCONFIG: path.join(home, '.npmrc'),
    npm_config_cache: npmCache,
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    npm_config_loglevel: 'error',
    npm_config_userconfig: path.join(home, '.npmrc'),
  };
}

function installedPackage(runtimeDir, manifest) {
  const npxRoot = path.join(runtimeDir, 'npm-cache', '_npx');
  let installs = [];
  try { installs = fs.readdirSync(npxRoot, { withFileTypes: true }); }
  catch { return null; }
  for (const install of installs) {
    if (!install.isDirectory()) continue;
    const installRoot = path.join(npxRoot, install.name);
    const packageDir = path.join(installRoot, 'node_modules', ...manifest.package
      .replace(/@[^@]+$/, '')
      .split('/'));
    let packageJson;
    try { packageJson = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')); }
    catch { continue; }
    const expectedVersion = manifest.package.slice(manifest.package.lastIndexOf('@') + 1);
    if (packageJson.name !== manifest.package.replace(/@[^@]+$/, '') || packageJson.version !== expectedVersion) continue;
    const relativeBin = typeof packageJson.bin === 'string'
      ? packageJson.bin
      : packageJson.bin?.[manifest.executable];
    if (typeof relativeBin !== 'string') continue;
    const bin = path.resolve(packageDir, relativeBin);
    const relative = path.relative(packageDir, bin);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(bin)) continue;
    return { installRoot, packageDir };
  }
  return null;
}

function runProviderCanary(parent, provider, manifest, npxCli) {
  const runtimeDir = path.join(parent, `${provider} CLI 路径`);
  fs.mkdirSync(runtimeDir, { recursive: true });
  const env = sanitizedEnvironment(runtimeDir, provider, manifest, npxCli);
  const result = spawnSync(process.execPath, [authHelper], {
    cwd: env.ORKAS_LOCAL_CLI_WORK_DIR,
    env,
    encoding: 'utf8',
    timeout: 5 * 60_000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });

  requireCondition(!result.error,
    `${PROVIDER_LABELS[provider]} install/start process failed (${result.error?.code || 'unknown'})`);
  requireCondition(result.status === 0,
    `${PROVIDER_LABELS[provider]} install/start exited ${result.status}; captured stdout=${result.stdout.length}, stderr=${result.stderr.length}`);
  requireCondition(result.stderr.trim() === '',
    `${PROVIDER_LABELS[provider]} install/start emitted ${result.stderr.length} bytes of unclassified stderr`);
  const normalizedHelp = result.stdout.replace(/\x1b\[[0-9;]*m/g, '').trim();
  requireCondition(normalizedHelp.length > 0 && /(?:usage|commands?|options?|help)/i.test(normalizedHelp),
    `${PROVIDER_LABELS[provider]} did not return recognizable CLI help`);

  const marker = JSON.parse(fs.readFileSync(env.ORKAS_LOCAL_CLI_INTEGRITY_MARKER, 'utf8'));
  requireCondition(
    JSON.stringify(marker) === JSON.stringify({ package: manifest.package, integrity: manifest.integrity }),
    `${PROVIDER_LABELS[provider]} wrote an invalid integrity marker`,
  );
  const installed = installedPackage(runtimeDir, manifest);
  requireCondition(installed, `${PROVIDER_LABELS[provider]} exact package executable was not retained in the isolated npx cache`);

  if (provider === 'wecom' && process.arch === 'x64') {
    const platformPackage = path.join(
      installed.installRoot, 'node_modules', '@wecom', 'cli-win32-x64', 'package.json',
    );
    requireCondition(fs.existsSync(platformPackage), 'WeCom Windows x64 native package was not installed');
    const platformMetadata = JSON.parse(fs.readFileSync(platformPackage, 'utf8'));
    requireCondition(platformMetadata.version === '1.2.0', 'WeCom Windows x64 native package version changed');
  }

  // Immediate removal is the native lock/handle oracle: the connector cannot be
  // safely disconnected or reinstalled if npm/provider descendants retain files.
  fs.rmSync(runtimeDir, { recursive: true, force: true });
  requireCondition(!fs.existsSync(runtimeDir), `${PROVIDER_LABELS[provider]} runtime remained locked after CLI exit`);
  console.log(`[windows-local-cli] ${PROVIDER_LABELS[provider]} PASS`);
}

function main() {
  requireCondition(
    JSON.stringify(Object.keys(MANIFESTS)) === JSON.stringify(EXPECTED_PROVIDERS),
    'the Windows canary inventory must be reviewed when a local CLI provider changes',
  );
  requireCondition(process.arch === 'x64', `unsupported Windows canary architecture: ${process.arch}`);
  const npxCli = bundledNpxCli(process.execPath);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas Windows CLI 测试-'));
  try {
    for (const provider of EXPECTED_PROVIDERS) {
      runProviderCanary(tempRoot, provider, MANIFESTS[provider], npxCli);
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  console.log(`[windows-local-cli] PASS providers=${EXPECTED_PROVIDERS.length}; architecture=${process.arch}`);
}

try {
  main();
} catch (error) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  const message = error instanceof Error && error.publicCanaryMessage === true
    ? error.message
    : `native canary failed${code ? ` (${code})` : ''}`;
  console.error(`[windows-local-cli] FAIL: ${message}`);
  process.exit(1);
}
