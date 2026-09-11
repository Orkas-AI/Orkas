/**
 * Model-facing issue projection policy.
 *
 * Known blockers are never item-capped here. The final AgentRunner tool-result
 * boundary owns the shared token budget and lossless Result Store spill, so a
 * business tool must not discard blockers before that boundary can preserve
 * them. Advisory findings may be sampled because they do not block progress;
 * callers must expose `advisoryIssuesOmitted` when it is non-zero.
 */

export const DEFAULT_MODEL_VISIBLE_ADVISORY_LIMIT = 8;

export type ModelVisibleIssueProjection<T> = {
  blockers: T[];
  advisories: T[];
  issues: T[];
  blockerCount: number;
  advisoryCount: number;
  advisoryIssuesOmitted: number;
  blockersComplete: true;
};

export function projectModelVisibleIssues<T>(
  issues: readonly T[],
  isBlocker: (issue: T) => boolean,
  maxAdvisories = DEFAULT_MODEL_VISIBLE_ADVISORY_LIMIT,
): ModelVisibleIssueProjection<T> {
  const blockers: T[] = [];
  const allAdvisories: T[] = [];
  for (const issue of issues) {
    if (isBlocker(issue)) blockers.push(issue);
    else allAdvisories.push(issue);
  }
  const advisoryLimit = Number.isFinite(maxAdvisories)
    ? Math.max(0, Math.floor(maxAdvisories))
    : DEFAULT_MODEL_VISIBLE_ADVISORY_LIMIT;
  const advisories = allAdvisories.slice(0, advisoryLimit);
  return {
    blockers,
    advisories,
    issues: [...blockers, ...advisories],
    blockerCount: blockers.length,
    advisoryCount: allAdvisories.length,
    advisoryIssuesOmitted: Math.max(0, allAdvisories.length - advisories.length),
    blockersComplete: true,
  };
}
