import type { OAuthCredentials } from "@earendil-works/pi-ai";

/** API key credential. */
export type ApiKeyCredential = {
  type: "api_key";
  provider: string;
  key: string;
  email?: string;
};

/** OAuth credential — stores access/refresh tokens with expiry. */
export type OAuthCredential = OAuthCredentials & {
  type: "oauth";
  provider: string;
  clientId?: string;
  email?: string;
};

/** A stored credential — either API key or OAuth. */
export type AuthCredential = ApiKeyCredential | OAuthCredential;

/** Persistent auth credential store. */
export type AuthStore = {
  version: number;
  profiles: Record<string, AuthCredential>;
};
