import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/conversation.js'), 'utf8');
const styleSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/style.css'), 'utf8');

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
      'html', 'htm',
      'svg', 'png', 'jpg', 'jpeg', 'webp', 'gif',
      'mp4', 'mov', 'webm',
      'md', 'txt', 'json',
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
  it('keeps chat bubbles capped at 10 files and expands overflow in place', () => {
    expect(source).toContain('const _PRODUCED_VISIBLE_LIMIT = 10;');
    expect(source).toContain("row.classList.add('is-expanded')");
    expect(source).not.toContain("window.ConversationInfo.openAndSetTab('files')");
    expect(styleSource).toContain('.chat-msg-produced.is-expanded');
    expect(styleSource).toContain('max-height: 168px;');
    expect(styleSource).toContain('overflow-y: auto;');
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
});
