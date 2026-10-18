/** Error envelope of every non-2xx response (https://cryptolike.net/docs/auth §5, https://cryptolike.net/docs/api §5). */
export interface ApiErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

/**
 * `403` code of a payout (create, cancel) with a key whose `withdraw` permission a developer
 * requested and an owner/admin has not approved yet: nothing was created or held, the
 * Idempotency-Key is still free. Not retried — retry once the request is approved in the cabinet.
 */
export const WITHDRAW_PENDING_APPROVAL = "withdraw_pending_approval";

/**
 * Thrown for every non-2xx response the client could not recover from by retrying.
 * Branch on `code` (stable machine code); `message` is for humans and may change.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;
  /** `Retry-After` in seconds, when the server sent one (429, 503). */
  readonly retryAfter: number | undefined;
  /** `X-Request-Id` of the failed response — quote it to support. */
  readonly requestId: string | undefined;
  constructor(status: number, body: ApiErrorBody | undefined, opts: { retryAfter?: number; requestId?: string } = {}) {
    super(body?.error?.message ?? `HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.code = body?.error?.code ?? "http_error";
    this.details = body?.error?.details;
    this.retryAfter = opts.retryAfter;
    this.requestId = opts.requestId;
  }
  /** The payout was refused because the key's `withdraw` waits for an owner/admin's approval. */
  get withdrawPendingApproval(): boolean {
    return this.code === WITHDRAW_PENDING_APPROVAL;
  }
  /** `details.field` of a `validation_error`, when present. */
  get field(): string | undefined {
    const f = this.details?.field;
    return typeof f === "string" ? f : undefined;
  }
}

/** Thrown when the request could not be completed at the transport level (DNS, TLS, timeout) after all retries. */
export class NetworkError extends Error {
  readonly cause: unknown;
  constructor(message: string, cause: unknown) {
    super(message);
    this.name = "NetworkError";
    this.cause = cause;
  }
}

/**
 * Thrown when the SDK is loaded in a browser. The API secret signs as you: whoever can read a
 * page's JavaScript could create payments, read balances and change your webhooks. Sign on your
 * server; the browser only ever needs an invoice id (https://cryptolike.net/docs/widget §1).
 */
export class BrowserSecretError extends Error {
  constructor() {
    super(
      "cryptolike: the API secret must never be shipped to a browser — it would be visible to every visitor " +
        "and would let anyone act as your account. Use the SDK on your server (Node.js) and send the browser only the " +
        "invoice id / checkout_url (see https://cryptolike.net/docs/widget §1).",
    );
    this.name = "BrowserSecretError";
  }
}

/** Thrown by `verifyWebhook` when the delivery must be rejected; `reason` says why (never log the secret). */
export class WebhookVerificationError extends Error {
  readonly reason: WebhookRejectReason;
  constructor(reason: WebhookRejectReason, message: string) {
    super(message);
    this.name = "WebhookVerificationError";
    this.reason = reason;
  }
}

export type WebhookRejectReason = "missing_header" | "invalid_timestamp" | "timestamp_out_of_tolerance" | "invalid_signature" | "invalid_body";
