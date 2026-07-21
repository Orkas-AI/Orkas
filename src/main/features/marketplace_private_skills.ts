import AdmZip from 'adm-zip';

import { safeId } from '../storage';
import { inspectMarketplaceBundle } from './marketplace_bundle';

/**
 * Return the skill ids materialized by an agent-private skills bundle.
 *
 * Agent bundles are authored as `<skill-id>/SKILL.md` trees. `agent.json.skill_list`
 * is also the runtime allowlist, so it may legitimately contain both these private
 * ids and standalone marketplace skill ids. Installers must only cascade-install
 * the latter.
 */
export function agentPrivateSkillIdsFromBundle(bundle: AdmZip | null): Set<string> {
  const ids = new Set<string>();
  if (!bundle) return ids;

  for (const { entry, relPath } of inspectMarketplaceBundle(bundle)) {
    if (entry.isDirectory) continue;
    if (!relPath) continue;
    const parts = relPath.split('/');
    if (parts.length !== 2 || parts[1] !== 'SKILL.md') continue;
    if (safeId(parts[0])) ids.add(parts[0]);
  }
  return ids;
}
