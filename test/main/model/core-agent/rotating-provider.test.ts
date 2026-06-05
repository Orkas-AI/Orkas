import { describe, it, expect, beforeEach } from 'vitest';
import { createRotatingProvider, type RotatingCandidate } from '../../../../src/main/model/core-agent/rotating-provider';
import type { LLMProvider, StreamEvent, CompletionParams } from '#core-agent';
import { _clearAll, getCooldown } from '../../../../src/main/model/core-agent/profile-cooldown';

// ── Fake LLMProvider factory ────────────────────────────────────────────

interface FakeBehavior {
  streamEvents?: StreamEvent[];  // yield 这些事件后正常 done
  throwBefore?: unknown;          // 第一个事件之前就抛
  throwAfter?: unknown;           // 第一个事件 yield 之后才抛
  throwAfterN?: { n: number; err: unknown }; // 第 N 个事件 yield 之后才抛
  completeResult?: any;
  completeError?: unknown;
  buildError?: unknown;           // build() 阶段就挂（模拟 external-providers 构造错误）
}

function fakeProvider(id: string, b: FakeBehavior): LLMProvider {
  return {
    id,
    name: id,
    async *stream(_params: CompletionParams): AsyncIterable<StreamEvent> {
      if (b.throwBefore !== undefined) throw b.throwBefore;
      const events = b.streamEvents ?? [];
      for (let i = 0; i < events.length; i++) {
        yield events[i];
        if (b.throwAfter !== undefined && i === 0) throw b.throwAfter;
        if (b.throwAfterN && i === b.throwAfterN.n) throw b.throwAfterN.err;
      }
    },
    async complete(_p: CompletionParams) {
      if (b.completeError !== undefined) throw b.completeError;
      return b.completeResult;
    },
    async validateAuth() { return true; },
  };
}

