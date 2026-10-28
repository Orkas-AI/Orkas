import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixtures/orkas';


for (const [boundary, continuation] of [
  ['completed', 'plain'], ['stopped', 'plain'], ['in-flight', 'plain'],
  ['in-flight', 'retry'], ['app-relaunch', 'plain'],
] as const) {
  test(`retains tool evidence across ${boundary} shutdown and ${continuation} followup`, async ({ modelOrkas }, info) => {
    test.setTimeout(90_000);
    const input = modelOrkas.createWorkspaceFile('shutdown-proof.txt', 'SHUTDOWN_RECEIPT_FACT=confirmed\n');
    await modelOrkas.setChatCommentaryScenario({
      reads: [{ path: input, commentary: 'I am checking the retained task information.' }],
      finalText: 'The task information has been verified.',
    });
    const page = modelOrkas.page!;
    await page.locator('#new-chat-btn').click();
    await page.locator('#new-chat-input').fill('Check the task information and keep the evidence.');
    await page.locator('#new-chat-send-btn').click();
    await expect.poll(() => modelOrkas.commentaryStage, { timeout: 30_000 }).toBe(1);
    modelOrkas.releaseCommentaryStage();
    await expect.poll(() => modelOrkas.commentaryStage, { timeout: 30_000 }).toBe(2);
    const cid = await page.evaluate<string>('currentCid');
    const file = path.join(modelOrkas.workspaceRoot, 'account-e2e', 'cloud', 'chats', `${cid}.jsonl`);
    const records = () => existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    const receipts = (rows: any[]) => rows.flatMap(row => row.process || []).filter(item =>
      item.event?.stream === 'tool' && item.event.data?.phase === 'end'
      && item.event.data?.id === 'call-e2e-commentary-1');
    expect(modelOrkas.modelRequests).toHaveLength(2);
    expect((modelOrkas.modelRequests[1].messages as any[]).some(message =>
      message.role === 'tool' && String(message.content).includes('SHUTDOWN_RECEIPT_FACT=confirmed'))).toBe(true);
    const live = await modelOrkas.invoke<any>('conversations.history', { cid, live: '1' });
    const liveRows = live.live_display.turns.flatMap((turn: any) => turn.records);
    expect(receipts(liveRows)).toHaveLength(1);
    expect(receipts(records())).toHaveLength(0);
    if (boundary === 'completed') {
      modelOrkas.releaseCommentaryStage();
      await expect.poll(() => records().some(row => row.text === 'The task information has been verified.')).toBe(true);
    } else if (boundary === 'stopped') {
      await modelOrkas.invoke('groupChat.abort', { cid });
      await expect.poll(() => receipts(records()).length).toBe(1);
    }
    const beforeQuit = { receiptCount: receipts(records()).length, requestCount: modelOrkas.modelRequests.length };
    const started = Date.now();
    if (boundary === 'app-relaunch') {
      // Exercise the shipped preload/Main path. The private DevTools chord is
      // intentionally absent in the public build. Only the replacement child
      // is controlled; archival, dependency drain and native app.exit are real.
      const restartingApp = modelOrkas.electronApp!;
      const oldProcess = restartingApp.process();
      const exitProof = path.join(modelOrkas.workspaceRoot, 'public-relaunch-exit.json');
      await modelOrkas.prepareForNativeShutdown();
      await restartingApp.evaluate(({ app }, data) => {
        const require = (process as any).mainModule.require.bind((process as any).mainModule);
        const cp = require('node:child_process');
        const fs = require('node:fs');
        const { EventEmitter } = require('node:events');
        const state = {
          originalExit: app.exit, originalSpawn: cp.spawn,
          launches: 0, spawnConfirmed: false, unrefCalls: 0,
          unrefBeforeSpawn: 0, killCalls: 0, child: null as any,
        };
        cp.spawn = (...args: any[]) => {
          const options = args[2];
          if (options?.env?.ORKAS_RELAUNCH_OWNER_PID !== String(process.pid)
              || options?.cwd !== data.root || options?.detached !== true) {
            return state.originalSpawn.apply(cp, args);
          }
          state.launches++;
          state.child = Object.assign(new EventEmitter(), {
            exitCode: null, signalCode: null as string | null,
            unref() {
              state.unrefCalls++;
              if (!state.spawnConfirmed) state.unrefBeforeSpawn++;
            },
            kill() { state.killCalls++; state.child.signalCode = 'SIGTERM'; return true; },
          });
          return state.child;
        };
        app.exit = code => {
          const rows = fs.readFileSync(data.file, 'utf8').trim().split('\n')
            .filter(Boolean).map((line: string) => JSON.parse(line));
          const toolReceipts = rows.flatMap((row: any) => row.process || []).filter((item: any) =>
            item.event?.stream === 'tool' && item.event.data?.phase === 'end'
            && item.event.data?.id === 'call-e2e-commentary-1');
          // Observe the exact exit boundary, then call Electron's original
          // implementation. A later fixture quit cannot satisfy this receipt.
          fs.writeFileSync(data.exitProof, JSON.stringify({
            exitCode: code, launches: state.launches,
            spawnConfirmed: state.spawnConfirmed, unrefCalls: state.unrefCalls,
            unrefBeforeSpawn: state.unrefBeforeSpawn, killCalls: state.killCalls,
            ownerPid: process.pid, receiptCount: toolReceipts.length,
            interruptionNoticeCount: rows.filter((row: any) => row.system_kind === 'reply_interrupted').length,
          }), 'utf8');
          state.originalExit.call(app, code);
        };
        (globalThis as any).__shutdownRestart = state;
      }, { root: path.resolve(__dirname, '../..'), file, exitProof });
      try {
        expect(await page.evaluate(() => typeof (window as any).orkas.relaunch)).toBe('function');
        await page.evaluate(() => {
          // Native exit destroys the invoking renderer; the persisted Main
          // boundary receipt and actual child exit below own success.
          void (window as any).orkas.relaunch().catch(() => {});
        });
        await expect.poll(() => restartingApp.evaluate(() => (globalThis as any).__shutdownRestart.launches)).toBe(1);
        expect(await restartingApp.evaluate(() => {
          const state = (globalThis as any).__shutdownRestart;
          return { spawnConfirmed: state.spawnConfirmed, unrefCalls: state.unrefCalls };
        })).toEqual({ spawnConfirmed: false, unrefCalls: 0 });
        expect(receipts(records()), 'unconfirmed launcher must not archive/exit the active turn').toHaveLength(0);
        expect(existsSync(exitProof), 'native exit must wait for launcher spawn confirmation').toBe(false);
        const nativeExitDeadline = Date.now() + 12_000;
        await restartingApp.evaluate(() => {
          // Publish the inspector response before releasing the native event.
          setImmediate(() => {
            const state = (globalThis as any).__shutdownRestart;
            state.spawnConfirmed = true;
            state.child.emit('spawn');
          });
        });
        // Main's existing cleanup budget is 10s and can expire only after
        // critical archival. This observation deadline includes that budget.
        await expect.poll(() => existsSync(exitProof), {
          timeout: Math.max(1, nativeExitDeadline - Date.now()),
        }).toBe(true);
        // No driver.close()/normal quit is allowed to make this pass: native
        // app.exit must finish within the SAME observation deadline.
        await expect.poll(() => oldProcess.exitCode, {
          timeout: Math.max(1, nativeExitDeadline - Date.now()),
        }).toBe(0);
        expect(oldProcess.signalCode).toBeNull();
        const proof = JSON.parse(readFileSync(exitProof, 'utf8'));
        await info.attach('public-relaunch-native-exit', { body: JSON.stringify(proof), contentType: 'application/json' });
        expect(proof).toEqual({ exitCode: 0, launches: 1, spawnConfirmed: true,
          unrefCalls: 1, unrefBeforeSpawn: 0, killCalls: 0, ownerPid: oldProcess.pid,
          receiptCount: 1, interruptionNoticeCount: 1 });
      } finally {
        if (oldProcess.exitCode === null && oldProcess.signalCode === null) {
          await restartingApp.evaluate(({ app }) => {
            const state = (globalThis as any).__shutdownRestart;
            if (!state) return;
            app.exit = state.originalExit;
            (process as any).mainModule.require('node:child_process').spawn = state.originalSpawn;
            delete (globalThis as any).__shutdownRestart;
          }).catch(() => { /* The observed native exit may already have disposed the inspector. */ });
        }
      }
      // Fixture ownership, trace completion and clean native exit are checked
      // by its explicit lifecycle API before the same workspace is reopened.
      await modelOrkas.launchAfterNativeExit(restartingApp);
    } else {
      await modelOrkas.relaunch();
    }
    const after = records();
    const summary = { boundary, beforeQuit, afterQuit: {
      receiptCount: receipts(after).length,
      interruptionNoticeCount: after.filter(row => row.system_kind === 'reply_interrupted').length,
      completedReplyCount: after.filter(row => row.text === 'The task information has been verified.').length,
      requestCount: modelOrkas.modelRequests.length,
    }, relaunchMs: Date.now() - started };
    await info.attach('shutdown-receipt-evidence', { body: JSON.stringify(summary), contentType: 'application/json' });
    console.log('Shutdown receipt evidence:', JSON.stringify(summary));
    expect(readFileSync(input, 'utf8')).toBe('SHUTDOWN_RECEIPT_FACT=confirmed\n');
    expect(modelOrkas.modelRequests).toHaveLength(2);
    if (boundary === 'in-flight' || boundary === 'app-relaunch') {
      expect(after.filter(row => row.system_kind === 'reply_interrupted')).toHaveLength(1);
      const archived = after.find(row => row.system_kind === 'reply_interrupted');
      expect(archived.source_message_id).toBe(after.find(row => row.from === 'user').id);
      const clocks = (archived.process || []).filter(item => item.event?.stream === 'runtime'
        && ['end', 'interrupted'].includes(item.event.data?.phase));
      expect(clocks, 'shutdown must retain the clock together with the public process').toHaveLength(1);
      expect(clocks[0].event.data.duration_ms).toBeGreaterThan(0);
      const reopenedPage = modelOrkas.page!;
      await reopenedPage.locator(`#conversation-list .conv-item[data-cid="${cid}"]`).click();
      const interruption = reopenedPage.locator('#chat-history .chat-message.assistant[data-system-kind="reply_interrupted"]');
      await expect(interruption).toHaveCount(1);
      await expect(interruption.locator('.stream-process-runtime')).toBeVisible();
      await expect(interruption.locator('.stream-process-runtime')).not.toHaveText('');
      modelOrkas.clearModelToolScenario();
      modelOrkas.setModelTextReplies(['The saved evidence is available.']);
      const retried = await modelOrkas.invoke<any>('groupChat.send', {
        cid, content: 'Summarize the verified evidence.',
        ...(continuation === 'retry' ? { retry_message_id: archived.id } : {}),
      });
      await expect.poll(() => modelOrkas.modelRequests.length, { timeout: 30_000 }).toBe(3);
      await expect.poll(() => records().some(row => row.text === 'The saved evidence is available.')).toBe(true);
      if (continuation === 'retry') {
        expect(retried.mode).toBe('resume');
        expect(JSON.stringify(modelOrkas.modelRequests[2].messages)).toContain('SHUTDOWN_RECEIPT_FACT=confirmed');
      }
      if (continuation === 'plain') {
        // The next normal turn can rebase the private Session. Retrieval must
        // still use the canonical public archive, without matching user prose.
        const retrieved = await modelOrkas.electronApp!.evaluate(async (_electron, data) => {
          const require = (process as any).mainModule.require.bind((process as any).mainModule);
          const users = require(`${data.root}/src/main/features/users.ts`);
          const history = require(`${data.root}/src/main/model/core-agent/chat-history-tools.ts`)
            .createChatHistoryTool({ userId: users.getActiveUserId(), currentCid: data.cid, currentMessageId: data.boundaryId,
              allowedScopes: ['current'] });
          return history.execute({ action: 'read', scope: 'current',
            page: { mode: 'latest', count: 30 }, include_process: true, max_tokens: 10000 }, { state: {} });
        }, { root: path.resolve(__dirname, '../..'), cid,
          boundaryId: records().filter(row => row.from === 'user').at(-1).id });
        expect(retrieved.isError, retrieved.content).toBeFalsy();
        expect(retrieved.content).toContain('call-e2e-commentary-1');
        expect(retrieved.content).toContain('SHUTDOWN_RECEIPT_FACT=confirmed');
      }
      expect(receipts(records())).toHaveLength(1);
      expect(records().filter(row => row.system_kind === 'reply_interrupted')).toHaveLength(1);
      expect(modelOrkas.modelRequests).toHaveLength(3);
    } else {
      expect(after.filter(row => row.system_kind === 'reply_interrupted')).toHaveLength(0);
    }
    expect(receipts(after), 'a normal quit must not erase a completed tool receipt visible before exit').toHaveLength(1);
  });
}
