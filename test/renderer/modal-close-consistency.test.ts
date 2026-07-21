import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.join(__dirname, '../..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const indexSource = read('src/renderer/index.html');
const styleSource = read('src/renderer/style.css');
const backdropDismissSources = [
  read('src/renderer/modules/library-transfer.js'),
  read('src/renderer/modules/conversation.js'),
  read('src/renderer/modules/search.js'),
];
const dialogSources = [
  read('src/renderer/modules/library-transfer.js'),
  read('src/renderer/modules/memory.js'),
  read('src/renderer/modules/project-detail.js'),
  read('src/renderer/modules/conversation.js'),
  read('src/renderer/modules/chat-file-viewer.js'),
  read('src/renderer/modules/chat-lightbox.js'),
  read('src/renderer/modules/chat-artifact.js'),
  read('src/renderer/modules/saved-apps.js'),
];

describe('modal close control consistency', () => {
  it('does not dismiss the audited dialogs from a backdrop click', () => {
    for (const source of backdropDismissSources) {
      expect(source).not.toMatch(/event\.target\s*===\s*overlay|e\.target\s*===\s*overlay/);
    }
  });

  it('defines one shared close-button and icon treatment', () => {
    expect(styleSource).toContain('.modal-close-btn {');
    expect(styleSource).toContain('.modal-close-btn:hover:not(:disabled)');
    expect(styleSource).toContain('.modal-close-btn:focus-visible');
    expect(styleSource).toContain('.modal-close-icon {');
  });

  it('uses the shared control in static and dynamically mounted dialogs', () => {
    expect(indexSource).toContain('class="modal-close-btn project-library-modal-close"');
    for (const source of dialogSources) {
      expect(source).toContain('modal-close-btn');
      expect(source).toContain('modal-close-icon');
    }
  });

  it('keeps viewer function buttons on the same small corner radius', () => {
    expect(styleSource).toMatch(/\.chat-lightbox-add-library,\s*\.chat-lightbox-reveal\s*\{[\s\S]*?border-radius: 8px;/);
    expect(styleSource).toMatch(/\.chat-file-viewer-md-actions \.ctx-viewer-action-icon-btn\s*\{[\s\S]*?border-radius: 8px;/);
    expect(styleSource).toMatch(/\.chat-file-viewer-add-library,\s*\.chat-file-viewer-save-app,\s*\.chat-file-viewer-reveal\s*\{[\s\S]*?border-radius: 8px;/);
  });

  it('uses one title, body, and action-button sizing contract', () => {
    expect(styleSource).toMatch(/\.modal-title\s*\{[\s\S]*?font-size:\s*16px;[\s\S]*?font-weight:\s*600;[\s\S]*?line-height:\s*1\.4;/);
    expect(styleSource).toMatch(/\.modal-body\s*\{[\s\S]*?font-size:\s*14px;[\s\S]*?line-height:\s*1\.6;/);
    expect(styleSource).toMatch(/\.modal-actions \.btn,[\s\S]*?min-width:\s*76px;[\s\S]*?min-height:\s*36px;[\s\S]*?padding:\s*0 16px;[\s\S]*?font-size:\s*13px;/);
  });
});
