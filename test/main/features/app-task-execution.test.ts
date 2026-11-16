import { describe, expect, it } from 'vitest';
import { appTaskExecutionGuidance, isDirectAppTask, withAppTaskExecution } from '../../../src/main/features/app_task_execution';

const once = `app_${'a'.repeat(64)}_once_${'b'.repeat(32)}`;
describe('application invocation isolation', () => {
  it.each([undefined, '', 'ordinary-conversation', once.replace('_once_', '_retain_'), once.slice(0, -1)])('does not alter another execution surface: %s', cid => {
    expect(isDirectAppTask(cid)).toBe(false);
    if (cid !== undefined) {
      expect(appTaskExecutionGuidance(cid)).toBe('');
      expect(withAppTaskExecution('Original authored workflow.', cid)).toBe('Original authored workflow.');
    }
  });
  it('keeps the authored workflow and final language/date boundary while adding invocation-only guidance', () => {
    const original = 'Role and original workflow.\n\n## Runtime injection\nKnown state.\n\n---\n\n## User language\nChinese.\n\n---\n\n## Current date\nToday.';
    const result = withAppTaskExecution(original, once);
    expect(result).toContain('Role and original workflow.');
    expect(result).toContain('Known state.');
    expect(result.indexOf('## Application direct delivery')).toBeLessThan(result.indexOf('## User language'));
    expect(result.endsWith(original.slice(original.indexOf('\n\n---\n\n## User language')))).toBe(true);
  });
});
