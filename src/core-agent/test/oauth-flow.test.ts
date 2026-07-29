import { describe, expect, it } from "vitest";

import { browserOpenCommand } from "../src/auth/oauth-flow.js";

describe("OAuth browser launch platform contract", () => {
  it("passes a hostile Windows OAuth URL as one literal argv token", () => {
    const url = "https://login.example/callback?state=a&next=\"calc.exe\"|more";
    const command = browserOpenCommand(url, "win32", {
      SystemRoot: "D:\\Windows",
    });

    expect(command).toEqual({
      file: "D:\\Windows\\System32\\rundll32.exe",
      args: ["url.dll,FileProtocolHandler", url],
      options: { windowsHide: true, timeout: 5_000 },
    });
    expect(command.args).toHaveLength(2);
  });

  it("uses argv-only native openers on macOS and Linux", () => {
    const url = "https://login.example/path with spaces?state=a&b=c";

    expect(browserOpenCommand(url, "darwin")).toMatchObject({
      file: "open",
      args: [url],
    });
    expect(browserOpenCommand(url, "linux")).toMatchObject({
      file: "xdg-open",
      args: [url],
    });
  });
});
