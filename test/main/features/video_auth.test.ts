import { generateKeyPairSync } from 'node:crypto';
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
  listVideoModelOptions,
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
    expect(options).toHaveLength(6);
    expect(listVideoProviderOptions().map((option) => option.id)).toEqual(['orkas-api', 'doubao', 'minimax', 'vidu', 'kling', 'google', 'google-cloud', 'aliyun', 'runway']);
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
 ['doubao','doubao-seedance-2-5-260628'],['doubao','doubao-seedance-2-5-flash'],['doubao','doubao-seedance-2-0-260128'],['doubao','doubao-seedance-2-0-fast-260128'],['doubao','doubao-seedance-2-0-mini'],
 ['minimax','MiniMax-H3'],['minimax','MiniMax-H3-Highspeed'],['minimax','MiniMax-H3-Lite'],['minimax','MiniMax-H3-Max'],['vidu','viduq3-pro'],['vidu','viduq3-turbo'],['kling','kling-v4-0'],['kling','kling-v4-0-flash'],['google','gemini-omni-1.1-flash'],['google-cloud','veo-3.1-generate-001'],['google-cloud','veo-3.1-fast-generate-001'],['google-cloud','veo-3.1-lite-generate-001'],['runway','gen4.5'],['aliyun','wan3.0-video'],['aliyun','wan3.0-video-prime'],
 ];
  it.each(supported)('saves a selected %s model and returns its saved identity', (provider, model) => {
    const apiKey = provider === 'google-cloud' ? JSON.stringify({type:'service_account',project_id:'fixture-project',client_email:'video@fixture-project.iam.gserviceaccount.com',private_key:generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'})}) : 'fixture-user-key';
    const result = addVideoProfile({provider,model,apiKey,label:'My video service',...(provider==='aliyun'?{workspaceId:'fixture-workspace',region:'ap-southeast-1'}:{})});
    expect(result.ok).toBe(true);
    expect(listVideoProfiles()).toEqual([expect.objectContaining({provider,model,label:'My video service'})]);
  });
  it('returns every concrete BYO choice while preserving the public API entry', () => {
    const choices = flattenVideoProviderOptions(listVideoProviderOptions());
    expect(choices.map(p=>[p.provider,p.model])).toEqual([
      ['orkas-api','orkas-video'], ...supported.filter(([provider])=>provider!=='aliyun'&&provider!=='runway'), ...supported.filter(([provider])=>provider==='aliyun'), ['runway','gen4.5'],
    ]);
    expect(choices.filter(p=>p.provider==='doubao').map(p=>p.id)).toEqual([
      'doubao:doubao-seedance-2-5-260628','doubao:doubao-seedance-2-5-flash','doubao:doubao-seedance-2-0-260128','doubao:doubao-seedance-2-0-fast-260128','doubao:doubao-seedance-2-0-mini',
    ]);
    expect(choices.some(p=>p.provider==='orkas-video')).toBe(false);
  });
  it('rejects a foreign provider/model pairing and missing user key before saving', () => {
    expect(addVideoProfile({provider:'google',model:'gen4.5',apiKey:'fixture'}).ok).toBe(false);
    expect(addVideoProfile({provider:'google',model:'gemini-omni-1.1-flash',apiKey:''})).toEqual({ok:false,error:'apiKey required'});
    expect(mocks.profiles).toEqual([]);
  });
});

describe('current video configuration identities',()=>{
it.each([
    ['minimax', 'MiniMax-H3', 'https://platform.minimax.cn/docs/guides/quickstart-preparation'],
    ['vidu', 'viduq3-pro', 'https://platform.vidu.cn/'],
    ['kling', 'kling-v4-0', 'https://app.klingai.com/cn/dev'],
  ])('creates domestic %s credentials without changing existing international profiles', (provider, model, docs) => {
    const retained = { id: 'retained', provider, model, apiKey: 'old-key', label: 'old', createdAt: 1 };
    mocks.profiles = [retained];
    expect(addVideoProfile({ provider, model, apiKey: 'new-key' })).toMatchObject({ ok: true });
    expect(listVideoProfiles()).toContainEqual(expect.objectContaining({ provider, model, apiKey: 'new-key', apiSite: 'cn' }));
    expect(listVideoProfiles()).toContainEqual(retained);
    expect(listVideoProviderOptions().find(option => option.id === provider)?.docs).toBe(docs);
  });
it('uses complete model names in the catalog and picker without changing option identities', () => {
    const expected = [
      ['doubao', 'Doubao Seedance 2.5', 'Doubao Seedance 2.5 Flash', 'Doubao Seedance 2.0', 'Doubao Seedance 2.0 Fast', 'Doubao Seedance 2.0 Mini'],
      ['minimax', 'MiniMax H3', 'MiniMax H3 Highspeed', 'MiniMax H3 Lite', 'MiniMax H3 Max'],
      ['vidu', 'Vidu Q3 Pro', 'Vidu Q3 Turbo'],
      ['kling', 'Kling 4.0', 'Kling 4.0 Flash'],
      ['google', 'Google Gemini Omni 1.1 Flash'],
      ['google-cloud', 'Google Cloud Veo 3.1', 'Google Cloud Veo 3.1 Fast', 'Google Cloud Veo 3.1 Lite'],
      ['runway', 'Runway Gen-4.5'],
      ['aliyun', 'Alibaba Cloud Wan 3.0', 'Alibaba Cloud Wan 3.0 Prime'],
    ];
    const options = flattenVideoProviderOptions(listVideoProviderOptions());
    expect(options.filter(option => option.provider !== 'orkas-api')).toHaveLength(20);
    for (const [provider, ...names] of expected) {
      const models = listVideoModelOptions(provider);
      expect(models.map(model => model.name)).toEqual(names);
      expect(options.filter(option => option.provider === provider).map(option => option.label)).toEqual(names);
      for (const model of models) {
        expect(options).toContainEqual(expect.objectContaining({ provider, model: model.id,
          id: models.length === 1 ? provider : `${provider}:${model.id}` }));
      }
    }
    expect(options[0]).toMatchObject({ id: 'orkas-api', label: 'Orkas · Video' });
  });
it.each([
    { provider: 'aliyun', model: 'wan3.0-video', apiKey: 'fixture-key' },
    { provider: 'aliyun', model: 'wan3.0-video-prime', apiKey: 'fixture-key', workspaceId: 'workspace123', region: 'foreign.invalid' },
    { provider: 'google-cloud', model: 'veo-3.1-fast-generate-001', apiKey: '{"private_key":"private-invalid-key"}' },
    { provider: 'google', model: 'veo-3.1-generate-preview', apiKey: 'legacy-key' },
  ])('does not persist incomplete, unsafe or retired provider configuration: %j', input => {
    const result = addVideoProfile(input);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('private-invalid-key');
    expect(mocks.profiles).toEqual([]);
  });
});

it('keeps saved Hailuo and Kling Turbo identities without offering them as new profiles',()=>{
 const retained=[{id:'hailuo',provider:'minimax',model:'MiniMax-Hailuo-2.3',apiKey:'saved-key',label:'old',createdAt:1},{id:'turbo',provider:'kling',model:'kling-v3-0-turbo',apiKey:'saved-key',label:'old',createdAt:2}];
 mocks.profiles=retained;expect(listVideoProfiles()).toEqual(retained);for(const item of retained)expect(addVideoProfile({...item,apiKey:'new-key'}).ok).toBe(false);expect(listVideoProfiles()).toEqual(retained);
});
