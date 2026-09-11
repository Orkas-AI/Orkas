import { describe, it, expect } from "vitest";
import { createConfig, loadConfig, CoreAgentConfigSchema } from "../src/config/index.js";

describe("Config", () => {
  describe("createConfig", () => {
    it("creates config with all defaults", () => {
      const config = createConfig();

      expect(config.agent.defaultModel).toBe("claude-opus-4-8");
      expect(config.agent.defaultProvider).toBe("anthropic");
      expect(config.agent.maxRetries).toBe(3);
      expect(config.agent.maxToolLoops).toBe(100);
    });

    it("allows overriding specific fields", () => {
      const config = createConfig({
        agent: { defaultModel: "gpt-4o", defaultProvider: "openai" },
      });

      expect(config.agent.defaultModel).toBe("gpt-4o");
      expect(config.agent.defaultProvider).toBe("openai");
      // Defaults still applied
      expect(config.agent.maxRetries).toBe(3);
    });

    it("strips a legacy memory-engine section from older config files", () => {
      // The retrieval-engine config was removed with the unwired engine
      // (2026-08-16); a config.json written by an older build must still load.
      const config = createConfig({ memory: { enabled: true, provider: "auto" } } as never);
      expect((config as Record<string, unknown>).memory).toBeUndefined();
    });

    it("accepts provider configurations", () => {
      const config = createConfig({
        models: {
          providers: {
            anthropic: { apiKey: "test-key", baseUrl: "https://custom.api" },
          },
        },
      });

      expect(config.models.providers.anthropic).toBeDefined();
      expect(config.models.providers.anthropic.apiKey).toBe("test-key");
    });
  });

  describe("CoreAgentConfigSchema", () => {
    it("validates valid config", () => {
      const result = CoreAgentConfigSchema.safeParse({
        agent: { defaultModel: "claude-opus-4-7" },
      });
      expect(result.success).toBe(true);
    });

    it("rejects negative maxRetries", () => {
      const result = CoreAgentConfigSchema.safeParse({
        agent: { maxRetries: -1 },
      });
      expect(result.success).toBe(false);
    });
  });

  describe("loadConfig", () => {
    it("returns defaults when no path given", async () => {
      const config = await loadConfig();
      expect(config.agent.defaultModel).toBe("claude-opus-4-8");
    });

    it("returns defaults for non-existent file", async () => {
      const config = await loadConfig("/tmp/nonexistent-config-12345.json");
      expect(config.agent.defaultModel).toBe("claude-opus-4-8");
    });
  });
});
