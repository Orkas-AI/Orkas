import { describe, expect, it } from 'vitest';
import * as host from '../../../src/main/util/history-text-window';
import * as core from '../../../src/core-agent/src/shared/history-text-window';
import { estimateBudgetTokens } from '../../../src/main/util/token-estimate';

const render = (texts: string[]) => (first: number, boundary?: string) => texts.slice(first)
  .map((text, index) => ({ role: 'user', content: [{ type: 'text', text: index === 0 ? boundary ?? text : text }] }));
const estimate = (value: unknown) => estimateBudgetTokens(JSON.stringify(value));

describe('history text suffix fitting', () => {
  it.each([host, core])('preserves recent evidence and a partial older message within serialized capacity', impl => {
    const texts = ['OLD_BEGIN ' + 'a'.repeat(80_000) + ' OLD_END', 'NEW_BEGIN ' + 'b'.repeat(80_000) + ' NEW_END'];
    const original = [...texts];
    const result = impl.fitHistoryTextSuffix(texts, 30_000, render(texts), estimate, []);
    expect(estimate(result)).toBeLessThanOrEqual(30_000);
    expect(estimate(result)).toBeGreaterThan(29_900);
    expect(result).toHaveLength(2);
    expect(result[0].content[0].text).not.toContain('OLD_BEGIN');
    expect(result[0].content[0].text).toContain('OLD_END');
    expect(result[1].content[0].text).toBe(texts[1]);
    expect(texts).toEqual(original);
  });

  it.each([host, core])('leaves small input unchanged and drops impossible framing without mutating sources', impl => {
    const texts = ['first', 'second'];
    expect(impl.fitHistoryTextSuffix(texts, 100, render(texts), estimate, [])).toEqual(render(texts)(0));
    for (const budget of [0, 1, 2, 3]) expect(impl.fitHistoryTextSuffix(texts, budget, render(texts), estimate, [])).toEqual([]);
  });

  it('keeps host/core parity and safe Unicode boundaries for mixed prose, digits and JSON escapes', () => {
    const corpora = ['界🙂abc123456789\n"\\'.repeat(600), '🙂'.repeat(500), '\n\t"\\'.repeat(500)];
    for (const body of corpora) for (const budget of [40, 41, 42, 99, 100, 101, 999]) {
      const texts = ['old', body + ' END'];
      const actual = host.fitHistoryTextSuffix(texts, budget, render(texts), estimate, []);
      expect(actual).toEqual(core.fitHistoryTextSuffix(texts, budget, render(texts), estimate, []));
      if (actual.length) {
        expect(estimate(actual)).toBeLessThanOrEqual(budget);
        const text = actual[0].content[0].text;
        expect(text).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
        expect(JSON.stringify(actual)).toContain('END');
      }
    }
  });
});
