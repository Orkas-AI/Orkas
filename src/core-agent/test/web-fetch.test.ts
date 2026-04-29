import { describe, it, expect } from "vitest";
import { resolveCharset, decodeBytes } from "../src/tools/web-fetch.js";

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
