import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export const DEFAULT_PROCESS_OUTPUT_MEMORY_BYTES = 1024 * 1024;
export const DEFAULT_PROCESS_OUTPUT_SPOOL_BYTES = 64 * 1024 * 1024;

export type StreamedToolOutput = {
  /** UTF-8 text file waiting for the host Result Store to content-address it. */
  path: string;
  size: number;
  /** True only when the higher hard safety limit was reached. */
  sourceTruncated?: boolean;
};

export type CapturedProcessOutput = {
  text: string;
  bytes: number;
  streamedOutput?: StreamedToolOutput;
};

export type ProcessOutputCaptureOptions = {
  spoolDir?: string;
  prefix: string;
  memoryBytes?: number;
  maxSpoolBytes?: number;
};

/**
 * Capture one process stream without treating the in-memory preview threshold
 * as a data-loss threshold.
 *
 * With a spool directory, every byte is written to a mode-0600 temp file while
 * at most `memoryBytes` is retained in RAM. The process may continue until the
 * separate `maxSpoolBytes` hard safety limit. Without a spool directory this
 * intentionally preserves the legacy bounded-buffer behavior.
 */
export class ProcessOutputCapture {
  private readonly memoryLimit: number;
  private readonly hardLimit: number;
  private readonly memoryChunks: Buffer[] = [];
  private memorySize = 0;
  private totalSize = 0;
  private fd: number | null = null;
  private spoolPath: string | null = null;
  private finalized = false;
  private truncated = false;

  constructor(opts: ProcessOutputCaptureOptions) {
    this.memoryLimit = positiveInt(opts.memoryBytes, DEFAULT_PROCESS_OUTPUT_MEMORY_BYTES);
    const requestedHardLimit = positiveInt(opts.maxSpoolBytes, DEFAULT_PROCESS_OUTPUT_SPOOL_BYTES);
    const spoolDir = typeof opts.spoolDir === "string" && opts.spoolDir.trim()
      ? path.resolve(opts.spoolDir)
      : null;
    if (spoolDir) {
      try {
        fs.mkdirSync(spoolDir, { recursive: true, mode: 0o700 });
        const safePrefix = String(opts.prefix || "output")
          .replace(/[^a-zA-Z0-9_-]+/g, "_")
          .slice(0, 40) || "output";
        this.spoolPath = path.join(
          spoolDir,
          `.${safePrefix}.${process.pid}.${randomBytes(8).toString("hex")}.spool`,
        );
        this.fd = fs.openSync(this.spoolPath, "wx", 0o600);
      } catch {
        this.closeAndRemoveSpool();
      }
    }
    this.hardLimit = this.fd != null
      ? Math.max(this.memoryLimit, requestedHardLimit)
      : this.memoryLimit;
  }

  /** Append bytes. Returns false exactly when the hard limit is crossed. */
  append(data: Buffer): boolean {
    if (this.finalized || this.truncated || !data.length) return !this.truncated;
    const remaining = Math.max(0, this.hardLimit - this.totalSize);
    const accepted = data.subarray(0, Math.min(data.length, remaining));
    if (accepted.length) {
      if (this.fd != null) {
        try {
          fs.writeSync(this.fd, accepted);
        } catch {
          // Once streaming fails, the already-buffered prefix is the only safe
          // output we can promise. Switch to explicit truncation and let the
          // caller terminate the producer.
          this.closeAndRemoveSpool();
          this.truncated = true;
          return false;
        }
      }
      const memoryRemaining = Math.max(0, this.memoryLimit - this.memorySize);
      if (memoryRemaining) {
        const previewPart = accepted.subarray(0, Math.min(accepted.length, memoryRemaining));
        this.memoryChunks.push(previewPart);
        this.memorySize += previewPart.length;
      }
      this.totalSize += accepted.length;
    }
    if (accepted.length < data.length) {
      this.truncated = true;
      return false;
    }
    return true;
  }

  finish(opts: {
    decode: (bytes: Buffer) => string;
    /** Windows console output may use a legacy code page. Normalize the bounded
     * spool to UTF-8 once after the process exits so Result Store readers are
     * encoding-independent. */
    normalizeSpoolToUtf8?: boolean;
  }): CapturedProcessOutput {
    if (this.finalized) throw new Error("ProcessOutputCapture already finalized");
    this.finalized = true;
    this.closeSpool();

    let preview = opts.decode(Buffer.concat(this.memoryChunks));
    if (this.spoolPath && this.totalSize > this.memoryLimit) {
      if (opts.normalizeSpoolToUtf8) {
        const decoded = opts.decode(fs.readFileSync(this.spoolPath));
        fs.writeFileSync(this.spoolPath, decoded, { encoding: "utf8", mode: 0o600 });
        this.totalSize = fs.statSync(this.spoolPath).size;
      }
      const omittedBytes = Math.max(0, this.totalSize - this.memorySize);
      preview += `\n... [${omittedBytes} bytes omitted from preview; full output streamed to Result Store]`;
      if (this.truncated) {
        preview += `\n[WARNING: source output exceeded the ${this.hardLimit}-byte hard safety limit; the stored prefix is incomplete.]`;
      }
      return {
        text: preview,
        bytes: this.totalSize,
        streamedOutput: {
          path: this.spoolPath,
          size: this.totalSize,
          ...(this.truncated ? { sourceTruncated: true } : {}),
        },
      };
    }

    this.closeAndRemoveSpool();
    if (this.truncated) preview += "\n... [output truncated by sandbox]";
    return { text: preview, bytes: this.totalSize };
  }

  discard(): void {
    this.finalized = true;
    this.closeAndRemoveSpool();
  }

  private closeSpool(): void {
    if (this.fd == null) return;
    try { fs.closeSync(this.fd); } catch { /* best-effort */ }
    this.fd = null;
  }

  private closeAndRemoveSpool(): void {
    this.closeSpool();
    if (!this.spoolPath) return;
    try { fs.unlinkSync(this.spoolPath); } catch { /* best-effort */ }
    this.spoolPath = null;
  }
}

export function discardStreamedToolOutput(output: StreamedToolOutput | undefined): void {
  if (!output?.path) return;
  try { fs.unlinkSync(output.path); } catch { /* best-effort */ }
}

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.trunc(value))
    : fallback;
}
