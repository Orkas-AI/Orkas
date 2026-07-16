import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.join(__dirname, '../..');
const conversationSource = fs.readFileSync(path.join(root, 'src/renderer/modules/conversation.js'), 'utf8');
const utilsSource = fs.readFileSync(path.join(root, 'src/renderer/modules/utils.js'), 'utf8');
const styleSource = fs.readFileSync(path.join(root, 'src/renderer/style.css'), 'utf8');

describe('conversation image layout stability', () => {
  it('reserves a stable shell for markdown and attachment images', () => {
    expect(utilsSource).toContain('chat-image-shell chat-md-img-shell is-loading');
    expect(conversationSource).toContain('chat-image-shell chat-msg-attach-thumb-shell is-loading');
    expect(styleSource).toContain('.chat-md-img-shell {');
    expect(styleSource).toContain('.chat-msg-attach-thumb-shell {');
    expect(styleSource).toContain('aspect-ratio: 4 / 3;');
    expect(styleSource).toContain('object-fit: contain;');
  });

  it('shows a skeleton until load settles and preserves pinned-bottom behavior', () => {
    expect(utilsSource).toContain("document.addEventListener('load'");
    expect(utilsSource).toContain("new CustomEvent('chat-image-settled', { bubbles: true })");
    expect(styleSource).toContain('.chat-image-shell.is-loading::after');
    expect(styleSource).toContain('@keyframes chat-image-placeholder-shimmer');
    expect(conversationSource).toContain("document.addEventListener('chat-image-settled'");
    expect(conversationSource).toContain('if (msg) _stickBottomFromMsg(msg);');
  });

  it('collapses a failed markdown image shell to the existing missing-image chip', () => {
    expect(utilsSource).toContain("img.closest?.('.chat-md-img-shell')");
    expect(utilsSource).toContain('(shell || img).replaceWith(chip)');
  });
});
