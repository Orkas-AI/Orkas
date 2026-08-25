/**
 * Current persisted tool-catalog marker.
 *
 * Keep this constant dependency-free: production regression contracts import
 * it as their current-state oracle without pulling the Electron runtime or the
 * tool catalog's logger/path dependency chain into model-eval processes.
 */
export const TOOL_CATALOG_REVISION = '10';
