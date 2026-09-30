import { describe, it, expect } from 'vitest';
import {
  classifyKeyFailure,
  isKeyFailure,
  formatKeyFailure,
} from '../../../../src/main/model/core-agent/auth-error';
import {
  AuthError,
  RateLimitError,
  ProviderError,
  ContextOverflowError,
  TimeoutError,
} from '../../../../src/core-agent/src/shared/errors';

describe('auth-error › classifyKeyFailure › status code fast path', () => {
  it.each([
    'Not authorized to operate on this resource',
    'Unable to generate this resource',
    'Quota is not the reason this operation was denied',
  ])('keeps a 403 permission failure despite incidental wording: %s', (message) => {
    expect(classifyKeyFailure({ status: 403, message })).toBe('permission');
  });

  it('uses an explicit rate-limit code even when its HTTP envelope is 403', () => {
    expect(classifyKeyFailure({ status: 403, code: 'rate_limit_error', message: 'opaque' })).toBe('rate_limit');
  });
  it('401 → auth', () => {
    const err = Object.assign(new Error('Unauthorized'), { status: 401 });
    expect(classifyKeyFailure(err)).toBe('auth');
  });

  it('401 + invalid_request_error + token_invalidated → auth（具体凭证信号优先）', () => {
    const err = Object.assign(new Error(JSON.stringify({
      error: {
        message: 'Encountered invalidated oauth token for user, failing request',
        type: 'invalid_request_error',
        code: 'token_invalidated',
      },
    })), { status: 401, code: 'token_invalidated' });
    expect(classifyKeyFailure(err)).toBe('auth');
  });

  it('403 → permission（默认）', () => {
    const err = Object.assign(new Error('Forbidden'), { status: 403 });
    expect(classifyKeyFailure(err)).toBe('permission');
  });

  it('keeps a 403 as permission without an explicit throttling code', () => {
    // Prose alone cannot override the HTTP status.
    const err = Object.assign(new Error('Resource has been exhausted: quota'), { status: 403 });
    expect(classifyKeyFailure(err)).toBe('permission');
  });

  it('429 → rate_limit', () => {
    const err = Object.assign(new Error('Too Many Requests'), { status: 429 });
    expect(classifyKeyFailure(err)).toBe('rate_limit');
  });

  it('429 + insufficient_quota → balance（余额不足，不是限流）', () => {
    const err = Object.assign(new Error('429 {"error":{"message":"积分不足","type":"insufficient_quota","code":"orkas_llm_quota_exceeded"}}'), { status: 429, code: 'insufficient_quota' });
    expect(classifyKeyFailure(err)).toBe('balance');
  });

  it('429 + code=insufficient_quota → balance', () => {
    const err = Object.assign(new Error('429'), { status: 429, code: 'insufficient_quota' });
    expect(classifyKeyFailure(err)).toBe('balance');
  });

  it('does not override HTTP 429 with a message-only balance claim', () => {
    expect(classifyKeyFailure({ status: 429, message: '429 积分不足' })).toBe('rate_limit');
  });

  it('402 → balance', () => {
    const err = Object.assign(new Error('Payment Required'), { status: 402 });
    expect(classifyKeyFailure(err)).toBe('balance');
  });

  it('402 + generic quota_exceeded code → balance（HTTP payment status wins）', () => {
    const err = Object.assign(new Error('quota exceeded'), {
      status: 402,
      code: 'orkas_llm_quota_exceeded',
    });
    expect(classifyKeyFailure(err)).toBe('balance');
  });

  it('Orkas quota business code remains balance even without an HTTP status', () => {
    const err = Object.assign(new Error('upstream rejected request'), {
      code: 'orkas_llm_quota_exceeded',
    });
    expect(classifyKeyFailure(err)).toBe('balance');
  });
});

describe('auth-error structured evidence and unclassified diagnostics', () => {

  it.each([
    ['auth', { code: 'AUTH_ERROR', message: 'opaque' }],
    ['rate_limit', { code: 'RATE_LIMIT', message: 'opaque' }],
    ['auth', { error: { type: 'invalid_request_error', code: 'token_invalidated' } }],
    ['auth', { error: { message: 'Missing Authentication header', code: 401 } }],
    ['auth', new ProviderError('opaque', 'custom', 401)],
    ['permission', { status: 403, code: 'unrecognized_gateway_code', message: 'opaque' }],
  ] as const)('preserves %s through typed or nested protocol metadata', (kind, error) => {
    expect(classifyKeyFailure(error)).toBe(kind);
  });

  it.each(['constructor', '__proto__', 'not_a_rate_limit_error', 'quota_exceeded'])(
    'does not invent an account cause for unknown code %s', (code) => {
      expect(classifyKeyFailure({ code, message: 'opaque' })).toBeNull();
    },
  );

  it('bounds parsing and handles a cyclic plain-object cause', () => {
    const error: { message: string; cause?: unknown } = { message: 'opaque' };
    error.cause = error;
    expect(classifyKeyFailure(error)).toBeNull();
    expect(classifyKeyFailure(new Error('{"code":"rate_limit_error","message":"' + 'x'.repeat(65_536) + '"}'))).toBeNull();
  });
});

