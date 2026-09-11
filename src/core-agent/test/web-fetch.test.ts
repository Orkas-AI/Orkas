import { afterEach, describe, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  resolveCharset,
  decodeBytes,
  classifyFetchContent,
  configureWebFetchRenderer,
  htmlToText,
  decodeNumericEntity,
  formatWebFetchNetworkFailure,
  webFetchTool,
} from "../src/tools/web-fetch.js";

describe("web-fetch › resolveCharset", () => {
  it("picks charset from Content-Type header when present", () => {
    expect(resolveCharset("text/html; charset=GBK", Buffer.from(""))).toBe("gbk");
    expect(resolveCharset("text/html;charset=gb2312", Buffer.from(""))).toBe("gb2312");
    expect(resolveCharset("text/html; charset=\"utf-8\"", Buffer.from(""))).toBe("utf-8");
  });

  it("header trumps meta tag (authoritative)", () => {
    const html = '<html><head><meta charset="utf-8"></head></html>';
    expect(resolveCharset("text/html; charset=gbk", Buffer.from(html))).toBe("gbk");
  });

  it("falls back to <meta charset=...> from first 2KB when header is missing", () => {
    const html = '<html><head><meta charset="GB2312"><title>x</title></head></html>';
    expect(resolveCharset("text/html", Buffer.from(html))).toBe("gb2312");
  });

  it("parses legacy <meta http-equiv> form", () => {
    const html =
      '<html><head><meta http-equiv="Content-Type" content="text/html; charset=gbk"></head></html>';
    expect(resolveCharset("text/html", Buffer.from(html))).toBe("gbk");
  });

  it("handles unquoted meta charset", () => {
    const html = "<html><head><meta charset=big5></head></html>";
    expect(resolveCharset("text/html", Buffer.from(html))).toBe("big5");
  });

  it("defaults to utf-8 when nothing is declared", () => {
    expect(resolveCharset("text/html", Buffer.from("<html></html>"))).toBe("utf-8");
    expect(resolveCharset("", Buffer.from(""))).toBe("utf-8");
  });

  it("only inspects the first 2KB of the body (no scan past head region)", () => {
    const padding = " ".repeat(4096);
    const html = `<html><head></head><body>${padding}<meta charset="gbk"></body></html>`;
    expect(resolveCharset("text/html", Buffer.from(html))).toBe("utf-8");
  });
});

describe("web-fetch › decodeBytes", () => {
  it("round-trips UTF-8 Chinese text", () => {
    const buf = Buffer.from("深圳天气", "utf-8");
    expect(decodeBytes(buf, "utf-8")).toBe("深圳天气");
  });

  it("decodes GBK bytes correctly (the huangjinjiage.cn reproducer)", () => {
    // "今日金价" in GBK = D5 EB D7 D2 E4 B3 BC DB  (8 bytes, 4 chars)
    // Wait actually: 今=BDF1 日=C8D5 金=BDF0 价=BCDB → bytes BD F1 C8 D5 BD F0 BC DB
    const bytes = Buffer.from([0xbd, 0xf1, 0xc8, 0xd5, 0xbd, 0xf0, 0xbc, 0xdb]);
    expect(decodeBytes(bytes, "gbk")).toBe("今日金价");
  });

  it("GBK bytes decoded as utf-8 produce replacement chars (the original bug)", () => {
    // Verifies that the previous hardcoded utf-8 path garbled CN pages —
    // locks in the root cause so future regressions are caught.
    const bytes = Buffer.from([0xbd, 0xf1, 0xc8, 0xd5, 0xbd, 0xf0, 0xbc, 0xdb]);
    const wrong = decodeBytes(bytes, "utf-8");
    expect(wrong).not.toBe("今日金价");
    expect(wrong).toMatch(/\uFFFD/); // U+FFFD replacement char present
  });

  it("unknown charset label falls back to utf-8 instead of throwing", () => {
    const buf = Buffer.from("hello", "utf-8");
    expect(decodeBytes(buf, "this-is-not-a-real-charset")).toBe("hello");
  });
});

