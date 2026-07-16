import { describe, expect, it } from 'vitest';

import { selectVisibleProducedFiles } from '../../../src/main/features/produced_files';

describe('produced file presentation', () => {
  it('keeps an ordinary ambiguous deliverable when there is no export signal', () => {
    expect(selectVisibleProducedFiles(['/workspace/report.md'])).toEqual(['/workspace/report.md']);
    expect(selectVisibleProducedFiles(['/workspace/tool.py'])).toEqual(['/workspace/tool.py']);
  });

  it('shows document exports instead of their source and rendering assets', () => {
    expect(selectVisibleProducedFiles([
      '/workspace/report.md',
      '/workspace/assets/chart.png',
      '/workspace/report.docx',
      '/workspace/report.pdf',
    ])).toEqual([
      '/workspace/report.docx',
      '/workspace/report.pdf',
    ]);
  });

  it('shows a rendered video and subtitle instead of composition assets', () => {
    expect(selectVisibleProducedFiles([
      '/workspace/composition.html',
      '/workspace/frame.png',
      '/workspace/final.mp4',
      '/workspace/final.srt',
    ])).toEqual([
      '/workspace/final.mp4',
      '/workspace/final.srt',
    ]);
  });

  it('shows final images instead of generated metadata', () => {
    expect(selectVisibleProducedFiles([
      '/workspace/metadata.json',
      '/workspace/cover.png',
      '/workspace/cover.webp',
    ])).toEqual([
      '/workspace/cover.png',
      '/workspace/cover.webp',
    ]);
  });

  it('removes obvious process paths and technical files', () => {
    expect(selectVisibleProducedFiles([
      '/workspace/tmp/render.json',
      '/workspace/preview-slide.png',
      '/workspace/run.log',
      '/workspace/result.csv',
    ])).toEqual(['/workspace/result.csv']);
  });

  it('does not treat a process-like workspace ancestor as a file role', () => {
    expect(selectVisibleProducedFiles([
      '/Users/test/work/project/result.json',
      'C:\\Users\\example\\temp\\project\\report.md',
    ])).toEqual([
    '/Users/test/work/project/result.json',
      'C:\\Users\\example\\temp\\project\\report.md',
    ]);
  });

  it('deduplicates exact paths while preserving the original order', () => {
    expect(selectVisibleProducedFiles([
      '/workspace/a.json',
      '/workspace/a.json',
      '/workspace/b.json',
    ])).toEqual(['/workspace/a.json', '/workspace/b.json']);
  });

  it('lets an explicit current-turn declaration override every heuristic', () => {
    expect(selectVisibleProducedFiles([
      '/workspace/source.md',
      '/workspace/manifest.json',
      '/workspace/export.pdf',
    ], [
      '/workspace/manifest.json',
      '/workspace/source.md',
      '/workspace/not-produced.zip',
    ])).toEqual([
      '/workspace/manifest.json',
      '/workspace/source.md',
    ]);
  });

  it('distinguishes no declaration from an explicit empty declaration', () => {
    const paths = [
      '/workspace/script.md',
      '/workspace/shotlist.json',
    ];

    expect(selectVisibleProducedFiles(paths)).toEqual(paths);
    expect(selectVisibleProducedFiles(paths, [])).toEqual([]);
  });
});
