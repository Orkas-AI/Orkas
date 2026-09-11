import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const rendererSource = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/conversation.js'),
  'utf8',
);
const ipcSource = fs.readFileSync(
  path.join(__dirname, '../../src/main/ipc/index.ts'),
  'utf8',
);
const turnNavSource = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/conversation-turn-nav.js'),
  'utf8',
);
const bootSource = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/boot.js'),
  'utf8',
);

describe('conversation detail first-paint boundary', () => {
  it('keeps the first history page at 10 rows', () => {
    expect(rendererSource).toContain('const HISTORY_PAGE_SIZE = 10;');
    expect(rendererSource).toContain('limit = HISTORY_PAGE_SIZE');
    expect(rendererSource).toContain('limit=${pageSize}');
  });

  it('does not make secondary identity enrichment a transcript paint prerequisite', () => {
    const start = rendererSource.indexOf('async function loadConversationHistory');
    const end = rendererSource.indexOf('\nfunction _messageRecordHasMountedSidecars', start);
    const body = rendererSource.slice(start, end);

    expect(body).toContain('const membersPromise = _refreshGroupMembers(cid)');
    expect(body).toContain('const agentsPromise = (async () => {');
    expect(body).toContain('const historyPromise = apiFetch(_historyRequestUrl(');
    expect(body).toContain('Number(opts.searchTarget?.msgIndex)');
    expect(body).toContain('const res = await historyPromise');
    expect(body.indexOf('const historyPromise = apiFetch')).toBeLessThan(
      body.indexOf('const agentsPromise = (async () => {'),
    );
    expect(body.indexOf('const res = await historyPromise')).toBeLessThan(
      body.indexOf('void agentsPromise'),
    );
    expect(body).not.toContain('await Promise.all([\n      apiFetch(_historyRequestUrl(cid)),\n      _refreshGroupMembers(cid)');
    expect(body.indexOf("conversation detail first paint")).toBeLessThan(
      body.indexOf('await _evaluateAutoRecipient(cid)'),
    );
  });

  it('uses the known physical owner for the background member lookup', () => {
    expect(rendererSource).toContain('/members?project_id=${encodeURIComponent(_projectIdForConversation(cid))}');
    const start = ipcSource.indexOf("'groupChat.listMembers'");
    const end = ipcSource.indexOf("'groupChat.runtimeStatus'", start);
    const handler = ipcSource.slice(start, end);
    expect(handler).toContain('const projectIdHint = conversationProjectHint(args)');
    expect(handler).toContain('chats.getConversationMetadata(ctx.userId, cid, projectIdHint)');
    expect(handler).toContain('groupChat.listMembers(ctx.userId, cid, conv.project_id ?? null)');
  });

  it('passes the same owner through state and paged history reads', () => {
    const start = ipcSource.indexOf("'conversations.history'");
    const end = ipcSource.indexOf("'conversations.files.list'", start);
    const handler = ipcSource.slice(start, end);

    expect(handler).toContain('chats.getConversationMetadata(ctx.userId, cid, projectIdHint)');
    expect(handler).toContain('const resolvedProjectId = conv.project_id ?? null');
    expect(handler).toContain('groupChat.runtimeStatus(ctx.userId, cid, resolvedProjectId)');
    expect(handler).toContain('const [runtime, initialPage] = await Promise.all([');
    expect(handler).not.toContain('? await chats.getMessagesPageAtIndex(');
    expect(handler).toContain('chats.getMessagesPageAtIndex(');
    expect(handler).toContain('requestedAroundIndex, requestedLimit, resolvedProjectId');
    expect(handler).toContain('resolvedProjectId,\n      );');
  });

  it('keeps attachment refresh independent and timed', () => {
    expect(rendererSource).toContain("conversation detail attachments ready");
    expect(rendererSource).toContain("conversation detail members ready");
    expect(rendererSource).toContain("conversation detail first paint");
  });

  it('starts hidden turn navigation only after the transcript commits a frame', () => {
    const enterStart = rendererSource.indexOf('function onEnterConversationView()');
    const enterEnd = rendererSource.indexOf('\nfunction _forgetCidRecipient', enterStart);
    const enterBody = rendererSource.slice(enterStart, enterEnd);
    expect(enterBody).toContain('_prepareConversationTurnNavigation(currentCid)');
    expect(enterBody).not.toContain('_openConversationTurnNavigation(currentCid)');

    const loadStart = rendererSource.indexOf('async function loadConversationHistory');
    const loadEnd = rendererSource.indexOf('\nfunction _messageRecordHasMountedSidecars', loadStart);
    const loadBody = rendererSource.slice(loadStart, loadEnd);
    expect(loadBody.indexOf("conversation detail first paint")).toBeLessThan(
      loadBody.indexOf('_scheduleConversationTurnNavigation(cid)'),
    );

    const scheduleStart = rendererSource.indexOf('function _scheduleConversationTurnNavigation');
    const scheduleEnd = rendererSource.indexOf('\nfunction _membersRequestUrl', scheduleStart);
    const scheduleBody = rendererSource.slice(scheduleStart, scheduleEnd);
    expect(scheduleBody).toContain('window.requestAnimationFrame');
    expect(scheduleBody).toContain('setTimeout(() => {');
    expect(scheduleBody).toContain('schedule !== _conversationTurnNavigationSchedule');
    expect(scheduleBody).toContain('cid !== currentCid');

    expect(turnNavSource).toContain('function prepare(cidValue = \'\')');
    expect(turnNavSource).toContain('state.nav.hidden = true');
    expect(turnNavSource.indexOf('state.indexReady = true')).toBeLessThan(
      turnNavSource.indexOf('renderMarkers();', turnNavSource.indexOf('state.indexReady = true')),
    );
    expect(bootSource).toContain('_scheduleConversationTurnNavigation(cid)');
  });
});
