import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.join(__dirname, '../..');
const conversationSource = fs.readFileSync(path.join(root, 'src/renderer/modules/conversation.js'), 'utf8');
const utilsSource = fs.readFileSync(path.join(root, 'src/renderer/modules/utils.js'), 'utf8');
const styleSource = fs.readFileSync(path.join(root, 'src/renderer/style.css'), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { _chatImageIntrinsicStyle } = require('../../src/renderer/modules/utils.js') as {
  _chatImageIntrinsicStyle: (width: number, height: number) => {
    naturalWidth: string;
    aspectRatio: string;
  } | undefined;
};

describe('conversation image layout stability', () => {
  it('reserves a stable shell for markdown and attachment images', () => {
    expect(utilsSource).toContain('chat-image-shell chat-md-img-shell is-loading');
    expect(conversationSource).toContain('chat-image-shell chat-msg-attach-thumb-shell is-loading');
    expect(styleSource).toContain('.chat-md-img-shell {');
    expect(styleSource).toContain('.chat-msg-attach-thumb-shell {');
    expect(styleSource).toContain('width: min(var(--chat-image-natural-width, 640px), 640px, 100%);');
    expect(styleSource).toContain('aspect-ratio: var(--chat-image-aspect-ratio, 4 / 3);');
    expect(styleSource).toContain('object-fit: contain;');
  });

  it('shows a skeleton until load settles and preserves pinned-bottom behavior', () => {
    expect(utilsSource).toContain("document.addEventListener('load'");
    expect(utilsSource).toContain("new CustomEvent('chat-image-settled', { bubbles: true })");
    expect(utilsSource).toContain('img?.naturalWidth');
    expect(utilsSource).toContain("shell.style.setProperty('--chat-image-aspect-ratio'");
    expect(styleSource).toContain('.chat-image-shell.is-loading::after');
    expect(styleSource).toContain('@keyframes chat-image-placeholder-shimmer');
    expect(conversationSource).toContain("document.addEventListener('chat-image-settled'");
    expect(conversationSource).toContain('if (msg) _stickBottomFromMsg(msg);');
  });

  it.each([
    ['landscape', 1600, 900, '1600px', '1600 / 900'],
    ['portrait', 900, 1600, '900px', '900 / 1600'],
    ['square', 1600, 1600, '1600px', '1600 / 1600'],
    ['small image', 96, 64, '96px', '96 / 64'],
  ])('switches a loaded %s markdown image to its intrinsic dimensions', (
    _label,
    width,
    height,
    naturalWidth,
    aspectRatio,
  ) => {
    expect(_chatImageIntrinsicStyle(width, height)).toEqual({ naturalWidth, aspectRatio });
  });

  it.each([
    ['zero width', 0, 600],
    ['zero height', 600, 0],
    ['negative width', -1, 600],
    ['non-finite width', Number.POSITIVE_INFINITY, 600],
    ['not-a-number height', 600, Number.NaN],
  ])('keeps the fallback shell for %s', (_label, width, height) => {
    expect(_chatImageIntrinsicStyle(width, height)).toBeUndefined();
  });

  it('collapses a failed markdown image shell to the existing missing-image chip', () => {
    expect(utilsSource).toContain("img.closest?.('.chat-md-img-shell')");
    expect(utilsSource).toContain('(shell || img).replaceWith(chip)');
  });
});
