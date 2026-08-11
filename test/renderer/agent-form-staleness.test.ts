import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

// _resolveAgentFormMount decides, per form mount, whether an unsubmitted
// agent form is still the agent's live decision card or a dead affordance.
// Production incident: a VideoStudio review produced newer candidates, and
// the older unsubmitted gate forms stayed clickable in history — every click
// was rejected server-side as superseded (user clicked three times in one
// session). The renderer must stop offering those clicks at all, without
// hard-coding any agent id.
function loadResolver() {
  const context: any = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    JSON,
    Map,
    Set,
    Array,
    String,
    Number,
    RegExp,
    createLogger: () => ({ warn() {}, info() {}, error() {}, debug() {} }),
    t: (key: string) => key,
    escapeHtml: (s: unknown) => String(s ?? ''),
    currentCid: '',
    _BUCKET_ORDER: ['today', 'last30'],
    timeBucket: () => 'today',
    renderAvatarHtml: () => '',
    localStorage: {
      getItem: () => null,
      setItem() {},
      removeItem() {},
    },
    document: {
      readyState: 'loading',
      addEventListener() {},
      querySelector: () => null,
      querySelectorAll: () => [],
      getElementById: () => null,
    },
    window: {
      addEventListener() {},
      uiIconHtml: () => '',
      ConversationRuntime: {},
    },
  };
  context.window.window = context.window;
  vm.createContext(context);
  const source = fs.readFileSync(
    path.join(__dirname, '../../src/renderer/modules/conversation.js'),
    'utf8',
  );
  vm.runInContext(source, context);
  return context._resolveAgentFormMount as (
    existing: { formId: string; ts: number } | null | undefined,
    next: { formId: string; ts: number; submitted: boolean },
  ) => { stale: boolean; becomesActive: boolean; flipPrevious: boolean };
}

describe('agent form staleness resolution', () => {
  const resolve = loadResolver();

  it('keeps the first unsubmitted form live and flips it when a newer one mounts', () => {
    expect(resolve(null, { formId: 'f1', ts: 100, submitted: false })).toEqual({
      stale: false,
      becomesActive: true,
      flipPrevious: false,
    });
    // Newer form from the same agent supersedes the registered one.
    expect(resolve({ formId: 'f1', ts: 100 }, { formId: 'f2', ts: 200, submitted: false })).toEqual({
      stale: false,
      becomesActive: true,
      flipPrevious: true,
    });
  });

  it('mounts an older unsubmitted form as stale during history pagination', () => {
    // Older page loads after the live form is registered: the old form must
    // not steal the live slot or render clickable.
    expect(resolve({ formId: 'f2', ts: 200 }, { formId: 'f1', ts: 100, submitted: false })).toEqual({
      stale: true,
      becomesActive: false,
      flipPrevious: false,
    });
  });

  it('treats a re-mount of the same form as a refresh, never as superseding itself', () => {
    // Tab switches re-render the same message; flipping it against itself
    // would kill the only live form.
    expect(resolve({ formId: 'f1', ts: 100 }, { formId: 'f1', ts: 100, submitted: false })).toEqual({
      stale: false,
      becomesActive: true,
      flipPrevious: false,
    });
  });

  it('never marks a submitted form stale and never lets it flip the live one', () => {
    // Submitted forms are the durable record of a past decision; readonly
    // rendering owns them. A submitted re-render must not disturb a newer
    // pending form from the same agent.
    expect(resolve({ formId: 'f2', ts: 200 }, { formId: 'f1', ts: 100, submitted: true })).toEqual({
      stale: false,
      becomesActive: false,
      flipPrevious: false,
    });
  });
});
