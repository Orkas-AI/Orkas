import { describe, expect, it } from 'vitest';
import { reviewInspectStderr, inspectCanaryExitCode } from '../../gui/inspect-canary-logs.mjs';

const sharp = '(node:4439) [SharpElectronLinux] Warning: Binaries provided by Electron for use on Linux may be incompatible with sharp - see https://sharp.pixelplumbing.com/install#electron-and-linux';
const glib = "[4439:0911/032713.835182:ERROR:content/browser/browser_main_loop.cc:274] GLib-GObject: g_object_ref: assertion 'G_IS_OBJECT (object)' failed";
const dbus = '[4439:0911/032713.202218:ERROR:dbus/bus.cc:405] Failed to connect to the bus: Could not parse server address: Unknown address type (examples of valid types are "tcp" and on UNIX "unix")';
const owner = '[4439:0911/032710.232165:ERROR:dbus/object_proxy.cc:572] Failed to call method: org.freedesktop.DBus.NameHasOwner: object_path= /org/freedesktop/DBus: unknown error type: ';
const trace = '(Use `electron --trace-warnings ...` to show where the warning was created)';

describe('GUI canary process diagnostics', () => {
  it('reports reviewed Linux baseline diagnostics separately from functional success', () => {
    const report = reviewInspectStderr([dbus, owner, 'Unable to revert mtime: /usr/share/fonts/truetype/noto'].join('\r\n'), 'linux');
    expect(report).toEqual({ unexpected: 0, warnings: {
      'dbus-address': 1, 'dbus-owner': 1, 'system-font-mtime': 1,
    } });
    expect(inspectCanaryExitCode(0, false, report)).toBe(0);
    expect(inspectCanaryExitCode(2, false, report)).toBe(2);
    expect(inspectCanaryExitCode(0, true, report)).toBe(1);
  });

  it.each(['darwin', 'win32', 'linux'])('rejects an Electron/sharp collision on %s', platform => {
    expect(reviewInspectStderr(sharp, platform).unexpected).toBe(1);
  });

  it.each([
    'GUI test Electron runner failed: Error', 'Segmentation fault',
    'Unable to revert mtime: /private/user-file', `${glib} and another error`,
    dbus.replace('Could not parse server address', 'Permission denied'),
  ])('rejects unknown output and near matches: %s', message => {
    const report = reviewInspectStderr(`${sharp}\n${message}`, 'linux');
    expect(report.unexpected).toBeGreaterThan(0);
    expect(inspectCanaryExitCode(0, false, report)).toBe(1);
  });

  it('rejects an unbounded warning loop and unexplained GLib or trace output', () => {
    expect(reviewInspectStderr(Array(21).fill(dbus).join('\n'), 'linux').unexpected).toBe(1);
    expect(reviewInspectStderr(glib, 'linux').unexpected).toBe(1);
    expect(reviewInspectStderr(trace, 'linux').unexpected).toBe(1);
  });

  it('accepts a clean process without platform exceptions', () => {
    expect(reviewInspectStderr('\n', 'darwin')).toEqual({ warnings: {}, unexpected: 0 });
  });
});
