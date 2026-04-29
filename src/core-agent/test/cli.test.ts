import { describe, it, expect, vi } from "vitest";
import { CLI } from "../src/cli/cli.js";
import type { CLICommand } from "../src/cli/cli.js";

describe("CLI", () => {
  it("creates CLI with built-in commands", () => {
    const cli = new CLI();
    const commands = cli.getCommands();
    const names = commands.map((c) => c.name);
    expect(names).toContain("run");
    expect(names).toContain("chat");
    expect(names).toContain("config");
    expect(names).toContain("memory");
    expect(names).toContain("models");
    expect(names).toContain("help");
  });

  it("registers custom commands", () => {
    const cli = new CLI();
    const custom: CLICommand = {
      name: "custom",
      description: "A custom command",
      async execute() {},
    };
    cli.register(custom);
    const names = cli.getCommands().map((c) => c.name);
    expect(names).toContain("custom");
  });

  it("runs help with no args", async () => {
    const cli = new CLI();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await cli.run([]);

    expect(logSpy).toHaveBeenCalled();
    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("core-agent");
    expect(output).toContain("Commands:");

    logSpy.mockRestore();
  });

  it("runs help with --help flag", async () => {
    const cli = new CLI();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await cli.run(["--help"]);

    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("reports error for unknown command", async () => {
    const cli = new CLI();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await cli.run(["nonexistent"]);

    expect(errSpy).toHaveBeenCalled();
    const output = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("Unknown command");

    errSpy.mockRestore();
  });

  it("runs config command", async () => {
    const cli = new CLI();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await cli.run(["config"]);

    expect(logSpy).toHaveBeenCalled();
    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("defaultModel");

    logSpy.mockRestore();
  });

  it("runs models command", async () => {
    const cli = new CLI();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await cli.run(["models"]);

    expect(logSpy).toHaveBeenCalled();
    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("anthropic");
    expect(output).toContain("openai");

    logSpy.mockRestore();
  });

  it("runs models --provider anthropic", async () => {
    const cli = new CLI();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await cli.run(["models", "--provider", "anthropic"]);

    expect(logSpy).toHaveBeenCalled();
    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("claude");

    logSpy.mockRestore();
  });

  it("run command errors without message", async () => {
    const cli = new CLI();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await cli.run(["run"]);

    expect(errSpy).toHaveBeenCalled();
    const output = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("No message");

    errSpy.mockRestore();
  });
});
