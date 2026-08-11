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
  const progress: Array<{ text: string; kind: string }> = [];
  const cancel = vi.fn();
  const paint = vi.fn((_msg, finalEl, text) => { finalEl.innerHTML = text; });
  const context = {
    _streamingAppendProgress: (_msg: unknown, text: string, kind: string) => progress.push({ text, kind }),
    _isRepeatedPriorTurnCommentary: () => false,
    _cancelPendingStreamRaf: cancel,
    _stripSkillCreateBlocksForStream: (value: string) => value,
    _stripAgentCreateBlocksForStream: (value: string) => value,
    _stripAutoTaskBlocksForStream: (value: string) => value,
    _stripAgentFormBlockForStream: (value: string) => value,
    _stripDashboardBlocksForStream: (value: string) => value,
    _stripSkillFileBlocksForStream: (value: string) => value,
    _paintStreamingFinalMarkdown: paint,
    requestAnimationFrame: (callback: () => void) => { callback(); return 1; },
    setTimeout,
  };
  const funcs = [
    extractFunction('_streamingFinalizeCommentary'),
    extractFunction('_streamingAppendFinalDelta'),
  ].join('\n');
  const api = vm.runInNewContext(`${funcs}\n({ finalize: _streamingFinalizeCommentary, append: _streamingAppendFinalDelta });`, context);
  return { ...api, progress, cancel, paint };
}

describe('conversation commentary finalization', () => {
  it('formats multilingual commentary as readable sentence paragraphs', () => {
    const formatter = vm.runInNewContext(
      `${extractFunction('_formatStreamingCommentary')}\n_formatStreamingCommentary`,
    );

    expect(formatter('先检查实现。再补充测试！最后验证？')).toBe(
      '先检查实现。\n\n再补充测试！\n\n最后验证？',
    );
    expect(formatter('First inspect the implementation. Then add tests! Finally verify it.')).toBe(
      'First inspect the implementation.\n\nThen add tests!\n\nFinally verify it.',
    );
    expect(formatter('実装を確認します。次にテストを追加します。')).toBe(
      '実装を確認します。\n\n次にテストを追加します。',
    );
    expect(formatter('已有一段。\n\n已有二段。')).toBe('已有一段。\n\n已有二段。');
  });

  it('moves commentary into process and starts final text from an empty body', () => {
    const { finalize, append, progress, cancel, paint } = loadCommentaryHarness();
    const finalEl = { style: { display: '' }, innerHTML: 'live commentary' };
    const msg: any = {
      dataset: {
        streamBuf: 'live commentary',
        finalText: 'live commentary',
        streamDisplay: 'live commentary',
        streamPaintedDisplay: 'live commentary',
      },
      querySelector: (selector: string) => selector === '[data-role="final"]' ? finalEl : null,
    };

    finalize(msg, 'live commentary');
    append(msg, 'Final answer');

    expect(progress).toEqual([{ text: 'live commentary', kind: 'think' }]);
    expect(cancel).toHaveBeenCalledOnce();
    expect(msg.dataset.streamBuf).toBe('Final answer');
    expect(msg.dataset.finalText).toBe('Final answer');
    expect(finalEl.style.display).toBe('');
    expect(paint).toHaveBeenLastCalledWith(msg, finalEl, 'Final answer', { stickBottom: true });
  });

  it('is idempotent when a phase-transition event is replayed', () => {
    const { finalize, progress } = loadCommentaryHarness();
    const finalEl = { style: { display: '' }, innerHTML: 'commentary' };
    const msg: any = {
      dataset: { streamBuf: 'commentary' },
      querySelector: () => finalEl,
    };

    finalize(msg, 'commentary');
    finalize(msg, 'commentary');

    expect(progress).toHaveLength(1);
    expect(msg.dataset.commentaryFinalized).toBe('1');
  });
});
