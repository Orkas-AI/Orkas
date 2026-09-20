import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { expect, it, vi } from "vitest";
import { killProcessTree, SandboxExecutor } from "../src/sandbox/executor.js";

const node = process.env.ORKAS_TEST_NODE || process.execPath;
const quote = (text: string) => `'${text.replace(/'/g, "''")}'`;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

it.runIf(process.platform === "win32")("cleans up eight simultaneous deadlines without an incomplete-tree fallback", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-concurrent-cleanup-"));
  const warnings = vi.spyOn(console, "warn");
  const dirs = Array.from({ length: 8 }, (_, index) => path.join(root, String(index)));
  try {
    await Promise.all(dirs.map(async dir => {
      await fs.mkdir(dir);
      const script = "require('fs').writeFileSync('producer.pid',String(process.pid));setInterval(()=>{},1000);setTimeout(()=>process.exit(0),10000)";
      const result = await new SandboxExecutor({ workingDir: dir, timeoutMs: 250 })
        .execute(`& ${quote(node)} -e ${quote(script)}`);
      expect(result.timedOut).toBe(true);
      const pid = await fs.readFile(path.join(dir, "producer.pid"), "utf8").catch(() => "");
      if (pid) expect(() => process.kill(Number(pid), 0)).toThrow();
    }));
    expect(warnings.mock.calls).toEqual([]);
  } finally {
    warnings.mockRestore();
    for (const dir of dirs) {
      const pid = await fs.readFile(path.join(dir, "producer.pid"), "utf8").catch(() => "");
      if (pid) { try { process.kill(Number(pid)); } catch { /* already reaped */ } }
    }
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 15_000);

it.runIf(process.platform === "win32")("reaps a child born after the cleanup snapshot without killing an unrelated producer", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-late-child-"));
  let root: ChildProcess | undefined;
  let sibling: ChildProcess | undefined;
  try {
    const childScript = "require('fs').writeFileSync('late.pid',String(process.pid));"
      + "setInterval(()=>require('fs').appendFileSync('ticks','x'),20);setTimeout(()=>process.exit(0),10000)";
    const producerScript = `const fs=require('fs');fs.writeFileSync('producer.pid',String(process.pid));let started=false;setInterval(()=>{if(!started&&fs.existsSync('go')){started=true;`
      + `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{windowsHide:true,detached:true,stdio:'inherit'});}},5);`
      + "console.log('ready');setTimeout(()=>process.exit(0),10000)";
    // Detached descendants model shells that do not automatically reap their
    // children, while retaining real parent identities and inherited pipes.
    const rootScript = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(producerScript)}],`
      + "{windowsHide:true,detached:true,stdio:'inherit'});setInterval(()=>{},1000);setTimeout(()=>process.exit(0),10000)";
    sibling = spawn(node, ["-e", "console.log('ready');setInterval(()=>{},1000);setTimeout(()=>process.exit(0),10000)"], { windowsHide: true });
    await new Promise<void>((resolve, reject) => {
      sibling!.once("error", reject);
      sibling!.stdout!.once("data", () => resolve());
    });
    root = spawn(node, ["-e", rootScript], { cwd: dir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((resolve, reject) => {
      root!.once("error", reject);
      root!.stdout!.once("data", () => resolve());
    });
    // Freeze the first real Windows snapshot, then let a descendant create a child
    // before returning it. The oracle reads the child's actual OS liveness.
    const dependency = `
$script:originalSnapshot = \${function:Read-ProcessSnapshot}
function Read-ProcessSnapshot {
  $rows = @(& $script:originalSnapshot)
  # Model a stale parent id after PID reuse: this unrelated process predates
  # the owned root, so even a matching parent id must never authorize a kill.
  $older = $rows | Where-Object { $_.ProcessId -eq ${sibling.pid} }
  $rows += [pscustomobject]@{ ProcessId = ${sibling.pid}; ParentProcessId = ${root.pid}; CreationDate = $older.CreationDate }
  if (-not $script:triggered) {
    $script:triggered = $true
    [IO.File]::WriteAllText(${quote(path.join(dir, "snapshot.json"))}, (ConvertTo-Json -InputObject @($rows.ProcessId)))
    [IO.File]::WriteAllText(${quote(path.join(dir, "go"))}, 'go')
    $deadline = [DateTime]::UtcNow.AddSeconds(2)
    while (-not [IO.File]::Exists(${quote(path.join(dir, "late.pid"))})) {
      if ([DateTime]::UtcNow -gt $deadline) { throw 'fixture_child_missing' }
      Start-Sleep -Milliseconds 5
    }
  }
  return $rows
}
`;
    await new Promise<void>(resolve => killProcessTree(root!, "SIGKILL", {
      spawnFn: ((file: string, args: string[], options: any) => {
        const rewritten = [...args];
        const index = rewritten.indexOf("-EncodedCommand") + 1;
        const script = Buffer.from(rewritten[index], "base64").toString("utf16le");
        rewritten[index] = Buffer.from(script.replace("$ErrorActionPreference = 'Stop'", dependency + "\n$ErrorActionPreference = 'Stop'"), "utf16le").toString("base64");
        return spawn(file, rewritten, options);
      }) as typeof spawn,
      onComplete: resolve,
    }));
    const pid = Number(await fs.readFile(path.join(dir, "late.pid"), "utf8"));
    expect(JSON.parse(await fs.readFile(path.join(dir, "snapshot.json"), "utf8"))).not.toContain(pid);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(() => process.kill(sibling!.pid!, 0)).not.toThrow();
    const before = await fs.readFile(path.join(dir, "ticks"), "utf8").catch(() => "");
    await delay(100);
    expect(await fs.readFile(path.join(dir, "ticks"), "utf8").catch(() => "")).toBe(before);
  } finally {
    root?.kill();
    sibling?.kill();
    const pid = await fs.readFile(path.join(dir, "late.pid"), "utf8").catch(() => "");
    if (pid) { try { process.kill(Number(pid)); } catch { /* already reaped */ } }
    const producer = await fs.readFile(path.join(dir, "producer.pid"), "utf8").catch(() => "");
    if (producer) { try { process.kill(Number(producer)); } catch { /* already reaped */ } }
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 15_000);

it.runIf(process.platform === "win32")("reaps producers when the deadline overlaps shell startup and child creation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-startup-tree-"));
  let started = 0;
  try {
    for (const timeoutMs of [100, 150, 250, 350]) {
      const dir = path.join(root, String(timeoutMs));
      await fs.mkdir(dir);
      const script = "const fs=require('fs');fs.writeFileSync('producer.pid',String(process.pid));"
        + "setInterval(()=>fs.appendFileSync('ticks','x'),20);setTimeout(()=>process.exit(0),10000)";
      try {
        const result = await new SandboxExecutor({ workingDir: dir, timeoutMs })
          .execute(`& ${quote(node)} -e ${quote(script)}`);
        expect(result.timedOut).toBe(true);
        await delay(100);
        const pid = await fs.readFile(path.join(dir, "producer.pid"), "utf8").catch(() => "");
        if (pid) {
          started++;
          expect(() => process.kill(Number(pid), 0)).toThrow();
        }
        const before = await fs.readFile(path.join(dir, "ticks"), "utf8").catch(() => "");
        await delay(100);
        expect(await fs.readFile(path.join(dir, "ticks"), "utf8").catch(() => "")).toBe(before);
      } finally {
        // Only this isolated fixture writes this PID; prevent a failed oracle
        // from leaking its ten-second producer into later cases.
        const pid = await fs.readFile(path.join(dir, "producer.pid"), "utf8").catch(() => "");
        if (pid) { try { process.kill(Number(pid)); } catch { /* already reaped */ } }
      }
    }
    expect(started).toBeGreaterThan(0);
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 30_000);
