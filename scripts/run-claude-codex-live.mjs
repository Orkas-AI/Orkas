/** Scoped wrapper around the existing Electron/registry/runner acceptance entry. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createClaudeCodexGateway, CLAUDE_CODEX_TEST_MODEL } from './local-agent-claude-codex-gateway.mjs';

const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;

export function createClaudeCodexIsolation({ root, cliPath, gateway, env }) {
  if (!path.isAbsolute(root) || !path.isAbsolute(cliPath) || process.platform === 'win32') {
    throw new Error('Claude/Codex isolated acceptance currently requires an absolute POSIX CLI path');
  }
  const isolated = {};
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) {
    if (env[key] !== undefined) isolated[key] = env[key];
  }
  for (const name of ['home', 'claude', 'codex', 'config', 'cache', 'state', 'tmp', 'data']) fs.mkdirSync(path.join(root, name), { recursive: true, mode: 0o700 });
  const wrapper = path.join(root, 'claude-isolated');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${shellQuote(cliPath)} --setting-sources '' --strict-mcp-config "$@"\n`, { mode: 0o700 });
  Object.assign(isolated, { HOME: path.join(root, 'home'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex'),
    XDG_CONFIG_HOME: path.join(root, 'config'), XDG_CACHE_HOME: path.join(root, 'cache'), XDG_STATE_HOME: path.join(root, 'state'),
    XDG_DATA_HOME: path.join(root, 'data'), TMPDIR: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'), TEMP: path.join(root, 'tmp'),
    ORKAS_WORKSPACE_ROOT: path.join(root, 'data'), ORKAS_CLAUDE_PATH: wrapper,
    ORKAS_LOCAL_AGENT_TEST_INSTALL_ROOT: path.join(root, 'unused-installs'),
    ANTHROPIC_BASE_URL: gateway.url, ANTHROPIC_AUTH_TOKEN: gateway.token,
    EVAL_CLAUDE_MODEL: CLAUDE_CODEX_TEST_MODEL, DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ENABLE_TOOL_SEARCH: 'false',
  });
  return { env: isolated };
}

function credential(env) {
  const auth = path.join(env.CODEX_HOME || path.join(env.HOME || os.homedir(), '.codex'), 'auth.json');
  let token;
  try { token = JSON.parse(fs.readFileSync(auth, 'utf8')).tokens?.access_token; } catch { /* No alternate credential route. */ }
  if (typeof token !== 'string' || !token.trim()) throw new Error('Existing Codex login is required; no API-key or paid fallback is permitted');
  return token;
}

function fingerprints(env, cliPath) {
  const home = env.HOME || os.homedir(); const config = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const files = [cliPath, path.join(home, '.claude.json'), path.join(config, 'settings.json'), path.join(config, 'settings.local.json'),
    path.join(config, '.credentials.json'), path.join(env.CODEX_HOME || path.join(home, '.codex'), 'auth.json'),
    path.join(env.CODEX_HOME || path.join(home, '.codex'), 'config.toml')];
  return files.map((file, index) => {
    try {
      if (index === 0) { const stat = fs.statSync(file); return JSON.stringify([fs.realpathSync(file), stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode]); }
      if (fs.statSync(file).size > 1024 * 1024) throw new Error('Protected configuration exceeds snapshot limit');
      return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    }
    catch (error) { if (error.code === 'ENOENT') return 'absent'; throw new Error('Cannot fingerprint protected CLI configuration'); }
  });
}

