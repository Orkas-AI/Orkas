import { readConversationTurnPage, purgeConversationTurnIndex } from './conversation-turn-index';
import { parentPort } from 'node:worker_threads';
import { readJsonlPageWithOffsets } from '../storage';
import { persistedCodexOutputCitations, storedProducedPaths } from './local_agents/public-output';
import type { GroupMessage } from './group_chat/visibility';
import type { HistoryCommand, ProducedPathRecord } from './conversation-history-client';
import { readConversationHistoryPage, readConversationHistoryWindow, readConversationHistoryWindowAtMessage,
  projectConversationHistoryRecords, purgeConversationHistoryCache, readConversationProcessPage } from './conversation_history_cache';

const PRODUCED_PATH_FIELDS = new Set(['from', 'deleted_at', 'produced', 'text']);

async function readProducedPaths(command: HistoryCommand): Promise<ProducedPathRecord[]> {
  const page = await readJsonlPageWithOffsets<ProducedPathRecord>(command.sourceFile, command.limit, undefined, {
    project: {
      fields: PRODUCED_PATH_FIELDS,
      record: value => {
        const message = value as GroupMessage | null;
        if (!message || message.deleted_at) return undefined;
        return {
          stored: storedProducedPaths(message.produced),
          cited: message.from === 'user' ? [] : persistedCodexOutputCitations(message.text),
        };
      },
    },
  });
  return page.entries.map(({ record }) => record);
}

let tail = Promise.resolve();
parentPort!.on('message', (command: HistoryCommand & { id: number }) => {
  tail = tail.then(async () => {
    try {
      let value: unknown;
      if (command.kind === 'produced-paths') value = await readProducedPaths(command);
      else if (command.kind === 'process-page') value = await readConversationProcessPage(command.userId, command.sourceFile, command.processRef!, command.processCursor, command.messageId);
      else if (command.kind === 'turns') value = await readConversationTurnPage(command.userId, command.cid!, command.sourceFile, command.before, command.projectIdHint);
      else if (command.kind === 'turn-purge') value = await purgeConversationTurnIndex(command.userId, command.cid!);
      else if (command.kind === 'page') value = await readConversationHistoryPage(command.userId, command.sourceFile, command.limit!, command.before);
      else if (command.kind === 'window') value = await readConversationHistoryWindow(command.userId, command.sourceFile, command.start!, command.limit, command.after);
      else if (command.kind === 'window-at-message') value = await readConversationHistoryWindowAtMessage(command.userId, command.sourceFile, command.messageId!, command.limit);
      else if (command.kind === 'project') value = projectConversationHistoryRecords(command.userId, command.sourceFile, command.records!);
      else if (command.kind === 'purge') value = await purgeConversationHistoryCache(command.userId, command.sourceFile);
      else throw new Error('Unknown history operation');
      parentPort!.postMessage({ id: command.id, ok: true, value });
    } catch {
      parentPort!.postMessage({ id: command.id, ok: false });
    }
  });
});
