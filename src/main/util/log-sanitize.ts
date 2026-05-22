/**
 * Best-effort positional redaction for log text being sent off-device.
 *
 * The logger's `redact()` hook covers NAMED object fields (token / api_key
 * / email / ...) but cannot see values stitched into a positional string —
 * `log.warn(\`token=${val}\`)` slips through. This util runs AFTER a log
 * file is assembled (e.g. before `feedback.ts` uploads it), applying narrow
 * regex masks for shapes that are unambiguously sensitive in plain text:
 *
 *   - "Bearer <token>"        → "Bearer ***"
 *   - JWT (3 base64url segs)  → "***JWT***"
 *   - email a@b.c             → "a***@b.c"     (matches Server mask_email)
 *   - CN mobile 13800138000   → "138****8000"  (matches Server mask_phone)
 *
 * Why these four and not more: each additional pattern risks destroying
 * useful diagnostic data. The four above are
 *   (a) unambiguous in plain text — a literal "Bearer X" / "eyJ.eyJ.X" /
 *       "@example.com" / "13xxxxxxxxx" rarely has a non-secret meaning,
 *   (b) consistent with the Server-side masking convention
 *       (`Server/utils/util.py::mask_phone` / `mask_email`).
 *
 * Opaque hex/SHA tokens (32+ chars of [a-f0-9]) are deliberately NOT
 * masked — too many false positives (commit shas, file hashes, paths).
 */
export function sanitizeLogTextForUpload(text: string): string {
  if (!text) return text;
  return text
    // Bearer in Authorization header — covers raw "Authorization: Bearer X"
    // and JSON-stringified "\"authorization\":\"Bearer X\"". Case-insensitive
    // because RFC 6750 declares the scheme name case-insensitive.
    .replace(/Bearer\s+[A-Za-z0-9._\-~+/=]+/gi, 'Bearer ***')
    // JWT — three base64url segments, first two starting "eyJ" (base64 of "{").
    .replace(/\beyJ[A-Za-z0-9_\-]+\.eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\b/g, '***JWT***')
    // Email — keep first local char + full domain for diagnostic value.
    .replace(/\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, '$1***$2')
    // CN mobile (11 digits starting 1[3-9]) — keep first 3 + last 4.
    .replace(/\b(1[3-9]\d)\d{4}(\d{4})\b/g, '$1****$2');
}
