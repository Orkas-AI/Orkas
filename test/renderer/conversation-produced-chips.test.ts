// Produced-deliverable presentation at the bottom of an assistant bubble.
//
// Two user outcomes are protected here:
//
//   1. Every file the turn delivered is reachable from chat. The renderer used
//      to re-rank and de-duplicate the main process's selection by basename, so
//      a turn that wrote `a/report.md` and `b/report.md` rendered ONE chip and
//      the other file could not be opened from the conversation at all.
//   2. Generated image / video / audio is visible without depending on the
//      model. Presentation used to require the model pasting a `chat-media://`
//      markdown link for its own output; when it skipped that, the user got a
//      grey chip and never saw the result. The host renders the preview now,
//      and must NOT add a second copy when the model did paste one.
//
// Media markup and URL encoding come from the real `utils.js` helpers rather
// than stubs, so these cases fail if either side of the duplicate check drifts.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const utils = require('../../src/renderer/modules/utils.js');

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

/** Pull a `const NAME = [...]` line straight from production so the kind
 *  tables under test are the shipped ones, not a copy that can drift. */
function extractConstLine(name: string): string {
  const line = source.split('\n').find((row) => row.startsWith(`const ${name} = `));
  if (!line) throw new Error(`missing const ${name}`);
  return line;
}

type ProducedRenderers = {
  renderMedia: (paths: string[], alreadyShown: Set<string>) => string;
  renderChips: (paths: string[]) => string;
  mediaPathKey: (absPath: string) => string;
};

function loadProducedRenderers(): ProducedRenderers {
  const context: Record<string, unknown> = {
    // Real implementations — the media shapes and the URL encoding are the
    // behaviour under test, not fixtures.
    _normalizeLocalMediaSrc: utils._normalizeLocalMediaSrc,
    _markdownImageHtml: utils._markdownImageHtml,
    _markdownVideoHtml: utils._markdownVideoHtml,
    _markdownAudioHtml: utils._markdownAudioHtml,
    escapeHtml: utils.escapeHtml,
    // Chrome the chip row needs but whose content carries no contract here.
    t: (key: string) => key,
    _uiIconHtml: () => '',
    _iconForProduced: () => '',
  };
  vm.createContext(context);
  vm.runInContext(`
    ${extractConstLine('CHAT_IMAGE_EXTS')}
    ${extractConstLine('CHAT_VIDEO_EXTS')}
    ${extractConstLine('CHAT_AUDIO_EXTS')}
    ${extractFunction('_chatAttachExtOf')}
    ${extractFunction('_chatAttachKindFromExt')}
    ${extractFunction('_producedBaseName')}
    ${extractFunction('_producedMediaPathKey')}
    ${extractFunction('_renderProducedMediaHtml')}
    ${extractFunction('_renderMessageProducedHtml')}
  `, context);
  return {
    renderMedia: context._renderProducedMediaHtml as ProducedRenderers['renderMedia'],
    renderChips: context._renderMessageProducedHtml as ProducedRenderers['renderChips'],
    mediaPathKey: context._producedMediaPathKey as ProducedRenderers['mediaPathKey'],
  };
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
    expect(source).toContain('const appendBeforeCreatedResources = (child) => {');
    expect(source).toContain('appendBeforeCreatedResources(node);');
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

  // The regression this replaces: basename de-duplication kept ONE of these
  // and the other file had no chip, no menu, and no way to be opened.
  it('keeps same-basename deliverables from different directories reachable', () => {
    const { renderChips } = loadProducedRenderers();

    const html = renderChips(['/workspace/a/report.md', '/workspace/b/report.md']);

    expect(html.match(/chat-msg-produced-item/g) || []).toHaveLength(2);
    expect(html).toContain('data-produced-path="/workspace/a/report.md"');
    expect(html).toContain('data-produced-path="/workspace/b/report.md"');
  });

  it('preserves the main process deliverable order instead of re-ranking it', () => {
    const { renderChips } = loadProducedRenderers();

    const html = renderChips(['/workspace/notes.md', '/workspace/deck.pptx']);

    // `notes.md` led on input, so it must lead on screen. The removed renderer
    // ranking floated Office/PDF/archive extensions to the front, contradicting
    // features/produced_files.ts::selectVisibleProducedFiles.
    expect(html.indexOf('notes.md')).toBeLessThan(html.indexOf('deck.pptx'));
  });
});

