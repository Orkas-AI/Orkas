import { describe, it, expect } from "vitest";
import {
  CoreAgentError,
  AuthError,
  RateLimitError,
  ContextOverflowError,
  ProviderError,
  TimeoutError,
  classifyRetryableError,
  classifyTransientNetworkError,
  isRetryableError,
  isTransientNetworkError,
  formatError,
} from "../src/shared/errors.js";
import { createLogger } from "../src/shared/logger.js";

describe("Errors", () => {
  it("CoreAgentError has code and name", () => {
    const err = new CoreAgentError("test", "TEST_CODE");
    expect(err.message).toBe("test");
    expect(err.code).toBe("TEST_CODE");
    expect(err.name).toBe("CoreAgentError");
  });

  it("AuthError inherits from CoreAgentError", () => {
    const err = new AuthError("bad key");
    expect(err).toBeInstanceOf(CoreAgentError);
    expect(err.code).toBe("AUTH_ERROR");
  });

  it("RateLimitError includes retryAfterMs", () => {
    const err = new RateLimitError("too fast", 5000);
    expect(err.retryAfterMs).toBe(5000);
    expect(err.code).toBe("RATE_LIMIT");
  });

  it("ProviderError includes provider and statusCode", () => {
    const err = new ProviderError("boom", "anthropic", 500);
    expect(err.provider).toBe("anthropic");
    expect(err.statusCode).toBe(500);
  });

  describe("isRetryableError", () => {
    it("returns true for RateLimitError", () => {
      expect(isRetryableError(new RateLimitError("rate"))).toBe(true);
    });

    it("returns true for TimeoutError", () => {
      expect(isRetryableError(new TimeoutError("timeout"))).toBe(true);
    });

    it("returns true for 429 ProviderError", () => {
      expect(isRetryableError(new ProviderError("429", "test", 429))).toBe(true);
    });

    it("returns true for 500/502/503 ProviderError", () => {
      expect(isRetryableError(new ProviderError("500", "test", 500))).toBe(true);
      expect(isRetryableError(new ProviderError("502", "test", 502))).toBe(true);
      expect(isRetryableError(new ProviderError("503", "test", 503))).toBe(true);
    });

    it("returns false for AuthError", () => {
      expect(isRetryableError(new AuthError("auth"))).toBe(false);
    });

    it("returns false for 400 ProviderError", () => {
      expect(isRetryableError(new ProviderError("400", "test", 400))).toBe(false);
    });

    it("returns false for plain Error", () => {
      expect(isRetryableError(new Error("plain"))).toBe(false);
    });

    it("returns true for undici 'terminated' (mid-stream SSE cutoff)", () => {
      expect(isRetryableError(new TypeError("terminated"))).toBe(true);
      // pi-provider wraps it into a statusCode-less ProviderError — must
      // still classify as retryable (this is the primary bug we're fixing)
      expect(isRetryableError(new ProviderError("terminated", "openai-codex"))).toBe(true);
    });

    it("returns true for hosted WebSocket stream drops", () => {
      expect(isRetryableError(new ProviderError("WebSocket error", "openai-codex"))).toBe(true);
      expect(isRetryableError(new Error("WebSocket closed unexpectedly"))).toBe(true);
    });

    it("returns true for slow SSE response-header timeouts", () => {
      const err = new ProviderError("Codex SSE response headers timed out after 10000ms", "openai-codex");
      expect(isRetryableError(err)).toBe(true);
      expect(classifyRetryableError(err)).toBe("timeout");
    });

    it("returns true for provider-agnostic stream/connection drops", () => {
      expect(isRetryableError(new ProviderError("Connection closed", "anthropic"))).toBe(true);
      expect(isRetryableError(new ProviderError("stream disconnected before completion", "openai"))).toBe(true);
      expect(isRetryableError(new Error("ERR_STREAM_PREMATURE_CLOSE"))).toBe(true);
      expect(isRetryableError(new Error("read ECONNRESET"))).toBe(true);
    });

    it("falls through to message check when statusCode alone says not retryable", () => {
      // ProviderError with statusCode=400 normally isn't retryable, but if
      // the message is a transient-network marker, the fall-through must kick in
      expect(isRetryableError(new ProviderError("terminated", "x", 400))).toBe(true);
    });

    it("returns true for Node fetch 'fetch failed'", () => {
      expect(isRetryableError(new TypeError("fetch failed"))).toBe(true);
    });

    it("returns true for retryable HTTP gateway/status families", () => {
      expect(classifyRetryableError(new ProviderError("Request Timeout", "test", 408))).toBe("timeout");
      expect(classifyRetryableError(new ProviderError("Gateway Timeout", "test", 504))).toBe("service_unavailable");
      expect(classifyRetryableError(new ProviderError("Cloudflare timeout", "test", 524))).toBe("timeout");
      expect(isRetryableError(new ProviderError("Gateway Timeout", "test", 504))).toBe(true);
    });

    it("returns true for raw socket codes via err.code", () => {
      const mk = (code: string) => Object.assign(new Error("net"), { code });
      expect(isRetryableError(mk("ECONNRESET"))).toBe(true);
      expect(isRetryableError(mk("ETIMEDOUT"))).toBe(true);
      expect(isRetryableError(mk("ECONNREFUSED"))).toBe(true);
      expect(isRetryableError(mk("EPIPE"))).toBe(true);
    });

    it("returns true for undici UND_ERR_* cause chain", () => {
      const inner = Object.assign(new Error("socket"), { code: "UND_ERR_SOCKET" });
      const outer = new TypeError("terminated");
      (outer as Error & { cause?: unknown }).cause = inner;
      expect(isRetryableError(outer)).toBe(true);

      // Even with a generic outer message, cause chain should still match
      const outer2 = Object.assign(new Error("something"), { cause: inner });
      expect(isRetryableError(outer2)).toBe(true);
    });

    it("returns false for unrelated TypeErrors", () => {
      expect(isRetryableError(new TypeError("invalid argument"))).toBe(false);
    });
  });

  describe("isTransientNetworkError", () => {
    it("matches 'terminated' message", () => {
      expect(isTransientNetworkError(new Error("terminated"))).toBe(true);
    });

    it("matches 'fetch failed'", () => {
      expect(isTransientNetworkError(new Error("fetch failed"))).toBe(true);
    });

    it("matches websocket stream errors", () => {
      expect(isTransientNetworkError(new Error("WebSocket error"))).toBe(true);
      expect(isTransientNetworkError(new Error("ws closed unexpectedly"))).toBe(true);
    });

    it("matches slow SSE response-header timeouts", () => {
      const err = new Error("Codex SSE response headers timed out after 10000ms");
      expect(isTransientNetworkError(err)).toBe(true);
      expect(classifyTransientNetworkError(err)).toBe("timeout");
    });

    it("matches generic stream/connection drops", () => {
      expect(isTransientNetworkError(new Error("Connection closed"))).toBe(true);
      expect(isTransientNetworkError(new Error("stream disconnected before completion"))).toBe(true);
      expect(isTransientNetworkError(new Error("ERR_STREAM_PREMATURE_CLOSE"))).toBe(true);
      expect(isTransientNetworkError(new Error("read ECONNRESET"))).toBe(true);
    });

    it("matches via code on direct error", () => {
      expect(isTransientNetworkError(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe(true);
      expect(isTransientNetworkError(Object.assign(new Error("x"), { code: "UND_ERR_CONNECT_TIMEOUT" }))).toBe(true);
    });

    it("walks cause chain", () => {
      const inner = Object.assign(new Error("inner"), { code: "UND_ERR_SOCKET" });
      const outer = Object.assign(new Error("outer"), { cause: inner });
      expect(isTransientNetworkError(outer)).toBe(true);
    });

    it("walks plain-object provider causes", () => {
      const err = { message: "Provider failed", cause: { code: "UND_ERR_HEADERS_TIMEOUT" } };
      expect(classifyTransientNetworkError(err)).toBe("timeout");
    });

    it("guards against runaway cause cycles", () => {
      const a: Error & { cause?: unknown } = new Error("a");
      const b: Error & { cause?: unknown } = new Error("b");
      a.cause = b;
      b.cause = a;
      // must not infinite-loop; result doesn't matter, just that it returns
      expect(() => isTransientNetworkError(a)).not.toThrow();
    });

    it("returns false for unrelated errors", () => {
      expect(isTransientNetworkError(new Error("some other thing"))).toBe(false);
      expect(isTransientNetworkError(new Error("Request was aborted"))).toBe(false);
      expect(isTransientNetworkError(null)).toBe(false);
      expect(isTransientNetworkError(undefined)).toBe(false);
      expect(isTransientNetworkError({})).toBe(false);
    });
  });

  describe("formatError", () => {
    it("formats Error objects", () => {
      expect(formatError(new Error("oops"))).toBe("oops");
    });

    it("formats non-Error values", () => {
      expect(formatError("string error")).toBe("string error");
      expect(formatError(42)).toBe("42");
    });
  });
});

describe("Logger", () => {
  it("creates a logger with subsystem prefix", () => {
    const logger = createLogger("test-subsystem");
    expect(logger).toBeDefined();
    expect(typeof logger.debug).toBe("function");
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
  });
});
