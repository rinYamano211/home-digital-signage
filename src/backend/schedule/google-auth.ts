import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/** Service Account JWT Bearer (technology-stack 18.7). No Google library. */
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const CALENDAR_SCOPE =
  "https://www.googleapis.com/auth/calendar.events.readonly";
const ASSERTION_LIFETIME_S = 3600;
/** Refresh this long before the token expires. */
export const TOKEN_REFRESH_MARGIN_MS = 60_000;

export interface ServiceAccount {
  readonly clientEmail: string;
  readonly privateKey: KeyObject;
}

/** Validates the Service Account JSON once at startup. Returns null (never
 * the reason text or any field) when it is unusable.
 */
export function serviceAccount(
  secret: Record<string, unknown>,
): ServiceAccount | null {
  const email = secret.client_email;
  const pem = secret.private_key;
  if (secret.type !== "service_account") return null;
  if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+$/.test(email))
    return null;
  if (typeof pem !== "string") return null;
  try {
    const privateKey = createPrivateKey({ key: pem, format: "pem" });
    if (privateKey.asymmetricKeyType !== "rsa") return null;
    return Object.freeze({ clientEmail: email, privateKey });
  } catch {
    return null;
  }
}

const base64url = (value: Buffer | string) =>
  Buffer.from(value).toString("base64url");

/** RS256-signed assertion for the Token Endpoint. */
export function assertion(account: ServiceAccount, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: account.clientEmail,
      scope: CALENDAR_SCOPE,
      aud: TOKEN_URL,
      iat,
      exp: iat + ASSERTION_LIFETIME_S,
    }),
  );
  const input = `${header}.${claims}`;
  const signature = sign("RSA-SHA256", Buffer.from(input), account.privateKey);
  return `${input}.${base64url(signature)}`;
}

export function tokenRequestBody(jwt: string): string {
  return new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: jwt,
  }).toString();
}

const TokenResponse = Type.Object({
  access_token: Type.String({ minLength: 1 }),
  expires_in: Type.Integer({ minimum: 1, maximum: 86_400 }),
});

/** Parsed Token Endpoint response, or null. */
export function parseTokenResponse(
  body: Uint8Array,
): { accessToken: string; expiresInMs: number } | null {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return null;
  }
  if (!Value.Check(TokenResponse, value)) return null;
  return {
    accessToken: value.access_token,
    expiresInMs: value.expires_in * 1000,
  };
}

/** In-memory access token. Single owner: the Schedule Provider, whose
 * attempts never overlap (Scheduler inFlight + Control beginAttempt).
 */
export class TokenCache {
  private token?: { value: string; refreshAtMs: number };
  get(nowMs: number): string | null {
    return this.token && nowMs < this.token.refreshAtMs
      ? this.token.value
      : null;
  }
  set(value: string, obtainedAtMs: number, expiresInMs: number): void {
    this.token = {
      value,
      refreshAtMs: obtainedAtMs + expiresInMs - TOKEN_REFRESH_MARGIN_MS,
    };
  }
  clear(): void {
    this.token = undefined;
  }
}
