/**
 * Marketplace — browse + install official agents / skills from the Orkas Server.
 *
 * Installed items are dropped into the same `data/builtin/{agents,skills}/<id>/` tree as the
 * shipped built-ins so they surface under the existing "Built-in" group in the UI; we mark each
 * installed directory with a `_marketplace.json` sentinel so the startup hash-sync in
 * `agents.ts::syncBuiltinAgents` / `skills.ts::syncBuiltinSkills` doesn't garbage-collect them
 * (they aren't in `PC/src/builtin/`).
 *
 * Skill bundles travel as a single JSON envelope `{files:[{path, encoding, content}]}` so we don't
 * need a zip dependency (per PC/CLAUDE.md §1, every new npm dep needs a discussion). The envelope
 * is small in practice (SKILL.md + a couple of scripts) and the Server caps it at 8 MB.
 *
 * Upload (publishing custom items to the Server) is dev-only and lives in `marketplace_dev.ts`
 * so that file can be excluded from packaged builds via `package.json::build.files` — same
 * physical-exclusion pattern as `features/skills_dev.ts`.
 */

import { app } from 'electron';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import {
  BUILTIN_SKILLS_DIR,
  builtinAgentDir, builtinAgentDefinitionFile,
} from '../paths';
import { invalidateSkills as invalidateCoreAgentSkills } from '../model/core-agent/skill-registry';
import { createLogger } from '../logger';

const log = createLogger('marketplace');

// ── server URL ────────────────────────────────────────────────────────────
// Default to production. Devs running against a local Server set ORKAS_API_BASE_URL.
// The `app.isPackaged` fallback below is purely a dev-ergonomics default — packaged users always
// hit prod, unpackaged dev runs default to localhost. The catalog endpoint behaves identically
// either way.
const PROD_BASE = 'https://www.aiservice.fun/api';
const DEV_DEFAULT_BASE = 'http://127.0.0.1:8888/api';
export function apiBase(): string {
  if (process.env.ORKAS_API_BASE_URL) return process.env.ORKAS_API_BASE_URL.replace(/\/+$/, '');
  return app.isPackaged ? PROD_BASE : DEV_DEFAULT_BASE;
}

// ── envelope ──────────────────────────────────────────────────────────────
interface Envelope { code: number; msg?: string; [k: string]: unknown }