export async function runClaudeCodexLive(argv, { env = process.env, loadCredential = credential,
  startGateway = createClaudeCodexGateway, launchLive, writeReport } = {}) {
  const args = []; let mcp = false;
  for (let at = 0; at < argv.length; at++) {
    const arg = argv[at];
    if (arg === '--agents') { if (argv[++at] !== 'claude') throw new Error('Isolated Codex route permits only Claude CLI'); }
    else if (arg === '--no-install') continue;
    else if (arg === '--mcp') mcp = true;
    else if (arg === '--lifecycle') args.push(arg);
    else if (arg === '--lifecycle-fault' && ['cancel', 'wall'].includes(argv[at + 1])) args.push(arg, argv[++at]);
    else throw new Error('Isolated Codex route supports only smoke and lifecycle acceptance');
  }
  if (mcp && args.length) throw new Error('Select MCP or lifecycle acceptance separately');
  if (args.includes('--lifecycle-fault') && !args.includes('--lifecycle')) throw new Error('Lifecycle fault requires lifecycle acceptance');
  if (mcp) args.push('--benchmark', '--scenario', 'local-agent-open-skill-read', '--k', '1');
  const cliPath = env.ORKAS_CLAUDE_PATH;
  let executableExists = false;
  try { executableExists = !!cliPath && path.isAbsolute(cliPath) && fs.statSync(cliPath).isFile(); } catch { /* Keep private paths out of failure output. */ }
  if (!executableExists || process.platform === 'win32') throw new Error('Set ORKAS_CLAUDE_PATH to an existing POSIX Claude executable');
  const before = fingerprints(env, cliPath);
  const apiKey = loadCredential(env);
  // A nested macOS TMPDIR can exceed Unix-domain socket limits before the
  // per-run MCP bridge even starts. Keep this test-owned temporary root short.
  const root = fs.mkdtempSync('/tmp/orkas-cc-');
  let gateway, outcome = 1, unchanged = false;
  const startedAt = new Date().toISOString();
  try {
    if (startGateway === createClaudeCodexGateway) {
      const { installLocalAgentProxyRuntime } = await import('./local-agent-live-proxy-env.mjs');
      installLocalAgentProxyRuntime();
    }
    gateway = await startGateway({ apiKey, requestBudget: 24, requestTimeoutMs: 120_000 });
    const isolated = createClaudeCodexIsolation({ root, cliPath, gateway, env });
    const launch = launchLive ?? (await import('./run-local-agents-live.mjs')).runLocalAgentLive;
    outcome = await launch(['--agents', 'claude', '--no-install', ...args], { env: isolated.env });
  } finally {
    let gatewayClosed = false, cleanupComplete = false;
    try { await gateway?.close(); gatewayClosed = !!gateway; } catch { /* Retain a failed cleanup result. */ }
    try { await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); cleanupComplete = true; }
    catch { /* Do not claim acceptance or expose a raw cleanup path. */ }
    try {
      unchanged = JSON.stringify(before) === JSON.stringify(fingerprints(env, cliPath));
    } catch { /* An unreadable protected file cannot establish isolation. */ }
    const report = { kind: 'claude-codex-isolation', startedAt, finishedAt: new Date().toISOString(), platform: process.platform,
      scenario: mcp ? 'mcp' : args.includes('--lifecycle') ? (args.includes('wall') ? 'wall' : 'cancel') : 'smoke',
      protectedConfigurationUnchanged: unchanged, gatewayClosed, cleanupComplete, model: CLAUDE_CODEX_TEST_MODEL, requestBudget: 24,
      gateway: gateway?.stats ?? null, runnerExitCode: outcome,
      passed: outcome === 0 && unchanged && gatewayClosed && cleanupComplete && !!gateway && gateway.stats.requests > 0
        && gateway.stats.failed === 0 && gateway.stats.rejected === 0 && gateway.stats.active === 0 };
    if (writeReport) writeReport(report);
    else {
      const directory = fileURLToPath(new URL('../test-results/local-agents/', import.meta.url));
      fs.mkdirSync(directory, { recursive: true });
      const name = `claude-codex-isolation-${startedAt.replaceAll(':', '-').replaceAll('.', '-')}-${process.pid}.json`;
      fs.writeFileSync(path.join(directory, name), JSON.stringify(report, null, 2) + '\n');
      process.stdout.write(`[claude-codex-live] report=test-results/local-agents/${name}\n`);
    }
    if (!report.passed) outcome = 1;
  }
  return outcome;
}
