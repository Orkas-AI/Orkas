import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Pure renderer helpers are exposed through a guarded CommonJS bridge. The
// browser path still initializes from the same file without a module runtime.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const turnNav = require('../../src/renderer/modules/conversation-turn-nav.js');

const moduleSource = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/conversation-turn-nav.js'),
  'utf8',
);
const rendererHtml = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/index.html'),
  'utf8',
);
const conversationSource = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/conversation.js'),
  'utf8',
);
const styleSource = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/style.css'),
  'utf8',
);

function fakeMessage(role: 'user' | 'assistant', text: string): any {
  return {
    role,
    text,
    nextElementSibling: null,
    matches(selector: string) {
      return selector === `.chat-message.${role}`;
    },
    querySelector(selector: string) {
      return selector === '.chat-bubble .markdown-body' ? { textContent: text } : null;
    },
  };
}

describe('conversation turn navigation', () => {
  it('appears at five indexed user turns, not four', () => {
    expect(turnNav.shouldShowTurnNav(4)).toBe(false);
    expect(turnNav.shouldShowTurnNav(5)).toBe(true);
  });

  it('merges complete fifteen-turn pages without sampling or duplicating overlap', () => {
    const latest = Array.from({ length: 15 }, (_, index) => ({
      turn_no: index + 16,
      message_id: `u${index + 16}`,
      message_index: (index + 15) * 2,
      user_preview: `user ${index + 16}`,
      assistant_preview: `reply ${index + 16}`,
    }));
    const older = Array.from({ length: 15 }, (_, index) => ({
      turn_no: index + 1,
      message_id: `u${index + 1}`,
      message_index: index * 2,
      user_preview: `user ${index + 1}`,
      assistant_preview: `reply ${index + 1}`,
    }));
    const merged = turnNav.mergeTurnPage(
      turnNav.mergeTurnPage([], latest),
      [...older, latest[0]],
    );

    expect(turnNav.PAGE_SIZE).toBe(15);
    expect(turnNav.VISIBLE_MARKERS).toBe(12);
    expect(merged).toHaveLength(30);
    expect(merged.map((turn: any) => turn.turnNo)).toEqual(
      Array.from({ length: 30 }, (_, index) => index + 1),
    );

    const claimedLive = turnNav.mergeTurnPage([{
      turnNo: 21,
      liveKey: 'client-21',
      clientMessageId: 'client-21',
      provisional: true,
      userPreview: 'optimistic',
    }], [{
      turn_no: 21,
      message_id: 'u21',
      client_message_id: 'client-21',
      message_index: 40,
      user_preview: 'persisted',
    }]);
    expect(claimedLive).toHaveLength(1);
    expect(claimedLive[0]).toMatchObject({
      turnNo: 21,
      messageId: 'u21',
      messageIndex: 40,
      userPreview: 'persisted',
      provisional: false,
    });

    const sentBeforeInitialPage = [{
      turnNo: 1,
      liveKey: 'client-22',
      clientMessageId: 'client-22',
      provisional: true,
    }];
    expect(turnNav.rebaseProvisionalTurns(sentBeforeInitialPage, 21)).toBe(22);
    expect(sentBeforeInitialPage[0].turnNo).toBe(22);
  });

  it('stores at most one user line and two compact assistant lines', () => {
    const turn = turnNav.normalizeTurnDescriptor({
      turn_no: 1,
      user_preview: '用'.repeat(50),
      assistant_preview: '答'.repeat(100),
    });
    expect(Array.from(turn.userPreview)).toHaveLength(40);
    expect(Array.from(turn.assistantPreview)).toHaveLength(80);
    expect(turn.userPreview.endsWith('…')).toBe(true);
    expect(turn.assistantPreview.endsWith('…')).toBe(true);
  });

  it('previews only the selected user turn and replies before the next turn', () => {
    const first = fakeMessage('user', '  First   request  ');
    const answer = fakeMessage('assistant', 'First answer');
    const followup = fakeMessage('assistant', 'Additional detail');
    const second = fakeMessage('user', 'Second request must stay out');
    const secondAnswer = fakeMessage('assistant', 'Second answer must stay out');
    first.nextElementSibling = answer;
    answer.nextElementSibling = followup;
    followup.nextElementSibling = second;
    second.nextElementSibling = secondAnswer;

    expect(turnNav.previewForTurn(first)).toEqual({
      title: 'First request',
      body: 'First answer · Additional detail',
    });
  });

  it('marks a jump as programmatic and pauses sticky following', () => {
    const calls: string[] = [];
    const targetClasses = new Set<string>();
    const container: any = {
      scrollTop: 100,
      clientHeight: 400,
      style: { scrollBehavior: 'smooth' },
      getBoundingClientRect: () => ({ top: 0 }),
    };
    const target: any = {
      getBoundingClientRect: () => ({ top: 300, height: 100 }),
      classList: {
        add: (value: string) => targetClasses.add(value),
        remove: (value: string) => targetClasses.delete(value),
      },
    };

    expect(turnNav.jumpToTurn(container, target, {
      markProgrammatic: () => calls.push('marked'),
      requestFrame: (callback: () => void) => callback(),
      setTimer: (callback: () => void) => callback(),
    })).toBe(true);
    expect(calls).toEqual(['marked']);
    expect(container.scrollTop).toBe(250);
    expect(container._stickyEnabled).toBe(false);
    expect(container._stickyUserPaused).toBe(true);
    expect(container.style.scrollBehavior).toBe('smooth');
    expect(targetClasses.size).toBe(0);
  });

  it('centers the selected marker and clamps only at the rail boundaries', () => {
    expect(turnNav.centeredMarkerScrollTop({
      markerTop: 252,
      markerHeight: 18,
      clientHeight: 216,
      scrollHeight: 540,
    })).toBe(153);
    expect(turnNav.centeredMarkerScrollTop({
      markerTop: 0,
      markerHeight: 18,
      clientHeight: 216,
      scrollHeight: 540,
    })).toBe(0);
    expect(turnNav.centeredMarkerScrollTop({
      markerTop: 522,
      markerHeight: 18,
      clientHeight: 216,
      scrollHeight: 540,
    })).toBe(324);
  });

  it('exposes independent before and after overflow markers', () => {
    expect(turnNav.turnNavOverflowState({
      scrollTop: 27,
      clientHeight: 216,
      scrollHeight: 270,
    })).toEqual({ before: true, after: true });
    expect(turnNav.turnNavOverflowState({
      scrollTop: 54,
      clientHeight: 216,
      scrollHeight: 270,
    })).toEqual({ before: true, after: false });
    expect(turnNav.turnNavOverflowState({
      scrollTop: 0,
      clientHeight: 216,
      scrollHeight: 216,
    }, true)).toEqual({ before: true, after: false });
    expect(turnNav.turnNavOverflowState({
      scrollTop: 0,
      clientHeight: 216,
      scrollHeight: 216,
    })).toEqual({ before: false, after: false });
  });

  it('tapers only visible edge markers without adding rail height', () => {
    const markers = Array.from({ length: 15 }, (_, index) => ({
      offsetTop: index * 18,
      offsetHeight: 18,
    }));
    const ranks = turnNav.overflowEdgeRanks(markers, {
      scrollTop: 27,
      clientHeight: 216,
    }, { before: true, after: true });
    expect(ranks.slice(0, 5)).toEqual([0, 1, 2, 3, 0]);
    expect(ranks.slice(-5)).toEqual([0, 3, 2, 1, 0]);
    expect(turnNav.overflowEdgeRanks(markers, {
      scrollTop: 27,
      clientHeight: 216,
    }, { before: false, after: false })).toEqual(markers.map(() => 0));
  });

  it('pages the compact rail independently without adding transcript prefetch', () => {
    expect(rendererHtml).toContain('id="chat-turn-nav"');
    expect(rendererHtml).toContain('./modules/conversation-turn-nav.js');
    expect(rendererHtml).not.toContain('chat-turn-nav-overflow');
    expect(moduleSource).not.toContain('apiFetch(');
    expect(moduleSource).toContain('const PAGE_SIZE = 15;');
    expect(moduleSource).toContain('const VISIBLE_MARKERS = 12;');
    expect(moduleSource).toContain('state.loadPage(cursor)');
    expect(moduleSource).toContain('previousTop + nextHeight - previousHeight');
    expect(moduleSource).toContain('attributeFilter: [\'data-msg-id\', \'data-msg-index\']');
    expect(moduleSource).not.toContain('subtree: true');
    expect(moduleSource).not.toContain('MAX_MARKERS');
    expect(conversationSource).toContain('/turns?limit=15');
    expect(conversationSource).toContain('_activateConversationTurnNavigationEntry');
    expect(styleSource).toContain('max-height: 216px');
    expect(styleSource).toContain('flex: 0 0 18px');
    expect(styleSource).toContain('.chat-turn-nav-marker.is-overflow-edge-1::before');
    expect(styleSource).toContain('left: 6.5px');
    expect(styleSource).toContain('border-radius: 99px');
    expect(styleSource).toMatch(/\.chat-turn-nav-marker::before\s*\{[^}]*height: 2px;/s);
    expect(styleSource).toContain('width: clamp(200px, 26cqw, 260px)');
    expect(styleSource).toContain('-webkit-line-clamp: 1');
    expect(styleSource).toContain('-webkit-line-clamp: 2');
  });
});
