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
