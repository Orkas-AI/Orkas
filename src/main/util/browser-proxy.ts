import type { ProxyConfig, Session, WebContents } from 'electron';
import { createLogger } from '../logger';
import { envProxyConfig } from './proxy-dispatcher';

const log = createLogger('browser-proxy');
type Credentials = { username: string; password: string };

/** Translate launch environment policy without changing Chromium's system/PAC defaults. */
export function browserProxyConfig(env: NodeJS.ProcessEnv): {
  config?: ProxyConfig;
  credentials: Map<string, Credentials>;
} {
  const policy = envProxyConfig(env);
  const credentials = new Map<string, Credentials>();
  if (!policy.httpProxy && !policy.httpsProxy) return { credentials };
  const endpoint = (raw: string | undefined): string => {
    if (!raw) return 'direct://'; // An explicit HTTPS-only policy leaves HTTP direct.
    const url = new URL(raw);
    const scheme = url.protocol === 'socks5h:' ? 'socks5:' : url.protocol;
    if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(scheme)
        || !/^(?:[a-z\d._-]+|\[[a-f\d:]+\])$/iu.test(url.hostname)
        || (url.pathname && url.pathname !== '/') || url.search || url.hash) {
      throw new Error('Unsupported browser proxy configuration');
    }
    if (url.username || url.password) {
      // Chromium does not support authenticated SOCKS proxies. Never strip their credentials and continue.
      if (scheme.startsWith('socks')) throw new Error('Authenticated SOCKS is unavailable');
      const key = `${url.hostname}:${url.port || (scheme === 'https:' ? '443' : '80')}`;
      const value = { username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
      const previous = credentials.get(key);
      if (previous && (previous.username !== value.username || previous.password !== value.password)) {
        throw new Error('Conflicting browser proxy credentials');
      }
      credentials.set(key, value);
    }
    return `${scheme}//${url.host}`;
  };
  const http = endpoint(policy.httpProxy);
  const https = endpoint(policy.httpsProxy);
  const bypass: string[] = [];
  for (const token of policy.noProxy.split(/[\s,]+/u).filter(Boolean)) {
    if (token === '*') {
      bypass.push('*');
      continue;
    }
    // NO_PROXY bare domains cover both the host and its subdomains. Chromium bare hosts do not.
    const match = /^(\[[\da-f:]+\]|::1|(?:\*?\.)?[\w.-]+)(:\d+)?$/iu.exec(token);
    if (!match) throw new Error('Unsupported browser proxy bypass rule');
    const host = match[1].replace(/^\*?\./u, '').toLowerCase();
    const port = match[2] || '';
    if (port && (Number(port.slice(1)) < 1 || Number(port.slice(1)) > 65535)) {
      throw new Error('Invalid browser proxy bypass port');
    }
    if (host.includes(':')) bypass.push(`${host.startsWith('[') ? host : `[${host}]`}${port}`);
    else {
      bypass.push(`${host}${port}`);
      if (!/^[\d.]+$/u.test(host)) bypass.push(`.${host}${port}`);
    }
  }
  return {
    config: { mode: 'fixed_servers', proxyRules: `http=${http};https=${https}`, proxyBypassRules: bypass.join(',') },
    credentials,
  };
}

/** All requests must wait for ready; a rejected or stalled setup must never release them directly. */
export function prepareBrowserProxy(ses: Pick<Session, 'setProxy'>, env: NodeJS.ProcessEnv = process.env): {
  ready?: Promise<boolean>;
  attach: (contents: WebContents) => void;
} {
  try {
    const { config, credentials } = browserProxyConfig(env);
    if (!config) return { attach: () => {} };
    let timer: ReturnType<typeof setTimeout>;
    const ready = Promise.race([
      ses.setProxy(config).then(() => true),
      new Promise<boolean>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Browser proxy setup timed out')), 60_000);
      }),
    ]).catch(() => {
      log.warn('browser proxy setup failed; browser requests remain blocked');
      return false;
    }).finally(() => clearTimeout(timer!));
    return {
      ready,
      attach(contents) {
        if (!credentials.size) return;
        contents.on('login', (event, details, auth, callback) => {
          if (!auth.isProxy) return;
          const host = auth.host.includes(':') && !auth.host.startsWith('[') ? `[${auth.host}]` : auth.host;
          const value = credentials.get(`${host.toLowerCase()}:${auth.port}`);
          if (!value) return;
          event.preventDefault();
          if (details.firstAuthAttempt) callback(value.username, value.password);
          else callback(); // Bad credentials must not produce an endless login loop.
        });
      },
    };
  } catch {
    // Never include an environment URL or upstream error: it may contain credentials.
    log.warn('browser proxy configuration is invalid; browser requests remain blocked');
    return { ready: Promise.resolve(false), attach: () => {} };
  }
}
