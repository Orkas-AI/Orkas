/**
 * Auth credential store — persists OAuth and API key credentials to disk.
 *
 * Credentials are stored in a JSON file at `~/.core-agent/auth-profiles.json`.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { OAuthCredentials } from "@mariozechner/pi-ai";
import { createLogger } from "../shared/logger.js";
import type { AuthCredential, AuthStore, OAuthCredential } from "./types.js";

const log = createLogger("auth-store");

const AUTH_STORE_VERSION = 1;

/**
 * Resolve the directory for storing auth data.
 *
 * Precedence:
 *   1. `CORE_AGENT_AUTH_DIR` env var (absolute path) — lets embedders pin
 *      the store to their own workspace (e.g. Orkas points this at
 *      `<workspace>/auth` so credentials live with the app data, not the
 *      user's home).
 *   2. `~/.core-agent` — standalone default.
 */
export function resolveAuthDir(): string {
  const override = process.env.CORE_AGENT_AUTH_DIR;
  if (override && override.trim()) {
    return path.resolve(override.trim());
  }
  return path.join(os.homedir(), ".core-agent");
}

/** Resolve the path to the auth store file. */
export function resolveAuthStorePath(): string {
  return path.join(resolveAuthDir(), "auth-profiles.json");
}

/** Ensure the auth directory exists. */
function ensureAuthDir(): void {
  const dir = resolveAuthDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Load the auth store from disk. Returns empty store if not found. */
export function loadAuthStore(): AuthStore {
  const storePath = resolveAuthStorePath();
  try {
    const raw = fs.readFileSync(storePath, "utf-8");
    const data = JSON.parse(raw) as Record<string, unknown>;

    if (data.profiles && typeof data.profiles === "object") {
      return {
        version: Number(data.version ?? AUTH_STORE_VERSION),
        profiles: data.profiles as Record<string, AuthCredential>,
      };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn("failed to load auth store", { error: (err as Error).message });
    }
  }

  return { version: AUTH_STORE_VERSION, profiles: {} };
}

/** Save the auth store to disk. */
export function saveAuthStore(store: AuthStore): void {
  ensureAuthDir();
  const storePath = resolveAuthStorePath();
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2), "utf-8");
  log.debug("saved auth store", { path: storePath });
}

/** Write OAuth credentials for a provider, returning the profile ID. */
export function writeOAuthCredentials(
  provider: string,
  credentials: OAuthCredentials,
): string {
  const store = loadAuthStore();
  const profileId = `${provider}:default`;

  store.profiles[profileId] = {
    type: "oauth",
    provider,
    ...credentials,
  } as OAuthCredential;

  saveAuthStore(store);
  log.info("saved OAuth credentials", { provider, profileId });
  return profileId;
}

/** Write an API key for a provider, returning the profile ID. */
export function writeApiKeyCredential(
  provider: string,
  apiKey: string,
): string {
  const store = loadAuthStore();
  const profileId = `${provider}:default`;

  store.profiles[profileId] = {
    type: "api_key",
    provider,
    key: apiKey,
  };

  saveAuthStore(store);
  log.info("saved API key credential", { provider, profileId });
  return profileId;
}

/** Remove a credential profile. */
export function removeCredential(profileId: string): boolean {
  const store = loadAuthStore();
  if (store.profiles[profileId]) {
    delete store.profiles[profileId];
    saveAuthStore(store);
    return true;
  }
  return false;
}

/** Resolve an API key for a given provider from the store. */
export function resolveApiKeyFromStore(provider: string): string | undefined {
  const store = loadAuthStore();
  const profileId = `${provider}:default`;
  const cred = store.profiles[profileId];

  if (!cred) return undefined;

  if (cred.type === "api_key") {
    return cred.key;
  }

  if (cred.type === "oauth") {
    // Check if token is still valid
    if (Date.now() < cred.expires) {
      return cred.access;
    }
    // Token expired — caller should call refreshOAuthCredential()
    return undefined;
  }

  return undefined;
}

/** Check if a stored OAuth credential needs refresh. */
export function isOAuthExpired(provider: string): boolean {
  const store = loadAuthStore();
  const profileId = `${provider}:default`;
  const cred = store.profiles[profileId];

  if (!cred || cred.type !== "oauth") return false;
  return Date.now() >= cred.expires;
}

/** Get the stored OAuth credential for a provider. */
export function getOAuthCredential(provider: string): OAuthCredential | undefined {
  const store = loadAuthStore();
  const profileId = `${provider}:default`;
  const cred = store.profiles[profileId];
  if (cred?.type === "oauth") return cred;
  return undefined;
}

/** List all stored credential profiles. */
export function listCredentials(): Array<{
  profileId: string;
  provider: string;
  type: "api_key" | "oauth";
  expired?: boolean;
}> {
  const store = loadAuthStore();
  return Object.entries(store.profiles).map(([id, cred]) => ({
    profileId: id,
    provider: cred.provider,
    type: cred.type,
    ...(cred.type === "oauth" ? { expired: Date.now() >= cred.expires } : {}),
  }));
}