function candidate(profileId: string, b: FakeBehavior, providerId = 'test', modelId = 'test-model'): RotatingCandidate {
  return {
    profileId,
    providerId,
    modelId,
    build: async () => {
      if (b.buildError !== undefined) throw b.buildError;
      return fakeProvider(profileId, b);
    },
  };
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

const PARAMS: CompletionParams = {
  model: 'test-model',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
};

describe('rotating-provider › stream 成功路径', () => {
  beforeEach(() => _clearAll());

  it('唯一候选成功 → 透传所有事件，onSuccess 触发', async () => {
    let winner: string | null = null;
    const p = createRotatingProvider({
      providerId: 'test',
      candidates: [candidate('p1', {
        streamEvents: [
          { type: 'text_delta', text: 'hi' } as any,
          { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, model: 'test-model' } as any,
        ],
      })],
      onSuccess: (pid) => { winner = pid; },
    });
    const events = await collect(p.stream(PARAMS));
    expect(events.length).toBe(2);
    expect(winner).toBe('p1');
  });
});

describe('rotating-provider › stream 可轮转失败', () => {
  beforeEach(() => _clearAll());

  it('第一把 401 → 切第二把成功，第一把进冷却', async () => {
    let winner: string | null = null;
    const authErr = Object.assign(new Error('Unauthorized'), { status: 401 });
    const p = createRotatingProvider({
      providerId: 'test',
      candidates: [
        candidate('p1', { throwBefore: authErr }),
        candidate('p2', { streamEvents: [{ type: 'text_delta', text: 'ok' } as any] }),
      ],
      onSuccess: (pid) => { winner = pid; },
    });
    const events = await collect(p.stream(PARAMS));
    expect(events.length).toBe(1);
    expect((events[0] as any).text).toBe('ok');
    expect(winner).toBe('p2');
    expect(getCooldown('p1')?.kind).toBe('auth');
    expect(getCooldown('p2')).toBeUndefined();
  });

  it('429 rate_limit → 同样轮转', async () => {
    const rateErr = Object.assign(new Error('Too Many Requests'), { status: 429 });
    const p = createRotatingProvider({
      providerId: 'test',
      candidates: [
        candidate('p1', { throwBefore: rateErr }),
        candidate('p2', { streamEvents: [{ type: 'text_delta', text: 'ok' } as any] }),
      ],
    });
    const events = await collect(p.stream(PARAMS));
    expect(events.length).toBe(1);
    expect(getCooldown('p1')?.kind).toBe('rate_limit');
  });

  it('balance（余额不足）→ 轮转', async () => {
    const balanceErr = new Error('账户余额不足，请充值');
    const p = createRotatingProvider({
      providerId: 'test',
      candidates: [
        candidate('p1', { throwBefore: balanceErr }),
        candidate('p2', { streamEvents: [{ type: 'text_delta', text: 'ok' } as any] }),
      ],
    });
    await collect(p.stream(PARAMS));
    expect(getCooldown('p1')?.kind).toBe('balance');
  });

  it('build() 阶段抛出 key 失败（如 external provider 初始化错）也能轮转', async () => {
    const authErr = new Error('invalid_api_key');
    const p = createRotatingProvider({
      providerId: 'test',
      candidates: [
        candidate('p1', { buildError: authErr }),
        candidate('p2', { streamEvents: [{ type: 'text_delta', text: 'ok' } as any] }),
      ],
    });
    const events = await collect(p.stream(PARAMS));
    expect(events.length).toBe(1);
    expect(getCooldown('p1')?.kind).toBe('auth');
  });

  it('fetch failed 先在当前候选重试 3 次，仍失败才切到下一个候选', async () => {
    const netErr = new TypeError('fetch failed');
    let p1Builds = 0;
    let p2Builds = 0;
    const p = createRotatingProvider({
      providerId: 'test',
      networkRetryDelayMs: () => 0,
      candidates: [
        {
          profileId: 'p1',
          providerId: 'test',
          modelId: 'test-model',
          build: async () => {
            p1Builds += 1;
            return fakeProvider('p1', { throwBefore: netErr });
          },
        },
        {
          profileId: 'p2',
          providerId: 'test',
          modelId: 'test-model',
          build: async () => {
            p2Builds += 1;
            return fakeProvider('p2', { streamEvents: [{ type: 'text_delta', text: 'ok' } as any] });
          },
        },
      ],
    });
    const events = await collect(p.stream(PARAMS));
    expect(p1Builds).toBe(4); // initial try + 3 retries
    expect(p2Builds).toBe(1);
    expect(events.filter((ev: any) => ev.type === 'retry').map((ev: any) => ev.attempt)).toEqual([1, 2, 3]);
    expect((events[events.length - 1] as any).text).toBe('ok');
    expect(getCooldown('p1')).toBeUndefined();
    expect(getCooldown('p2')).toBeUndefined();
  });
});

describe('rotating-provider › stream 不可轮转失败', () => {
  beforeEach(() => _clearAll());

  it('400 invalid_request → 第一把直接抛，不试第二把', async () => {
    const badReq = Object.assign(new Error('invalid_request_error: missing model'), { status: 400 });
    let p2Called = false;
    const p = createRotatingProvider({
      providerId: 'test',
      candidates: [
        candidate('p1', { throwBefore: badReq }),
        {
          profileId: 'p2',
          build: async () => { p2Called = true; return fakeProvider('p2', { streamEvents: [] }); },
        },
      ],
    });
    await expect(collect(p.stream(PARAMS))).rejects.toThrow(/invalid_request/);
    expect(p2Called).toBe(false);
    // 且第一把不进冷却（key 本身没问题）
    expect(getCooldown('p1')).toBeUndefined();
  });

  it('content_policy → 直接抛，不轮转', async () => {
    const policy = new Error('content_policy_violation: user asked for X');
    const p = createRotatingProvider({
      providerId: 'test',
      candidates: [
        candidate('p1', { throwBefore: policy }),
        candidate('p2', { streamEvents: [{ type: 'text_delta', text: 'ok' } as any] }),
      ],
    });
    await expect(collect(p.stream(PARAMS))).rejects.toThrow(/content_policy/);
    expect(getCooldown('p1')).toBeUndefined();
  });
});

describe('rotating-provider › stream preamble drain', () => {
  beforeEach(() => _clearAll());

  it('先 yield {type:"start"} 再抛 401 → 仍然能轮转（start 是 preamble 不 commit）', async () => {
    // 这是真实场景：pi-ai 的 stream 始终先 yield 一个 {type:"start"} 事件，
    // 然后在真正打 provider 请求时才 401。如果 rotating-provider 把 "start"
    // 当作内容事件提前 commit，就永远轮转不了 —— 这正是用户看到"没有转"的
    // bug。
    const authErr = Object.assign(new Error('401 Incorrect API key'), { status: 401 });
    let winner: string | null = null;
    const p = createRotatingProvider({
      providerId: 'test',
      candidates: [
        candidate('p1', {
          streamEvents: [{ type: 'start', model: 't' } as any],
          throwAfter: authErr,
        }),
        candidate('p2', {
          streamEvents: [
            { type: 'start', model: 't' } as any,
            { type: 'text_delta', text: 'ok' } as any,
          ],
        }),
      ],
      onSuccess: (pid) => { winner = pid; },
    });
    const events = await collect(p.stream(PARAMS));
    expect(winner).toBe('p2');
    expect(getCooldown('p1')?.kind).toBe('auth');
    // p2 的 start + text_delta 都应该透传
    expect(events.length).toBe(2);
    expect((events[1] as any).text).toBe('ok');
  });

  it('in-band {type:"error"} 事件也触发轮转', async () => {
    const authErr = Object.assign(new Error('401 invalid'), { status: 401 });
    const p = createRotatingProvider({
      providerId: 'test',
      candidates: [
        candidate('p1', {
          streamEvents: [
            { type: 'start', model: 't' } as any,
            { type: 'error', error: authErr } as any,
          ],
        }),
        candidate('p2', {
          streamEvents: [{ type: 'text_delta', text: 'ok' } as any],
        }),
      ],
    });
    const events = await collect(p.stream(PARAMS));
    expect(events.length).toBe(1);
    expect((events[0] as any).text).toBe('ok');
    expect(getCooldown('p1')?.kind).toBe('auth');
  });

  it('连续 yield 多个 preamble 不会 commit，后续 error 仍可轮转', async () => {
    const authErr = new Error('invalid_api_key');
    const p = createRotatingProvider({
      providerId: 'test',
      candidates: [
        candidate('p1', {
          streamEvents: [
            { type: 'start', model: 't' } as any,
            { type: 'content_block_start', index: 0 } as any,
            { type: 'error', error: authErr } as any,
          ],
        }),
        candidate('p2', {
          streamEvents: [{ type: 'text_delta', text: 'ok' } as any],
        }),
      ],
    });
    const events = await collect(p.stream(PARAMS));
    expect((events[events.length - 1] as any).text).toBe('ok');
    expect(getCooldown('p1')?.kind).toBe('auth');
  });
});

describe('rotating-provider › stream 已产出内容后失败', () => {
  beforeEach(() => _clearAll());

  it('yield 了 text_delta 之后再 401 也不轮转（保护已产出内容的完整性）', async () => {
    const authErr = Object.assign(new Error('Unauthorized'), { status: 401 });
    let winner: string | null = null;
    let p2Called = false;
    const p = createRotatingProvider({
      providerId: 'test',
      candidates: [
        candidate('p1', {
          streamEvents: [{ type: 'text_delta', text: 'partial' } as any],
          throwAfter: authErr,
        }),
        {
          profileId: 'p2',
          build: async () => { p2Called = true; return fakeProvider('p2', { streamEvents: [] }); },
        },
      ],
      onSuccess: (pid) => { winner = pid; },
    });
    const events: StreamEvent[] = [];
    let thrown: unknown = null;
    try {
      for await (const ev of p.stream(PARAMS)) events.push(ev);
    } catch (err) {
      thrown = err;
    }
    expect(winner).toBe('p1');      // 已 commit
    expect(events.length).toBe(1);  // 把 partial 吐出来了
    expect(thrown).toBeTruthy();    // 最终还是抛了
    expect(p2Called).toBe(false);   // 不换 key
  });
});

describe('rotating-provider › stream 全部候选失败', () => {
  beforeEach(() => _clearAll());

  it('所有候选都 401 → 全部进冷却，最后抛 last error', async () => {
    const authErr = Object.assign(new Error('Unauthorized'), { status: 401 });
    const p = createRotatingProvider({
      providerId: 'test',
      candidates: [
        candidate('p1', { throwBefore: authErr }),
        candidate('p2', { throwBefore: authErr }),
        candidate('p3', { throwBefore: authErr }),
      ],
    });
    await expect(collect(p.stream(PARAMS))).rejects.toThrow(/Unauthorized/);
    expect(getCooldown('p1')?.kind).toBe('auth');
    expect(getCooldown('p2')?.kind).toBe('auth');
    expect(getCooldown('p3')?.kind).toBe('auth');
  });

  it('候选为空 → 构造时直接抛', () => {
    expect(() => createRotatingProvider({
      providerId: 'test',
      candidates: [],
    })).toThrow(/candidates list is empty/);
  });

  it('所有候选 fetch failed → 各自重试后不进冷却，最终抛非 transient 的汇总错误', async () => {
    const netErr = new TypeError('fetch failed');
    let p1Builds = 0;
    let p2Builds = 0;
    const p = createRotatingProvider({
      providerId: 'test',
      networkRetryDelayMs: () => 0,
      candidates: [
        {
          profileId: 'p1',
          providerId: 'test',
          modelId: 'test-model',
          build: async () => {
            p1Builds += 1;
            return fakeProvider('p1', { throwBefore: netErr });
          },
        },
        {
          profileId: 'p2',
          providerId: 'test',
          modelId: 'test-model',
          build: async () => {
            p2Builds += 1;
            return fakeProvider('p2', { throwBefore: netErr });
          },
        },
      ],
    });
    await expect(collect(p.stream(PARAMS))).rejects.toThrow(/All configured model candidates failed after network retries/);
    expect(p1Builds).toBe(4);
    expect(p2Builds).toBe(4);
    expect(getCooldown('p1')).toBeUndefined();
    expect(getCooldown('p2')).toBeUndefined();
  });
});

describe('rotating-provider › 跨 provider fallback', () => {
  beforeEach(() => _clearAll());

  it('primary openai 401 → fallback anthropic，params.model 被换成 candidate 自己的 model', async () => {
    const authErr = Object.assign(new Error('401 invalid openai key'), { status: 401 });
    // 记录 fake provider 收到的 params.model，验证跨 provider 切换时 model 被 override
    const receivedModels: string[] = [];
    const makeProvider = (id: string, b: FakeBehavior): LLMProvider => ({
      id,
      name: id,
      async *stream(params) {
        receivedModels.push(params.model);
        if (b.throwBefore !== undefined) throw b.throwBefore;
        for (const ev of (b.streamEvents ?? [])) yield ev;
      },
      async complete(params) {
        receivedModels.push(params.model);
        if (b.completeError !== undefined) throw b.completeError;
        return b.completeResult;
      },
      async validateAuth() { return true; },
    });

    const p = createRotatingProvider({
      providerId: 'openai',   // registry 里的路由 id（primary 的 provider）
      candidates: [
        {
          profileId: 'openai:default',
          providerId: 'openai',
          modelId: 'gpt-5.4',
          build: async () => makeProvider('openai', { throwBefore: authErr }),
        },
        {
          profileId: 'anthropic:default',
          providerId: 'anthropic',
          modelId: 'claude-opus-4-7',
          build: async () => makeProvider('anthropic', {
            streamEvents: [{ type: 'text_delta', text: 'hello from claude' } as any],
          }),
        },
      ],
    });

    // AgentRunner 会用 primary 的 defaultModel 调 stream；rotating 内部
    // 必须把它 override 成每个 candidate 自己的 model。
    const events = await collect(p.stream({ ...PARAMS, model: 'gpt-5.4' }));
    expect(events.length).toBe(1);
    expect((events[0] as any).text).toBe('hello from claude');
    // 第一把 openai 用了 primary 的 model 'gpt-5.4'；第二把 anthropic
    // 必须看到被 override 后的 'claude-opus-4-7'，否则 pi-ai 会抛
    // "No model found for provider: anthropic, model: gpt-5.4"。
    expect(receivedModels).toEqual(['gpt-5.4', 'claude-opus-4-7']);
  });
});

describe('rotating-provider › complete 分支', () => {
  beforeEach(() => _clearAll());

  it('complete 第一把 401 → 切第二把', async () => {
    let winner: string | null = null;
    const authErr = Object.assign(new Error('Unauthorized'), { status: 401 });
    const p = createRotatingProvider({
      providerId: 'test',
      candidates: [
        candidate('p1', { completeError: authErr }),
        candidate('p2', { completeResult: { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, model: 'test' } }),
      ],
      onSuccess: (pid) => { winner = pid; },
    });
    const res = await p.complete(PARAMS);
    expect((res.content[0] as any).text).toBe('ok');
    expect(winner).toBe('p2');
    expect(getCooldown('p1')?.kind).toBe('auth');
  });

  it('complete 不可轮转 → 第一把直接抛', async () => {
    const badReq = Object.assign(new Error('invalid_request'), { status: 400 });
    const p = createRotatingProvider({
      providerId: 'test',
      candidates: [
        candidate('p1', { completeError: badReq }),
        candidate('p2', { completeResult: { content: [], stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, model: 't' } }),
      ],
    });
    await expect(p.complete(PARAMS)).rejects.toThrow(/invalid_request/);
    expect(getCooldown('p1')).toBeUndefined();
  });
});
