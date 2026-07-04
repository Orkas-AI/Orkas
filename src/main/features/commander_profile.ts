/**
 * Commander profile catalog.
 *
 * Static, localized display/profile data lives in `src/main/data/commander.json`.
 * Runtime facts stay elsewhere:
 * - avatar preference: preferences.json
 * - memory: cloud/memory/agents/commander/MEMORY.md
 * - runtime stats: cloud/commander/runtime_stats.json
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface CommanderLocalizedText {
  zh?: string;
  en?: string;
  ja?: string;
}

export interface CommanderLocalizedList {
  zh?: string[];
  en?: string[];
  ja?: string[];
}

export interface CommanderProfile {
  id: 'commander';
  name: CommanderLocalizedText;
  description: CommanderLocalizedText;
  knowhow: CommanderLocalizedList;
  standards: CommanderLocalizedList;
  workflow: CommanderLocalizedText;
}

let _profile: CommanderProfile | null = null;

function loadProfile(): CommanderProfile {
  if (_profile) return _profile;
  const file = path.join(__dirname, '..', 'data', 'commander.json');
  const text = fs.readFileSync(file, 'utf-8');
  const parsed = JSON.parse(text) as CommanderProfile;
  _profile = parsed;
  return parsed;
}

export function getProfile(): CommanderProfile {
  return loadProfile();
}
