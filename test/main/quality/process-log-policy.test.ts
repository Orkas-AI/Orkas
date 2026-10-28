import { describe, expect, it } from 'vitest';
import { createModelEvalLogCollector } from '../../../scripts/model-eval-log-policy.mjs';

// The Electron console bridge must preserve Node warning protocol while real
// application errors and unrelated stderr continue to fail certification.
describe('public process log warning boundaries', () => {
  it.each(['stdout', 'stderr'])(
    'preserves a logger-wrapped Node listener warning for review on %s', stream => {
      const logs = createModelEvalLogCollector('packaged-launch-library');
      logs.ingest(stream, '[12:00:00.000] [error] [ (console)] (node:42) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 before-quit listeners added to [EventEmitter]. MaxListeners is 10. Use emitter.setMaxListeners() to increase limit\n');
      expect(logs.finish()).toMatchObject({ passed: true, requiresReview: true,
        coveragePassed: true, capturedLineCount: 1, analyzedLineCount: 1,
        levelCounts: { warn: 1, error: 0 },
        findings: [expect.objectContaining({ code: 'node-runtime-warning', severity: 'warning', count: 1 })] });
      logs.ingest('stderr', 'unexpected native failure\n');
      expect(logs.finish().passed).toBe(false);
    },
  );

  it.each([
    '[12:00:00.000] [error] [ (library)] (node:42) MaxListenersExceededWarning: fixture',
    '[12:00:00.000] [error] [ (console)] failed after MaxListenersExceededWarning',
    '[12:00:00.000] [error] [ (console)] (node:42) Error: MaxListenersExceededWarning',
  ])('keeps listener-warning look-alikes as application errors: %s', line => {
    const logs = createModelEvalLogCollector('packaged-launch-library');
    logs.ingest('stderr', line);
    expect(logs.finish()).toMatchObject({ passed: false,
      findings: [expect.objectContaining({ code: 'runtime-error', severity: 'error' })] });
  });

});
