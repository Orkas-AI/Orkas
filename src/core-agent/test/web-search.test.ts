import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  parseBraveHtml,
  parseBingHtml,
  parseBingRss,
  parseDuckDuckGoHtml,
  parseSoHtml,
  parseSogouHtml,
  parseYahooHtml,
  chooseProvider,
  runBuiltinWebSearch,
  webSearchTool,
  type SearchProvider,
} from "../src/tools/web-search.js";

// Catalog tool name: web_search.
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

const DUCKDUCKGO_FIXTURE = `
<html><body>
<div class="result results_links results_links_deep web-result">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a"
       href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.example.com%2Fduck&amp;rut=abc">
      Duck &amp; result
    </a>
  </h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.example.com%2Fduck">
    Direct <strong>source</strong> snippet.
  </a>
</div>
</body></html>
`;

const YAHOO_FIXTURE = `
<html><body>
<div class="dd fst algo algo-sr relsrch Sr">
  <div class="compTitle">
    <a target="_blank"
       href="https://r.search.yahoo.com/x/RU=https%3A%2F%2Fofficial.example.com%2Freport%3Fid%3D1/RK=2/RS=abc">
      <h3 class="title"><span>Yahoo <b>official</b> result</span></h3>
    </a>
  </div>
  <div class="compText"><p>Current <strong>evidence</strong> summary.</p></div>
</div></li>
</body></html>
`;

const SOGOU_FIXTURE = `
<html><body>
<div class="vrwrap result">
  <h3 class="vr-title"><a href="/link?url=tracking">Visible result</a></h3>
  <p class="star-wiki">Direct <strong>market evidence</strong>.</p>
  <div class="hidden-result"
       data-url="https://report.example.cn/ai-hiring?id=2026"
       data-title="2026%20AI%20hiring%20report"></div>
</div>
</body></html>
`;

const SO_FIXTURE = `
<html><body>
<li class="res-list result">
  <h3 class="res-title">
    <a href="https://www.so.com/link?tracking"
       data-mdurl="https://official.example.cn/2026-ai-report">
      2026 <em>AI</em> talent report
    </a>
  </h3>
  <p class="res-desc">Official <strong>market evidence</strong>.</p>
</li>
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

  it("keeps parsing when Brave changes compiled svelte class hashes", () => {
    const html = BRAVE_FIXTURE.replace(/svelte-jmfu5f/g, "svelte-newhash");
    expect(parseBraveHtml(html)).toHaveLength(2);
  });

  it("accepts semantic attributes in a different order and single quotes", () => {
    const html = `
<div data-type='web' class='card snippet svelte-next'>
  <a class='result-link' href='https://example.com/semantic'>
    <span class='result title svelte-other'>Semantic result</span>
  </a>
  <p class='snippet-description newer-hash'>Stable parser</p>
</div>`;
    expect(parseBraveHtml(html)).toEqual([{
      title: "Semantic result",
      url: "https://example.com/semantic",
      snippet: "Stable parser",
    }]);
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

  it("accepts additional class tokens and single-quoted attributes", () => {
    const html = `
<li data-bm='2' class='result b_algo new-layout'>
  <h2><a data-id='x' href='https://example.com/new-bing'>New Bing result</a></h2>
  <div class='new b_caption compact'><p>Parser remains stable.</p></div>
