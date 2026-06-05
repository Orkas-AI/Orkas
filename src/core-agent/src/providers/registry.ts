import type { CoreAgentConfig } from "../config/schema.js";
import { createLogger } from "../shared/logger.js";
import type { LLMProvider, ProviderFactory } from "./base.js";
import { createPiProvider, createAnthropicProvider, createOpenAIProvider, listPiProviders } from "./pi-provider.js";
import { resolveApiKeyFromStore, getOAuthCredential } from "../auth/store.js";
import type { OAuthProviderInterface } from "@earendil-works/pi-ai";

const log = createLogger("providers");

/**
 * Provider registry: manages LLM provider instances.
 *
 * Now uses @earendil-works/pi-ai as the backend, giving access to 25+ providers
 * (Anthropic, OpenAI, Google, Mistral, Groq, xAI, etc.) out of the box.
 */
export class ProviderRegistry {
  private readonly providers = new Map<string, LLMProvider>();
  private readonly factories = new Map<string, ProviderFactory>();

  constructor(config?: CoreAgentConfig) {
    // Register convenience factories for the two most common providers
    this.factories.set("anthropic", createAnthropicProvider);
    this.factories.set("openai", createOpenAIProvider);

    // Create providers from config
    if (config?.models?.providers) {
      for (const [id, providerConfig] of Object.entries(config.models.providers)) {
        this.createProvider(id, providerConfig);
      }
    }
  }

  /** Register a custom provider factory. */
  registerFactory(id: string, factory: ProviderFactory): void {
    this.factories.set(id, factory);
  }

  /** Get or create a provider by ID. */
  get(id: string): LLMProvider | undefined {
    if (this.providers.has(id)) {
      return this.providers.get(id);
    }

    // Try resolving API key from stored credentials (OAuth or API key)
    const storedKey = resolveApiKeyFromStore(id);

    // Try factory first
    const factory = this.factories.get(id);
    if (factory) {
      const provider = factory({ apiKey: storedKey });
      this.providers.set(id, provider);
      return provider;
    }

    // Try creating via pi-ai for any known provider
    const piProviders = listPiProviders();
    if (piProviders.includes(id)) {
      const provider = createPiProvider({ provider: id, apiKey: storedKey });
      this.providers.set(id, provider);
      return provider;
    }

    return undefined;
  }

  /**
   * Get or create a provider, with async OAuth token refresh if needed.
   *
   * Use this instead of `get()` when you need automatic OAuth refresh support.
   */
  async getWithAuth(id: string): Promise<LLMProvider | undefined> {
    // Check if we have an expired OAuth credential that needs refresh
    const oauthCred = getOAuthCredential(id);
    if (oauthCred && Date.now() >= oauthCred.expires) {
      try {
        const { getOAuthProvider } = await import("@earendil-works/pi-ai/oauth");
        const oauthProvider = getOAuthProvider(id);
        if (oauthProvider) {
          const { refreshOAuthCredential } = await import("../auth/oauth-flow.js");
          const refreshedKey = await refreshOAuthCredential(oauthProvider);
          if (refreshedKey) {
            // Clear cached provider so it gets recreated with new key
            this.providers.delete(id);
          }
        }
      } catch (err) {
        log.warn("OAuth auto-refresh failed", { provider: id, error: (err as Error).message });
      }
    }

    return this.get(id);
  }

  /** Resolve the provider for a given model string (e.g., "anthropic/claude-opus-4-8"). */
  resolveForModel(model: string): { provider: LLMProvider; modelId: string } | undefined {
    // If model contains a slash, the prefix is the provider
    const slashIdx = model.indexOf("/");
    if (slashIdx > 0) {
      const providerId = model.slice(0, slashIdx);
      const modelId = model.slice(slashIdx + 1);
      const provider = this.get(providerId);
      if (provider) return { provider, modelId };
    }

    // Otherwise try to guess from model name
    if (model.startsWith("claude-") || model.startsWith("claude")) {
      const provider = this.get("anthropic");
      if (provider) return { provider, modelId: model };
    }
    if (model.startsWith("gpt-") || model.startsWith("o1") || model.startsWith("o3") || model.startsWith("o4")) {
      const provider = this.get("openai");
      if (provider) return { provider, modelId: model };
    }
    if (model.startsWith("gemini-")) {
      const provider = this.get("google");
      if (provider) return { provider, modelId: model };
    }
    if (model.startsWith("mistral-") || model.startsWith("codestral")) {
      const provider = this.get("mistral");
      if (provider) return { provider, modelId: model };
    }
    if (model.startsWith("grok-")) {
      const provider = this.get("xai");
      if (provider) return { provider, modelId: model };
    }

    // Fallback: try each registered provider
    for (const [, provider] of this.providers) {
      return { provider, modelId: model };
    }

    return undefined;
  }

  /** List all registered and available provider IDs. */
  list(): string[] {
    return [...new Set([
      ...this.providers.keys(),
      ...this.factories.keys(),
      ...listPiProviders(),
    ])];
  }

  private createProvider(
    id: string,
    config: { apiKey?: string; baseUrl?: string },
  ): LLMProvider | undefined {
    // Try factory
    const factory = this.factories.get(id);
    if (factory) {
      const provider = factory(config);
      this.providers.set(id, provider);
      return provider;
    }

    // Try pi-ai
    try {
      const provider = createPiProvider({
        provider: id,
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
      });
      this.providers.set(id, provider);
      return provider;
    } catch {
      log.warn(`No factory for provider: ${id}`);
      return undefined;
    }
  }
}
