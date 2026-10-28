/** Shared resource contract for installed apps and isolated HTML previews. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SRC_ROOT } from '../../paths';
import * as artifacts from '../chat_artifacts';
import { commonMethod } from './data-contract';
import { METHODS, SDK_PATH, catalogDocument } from './catalog';
import { webContentCsp } from '../../util/web-content-policy';
import type { WebAppRuntime } from './runtime';

const scripts = new Map<string,string>();
export function sdkScript(appType: 'local'|'web'='local') {
  if(!scripts.has(appType)){
    const methods=Object.keys(METHODS).filter(method=>appType!=='web'||commonMethod(method));
    const common=Object.keys(METHODS).filter(commonMethod);
    scripts.set(appType,fs.readFileSync(path.join(SRC_ROOT,'main/features/web_apps/sdk.js'),'utf8')
      .replace('/* HOST_METHOD_NAMES */ []',JSON.stringify(methods)).replaceAll('/* COMMON_METHOD_NAMES */ []',JSON.stringify(common)));
  }
  return scripts.get(appType)!;
}
export const APP_CSP = webContentCsp();
export async function appResource(request: Request, runtime: WebAppRuntime) {
  const url = new URL(request.url);
  if (!/^(?:app-[a-f0-9]{32}|a-[a-f0-9]{20})$/.test(url.host)) return null;
  let rel: string;
  try { rel = url.pathname.slice(1).split('/').map(decodeURIComponent).join('/'); } catch { return { status: 400 }; }
  const scoped = await runtime.resource(url.host, rel, request.headers.get('Origin'));
  if (!scoped) return { status: 403 };
  const headers: Record<string, string> = { 'Cache-Control': 'no-store',
    'Cross-Origin-Resource-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff' };
  if (!scoped.bundle.browserOnly) headers['Content-Security-Policy'] = APP_CSP;
  if (scoped.bundle.browserOnly && (rel === SDK_PATH || rel === '__orkas/capabilities.json')) return { status: 403 };
  const capabilityType = scoped.bundle.appType === 'local' ? 'local' : 'web';
  if (rel === SDK_PATH) return { status: 200, body: sdkScript(capabilityType), mime: 'text/javascript; charset=utf-8', headers };
  if (rel === artifacts.BRIDGE_RELPATH) return capabilityType==='web'?{status:403}:{ status: 200, body: artifacts.BRIDGE_JS, mime: 'text/javascript; charset=utf-8', headers };
  if (rel === '__orkas/capabilities.json') return { status: 200, body: JSON.stringify(catalogDocument(capabilityType)), mime: 'application/json', headers };
  if (!scoped.resolved) return { status: 404 };
  return { status: 200, file: scoped.resolved.absPath, mime: scoped.resolved.mime, headers,
    source: scoped.bundle.kind === 'artifact' ? 'chat_app_artifact' as const : 'chat_app_saved' as const };
}
