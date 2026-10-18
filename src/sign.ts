import { createHash, createHmac } from "node:crypto";
import { BrowserSecretError } from "./errors.js";

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** `true` when a `window` + `document` global exist — a page, not a server. */
export function isBrowser(): boolean {
  const g = globalThis as { window?: unknown; document?: unknown };
  return typeof g.window !== "undefined" && typeof g.document !== "undefined";
}

/** Throws `BrowserSecretError` in a browser. Called by the client before it touches the secret. */
export function assertServerSide(): void {
  if (isBrowser()) throw new BrowserSecretError();
}

/** Lower-case hex SHA-256 of the raw body bytes; the well-known constant for an empty body. */
export function bodySha256(body: string | Uint8Array): string {
  if (body.length === 0) return EMPTY_SHA256;
  return createHash("sha256").update(body).digest("hex");
}

/**
 * Canonical string of https://cryptolike.net/docs/auth §3: four lines joined with `\n`, no trailing newline.
 * `pathQuery` is the request target exactly as sent (`/v1/invoices?limit=10`).
 */
export function canonicalString(timestamp: number | string, method: string, pathQuery: string, body: string | Uint8Array): string {
  return `${timestamp}\n${method.toUpperCase()}\n${pathQuery}\n${bodySha256(body)}`;
}

/**
 * `X-Signature` for a merchant API request: hex HMAC-SHA256 of the canonical string, keyed with
 * the secret **as shown in the cabinet** (not decoded). Checked against the reference vectors (https://cryptolike.net/docs/sdk/vectors.json).
 */
export function sign(secret: string, timestamp: number | string, method: string, pathQuery: string, body: string | Uint8Array = ""): string {
  return createHmac("sha256", secret).update(canonicalString(timestamp, method, pathQuery, body)).digest("hex");
}
