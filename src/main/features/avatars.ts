/**
 * Avatar catalog — single source of truth for icon / color tokens.
 *
 * 数据本身在 `src/main/data/avatars.json`：
 *   - icons[]:  { id, label, svg }
 *   - colors[]: { id, label, bg, fg }
 *   - commander_default: { icon, color }   （指挥官固定图标 + 默认颜色）
 *
 * 后端只用 id 做白名单校验（agents.ts / config.ts 写入前过这里），
 * 不感知 SVG / hex —— 那两份是渲染数据，靠 `avatars.getCatalog` IPC 一次性
 * 喂给 renderer 缓存。新增/改名/换 SVG 全在 JSON 一处改。
 *
 * **Why** 一份数据：之前后端为做随机回填复制了一份 token 池，立刻就和
 * 前端的 `avatar.js` 出现了双写风险（改一处忘另一处）。统一到 JSON 后：
 *   - 后端只校验 id；不需要颜色 hex / svg；
 *   - 前端拿 catalog 时也拿到全套（含 SVG / hex），不再硬编码；
 *   - 所有"是否合法 token"的真相都源自这一份文件。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface AvatarIcon {
  id: string;
  label: string;
  svg: string;
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
