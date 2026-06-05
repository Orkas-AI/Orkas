/**
 * Static model catalogs for local CLI agents.
 *
 * Two CLIs ship with a curated list users can pick from (claude, codex);
 * the others (openclaw, opencode, hermes) return [] which the UI treats
 * as "free-text entry" — these CLIs either route by user account
 * (openclaw bonds models to pre-registered agents), enumerate via their
 * own `models` subcommand we don't shell yet (opencode), or advertise
 * via ACP at runtime (hermes). Dynamic discovery is a future option;
 * for v1 we keep the surface tiny and let users type the id.
 *
 * `default: true` is a UI hint only — at execute time, an empty
 * `agent.runtime.model` field tells the backend to pass nothing and let
 * the CLI resolve its own default (which tracks the user's account /
 * environment more accurately than any list we bake here).
 */

import type { LocalCliType } from './registry.js';

export type LocalModel = {
  id: string;
  label: string;
  /** Optional display hint; UI badges this entry as the recommended pick. */
  default?: boolean;
};

const CATALOG: Record<LocalCliType, LocalModel[]> = {
  claude: [
    { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', default: true },
    { id: 'claude-opus-4-7', label: 'Claude Opus 4.7' },
  ],
  codex: [
    { id: 'gpt-5.5', label: 'GPT-5.5', default: true },
    { id: 'gpt-5.5-pro', label: 'GPT-5.5 Pro' },
    { id: 'gpt-5.4', label: 'GPT-5.4' },
    { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini' },
    { id: 'gpt-5', label: 'GPT-5' },
    { id: 'o3', label: 'o3' },
    { id: 'o3-mini', label: 'o3-mini' },
  ],
  // Free-text entry; the UI renders an <input> instead of a <select>.
  openclaw: [],
  opencode: [],
  hermes: [],
};

/** Return the static model list for a CLI type. Empty = free-text entry. */
export function listModels(cli: LocalCliType): LocalModel[] {
  return CATALOG[cli] ?? [];
}

/**
 * The default model id for a CLI, or null if either the catalog is
 * empty or no entry is flagged `default: true`. Callers that need a
 * value to pre-fill the form use this; runner code never relies on it
 * (empty `agent.runtime.model` is a valid intent — "let the CLI pick").
 */
export function defaultModel(cli: LocalCliType): string | null {
  const list = listModels(cli);
  return list.find(m => m.default)?.id ?? null;
}
