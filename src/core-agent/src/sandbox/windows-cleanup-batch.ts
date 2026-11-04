import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { windowsTreeCleanupCommand } from "./windows-process-tree.js";

type OwnedChild = Pick<ChildProcess, "pid"> & Partial<Pick<ChildProcess, "exitCode" | "signalCode">>;
type Request = {
  child: OwnedChild; deadline: number; timer: ReturnType<typeof setTimeout>;
  authorized: boolean; ready: boolean; receipt?: boolean; failed: boolean; settled: boolean;
  finish(failed: boolean, terminated: boolean): void;
};
type Batch = { requests: Request[]; accepting: boolean; closed: boolean; helper?: ChildProcess };
// Share only cold startup. The manifest seals admission, so later cancellation
// cannot add work ahead of roots already being swept or renew their lifetime.
const starting = new WeakMap<typeof spawn, Batch>();
const MAX_BATCH_ROOTS = 64;
const MAX_RECEIPT_BYTES = 8192;
const live = (child: OwnedChild) => child.exitCode == null && child.signalCode == null;

export function queueWindowsTreeCleanup(
  child: OwnedChild, timeoutMs: number, spawnFn: typeof spawn,
  onComplete: (failed: boolean, terminated: boolean) => void,
): void {
  if (!Number.isSafeInteger(child.pid) || child.pid! <= 0) { onComplete(true, false); return; }
  const deadline = Date.now() + timeoutMs;
  let batch = starting.get(spawnFn);
  const fresh = !batch || !batch.accepting || batch.requests.length >= MAX_BATCH_ROOTS;
  if (fresh) {
    batch = { requests: [], accepting: true, closed: false };
    starting.set(spawnFn, batch);
  }
  const owner = batch!;
  const seal = () => {
    owner.accepting = false;
    if (starting.get(spawnFn) === owner) starting.delete(spawnFn);
  };
  const request: Request = {
    child, deadline, authorized: false, ready: false, failed: false, settled: false,
    timer: undefined as unknown as ReturnType<typeof setTimeout>,
    finish(failed, terminated) {
      if (request.settled) return;
      request.settled = true;
      clearTimeout(request.timer);
      // I/O can be dispatched before an already-due timer after a busy turn.
      // A late success receipt must not bypass the request's deadline.
      failed ||= Date.now() >= request.deadline;
      onComplete(failed && (request.authorized || live(child)), !failed && request.authorized && terminated);
    },
  };
  owner.requests.push(request);
  request.timer = setTimeout(() => {
    // A wedged startup cannot stay open through a stream of later arrivals.
    seal();
    request.finish(true, false);
    if (owner.requests.every(item => item.settled)) {
      seal();
      try { owner.helper?.kill(); } catch { /* Already exited. */ }
    }
  }, Math.max(0, deadline - Date.now()));
  request.timer.unref?.();
  if (!fresh) return;

  let buffered = "", receivedBytes = 0, manifestSent = false, invalid = false;
  const complete = (failed: boolean) => {
    if (owner.closed) return;
    owner.closed = true;
    seal();
    for (const item of owner.requests) item.finish(failed || item.receipt === undefined, item.receipt === true);
    owner.helper?.stdin?.destroy();
  };
  const fail = () => {
    invalid = true;
    complete(true);
    try { owner.helper?.kill(); } catch { /* Already exited. */ }
  };
  try {
    const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
    const helper = spawnFn(path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", windowsTreeCleanupCommand(),
    ], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    owner.helper = helper;
    helper.stdin?.on("error", fail);
    helper.stdout?.on("data", (data: Buffer) => {
      if (owner.closed) return;
      receivedBytes += data.length;
      if (receivedBytes > MAX_RECEIPT_BYTES) { fail(); return; }
      buffered += data.toString("utf8");
      let end: number;
      while ((end = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, end).replace(/\r$/, "");
        buffered = buffered.slice(end + 1);
        if (line === "accepting" && !manifestSent) {
          seal();
          manifestSent = true;
          helper.stdin?.write(owner.requests.map((item, id) => `${id},${item.child.pid},${item.deadline}`).join(";") + "\n");
          continue;
        }
        const match = /^(ready|done|failed):(\d+)(?::([01]))?$/.exec(line);
        const item = match ? owner.requests[Number(match[2])] : undefined;
        if (!manifestSent || !match || !item || item.failed || invalid) { fail(); return; }
        if (match[1] === "ready" && match[3] === undefined && !item.ready && item.receipt === undefined) {
          item.ready = true;
          item.authorized = !item.settled && Date.now() < item.deadline && live(item.child);
          helper.stdin?.write(`${item.authorized ? "go" : "cancel"}:${match[2]}\n`);
        } else if (match[1] === "done" && match[3] !== undefined && item.ready && item.receipt === undefined) {
          item.receipt = match[3] === "1";
        } else if (match[1] === "failed" && match[3] === undefined && item.receipt === undefined) {
          // Keep the deadline armed until close; an error receipt must not
          // leave a wedged helper alive with no remaining watchdog.
          item.failed = true;
        } else { fail(); return; }
      }
    });
    helper.once("error", fail);
    // Exit may precede final pipe data; close owns the complete receipt.
    helper.once("close", (code) => complete(code !== 0 || invalid || buffered.length !== 0));
    // Completion belongs to the helper's close event. Keep that process handle
    // referenced until the bounded sweep settles, including after its pipes EOF.
  } catch { fail(); }
}