async function postJson<T>(p: string, body: unknown): Promise<T> {
  const res = await fetch(`${apiBase()}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  let data: Envelope;
  try { data = JSON.parse(text); } catch { throw new Error(`bad response (${res.status}): ${text.slice(0, 200)}`); }
  if (data.code !== 0) throw new Error(data.msg || `marketplace ${p} failed (code=${data.code})`);
  return data as unknown as T;
}

// ── types ─────────────────────────────────────────────────────────────────
export interface MarketplaceCategory {
  code: string;
  name_zh: string;
  name_en: string;
  kind: 'agent' | 'skill' | 'both';
  sort_order: number;
}

export interface MarketplaceAgent {
  id: string;
  name: string;
  description_zh: string;
  description_en: string;
  category: string;
  icon: string;
  color: string;
  version: string;
  download_count: number;
  updated_at: number;
}

export interface MarketplaceSkill {
  id: string;
  name: string;
  description_zh: string;
  description_en: string;
  category: string;
  version: string;
  download_count: number;
  updated_at: number;
}

export interface MarketplaceSentinel {
  server_id: string;
  version: string;
  category: string;
  installed_at: number;
}

interface BundleFile { path: string; encoding: 'utf8' | 'base64'; content: string }
interface BundleEnvelope { files: BundleFile[] }

// ── listing ───────────────────────────────────────────────────────────────
export async function listCategories(kind?: 'agent' | 'skill'): Promise<MarketplaceCategory[]> {
  const data = await postJson<{ list: MarketplaceCategory[] }>('/marketplace/categories', { kind });
  return data.list || [];
}

export async function listMarketplaceAgents(
  opts: { category?: string; q?: string; page?: number; size?: number } = {},
): Promise<{ list: MarketplaceAgent[]; total: number }> {
  return await postJson('/marketplace/agents/list', {
    category: opts.category || null,
    q: opts.q || null,
    page: opts.page || 1,
    size: opts.size || 50,
  });
}

export async function listMarketplaceSkills(
  opts: { category?: string; q?: string; page?: number; size?: number } = {},
): Promise<{ list: MarketplaceSkill[]; total: number }> {
  return await postJson('/marketplace/skills/list', {
    category: opts.category || null,
    q: opts.q || null,
    page: opts.page || 1,
    size: opts.size || 50,
  });
}

// ── install ───────────────────────────────────────────────────────────────
export async function installMarketplaceAgent(agentId: string): Promise<{ ok: true; id: string }> {
  if (!agentId) throw new Error('agentId required');
  const data = await postJson<{ spec_json: Record<string, unknown>; version: string; category: string }>(
    '/marketplace/agents/spec', { id: agentId },
  );

  const dir = builtinAgentDir(agentId);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(builtinAgentDefinitionFile(agentId), JSON.stringify(data.spec_json, null, 2), 'utf8');
  await writeSentinel(dir, agentId, data.version, data.category);
  log.info(`installed marketplace agent ${agentId} v${data.version} → ${dir}`);
  return { ok: true, id: agentId };
}

export async function installMarketplaceSkill(skillId: string): Promise<{ ok: true; id: string }> {
  if (!skillId) throw new Error('skillId required');
  const meta = await postJson<{ bundle_url: string; version: string; category: string }>(
    '/marketplace/skills/bundle', { id: skillId },
  );

  const res = await fetch(meta.bundle_url);
  if (!res.ok) throw new Error(`download bundle failed (${res.status})`);
  const envText = await res.text();
  let env: BundleEnvelope;
  try { env = JSON.parse(envText); } catch { throw new Error('bundle not JSON'); }
  if (!env.files || !Array.isArray(env.files)) throw new Error('bundle missing files[]');

  const dir = path.join(BUILTIN_SKILLS_DIR, skillId);
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });

  for (const f of env.files) {
    const safe = safeRelPath(f.path);
    if (!safe) {
      log.warn(`skip bundle entry with unsafe path: ${f.path}`);
      continue;
    }
    const dst = path.join(dir, safe);
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    if (f.encoding === 'base64') {
      await fsp.writeFile(dst, Buffer.from(f.content, 'base64'));
    } else {
      await fsp.writeFile(dst, f.content, 'utf8');
    }
  }

  await writeSentinel(dir, skillId, meta.version, meta.category);
  invalidateCoreAgentSkills();
  log.info(`installed marketplace skill ${skillId} v${meta.version} → ${dir} (${env.files.length} files)`);
  return { ok: true, id: skillId };
}

// ── helpers (exported for marketplace_dev.ts) ─────────────────────────────
export async function writeSentinel(dir: string, serverId: string, version: string, category: string): Promise<void> {
  const sentinel: MarketplaceSentinel = {
    server_id: serverId,
    version: version || '1.0.0',
    category: category || '',
    installed_at: Date.now(),
  };
  await fsp.writeFile(path.join(dir, '_marketplace.json'), JSON.stringify(sentinel, null, 2), 'utf8');
}

/** A path is safe if it's a relative POSIX-style path inside the target dir — no absolute,
 *  no `..` segments, no empty / dot paths. Used both when materializing a marketplace skill
 *  bundle and when packing one (defense in depth — bundles travel through COS, which is
 *  outside our trust boundary). */
export function safeRelPath(rel: string): string | null {
  if (!rel || typeof rel !== 'string') return null;
  if (path.isAbsolute(rel)) return null;
  const norm = path.posix.normalize(rel.replace(/\\/g, '/'));
  if (norm.startsWith('..') || norm.includes('/../') || norm === '.' || norm === '') return null;
  if (norm.startsWith('/')) return null;
  return norm;
}
