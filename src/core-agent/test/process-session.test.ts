import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _resetProcessSessionsForTest,
  getProcessSessionTools,
} from "../src/tools/process-session.js";
import type { ToolContext } from "../src/tools/base.js";

const TEST_NODE = process.env.ORKAS_TEST_NODE || process.execPath;
let workingDir = "";

function shellQuote(value: string): string {
  return process.platform === "win32"
    ? `'${value.replace(/'/g, "''")}'`
    : `'${value.replace(/'/g, "'\\''")}'`;
}

function shellInvoke(executable: string, args: string[]): string {
  const command = [shellQuote(executable), ...args.map(shellQuote)].join(" ");
  return process.platform === "win32" ? `& ${command}` : command;
}

function context(owner: string): ToolContext {
  return { workingDir, state: { processSessionOwner: owner } };
}

function tool(name: string) {
  const found = getProcessSessionTools().find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing ${name}`);
  return found;
}

function json(content: string): Record<string, any> {
  return JSON.parse(content) as Record<string, any>;
}

beforeEach(async () => {
  workingDir = await fs.mkdtemp(path.join(os.tmpdir(), "core-process-session-"));
});

afterEach(async () => {
  await _resetProcessSessionsForTest();
  await fs.rm(workingDir, {
    recursive: true,
    force: true,
    maxRetries: process.platform === "win32" ? 10 : 0,
    retryDelay: 100,
  });
});

describe("persistent process sessions", () => {
  it("streams cursor-based output across separate Agent tool contexts", async () => {
    const command = shellInvoke(TEST_NODE, [
      "-e",
      "process.stdout.write('first\\n');setTimeout(()=>{process.stdout.write('second\\n')},500);setTimeout(()=>process.exit(0),550)",
    ]);
    const started = await tool("process_start").execute({ command }, context("conversation-a"));
    expect(started.isError).toBeUndefined();
    const first = json(started.content);
    expect(first.output).toContain("first");

    await new Promise((resolve) => setTimeout(resolve, 650));
    const later = await tool("process_read").execute({
      session_id: first.session_id,
      cursor: first.next_cursor,
    }, context("conversation-a"));
    const second = json(later.content);
    expect(second.output).toContain("second");
    expect(second.output).not.toContain("first");
    expect(second.status).toBe("exited");
    expect(later.observations?.execution).toMatchObject({
      status: "succeeded",
      exitCode: 0,
      timedOut: false,
      outputLimitExceeded: false,
    });
    expect(later.observations?.execution?.stdout.bytes).toBeGreaterThan(0);

    const emptyResult = await tool("process_read").execute({
      session_id: first.session_id,
      cursor: second.next_cursor,
    }, context("conversation-a"));
    const empty = json(emptyResult.content);
    expect(empty.output).toBe("");
    expect(empty.has_more).toBe(false);
    expect(emptyResult.observations?.execution).toBeUndefined();
  });

  it("isolates session ids by host owner", async () => {
    const command = shellInvoke(TEST_NODE, ["-e", "setTimeout(()=>process.exit(0),500)"]);
    const started = json((await tool("process_start").execute({ command }, context("owner-a"))).content);
    const denied = await tool("process_read").execute({
      session_id: started.session_id,
    }, context("owner-b"));
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain("E_PROCESS_SESSION_NOT_FOUND");
  });

  it("writes stdin and can stop a running process tree", async () => {
    const command = shellInvoke(TEST_NODE, [
      "-e",
      "process.stdin.once('data',d=>process.stdout.write('echo:'+d.toString()));setInterval(()=>{},1000)",
    ]);
    const started = json((await tool("process_start").execute({ command }, context("owner-a"))).content);
    const written = await tool("process_write").execute({
      session_id: started.session_id,
      chars: "hello",
      add_newline: true,
    }, context("owner-a"));
    expect(written.isError).toBeUndefined();
    await expect.poll(async () => {
      const output = json((await tool("process_read").execute({
        session_id: started.session_id,
        cursor: 0,
      }, context("owner-a"))).content);
      return output.output;
    }, {
      timeout: 2_000,
      interval: 25,
    }).toContain("echo:hello");

    const stoppedResult = await tool("process_stop").execute({
      session_id: started.session_id,
    }, context("owner-a"));
    const stopped = json(stoppedResult.content);
    expect(stopped.status).toBe("stopped");
    expect(stoppedResult.observations?.execution).toMatchObject({
      status: "aborted",
      exitCode: null,
      timedOut: false,
    });
  });

  it("reports a non-zero terminal command as failed structured execution", async () => {
    const command = shellInvoke(TEST_NODE, [
      "-e",
      "process.stderr.write('failed\\n');process.exit(7)",
    ]);
    const result = await tool("process_start").execute(
      { command },
      context("owner-a"),
    );
    const payload = json(result.content);
    expect(payload.status).toBe("error");
    expect(payload.exit_code).toBe(7);
    expect(result.isError).toBe(true);
    expect(result.observations?.execution).toMatchObject({
      status: "failed",
      exitCode: 7,
    });
    expect(result.observations?.execution?.stderr.bytes).toBeGreaterThan(0);
  });
});
