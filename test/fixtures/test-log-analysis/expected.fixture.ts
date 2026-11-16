import { expect, it } from 'vitest';
import { expectTestLog } from '../../helpers/test-log-analysis';

it('passes a declared recoverable warning', () => {
  console.info('fixture ordinary stdout remains visible');
  expectTestLog({ level: 'warn', source: 'console', message: /fixture recoverable retry/ });
  console.warn('fixture recoverable retry', { attempt: 2 });
  expect(true).toBe(true);
});

it('passes but surfaces an undeclared warning', () => {
  console.warn('fixture undeclared warning');
});

it('passes a declared and asserted error path', () => {
  expectTestLog({ level: 'error', message: /fixture asserted failure/ });
  console.error('fixture asserted failure');
});

it('accepts the structured skill-script progress protocol on stderr', () => {
  process.stderr.write('{"type":"progress","source":"video_edit","op":"mix","status":"running","elapsed_sec":0.5}\n');
});
