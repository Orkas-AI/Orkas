/** Test-owned attribution only. No exception-message inference or runtime retry. */
export interface PreviewAttempt {
  id: number;
  entryKey: string;
  version: string | null;
  stable: boolean;
  started: number;
  ended: number;
  interactions: boolean;
  ok: boolean;
  windows: number[];
  viewports: string[];
  runtimeErrorWindows: number[];
}
export interface PreviewRecoverySnapshot {
  attempts: PreviewAttempt[];
  currentVersions: Record<string, string | null>;
}

export function recoveredPreviewWindows(snapshot: PreviewRecoverySnapshot) {
  const latest = new Map<string, PreviewAttempt>();
  const owners = new Map<number, PreviewAttempt[]>();
  for (const attempt of snapshot.attempts) {
    const previous = latest.get(attempt.entryKey);
    if (!previous || attempt.started > previous.started) latest.set(attempt.entryKey, attempt);
    for (const window of attempt.windows) owners.set(window, [...(owners.get(window) ?? []), attempt]);
  }
  const recovered: Array<{ windowId: number; failedAttempt: number; recoveredBy: number }> = [];
  for (const failed of snapshot.attempts) {
    if (failed.ok || !failed.stable || !failed.version || !failed.interactions || !failed.ended) continue;
    const verified = latest.get(failed.entryKey);
    if (!verified || !verified.ok || !verified.stable || !verified.version || !verified.interactions
      || verified.runtimeErrorWindows.length || verified.started <= failed.ended
      || verified.version !== snapshot.currentVersions[failed.entryKey]
      || !failed.viewports.every(view => verified.viewports.includes(view))) continue;
    for (const window of failed.runtimeErrorWindows) {
      if (owners.get(window)?.length === 1 && failed.windows.includes(window)) {
        recovered.push({ windowId: window, failedAttempt: failed.id, recoveredBy: verified.id });
      }
    }
  }
  return recovered;
}
