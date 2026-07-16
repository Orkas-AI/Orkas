import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/conversation.js'), 'utf8');
const styleSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/style.css'), 'utf8');
const conversationInfoSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/conversation-info.js'), 'utf8');
const viewerSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/chat-file-viewer.js'), 'utf8');
const utilsSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/utils.js'), 'utf8');

function extractFunction(name: string): string {
  const marker = `function ${name}`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`missing ${name}`);
  const braceStart = source.indexOf('{', start);
  if (braceStart < 0) throw new Error(`missing body for ${name}`);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

function loadOrderProducedPaths(): (paths: string[]) => Array<{ path: string; base: string; i: number }> {
  const rank = extractFunction('_producedDeliverableRank');
  const specificity = extractFunction('_producedPathSpecificity');
  const order = extractFunction('_orderProducedPaths');
  return vm.runInNewContext(`
    const _PRODUCED_DELIVERABLE_EXTS = new Set([
      'pptx', 'ppt', 'key',
      'docx', 'doc', 'pages',
      'xlsx', 'xls', 'numbers', 'csv',
      'pdf',
      'zip',
    ]);
    ${rank}
    ${specificity}
    ${order}
    _orderProducedPaths;
  `, {});
}

describe('conversation produced chips', () => {
  it('renders every deliverable inside a height-capped scrolling footer', () => {
    expect(source).not.toContain('_PRODUCED_VISIBLE_LIMIT');
    expect(source).not.toContain('chat-msg-produced-more');
    expect(styleSource).toContain('max-height: min(102px, 36vh);');
    expect(styleSource).toContain('overflow-y: auto;');
    expect(styleSource).toContain('overscroll-behavior: auto;');
  });

  it('mounts compact file rows with a separate trailing menu at the bottom of the bubble', () => {
    expect(source).toContain('function _mountMessageProducedFooter');
    expect(source).toContain('bubble.appendChild(node)');
    expect(source).toContain('<div class="chat-msg-produced-item"');
    expect(source).toContain('class="chat-msg-produced-main"');
    expect(source).toContain('class="chat-msg-produced-menu-btn"');
    expect(styleSource).toContain('.chat-msg-produced {');
    expect(styleSource).toContain('flex-direction: column;');
    expect(styleSource).toContain('border-top: 1px solid rgba(148, 163, 184, 0.2);');
    expect(styleSource).toContain('width: 100%;');
  });

  it('reuses the task-detail Files menu for produced-file actions', () => {
    expect(source).toContain('window.ConversationInfo.openFileMenu(menuBtn, p, base');
    expect(conversationInfoSource).toContain('function openFileMenu(anchorBtn, absPath, displayName, options = {})');
    expect(conversationInfoSource).toContain("data-action=\"add-to-chat\"");
    expect(conversationInfoSource).toContain("data-action=\"add-to-library\"");
    expect(conversationInfoSource).toContain("data-action=\"delete\"");
  });

  it('dedupes same-basename chips to the more specific final path', () => {
    const orderProducedPaths = loadOrderProducedPaths();
    const stale = '/Users/test/.orkas/userWorkSpace/task/projects/business_planning.md';
    const final = '/Users/test/.orkas/userWorkSpace/task/projects/ppt169_business_planning_ppt169_20260616/sources/business_planning.md';

    const ordered = orderProducedPaths([stale, final]);

    expect(ordered).toHaveLength(1);
    expect(ordered[0].base).toBe('business_planning.md');
    expect(ordered[0].path).toBe(final);
  });

  it('keeps the later path when duplicate basenames have equal specificity', () => {
    const orderProducedPaths = loadOrderProducedPaths();

    const ordered = orderProducedPaths([
      '/workspace/a/report.md',
      '/workspace/b/report.md',
    ]);

    expect(ordered).toHaveLength(1);
    expect(ordered[0].path).toBe('/workspace/b/report.md');
  });
});

describe('chat video layout', () => {
  it('reserves a stable 16:9 slot for inline chat videos', () => {
    expect(styleSource).toContain('.chat-md-video-shell');
    expect(styleSource).toContain('aspect-ratio: 16 / 9;');
    expect(styleSource).toContain('width: min(640px, 100%);');
    expect(styleSource).toContain('.chat-msg-attach-video-shell');
  });

  it('wires bubble and floating-player surfaces to the shared playback toggle', () => {
    expect(source).toContain('data-chat-video-playback-surface="attachment_bubble"');
    expect(utilsSource).toContain('data-chat-video-playback-surface="markdown_bubble"');
    expect((viewerSource.match(/data-chat-video-playback-surface="floating_player"/g) || [])).toHaveLength(2);
    expect(utilsSource).toContain("target.closest('[data-chat-video-playback-surface]')");
    expect(utilsSource).toContain('_toggleChatVideoFromSurface(e, surface)');
  });
});
