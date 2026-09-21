import { describe, expect, it } from "vitest";
import { parsePowerShellChain } from "../src/sandbox/powershell-chain.js";
import { buildShellInvocation, SandboxExecutor } from "../src/sandbox/executor.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("Windows simple command chains", () => {
  it("accepts the bounded 32-command limit", () => {
    const chain = parsePowerShellChain(Array(32).fill('Write-Output ok').join(' && '));
    expect(chain.kind).toBe('chain');
    if (chain.kind === 'chain') expect(chain.commands).toHaveLength(32);
  });
  it.each([
    ['npm install && npm test', ['npm install', 'npm test'], ['&&']],
    ['first || second && third', ['first', 'second', 'third'], ['||', '&&']],
    [`Write-Output 'a && b' && Write-Output 'it''s || literal'`,
      [`Write-Output 'a && b'`, `Write-Output 'it''s || literal'`], ['&&']],
    ['& "C:\\tool path\\node.exe" -v && Write-Output "C:\\data\\"',
      ['& "C:\\tool path\\node.exe" -v', 'Write-Output "C:\\data\\"'], ['&&']],
    ['Write-Output "a `" && b" || Write-Output "$env:TEMP"',
      ['Write-Output "a `" && b"', 'Write-Output "$env:TEMP"'], ['||']],
  ])("preserves command bytes and operator order: %s", (source, commands, operators) => {
    expect(parsePowerShellChain(source)).toEqual({ kind: "chain", commands, operators });
  });

  it.each([
    "Write-Output '&& ||'", 'Write-Output "&& ||"',
    "Write-Output 'a'' && b'", "Write-Output done # && is a comment",
  ])("leaves literal operators alone: %s", source => {
    expect(parsePowerShellChain(source)).toEqual({ kind: "none" });
    expect(buildShellInvocation("powershell.exe", source, "win32").args.at(-1)).toContain(`\n${source}\n`);
  });

  it.each([
    'first &&', '&& second', 'first || || second', 'first && "unterminated',
    'first && (second)', 'first && $result', 'first && Write-Output "$(second)"',
    'first && Write-Output "$LASTEXITCODE"', 'first && second; third',
    'first && second\nthird', 'first && second | third', 'first && second > out.txt',
    'first && second &', 'first && . script.ps1', 'first && exit 0',
    'first && if($true) { second }', 'first && second # comment',
    'first && @"\ntext\n"@', 'first && second`\nthird',
    'first && Write-Output @(1)', 'first && [Console]::WriteLine(1)',
    'first && Write-Output "nul\0"', 'first && ' + 'x'.repeat(65_536),
    'Write-Output --% literal && second', 'Write-Output “literal && data”',
    'first && Write-Output "smart” || hidden “quote"',
    Array(33).fill('first').join(' && '),
  ])("rejects incomplete, compound or oversized chains", source => {
    expect(parsePowerShellChain(source)).toEqual({ kind: "unsupported" });
  });

  it("lowers only the legacy Windows PowerShell invocation", () => {
    const source = "first && second || third";
    for (const [shell, platform] of [
      ["pwsh.exe", "win32"], ["cmd.exe", "win32"], ["bash.exe", "win32"], ["/bin/sh", "darwin"],
    ] as const) {
      expect(buildShellInvocation(shell, source, platform).args.at(-1)).toContain(source);
    }
    const script = buildShellInvocation("powershell.exe", source, "win32").args.at(-1)!;
    const status = script.match(/\$(orkasChainSucceeded_[a-f0-9]{32})/)!;
    expect(status).not.toBeNull();
    expect(script).toContain(`first\n$${status[1]} = $?`);
    expect(script).toContain(`if ($${status[1]}) {\n$global:LASTEXITCODE = 0\nsecond`);
    expect(script).toContain(`if (-not $${status[1]}) {\n$global:LASTEXITCODE = 0\nthird`);
    expect(script).not.toContain('\n$LASTEXITCODE =');
    expect(script).toContain('elseif ($global:LASTEXITCODE -ne 0) { $global:LASTEXITCODE } else { 1 }');
    expect(script.match(/^first$|^second$|^third$/gm)).toEqual(['first', 'second', 'third']);
    expect(script).toMatch(/exit \$orkasChainExitCode_[a-f0-9]{32}/);
  });
});

