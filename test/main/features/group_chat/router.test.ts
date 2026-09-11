import { describe, it, expect } from 'vitest';

import {
  parseMentions, resolveRecipients,
  extractFormFromFinal, computeFormId, decodeSubmission, encodeSubmission,
  extractPlanInteractionFromFinal, extractHandbackFromFinal,
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

  // CJK typing habit: no space before `@` ("…然后@PptMaker 做成…"). The CJK
  // range is in the TOKEN class (CJK agent names) but must not act as a
  // leading boundary blocker — that exact shape silently dropped the second
  // mention on-device 2026-08-23 and the whole text went to one agent.
  it('recognizes a mention directly after a CJK character (no space)', () => {
    expect(parseMentions('写一篇介绍，然后@PptMaker 做成一份ppt文件', { names: ['PptMaker'] }))
      .toEqual(['PptMaker']);
    // Fallback class (no name list) behaves the same.
    expect(parseMentions('先研究，再@Writer 总结')).toEqual(['Writer']);
    // Rejected look-alikes: an ASCII word char before `@` is still an email
    // shape, even inside CJK prose.
    expect(parseMentions('邮件发到 user@example.com 即可')).toEqual([]);
    expect(parseMentions('账号a@b也不算')).toEqual([]);
  });

  it.each([
    '`@alice` then @bob review',
    '``@alice `example` `` then @bob review',
    '```ts\n@alice\n```\n@bob review',
    '~~~xml\n@alice\n~~~\n@bob review',
    '@bob review\n```\n@alice',
  ])('only dispatches prose mentions when pasted content contains code: %s', (text) => {
    expect(parseMentions(text)).toEqual(['bob']);
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

  // LLM 派活走 dispatch_to / plan_set 工具,散文里 @agent 是 markdown 装饰。
  // 这条不变量保护"commander/agent 在介绍/列举/计划里写 @ 不会误触发"
  // 的 bug 修复(详见 docs/plans/dispatch-via-tool-call.md)。Agent 仍可
  // 显式 @commander / @指挥官 升级给指挥官。
  it('skips non-reserved scanning when fromKind is not user', () => {
    const text = '我让 @需求挖掘师 先聊,然后 **@全面评估师** 评估';
    expect(parseMentions(text, { fromKind: 'commander' })).toEqual([]);
    expect(parseMentions(text, { fromKind: 'agent' })).toEqual([]);
    expect(parseMentions('辛苦 @需求挖掘师 继续, @commander 接力, @指挥官 看一下', { fromKind: 'agent' }))
      .toEqual(['commander', '指挥官']);
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

  it('ignores mentions across multiple separately quoted messages', () => {
    const text = [
      '> first reply asked @alice',
      '',
      '> second reply asked @bob',
      '> and referenced @carol',
      '',
      '@reviewer compare all replies',
    ].join('\n');
    expect(parseMentions(text)).toEqual(['reviewer']);
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

  // active_recipient (the conversation floor): a no-`@` user message follows the
  // agent the commander handed off to, instead of always the commander.
  it('user with no @ + active floor agent → routes to the floor agent', () => {
    const r = resolveRecipients({
      fromKind: 'user', fromId: 'user', text: 'I didn\'t get part 2', members,
      activeRecipient: 'writer',
    });
    expect(r.to).toEqual(['writer']);
    expect(r.hadExplicitMention).toBe(false);
  });

  it('falls back to Commander for legacy multi-recipient defaults', () => {
    const opts = { fromKind: 'user' as const, fromId: 'user', members,
      activeRecipients: ['writer', 'commander'] };
    expect(resolveRecipients({ ...opts, text: 'continue' }).to).toEqual(['commander']);
    expect(resolveRecipients({ ...opts, text: '> @writer quoted\ncontinue' }).to).toEqual(['commander']);
    expect(resolveRecipients({ ...opts, text: '@writer revise' }).to).toEqual(['writer']);
    expect(resolveRecipients({ ...opts, text: 'done', fromKind: 'agent', fromId: 'writer' }).to).toEqual(['user']);
  });

  it.each([
    ['check this', ['writer']],
    ['  @commander check this', ['commander']],
    ['check first @commander review', ['writer', 'commander']],
    ['> @writer quoted\n @commander review', ['commander']],
    ['@writer first @writer second', ['writer']],
  ])('routes first-instruction ownership for %s', (text, expected) => {
    expect(resolveRecipients({ fromKind: 'user', fromId: 'user', members, activeRecipient: 'writer', text }).to).toEqual(expected);
  });

  // Roster membership is a RECORD written at first dispatch, never a routing
  // gate: a chip-selected agent has no roster row until it first runs, and
  // gating on membership silently rerouted that first message to the
  // commander ("给：Claude Code" answered by 指挥官, on-device 2026-08-23).
  // The router therefore honors any non-reserved floor; the BUS owns
  // validation against the enabled-agent registry and clears dead floors
  // before calling in (bus e2e pins that half).
  it('honors an off-roster floor — validation is the caller\'s, membership is not eligibility', () => {
    const r = resolveRecipients({
      fromKind: 'user', fromId: 'user', text: '你好', members,
      activeRecipient: 'freshagent01',
    });
    expect(r.to).toEqual(['freshagent01']);
    expect(r.hadExplicitMention).toBe(false);
  });

  it('user explicit @commander overrides the floor (routes to commander)', () => {
    const r = resolveRecipients({
      fromKind: 'user', fromId: 'user', text: '@commander switch tasks', members,
      activeRecipient: 'writer',
    });
    expect(r.to).toEqual(['commander']);
  });

  it('user explicit @<otherAgent> while handed off routes only to that agent', () => {
    const members2 = [...members, { kind: 'agent' as const, id: 'coder', joined_at: 't' }];
    const r = resolveRecipients({
      fromKind: 'user', fromId: 'user', text: '@coder quick q', members: members2,
      activeRecipient: 'writer',
    });
    expect(r.to).toEqual(['coder']);
    expect(r.hadExplicitMention).toBe(true);
  });

  it('an absent/reserved floor falls back to [commander]', () => {
    // Dead-floor protection (deleted/disabled agent) lives in the BUS's
    // registry check now — it clears the floor before the router runs. The
    // router's own fallback covers only "no floor at all" and the reserved
    // ids, which are not agent routes.
    expect(resolveRecipients({
      fromKind: 'user', fromId: 'user', text: 'still there?', members,
    }).to).toEqual(['commander']);
    expect(resolveRecipients({
      fromKind: 'user', fromId: 'user', text: 'still there?', members,
      activeRecipient: 'commander',
    }).to).toEqual(['commander']);
  });

  it('commander reply ignores the floor (commander/agent always → user)', () => {
    const r = resolveRecipients({
      fromKind: 'commander', fromId: 'commander', text: 'done', members,
      activeRecipient: 'writer',
    });
    expect(r.to).toEqual(['user']);
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

  it('agent @<agent> in text routes to default (user) — @ no longer dispatches agents', () => {
    const r = resolveRecipients({
      fromKind: 'agent', fromId: 'writer',
      text: '辛苦 @writer 接力', members,
    });
    expect(r.to).toEqual(['user']);
  });

  it('agent explicit @commander / @指挥官 routes to commander', () => {
    const a = resolveRecipients({
      fromKind: 'agent', fromId: 'writer',
      text: '辛苦 @commander 接力', members,
    });
    expect(a.to).toEqual(['commander']);

    const b = resolveRecipients({
      fromKind: 'agent', fromId: 'writer',
      text: '@指挥官 我这边卡住了，需要你协调。', members,
    });
    expect(b.to).toEqual(['commander']);
  });
});

describe('group_chat router › extractHandbackFromFinal', () => {
  it('detects + strips a legacy bare marker without inventing a reason', () => {
    const r = extractHandbackFromFinal('All done for now.\n<handback />');
    expect(r.handback).toBe(true);
    expect(r.reason).toBeUndefined();
    expect(r.cleanText).toBe('All done for now.');
    expect(r.cleanText).not.toContain('handback');
  });

  it('extracts completed_handoff from the paired marker form', () => {
    const r = extractHandbackFromFinal(
      "Finished the delegated work.\n<handback reason='completed_handoff'></handback>",
    );
    expect(r.handback).toBe(true);
    expect(r.reason).toBe('completed_handoff');
    expect(r.cleanText).toBe('Finished the delegated work.');
  });

  it('extracts capability_boundary from a self-closing marker', () => {
    const r = extractHandbackFromFinal(
      'Video production is outside my workflow.\n<handback reason="capability_boundary" />',
    );
    expect(r.handback).toBe(true);
    expect(r.reason).toBe('capability_boundary');
    expect(r.cleanText).toBe('Video production is outside my workflow.');
  });

  it('strips unknown or conflicting reasons but leaves the routing reason undefined', () => {
    for (const text of [
      '<handback reason="done" />',
      '<handback reason="capability_boundary" reason="completed_handoff" />',
      '<handback reason="capability_boundary" />\n<handback />',
      '<handback reason="capability_boundary" />\n<handback reason="completed_handoff" />',
    ]) {
      const r = extractHandbackFromFinal(text);
      expect(r.handback).toBe(true);
      expect(r.reason).toBeUndefined();
      expect(r.cleanText).toBe('');
    }
  });

  it('no marker → handback undefined, text untouched', () => {
    const r = extractHandbackFromFinal('Here is lesson 2, any questions?');
    expect(r.handback).toBeUndefined();
    expect(r.cleanText).toBe('Here is lesson 2, any questions?');
  });

  it('look-alikes that pass the cheap <handback substring check but not the marker regex are NOT handback', () => {
    for (const text of [
      'See <handbackfoo /> for details.',        // \b after handback fails
      'The <handback-note> tag is documented.',  // not self-closing, no </handback>
      '<handbackish>content</handbackish>',       // \b fails on the word char
    ]) {
      const r = extractHandbackFromFinal(text);
      expect(r.handback).toBeUndefined();
      expect(r.cleanText).toBe(text);
    }
  });

  it('a real marker amid look-alike noise still detects handback and strips only the marker', () => {
    const r = extractHandbackFromFinal('Mentioning <handback-note> but actually done.\n<handback />');
    expect(r.handback).toBe(true);
    expect(r.cleanText).toBe('Mentioning <handback-note> but actually done.');
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

  it('extractFormFromFinal pulls XML form blocks without exposing the raw protocol text', () => {
    const text = [
      '请补充信息。',
      '',
      '<agent-input-form>',
      JSON.stringify({
        fields: [
          { id: 'topic', label: 'Topic', type: 'text', required: true },
          { id: 'files', label: 'Files', type: 'file', multiple: true },
        ],
      }),
      '</agent-input-form>',
      '',
      '收到后继续。',
    ].join('\n');

    const r = extractFormFromFinal(text, 'writer');
    expect(r.form?.agent_id).toBe('writer');
    expect(r.form?.fields.map((f) => f.id)).toEqual(['topic', 'files']);
    expect(r.cleanText).toContain('请补充信息。');
    expect(r.cleanText).toContain('收到后继续。');
    expect(r.cleanText).not.toContain('<agent-input-form>');
    expect(r.cleanText).not.toContain('"fields"');
  });

  it('extractPlanInteractionFromFinal strips valid markers and returns the latest status', () => {
    const text = [
      '我需要先和你确认目标。',
      '<plan-interaction status="open" />',
      '',
      '收到后我会继续。',
      '<plan-interaction status="closed"></plan-interaction>',
    ].join('\n');

    const r = extractPlanInteractionFromFinal(text);
    expect(r.status).toBe('closed');
    expect(r.cleanText).toContain('我需要先和你确认目标。');
    expect(r.cleanText).toContain('收到后我会继续。');
    expect(r.cleanText).not.toContain('plan-interaction');
  });

  it('extractPlanInteractionFromFinal leaves invalid markers visible', () => {
    const text = '继续确认。\n<plan-interaction status="wait" />';
    const r = extractPlanInteractionFromFinal(text);
    expect(r.status).toBeUndefined();
    expect(r.cleanText).toBe(text);
  });

  it('encodeSubmission leaves optional blanks empty instead of writing placeholders', () => {
    const form = {
      form_id: 'abcdef0123456789',
      agent_id: 'writer',
      fields: [
        { id: 'optional', label: 'Optional', type: 'text' as const, default: '' },
        { id: 'choice', label: 'Choice', type: 'select' as const, default: 'a', options: [{ value: 'a', label: 'A' }] },
        { id: 'multi', label: 'Multi', type: 'multiselect' as const, default: [], options: [{ value: 'x', label: 'X' }] },
      ],
    };

    const text = encodeSubmission(form, {});
    const decoded = decodeSubmission(text);

    expect(text).toContain('Optional：\n');
    expect(text).toContain('Choice：A');
    expect(text).toContain('Multi：\n');
    expect(text).not.toContain('unfilled');
    expect(text).not.toContain('undefined');
    expect(decoded?.values).toEqual({});
  });

  it('computeFormId is deterministic on same inputs', () => {
    const fields = [{ id: 'q', label: 'Q', type: 'text' as const, default: '' }];
    expect(computeFormId('cid1', 'msg1', 'writer', fields))
      .toBe(computeFormId('cid1', 'msg1', 'writer', fields));
  });
});

describe('group_chat router › segmentUserMentions (D9 §4.2.1)', () => {
  // Fixture contract (repo rule: parser code needs accepted real shapes +
  // rejected look-alikes). The segmenter is the deterministic core that
  // retired same-text broadcast: a wrong split sends an agent another
  // agent's instructions.
  const IDS = { a: 'agent-aaa1', b: 'agent-bbb2', helper: 'agent-ccc3' };
  const NAMES: Record<string, string> = { A: IDS.a, B: IDS.b, 'Writing Helper': IDS.helper, 写作助手: IDS.helper };
  const opts = (recipientIds: string[] = Object.values(IDS)) => ({
    tokenToId: (token: string) => NAMES[token] || null,
    recipientIds: new Set(recipientIds),
    names: Object.keys(NAMES),
  });
  const { segmentUserMentions } = require('../../../../src/main/features/group_chat/router');

  it('assigns the first instruction to Commander and strips later routing tokens', () => {
    const out = segmentUserMentions('明天上线前：@A 做a，输出到 docs/。@B 做b。', opts());
    expect(out?.preamble).toBe('明天上线前：');
    expect(out?.segments).toEqual([
      { actorId: 'commander', instruction: '明天上线前：', group: 0 },
      { actorId: IDS.a, instruction: '做a，输出到 docs/。', group: 1 },
      { actorId: IDS.b, instruction: '做b。', group: 2 },
    ]);
  });

  it('adjacent mentions share the following span (共同段) and the same group', () => {
    const out = segmentUserMentions('@A @B 检查这份报告', opts());
    expect(out?.segments).toEqual([
      { actorId: IDS.a, instruction: '检查这份报告', group: 0 },
      { actorId: IDS.b, instruction: '检查这份报告', group: 0 },
    ]);
  });

  it('deduplicates an adjacent recipient group and skips Agents without descriptions', () => {
    expect(segmentUserMentions('@A @A @B inspect', opts())?.segments).toEqual([
      { actorId: IDS.a, instruction: 'inspect', group: 0 },
      { actorId: IDS.b, instruction: 'inspect', group: 0 },
    ]);
    expect(segmentUserMentions('@A inspect @B', opts())?.segments).toEqual([
      { actorId: IDS.a, instruction: 'inspect', group: 0 },
    ]);
    expect(segmentUserMentions('@A', opts())?.segments).toEqual([]);
    expect(segmentUserMentions('@A @B ', opts())?.segments).toEqual([]);
    expect(segmentUserMentions('> context\n@A', opts())?.segments).toEqual([]);
  });

  it('keeps literal code in the assigned instruction without dispatching its mentions', () => {
    const text = '@A inspect `@B` and this example:\n```xml\n@B\n```\n@B verify';
    expect(segmentUserMentions(text, opts())?.segments).toEqual([
      { actorId: IDS.a, instruction: 'inspect `@B` and this example:\n```xml\n@B\n```', group: 0 },
      { actorId: IDS.b, instruction: 'verify', group: 1 },
    ]);
  });

  it('the same agent mentioned twice yields two ordered segments (no dedup)', () => {
    const out = segmentUserMentions('@A first step @A second step', opts());
    expect(out?.segments.map((s: any) => s.actorId)).toEqual([IDS.a, IDS.a]);
    expect(out?.segments.map((s: any) => s.instruction)).toEqual(['first step', 'second step']);
  });

  it('matches multi-word and Chinese display names exactly', () => {
    const out = segmentUserMentions('@Writing Helper polish the intro @写作助手 then the ending', opts());
    expect(out?.segments.map((s: any) => s.actorId)).toEqual([IDS.helper, IDS.helper]);
    expect(out?.segments[0].instruction).toBe('polish the intro');
  });

  it('does not copy the first instruction into an empty trailing segment', () => {
    const out = segmentUserMentions('review the doc: @A rewrite it @B', opts());
    expect(out?.segments).toEqual([
      { actorId: 'commander', instruction: 'review the doc:', group: 0 },
      { actorId: IDS.a, instruction: 'rewrite it', group: 1 },
    ]);
  });

  // CJK prose puts no whitespace before `@` — the mention (and thus the
  // second segment) must still open. This exact shape routed to ONE agent
  // on-device 2026-08-23 ("…，然后@PptMaker 做成…" reached only the first
  // mention's agent, with the second @ left as literal text).
  it('a mention directly after a CJK character still opens a segment', () => {
    const out = segmentUserMentions('@A 写一篇介绍，然后@B 做成一份ppt文件', opts());
    expect(out?.segments).toEqual([
      { actorId: IDS.a, instruction: '写一篇介绍，然后', group: 0 },
      { actorId: IDS.b, instruction: '做成一份ppt文件', group: 1 },
    ]);
  });

  // ── rejected look-alikes ────────────────────────────────────────────────

  it('returns null for zero or one resolved mention (single-recipient path owns those)', () => {
    expect(segmentUserMentions('just some text', opts())).toBeNull();
    expect(segmentUserMentions('@A do the whole thing', opts())).toBeNull();
    // Unresolvable tokens are not segment boundaries.
    expect(segmentUserMentions('@A do it with @nobody', opts())).toBeNull();
  });

  it('mentions on blockquote lines never open segments', () => {
    const out = segmentUserMentions('> quoted from @A earlier\n@A do a\n@B do b', opts());
    expect(out?.segments.map((s: any) => s.actorId)).toEqual([IDS.a, IDS.b]);
    // The quote line stays in the preamble text, not as its own segment.
    expect(out?.preamble).toContain('quoted from @A earlier');
  });

  it('does not treat email-like tokens as mention boundaries', () => {
    expect(segmentUserMentions('mail a@b and c@d then decide', opts())).toBeNull();
  });

  it('a mention resolving outside recipientIds is not a boundary', () => {
    const out = segmentUserMentions('@A do a @B do b', opts([IDS.a]));
    expect(out).toBeNull(); // only one span remains → single-recipient path
  });

  // ── D22 (user adjudication 2026-08-27): commander segments ────────────
  // Commander participates only through an explicit mention; ordinary text
  // before a mention stays shared context for the selected recipients.
  const CMD = 'commander';
  const d22opts = (recipientIds: string[] = Object.values(IDS)) => ({
    ...opts(recipientIds),
    tokenToId: (token: string) => NAMES[token]
      || (token === '指挥官' || token.toLowerCase() === 'commander' ? CMD : null),
    commanderId: CMD,
  });

  it('D22: an explicit commander mention opens its own segment instead of broadcasting', () => {
    const out = segmentUserMentions('@指挥官 总结现状 @A 跑一遍测试', d22opts());
    expect(out?.segments).toEqual([
      { actorId: CMD, instruction: '总结现状', group: 0 },
      { actorId: IDS.a, instruction: '跑一遍测试', group: 1 },
    ]);
  });

  it.each(['commander', IDS.b])('assigns the unaddressed first instruction to the current %s', (defaultRecipient) => {
    const out = segmentUserMentions('写一个登录页 @A 出这个页面的视觉稿', { ...d22opts(), defaultRecipient });
    expect(out?.segments).toEqual([
      { actorId: defaultRecipient, instruction: '写一个登录页', group: 0 },
      { actorId: IDS.a, instruction: '出这个页面的视觉稿', group: 1 },
    ]);
  });

  it('D22: a quote-only preamble stays shared context — no commander segment', () => {
    const out = segmentUserMentions('> 引用的上下文\n@A 处理 @B 复核', d22opts());
    expect(out?.segments).toEqual([
      { actorId: IDS.a, instruction: '> 引用的上下文\n处理', group: 0 },
      { actorId: IDS.b, instruction: '> 引用的上下文\n复核', group: 1 },
    ]);
  });

  it('D22: a single mention with no substantive preamble keeps the single-recipient path', () => {
    expect(segmentUserMentions('@A 单独做这件事', d22opts())).toBeNull();
    expect(segmentUserMentions('> 只有引用\n@A 单独做', d22opts())).toBeNull();
  });
});
