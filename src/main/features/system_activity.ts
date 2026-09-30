// Compatibility entry; all Agent runtimes share one OS suspension tracker.
export { SystemActivityTracker, getSystemActivitySnapshot, getSystemActivityClock } from '../util/system-activity';
export type { SystemActivitySnapshot } from '../util/system-activity';
