import { describe, it, expect } from 'vitest';

import {
  parseMentions, resolveRecipients,
  extractFormFromFinal, computeFormId, decodeSubmission, encodeSubmission,
} from '../../../../src/main/features/group_chat/router';

describe('group_chat router › parseMentions', () => {
  it('finds @-tokens deduped in first-occurrence order', () => {
    expect(parseMentions('hi @alice and @bob, then @alice again')).toEqual(['alice', 'bob']);
  });

  it('does not match emails as mentions', () => {
    // `foo@example.com` — `o` is in the prev-char class so the boundary
    // disqualifies the @.
    expect(parseMentions('contact me at foo@example.com please')).toEqual([]);
  });

  it('handles punctuation boundaries (start, comma, period)', () => {
    expect(parseMentions('@x, hello @y. and @z!')).toEqual(['x', 'y', 'z']);
  });

  it('returns [] on empty / non-string', () => {
    expect(parseMentions('')).toEqual([]);
  });

  // Multi-word display names get truncated by the fallback char-class regex
  // (no whitespace allowed inside a token). Passing `names` switches the
  // parser to alternation mode so "Software Requirements Analyst" matches
  // as a whole. Regression for the case where user typed
  // "@Socratic Learning Coach 运行" and bus extracted only `Socratic`.
  it('greedy-matches multi-word names from the supplied list', () => {
    const names = ['Software Requirements Analyst', 'Socratic Learning Coach', 'Software'];
    expect(parseMentions('@Socratic Learning Coach 运行', { names })).toEqual(['Socratic Learning Coach']);
    expect(parseMentions('let @Software Requirements Analyst handle scoping', { names }))
      .toEqual(['Software Requirements Analyst']);
    // Longest-first ordering: bare "@Software" (no continuation) still matches
    // the short name without being mistaken for a prefix of the long one.
    expect(parseMentions('ping @Software now', { names })).toEqual(['Software']);
    // Token continues into a non-name word — alternation fails, fallback
    // char class matches just the leading word.
    expect(parseMentions('@Software Foo Bar', { names })).toEqual(['Software']);
  });

  // LLM 派活走 dispatch_to / plan_set 工具,散文里 @ 是 markdown 装饰。
  // 这条不变量保护"commander/agent 在介绍/列举/计划里写 @ 不会误触发"
  // 的 bug 修复(详见 docs/plans/dispatch-via-tool-call.md)。
  it('skips scanning when fromKind is not user (commander / agent)', () => {
    const text = '我让 @需求挖掘师 先聊,然后 **@全面评估师** 评估';
    expect(parseMentions(text, { fromKind: 'commander' })).toEqual([]);
    expect(parseMentions(text, { fromKind: 'agent' })).toEqual([]);
    // user 仍然走完整扫描
    expect(parseMentions(text, { fromKind: 'user' })).toEqual(['需求挖掘师', '全面评估师']);
    // 缺省 fromKind 等价老行为(向后兼容)
    expect(parseMentions(text)).toEqual(['需求挖掘师', '全面评估师']);
  });

  // Quote-reply prepends the quoted bubble's body as `> ...` blockquote
  // lines. `@<name>` inside that quote refers to the original author's
  // dispatch — re-routing to it whenever someone forwards the bubble
  // is wrong (the user's intent is in their own typed prose, not in the
  // pasted-in context). Lines starting with `>` are stripped from the
  // routing-relevant view.
  it('ignores @-mentions inside `>` blockquote lines (quote-reply context)', () => {
    // Pure quote, no body → no mentions parsed (default routing applies upstream).
    expect(parseMentions('> hi @alice')).toEqual([]);
    // Quote contains @, body has its own @ → only the body's @ counts.
    expect(parseMentions('> previous reply mentioned @alice\n@bob please review'))
      .toEqual(['bob']);
    // Multi-line quote, multiple @s ignored; user's plain @ kept.
    expect(parseMentions('> line one @x\n> line two @y\nfinal: @z'))
      .toEqual(['z']);
    // Leading whitespace before `>` (some clients indent quotes).
    expect(parseMentions('   > @alice from somewhere\nplain @bob'))
      .toEqual(['bob']);
  });
});

