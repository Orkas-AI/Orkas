import { describe, it, expect } from "vitest";
import { resolveCharset, decodeBytes, classifyFetchContent } from "../src/tools/web-fetch.js";

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
