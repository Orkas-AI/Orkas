// Linux source builds retain these diagnostics in the successful main baseline
// (GitHub Actions run 34550610580). They are warnings, not clean-runtime evidence.
// Sharp documents the GLib collision at https://sharp.pixelplumbing.com/install/#electron-and-linux.
const chromium = String.raw`\[\d+:\d+/\d+\.\d+:ERROR:`;
const knownLinux = [
  ['dbus-address', new RegExp(`^${chromium}dbus/bus\\.cc:\\d+\\] Failed to connect to the bus: Could not parse server address: Unknown address type \\(examples of valid types are "tcp" and on UNIX "unix"\\)$`), 20],
  ['dbus-owner', new RegExp(`^${chromium}dbus/object_proxy\\.cc:\\d+\\] Failed to call method: org\\.freedesktop\\.DBus\\.NameHasOwner: object_path= /org/freedesktop/DBus: unknown error type: ?$`), 10],
  ['sharp-linux', /^\(node:\d+\) \[SharpElectronLinux\] Warning: Binaries provided by Electron for use on Linux may be incompatible with sharp - see https:\/\/sharp\.pixelplumbing\.com\/install#electron-and-linux$/, 1],
  ['sharp-trace', /^\(Use `electron --trace-warnings \.\.\.` to show where the warning was created\)$/, 1],
  ['glib-sharp', new RegExp(`^${chromium}content/browser/browser_main_loop\\.cc:\\d+\\] GLib-GObject: g_object_(?:ref|unref): assertion 'G_IS_OBJECT \\(object\\)' failed$`), 100],
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
  // A trace hint or GLib error without the specific Sharp warning is unexplained.
  if (!warnings['sharp-linux']) unexpected += (warnings['glib-sharp'] || 0) + (warnings['sharp-trace'] || 0);
  return { warnings, unexpected };
}

export function inspectCanaryExitCode(code, timedOut, report) {
  return code || (timedOut || report.unexpected ? 1 : 0);
}
