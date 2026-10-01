import { readConversationTurnPage, purgeConversationTurnIndex } from './conversation-turn-index';
import { parentPort } from 'node:worker_threads';
import type { HistoryCommand } from './conversation-history-client';
import { readConversationHistoryPage, readConversationHistoryWindow,
  projectConversationHistoryRecords, purgeConversationHistoryCache } from './conversation_history_cache';

let tail = Promise.resolve();
parentPort!.on('message', (command: HistoryCommand & { id: number }) => {
  tail = tail.then(async () => {
    try {
      let value: unknown;
      if (command.kind === 'turns') value = await readConversationTurnPage(command.userId, command.cid!, command.sourceFile, command.before, command.projectIdHint);
      else if (command.kind === 'turn-purge') value = await purgeConversationTurnIndex(command.userId, command.cid!);
      else if (command.kind === 'page') value = await readConversationHistoryPage(command.userId, command.sourceFile, command.limit!, command.before);
      else if (command.kind === 'window') value = await readConversationHistoryWindow(command.userId, command.sourceFile, command.start!, command.limit, command.after);
      else if (command.kind === 'project') value = projectConversationHistoryRecords(command.userId, command.sourceFile, command.records!);
      else if (command.kind === 'purge') value = await purgeConversationHistoryCache(command.userId, command.sourceFile);
      else throw new Error('Unknown history operation');
      parentPort!.postMessage({ id: command.id, ok: true, value });
    } catch {
      parentPort!.postMessage({ id: command.id, ok: false });
    }
  });
});