</li>`;
    expect(parseBingHtml(html)).toEqual([{
      title: "New Bing result",
      url: "https://example.com/new-bing",
      snippet: "Parser remains stable.",
    }]);
  });
});

describe("web-search structured fallbacks", () => {
  it("unwraps DuckDuckGo redirect URLs and extracts semantic snippets", () => {
    expect(parseDuckDuckGoHtml(DUCKDUCKGO_FIXTURE)).toEqual([{
      title: "Duck & result",
      url: "https://docs.example.com/duck",
      snippet: "Direct source snippet.",
    }]);
  });

  it("parses direct URLs from Bing RSS", () => {
    const rss = `<?xml version="1.0"?><rss><channel><item>
      <title>Official &amp; useful</title>
      <link>https://example.gov/report?id=1&amp;lang=zh</link>
      <description><![CDATA[Evidence <strong>summary</strong>.]]></description>
    </item></channel></rss>`;
    expect(parseBingRss(rss)).toEqual([{
      title: "Official & useful",
      url: "https://example.gov/report?id=1&lang=zh",
      snippet: "Evidence summary.",
    }]);
  });

  it("unwraps Yahoo result URLs and extracts the result summary", () => {
    expect(parseYahooHtml(YAHOO_FIXTURE)).toEqual([{
      title: "Yahoo official result",
      url: "https://official.example.com/report?id=1",
      snippet: "Current evidence summary.",
    }]);
  });

  it("uses Sogou's direct result metadata instead of its tracking link", () => {
    expect(parseSogouHtml(SOGOU_FIXTURE)).toEqual([{
      title: "2026 AI hiring report",
      url: "https://report.example.cn/ai-hiring?id=2026",
      snippet: "Direct market evidence.",
    }]);
  });

  it("uses 360 Search's direct source metadata instead of its tracking link", () => {
    expect(parseSoHtml(SO_FIXTURE)).toEqual([{
      title: "2026 AI talent report",
      url: "https://official.example.cn/2026-ai-report",
      snippet: "Official market evidence.",
    }]);
  });

  it("drops direct metadata URLs that already point at an error page", () => {
    const html = SO_FIXTURE.replace(
      "https://official.example.cn/2026-ai-report",
      "https://www.sohu.com/404.html",
    );
    expect(parseSoHtml(html)).toEqual([]);
  });
});

// ─── chooseProvider (provider-selection state machine) ────────────────────

describe("web-search › chooseProvider", () => {
  const probe = (
    brave: boolean,
    bing: boolean,
    duckduckgo = false,
    yahoo = false,
    sogou = false,
    so = false,
  ): Record<SearchProvider, boolean> => ({
    brave,
    duckduckgo,
    so,
    sogou,
    yahoo,
    bing,
  });

  it("no previous + both reachable → picks brave (first in order)", () => {
    expect(chooseProvider(probe(true, true))).toBe("brave");
  });

  it("uses DuckDuckGo before Bing when Brave is unavailable", () => {
    expect(chooseProvider(probe(false, true, true))).toBe("duckduckgo");
  });

  it("uses Yahoo before Bing when earlier providers are unavailable", () => {
    expect(chooseProvider(probe(false, true, false, true))).toBe("yahoo");
  });

  it("uses Sogou when Yahoo and earlier providers are unavailable", () => {
    expect(chooseProvider(probe(false, true, false, false, true))).toBe("sogou");
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

  it("starts Chinese queries on 360 Search's direct-URL index", async () => {
    const fetchMock = vi.fn(async () => new Response(SO_FIXTURE, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await webSearchTool.execute({ query: "中国 AI 招聘" }, { state: {} });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("via 360 Search");
    expect(String(fetchMock.mock.calls[0][0])).toContain("www.so.com");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("executes the default provider without probe requests, clamps count, and persists the choice", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
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
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.every(([, init]) => init?.method !== "HEAD")).toBe(true);
  });

  it("switches from an unreachable cached provider and retries DuckDuckGo", async () => {
    fs.writeFileSync(path.join(stateDir, "web-search-cache.json"), JSON.stringify({
      preferred: "brave",
      probedAt: new Date().toISOString(),
    }));
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      const href = String(url);
      if (href.includes("brave.com")) throw new Error("blocked");
      return new Response(DUCKDUCKGO_FIXTURE, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await webSearchTool.execute({ query: "fallback" }, { state: {} });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("via DuckDuckGo");
    expect(result.content).toContain("Duck & result");
    const cache = JSON.parse(fs.readFileSync(path.join(stateDir, "web-search-cache.json"), "utf8"));
    expect(cache.preferred).toBe("duckduckgo");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("handles a Brave 429 inside one tool call by falling back to DuckDuckGo once", async () => {
    fs.writeFileSync(path.join(stateDir, "web-search-cache.json"), JSON.stringify({
      preferred: "brave",
      probedAt: new Date().toISOString(),
    }));
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      const href = String(url);
      return href.includes("brave.com")
        ? new Response("rate limited", { status: 429, statusText: "Too Many Requests" })
        : new Response(DUCKDUCKGO_FIXTURE, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await webSearchTool.execute({ query: "rate limited fallback" }, { state: {} });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("via DuckDuckGo");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([, init]) => init?.method !== "HEAD")).toBe(true);
    const cache = JSON.parse(fs.readFileSync(path.join(stateDir, "web-search-cache.json"), "utf8"));
    expect(cache.preferred).toBe("duckduckgo");
    expect(cache.reason).toContain("HTTP 429");
  });

  it("uses Bing RSS after both Brave and DuckDuckGo fail", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const href = String(url);
      if (href.includes("brave.com")) {
        return new Response("rate limited", { status: 429, statusText: "Too Many Requests" });
      }
      if (href.includes("duckduckgo.com")) {
        return new Response("unavailable", { status: 503, statusText: "Service Unavailable" });
      }
      if (href.includes("sogou.com")) {
        return new Response("unavailable", { status: 503, statusText: "Service Unavailable" });
      }
      if (href.includes("yahoo.com")) {
        return new Response("unavailable", { status: 503, statusText: "Service Unavailable" });
      }
      return new Response(BING_FIXTURE, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await webSearchTool.execute({ query: "last resort" }, { state: {} });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("via Bing");
    expect(result.content).toContain("Docs & page");
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(String(fetchMock.mock.calls[5][0])).toContain("format=rss");
  });

  it("recovers through Yahoo when DuckDuckGo returns an anti-bot page", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const href = String(url);
      if (href.includes("brave.com")) {
        return new Response("rate limited", { status: 429, statusText: "Too Many Requests" });
      }
      if (href.includes("duckduckgo.com")) {
        return new Response("<html>challenge</html>", { status: 202 });
      }
      return new Response(YAHOO_FIXTURE, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await webSearchTool.execute({ query: "anti-bot recovery" }, { state: {} });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("via Yahoo");
    expect(result.content).toContain("https://official.example.com/report?id=1");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("recovers through Sogou when Brave and DuckDuckGo are unavailable", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const href = String(url);
      if (href.includes("brave.com")) {
        return new Response("rate limited", { status: 429, statusText: "Too Many Requests" });
      }
      if (href.includes("duckduckgo.com")) {
        return new Response("<html>challenge</html>", { status: 202 });
      }
      if (href.includes("yahoo.com")) {
        return new Response("unavailable", { status: 500, statusText: "INKApi Error" });
      }
      return new Response(SOGOU_FIXTURE, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await webSearchTool.execute({ query: "Chinese market recovery" }, { state: {} });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("via Sogou");
    expect(result.content).toContain("https://report.example.cn/ai-hiring?id=2026");
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("falls back when the preferred provider returns an unparseable empty page", async () => {
    const fetchMock = vi.fn(async (url: string) => (
      String(url).includes("brave.com")
        ? new Response("<html><body>layout changed</body></html>", { status: 200 })
        : new Response(DUCKDUCKGO_FIXTURE, { status: 200 })
    ));
    vi.stubGlobal("fetch", fetchMock);

    const result = await webSearchTool.execute({ query: "parser fallback" }, { state: {} });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("via DuckDuckGo");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("serializes sibling keyless searches and reuses the recovered provider", async () => {
    let active = 0;
    let maxActive = 0;
    const fetchMock = vi.fn(async (url: string) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      return String(url).includes("brave.com")
        ? new Response("rate limited", { status: 429, statusText: "Too Many Requests" })
        : new Response(DUCKDUCKGO_FIXTURE, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const results = await Promise.all([
      runBuiltinWebSearch("first query", 5),
      runBuiltinWebSearch("second query", 5),
      runBuiltinWebSearch("third query", 5),
    ]);

    expect(results.every((result) => result.isError !== true)).toBe(true);
    expect(results.every((result) => result.content.includes("via DuckDuckGo"))).toBe(true);
    expect(maxActive).toBe(1);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("brave.com"))).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("duckduckgo.com"))).toHaveLength(3);
  });
});
