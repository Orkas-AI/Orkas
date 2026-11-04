#!/usr/bin/env node
/** Explicit opt-in: register ONLY a unique disposable app, then remove its item.
 * No windows, accounts, reboot/logout, production identity, or signing credentials.
 * An approval-required result fails enable verification instead of passing it.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const pcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
if (!['darwin', 'win32'].includes(process.platform)) throw new Error('A macOS or Windows desktop host is required');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-startup-native-'));
const identity = `org.orkas.startup-test.${randomUUID()}`;
const reportDir = path.resolve(pcRoot, '../tmp/startup-native', identity);
fs.mkdirSync(reportDir, { recursive: true });
const report = { identity, platform: process.platform, root, results: [], phases: [], checks: [], cleanup: false, passed: false };
let executable, prepared = false;
function command(bin, args, env = process.env) {
  const run = spawnSync(bin, args, { env, encoding: 'utf8', timeout: 45_000, windowsHide: true });
  report.results.push({ command: path.basename(bin), args, status: run.status, signal: run.signal,
    stdout: run.stdout || '', stderr: run.stderr || '', error: run.error?.message });
  if (run.error || run.status !== 0) throw new Error(`${path.basename(bin)} failed (${run.status}): ${run.error?.message || run.stderr}`);
  return run.stdout;
}
function check(name, run) { run(); report.checks.push(name); }
function phase(name) {
  const env = { ...process.env, ORKAS_STARTUP_NATIVE_PHASE: name };
  // Windows Electron treats an empty value as Node mode too.
  delete env.ELECTRON_RUN_AS_NODE;
  const file = path.join(root, `${name}.json`);
  fs.rmSync(file, { force: true });
  let value;
  try { command(executable, [], env); }
  finally {
    if (fs.existsSync(file)) {
      value = JSON.parse(fs.readFileSync(file, 'utf8'));
      report.phases.push(value); report[name] = value;
    }
  }
  assert.ok(value, `Missing native ${name} receipt`);
  assert.equal(value.packaged, true); assert.equal(value.windows, 0); assert.equal(value.error, undefined);
  return value;
}
try {
  const electron = require('electron');
  let resources;
  if (process.platform === 'darwin') {
    const source = path.resolve(electron, '../../..');
    const bundle = path.join(root, 'Startup Verification.app');
    command('/usr/bin/ditto', [source, bundle]);
    const plist = path.join(bundle, 'Contents/Info.plist');
    for (const [key, value] of [['CFBundleIdentifier', identity], ['CFBundleName', identity], ['CFBundleDisplayName', 'Startup Verification'], ['CFBundleExecutable', 'StartupVerification']]) {
      command('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
    }
    command('/usr/libexec/PlistBuddy', ['-c', 'Add :LSUIElement bool true', plist]);
    executable = path.join(bundle, 'Contents/MacOS/StartupVerification');
    fs.renameSync(path.join(bundle, 'Contents/MacOS', path.basename(electron)), executable);
    resources = path.join(bundle, 'Contents/Resources');
  } else {
    const target = path.join(root, 'Startup Verification application');
    fs.cpSync(path.dirname(electron), target, { recursive: true });
    executable = path.join(target, 'StartupVerification.exe');
    fs.renameSync(path.join(target, path.basename(electron)), executable);
    resources = path.join(target, 'resources');
  }
  for (const name of ['app', 'app.asar', 'default_app.asar']) fs.rmSync(path.join(resources, name), { recursive: true, force: true });
  const appRoot = path.join(resources, 'app'); fs.mkdirSync(appRoot);
  fs.copyFileSync(path.join(pcRoot, 'test/gui/startup-native-main.cjs'), path.join(appRoot, 'main.cjs'));
  fs.writeFileSync(path.join(appRoot, 'package.json'), JSON.stringify({ name: identity, version: '1.0.0', main: 'main.cjs' }));
  fs.writeFileSync(path.join(appRoot, 'fixture.json'), JSON.stringify({ root, pcRoot, identity }));
  if (process.platform === 'darwin') command('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', path.resolve(executable, '../../..')]);
  prepared = true;
  check('fresh packaged identity defaults off without consent', () => {
    const initial = phase('read'); assert.equal(initial.state.enabled, false); assert.equal(initial.native.openAtLogin, false);
  });
  const enabled = phase('enable');
  check('explicit enable is effectively enabled in the real OS', () => {
    assert.equal(enabled.state.status, 'enabled', 'OS approval is pending or registration failed; enabling is NOT verified');
    assert.equal(enabled.native.openAtLogin, true);
    if (process.platform === 'darwin') assert.equal(enabled.native.status, 'enabled');
    else {
      assert.equal(enabled.native.executableWillLaunchAtLogin, true);
      const matching = enabled.native.launchItems.filter(item => item.name === identity);
      assert.equal(matching.length, 1); assert.equal(matching[0].enabled, true);
      assert.equal(matching[0].path.toLowerCase(), executable.toLowerCase());
      // Chromium's launchItems.args omits switches. Read the exact test-owned
      // registry command independently to prove the startup argument survives.
      const script = `$ErrorActionPreference='Stop'; $key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Run'); try { [Console]::Write($key.GetValue('${identity}')) } finally { $key.Dispose() }`;
      const registry = command('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]);
      assert.equal(registry.trim(), `"${executable}" --orkas-startup`);
    }
  });
  check('enabled registration survives a fresh application process', () => assert.equal(phase('read').state.enabled, true));
  check('startup registration never writes a local enabled flag or changes background preferences', () => assert.equal(fs.existsSync(path.join(root, 'data/device.json')), false));
} catch (error) { report.failure = error.stack || String(error); }
finally {
  // Run separately even when enable/read assertions failed. Keep the bundle if
  // cleanup cannot be verified, so an orphan never points at a deleted executable.
  if (prepared) {
    try {
      assert.equal(phase('disable').state.enabled, false);
      const disabled = phase('read');
      assert.equal(disabled.native.openAtLogin, false);
      if (process.platform === 'darwin') assert.equal(disabled.native.status, 'not-registered');
      else {
        // Read only this disposable identity; never print other startup items.
        const script = `$ErrorActionPreference='Stop'; $key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Run'); try { if ($null -eq $key) { 'absent' } elseif ($key.GetValueNames() -contains '${identity}') { 'present' } else { 'absent' } } finally { if ($null -ne $key) { $key.Dispose() } }`;
        assert.equal(command('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]).trim(), 'absent');
      }
      report.cleanup = true;
      report.checks.push('disable removes registration and remains off in a fresh process');
    } catch (error) { report.cleanupFailure = error.stack || String(error); }
  }
  report.passed = !report.failure && report.cleanup;
  const unexpected = report.results.filter(result => {
    const expectedSignature = result.command === 'codesign' && result.stderr.trim() === `${result.args.at(-1)}: replacing existing signature`;
    const expectedRegistry = ['reg.exe', 'powershell.exe'].includes(result.command) && result.status === 0;
    return (result.stderr.trim() && !expectedSignature) || (result.stdout.trim() && !expectedRegistry);
  });
  report.logAnalysis = { commands: report.results.length, unexpected: unexpected.length,
    note: 'codesign replacement notices and the test-owned registry query are expected; all Electron output is reviewed as unexpected' };
  if (unexpected.length) { report.passed = false; report.logFailure = 'Unexpected native command output; inspect retained receipts'; }
  fs.writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify(report, null, 2));
  if (report.cleanup) fs.rmSync(root, { recursive: true, force: true });
  console.log(`[startup-native] ${report.passed ? 'PASS' : 'FAIL'} checks=${report.checks.length} cleanup=${report.cleanup} report=${path.join(reportDir, 'report.json')}`);
  if (report.failure) console.error(report.failure);
  if (report.cleanupFailure) console.error(report.cleanupFailure);
  if (report.logFailure) console.error(report.logFailure);
}
process.exitCode = report.passed ? 0 : 1;
