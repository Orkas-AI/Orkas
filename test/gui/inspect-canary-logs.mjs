// Linux source builds retain these diagnostics in the successful main baseline
// (GitHub Actions run 34550610580). They are warnings, not clean-runtime evidence.
// Application sharp operations now run outside Electron; GLib collisions fail.
const chromium = String.raw`\[\d+:\d+/\d+\.\d+:ERROR:`;
const knownLinux = [
  ['dbus-address', new RegExp(`^${chromium}dbus/bus\\.cc:\\d+\\] Failed to connect to the bus: Could not parse server address: Unknown address type \\(examples of valid types are "tcp" and on UNIX "unix"\\)$`), 20],
  ['dbus-owner', new RegExp(`^${chromium}dbus/object_proxy\\.cc:\\d+\\] Failed to call method: org\\.freedesktop\\.DBus\\.NameHasOwner: object_path= /org/freedesktop/DBus: unknown error type: ?$`), 10],
  ['system-font-mtime', /^Unable to revert mtime: \/usr\/share\/fonts(?:\/truetype(?:\/(?:dejavu|lato|liberation|noto))?)?$/, 20],
];

export function reviewInspectStderr(stderr, platform = process.platform) {
  const warnings = {};
  let unexpected = 0;
  for (const line of stderr.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = platform === 'linux' && knownLinux.find(([, pattern]) => pattern.test(line));
    if (!match) { unexpected++; continue; }
    const [name, , limit] = match;
    warnings[name] = (warnings[name] || 0) + 1;
    if (warnings[name] > limit) unexpected++;
  }
  return { warnings, unexpected };
}

export function inspectCanaryExitCode(code, timedOut, report) {
  return code || (timedOut || report.unexpected ? 1 : 0);
}
