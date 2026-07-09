/**
 * Redaction helpers for log/telemetry text. Subprocess stderr (ffmpeg /
 * OCR / whisper) can contain absolute filesystem paths, which CLAUDE.md
 * forbids writing to logs. Use `redactPaths` on any captured stderr/stdout tail
 * before logging it.
 */

/** Replace absolute filesystem paths (POSIX `/a/b/c` and Windows `C:\a\b`) with
 *  `<path>`. Conservative: only collapses multi-segment absolute paths so it
 *  doesn't mangle ordinary words. */
export function redactPaths(text: string): string {
  if (!text) return text;
  return text
    // Windows drive paths: C:\Users\... or C:/Users/...
    .replace(/[A-Za-z]:[\\/][^\s"']*/g, '<path>')
    // POSIX absolute paths with at least two segments: /a/b...
    .replace(/(?:\/[\w.\-]+){2,}\/?/g, '<path>');
}
