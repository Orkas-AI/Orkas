import { beforeEach, describe, expect, it, vi } from 'vitest';

const trayMock = vi.hoisted(() => ({
  createFromPath: vi.fn(),
  isEmpty: vi.fn(),
  setTemplateImage: vi.fn(),
  construct: vi.fn(),
  setToolTip: vi.fn(),
  on: vi.fn(),
  destroy: vi.fn(),
  click: null as (() => void) | null,
}));

vi.mock('electron', () => ({
  nativeImage: { createFromPath: trayMock.createFromPath },
  Tray: class {
    constructor(image: unknown) { trayMock.construct(image); }
    setToolTip = trayMock.setToolTip;
    on = trayMock.on;
    destroy = trayMock.destroy;
  },
}));

import { createOptionalTray } from '../../../src/main/util/app-tray';

describe('optional desktop tray', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    trayMock.click = null;
    trayMock.isEmpty.mockReturnValue(false);
    trayMock.createFromPath.mockReturnValue({
      isEmpty: trayMock.isEmpty,
      setTemplateImage: trayMock.setTemplateImage,
    });
    trayMock.on.mockImplementation((event: string, callback: () => void) => {
      if (event === 'click') trayMock.click = callback;
    });
  });

  const create = (platform: NodeJS.Platform = 'win32', onActivate = vi.fn(), warn = vi.fn()) =>
    createOptionalTray({ platform, iconPath: '/app/icon.ico', displayName: 'Orkas', onActivate, warn });

  it('keeps a usable activation entry when the icon and tray are available', () => {
    const onActivate = vi.fn();
    expect(create('win32', onActivate)).not.toBeNull();
    expect(trayMock.createFromPath).toHaveBeenCalledWith('/app/icon.ico');
    expect(trayMock.setToolTip).toHaveBeenCalledWith('Orkas');
    expect(trayMock.click).not.toBeNull();
    trayMock.click?.();
    expect(onActivate).toHaveBeenCalledOnce();
    expect(trayMock.setTemplateImage).not.toHaveBeenCalled();
  });

  it('uses a template image only for the macOS menu bar', () => {
    expect(create('darwin')).not.toBeNull();
    expect(trayMock.setTemplateImage).toHaveBeenCalledWith(true);
  });

  it('leaves unsupported platforms alone', () => {
    expect(create('linux')).toBeNull();
    expect(trayMock.createFromPath).not.toHaveBeenCalled();
  });

  it('lets startup continue when the icon is missing or invalid', () => {
    const warn = vi.fn();
    trayMock.isEmpty.mockReturnValue(true);
    expect(create('win32', vi.fn(), warn)).toBeNull();
    expect(trayMock.construct).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('tray icon unavailable');
  });

  it('lets startup continue when creating the tray fails', () => {
    const warn = vi.fn();
    trayMock.construct.mockImplementationOnce(() => { throw new Error('native tray unavailable'); });
    expect(create('win32', vi.fn(), warn)).toBeNull();
    expect(warn).toHaveBeenCalledWith('tray unavailable');
  });

  it('contains a second failure while cleaning up a partially created tray', () => {
    const warn = vi.fn();
    trayMock.on.mockImplementationOnce(() => { throw new Error('registration failed'); });
    trayMock.destroy.mockImplementationOnce(() => { throw new Error('cleanup failed'); });
    expect(create('win32', vi.fn(), warn)).toBeNull();
    expect(trayMock.destroy).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith('tray unavailable');
  });

  it('contains a window activation failure so a later click can retry', () => {
    const warn = vi.fn();
    const onActivate = vi.fn()
      .mockImplementationOnce(() => { throw new Error('window unavailable'); })
      .mockImplementationOnce(() => {});
    expect(create('win32', onActivate, warn)).not.toBeNull();
    expect(() => trayMock.click?.()).not.toThrow();
    trayMock.click?.();
    expect(onActivate).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledExactlyOnceWith('tray activation unavailable');
  });
});
