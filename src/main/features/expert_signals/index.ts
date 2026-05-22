/**
 * Expert signals — public API.
 *
 * Two entry points for outer modules:
 *   - `emitSignal(uid, input)`  — fire-and-forget write at chokepoints
 *   - `querySignals(filter)`    — read-back for reflection / patch suggester / critic
 *
 * Outer callers must import only from here, never from `./extractors/*` or
 * `./storage.ts` directly. Storage layout, jsonl format, and extractor
 * versioning are implementation detail subject to change.
 *
 * Why so thin: the extractor rules live with their chokepoint callers (bus
 * turn-end runs text + tool_failure extractors; IPC handlers run event
 * extractors). This module is just the write/read facade — it doesn't own
 * triggering logic.
 */

import { appendSignal, querySignals as _querySignals } from './storage';
import type { Signal, SignalFilter, SignalInput } from './types';

export type {
  Signal, SignalFilter, SignalInput,
  SignalType, SignalSource, SignalDelta, SignalContextRef, SignalTextSlice,
} from './types';
export { EXTRACTOR_VERSION } from './types';

/** Emit a signal. Fire-and-forget; never throws. The caller passes the
 *  active uid explicitly (rather than resolving from `getActiveUserId()`
 *  here) so a turn-end hook fired during user-switch doesn't accidentally
 *  cross-write. */
export function emitSignal(uid: string, input: SignalInput): void {
  appendSignal(uid, input);
}

/** Query signals across one or more daily files. */
export async function querySignals(filter: SignalFilter = {}): Promise<Signal[]> {
  return _querySignals(filter);
}
