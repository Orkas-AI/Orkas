/** Renderer notification for OAuth work that finishes after `connectors.start_oauth` returned. */
export interface OAuthConnectOutcome {
  attempt_id: string;
  catalog_id: string;
  result: 'success' | 'failure' | 'cancelled';
  duration_ms: number;
  code?: string;
  error?: string;
}

export interface OAuthConnectProgress {
  attempt_id: string;
  catalog_id: string;
}

function _broadcast(channel: string, payload: unknown): void {
  // Lazy import avoids a feature → IPC initialization cycle. These events run only after the IPC
  // handler has accepted the start request.
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const ipc = require('../../ipc') as { broadcastToRenderer?: (event: string, data: unknown) => void };
  ipc.broadcastToRenderer?.(channel, payload);
}

/** Tell the renderer that the provider has returned to the app and network finalization began. */
export function broadcastOAuthConnectProgress(progress: OAuthConnectProgress): void {
  try {
    _broadcast('connectors:oauth-callback', progress);
  } catch {
    // Tests and open-source builds may not have the hosted IPC bridge loaded.
  }
}

export function broadcastOAuthConnectOutcome(outcome: OAuthConnectOutcome): void {
  try {
    _broadcast('connectors:oauth-result', outcome);
  } catch {
    // Tests and open-source builds may not have the hosted IPC bridge loaded. Registry writes still
    // broadcast `connectors:changed`, so connector state remains correct even without this UX event.
  }
}