describe("web-fetch › htmlToText", () => {
  it("decodes decimal astral entities via code points (emoji, not garbage)", () => {
    // Old code used String.fromCharCode(128512), which truncates to U+F600.
    expect(htmlToText("&#128512;")).toBe("😀");
  });

  it("decodes hex astral entities via code points", () => {
    expect(htmlToText("&#x1F600;")).toBe("😀");
  });

  it("drops out-of-range numeric entities instead of emitting garbage", () => {
    // 0x110000 is one past the Unicode ceiling; fromCodePoint would throw.
    expect(htmlToText("a&#1114112;b")).toBe("ab");
    expect(htmlToText("a&#x110000;b")).toBe("ab");
  });

  it("still decodes BMP numeric and named entities", () => {
    expect(htmlToText("&#65;&#x42;")).toBe("AB");
    expect(htmlToText("Fish &amp; Chips &lt;3 &nbsp;&hellip;")).toBe("Fish & Chips <3 …");
  });

  it("separates adjacent table cells with a space", () => {
    // Old code stripped </td>/</th> silently, concatenating cells into "ab".
    expect(htmlToText("<table><tr><td>a</td><td>b</td></tr></table>")).toBe("a b");
    expect(htmlToText("<table><tr><th>h1</th><th>h2</th></tr></table>")).toBe("h1 h2");
  });

  it("keeps rows on separate lines while spacing cells", () => {
    const html = "<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>";
    expect(htmlToText(html)).toBe("a b\nc d");
  });
});

describe("web-fetch › decodeNumericEntity", () => {
  it("returns astral code points intact", () => {
    expect(decodeNumericEntity(0x1f600)).toBe("😀");
  });

  it("drops NaN, negative, and beyond-Unicode inputs", () => {
    expect(decodeNumericEntity(Number.NaN)).toBe("");
    expect(decodeNumericEntity(-1)).toBe("");
    expect(decodeNumericEntity(0x110000)).toBe("");
  });
});

describe("web-fetch › webFetchTool abort signal", () => {
  function startNeverRespondingServer(): Promise<{ server: Server; url: string }> {
    return new Promise((resolve) => {
      const server = createServer(() => {
        /* accept the request, never respond */
      });
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo;
        resolve({ server, url: `http://127.0.0.1:${port}/` });
      });
    });
  }

  function stop(server: Server): Promise<void> {
    server.closeAllConnections?.();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  it("rejects promptly when the tool context signal aborts mid-flight", async () => {
    const { server, url } = await startNeverRespondingServer();
    try {
      const ac = new AbortController();
      const started = Date.now();
      const pending = webFetchTool.execute({ url }, { signal: ac.signal, state: {} });
      setTimeout(() => ac.abort(), 50);
      const result = await pending;
      const elapsed = Date.now() - started;
      expect(result.isError).toBe(true);
      expect(result.content).toContain("cancelled");
      // Old code ignored ctx.signal and hung for the full 60s timeout.
      expect(elapsed).toBeLessThan(5000);
    } finally {
      await stop(server);
    }
  }, 10_000);

  it("returns immediately for an already-aborted signal", async () => {
    const { server, url } = await startNeverRespondingServer();
    try {
      const ac = new AbortController();
      ac.abort();
      const started = Date.now();
      const result = await webFetchTool.execute({ url }, { signal: ac.signal, state: {} });
      expect(result.isError).toBe(true);
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      await stop(server);
    }
  }, 10_000);
});

