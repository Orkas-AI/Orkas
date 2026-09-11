import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/conversation.js'), 'utf8');

function extractFunction(name: string): string {
  const marker = `function ${name}`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`missing ${name}`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

function loadCommentaryHarness() {
  const commentary: string[] = [];
  const cancel = vi.fn();
  const seal = vi.fn((msg) => {
    msg._commentaryBuf = '';
    msg._commentaryLine = null;
  });
  const complete = vi.fn();
  const paint = vi.fn((_msg, finalEl, text) => { finalEl.innerHTML = text; });
  const context = {
    _streamingAppendCommentaryDelta: (msg: any, text: string) => {
      commentary.push(text);
      msg.dataset.commentaryStreamed = '1';
      msg._commentaryBuf = String(msg._commentaryBuf || '') + text;
    },
    _sealStreamingCommentary: seal,
    _completeProcessDisclosure: complete,
    _isRepeatedPriorTurnCommentary: () => false,
    _cancelPendingStreamRaf: cancel,
    _streamingDisplayText: (value: string) => value,
    _paintStreamingFinalMarkdown: paint,
    requestAnimationFrame: (callback: () => void) => { callback(); return 1; },
    setTimeout,
  };
  const funcs = [
    extractFunction('_streamingFinalizeCommentary'),
    extractFunction('_streamingAppendFinalDelta'),
  ].join('\n');
  const api = vm.runInNewContext(`${funcs}\n({ finalize: _streamingFinalizeCommentary, append: _streamingAppendFinalDelta });`, context);
  return { ...api, commentary, cancel, seal, complete, paint };
}

describe('conversation commentary finalization', () => {
  it('normalizes newlines without collapsing markdown paragraph breaks', () => {
    const formatter = vm.runInNewContext(
      `${extractFunction('_formatStreamingCommentary')}\n_formatStreamingCommentary`,
    );

    expect(formatter('先检查实现。再补充测试！最后验证？')).toBe(
      '先检查实现。再补充测试！最后验证？',
    );
    expect(formatter('line one\r\nline two\rline three')).toBe('line one\nline two\nline three');
    // Commentary renders as markdown: collapsing '\n\n' would merge authored
    // paragraphs and turn a '---' thematic break into a setext underline that
    // promotes the preceding line to a heading.
    expect(formatter('已有一段。\n\n已有二段。')).toBe('已有一段。\n\n已有二段。');
    expect(formatter('核心判断\n\n---\n\n## 关键词矩阵')).toBe('核心判断\n\n---\n\n## 关键词矩阵');
  });

  it('keeps commentary in the process stream and starts body text only at final_answer', () => {
    const { finalize, append, commentary, cancel, complete, paint } = loadCommentaryHarness();
    const finalEl = { style: { display: 'none' }, innerHTML: '' };
    const msg: any = {
      dataset: {},
      querySelector: (selector: string) => selector === '[data-role="final"]' ? finalEl : null,
    };

    append(msg, 'live commentary', 'commentary');
    expect(commentary).toEqual(['live commentary']);
    expect(finalEl.style.display).toBe('none');

    finalize(msg, 'live commentary');
    append(msg, 'Final answer', 'final_answer');

    expect(commentary).toEqual(['live commentary']);
    expect(cancel).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();
    expect(msg.dataset.streamBuf).toBe('Final answer');
    expect(msg.dataset.finalText).toBe('Final answer');
    expect(finalEl.style.display).toBe('');
    expect(paint).toHaveBeenLastCalledWith(msg, finalEl, 'Final answer', { stickBottom: true });
  });

  it('is idempotent when a phase-transition event is replayed', () => {
    const { finalize, commentary, seal } = loadCommentaryHarness();
    const finalEl = { style: { display: '' }, innerHTML: 'commentary' };
    const msg: any = {
      dataset: { streamBuf: 'commentary' },
      querySelector: () => finalEl,
    };

    finalize(msg, 'commentary');
    finalize(msg, 'commentary');

    expect(commentary).toEqual(['commentary']);
    expect(seal).toHaveBeenCalledOnce();
    expect(msg.dataset.commentaryFinalized).toBe('1');
  });
});
