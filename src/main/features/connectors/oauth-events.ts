/** Renderer notification for OAuth work that finishes after `connectors.start_oauth` returned. */
export interface OAuthConnectOutcome {
  attempt_id: string;
  catalog_id: string;
  result: 'success' | 'failure' | 'cancelled';
  duration_ms: number;
  code?: string;
  error?: string;
}

export function broadcastOAuthConnectOutcome(outcome: OAuthConnectOutcome): void {
  try {
    // Lazy import avoids a feature → IPC initialization cycle. This runs only after the IPC
    // handler has accepted the start request and the current protocol callback finishes.
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const ipc = require('../../ipc') as { broadcastToRenderer?: (channel: string, payload: unknown) => void };
    ipc.broadcastToRenderer?.('connectors:oauth-result', outcome);
  } catch {
    // Tests and open-source builds may not have the hosted IPC bridge loaded. Registry writes still
    // broadcast `connectors:changed`, so connector state remains correct even without this UX event.
  }
}
