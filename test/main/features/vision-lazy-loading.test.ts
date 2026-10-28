import { expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ loads: 0, calls: vi.fn() }));
vi.mock('../../../src/main/model/client', () => {
  runtime.loads++;
  return { chatWithModel: runtime.calls };
});
vi.mock('../../../src/main/util/image-transform', () => ({
  LIBRARY_IMAGE_TRANSFORM_OPTIONS: {},
  toCompressedJpeg: async () => ({ buf: Buffer.from('jpeg') }),
}));
vi.mock('../../../src/main/prompts/loader', () => ({ prompts: { load: () => 'describe image' } }));

import { describeLibraryImage } from '../../../src/main/features/library_image_describer';
import { analyzeFrames } from '../../../src/main/features/video_vision';

it('keeps image/video surfaces usable without loading the model until real vision input arrives', async () => {
  expect(runtime.loads).toBe(0);
  expect(await analyzeFrames({ userId: 'u', framePaths: [], question: 'describe' }))
    .toMatchObject({ ok: false, reason: 'no-frames' });
  expect(runtime.loads).toBe(0);
  runtime.calls.mockResolvedValue({ ok: true, text: 'Visible image', error: '', aborted: false });
  expect(await describeLibraryImage('u', 'image.png', Buffer.from('image'))).toBe('Visible image');
  expect(await analyzeFrames({ userId: 'u', framePaths: ['frame.png'], question: 'describe',
    loadFrames: async () => [{ data: 'anBlZw==', mediaType: 'image/jpeg' }] }))
    .toMatchObject({ ok: true, text: 'Visible image', framesUsed: 1 });
  expect(runtime.loads).toBe(1);
  expect(runtime.calls).toHaveBeenCalledTimes(2);
});
