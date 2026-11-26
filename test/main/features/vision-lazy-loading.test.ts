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

it('keeps the image library usable without loading the model until a real image arrives', async () => {
  expect(runtime.loads).toBe(0);
  runtime.calls.mockResolvedValue({ ok: true, text: 'Visible image', error: '', aborted: false });
  expect(await describeLibraryImage('u', 'image.png', Buffer.from('image'))).toBe('Visible image');
  expect(runtime.loads).toBe(1);
  expect(runtime.calls).toHaveBeenCalledTimes(1);
});
