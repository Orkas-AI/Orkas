/**
 * OAuth login flows for supported providers.
 *
 * Uses @earendil-works/pi-ai's built-in OAuth support (loginOpenAICodex, etc.)
 * with a CLI-friendly interactive flow: opens browser, waits for callback.
 */
import { createInterface } from "node:readline";
import { createLogger } from "../shared/logger.js";
import { writeOAuthCredentials, getOAuthCredential } from "./store.js";
import type { OAuthCredentials, OAuthProviderInterface } from "@earendil-works/pi-ai";

const log = createLogger("oauth-flow");

/** Prompt the user for text input via stdin/stdout. */
async function promptText(message: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${message}: `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** Try to open a URL in the user's browser. */
async function openBrowser(url: string): Promise<void> {
  try {
    const { exec } = await import("node:child_process");
    const cmd =
      process.platform === "darwin"
        ? `open "${url}"`
        : process.platform === "win32"
          ? `start "${url}"`
          : `xdg-open "${url}"`;
    exec(cmd);
  } catch {
    // Ignore — user can manually open the URL
  }
}

/**
 * Run an interactive OAuth login for the given pi-ai OAuth provider.
 *
 * Opens the browser for the user to authenticate, then captures the callback
 * and stores the credentials.
 */
export async function loginOAuthProvider(provider: OAuthProviderInterface): Promise<{
  profileId: string;
  credentials: OAuthCredentials;
}> {
  console.log(`\nStarting ${provider.name} OAuth login...`);
  console.log("A browser window will open for authentication.");
  console.log("If it doesn't open automatically, copy and paste the URL shown below.\n");

  const credentials = await provider.login({
    onAuth: async (info) => {
      console.log(`\nOpen this URL in your browser:\n\n  ${info.url}\n`);
      if (info.instructions) {
        console.log(info.instructions);
      }
      await openBrowser(info.url);
    },
    onDeviceCode: (info) => {
      console.log(`\nOpen this URL in your browser:\n\n  ${info.verificationUri}\n`);
      console.log(`Enter code: ${info.userCode}\n`);
      if (info.expiresInSeconds) {
        console.log(`The code expires in ${info.expiresInSeconds} seconds.\n`);
      }
      void openBrowser(info.verificationUri);
    },
    onPrompt: async (prompt) => {
      return await promptText(prompt.message);
    },
    onSelect: async (prompt) => {
      console.log(`\n${prompt.message}`);
      prompt.options.forEach((option, index) => {
        console.log(`  ${index + 1}. ${option.label}`);
      });
      const answer = await promptText(`Enter number (1-${prompt.options.length})`);
      const index = Number.parseInt(answer, 10) - 1;
      return prompt.options[index]?.id;
    },
    onProgress: (message) => {
      log.debug(message);
    },
  });

  const profileId = writeOAuthCredentials(provider.id, credentials);
  console.log(`\nOAuth login successful! Credentials saved as "${profileId}".`);

  return { profileId, credentials };
}

/**
 * Refresh an expired OAuth credential for a provider using pi-ai's provider interface.
 *
 * Returns the new access token (API key), or undefined if refresh failed.
 */
export async function refreshOAuthCredential(
  provider: OAuthProviderInterface,
): Promise<string | undefined> {
  const stored = getOAuthCredential(provider.id);
  if (!stored) {
    log.warn("no stored OAuth credential to refresh", { provider: provider.id });
    return undefined;
  }

  try {
    log.debug("refreshing OAuth token", { provider: provider.id });
    const newCreds = await provider.refreshToken(stored);
    writeOAuthCredentials(provider.id, newCreds);
    log.info("OAuth token refreshed", { provider: provider.id });
    return provider.getApiKey(newCreds);
  } catch (err) {
    log.warn("OAuth token refresh failed", {
      provider: provider.id,
      error: (err as Error).message,
    });
    return undefined;
  }
}

/**
 * Resolve an API key for a provider from stored OAuth credentials.
 *
 * Automatically refreshes expired tokens if possible.
 * Returns the access token as API key, or undefined if not available.
 */
export async function resolveOAuthApiKey(
  provider: OAuthProviderInterface,
): Promise<string | undefined> {
  const stored = getOAuthCredential(provider.id);
  if (!stored) return undefined;

  // Token still valid
  if (Date.now() < stored.expires) {
    return provider.getApiKey(stored);
  }

  // Try to refresh
  return await refreshOAuthCredential(provider);
}
