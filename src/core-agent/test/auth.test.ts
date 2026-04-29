import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  loadAuthStore,
  saveAuthStore,
  writeOAuthCredentials,
  writeApiKeyCredential,
  removeCredential,
  resolveApiKeyFromStore,
  isOAuthExpired,
  getOAuthCredential,
  listCredentials,
  resolveAuthDir,
  resolveAuthStorePath,
} from "../src/auth/store.js";

describe("Auth Store", () => {
  // Use the real auth dir but save/restore original state
  let originalStore: string | undefined;
  const storePath = resolveAuthStorePath();

  beforeEach(() => {
    try {
      originalStore = fs.readFileSync(storePath, "utf-8");
    } catch {
      originalStore = undefined;
    }
    // Start with clean state
    try { fs.unlinkSync(storePath); } catch { /* ignore */ }
  });

  afterEach(() => {
    // Restore original state
    if (originalStore !== undefined) {
      fs.writeFileSync(storePath, originalStore, "utf-8");
    } else {
      try { fs.unlinkSync(storePath); } catch { /* ignore */ }
    }
  });

  it("returns empty store when no file exists", () => {
    const store = loadAuthStore();
    expect(store.version).toBe(1);
    expect(Object.keys(store.profiles)).toHaveLength(0);
  });

  it("resolves auth dir under home directory", () => {
    expect(resolveAuthDir()).toBe(path.join(os.homedir(), ".core-agent"));
  });

  it("saves and loads auth store", () => {
    const store = {
      version: 1,
      profiles: {
        "openai:default": {
          type: "api_key" as const,
          provider: "openai",
          key: "sk-test-key",
        },
      },
    };
    saveAuthStore(store);

    const loaded = loadAuthStore();
    expect(loaded.version).toBe(1);
    expect(loaded.profiles["openai:default"]).toEqual(store.profiles["openai:default"]);
  });

  it("writes and resolves API key credential", () => {
    const profileId = writeApiKeyCredential("openai", "sk-test-123");
    expect(profileId).toBe("openai:default");

    const key = resolveApiKeyFromStore("openai");
    expect(key).toBe("sk-test-123");
  });

  it("writes OAuth credentials", () => {
    const creds = {
      access: "access-token-abc",
      refresh: "refresh-token-xyz",
      expires: Date.now() + 3600_000,
    };

    const profileId = writeOAuthCredentials("openai-codex", creds);
    expect(profileId).toBe("openai-codex:default");

    const stored = getOAuthCredential("openai-codex");
    expect(stored).toBeDefined();
    expect(stored!.access).toBe("access-token-abc");
    expect(stored!.refresh).toBe("refresh-token-xyz");
    expect(stored!.provider).toBe("openai-codex");
  });

  it("resolves API key from valid OAuth credential", () => {
    const creds = {
      access: "access-token-valid",
      refresh: "refresh-token",
      expires: Date.now() + 3600_000,
    };
    writeOAuthCredentials("openai-codex", creds);

    const key = resolveApiKeyFromStore("openai-codex");
    expect(key).toBe("access-token-valid");
  });

  it("returns undefined for expired OAuth credential", () => {
    const creds = {
      access: "expired-token",
      refresh: "refresh-token",
      expires: Date.now() - 1000, // expired
    };
    writeOAuthCredentials("openai-codex", creds);

    const key = resolveApiKeyFromStore("openai-codex");
    expect(key).toBeUndefined();
  });

  it("detects expired OAuth credentials", () => {
    const creds = {
      access: "token",
      refresh: "refresh",
      expires: Date.now() - 1000,
    };
    writeOAuthCredentials("openai-codex", creds);

    expect(isOAuthExpired("openai-codex")).toBe(true);
  });

  it("detects valid OAuth credentials as not expired", () => {
    const creds = {
      access: "token",
      refresh: "refresh",
      expires: Date.now() + 3600_000,
    };
    writeOAuthCredentials("openai-codex", creds);

    expect(isOAuthExpired("openai-codex")).toBe(false);
  });

  it("removes credentials", () => {
    writeApiKeyCredential("openai", "sk-test");
    expect(resolveApiKeyFromStore("openai")).toBe("sk-test");

    const removed = removeCredential("openai:default");
    expect(removed).toBe(true);
    expect(resolveApiKeyFromStore("openai")).toBeUndefined();
  });

  it("returns false when removing non-existent credential", () => {
    const removed = removeCredential("nonexistent:default");
    expect(removed).toBe(false);
  });

  it("lists all stored credentials", () => {
    writeApiKeyCredential("openai", "sk-key");
    writeOAuthCredentials("openai-codex", {
      access: "token",
      refresh: "refresh",
      expires: Date.now() + 3600_000,
    });

    const creds = listCredentials();
    expect(creds).toHaveLength(2);
    expect(creds.find((c) => c.provider === "openai")?.type).toBe("api_key");
    expect(creds.find((c) => c.provider === "openai-codex")?.type).toBe("oauth");
    expect(creds.find((c) => c.provider === "openai-codex")?.expired).toBe(false);
  });

  it("returns undefined for non-existent provider", () => {
    expect(resolveApiKeyFromStore("nonexistent")).toBeUndefined();
    expect(getOAuthCredential("nonexistent")).toBeUndefined();
    expect(isOAuthExpired("nonexistent")).toBe(false);
  });
});