describe('group_chat router › resolveRecipients', () => {
  const members = [
    { kind: 'commander' as const, id: 'commander', joined_at: 't' },
    { kind: 'user' as const,      id: 'user',      joined_at: 't' },
    { kind: 'agent' as const,     id: 'writer',    joined_at: 't' },
  ];

  it('user with no @ → defaults to [commander]', () => {
    const r = resolveRecipients({ fromKind: 'user', fromId: 'user', text: 'hi', members });
    expect(r.to).toEqual(['commander']);
    expect(r.unknown).toEqual([]);
  });

  it('commander with no @ → defaults to [user]', () => {
    const r = resolveRecipients({ fromKind: 'commander', fromId: 'commander', text: 'done', members });
    expect(r.to).toEqual(['user']);
  });

  it('agent with no @ → defaults to [user]', () => {
    // Agents surface their output to the human user by default — most
    // turns produce intermediate / final results meant for user-facing
    // display. Reaching commander (to ask it to re-orchestrate) requires
    // explicit `@<commander>` (e.g. `@指挥官` or `@commander`).
    const r = resolveRecipients({ fromKind: 'agent', fromId: 'writer', text: 'done', members });
    expect(r.to).toEqual(['user']);
  });

  it('explicit @<aid> routes only to that actor', () => {
    const r = resolveRecipients({
      fromKind: 'user', fromId: 'user', text: '@writer go', members,
    });
    expect(r.to).toEqual(['writer']);
  });

  it('@unknown returns empty `to` + populated `unknown` (bus applies default)', () => {
    // When tokens were present but none resolved synchronously, router
    // returns `to=[]` so the bus can try async resolution before
    // committing to the sender-default recipient. If router defaulted
    // here, a successful async resolve would end up appending the agent
    // alongside the default user/commander, double-routing the message.
    const r = resolveRecipients({
      fromKind: 'user', fromId: 'user', text: '@nobody help', members,
    });
    expect(r.to).toEqual([]);
    expect(r.unknown).toEqual(['nobody']);
  });

  it('user multiple @-mentions deduped + union routed', () => {
    const r = resolveRecipients({
      fromKind: 'user', fromId: 'user',
      text: '@writer please / and @writer again', members,
    });
    expect(r.to).toEqual(['writer']);
  });

  // Bug-fix invariant: commander/agent 散文里写 `@<X>` 不再触发派活
  // (LLM 派活走 dispatch_to / plan_set 工具)。详见 CLAUDE.md §5
  // "派活通道" + docs/plans/dispatch-via-tool-call.md。
  it('commander @ in text routes to default (user) — @ no longer dispatches', () => {
    const r = resolveRecipients({
      fromKind: 'commander', fromId: 'commander',
      text: '我让 **@writer** 先做这件事,然后 @writer 收尾', members,
    });
    expect(r.to).toEqual(['user']);
    expect(r.unknown).toEqual([]);
  });

  it('agent @ in text routes to default (user) — @ no longer dispatches', () => {
    const r = resolveRecipients({
      fromKind: 'agent', fromId: 'writer',
      text: '辛苦 @commander 接力', members,
    });
    expect(r.to).toEqual(['user']);
  });
});

describe('group_chat router › form encoding', () => {
  it('encodeSubmission round-trips through decodeSubmission', () => {
    const form = {
      form_id: 'abcdef0123456789',
      agent_id: 'writer',
      fields: [
        { id: 'topic', label: 'Topic', type: 'text' as const, default: '' },
        { id: 'count', label: 'Count', type: 'number' as const, default: 1 },
      ],
    };
    const text = encodeSubmission(form, { topic: 'hello', count: 5 });
    const decoded = decodeSubmission(text);
    expect(decoded).not.toBeNull();
    expect(decoded?.form_id).toBe('abcdef0123456789');
    expect(decoded?.agent_id).toBe('writer');
    expect(decoded?.values).toEqual({ topic: 'hello', count: 5 });
  });

  it('extractFormFromFinal pulls fenced block + falls back to defaultAgentId', () => {
    const text = [
      'before',
      '',
      '```agent-input-form',
      JSON.stringify({ fields: [{ id: 'q', label: 'Q', type: 'text' }] }),
      '```',
      '',
      'after',
    ].join('\n');
    const r = extractFormFromFinal(text, 'writer');
    expect(r.form?.agent_id).toBe('writer');
    expect(r.form?.fields[0].id).toBe('q');
    expect(r.cleanText).toContain('before');
    expect(r.cleanText).toContain('after');
    expect(r.cleanText).not.toContain('agent-input-form');
  });

  it('computeFormId is deterministic on same inputs', () => {
    const fields = [{ id: 'q', label: 'Q', type: 'text' as const, default: '' }];
    expect(computeFormId('cid1', 'msg1', 'writer', fields))
      .toBe(computeFormId('cid1', 'msg1', 'writer', fields));
  });
});
