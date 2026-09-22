/**
 * Release process-wide main-process caches before deleting a per-test
 * workspace. Windows does not allow unlinking SQLite databases while a
 * connection is still open, and search can retain delayed flush timers.
 */
export async function drainMainRuntimeForTest(): Promise<void> {
  // `flushAll` settles deferred chat writes and releases the chat store's
  // SQLite handle, which Windows needs before the workspace can be removed.
  const searchIndexer = await import('../../src/main/features/search/indexer');
  await searchIndexer.flushAll();

  const kbVector = await import('../../src/main/features/kb_vector');
  kbVector.closeAllKb();
}
