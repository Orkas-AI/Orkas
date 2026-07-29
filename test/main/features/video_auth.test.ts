import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  profiles: [] as Array<{
    id: string;
    provider: string;
    model: string;
    apiKey: string;
    label: string;
    createdAt: number;
  }>,
}));

vi.mock('../../../src/main/features/auth', () => ({
  loadVideoProfiles: () => mocks.profiles.map((profile) => ({ ...profile })),
  saveVideoProfiles: (profiles: typeof mocks.profiles) => {
    mocks.profiles = profiles.map((profile) => ({ ...profile }));
  },
}));

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  addVideoProfile,
  flattenVideoProviderOptions,
  listVideoProfiles,
  removeVideoProfile,
  reorderVideoProfiles,
} from '../../../src/main/features/video_auth';

beforeEach(() => {
  mocks.profiles = [];
});

describe('video auth profiles', () => {
  it('rejects unsupported or incomplete BYO profiles without persisting credentials', () => {
    expect(addVideoProfile({
      provider: 'doubao',
      model: 'retired-model',
      apiKey: 'must-not-be-stored',
    })).toEqual({
      ok: false,
      error: 'unsupported video model "doubao/retired-model"',
    });
    expect(addVideoProfile({
      provider: 'doubao',
      model: 'doubao-seedance-2-0-260128',
      apiKey: '',
    })).toEqual({ ok: false, error: 'apiKey required' });
    expect(mocks.profiles).toEqual([]);
  });

  it('keeps explicit ordering and bounded labels deterministic', () => {
    const first = addVideoProfile({
      provider: 'doubao',
      model: 'doubao-seedance-2-0-260128',
      apiKey: 'first',
      label: `  ${'x'.repeat(60)}  `,
    });
    const second = addVideoProfile({
      provider: 'doubao',
      model: 'doubao-seedance-2-0-260128',
      apiKey: 'second',
      label: 'second',
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    reorderVideoProfiles([first.id, second.id]);
    expect(listVideoProfiles().map((profile) => profile.id)).toEqual([
      first.id,
      second.id,
    ]);
    expect(listVideoProfiles()[0]?.label).toHaveLength(40);

    expect(removeVideoProfile(second.id)).toEqual({ ok: true });
    expect(listVideoProfiles().map((profile) => profile.id)).toEqual([first.id]);
  });

  it('exposes the concrete open-source video model in the picker', () => {
    const options = flattenVideoProviderOptions([
      { id: 'doubao', label: 'DouBao' },
    ]);

    expect(options[0]).toMatchObject({
      id: 'doubao',
      provider: 'doubao',
      model: 'doubao-seedance-2-0-260128',
    });
  });
});
