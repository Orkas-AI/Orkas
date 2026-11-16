import { it } from 'vitest';
import { expectTestLog } from '../../helpers/test-log-analysis';

it('matches a declared Server fault by message without keeping its request identity', () => {
  expectTestLog({ level: 'error', source: 'python-server', message: /^controlled Server fault$/ });
  process.stdout.write('[12:34:56.789][ERROR][rid=synthetic-private-request] controlled Server fault\n');
});

it('rejects a different Server fault after the expected case', () => {
  process.stdout.write('[12:34:56.789][ERROR][rid=synthetic-private-request] unrelated Server fault\n');
});
