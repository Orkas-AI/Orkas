/**
 * Avatar catalog — PC runtime source for icon / color tokens.
 *
 * Data lives at `src/main/data/avatars.json`:
 *   - icons[]:  { id, label, description, svg }
 *   - colors[]: { id, label, bg, fg }
 *   - commander_default: { icon, color }   (commander's fixed icon + default color)
 *
 * `label` values in the JSON are English defaults; the renderer resolves a
 * localized name via `t('avatar.icon.<id>')` / `t('avatar.color.<id>')` and
 * falls back to the JSON `label` when no locale key exists.
 *
 * The backend only validates by `id` (agents.ts / config.ts pass writes
 * through here) — it doesn't care about SVG / hex; those exist as render
 * data and are pushed to the renderer once via the `avatars.getCatalog` IPC,
 * which caches them. Add / rename / re-style happens in the JSON, in one
 * place.
 *
 * Keep this catalog aligned with iOS/Web via `PC/test/main/avatar-catalogs.test.ts`.
 *
 * **Why** one runtime source per platform: an earlier version kept a duplicate token
 * pool on the backend for random backfill, which immediately invited the
 * "edit one, forget the other" failure mode with the renderer's `avatar.js`.
 * After unification to the platform JSON:
 *   - the backend only validates `id`; no color hex / svg awareness;
 *   - the renderer receives the full catalog (incl. SVG / hex) once, no
 *     hard-coding;
 *   - the canonical "is this token valid" truth lives in this one file.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface AvatarIcon {
  id: string;
  label: string;
  /** Stable semantic metadata kept beside the visual asset. */
  description: string;
  svg: string;
  auto_seed?: boolean;
}
export interface AvatarColor {
  id: string;
  label: string;
  bg: string;
  fg: string;
}
export interface AvatarCatalog {
  commander_default: { icon: string; color: string };
  icons: AvatarIcon[];
  colors: AvatarColor[];
}

let _catalog: AvatarCatalog | null = null;
let _knownIcons: Set<string> = new Set();
let _knownColors: Set<string> = new Set();

function _load(): AvatarCatalog {
  if (_catalog) return _catalog;
  // features/ → data/ via ../data
  const file = path.join(__dirname, '..', 'data', 'avatars.json');
  const text = fs.readFileSync(file, 'utf-8');
  const parsed = JSON.parse(text) as AvatarCatalog;
  _knownIcons = new Set(parsed.icons.map((i) => i.id));
  _knownColors = new Set(parsed.colors.map((c) => c.id));
  _catalog = parsed;
  return parsed;
}

export function getCatalog(): AvatarCatalog { return _load(); }

export function isKnownIcon(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  _load();
  return _knownIcons.has(v);
}

export function isKnownColor(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  _load();
  return _knownColors.has(v);
}
