import { it } from 'vitest';
import { expectTestLog } from '../../helpers/test-log-analysis';

it.each([
  ['global', /fixture repeated diagnostic/g],
  ['sticky', /fixture repeated diagnostic/y],
  ['frozen-global', Object.freeze(/fixture repeated diagnostic/g)],
  ['frozen-sticky', Object.freeze(/fixture repeated diagnostic/y)],
] as const)('matches every repeated %s declaration', (_kind, message) => {
  expectTestLog({ level: 'error', message });
  console.error('fixture repeated diagnostic');
  console.error('fixture repeated diagnostic');
});

it('still rejects a different error after repeated declared output', () => {
  expectTestLog({ level: 'error', message: /fixture declared diagnostic/g });
  console.error('fixture declared diagnostic');
  console.error('fixture declared diagnostic');
  console.error('fixture different unexpected diagnostic');
});
