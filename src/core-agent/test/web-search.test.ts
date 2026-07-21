import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  parseBraveHtml,
  parseBingHtml,
  chooseProvider,
  webSearchTool,
  type SearchProvider,
} from "../src/tools/web-search.js";

let stateDir = "";
let previousStateDir: string | undefined;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "core-web-search-test-"));
  previousStateDir = process.env.CORE_AGENT_STATE_DIR;
  process.env.CORE_AGENT_STATE_DIR = stateDir;
});

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.CORE_AGENT_STATE_DIR;
  else process.env.CORE_AGENT_STATE_DIR = previousStateDir;
  vi.unstubAllGlobals();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

// ─── parseBraveHtml ───────────────────────────────────────────────────────

const BRAVE_FIXTURE = `
<html><body>
<div class="snippet fdb svelte-jmfu5f" data-type="web">
  <a href="https://example.com/a" class="svelte-14r20fy some-other">
    <div class="title svelte-abc123">Example <strong>A</strong></div>
  </a>
  <div class="snippet-description svelte-xyz">Snippet &amp; description A &#39;quoted&#39;</div>
</div>
<div class="snippet svelte-jmfu5f" data-type="web">
  <a href="https://example.com/b" class="svelte-14r20fy">
    <div class="title svelte-abc">Example B</div>
  </a>
  <div class="snippet-description">Second snippet</div>
</div>
<footer>not a result</footer>
</body></html>
`;

// ─── parseBingHtml ────────────────────────────────────────────────────────

const BING_FIXTURE = `
<html><body>
<ol id="b_results">
  <li class="b_algo" data-bm="1">
    <h2><a href="https://docs.example.com/page" h="ID=SERP,123.1">Docs &amp; <strong>page</strong></a></h2>
    <div class="b_caption">
      <p>Official documentation for the <strong>page</strong> feature.</p>
    </div>
  </li>
  <li class="b_algo">
    <h2><a href="javascript:void(0)">Tracking Redirect Link</a></h2>
    <div class="b_caption"><p>Should be skipped.</p></div>
  </li>
  <li class="b_algo">
    <h2><a href="https://blog.example.com/post">Blog post title</a></h2>
    <div class="b_caption"><p>Blog snippet text.</p></div>
  </li>
</ol>
</body></html>
`;

describe("web-search › parseBraveHtml", () => {
  it("extracts title, url, decoded snippet for each web-type snippet block", () => {
    const results = parseBraveHtml(BRAVE_FIXTURE);
    expect(results).toHaveLength(2);

    expect(results[0].url).toBe("https://example.com/a");
    expect(results[0].title).toBe("Example A");
    // entity decoding + strip tags
    expect(results[0].snippet).toBe("Snippet & description A 'quoted'");

    expect(results[1].url).toBe("https://example.com/b");
    expect(results[1].title).toBe("Example B");
    expect(results[1].snippet).toBe("Second snippet");
  });

  it("returns [] when the svelte class hash drifts (forward-compat sentinel)", () => {
    const html = BRAVE_FIXTURE.replace(/svelte-jmfu5f/g, "svelte-newhash");
    // Regex is pinned to the current hash, so a rebuild of brave's frontend
    // silently returns nothing. This test locks that known limitation.
    expect(parseBraveHtml(html)).toEqual([]);
  });
});

describe("web-search › parseBingHtml", () => {
  it("extracts the two organic results and skips the javascript: href", () => {
    const results = parseBingHtml(BING_FIXTURE);
    expect(results).toHaveLength(2);

    expect(results[0].url).toBe("https://docs.example.com/page");
    expect(results[0].title).toBe("Docs & page"); // &amp; decoded, <strong> stripped
    expect(results[0].snippet).toBe("Official documentation for the page feature.");

    expect(results[1].url).toBe("https://blog.example.com/post");
    expect(results[1].title).toBe("Blog post title");
    expect(results[1].snippet).toBe("Blog snippet text.");
  });

  it("returns [] when no b_algo blocks are present", () => {
    expect(parseBingHtml("<html><body><p>nothing here</p></body></html>")).toEqual([]);
  });

  it("decodes Bing's zhihu-style snippets (&ensp;, &middot;, &hellip;)", () => {
    const html = `
<html><body>
<li class="b_algo">
  <h2><a href="https://www.zhihu.com/question/1">Question title</a></h2>
  <div class="b_caption"><p>2025年11月13日&ensp;&middot;&ensp;内容摘要 &hellip;</p></div>
</li>
</body></html>
`;
    const r = parseBingHtml(html);
    expect(r).toHaveLength(1);
    // &ensp; → ASCII space, &middot; → ·, &hellip; → …
    expect(r[0].snippet).toBe("2025年11月13日 · 内容摘要 …");
  });
});

// ─── chooseProvider (provider-selection state machine) ────────────────────

describe("web-search › chooseProvider", () => {
  const probe = (brave: boolean, bing: boolean): Record<SearchProvider, boolean> => ({
    brave,
    bing,
  });

  it("no previous + both reachable → picks brave (first in order)", () => {
    expect(chooseProvider(probe(true, true))).toBe("brave");
  });

  it("no previous + only bing reachable → picks bing", () => {
    expect(chooseProvider(probe(false, true))).toBe("bing");
  });

  it("sticky: keeps cached provider when it's still reachable", () => {
    expect(chooseProvider(probe(true, true), "bing")).toBe("bing");
    expect(chooseProvider(probe(true, true), "brave")).toBe("brave");
  });

  it("switches when cached provider goes unreachable but the other is up", () => {
    expect(chooseProvider(probe(false, true), "brave")).toBe("bing");
    expect(chooseProvider(probe(true, false), "bing")).toBe("brave");
  });

  it("returns null when neither is reachable (caller surfaces network error)", () => {
    expect(chooseProvider(probe(false, false))).toBeNull();
    expect(chooseProvider(probe(false, false), "brave")).toBeNull();
  });
});

describe("web-search tool execution", () => {
  it("rejects an empty query without touching the network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await webSearchTool.execute({ query: "   " }, { state: {} });

    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain("query is required");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("probes providers, executes the preferred search, clamps count, and persists the choice", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "HEAD") return new Response("", { status: 200 });
      return new Response(BRAVE_FIXTURE, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await webSearchTool.execute({ query: "cross platform", count: 1 }, { state: {} });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Search results for: \"cross platform\" (via Brave)");
    expect(result.content).toContain("Example A");
    expect(result.content).not.toContain("Example B");
    const cache = JSON.parse(fs.readFileSync(path.join(stateDir, "web-search-cache.json"), "utf8"));
    expect(cache.preferred).toBe("brave");
  });

  it("switches from an unreachable cached provider and retries the reachable provider", async () => {
    fs.writeFileSync(path.join(stateDir, "web-search-cache.json"), JSON.stringify({
      preferred: "brave",
      probedAt: new Date().toISOString(),
    }));
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const href = String(url);
      if (init?.method === "HEAD") {
        if (href.includes("brave.com")) throw new Error("blocked");
        return new Response("", { status: 200 });
      }
      if (href.includes("brave.com")) throw new Error("blocked");
      return new Response(BING_FIXTURE, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await webSearchTool.execute({ query: "fallback" }, { state: {} });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("via Bing");
    expect(result.content).toContain("Docs & page");
    const cache = JSON.parse(fs.readFileSync(path.join(stateDir, "web-search-cache.json"), "utf8"));
    expect(cache.preferred).toBe("bing");
  });
});
