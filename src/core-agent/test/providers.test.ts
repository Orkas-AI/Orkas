import { describe, it, expect } from "vitest";
import { ProviderRegistry } from "../src/providers/registry.js";
import { createAnthropicProvider, createOpenAIProvider, createPiProvider, listPiProviders, listPiModels } from "../src/providers/pi-provider.js";
import { createConfig } from "../src/config/loader.js";

describe("Providers (pi-ai backed)", () => {
  describe("createAnthropicProvider", () => {
    it("creates a provider with correct id and name", () => {
      const provider = createAnthropicProvider({ apiKey: "test" });
      expect(provider.id).toBe("anthropic");
      expect(provider.name).toBe("Anthropic");
    });

    it("has complete, stream, and validateAuth methods", () => {
      const provider = createAnthropicProvider({ apiKey: "test" });
      expect(typeof provider.complete).toBe("function");
      expect(typeof provider.stream).toBe("function");
      expect(typeof provider.validateAuth).toBe("function");
    });
  });

  describe("createOpenAIProvider", () => {
    it("creates a provider with correct id and name", () => {
      const provider = createOpenAIProvider({ apiKey: "test" });
      expect(provider.id).toBe("openai");
      expect(provider.name).toBe("Openai");
    });

    it("has complete, stream, and validateAuth methods", () => {
      const provider = createOpenAIProvider({ apiKey: "test" });
      expect(typeof provider.complete).toBe("function");
      expect(typeof provider.stream).toBe("function");
      expect(typeof provider.validateAuth).toBe("function");
    });
  });

  describe("createPiProvider", () => {
    it("creates a provider for any pi-ai supported provider", () => {
      const provider = createPiProvider({ provider: "anthropic", model: "claude-opus-4-8" });
      expect(provider.id).toBe("anthropic");
    });

    it("creates google provider", () => {
      const provider = createPiProvider({ provider: "google" });
      expect(provider.id).toBe("google");
    });
  });

  describe("listPiProviders / listPiModels", () => {
    it("lists available providers", () => {
      const providers = listPiProviders();
      expect(providers).toContain("anthropic");
      expect(providers).toContain("openai");
      expect(providers).toContain("google");
      expect(providers.length).toBeGreaterThan(5);
    });

    it("lists models for a provider", () => {
      const models = listPiModels("anthropic");
      expect(models.length).toBeGreaterThan(0);
      expect(models.some((m) => m.id.includes("claude"))).toBe(true);
    });

    it("returns empty array for unknown provider", () => {
      const models = listPiModels("nonexistent");
      expect(models).toEqual([]);
    });
  });

  describe("ProviderRegistry", () => {
    it("creates registry with built-in factories", () => {
      const registry = new ProviderRegistry();
      const list = registry.list();
      expect(list).toContain("anthropic");
      expect(list).toContain("openai");
    });

    it("lists all pi-ai providers", () => {
      const registry = new ProviderRegistry();
      const list = registry.list();
      expect(list).toContain("google");
      expect(list).toContain("mistral");
      expect(list.length).toBeGreaterThan(10);
    });

    it("gets provider by id, creating from factory", () => {
      const registry = new ProviderRegistry();
      const provider = registry.get("anthropic");
      expect(provider).toBeDefined();
      expect(provider?.id).toBe("anthropic");
    });

    it("gets pi-ai provider by id even without explicit factory", () => {
      const registry = new ProviderRegistry();
      const provider = registry.get("google");
      expect(provider).toBeDefined();
      expect(provider?.id).toBe("google");
    });

    it("returns undefined for unknown provider", () => {
      const registry = new ProviderRegistry();
      expect(registry.get("unknown-provider-xyz")).toBeUndefined();
    });

    it("resolves provider from model string with slash", () => {
      const registry = new ProviderRegistry();
      const resolved = registry.resolveForModel("anthropic/claude-opus-4-8");
      expect(resolved).toBeDefined();
      expect(resolved?.provider.id).toBe("anthropic");
      expect(resolved?.modelId).toBe("claude-opus-4-8");
    });

    it("resolves anthropic provider for claude- prefixed models", () => {
      const registry = new ProviderRegistry();
      const resolved = registry.resolveForModel("claude-opus-4-8");
      expect(resolved).toBeDefined();
      expect(resolved?.provider.id).toBe("anthropic");
    });

    it("resolves openai provider for gpt- prefixed models", () => {
      const registry = new ProviderRegistry();
      const resolved = registry.resolveForModel("gpt-4o");
      expect(resolved).toBeDefined();
      expect(resolved?.provider.id).toBe("openai");
    });

    it("resolves google provider for gemini- prefixed models", () => {
      const registry = new ProviderRegistry();
      const resolved = registry.resolveForModel("gemini-2.0-flash");
      expect(resolved).toBeDefined();
      expect(resolved?.provider.id).toBe("google");
    });

    it("creates providers from config", () => {
      const config = createConfig({
        models: {
          providers: {
            anthropic: { apiKey: "my-key" },
          },
        },
      });
      const registry = new ProviderRegistry(config);
      const provider = registry.get("anthropic");
      expect(provider).toBeDefined();
    });

    it("allows registering custom factories", () => {
      const registry = new ProviderRegistry();
      registry.registerFactory("custom", () => ({
        id: "custom",
        name: "Custom",
        complete: async () => { throw new Error("not implemented"); },
        stream: async function* () {},
        validateAuth: async () => true,
      }));

      const provider = registry.get("custom");
      expect(provider).toBeDefined();
      expect(provider?.id).toBe("custom");
    });
  });
});
