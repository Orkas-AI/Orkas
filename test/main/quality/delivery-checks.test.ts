import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { TERMINAL_CHECKS } from '../../../src/main/features/group_chat/terminal-checks';

/**
 * A declared delivery check that does not resolve is a silently disarmed
 * guard. The runtime deliberately fails open on unknown names (a typo in a
 * custom spec must not break the agent's turn), so for repo-shipped agents
 * this gate is the fail-closed side: every name a builtin agent.json declares
 * must exist in the terminal-checks registry, and renaming or deleting a
 * registry check must fail here instead of silently stripping an agent of a
 * guard it was reviewed to have.
 */

const AGENTS_ROOT = path.join(
  __dirname, '..', '..', '..', 'resources', 'builtin', 'marketplace', 'agents',
);

describe('builtin delivery_checks resolve', () => {
  it('every declared check name exists in the terminal-checks registry', () => {
    const known = new Set(Object.keys(TERMINAL_CHECKS));
    const unresolved: string[] = [];
    for (const dir of fs.readdirSync(AGENTS_ROOT)) {
      const file = path.join(AGENTS_ROOT, dir, 'agent.json');
      if (!fs.existsSync(file)) continue;
      const spec = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        name?: string;
        delivery_checks?: unknown;
      };
      if (!Array.isArray(spec.delivery_checks)) continue;
      for (const name of spec.delivery_checks) {
        if (typeof name !== 'string' || !known.has(name)) {
          unresolved.push(`${spec.name || dir}: ${String(name)}`);
        }
      }
    }
    expect(unresolved, 'declared delivery checks that no registry entry backs').toEqual([]);
  });

  it('the corpus actually declares at least one check (negative control)', () => {
    // Without this, deleting delivery_checks from every agent.json would turn
    // the gate above into a vacuous pass.
    const declared = fs.readdirSync(AGENTS_ROOT).some((dir) => {
      const file = path.join(AGENTS_ROOT, dir, 'agent.json');
      if (!fs.existsSync(file)) return false;
      const spec = JSON.parse(fs.readFileSync(file, 'utf8')) as { delivery_checks?: unknown };
      return Array.isArray(spec.delivery_checks) && spec.delivery_checks.length > 0;
    });
    expect(declared).toBe(true);
  });
});