describe('auth-error › classifyKeyFailure › 反例（不触发轮转）', () => {
  it('400 Bad Request / invalid_request_error → null', () => {
    const err = Object.assign(new Error('invalid_request_error: missing model param'), { status: 400 });
    expect(classifyKeyFailure(err)).toBeNull();
  });

  it('内容审核类 content_policy → null', () => {
    const err = new Error('Your request was flagged by content_policy_violation');
    expect(classifyKeyFailure(err)).toBeNull();
  });

  it('content_filter → null', () => {
    const err = new Error('Response blocked: content_filter triggered');
    expect(classifyKeyFailure(err)).toBeNull();
  });

  it('structured safety code wins over incidental balance wording', () => {
    const err = Object.assign(new Error('Request requires more credits to evaluate'), {
      code: 'ResponsibleAIPolicyViolation',
    });
    expect(classifyKeyFailure(err)).toBeNull();
  });

  it('500 / 502 / 503 server error → null（默认不触发，跟 isRetryableError 区分开）', () => {
    const err500 = Object.assign(new Error('Internal Server Error'), { status: 500 });
    const err502 = Object.assign(new Error('Bad Gateway'), { status: 502 });
    const err503 = Object.assign(new Error('Service Unavailable'), { status: 503 });
    expect(classifyKeyFailure(err500)).toBeNull();
    expect(classifyKeyFailure(err502)).toBeNull();
    expect(classifyKeyFailure(err503)).toBeNull();
  });

  it('ECONNRESET → "network"（rotatable，让旋转跳到下一个候选）', () => {
    const err = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    expect(classifyKeyFailure(err)).toBe('network');
  });

  it('TypeError("fetch failed") 包裹 ECONNRESET cause → "network"', () => {
    // 实际生产 log 里看到的形态：undici fetch failed，真正原因在 cause 链上
    const cause = Object.assign(new Error('Client network socket disconnected before secure TLS connection was established'), { code: 'ECONNRESET' });
    const err = Object.assign(new TypeError('fetch failed'), { cause });
    expect(classifyKeyFailure(err)).toBe('network');
  });

  it('ETIMEDOUT / ENOTFOUND / ECONNREFUSED → "network"', () => {
    expect(classifyKeyFailure(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }))).toBe('network');
    expect(classifyKeyFailure(Object.assign(new Error('getaddrinfo ENOTFOUND api.example.com'), { code: 'ENOTFOUND' }))).toBe('network');
    expect(classifyKeyFailure(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))).toBe('network');
  });

  it('keeps a message-only fetch failure unclassified', () => {
    const err = new TypeError('fetch failed');
    expect(classifyKeyFailure(err)).toBeNull();
  });

  it('"fetch failed" 包裹 401 cause → 仍然按 auth 分类（网络判断在最后）', () => {
    // 防御边界：HTTP 401 包在 fetch 错误外面时不应被误判成 network
    const cause = Object.assign(new Error('Unauthorized'), { status: 401 });
    const err = Object.assign(new TypeError('fetch failed'), { cause });
    expect(classifyKeyFailure(err)).toBe('auth');
  });

  it('model_not_found → null（配置问题，换 key 一样）', () => {
    const err = new Error('model not found: gpt-9');
    expect(classifyKeyFailure(err)).toBeNull();
  });

  it('undefined / null / 空对象 → null', () => {
    expect(classifyKeyFailure(null)).toBeNull();
    expect(classifyKeyFailure(undefined)).toBeNull();
    expect(classifyKeyFailure({})).toBeNull();
  });
});

describe('auth-error › classifyKeyFailure › cause chain 穿透', () => {
  it('深层 cause 里的 authentication_error 也能识别', () => {
    const inner = Object.assign(new Error('authentication_error: invalid api key'), { status: 401 });
    const mid = new Error('provider wrapped');
    (mid as any).cause = inner;
    const outer = new ProviderError('generic provider error', 'kimi-coding');
    (outer as any).cause = mid;
    expect(classifyKeyFailure(outer)).toBe('auth');
  });

  it('cause 链超 5 层后停止（避免循环 cause 卡死）', () => {
    const circular: Error & { cause?: Error } = new Error('layer-0');
    circular.cause = circular;
    // 不应崩（depth 限制生效）；没匹配到关键词 → null
    expect(classifyKeyFailure(circular)).toBeNull();
  });
});

describe('auth-error › isKeyFailure / formatKeyFailure', () => {
  it('isKeyFailure 是 classify 的 truthy 包装', () => {
    expect(isKeyFailure(Object.assign(new Error('x'), { status: 401 }))).toBe(true);
    expect(isKeyFailure(new TimeoutError('timeout'))).toBe(false);
  });

  it('formatKeyFailure 给可读摘要 + kind 前缀', () => {
    const err = Object.assign(new Error('Unauthorized: invalid api key'), { status: 401 });
    const formatted = formatKeyFailure(err);
    expect(formatted).toMatch(/^\[auth\]/);
    expect(formatted.length).toBeLessThanOrEqual(220);
  });

  it('formatKeyFailure 对非 key 失败不加前缀', () => {
    const err = new Error('content_policy_violation');
    expect(formatKeyFailure(err)).not.toMatch(/^\[/);
  });
});
