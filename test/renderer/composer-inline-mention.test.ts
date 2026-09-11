import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

/**
 * `@` in a group-chat composer is how a user hands one message to SEVERAL
 * agents: each pick must leave a visible `@name` in the text (the bus splits
 * a multi-mention send per assignee). Restricting that to the conversation
 * composer left the new-chat and project boxes able to address exactly ONE
 * agent — the pick ate the typed `@` and only moved the recipient chip, so a
 * second pick replaced the first (on-device 2026-08-26).
 */

const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/agents.js'), 'utf8');

function extractFunction(name: string): string {
  const marker = `function ${name}`;
  const found = source.indexOf(marker);
  if (found < 0) throw new Error(`missing ${name}`);
  // Keep the `async` keyword: dropping it turns every `await` in the body
  // into a syntax error inside the vm script.
  const start = source.slice(found - 6, found) === 'async ' ? found - 6 : found;
  const braceStart = source.indexOf('{', start);
  if (braceStart < 0) throw new Error(`missing body for ${name}`);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

const EXTRACTED = [
  '_recipientTextareaFromEventTarget',
  '_atKeyOpener',
  '_insertInlineMention',
  '_consumeAtKeyChar',
  '_targetFromPickerAnchor',
  '_triggerAgent',
].map(extractFunction).join('\n');

type Recipient = { target: string; id: string; name: string };

/** Drive the real picker plumbing: type `@` into a composer (which is what
 *  arms the picker), then select `picks[i]` from it. `chipClicks` selects the
 *  same way but WITHOUT a typed `@`, i.e. the chip-click path. */
async function runComposer(inputId: string, chipId: string, script: Array<
  { type: 'type'; text: string }
  | { type: 'atPick'; id: string; name: string }
  | { type: 'chipPick'; id: string; name: string }
>) {
  const recipients: Recipient[] = [];
  const pickerOpens: string[] = [];
  const textarea: any = {
    id: inputId,
    value: '',
    selectionStart: 0,
    selectionEnd: 0,
    dataset: {},
    setSelectionRange(start: number, end?: number) {
      this.selectionStart = start;
      this.selectionEnd = typeof end === 'number' ? end : start;
    },
    dispatchEvent() { return true; },
    focus() {},
  };
  const chip = { id: chipId };
  const context: any = {
    console,
    setTimeout,
    Event: class { type: string; constructor(type: string) { this.type = type; } },
    document: {
      getElementById: (id: string) => {
        if (id === inputId) return textarea;
        if (id === chipId) return chip;
        return null;
      },
    },
    _openAgentPicker: (btn: any, entry: string) => { pickerOpens.push(`${btn?.id}:${entry}`); },
    getChatRichComposerSelection: () => null,
    setChatRecipient: (target: string, r: any) => {
      recipients.push({ target, id: r?.id || '', name: r?.name || '' });
    },
    autoGrow: () => {},
    _focusInput: () => {},
    useAgent: async () => {},
  };
  context.window = context;
  vm.createContext(context);

  const driver = script.map((step) => {
    if (step.type === 'type') {
      return `__type(${JSON.stringify(step.text)});`;
    }
    if (step.type === 'atPick') {
      return `__type('@'); __at(); await __flush();`
        + ` await _triggerAgent(${JSON.stringify(step.id)}, ${JSON.stringify(step.name)}, ${JSON.stringify(chipId)});`;
    }
    return `_atKeyMark = null;`
      + ` await _triggerAgent(${JSON.stringify(step.id)}, ${JSON.stringify(step.name)}, ${JSON.stringify(chipId)});`;
  }).join('\n');

  const value = await vm.runInContext(`
    let _atKeyMark = null;
    ${EXTRACTED}
    const __ta = document.getElementById(${JSON.stringify(inputId)});
    const __opener = _atKeyOpener(${JSON.stringify(chipId)});
    const __type = (text) => {
      const at = __ta.selectionStart;
      __ta.value = __ta.value.slice(0, at) + text + __ta.value.slice(at);
      __ta.selectionStart = __ta.selectionEnd = at + text.length;
    };
    const __at = () => __opener({ key: '@', currentTarget: __ta });
    const __flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    (async () => {
      ${driver}
      return __ta.value;
    })()
  `, context);

  return { value, recipients, pickerOpens };
}

describe('inline @ mentions in the new-chat and project composers', () => {
  it('lets the new-chat composer name two agents in one message', async () => {
    const run = await runComposer('new-chat-input', 'new-chat-recipient-chip', [
      { type: 'atPick', id: 'a1', name: 'ContentWriter' },
      { type: 'type', text: '写一篇 orkas 介绍，' },
      { type: 'atPick', id: 'a2', name: 'PptMaker' },
      { type: 'type', text: '做成ppt' },
    ]);

    // Both assignees survive in the text the user sends — this is the whole
    // dispatch. A regression shows up as one name (or none) here.
    expect(run.value).toBe('@ContentWriter 写一篇 orkas 介绍，@PptMaker 做成ppt');
    // Neither pick may quietly re-point the single-recipient chip instead.
    expect(run.recipients).toEqual([]);
    expect(run.pickerOpens).toEqual([
      'new-chat-recipient-chip:at_key',
      'new-chat-recipient-chip:at_key',
    ]);
  });

  it('lets the project composer name two agents in one message', async () => {
    const run = await runComposer('project-chat-input', 'project-chat-recipient-chip', [
      { type: 'atPick', id: 'a1', name: 'Writing Helper' },
      { type: 'type', text: '起草，' },
      { type: 'atPick', id: 'a2', name: 'FamilyTutor' },
      { type: 'type', text: '审一遍' },
    ]);

    // Multi-word display names go in verbatim — the bus matches them by name.
    expect(run.value).toBe('@Writing Helper 起草，@FamilyTutor 审一遍');
    expect(run.recipients).toEqual([]);
  });

  it('inserts the commander alias like any other pick', async () => {
    const run = await runComposer('new-chat-input', 'new-chat-recipient-chip', [
      { type: 'atPick', id: '__commander__', name: 'Commander' },
      { type: 'type', text: '安排一下' },
    ]);

    expect(run.value).toBe('@commander 安排一下');
    expect(run.recipients).toEqual([]);
  });
});
