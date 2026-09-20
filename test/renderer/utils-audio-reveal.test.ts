import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/utils.js'), 'utf8');
const locales = Object.fromEntries(['en', 'zh', 'ja', 'pt'].map(lang => [
  lang, JSON.parse(fs.readFileSync(path.join(__dirname, `../../src/renderer/locales/${lang}.json`), 'utf8')),
]));

function loadAudio(lang = 'en') {
  const clicks: Array<(event: unknown) => unknown> = [];
  const openFileMenu = vi.fn().mockResolvedValue(undefined);
  const alert = vi.fn().mockResolvedValue(undefined);
  const context = vm.createContext({
    URL,
    window: { ConversationInfo: { openFileMenu } },
    currentCid: 'audio-conversation',
    t: (key: string) => locales[lang][key] || key,
    uiAlert: alert,
    document: {
      addEventListener(type: string, listener: (event: unknown) => unknown) {
        if (type === 'click') clicks.push(listener);
      },
    },
  });
  vm.runInContext(source, context);
  const render = (markdown: string) => context.inlineFormat(markdown) as string;
  const audio = { pause: vi.fn(), removeAttribute: vi.fn(), load: vi.fn(), closest: () => null };
  const card = { querySelector: () => audio, remove: vi.fn() };
  const buttonFor = (src: string) => ({
    closest: () => card,
    disabled: false,
    getAttribute: (key: string) => key === 'data-audio-src' ? src : null,
  });
  const click = (button: ReturnType<typeof buttonFor> | null) => {
    const event = {
      target: { closest: (selector: string) => selector === '[data-chat-md-audio-menu="1"]' ? button : null },
      preventDefault: vi.fn(), stopPropagation: vi.fn(),
    };
    return { event, done: Promise.all(clicks.map(listener => listener(event))) };
  };
  return { context, render, buttonFor, click, openFileMenu, alert, audio, card };
}

describe('inline audio file menu', () => {
  it.each([
    ['[Listen](</tmp/My clip.mp3>)', '/tmp/My clip.mp3'],
    ['![Listen](file:///tmp/clip.wav)', '/tmp/clip.wav'],
    ['[Listen](sandbox:/tmp/clip.ogg)', '/tmp/clip.ogg'],
    ['[Listen](chat-media://local/C:/Users/Alice/My%20clip.mp3)', 'C:/Users/Alice/My clip.mp3'],
    ['[Listen](chat-media://local/tmp/%E8%AF%95%E5%90%AC%23%22.mp3)', '/tmp/试听#".mp3'],
  ])('opens the shared menu for the exact local file from %s while keeping playback available', async (markdown, expectedPath) => {
    const runtime = loadAudio();
    const html = runtime.render(markdown);
    expect(html).toContain('data-chat-md-audio-menu="1"');
    expect(html).toContain('<audio class="chat-md-audio" controls');
    const src = /data-audio-src="([^"]+)"/.exec(html)?.[1];
    expect(src).toBeTruthy();
    const button = runtime.buttonFor(src!);
    const { event, done } = runtime.click(button);
    await done;
    expect(runtime.openFileMenu).toHaveBeenCalledExactlyOnceWith(button, expectedPath, expectedPath.split('/').pop(), {
      cid: 'audio-conversation', onDeleted: expect.any(Function),
    });
    expect(runtime.audio.pause).not.toHaveBeenCalled();
    expect(runtime.card.remove).not.toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(button.disabled).toBe(false);
    expect(runtime.alert).not.toHaveBeenCalled();
  });

  it.each([
    'https://example.com/clip.mp3', 'blob:https://example.com/clip.mp3',
    'chat-media://cid/conversation/clip.mp3', 'chat-media://local.example/tmp/clip.mp3',
    'chat-media://local@evil.example/tmp/clip.mp3', 'chat-media://user@local/tmp/clip.mp3',
    'chat-media://local:123/tmp/clip.mp3', 'chat-media://local/tmp/%ZZ.mp3',
    'chat-media://local/tmp/%00.mp3',
  ])('offers no folder action or filesystem call for %s', async src => {
    const runtime = loadAudio();
    expect(runtime.render(`[Listen](${src})`)).not.toContain('data-chat-md-audio-menu');
    await runtime.click(runtime.buttonFor(src)).done;
    expect(runtime.openFileMenu).not.toHaveBeenCalled();
  });

  it.each(['en', 'zh', 'ja', 'pt'])('uses the existing %s action label and language-refresh attributes', lang => {
    const runtime = loadAudio(lang);
    const html = runtime.render('[Listen](/tmp/clip.mp3)');
    expect(html).toContain(`aria-label="${locales[lang]['contexts.menu.more_actions']}"`);
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).not.toContain('data-chat-md-audio-reveal');
    expect(html).toContain('data-i18n-aria-label="contexts.menu.more_actions"');
    expect(html).toContain('data-i18n-title="contexts.menu.more_actions"');
  });

  it('stops and releases audio only after the shared deletion flow confirms success', async () => {
    const runtime = loadAudio();
    await runtime.click(runtime.buttonFor('chat-media://local/tmp/clip.mp3')).done;
    expect(runtime.card.remove).not.toHaveBeenCalled();
    const options = runtime.openFileMenu.mock.calls[0][3];
    options.onDeleted();
    expect(runtime.audio.pause).toHaveBeenCalledOnce();
    expect(runtime.audio.removeAttribute).toHaveBeenCalledWith('src');
    expect(runtime.audio.load).toHaveBeenCalledOnce();
    expect(runtime.card.remove).toHaveBeenCalledOnce();
  });

  it('ignores repeat clicks while the menu opens and leaves playback control clicks native', async () => {
    const runtime = loadAudio();
    let resolve!: (value: unknown) => void;
    runtime.openFileMenu.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const button = runtime.buttonFor('chat-media://local/tmp/clip.mp3');
    const first = runtime.click(button);
    expect(button.disabled).toBe(true);
    await runtime.click(button).done;
    expect(runtime.openFileMenu).toHaveBeenCalledTimes(1);
    resolve({ ok: true });
    await first.done;
    expect(button.disabled).toBe(false);
    const nativeClick = runtime.click(null);
    await nativeClick.done;
    expect(nativeClick.event.preventDefault).not.toHaveBeenCalled();
    expect(runtime.openFileMenu).toHaveBeenCalledTimes(1);
  });
});