describe('produced media preview', () => {
  it('renders a player for generated media the reply text never embedded', () => {
    const { renderMedia } = loadProducedRenderers();

    const html = renderMedia(
      ['/workspace/cover.png', '/workspace/promo.mp4', '/workspace/vo.mp3'],
      new Set(),
    );

    expect(html).toContain('chat-msg-produced-media');
    expect(html).toContain('class="chat-md-img"');
    expect(html).toContain('class="chat-md-video"');
    expect(html).toContain('class="chat-md-audio"');
    expect(html).toContain('chat-media://local/workspace/cover.png');
  });

  it('skips a file the bubble already presents so the model does not get a duplicate', () => {
    const { renderMedia, mediaPathKey } = loadProducedRenderers();

    const html = renderMedia(
      ['/workspace/cover.png', '/workspace/second.png'],
      new Set([mediaPathKey('/workspace/cover.png')]),
    );

    expect(html).not.toContain('cover.png');
    expect(html).toContain('second.png');
  });

  // The duplicate check compares decoded absolute paths because the main
  // process and the renderer percent-encode differently: main escapes `!'()*`
  // (util/chat-media-url.ts) while `_normalizeLocalMediaSrc` leaves them alone.
  // Comparing URL strings would let a parenthesised filename through twice.
  it('matches the same file across both media URL encoders', () => {
    const { mediaPathKey } = loadProducedRenderers();
    const abs = '/workspace/report(1).png';

    const rendererUrl = utils._normalizeLocalMediaSrc(abs);
    const mainStyleUrl = `chat-media://local/workspace/report%281%29.png?v=17-19-42`;

    expect(rendererUrl).not.toBe(mainStyleUrl);
    expect(mediaPathKey(utils._chatMediaLocalPathFromUrl(rendererUrl))).toBe(mediaPathKey(abs));
    expect(mediaPathKey(utils._chatMediaLocalPathFromUrl(mainStyleUrl))).toBe(mediaPathKey(abs));
  });

  it('leaves documents and archives to the chip row', () => {
    const { renderMedia } = loadProducedRenderers();

    expect(renderMedia(['/workspace/TARGETS.md', '/workspace/plan.pdf', '/workspace/out.zip'], new Set()))
      .toBe('');
  });

  // Quote and share carry the reply's own content. The chip row was already
  // excluded as host chrome; the host-rendered preview is the same chrome for
  // the same files, and `_markdownAudioHtml` renders a visible filename, so
  // leaving it in would put a stray file name into a quoted or shared reply.
  it('stays out of quoted reply content, like the chip row', () => {
    const quoteSelectors = source
      .split('\n')
      .filter((line) => line.includes('.chat-msg-produced,'));
    expect(quoteSelectors.length).toBeGreaterThan(0);
    for (const line of quoteSelectors) {
      expect(line).toContain('.chat-msg-produced-media');
    }
  });

  it('mounts the preview above the deliverable rows, guarded by the same idempotency marker', () => {
    expect(source).toContain('function _renderProducedMediaHtml');
    expect(source).toContain('function _bubbleRenderedMediaPaths');
    // Media block is appended first so the reading order stays
    // "reply text -> what it produced -> the file rows".
    expect(source.indexOf('if (mediaNode) appendBeforeCreatedResources(mediaNode);'))
      .toBeLessThan(source.indexOf('appendBeforeCreatedResources(node);'));
    expect(source).toContain("if (!bubble || bubble.querySelector('.chat-msg-produced')) return;");
    expect(styleSource).toContain('.chat-msg-produced-media {');
  });
});

// A minimal element graph with real parent/child links. `closest` and
// `querySelector` are implemented generically over that graph rather than
// answering for the case under test — the repo has no DOM implementation and
// PC/CLAUDE.md rules out adding one for a test.
type El = {
  classes: string[];
  parent: El | null;
  children: El[];
  closest(selector: string): El | null;
  querySelector(selector: string): El | null;
  remove(): void;
  attached(): boolean;
};

