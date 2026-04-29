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
  it('401 → auth', () => {
    const err = Object.assign(new Error('Unauthorized'), { status: 401 });
    expect(classifyKeyFailure(err)).toBe('auth');
  });

  it('403 → permission（默认）', () => {
    const err = Object.assign(new Error('Forbidden'), { status: 403 });
    expect(classifyKeyFailure(err)).toBe('permission');
  });

  it('403 带 rate/quota 字样 → 归到 rate_limit（一些云商用 403 返限速）', () => {
    // 例：Google Vertex AI 偶发 403 "Resource has been exhausted (e.g. check quota)"
    const err = Object.assign(new Error('Resource has been exhausted: quota'), { status: 403 });
    expect(classifyKeyFailure(err)).toBe('rate_limit');
  });

  it('429 → rate_limit', () => {
    const err = Object.assign(new Error('Too Many Requests'), { status: 429 });
    expect(classifyKeyFailure(err)).toBe('rate_limit');
  });

  it('402 → balance', () => {
    const err = Object.assign(new Error('Payment Required'), { status: 402 });
    expect(classifyKeyFailure(err)).toBe('balance');
  });
});

describe('auth-error › classifyKeyFailure › 跨模块边界 (message-only)', () => {
  // 故意不用 instanceof — pi-provider 在 ESM 加载 AuthError，我们在 CJS 加载，
  // 跨模块 instanceof 返 false。靠 err.message / err.status 分类。
  it('pi-provider 的 wrapError 产物 "auth failed" 前缀 → auth', () => {
    // pi-provider.ts::wrapError 构造的 message 格式
    const err = new Error('openai auth failed: 401 Incorrect API key provided: sk-xxx');
    expect(classifyKeyFailure(err)).toBe('auth');
  });

  it('"auth failed" 前缀带 permission 关键词 → permission', () => {
    const err = new Error('anthropic auth failed: forbidden: subscription expired');
    expect(classifyKeyFailure(err)).toBe('permission');
  });

  it('rate_limit message', () => {
    expect(classifyKeyFailure(new Error('rate limited: too many requests per minute'))).toBe('rate_limit');
  });

  it('context_length_exceeded → null（不换 key，换了一样溢出）', () => {
    expect(classifyKeyFailure(new Error('context_length_exceeded: max 8k'))).toBeNull();
  });

  it('request timed out → "network"（同 key 重试无用，但换 endpoint 有救）', () => {
    expect(classifyKeyFailure(new Error('request timed out after 30s'))).toBe('network');
  });
});

describe('auth-error › classifyKeyFailure › message fallback', () => {
  it('Kimi/Anthropic 风格的 authentication_error JSON 体', () => {
    // 这正是用户看到的 401 报文
    const body = '401 {"error":{"type":"authentication_error","message":"The API Key appears to be invalid or may have expired. Please verify your credentials and try again."},"type":"error"}';
    const err = new ProviderError(body, 'kimi-coding');
    expect(classifyKeyFailure(err)).toBe('auth');
  });

  it('中文"余额不足"', () => {
    const err = new ProviderError('账户余额不足，请充值后重试', 'moonshot');
    expect(classifyKeyFailure(err)).toBe('balance');
  });

  it('OpenAI "insufficient_quota"', () => {
    const err = new Error('You exceeded your current quota — insufficient_quota');
    expect(classifyKeyFailure(err)).toBe('balance');
  });

  it('permission error 不带状态码也能识别', () => {
    const err = new Error('permission_error: this API key does not have access to the requested model');
    expect(classifyKeyFailure(err)).toBe('permission');
  });

  it('rate limit 英文报文', () => {
    const err = new Error('rate_limit_error: too many requests per minute');
    expect(classifyKeyFailure(err)).toBe('rate_limit');
  });

  it('balance 关键词排在 auth 前面（"insufficient credits" 不应误判为 invalid）', () => {
    const err = new Error('Your request was blocked: insufficient credits');
    expect(classifyKeyFailure(err)).toBe('balance');
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

  it('"fetch failed" 仅消息无 cause code → "network"（消息正则兜底）', () => {
    const err = new TypeError('fetch failed');
    expect(classifyKeyFailure(err)).toBe('network');
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
