import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const DEFAULT_NO_PROXY = ['localhost', '127.0.0.1', '::1', '*.local'];
const require = createRequire(import.meta.url);

function proxyUrl(host, port) {
  const cleanHost = String(host || '').trim();
  const cleanPort = String(port || '').trim();
  if (!cleanHost || !/^\d+$/.test(cleanPort)) return undefined;
  const formattedHost = cleanHost.includes(':') && !cleanHost.startsWith('[')
    ? `[${cleanHost}]`
    : cleanHost;
  return `http://${formattedHost}:${cleanPort}`;
}

/**
 * Parse the static HTTP(S) portion of `scutil --proxy`.
 * PAC remains an Electron-app concern; local CLI acceptance's Node process only adopts
 * concrete system proxy endpoints.
 */
export function parseMacOSSystemProxy(output) {
  const values = new Map();
  const exceptions = [];
  let inExceptions = false;
  for (const line of String(output || '').split(/\r?\n/)) {
    if (/^\s*ExceptionsList\s*:\s*<array>\s*\{\s*$/.test(line)) {
      inExceptions = true;
      continue;
    }
    if (inExceptions) {
      if (/^\s*}\s*$/.test(line)) {
        inExceptions = false;
        continue;
      }
      const entry = /^\s*\d+\s*:\s*(.+?)\s*$/.exec(line)?.[1];
      if (entry && entry !== '<local>') exceptions.push(entry);
      continue;
    }
    const scalar = /^\s*([A-Za-z][A-Za-z0-9]*)\s*:\s*(.*?)\s*$/.exec(line);
    if (scalar) values.set(scalar[1], scalar[2]);
  }

  const httpProxy = values.get('HTTPEnable') === '1'
    ? proxyUrl(values.get('HTTPProxy'), values.get('HTTPPort'))
    : undefined;
  const httpsProxy = values.get('HTTPSEnable') === '1'
    ? proxyUrl(values.get('HTTPSProxy'), values.get('HTTPSPort'))
    : undefined;
  return {
    httpProxy,
    httpsProxy,
    noProxy: [...new Set([...exceptions, ...DEFAULT_NO_PROXY])].join(','),
  };
}

function explicitProxy(env) {
  const httpProxy = env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy;
  const httpsProxy = env.HTTPS_PROXY || env.https_proxy || httpProxy;
  return {
    httpProxy,
    httpsProxy,
    noProxy: env.NO_PROXY || env.no_proxy || DEFAULT_NO_PROXY.join(','),
  };
}

function readMacOSSystemProxy() {
  try {
    return execFileSync('/usr/sbin/scutil', ['--proxy'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return '';
  }
}

/**
 * Build the environment consumed by bin/proxy-bootstrap.cjs.
 * Explicit launch environment always wins; otherwise macOS static system
 * proxy settings are inherited by the opt-in local CLI acceptance child.
 */
export function localAgentChildEnv(
  baseEnv = process.env,
  {
    platform = process.platform,
    scutilOutput,
  } = {},
) {
  // Acceptance uses the selected runtime without persisted adaptive state.
  const env = { ...baseEnv, ORKAS_METACOGNITION: '0' };
  if (env.ORKAS_PROXY_MODE) return env;

  let config = explicitProxy(env);
  if (!config.httpProxy && !config.httpsProxy && platform === 'darwin') {
    config = parseMacOSSystemProxy(
      scutilOutput === undefined ? readMacOSSystemProxy() : scutilOutput,
    );
  }
  if (!config.httpProxy && !config.httpsProxy) return env;

  return {
    ...env,
    ...(config.httpProxy ? { HTTP_PROXY: config.httpProxy } : {}),
    ...(config.httpsProxy ? { HTTPS_PROXY: config.httpsProxy } : {}),
    NO_PROXY: config.noProxy,
    ORKAS_PROXY_MODE: 'env',
    ...(config.httpProxy ? { ORKAS_PROXY_HTTP_URL: config.httpProxy } : {}),
    ...(config.httpsProxy ? { ORKAS_PROXY_HTTPS_URL: config.httpsProxy } : {}),
    ORKAS_PROXY_NO_PROXY: config.noProxy,
  };
}

/**
 * Reinstall the dispatcher after tsx has initialized. tsx loads its own
 * undici stack and can replace a dispatcher installed with Node --require,
 * so the live runner must call this after its runtime imports settle.
 */
export function installLocalAgentProxyRuntime(options = {}) {
  const resolved = localAgentChildEnv(process.env, options);
  for (const [key, value] of Object.entries(resolved)) {
    if (value !== undefined) process.env[key] = value;
  }
  if (!resolved.ORKAS_PROXY_MODE) return false;
  const { installChildProxy } = require('../bin/proxy-bootstrap.cjs');
  return installChildProxy();
}
