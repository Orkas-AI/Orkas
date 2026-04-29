/**
 * User preferences bag — `<uid>/cloud/config/preferences.json`.
 *
 * 跨设备一致的用户偏好（云同步）。目前仅存 UI 语言（`language: 'zh' | 'en'`）。
 *
 * 历史：原 `data/config/config.json` 还存有 legacy `provider` / `model` 字段
 * （`auth.saveConfig` 写入的默认模型对）—— 这份 fallback 已废弃，默认模型由
 * `auth-profiles.json` 的 priority entries 唯一决定（`auth.getConfig()` 读
 * `entries[0]`）。迁移时丢弃这两个字段。
 *
 * 写入走 merge；key 显式置 undefined 时忽略（等效 no-op）。
 */

import { app } from 'electron';

import { userPreferencesFile } from '../paths';
import { readJsonSync, writeJsonSync } from '../storage';
import { getActiveUserId } from './users';
import {
  type Lang,
  SUPPORTED_LANGS,
  isLang,
  detectSystemLang,
  setCurrentLang,
} from '../i18n';

export interface CommanderAvatar {
  icon: string;
  color: string;
}

export interface UserPreferences {
  language?: Lang;
  /** Per-user 指挥官 avatar (icon id + color id). Tokens come from
   * `renderer/modules/avatar.js`. Missing → renderer falls back to the
   * commander default (crown + gold). */
  commander_avatar?: CommanderAvatar;
  /** 元认知级别的 agent 自演进开关。undefined / 任意非 false 值 → 视为开启
   * （保留历史默认行为）；显式 false → 关闭。env `ORKAS_METACOGNITION='0'`
   * 仍是更高优先级的 kill switch。读取走 `features/metacognition.isFeatureEnabled`. */
  metacognition_enabled?: boolean;
  [key: string]: unknown;
}

// 头像 token 校验沿用同一份 catalog（src/main/data/avatars.json）。
import { isKnownIcon, isKnownColor } from './avatars';

function preferencesFile(): string {
  return userPreferencesFile(getActiveUserId());
}

export function readPreferences(): UserPreferences {
  return readJsonSync<UserPreferences>(preferencesFile());
}

/** Merge `partial` into the on-disk preferences and atomically rewrite. */
export function writePreferences(partial: Partial<UserPreferences>): UserPreferences {
  const current = readPreferences();
  const next: UserPreferences = { ...current };
  for (const [k, v] of Object.entries(partial)) {
    if (v !== undefined) next[k] = v;
  }
  writeJsonSync(preferencesFile(), next);
  return next;
}

// ── Back-compat aliases for older callers ────────────────────────────────
// 新代码应使用 read/writePreferences。这些别名给还没迁移完的调用点用。
export const readConfig = readPreferences;
export const writeConfig = writePreferences;
export type AppConfig = UserPreferences;

// ── Language ─────────────────────────────────────────────────────────────

export function getLanguage(): Lang {
  const v = readPreferences().language;
  return isLang(v) ? v : 'en';
}

export function setLanguage(lang: Lang): Lang {
  if (!isLang(lang)) throw new Error(`unsupported language: ${String(lang)}`);
  writePreferences({ language: lang });
  setCurrentLang(lang);
  return lang;
}

/**
 * Boot-time language resolution:
 *   - If preferences.json has a valid `language` → use it, sync to i18n.
 *   - Otherwise detect from the given system-locale string, persist, and
 *     sync to i18n.
 *
 * Takes `systemLocale` explicitly so tests can exercise the branches without
 * pulling in Electron's `app`. Production caller is `initLanguageFromApp`.
 */
export function initLanguage(systemLocale: string): Lang {
  const pref = readPreferences();
  if (isLang(pref.language)) {
    setCurrentLang(pref.language);
    return pref.language;
  }
  const lang = detectSystemLang(systemLocale);
  writePreferences({ language: lang });
  setCurrentLang(lang);
  return lang;
}

// ── Commander avatar ─────────────────────────────────────────────────────

export function getCommanderAvatar(): CommanderAvatar | null {
  const v = readPreferences().commander_avatar;
  if (!v || typeof v !== 'object') return null;
  const icon = (v as CommanderAvatar).icon;
  const color = (v as CommanderAvatar).color;
  if (!isKnownIcon(icon) || !isKnownColor(color)) return null;
  return { icon, color };
}

export function setCommanderAvatar(avatar: CommanderAvatar): CommanderAvatar {
  if (!isKnownIcon(avatar?.icon) || !isKnownColor(avatar?.color)) {
    throw new Error('invalid avatar tokens');
  }
  const next: CommanderAvatar = { icon: avatar.icon, color: avatar.color };
  writePreferences({ commander_avatar: next });
  return next;
}

// ── Metacognition (self-evolution) toggle ────────────────────────────────
// 默认 ON：未写过 = undefined → 视为 true，与历史行为一致。
// 显式 false 才关闭。读取统一走 features/metacognition.isFeatureEnabled，
// 那里再叠加 env `ORKAS_METACOGNITION='0'` kill switch。

export function getMetacognitionEnabled(): boolean {
  const v = readPreferences().metacognition_enabled;
  return v !== false;
}

export function setMetacognitionEnabled(enabled: boolean): boolean {
  writePreferences({ metacognition_enabled: !!enabled });
  return !!enabled;
}

/** Production wrapper: reads the system locale from Electron's `app`. */
export function initLanguageFromApp(): Lang {
  let locale = '';
  try { locale = app.getLocale() || ''; } catch { /* pre-ready or test stub */ }
  return initLanguage(locale);
}

/** Re-export for callers that need it without pulling i18n directly. */
export { SUPPORTED_LANGS, type Lang };