function el(classes: string, children: El[] = []): El {
  const node: El = {
    classes: classes.split(/\s+/).filter(Boolean),
    parent: null,
    children,
    closest(selector) {
      const wanted = selector.split(',').map((s) => s.trim().replace(/^\./, ''));
      let cursor: El | null = this;
      while (cursor) {
        if (wanted.some((cls) => cursor!.classes.includes(cls))) return cursor;
        cursor = cursor.parent;
      }
      return null;
    },
    querySelector(selector) {
      const wanted = selector.split(',').map((s) => s.trim().replace(/^\./, ''));
      for (const child of this.children) {
        if (wanted.some((cls) => child.classes.includes(cls))) return child;
        const nested = child.querySelector(selector);
        if (nested) return nested;
      }
      return null;
    },
    remove() {
      if (!this.parent) return;
      this.parent.children = this.parent.children.filter((c) => c !== this);
      this.parent = null;
    },
    attached() {
      let cursor: El | null = this;
      while (cursor.parent) cursor = cursor.parent;
      return cursor !== this;
    },
  };
  for (const child of children) child.parent = node;
  return node;
}

describe('produced preview that cannot load', () => {
  // Reopening an old conversation whose workspace was since cleaned must not
  // grow one "Image missing" tombstone per generated file. The chip row below
  // is the durable record and reports the deletion when clicked.
  it('removes the host preview instead of leaving a placeholder', () => {
    const img = el('chat-md-img');
    const shell = el('chat-image-shell chat-md-img-shell', [img]);
    const host = el('chat-msg-produced-media', [shell]);
    const bubble = el('chat-bubble', [host]);

    expect(utils._dropFailedProducedPreview(img)).toBe(true);
    expect(host.attached()).toBe(false);
    expect(bubble.children).toHaveLength(0);
  });

  it('keeps the host block when a sibling preview still loads', () => {
    const failing = el('chat-md-video');
    const failingShell = el('chat-md-video-shell', [failing]);
    const healthyShell = el('chat-image-shell', [el('chat-md-img')]);
    const host = el('chat-msg-produced-media', [failingShell, healthyShell]);

    expect(utils._dropFailedProducedPreview(failing)).toBe(true);
    expect(host.children).toEqual([healthyShell]);
  });

  // Media the model wrote into its own prose keeps the placeholder: the
  // surrounding sentence refers to it, so its absence has to stay visible.
  it('leaves model-authored markdown media to the placeholder path', () => {
    const img = el('chat-md-img');
    const body = el('markdown-body', [el('chat-image-shell', [img])]);

    expect(utils._dropFailedProducedPreview(img)).toBe(false);
    expect(body.querySelector('.chat-md-img')).not.toBeNull();
  });

  it('routes audio failures through the same guard', () => {
    // The listener only recognised IMG and VIDEO before; a produced `.mp3`
    // that had been deleted left a dead player in the bubble.
    expect(utilsSource).toContain("target.tagName === 'AUDIO' && target.classList?.contains('chat-md-audio')");
    expect(utilsSource).toContain('if (_dropFailedProducedPreview(target)) return;');
  });
});

describe('chat video layout', () => {
  it('reserves a stable 16:9 slot for markdown videos', () => {
    expect(styleSource).toContain('.chat-md-video-shell');
    expect(styleSource).toContain('aspect-ratio: 16 / 9;');
    expect(styleSource).toContain('width: min(640px, 100%);');
    expect(styleSource).not.toContain('.chat-msg-attach-video-shell');
  });

  it('wires expanded markdown and floating-player surfaces to the shared playback toggle', () => {
    expect(source).not.toContain('data-chat-video-playback-surface="attachment_bubble"');
    expect(utilsSource).toContain('data-chat-video-playback-surface="markdown_bubble"');
    expect((viewerSource.match(
      /data-chat-video-playback-surface="floating_player"|chatVideoPlaybackSurface = 'floating_player'/g,
    ) || [])).toHaveLength(2);
    expect(utilsSource).toContain("target.closest('[data-chat-video-playback-surface]')");
    expect(utilsSource).toContain('_toggleChatVideoFromSurface(e, surface)');
    expect(utilsSource).not.toMatch(/Monitor\.click\(['"]chat_video_surface_toggle/);
  });
});
