import { describe, it, expect } from "vitest";
import { createConfig, loadConfig, CoreAgentConfigSchema } from "../src/config/index.js";

describe("Config", () => {
  describe("createConfig", () => {
    it("creates config with all defaults", () => {
      const config = createConfig();

      expect(config.agent.defaultModel).toBe("claude-sonnet-4-20250514");
      expect(config.agent.defaultProvider).toBe("anthropic");
      expect(config.agent.maxRetries).toBe(3);
      expect(config.agent.maxToolLoops).toBe(50);
      expect(config.agent.thinkingLevel).toBe("off");
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

    it("creates memory config with defaults", () => {
      const config = createConfig();

      expect(config.memory.enabled).toBe(true);
      expect(config.memory.provider).toBe("auto");
      expect(config.memory.maxResults).toBe(10);
      expect(config.memory.minScore).toBe(0.3);
      expect(config.memory.fts.enabled).toBe(true);
      expect(config.memory.vector.enabled).toBe(true);
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
        agent: { defaultModel: "claude-opus-4-6" },
      });
      expect(result.success).toBe(true);
    });

    it("rejects invalid thinking level", () => {
      const result = CoreAgentConfigSchema.safeParse({
        agent: { thinkingLevel: "invalid" },
      });
      expect(result.success).toBe(false);
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
      expect(config.agent.defaultModel).toBe("claude-sonnet-4-20250514");
    });

    it("returns defaults for non-existent file", async () => {
      const config = await loadConfig("/tmp/nonexistent-config-12345.json");
      expect(config.agent.defaultModel).toBe("claude-sonnet-4-20250514");
    });
  });
});