describe("web-fetch › classifyFetchContent", () => {
  it("marks WAF challenge bodies as failed content", () => {
    const issue = classifyFetchContent(
      "https://xueqiu.com/3439096517/390394657",
      undefined,
      '{"_waf_bd8ce2ce37":"Pfachz2vL1SL0SmQA"}3EJP1NTyp9ak5NoRM',
      '{"_waf_bd8ce2ce37":"Pfachz2vL1SL0SmQA"}',
    );

    expect(issue).toMatchObject({ code: "WAF_OR_BOT_CHECK" });
  });

  it("marks missing social pages as failed content", () => {
    const issue = classifyFetchContent(
      "https://www.xiaohongshu.com/discovery/item/deleted",
      "小红书 - 你访问的页面不见了",
      "<html><title>小红书 - 你访问的页面不见了</title></html>",
      "小红书 - 你访问的页面不见了",
    );

    expect(issue).toMatchObject({ code: "PAGE_NOT_FOUND" });
  });

  it("marks known article navigation shells as failed content", () => {
    const issue = classifyFetchContent(
      "https://www.cls.cn/detail/xk/68a020e69b01344433be9032",
      "财联社电报：7*24小时滚动播报股市资讯",
      "<html><title>财联社电报：7*24小时滚动播报股市资讯</title></html>",
      "关于我们 网站声明 联系方式 用户反馈 网站地图 帮助 首页 电报 话题 盯盘 VIP FM 投研 下载",
    );

    expect(issue).toMatchObject({ code: "JS_OR_NAV_SHELL" });
  });

  it("marks a real Cloudflare interstitial challenge as failed content", () => {
    const issue = classifyFetchContent(
      "https://protected.example.com/article",
      "Just a moment...",
      '<html><head><title>Just a moment...</title></head><body><div class="cf-browser-verification"></div>' +
        "<p>Enable JavaScript and cookies to continue</p><script>window.__cf_chl_opt={};</script></body></html>",
      "Just a moment... Enable JavaScript and cookies to continue",
    );

    expect(issue).toMatchObject({ code: "WAF_OR_BOT_CHECK" });
  });

  it("marks a Chinese security-verification wall as failed content", () => {
    const issue = classifyFetchContent(
      "https://www.example.cn/news/123",
      "安全验证",
      "<html><title>安全验证</title><body>请完成验证后访问</body></html>",
      "安全验证 请完成验证后访问",
    );

    expect(issue).toMatchObject({ code: "WAF_OR_BOT_CHECK" });
  });

  it("does not classify normal article text as failed content", () => {
    const issue = classifyFetchContent(
      "https://example.com/article",
      "Quarterly results",
      "<html><title>Quarterly results</title><article>Revenue grew 20 percent.</article></html>",
      "Quarterly results\nRevenue grew 20 percent.",
    );

    expect(issue).toBeNull();
  });

  it("does not flag a normal page that merely loads Cloudflare CDN / Insights assets (look-alike)", () => {
    const issue = classifyFetchContent(
      "https://example.com/docs",
      "API Reference",
      '<html><head><title>API Reference</title>' +
        '<script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/prism.min.js"></script>' +
        '<script defer src="https://static.cloudflareinsights.com/beacon.min.js"></script></head>' +
        "<body><article>Call the endpoint with a bearer token.</article></body></html>",
      "API Reference\nCall the endpoint with a bearer token.",
    );

    expect(issue).toBeNull();
  });

  it("does not flag a normal page with a reCAPTCHA-protected contact form (look-alike)", () => {
    const issue = classifyFetchContent(
      "https://example.com/contact",
      "Contact us",
      '<html><head><title>Contact us</title>' +
        '<script src="https://www.google.com/recaptcha/api.js" async defer></script></head>' +
        '<body><h1>Contact us</h1><form><div class="g-recaptcha" data-sitekey="abc"></div>' +
        "<p>We usually reply within one business day.</p></form></body></html>",
      "Contact us\nWe usually reply within one business day.",
    );

    expect(issue).toBeNull();
  });
});

