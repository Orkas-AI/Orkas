import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ALLOWED_EXTENSIONS as CHAT_ATTACHMENT_EXTENSIONS } from '../../src/main/features/chat_attachments';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const policy = require('../../src/renderer/modules/file-operation-policy.js') as {
  canAddToChat: (name: string) => boolean;
  canAddToLibrary: (name: string, options?: { projectScoped?: boolean }) => boolean;
  canShare: (name: string) => boolean;
};

describe('file operation policy', () => {
  it('loads before every renderer consumer', () => {
    const index = fs.readFileSync(path.join(__dirname, '../../src/renderer/index.html'), 'utf8');
    const policyTag = index.indexOf('<script src="./modules/file-operation-policy.js"></script>');
    expect(policyTag).toBeGreaterThan(-1);
    expect(policyTag).toBeLessThan(index.indexOf('<script src="./modules/chat-file-viewer.js"></script>'));
    expect(policyTag).toBeLessThan(index.indexOf('<script src="./modules/conversation-info.js"></script>'));
  });

  it.each([
    'note.md', 'data.json', 'report.pdf', 'document.docx', 'sheet.xlsx', 'slides.pptx',
    'photo.png', 'clip.mp4', 'voice.mp3',
  ])('allows supported chat attachment %s', (name) => {
    expect(policy.canAddToChat(name)).toBe(true);
  });

  it('matches the main-process chat attachment allow-list', () => {
    for (const ext of CHAT_ATTACHMENT_EXTENSIONS) {
      expect(policy.canAddToChat(`attachment${ext}`), ext).toBe(true);
    }
  });

  it.each([
    'page.html', 'style.css', 'script.js', 'source.py', 'archive.zip', 'legacy.doc',
    'vector.svg', 'font.woff2', 'module.wasm',
  ])('does not advertise Add to chat for unsupported %s', (name) => {
    expect(policy.canAddToChat(name)).toBe(false);
  });

  it.each([
    'note.md', 'page.html', 'style.css', 'script.js', 'source.py', 'report.pdf',
    'document.docx', 'sheet.xlsx', 'slides.pptx', 'photo.png',
  ])('allows common Library file %s', (name) => {
    expect(policy.canAddToLibrary(name)).toBe(true);
  });

  it('allows video only for a project-scoped Library', () => {
    expect(policy.canAddToLibrary('clip.mp4')).toBe(false);
    expect(policy.canAddToLibrary('clip.mp4', { projectScoped: true })).toBe(true);
    expect(policy.canAddToLibrary('voice.mp3', { projectScoped: true })).toBe(false);
  });

  it.each(['archive.zip', 'legacy.doc', 'vector.svg', 'font.woff2', 'module.wasm'])(
    'rejects unsupported Library file %s',
    (name) => {
      expect(policy.canAddToLibrary(name, { projectScoped: true })).toBe(false);
    },
  );

  it('shares UTF-8 text/code families only', () => {
    expect(policy.canShare('note.md')).toBe(true);
    expect(policy.canShare('page.html')).toBe(true);
    expect(policy.canShare('style.css')).toBe(true);
    expect(policy.canShare('source.py')).toBe(true);
    expect(policy.canShare('photo.png')).toBe(false);
    expect(policy.canShare('report.pdf')).toBe(false);
    expect(policy.canShare('clip.mp4')).toBe(false);
  });

  it('is case-insensitive and does not infer a type without an extension', () => {
    expect(policy.canAddToChat('REPORT.PDF')).toBe(true);
    expect(policy.canAddToLibrary('PHOTO.PNG')).toBe(true);
    expect(policy.canShare('SOURCE.TS')).toBe(true);
    expect(policy.canAddToChat('README')).toBe(false);
  });
});
