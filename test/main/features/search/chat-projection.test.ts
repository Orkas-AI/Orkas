import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { historyRecordText } from '../../../../src/main/features/chat-history-records';
import { projectChatSnippet } from '../../../../src/main/features/search/snippet';
import { tokenize } from '../../../../src/main/features/search/tokenize';
import { buildChatProjection, projectEncodedChatSnippet } from '../../../../src/main/features/search/chat-projection';

// Persisted v2 fixtures are independent of the encoder. A well-formed envelope
// makes each malformed-header/body case reach the boundary named by the case.
function envelope(header: unknown, block: Buffer): Buffer {
  const encoded = Buffer.from(JSON.stringify(header));
  const length = Buffer.alloc(4); length.writeUInt32LE(encoded.length);
  return Buffer.concat([length, encoded, block]);
}
function fixture(overrides: Record<string, unknown> = {}, body: unknown = ['needle']) {
  const block = deflateRawSync(JSON.stringify(body));
  return envelope({ version: 2, visible: true, parts: [[0, block.length]], process: [], ...overrides }, block);
}

// The source projector is the independent, pre-existing display contract.
describe('durable search text projection', () => {
  it('preserves source text, exact snippets and original public process positions for any query', () => {
    const records = [
      { id: 'unicode', text: 'İstanbul 电商领域\n\t🧾 ' + 'tail '.repeat(30), attachments: [{ name: '商品报告' }], process: [
        { type: 'event', event: { stream: 'thinking', data: { output: 'PRIVATE 电商领域' } } },
        { type: 'progress', text: '电商市场总结' },
        { type: 'event', event: { stream: 'tool', data: { output: '电商领域 alpha beta' } } },
        { type: 'progress', text: 'alpha beta later tie' },
        { type: 'event', event: { stream: 'cli', data: { type: 'tool-event', input: { query: 'quotes " and \\ slash' } } } },
      ] },
      { content: 'legacy photo data:image/png;base64,c2VjcmV0', produced: [{ mimeType: 'image/png', data: 'SECRET' }] },
      { text: 'hidden', dispatch: true }, { text: 'deleted', deleted_at: 't' },
      { text: ' \n\t ' }, { process: [{ type: 'event', event: { stream: 'reasoning', data: { text: 'PRIVATE' } } }] },
    ];
    for (const record of records) {
      const projection = buildChatProjection(record);
      expect(projection.text).toBe(historyRecordText(record, true));
      expect(projection.payload).toBeDefined();
      for (const query of ['电商领域', 'alpha beta', 'missing', 'İstanbul', 'photo', 'quotes', '']) {
        expect(projectEncodedChatSnippet(projection.payload!, tokenize(query))).toEqual(projectChatSnippet(record, tokenize(query)));
      }
      expect(projection.text).not.toContain('PRIVATE');
      expect(projection.text).not.toContain('SECRET');
    }
  });

  it('omits private execution payloads from the stored projection instead of just compressing them', () => {
    const record = { text: '电商领域结论', process: [
      { type: 'event', event: { stream: 'thinking', data: { text: 'PRIVATE '.repeat(1_000_000) } } },
      { type: 'progress', text: '公开执行证据' },
    ] };
    const projection = buildChatProjection(record);
    expect(projection.payload!.length).toBeLessThan(1024);
    expect(projectEncodedChatSnippet(projection.payload!, tokenize('证据'))).toEqual(projectChatSnippet(record, tokenize('证据')));
  });

  it('reads the supported persisted format independently of the current encoder', () => {
    expect(projectEncodedChatSnippet(fixture(), ['needle'])).toEqual({ snippet: 'needle', visible: true });
  });
});

it('keeps large public trails cached and preserves a late process match across block boundaries', () => {
  const record = { text: '电商领域结论', process: [
    ...Array.from({ length: 160 }, (_, i) => ({ type: 'progress', text: `step ${i} ` + 'public '.repeat(16_000) })),
    { type: 'progress', text: 'lateboundary 电商领域' },
  ] };
  const projection = buildChatProjection(record);
  expect(Buffer.byteLength(projection.text)).toBeGreaterThan(16 * 1024 * 1024);
  expect(projection.payload).toBeDefined();
  for (const query of ['电商领域', 'lateboundary', 'absent', 'step']) {
    const tokens = tokenize(query);
    expect(projectEncodedChatSnippet(projection.payload!, tokens)).toEqual(projectChatSnippet(record, tokens));
  }
});

it.each([
  ['unsupported version', () => fixture({ version: 999 })],
  ['invalid visibility', () => fixture({ visible: 'yes' })],
  ['invalid message identity', () => fixture({ msg_id: 12 })],
  ['invalid directory', () => fixture({ parts: 'invalid' })],
  ['negative block offset', () => fixture({ parts: [[-1, 1]] })],
  ['fractional block offset', () => fixture({ parts: [[0.5, 1]] })],
  ['invalid filter', () => fixture({ process: [[0, 1, 'invalid']] })],
  ['non-text public part', () => fixture({}, [12])],
  ['invalid process position', () => {
    const block = deflateRawSync(JSON.stringify([[-1, 'needle']]));
    return envelope({ version: 2, visible: true, parts: [], process: [[0, block.length]] }, block);
  }],
  ['truncated block', () => { const valid = fixture(); return valid.subarray(0, valid.length - 1); }],
  ['corrupt compressed block', () => {
    const valid = fixture(); valid.fill(255, 4 + valid.readUInt32LE(0)); return valid;
  }],
] as const)('treats %s as a cache miss', (_name, payload) => {
  expect(projectEncodedChatSnippet(payload(), ['needle'])).toBeUndefined();
});

it('rejects valid but oversized stored, header and inflated data before returning a summary', () => {
  const valid = fixture();
  const oversized = Buffer.alloc(16 * 1024 * 1024 + 1); valid.copy(oversized);
  expect(projectEncodedChatSnippet(oversized, ['needle'])).toBeUndefined();
  // Whitespace is valid JSON; without the header bound this is a valid hit.
  const headerSize = 1024 * 1024 + 1;
  const header = Buffer.alloc(4 + headerSize, ' '); header.writeUInt32LE(headerSize);
  valid.copy(header, 4, 4, 4 + valid.readUInt32LE(0));
  expect(projectEncodedChatSnippet(Buffer.concat([header, valid.subarray(4 + valid.readUInt32LE(0))]), ['needle'])).toBeUndefined();
  // Valid JSON distinguishes the inflate guard from an unrelated parse error.
  const inflated = fixture({}, ['needle ' + 'x'.repeat(64 * 1024 * 1024)]);
  expect(projectEncodedChatSnippet(inflated, ['needle'])).toBeUndefined();
});
