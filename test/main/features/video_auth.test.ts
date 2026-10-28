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
  listVideoProviderOptions,
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
      provider: 'orkas-api',
      model: 'orkas-video',
      apiKey: '',
    })).toEqual({ ok: false, error: 'apiKey required' });
    expect(mocks.profiles).toEqual([]);
  });

  it('keeps explicit ordering and bounded labels deterministic', () => {
    const first = addVideoProfile({
      provider: 'orkas-api',
      model: 'orkas-video',
      apiKey: 'first',
      label: `  ${'x'.repeat(60)}  `,
    });
    const second = addVideoProfile({
      provider: 'orkas-api',
      model: 'orkas-video',
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
      { id: 'orkas-api', label: 'Orkas' },
      { id: 'doubao', label: 'DouBao' },
    ]);

    expect(options[0]).toMatchObject({
      id: 'orkas-api',
      provider: 'orkas-api',
      model: 'orkas-video',
      label: 'Orkas · Video',
    });
    expect(options).toHaveLength(4);
    expect(listVideoProviderOptions().map((option) => option.id)).toEqual(['orkas-api', 'doubao', 'minimax', 'vidu', 'kling', 'google', 'runway']);
  });
});

 it('retains legacy credentials for removal but refuses new unsupported video profiles', () => {
    mocks.profiles = [{ id: 'legacy', provider: 'legacy-provider', model: 'retired-model', apiKey: 'legacy-key', label: 'Legacy', createdAt: 1 }];
    expect(addVideoProfile({ provider: 'legacy-provider', model: 'retired-model', apiKey: 'new-key' })).toMatchObject({ ok: false });
    expect(listVideoProfiles()).toEqual(mocks.profiles);
    expect(listVideoProfiles()).toHaveLength(1);
    expect(removeVideoProfile('legacy')).toEqual({ ok: true });
    expect(listVideoProfiles()).toEqual([]);
 });


describe('public BYO video capability parity', () => {
  const supported = [
    ['doubao','doubao-seedance-2-0-260128'], ['doubao','doubao-seedance-2-0-fast-260128'],
    ['doubao','doubao-seedance-2-0-mini'], ['minimax','MiniMax-Hailuo-2.3'],
    ['vidu','viduq3-pro'], ['kling','kling-v3-0-turbo'],
    ['google','veo-3.1-generate-preview'], ['runway','gen4.5'],
  ];
  it.each(supported)('saves a selected %s model and returns its saved identity', (provider, model) => {
    const result = addVideoProfile({provider,model,apiKey:'fixture-user-key',label:'My video service'});
    expect(result.ok).toBe(true);
    expect(listVideoProfiles()).toEqual([expect.objectContaining({provider,model,label:'My video service'})]);
  });
  it('returns every concrete BYO choice while preserving the public API entry', () => {
    const choices = flattenVideoProviderOptions(listVideoProviderOptions());
    expect(choices.map(p=>[p.provider,p.model])).toEqual([
      ['orkas-api','orkas-video'], ...supported,
    ]);
    expect(choices.filter(p=>p.provider==='doubao').map(p=>p.id)).toEqual([
      'doubao:doubao-seedance-2-0-260128','doubao:doubao-seedance-2-0-fast-260128','doubao:doubao-seedance-2-0-mini',
    ]);
    expect(choices.some(p=>p.provider==='orkas-video')).toBe(false);
  });
  it('rejects a foreign provider/model pairing and missing user key before saving', () => {
    expect(addVideoProfile({provider:'google',model:'gen4.5',apiKey:'fixture'}).ok).toBe(false);
    expect(addVideoProfile({provider:'google',model:'veo-3.1-generate-preview',apiKey:''})).toEqual({ok:false,error:'apiKey required'});
    expect(mocks.profiles).toEqual([]);
  });
});
