import { beforeEach, describe, expect, it, vi } from 'vitest';

const trayMock = vi.hoisted(() => ({
  buildFromTemplate: vi.fn(template => ({ items: template })),
  popUpContextMenu: vi.fn(),
  events: {} as Record<string, () => void>,
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
  Menu: { buildFromTemplate: trayMock.buildFromTemplate },
  nativeImage: { createFromPath: trayMock.createFromPath },
  Tray: class {
    constructor(image: unknown) { trayMock.construct(image); }
    popUpContextMenu = trayMock.popUpContextMenu;
    setToolTip = trayMock.setToolTip;
    on = trayMock.on;
    destroy = trayMock.destroy;
  },
}));

import { createOptionalTray } from '../../../src/main/util/app-tray';

describe('optional desktop tray', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    trayMock.events = {};
    trayMock.buildFromTemplate.mockImplementation(template => ({ items: template }));
    trayMock.click = null;
    trayMock.isEmpty.mockReturnValue(false);
    trayMock.createFromPath.mockReturnValue({
      isEmpty: trayMock.isEmpty,
      setTemplateImage: trayMock.setTemplateImage,
    });
    trayMock.on.mockImplementation((event: string, callback: () => void) => {
      trayMock.events[event] = callback;
      if (event === 'click') trayMock.click = callback;
    });
  });

  const quit = vi.fn();
  let labels = { open: '打开', quit: '退出' };
  const create = (platform: NodeJS.Platform = 'win32', onActivate = vi.fn(), warn = vi.fn()) =>
    createOptionalTray({ platform, iconPath: '/app/icon.ico', displayName: 'Orkas', onActivate, onQuit: quit, labels: () => labels, warn });

  it.each(['darwin', 'win32'] as const)('offers exactly Open and Quit for left and right clicks on %s; opening never quits', platform => {
    labels = { open: '打开', quit: '退出' };
    const onActivate = vi.fn(); expect(create(platform, onActivate)).not.toBeNull();
    for (const event of ['click', 'right-click']) {
      trayMock.events[event]();
      const menu = trayMock.popUpContextMenu.mock.calls.at(-1)![0];
      expect(menu.items.map(item => item.label)).toEqual(['打开', '退出']);
      expect(onActivate).not.toHaveBeenCalled(); expect(quit).not.toHaveBeenCalled();
      menu.items[0].click(); expect(onActivate).toHaveBeenCalledOnce(); onActivate.mockClear();
    }
    labels = { open: 'Open', quit: 'Quit' }; trayMock.events.click();
    const menu = trayMock.popUpContextMenu.mock.calls.at(-1)![0];
    expect(menu.items.map(item => item.label)).toEqual(['Open', 'Quit']);
    menu.items[1].click(); expect(quit).toHaveBeenCalledOnce(); expect(onActivate).not.toHaveBeenCalled();
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

  it('keeps both actions unexecuted after a native popup failure and allows the next click to retry', () => {
    const warn = vi.fn(), activate = vi.fn();
    create('win32', activate, warn);
    trayMock.popUpContextMenu.mockImplementationOnce(() => { throw new Error('controlled popup failure'); });
    trayMock.events.click();
    expect(activate).not.toHaveBeenCalled(); expect(quit).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledExactlyOnceWith('tray menu unavailable');
    trayMock.events['right-click']();
    expect(trayMock.popUpContextMenu).toHaveBeenCalledTimes(2);
    trayMock.popUpContextMenu.mock.calls.at(-1)![0].items[0].click();
    expect(activate).toHaveBeenCalledOnce(); expect(quit).not.toHaveBeenCalled();
  });

  it('contains a window activation failure so a later click can retry', () => {
    const warn = vi.fn();
    const onActivate = vi.fn()
      .mockImplementationOnce(() => { throw new Error('window unavailable'); })
      .mockImplementationOnce(() => {});
    expect(create('win32', onActivate, warn)).not.toBeNull();
    trayMock.click?.();
    const activate = trayMock.popUpContextMenu.mock.calls.at(-1)![0].items[0].click;
    expect(() => activate()).not.toThrow();
    activate();
    expect(onActivate).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledExactlyOnceWith('tray activation unavailable');
  });

  it('keeps Quit retryable even when both shutdown initiation and its diagnostic fail', () => {
    const warn = vi.fn(() => { throw new Error('controlled diagnostic failure'); });
    quit.mockImplementationOnce(() => { throw new Error('controlled quit failure'); });
    const activate = vi.fn();
    expect(create('win32', activate, warn)).not.toBeNull();
    trayMock.events['right-click']();
    const requestQuit = trayMock.popUpContextMenu.mock.calls.at(-1)![0].items[1].click;
    expect(() => requestQuit()).not.toThrow();
    expect(warn).toHaveBeenCalledExactlyOnceWith('tray quit unavailable');
    expect(activate).not.toHaveBeenCalled();
    trayMock.events.click();
    trayMock.popUpContextMenu.mock.calls.at(-1)![0].items[1].click();
    expect(quit).toHaveBeenCalledTimes(2);
    expect(activate).not.toHaveBeenCalled();
  });
});
