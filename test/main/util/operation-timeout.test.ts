import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  envTimeoutMs,
  OperationTimeoutError,
  operationErrorCode,
  withOperationTimeout,
} from '../../../src/main/util/operation-timeout';

const ENV_NAME = 'ORKAS_TEST_OPERATION_TIMEOUT_MS';
let previousEnv: string | undefined;

beforeEach(() => {
  previousEnv = process.env[ENV_NAME];
  delete process.env[ENV_NAME];
});

afterEach(() => {
  vi.useRealTimers();
  if (previousEnv === undefined) delete process.env[ENV_NAME];
  else process.env[ENV_NAME] = previousEnv;
});

describe('operation timeout configuration', () => {
  it('always returns an integer inside the declared safety bounds', () => {
    expect(envTimeoutMs(ENV_NAME, 500, 1_000, 10_000)).toBe(1_000);

    process.env[ENV_NAME] = '2500.9';
    expect(envTimeoutMs(ENV_NAME, 5_000, 1_000, 10_000)).toBe(2_500);

    process.env[ENV_NAME] = '999999';
    expect(envTimeoutMs(ENV_NAME, 5_000, 1_000, 10_000)).toBe(10_000);

    process.env[ENV_NAME] = 'not-a-number';
    expect(envTimeoutMs(ENV_NAME, 12_000, 1_000, 10_000)).toBe(10_000);
  });

  it('treats blank environment values as absent and rejects invalid bounds', () => {
    process.env[ENV_NAME] = '   ';
    expect(envTimeoutMs(ENV_NAME, 2_500, 1_000, 10_000)).toBe(2_500);

    expect(() => envTimeoutMs(ENV_NAME, 2_500, 0, 10_000)).toThrow(RangeError);
    expect(() => envTimeoutMs(ENV_NAME, 2_500, 10_000, 1_000)).toThrow(RangeError);
  });
});

describe('operation timeout settlement', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('preserves a successful or failed operation that settles before its deadline', async () => {
    await expect(withOperationTimeout(Promise.resolve('ready'), {
      timeoutMs: 1_000,
      code: 'E_LIBRARY_TIMEOUT',
      stage: 'embed',
    })).resolves.toBe('ready');

    const failure = Object.assign(new Error('provider failed'), { code: 'E_PROVIDER_FAILED' });
    await expect(withOperationTimeout(Promise.reject(failure), {
      timeoutMs: 1_000,
      code: 'E_LIBRARY_TIMEOUT',
      stage: 'embed',
    })).rejects.toBe(failure);

    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns stable stage/code metadata and hands the exact late operation to recovery once', async () => {
    let settle!: (value: string) => void;
    const operation = new Promise<string>((resolve) => { settle = resolve; });
    const onLateSettlement = vi.fn();
    const result = withOperationTimeout(operation, {
      timeoutMs: 1_500,
      code: 'E_LIBRARY_EMBED_TIMEOUT',
      stage: 'embed',
      onLateSettlement,
    });
    const rejection = expect(result).rejects.toMatchObject({
      name: 'OperationTimeoutError',
      code: 'E_LIBRARY_EMBED_TIMEOUT',
      stage: 'embed',
      timeoutMs: 1_500,
      message: 'embed timed out after 2s',
    });

    await vi.advanceTimersByTimeAsync(1_500);
    await rejection;
    expect(onLateSettlement).toHaveBeenCalledTimes(1);
    expect(onLateSettlement).toHaveBeenCalledWith(operation);
    expect(vi.getTimerCount()).toBe(0);

    settle('eventually ready');
    await operation;
  });

  it('does not let a broken recovery callback replace or delay the primary timeout', async () => {
    const neverSettles = new Promise<never>(() => {});
    const syncFailure = withOperationTimeout(neverSettles, {
      timeoutMs: 1_000,
      code: 'E_LIBRARY_EXTRACT_TIMEOUT',
      stage: 'extract',
      onLateSettlement: () => {
        throw new Error('recovery bookkeeping failed');
      },
    });
    const syncRejection = expect(syncFailure).rejects.toBeInstanceOf(OperationTimeoutError);
    await vi.advanceTimersByTimeAsync(1_000);
    await syncRejection;

    const asyncFailure = withOperationTimeout(neverSettles, {
      timeoutMs: 1_000,
      code: 'E_LIBRARY_EMBED_TIMEOUT',
      stage: 'embed',
      onLateSettlement: async () => {
        throw new Error('async recovery bookkeeping failed');
      },
    });
    const asyncRejection = expect(asyncFailure).rejects.toMatchObject({
      code: 'E_LIBRARY_EMBED_TIMEOUT',
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await asyncRejection;
    await Promise.resolve();
  });

  it('rejects invalid deadlines instead of silently timing out immediately', async () => {
    await expect(withOperationTimeout(Promise.resolve('ignored'), {
      timeoutMs: Number.NaN,
      code: 'E_LIBRARY_TIMEOUT',
      stage: 'extract',
    })).rejects.toThrow(RangeError);
    await expect(withOperationTimeout(Promise.resolve('ignored'), {
      timeoutMs: 0,
      code: 'E_LIBRARY_TIMEOUT',
      stage: 'extract',
    })).rejects.toThrow(RangeError);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('operation error codes', () => {
  it('preserves a non-empty stable code and otherwise uses the stage fallback', () => {
    expect(operationErrorCode({ code: 'E_LIBRARY_EMBED_TIMEOUT' }, 'E_FALLBACK'))
      .toBe('E_LIBRARY_EMBED_TIMEOUT');
    expect(operationErrorCode({ code: '' }, 'E_FALLBACK')).toBe('E_FALLBACK');
    expect(operationErrorCode({ code: 500 }, 'E_FALLBACK')).toBe('E_FALLBACK');
    expect(operationErrorCode(null, 'E_FALLBACK')).toBe('E_FALLBACK');
  });
});