describe("web-fetch › safe network diagnostics", () => {
  it("surfaces a nested undici timeout code without returning arbitrary cause text", () => {
    const cause = Object.assign(new Error("connect timed out at 192.0.2.10:443"), {
      code: "UND_ERR_CONNECT_TIMEOUT",
    });
    const error = new TypeError("fetch failed", { cause });

    const result = formatWebFetchNetworkFailure(error);

    expect(result).toBe(
      "fetch failed [network_diagnostic category=timeout; codes=UND_ERR_CONNECT_TIMEOUT]",
    );
    expect(result).not.toContain("192.0.2.10");
  });

  it("inspects bounded AggregateError children and keeps only stable network codes", () => {
    const error = new TypeError("fetch failed", {
      cause: new AggregateError([
        Object.assign(new Error("IPv6 route includes a private address"), { code: "ENETUNREACH" }),
        Object.assign(new Error("IPv4 endpoint timed out"), { code: "ETIMEDOUT" }),
      ], "secret proxy details"),
    });

    const result = formatWebFetchNetworkFailure(error);

    expect(result).toBe(
      "fetch failed [network_diagnostic category=timeout; codes=ENETUNREACH,ETIMEDOUT]",
    );
    expect(result).not.toContain("private address");
    expect(result).not.toContain("secret proxy details");
  });

  it("classifies TLS failures while suppressing certificate and path details", () => {
    const error = Object.assign(
      new Error("certificate for internal.example from /Users/test/corp.pem was rejected"),
      { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" },
    );

    const result = formatWebFetchNetworkFailure(error);

    expect(result).toBe(
      "request failed [network_diagnostic category=tls; codes=UNABLE_TO_VERIFY_LEAF_SIGNATURE]",
    );
    expect(result).not.toContain("internal.example");
    expect(result).not.toContain("/Users/test");
  });

  it("uses a generic network category when the cause has no approved code", () => {
    const error = Object.assign(new Error("failed near /private/project/token.txt"), {
      code: "E_PRIVATE_SECRET",
    });

    expect(formatWebFetchNetworkFailure(error)).toBe(
      "request failed [network_diagnostic category=network; codes=unavailable]",
    );
  });

  it("returns the safe diagnostic through the web_fetch tool error result", async () => {
    const originalFetch = globalThis.fetch;
    const cause = Object.assign(new Error("lookup secret.proxy.local failed"), {
      code: "ENOTFOUND",
    });
    globalThis.fetch = async () => {
      throw new TypeError("fetch failed", { cause });
    };
    try {
      const result = await webFetchTool.execute(
        { url: "https://example.com/research" },
        { state: {} } as any,
      );

      expect(result.isError).toBe(true);
      expect(result.content).toBe(
        "Error fetching https://example.com/research: "
        + "fetch failed [network_diagnostic category=dns; codes=ENOTFOUND]",
      );
      expect(result.content).not.toContain("secret.proxy.local");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});


// ── Blocked and client-rendered responses ───────────────────────────────────
//
// Scenario source: a research run reported Trustpilot, Reddit, and YouTube as
// "no content available". Reproducing those three fetches showed the pages were
// reachable and the extractor was losing them:
//   - Trustpilot answered 403 with an AWS WAF interstitial; the body was
//     discarded, so only a bare status reached the model.
//   - Reddit answered 200 with an 8 KB JavaScript proof-of-work shell whose
//     readable text was the word "Reddit"; it was reported as a SUCCESS and
//     cached, so the empty body could not be told apart from an empty page.
//   - YouTube answered 200 with 97% of its bytes inside <script>, which the
//     extractor strips first, leaving footer boilerplate — also a "success".

/** Shape of the real Trustpilot interstitial: an AWS WAF challenge, 403. */
const AWS_WAF_INTERSTITIAL_HTML =
  '<!doctype html><html lang="en"><head><title>Verifying Connection</title>'
  + '<script src="https://example.edge.sdk.awswaf.com/challenge.js" defer></script></head>'
  + '<body><div class="container"><h1>Verifying your connection...</h1>'
  + '<p class="status">Please wait while we verify your browser.</p></div></body></html>';

/** Shape of the real Reddit shell: HTTP 200, title only, body built by script. */
function jsChallengeShellHtml(): string {
  const style = "main{align-items:center;display:flex;height:100vh;justify-content:center}".repeat(120);
  return '<!doctype html><html lang="en"><head><title>Reddit</title>'
    + '<script nonce="x">document.addEventListener("DOMContentLoaded",async function(){'
    + 'var e=document.forms[0];e.elements.namedItem("solution").value=await solve();e.requestSubmit()},{once:!0});</script>'
    + `<style>${style}</style></head><body><main><form></form></main></body></html>`;
}

/** Shape of a script-delivered page: the body exists, but only inside JSON.
 * The payload is kept large on purpose — the real page measured 1.37 MB of
 * script against 225 characters of extractable text, and a toy-sized fixture
 * would not reach the ratio this rule is meant to catch. */
function scriptDeliveredPageHtml(): string {
  const payload = JSON.stringify({
    contents: Array.from({ length: 20_000 }, (_, i) => `videoRenderer-${i}`),
  });
  return '<!doctype html><html><head><title>Rick Astley - Never Gonna Give You Up</title></head>'
    + `<body><div id="app"></div><script>var ytInitialData = ${payload};</script>`
    + "<footer>AboutPressCopyrightContact usCreatorsAdvertiseDevelopersTermsPrivacy</footer></body></html>";
}

const ARTICLE_BODY = "Higgsfield users reported credit consumption issues. ".repeat(30);
const RENDERED_ARTICLE_HTML =
  `<!doctype html><html><head><title>Higgsfield reviews</title></head><body><article>${ARTICLE_BODY}</article></body></html>`;

function startStaticServer(status: number, body: string, contentType = "text/html"): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(status, { "content-type": contentType });
      res.end(body);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}/page` });
    });
  });
}

function stopServer(server: Server): Promise<void> {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("web-fetch › blocked and client-rendered responses", () => {
  afterEach(() => {
    configureWebFetchRenderer(null);
  });

  it("names the bot check behind a 403 instead of reporting only the status", async () => {
    const { server, url } = await startStaticServer(403, AWS_WAF_INTERSTITIAL_HTML);
    try {
      const result = await webFetchTool.execute({ url }, { state: {} } as any);

      expect(result.isError).toBe(true);
      expect(result.content).toContain("HTTP 403");
      // Without the body the model cannot tell "needs credentials" from
      // "blocked as a bot", and reports the source as unavailable.
      expect(result.content).toContain("WAF_OR_BOT_CHECK");
    } finally {
      await stopServer(server);
    }
  });

  it("fails a 200 JavaScript challenge shell instead of returning it as a successful fetch", async () => {
    const { server, url } = await startStaticServer(200, jsChallengeShellHtml());
    try {
      const result = await webFetchTool.execute({ url }, { state: {} } as any);

      expect(result.isError).toBe(true);
      expect(result.content).toContain("JS_OR_NAV_SHELL");
      // The little text there was stays visible so the model can judge it.
      expect(result.content).toContain("Extracted text preview:");
    } finally {
      await stopServer(server);
    }
  });

  it("does not replay a shell as a cached success when the same URL is fetched again", async () => {
    const { server, url } = await startStaticServer(200, jsChallengeShellHtml());
    try {
      const state = {};
      await webFetchTool.execute({ url }, { state } as any);
      const second = await webFetchTool.execute({ url }, { state } as any);

      // The run cache previously replayed the empty body as WEB_FETCH_RUN_CACHE_HIT,
      // which reads as "already fetched successfully".
      expect(second.isError).toBe(true);
      expect(second.content).toContain("E_WEB_FETCH_NONRETRYABLE_CACHE_HIT");
    } finally {
      await stopServer(server);
    }
  });

  it("flags a page whose body is delivered only inside script payloads", () => {
    const raw = scriptDeliveredPageHtml();

    const issue = classifyFetchContent(
      "https://www.youtube.com/watch?v=x",
      "Rick Astley - Never Gonna Give You Up",
      raw,
      htmlToText(raw),
    );

    expect(issue).toMatchObject({ code: "JS_OR_NAV_SHELL" });
  });

  it("does not flag a genuinely short page that carries its own text", () => {
    const raw = "<html><head><title>Status</title></head><body><p>All systems operational. "
      + "Last incident: none in the past 90 days.</p></body></html>";

    expect(classifyFetchContent("https://example.com/status", "Status", raw, htmlToText(raw))).toBeNull();
  });

  it("does not flag a markup-heavy page that still carries a real body", () => {
    const rows = '<tr><td>row</td><td>0000</td></tr>'.repeat(4000);
    const article = "Quarterly revenue grew twenty percent across every region. ".repeat(90);
    const raw = `<html><head><title>Results</title></head><body><article>${article}</article><table>${rows}</table></body></html>`;

    expect(classifyFetchContent("https://example.com/results", "Results", raw, htmlToText(raw))).toBeNull();
  });
});

describe("web-fetch › browser render fallback", () => {
  afterEach(() => {
    configureWebFetchRenderer(null);
  });

  it("returns the rendered body when the direct response was a shell", async () => {
    const { server, url } = await startStaticServer(200, jsChallengeShellHtml());
    configureWebFetchRenderer(async () => ({ html: RENDERED_ARTICLE_HTML }));
    try {
      const result = await webFetchTool.execute({ url }, { state: {} } as any);

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain("Higgsfield users reported credit consumption issues.");
      // Provenance must survive into the evidence ledger.
      expect(result.content).toContain("Retrieved by: browser rendering");
    } finally {
      await stopServer(server);
    }
  });

  it("keeps the failure when rendering returns another shell", async () => {
    const { server, url } = await startStaticServer(200, jsChallengeShellHtml());
    configureWebFetchRenderer(async () => ({ html: jsChallengeShellHtml() }));
    try {
      const result = await webFetchTool.execute({ url }, { state: {} } as any);

      // Trusting a second shell would recreate the exact defect this fallback exists to fix.
      expect(result.isError).toBe(true);
      expect(result.content).toContain("JS_OR_NAV_SHELL");
      expect(result.content).not.toContain("Retrieved by: browser rendering");
    } finally {
      await stopServer(server);
    }
  });

  it("keeps the direct failure when the renderer itself fails", async () => {
    const { server, url } = await startStaticServer(200, jsChallengeShellHtml());
    configureWebFetchRenderer(async () => {
      throw new Error("renderer unavailable");
    });
    try {
      const result = await webFetchTool.execute({ url }, { state: {} } as any);

      expect(result.isError).toBe(true);
      expect(result.content).toContain("JS_OR_NAV_SHELL");
      expect(result.content).not.toContain("renderer unavailable");
    } finally {
      await stopServer(server);
    }
  });

  it("does not spend a render on a page the site reports as missing", async () => {
    const missing = '<html><head><title>Page not found</title></head><body>'
      + "<p>The page you requested could not be found.</p></body></html>";
    const { server, url } = await startStaticServer(200, missing);
    let renderCalls = 0;
    configureWebFetchRenderer(async () => {
      renderCalls += 1;
      return { html: RENDERED_ARTICLE_HTML };
    });
    try {
      const result = await webFetchTool.execute({ url }, { state: {} } as any);

      expect(result.isError).toBe(true);
      expect(result.content).toContain("PAGE_NOT_FOUND");
      expect(renderCalls).toBe(0);
    } finally {
      await stopServer(server);
    }
  });
});
