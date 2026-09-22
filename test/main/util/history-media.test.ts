import { describe, expect, it } from 'vitest';
import * as host from '../../../src/main/util/history-media';
import * as core from '../../../src/core-agent/src/shared/history-media';

describe('historical inline media projection', () => {
  it.each([host, core])('omits image/video data but preserves prose, locators and unrelated encodings', project => {
    const text = 'before ![chart](data:image/png;base64,aGVsbG8=) /work/chart.png '
      + '<video src="data:video/mp4;codecs=avc1;base64,dmlkZW8="></video> after '
      + 'https://example.test/video.mp4 data:text/plain;base64,aGVsbG8= ordinary=aGVsbG8= data:image/png;base64,';
    const result = project.projectHistoryMediaText(text);
    expect(result).toContain('[inline image/png data omitted from history]');
    expect(result).toContain('[inline video/mp4 data omitted from history]');
    expect(result).toContain('/work/chart.png');
    expect(result).toContain('https://example.test/video.mp4');
    expect(result).toContain('data:text/plain;base64,aGVsbG8= ordinary=aGVsbG8= data:image/png;base64,');
    expect(result).not.toContain('dmlkZW8=');
    expect(project.projectHistoryMediaText(result)).toBe(result);
  });

  it.each([host, core])('projects recognized structured media without mutating original evidence', project => {
    const value = { path: '/work/chart.png', content: [
      { type: 'image', mimeType: 'image/png', data: 'IMAGE_BYTES' },
      { source: { type: 'base64', media_type: 'video/mp4', data: 'VIDEO_BYTES' } },
      { type: 'text', text: '{"mimeType":"image/jpeg","data":"NESTED_BYTES","path":"/work/frame.jpg"}' },
      { data: 'ORDINARY_DATA', mimeType: 'application/json' },
    ] };
    const original = JSON.stringify(value);
    const result = project.stringifyHistoryMedia(value);
    expect(result).not.toMatch(/IMAGE_BYTES|VIDEO_BYTES|NESTED_BYTES/);
    expect(result).toContain('/work/frame.jpg');
    expect(result).toContain('ORDINARY_DATA');
    expect(JSON.stringify(value)).toBe(original);
    expect(project.projectHistoryMediaText(original)).toBe(result);
  });

  it('keeps synchronous host and ESM projections identical, with no normal JSON reformatting', () => {
    for (const text of [
      'A long normal reply. '.repeat(1000),
      '{ "path": "image/chart.png", "value": 7 }',
      '{ "data": "ordinary", "url": "https://example.test/video/mp4" }',
      'data:image/png;base64,' + 'AAAA'.repeat(100_000) + ' END',
      JSON.stringify({ output: JSON.stringify({ mimeType: 'image/png', data: 'AAAA' }) }),
      'data:image/png;base64,QUJD==" suffix data:video/webm;base64,REVG==',
    ]) expect(host.projectHistoryMediaText(text)).toBe(core.projectHistoryMediaText(text));
    const normal = '{ "url": "https://example.test/video/mp4", "data": "KEEP" }';
    expect(host.projectHistoryMediaText(normal)).toBe(normal);
  });
});
