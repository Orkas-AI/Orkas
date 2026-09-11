/** Task-run tab ownership, independent of Electron and individual Agent turns. */
export type BrowserTabRetention = 'deliverable' | 'handoff' | 'temporary';

export interface BrowserTabLifetime {
  createdBy: 'user' | 'model';
  /** Unmarked tabs stay open. An explicit policy lasts until changed or closed. */
  retention?: BrowserTabRetention;
}

interface TaskTabs {
  runId?: string;
  tabs: Map<string, { lifetime: BrowserTabLifetime; close: () => void }>;
}

// The bus and Electron host can load through different CJS/ESM instances.
const stateKey = Symbol.for('orkas.web_assist.task_tab_lifetimes');
const tasks: Map<string, TaskTabs> = ((globalThis as any)[stateKey] ??= new Map());
const keyFor = (uid: string, cid: string) => `${uid}\u0000${cid}`;

function taskTabs(uid: string, cid: string): TaskTabs {
  const key = keyFor(uid, cid);
  let task = tasks.get(key);
  if (!task) {
    task = { tabs: new Map() };
    tasks.set(key, task);
  }
  return task;
}

export function beginBrowserTaskRun(uid: string, cid: string, runId: string): void {
  const task = taskTabs(uid, cid);
  if (task.runId === runId) return;
  task.runId = runId;
}

export function browserTaskRunId(uid: string, cid: string): string | undefined {
  return tasks.get(keyFor(uid, cid))?.runId;
}

export function registerBrowserTab(
  uid: string, cid: string, tabId: string,
  createdBy: BrowserTabLifetime['createdBy'], close: () => void,
): BrowserTabLifetime {
  const lifetime: BrowserTabLifetime = { createdBy };
  taskTabs(uid, cid).tabs.set(tabId, { lifetime, close });
  return lifetime;
}

export function forgetBrowserTab(uid: string, cid: string, tabId: string): void {
  const key = keyFor(uid, cid);
  const task = tasks.get(key);
  if (!task) return;
  task.tabs.delete(tabId);
  if (!task.runId && !task.tabs.size) tasks.delete(key);
}

export function retainBrowserTab(
  uid: string, cid: string, tabId: string, retention: BrowserTabRetention,
): boolean {
  const task = tasks.get(keyFor(uid, cid));
  const entry = task?.tabs.get(tabId);
  if (!task?.runId || !entry || entry.lifetime.createdBy !== 'model') return false;
  entry.lifetime.retention = retention;
  return true;
}

/** Called once after all work in the task settles, including failure and stop. */
export function finishBrowserTaskRun(uid: string, cid: string, runId: string): void {
  const key = keyFor(uid, cid);
  const task = tasks.get(key);
  if (!task || task.runId !== runId) return;
  task.runId = undefined;
  for (const [tabId, entry] of [...task.tabs]) {
    if (entry.lifetime.createdBy === 'user' || entry.lifetime.retention !== 'temporary') continue;
    task.tabs.delete(tabId);
    entry.close();
  }
  if (!task.tabs.size) tasks.delete(key);
}
