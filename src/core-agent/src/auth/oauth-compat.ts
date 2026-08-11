/**
 * Compatibility bridge for pi-ai's pre-0.80.7 OAuth registry API.
 *
 * pi-ai now exposes OAuth through each Provider's `auth.oauth` object. Orkas
 * still stores multiple labelled profiles and owns the login UI, so this
 * bridge adapts provider-owned flows to the small legacy interface used by
 * the desktop and core-agent. Custom Orkas flows (MiniMax Portal) are kept in
 * a local registry.
 */
import type {
  Api,
  AuthInteraction,
  AuthPrompt,
  Model,
  OAuthCredential,
  OAuthCredentials,
} from '@earendil-works/pi-ai';

export type { OAuthCredentials } from '@earendil-works/pi-ai';

export interface OAuthPromptCompat {
  message: string;
  placeholder?: string;
  allowEmpty?: boolean;
}

export interface OAuthLoginCallbacks {
  onAuth: (info: { url: string; instructions?: string }) => void;
  onDeviceCode: (info: {
    userCode: string;
    verificationUri: string;
    intervalSeconds?: number;
    expiresInSeconds?: number;
  }) => void;
  onPrompt: (prompt: OAuthPromptCompat) => Promise<string>;
  onProgress?: (message: string) => void;
  onManualCodeInput?: () => Promise<string>;
  onSelect: (prompt: {
    message: string;
    options: Array<{ id: string; label: string }>;
  }) => Promise<string | undefined>;
  signal?: AbortSignal;
}

export interface OAuthProviderInterface {
  readonly id: string;
  readonly name: string;
  login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
  usesCallbackServer?: boolean;
  refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;
  getApiKey(credentials: OAuthCredentials): string;
  modifyModels?(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[];
}

type LegacyOAuthModule = {
  getOAuthProvider?: (id: string) => OAuthProviderInterface | undefined;
  getOAuthProviders?: () => OAuthProviderInterface[];
};

const customProviders = new Map<string, OAuthProviderInterface>();
let _legacyModulePromise: Promise<LegacyOAuthModule> | null = null;
let _builtinProvidersPromise: Promise<Map<string, OAuthProviderInterface>> | null = null;

function stripCredentialType(credential: OAuthCredential): OAuthCredentials {
  const { type: _type, ...credentials } = credential;
  return credentials as OAuthCredentials;
}

function interactionFromCallbacks(callbacks: OAuthLoginCallbacks): AuthInteraction {
  return {
    signal: callbacks.signal,
    async prompt(prompt: AuthPrompt): Promise<string> {
      if (prompt.type === 'select') {
        return (await callbacks.onSelect({
          message: prompt.message,
          options: prompt.options.map((option) => ({ id: option.id, label: option.label })),
        })) || '';
      }
      if (prompt.type === 'manual_code' && callbacks.onManualCodeInput) {
        return callbacks.onManualCodeInput();
      }
      return callbacks.onPrompt({
        message: prompt.message,
        placeholder: prompt.placeholder,
        allowEmpty: prompt.type !== 'secret',
      });
    },
    notify(event): void {
      switch (event.type) {
        case 'auth_url':
          callbacks.onAuth({ url: event.url, instructions: event.instructions });
          break;
        case 'device_code':
          callbacks.onDeviceCode({
            userCode: event.userCode,
            verificationUri: event.verificationUri,
            intervalSeconds: event.intervalSeconds,
            expiresInSeconds: event.expiresInSeconds,
          });
          break;
        case 'info':
        case 'progress':
          callbacks.onProgress?.(event.message);
          break;
      }
    },
  };
}

async function legacyModule(): Promise<LegacyOAuthModule> {
  if (!_legacyModulePromise) {
    _legacyModulePromise = import('@earendil-works/pi-ai/oauth') as Promise<LegacyOAuthModule>;
  }
  return _legacyModulePromise;
}

async function builtinProviders(): Promise<Map<string, OAuthProviderInterface>> {
  if (!_builtinProvidersPromise) {
    _builtinProvidersPromise = (async () => {
      const { builtinProviders: loadBuiltinProviders } = await import('@earendil-works/pi-ai/providers/all');
      const providers = new Map<string, OAuthProviderInterface>();
      for (const provider of loadBuiltinProviders()) {
        const oauth = provider.auth.oauth;
        if (!oauth) continue;
        providers.set(provider.id, {
          id: provider.id,
          name: oauth.name,
          usesCallbackServer: !['github-copilot'].includes(provider.id),
          async login(callbacks) {
            return stripCredentialType(await oauth.login(interactionFromCallbacks(callbacks)));
          },
          async refreshToken(credentials) {
            const refreshed = await oauth.refresh({ ...credentials, type: 'oauth' });
            return stripCredentialType(refreshed);
          },
          getApiKey(credentials) {
            return credentials.access;
          },
        });
      }
      return providers;
    })();
  }
  return _builtinProvidersPromise;
}

export function registerOAuthProvider(provider: OAuthProviderInterface): void {
  customProviders.set(provider.id, provider);
}

export function unregisterOAuthProvider(id: string): void {
  customProviders.delete(id);
}

export async function getOAuthProvider(id: string): Promise<OAuthProviderInterface | undefined> {
  const custom = customProviders.get(id);
  if (custom) return custom;

  // Preserve compatibility with tests or older pi-ai builds that still
  // expose the registry functions from the legacy entry point.
  const legacy = await legacyModule();
  const legacyProvider = legacy.getOAuthProvider?.(id);
  if (legacyProvider) return legacyProvider;

  return (await builtinProviders()).get(id);
}

export async function getOAuthProviders(): Promise<OAuthProviderInterface[]> {
  const merged = new Map<string, OAuthProviderInterface>();
  for (const [id, provider] of await builtinProviders()) merged.set(id, provider);
  const legacy = await legacyModule();
  for (const provider of legacy.getOAuthProviders?.() || []) merged.set(provider.id, provider);
  for (const [id, provider] of customProviders) merged.set(id, provider);
  return [...merged.values()];
}
