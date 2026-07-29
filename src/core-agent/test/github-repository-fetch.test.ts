import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchGitHubRepositorySnapshot,
  identifyGitHubRepositoryResource,
} from "../src/tools/github-repository-fetch.js";
import { getBuiltinTools } from "../src/tools/index.js";

const REPOSITORY_URL = "https://github.com/example/project";
const METADATA_URL = "https://api.github.com/repos/example/project";
const README_URL = `${METADATA_URL}/readme`;

const metadata = {
  full_name: "example/project",
  description: "Example desktop assistant",
  pushed_at: "2026-07-28T10:00:00Z",
  license: {
    name: "Apache License 2.0",
    spdx_id: "Apache-2.0",
    url: "https://api.github.com/licenses/apache-2.0",
  },
};

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.toString() : input.url;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function textResponse(value: string, status = 200): Response {
  return new Response(value, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function repositoryResource() {
  const resource = identifyGitHubRepositoryResource(REPOSITORY_URL);
  if (!resource) throw new Error("test repository URL was not recognized");
  return resource;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GitHub repository web_fetch provider", () => {
  it("keeps metadata when the README request fails", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url === METADATA_URL) return jsonResponse(metadata);
      if (url === README_URL) return textResponse("unavailable", 503);
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchGitHubRepositorySnapshot(repositoryResource());

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Title: example/project");
    expect(result.content).toContain("- License SPDX ID: Apache-2.0");
    expect(result.content).toContain("- README unavailable: HTTP 503");
    expect(result.content).toContain("README unavailable; do not infer README-backed claims.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the README when the metadata request fails", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url === METADATA_URL) return jsonResponse({ error: "unavailable" }, 503);
      if (url === README_URL) return textResponse("# Project\nRuns locally on Windows.");
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchGitHubRepositorySnapshot(repositoryResource());

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Title: Not provided");
    expect(result.content).toContain("- Metadata unavailable: HTTP 503");
    expect(result.content).toContain("# Project\nRuns locally on Windows.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache a snapshot when both GitHub requests fail", async () => {
    const fetchMock = vi.fn(async () => textResponse("unavailable", 503));
    vi.stubGlobal("fetch", fetchMock);
    const webFetch = getBuiltinTools().find((tool) => tool.name === "web_fetch")!;
    const context = { state: {} };

    const first = await webFetch.execute({ url: REPOSITORY_URL }, context);
    const second = await webFetch.execute({ url: REPOSITORY_URL }, context);

    expect(first.isError).toBe(true);
    expect(second.isError).toBe(true);
    expect(first.content).toContain("Metadata: HTTP 503");
    expect(first.content).toContain("README: HTTP 503");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("recognizes repository sources without intercepting issues, pull requests, or trees", () => {
    expect(identifyGitHubRepositoryResource(REPOSITORY_URL)).toMatchObject({
      kind: "repository",
      key: "example/project",
    });
    expect(identifyGitHubRepositoryResource(METADATA_URL)).toMatchObject({
      kind: "metadata",
      key: "example/project",
    });
    expect(identifyGitHubRepositoryResource(README_URL)).toMatchObject({
      kind: "readme",
      key: "example/project",
    });
    expect(
      identifyGitHubRepositoryResource(
        "https://raw.githubusercontent.com/example/project/main/README.md",
      ),
    ).toMatchObject({
      kind: "readme",
      key: "example/project",
    });
    expect(identifyGitHubRepositoryResource(`${REPOSITORY_URL}/issues/1`)).toBeNull();
    expect(identifyGitHubRepositoryResource(`${REPOSITORY_URL}/pull/2`)).toBeNull();
    expect(identifyGitHubRepositoryResource(`${REPOSITORY_URL}/tree/main`)).toBeNull();
  });

  it("decodes GitHub's base64 README representation", async () => {
    const readme = "# Project\nInstall the signed desktop package.";
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url === METADATA_URL) return jsonResponse(metadata);
      if (url === README_URL) {
        return jsonResponse({
          encoding: "base64",
          content: Buffer.from(readme, "utf8").toString("base64"),
        });
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchGitHubRepositorySnapshot(repositoryResource());

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain(readme);
    expect(result.content).not.toContain(Buffer.from(readme, "utf8").toString("base64"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
