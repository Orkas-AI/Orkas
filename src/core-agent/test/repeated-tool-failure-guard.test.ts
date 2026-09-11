import { describe, expect, it } from "vitest";
import {
  LoopGuards,
  toolFailureFingerprint,
  type ToolFailureResultLike,
} from "../src/agent/loop-guards.js";

const executionFailure = (
  content: string,
  execution: NonNullable<ToolFailureResultLike["observations"]>["execution"] = {
    status: "failed",
    exitCode: 1,
  },
): ToolFailureResultLike => ({
  content,
  observations: { execution },
});

const validationFailure = (content: string, scope = "project:alpha"): ToolFailureResultLike => ({
  content,
  failureContext: {
    kind: "deterministic_validation",
    scope,
    complete: true,
    issueCount: 1,
    issueCodes: [content.match(/E_[A-Z_]+/)?.[0] || "E_UNKNOWN"],
  },
});

describe("repeated tool failure fingerprint", () => {
  it("matches the same diagnostic across volatile paths, URLs, ids, and line numbers", () => {
    const first = executionFailure(
      '<command-result code="E_PARSE"><stderr>SyntaxError at /tmp/run-123/input-41.json:17; '
      + 'request https://api.example.test/jobs/550e8400-e29b-41d4-a716-446655440000</stderr></command-result>',
    );
    const second = executionFailure(
      '<command-result code="E_PARSE"><stderr>syntaxerror at C:\\Temp\\run-987\\input-92.json:88; '
      + 'request https://api.example.test/jobs/7d444840-9dc0-11d1-b245-5ffdce74fad2</stderr></command-result>',
    );

    expect(toolFailureFingerprint(first)).toBe(toolFailureFingerprint(second));
    expect(toolFailureFingerprint(first)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it.each([
    ["exit code", executionFailure("permission denied", { status: "failed", exitCode: 2 })],
    ["timeout", executionFailure("permission denied", { status: "failed", exitCode: 1, timedOut: true })],
    ["output limit", executionFailure("permission denied", { status: "failed", exitCode: 1, outputLimitExceeded: true })],
    ["diagnostic", executionFailure("connection refused", { status: "failed", exitCode: 1 })],
  ])("keeps a different %s in a separate episode", (_label, candidate) => {
    const baseline = executionFailure("permission denied", { status: "failed", exitCode: 1 });
    expect(toolFailureFingerprint(candidate)).not.toBe(toolFailureFingerprint(baseline));
  });

  it('groups changing blocker codes only when a tool declares one complete deterministic validation scope', () => {
    const first = validationFailure('<tool-error code="E_FIRST">first blocker</tool-error>');
    const second = validationFailure('<tool-error code="E_SECOND">second blocker</tool-error>');
    const otherProject = validationFailure(
      '<tool-error code="E_SECOND">second blocker</tool-error>',
      'project:beta',
    );
    const incomplete = {
      ...second,
      failureContext: { ...second.failureContext!, complete: false },
    };

    expect(toolFailureFingerprint(first)).toBe(toolFailureFingerprint(second));
    expect(toolFailureFingerprint(first)).not.toBe(toolFailureFingerprint(otherProject));
    expect(toolFailureFingerprint(first)).not.toBe(toolFailureFingerprint(incomplete));
  });
});

describe("repeated tool failure episodes", () => {
  const failure = executionFailure('<tool-error code="E_INPUT">invalid target 17</tool-error>');

  it("nudges once for matching diagnostics across changed inputs without blocking them", () => {
    const guards = new LoopGuards();
    const first = { name: "probe", input: { target: "candidate-a" } };
    const second = { name: "probe", input: { target: "candidate-b" } };
    const third = { name: "probe", input: { target: "candidate-c" } };

    guards.observeToolFailure(first, failure);
    expect(guards.takePendingFailureNudge()).toBeNull();
    guards.observeToolFailure(second, failure);
    expect(guards.takePendingFailureNudge()).toContain("same tool failure");
    guards.observeToolFailure(third, failure);

    expect(guards.takePendingFailureNudge()).toBeNull();
    expect(guards.repeatedFailureBlockForCall(first)).toBeNull();
    expect(guards.repeatedFailureBlockForCall(second)).toBeNull();
    expect(guards.repeatedFailureBlockForCall(third)).toBeNull();
  });

  it("does not merge identical diagnostics emitted by different tools", () => {
    const guards = new LoopGuards();
    const firstTool = { name: "probe_a", input: { target: "same" } };
    const secondTool = { name: "probe_b", input: { target: "same" } };

    guards.observeToolFailure(firstTool, failure);
    guards.observeToolFailure(secondTool, failure);
    expect(guards.takePendingFailureNudge()).toBeNull();

    guards.observeToolFailure(firstTool, failure);
    expect(guards.takePendingFailureNudge()).toContain("same tool failure");
    expect(guards.repeatedFailureBlockForCall(firstTool)).not.toBeNull();
    expect(guards.repeatedFailureBlockForCall(secondTool)).toBeNull();
  });

  it("reopens an exact operation after prerequisite progress and resolves it on success", () => {
    const guards = new LoopGuards();
    const probe = { name: "probe", input: { target: "same" } };

    guards.observeToolFailure(probe, failure);
    guards.observeToolFailure(probe, failure);
    expect(guards.repeatedFailureBlockForCall(probe)).not.toBeNull();

    guards.observeToolSuccess({ name: "repair", input: { target: "dependency" } });
    expect(guards.repeatedFailureBlockForCall(probe)).toBeNull();

    guards.observeToolSuccess(probe);
    guards.observeToolFailure(probe, failure);
    expect(guards.repeatedFailureBlockForCall(probe)).toBeNull();
  });

  it('nudges one deterministic validation episode even when its blocker codes change', () => {
    const guards = new LoopGuards();
    const inspect = { name: 'inspect', input: { project: 'alpha' } };

    guards.observeToolFailure(inspect, validationFailure('<tool-error code="E_FIRST">first</tool-error>'));
    expect(guards.takePendingFailureNudge()).toBeNull();
    guards.observeToolSuccess({ name: 'edit_file', input: { path: 'manifest.json' } });
    guards.observeToolFailure(inspect, validationFailure('<tool-error code="E_SECOND">second</tool-error>'));

    expect(guards.takePendingFailureNudge()).toContain('deterministic validation scope');
    expect(guards.repeatedFailureBlockForCall(inspect)).toBeNull();
  });

  it('does not hard-block a changed diagnostic merely because its validation scope is unchanged', () => {
    const guards = new LoopGuards();
    const inspect = { name: 'inspect', input: { project: 'alpha' } };

    guards.observeToolFailure(inspect, validationFailure('<tool-error code="E_FIRST">first</tool-error>'));
    guards.observeToolFailure(inspect, validationFailure('<tool-error code="E_SECOND">second</tool-error>'));

    expect(guards.takePendingFailureNudge()).toContain('deterministic validation scope');
    expect(guards.repeatedFailureBlockForCall(inspect)).toBeNull();

    guards.observeToolFailure(inspect, validationFailure('<tool-error code="E_SECOND">second</tool-error>'));
    expect(guards.repeatedFailureBlockForCall(inspect)).not.toBeNull();
  });
});
