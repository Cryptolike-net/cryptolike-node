import { createHmac, timingSafeEqual } from "node:crypto";
import { WebhookVerificationError } from "./errors.js";
import type { components } from "./schema.js";

/** Headers as Node's `IncomingHttpHeaders`, a `Headers` instance, or a plain object. */
export type WebhookHeaders = Record<string, string | string[] | undefined> | { get(name: string): string | null | undefined };

export interface VerifyWebhookOptions {
  /**
   * Maximum |now − X-Timestamp| in seconds (default 300). A captured delivery replayed later is
   * rejected. `null` disables the check — only for offline tests.
   */
  tolerance?: number | null;
  /** Clock override (Unix seconds) for tests. */
  now?: () => number;
}

/** A verified webhook event (https://cryptolike.net/docs/webhooks §2). `data` is the full state of the object at `created_at`. */
export interface WebhookEvent<T = Record<string, unknown>> {
  event_id: string;
  type: string;
  created_at: string;
  data: T;
}

/** Every event type an endpoint can subscribe to (https://cryptolike.net/docs/webhooks §5). */
export type WebhookEventType = components["schemas"]["WebhookEventType"];

/** `data` of `static_address.archived` — `reason` `manual` (you) or `auto` (no incoming transfers for the auto-archive period). */
export type StaticAddressArchivedData = components["schemas"]["StaticAddressArchivedData"];
/** `data` of `static_address.restored` — `reason` `manual` or `deposit` (with `deposit`); `conflict_with` when the customer has another active address. */
export type StaticAddressRestoredData = components["schemas"]["StaticAddressRestoredData"];
/** `data` of `static_address.archive_warning` — archived automatically after `archive_after` unless a transfer arrives. */
export type StaticAddressArchiveWarningData = components["schemas"]["StaticAddressArchiveWarningData"];
/** The address inside `static_address.*` / `deposit.*` webhooks (`coin` is the ticker). */
export type WebhookStaticAddress = components["schemas"]["WebhookStaticAddress"];

/** The static-address archive event types. */
export const StaticAddressEvent = {
  Archived: "static_address.archived",
  Restored: "static_address.restored",
  ArchiveWarning: "static_address.archive_warning",
} as const;

/** `data` type per event type, for the events the SDK types. */
export interface WebhookEventDataMap {
  "static_address.archived": StaticAddressArchivedData;
  "static_address.restored": StaticAddressRestoredData;
  "static_address.archive_warning": StaticAddressArchiveWarningData;
}

/**
 * Narrows a verified event to a typed one:
 *
 * ```ts
 * const event = verifyWebhook(req.headers, req.body, secret);
 * if (isWebhookEvent(event, StaticAddressEvent.Restored) && event.data.reason === "deposit") { … event.data.deposit?.txid … }
 * ```
 */
export function isWebhookEvent<K extends keyof WebhookEventDataMap>(event: WebhookEvent<unknown>, type: K): event is WebhookEvent<WebhookEventDataMap[K]> & { type: K } {
  return event.type === type;
}

function header(headers: WebhookHeaders, name: string): string | undefined {
  if (typeof (headers as { get?: unknown }).get === "function") {
    const v = (headers as { get(n: string): string | null | undefined }).get(name);
    return v ?? undefined;
  }
  const rec = headers as Record<string, string | string[] | undefined>;
  const v = rec[name] ?? rec[name.toLowerCase()] ?? rec[name.toUpperCase()];
  return Array.isArray(v) ? v[0] : v;
}

/** `X-Signature` value the platform computes for (`secret`, `timestamp`, `rawBody`) — https://cryptolike.net/docs/webhooks §3. */
export function webhookSignature(secret: string, timestamp: number | string, rawBody: string | Uint8Array): string {
  return "sha256=" + createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest("hex");
}

/**
 * Verifies a webhook delivery and returns the parsed event. Throws `WebhookVerificationError` when
 * the delivery must be rejected (answer 400/401 and do nothing else).
 *
 * `rawBody` must be the bytes exactly as received — never a re-serialised JSON object. With
 * Express: `app.post("/hook", express.raw({ type: "application/json" }), …)`.
 */
export function verifyWebhook<T = Record<string, unknown>>(headers: WebhookHeaders, rawBody: string | Uint8Array, secret: string, opts: VerifyWebhookOptions = {}): WebhookEvent<T> {
  if (typeof secret !== "string" || secret.length === 0) throw new WebhookVerificationError("invalid_signature", "webhook secret is empty");
  const ts = header(headers, "X-Timestamp");
  const sig = header(headers, "X-Signature");
  if (!ts) throw new WebhookVerificationError("missing_header", "X-Timestamp header is missing");
  if (!sig) throw new WebhookVerificationError("missing_header", "X-Signature header is missing");
  if (!/^[0-9]+$/.test(ts)) throw new WebhookVerificationError("invalid_timestamp", "X-Timestamp is not Unix seconds");

  const tolerance = opts.tolerance === undefined ? 300 : opts.tolerance;
  if (tolerance !== null) {
    const now = (opts.now ?? (() => Math.floor(Date.now() / 1000)))();
    if (Math.abs(now - Number(ts)) > tolerance) throw new WebhookVerificationError("timestamp_out_of_tolerance", `X-Timestamp is outside the ${tolerance} s tolerance`);
  }

  // Exact bytes: "sha256=" prefix and lower-case hex, as the platform sends them.
  const expected = Buffer.from(webhookSignature(secret, ts, rawBody));
  const got = Buffer.from(sig);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) throw new WebhookVerificationError("invalid_signature", "X-Signature does not match");

  let event: WebhookEvent<T>;
  try {
    event = JSON.parse(typeof rawBody === "string" ? rawBody : Buffer.from(rawBody).toString("utf8")) as WebhookEvent<T>;
  } catch {
    throw new WebhookVerificationError("invalid_body", "body is not JSON");
  }
  if (!event || typeof event !== "object" || typeof event.event_id !== "string" || typeof event.type !== "string") {
    throw new WebhookVerificationError("invalid_body", "body is not a webhook event");
  }
  return event;
}
