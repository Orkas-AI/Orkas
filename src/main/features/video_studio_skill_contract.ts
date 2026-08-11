/**
 * Host↔skill contract handshake for the video_studio tool.
 *
 * The host tool protocol (gate semantics, decision_evidence, signature-bound
 * review forms) and the VideoStudio agent skills ship through different
 * channels: the host with the app release, the skills through marketplace
 * reconcile. A skill generation older than the host protocol loops on every
 * gate instead of failing visibly (observed in production when a reconcile
 * downgraded the installed agent by 25 versions). This module lets the host
 * detect that skew explicitly instead of degrading silently.
 *
 * Compatibility resolution, in order:
 * 1. `video_studio_contract` in the installed agent.json — must equal the
 *    host contract exactly.
 * 2. No declared contract: installed `version` >= the floor below is treated
 *    as compatible (those releases already speak the current protocol but
 *    predate the field).
 * 3. Missing/unreadable agent.json: compatible. Absence is not the incident
 *    class (dev harnesses and tests run without a marketplace install), and
 *    failing closed there would break every non-marketplace runtime.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { userMarketplaceAgentDir } from '../paths';
import { compareVersions } from '../util/app-version-compat';

/** Bump when gate/evidence/review tool semantics change incompatibly. */
export const VIDEO_STUDIO_TOOL_CONTRACT = 2;

/** First agent release whose skills speak the current (contract 2) protocol. */
export const VIDEO_STUDIO_MIN_COMPATIBLE_AGENT_VERSION = '1.1.40';

export type VideoStudioContractCheck =
  | { compatible: true }
  | {
    compatible: false;
    direction: 'skill_outdated' | 'host_outdated';
    installed_version: string;
    declared_contract: number | null;
  };

export function checkInstalledVideoStudioContract(
  uid: string,
  agentId: string,
): VideoStudioContractCheck {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fs.readFileSync(
      path.join(userMarketplaceAgentDir(uid, agentId), 'agent.json'),
      'utf8',
    )) as Record<string, unknown>;
  } catch {
    return { compatible: true };
  }
  if (!parsed || typeof parsed !== 'object') return { compatible: true };
  const installedVersion = typeof parsed.version === 'string' ? parsed.version : '';
  const declaredRaw = Number((parsed as { video_studio_contract?: unknown }).video_studio_contract);
  const declared = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;
  if (declared !== null) {
    if (declared === VIDEO_STUDIO_TOOL_CONTRACT) return { compatible: true };
    return {
      compatible: false,
      direction: declared > VIDEO_STUDIO_TOOL_CONTRACT ? 'host_outdated' : 'skill_outdated',
      installed_version: installedVersion,
      declared_contract: declared,
    };
  }
  if (installedVersion
    && compareVersions(installedVersion, VIDEO_STUDIO_MIN_COMPATIBLE_AGENT_VERSION) >= 0) {
    return { compatible: true };
  }
  return {
    compatible: false,
    direction: 'skill_outdated',
    installed_version: installedVersion,
    declared_contract: null,
  };
}