// These cases need Windows PowerShell 5.1, not a POSIX emulator or pwsh 7.
// Observe real output/exit codes to catch skipped-if status resets and stale
// native failure codes; pure parsing checks cannot certify those semantics.
describe.runIf(process.platform === "win32")("native Windows PowerShell chain outcomes", () => {
  const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const node = process.env.ORKAS_TEST_NODE || process.execPath;
  const command = (label: string, code: number) =>
    `& ${quote(node)} -e ${quote(`console.log('${label}');process.exit(${code})`)}`;

  it.each([
    [0, '&&', 0, '&&', 0, 'A B C', 0],
    [7, '&&', 0, '&&', 0, 'A', 7],
    [0, '||', 9, '||', 8, 'A', 0],
    [7, '||', 0, '||', 8, 'A B', 0],
    [7, '&&', 9, '||', 0, 'A C', 0],
    [0, '||', 9, '&&', 0, 'A C', 0],
    [0, '&&', 8, '||', 9, 'A B C', 9],
    [7, '||', 8, '&&', 0, 'A B', 8],
  ])("preserves short circuit and final status (%s %s %s %s %s)", async (a, op1, b, op2, c, output, code) => {
    const sandbox = new SandboxExecutor({ workingDir: os.tmpdir(), shell: "powershell.exe" });
    const result = await sandbox.execute(`${command('A', a as number)} ${op1} ${command('B', b as number)} ${op2} ${command('C', c as number)}`);
    expect(result.stdout.trim().split(/\s+/).join(' ')).toBe(output);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(code);
  }, 25_000);

  it("clears a recovered native error and preserves literal operators", async () => {
    const sandbox = new SandboxExecutor({ workingDir: os.tmpdir(), shell: "powershell.exe" });
    const result = await sandbox.execute(`${command('A', 7)} || Write-Output 'recovered && ||'`);
    expect(result.stdout.trim().split(/\r?\n/)).toEqual(['A', 'recovered && ||']);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
  }, 25_000);

  it.each([
    ['&&', '', 1], ['||', 'recovered', 0],
  ])("uses cmdlet failure for %s short circuit", async (operator, output, exitCode) => {
    const sandbox = new SandboxExecutor({ workingDir: os.tmpdir(), shell: "powershell.exe" });
    const result = await sandbox.execute(`Write-Error 'chain-test-error' ${operator} Write-Output recovered`);
    expect(result.stdout.trim()).toBe(output);
    expect(result.stderr).toContain('chain-test-error');
    expect(result.exitCode).toBe(exitCode);
  }, 25_000);

  it("cancels a running chain without starting its remaining command", async () => {
    const controller = new AbortController();
    const sandbox = new SandboxExecutor({
      workingDir: os.tmpdir(), shell: "powershell.exe", signal: controller.signal, timeoutMs: 10_000,
    });
    const source = `& ${quote(node)} -e ${quote("console.log('READY');setInterval(()=>{},1000)")} && Write-Output MUST-NOT-RUN`;
    const result = await sandbox.execute(source, {
      onStart() {},
      onOutput(bytes, stream) {
        if (stream === 'stdout' && bytes.toString().includes('READY')) controller.abort();
      },
    });
    expect(result.stdout).toContain('READY');
    expect(result.stdout).not.toContain('MUST-NOT-RUN');
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
  }, 25_000);

  it("retains cwd and environment in the same process", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'orkas-chain-'));
    try {
      const sandbox = new SandboxExecutor({ workingDir: os.tmpdir(), shell: "powershell.exe" });
      const source = `Set-Location ${quote(cwd)} && Set-Item Env:ORKAS_CHAIN_TEST kept && & ${quote(node)} -e ${quote('console.log(JSON.stringify([process.cwd(),process.env.ORKAS_CHAIN_TEST]))')}`;
      const result = await sandbox.execute(source);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout.trim())).toEqual([cwd, 'kept']);
    } finally { await fs.rm(cwd, { recursive: true, force: true }); }
  }, 25_000);
});
