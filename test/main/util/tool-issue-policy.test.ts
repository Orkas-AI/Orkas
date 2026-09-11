import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MODEL_VISIBLE_ADVISORY_LIMIT,
  projectModelVisibleIssues,
} from '../../../src/main/util/tool-issue-policy';

describe('model-facing tool issue policy', () => {
  it('keeps every blocker while bounding only advisories', () => {
    const issues = [
      ...Array.from({ length: 20 }, (_, index) => ({ severity: 'error', code: `E_${index}` })),
      ...Array.from({ length: 12 }, (_, index) => ({ severity: 'warning', code: `W_${index}` })),
    ];

    const projected = projectModelVisibleIssues(
      issues,
      (issue) => issue.severity === 'error',
    );

    expect(projected.blockers).toHaveLength(20);
    expect(projected.advisories).toHaveLength(DEFAULT_MODEL_VISIBLE_ADVISORY_LIMIT);
    expect(projected.issues.slice(0, 20).map((issue) => issue.code))
      .toEqual(Array.from({ length: 20 }, (_, index) => `E_${index}`));
    expect(projected.advisoryIssuesOmitted).toBe(4);
    expect(projected.blockersComplete).toBe(true);
  });

  it('normalizes an invalid advisory limit without capping blockers', () => {
    const issues = [
      { severity: 'error', code: 'E_ONE' },
      { severity: 'warning', code: 'W_ONE' },
    ];
    const projected = projectModelVisibleIssues(
      issues,
      (issue) => issue.severity === 'error',
      Number.NaN,
    );

    expect(projected.blockers).toEqual([issues[0]]);
    expect(projected.advisories).toEqual([issues[1]]);
  });
});
