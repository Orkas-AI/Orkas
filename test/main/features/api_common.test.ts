import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getVersion: vi.fn(() => '2.0.0'),
  getCurrentLang: vi.fn((): string => 'en'),
  currentClientChannel: vi.fn(() => 'open'),
  desktopPlatform: vi.fn(() => 'mac'),
  osVersion: vi.fn(() => '15.5'),
}));

vi.mock('electron', () => ({ app: { getVersion: mocks.getVersion } }));
vi.mock('../../../src/main/i18n', () => ({ getCurrentLang: mocks.getCurrentLang }));
vi.mock('../../../src/main/features/client_channel', () => ({ currentClientChannel: mocks.currentClientChannel }));
vi.mock('../../../src/main/system_info', () => ({
  desktopPlatform: mocks.desktopPlatform,
  osVersion: mocks.osVersion,
}));

describe('api_common client metadata cache', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.getVersion.mockReturnValue('2.0.0');
    mocks.getCurrentLang.mockReturnValue('en');
    mocks.currentClientChannel.mockReturnValue('open');
    mocks.desktopPlatform.mockReturnValue('mac');
    mocks.osVersion.mockReturnValue('15.5');
  });

  it('resolves stable metadata once while reading language from memory per request', async () => {
    const apiCommon = await import('../../../src/main/features/api_common');

    const first = apiCommon.commonHeaders();
    mocks.getCurrentLang.mockReturnValue('zh');
    first['Orkas-App-Version'] = 'mutated-by-caller';
    const second = apiCommon.commonHeaders();

    expect(second).toMatchObject({
      'Orkas-App-Version': '2.0.0',
      'Orkas-Platform': 'mac',
      'Orkas-OS-Version': '15.5',
      'Orkas-Channel': 'open',
      'Accept-Language': 'zh',
    });
    expect(mocks.getVersion).toHaveBeenCalledTimes(1);
    expect(mocks.currentClientChannel).toHaveBeenCalledTimes(1);
    expect(mocks.desktopPlatform).toHaveBeenCalledTimes(1);
    expect(mocks.osVersion).toHaveBeenCalledTimes(1);
    expect(mocks.getCurrentLang).toHaveBeenCalledTimes(2);
  });
});
