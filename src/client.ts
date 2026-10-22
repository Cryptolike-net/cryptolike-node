import { randomUUID } from "node:crypto";
import type { components, operations } from "./schema.js";
import { ApiError, NetworkError, type ApiErrorBody } from "./errors.js";
import { assertServerSide, sign } from "./sign.js";
import { USER_AGENT } from "./version.js";

export type Schemas = components["schemas"];
type JsonOf<T> = T extends { content: { "application/json": infer B } } ? B : never;
/** Response body of an operation's success status. */
export type Result<Op extends keyof operations, Status extends keyof operations[Op]["responses"]> = JsonOf<operations[Op]["responses"][Status]>;
/** Query parameters of an operation. */
export type Query<Op extends keyof operations> = operations[Op]["parameters"] extends { query?: infer Q } ? NonNullable<Q> : never;

export type Invoice = Schemas["Invoice"];
export type InvoiceDetail = Schemas["InvoiceDetail"];
export type InvoiceStatus = Schemas["InvoiceStatus"];
export type CreateInvoiceRequest = Schemas["CreateInvoiceRequest"];
export type InvoiceCoinOptions = Schemas["InvoiceCoinOptions"];
export type CoinOption = Schemas["CheckoutCoinOption"];
export type StaticAddress = Schemas["StaticAddress"];
export type StaticAddressCard = Schemas["StaticAddressCard"];
export type CreateAddressRequest = Schemas["CreateAddressRequest"];
export type Transaction = Schemas["Transaction"];
export type Balance = Schemas["Balance"];
export type Currency = Schemas["Currency"];
export type Rate = Schemas["Rate"];
export type Withdrawal = Schemas["Withdrawal"];
export type WithdrawalStatus = Schemas["WithdrawalStatus"];
export type WithdrawalEstimate = Schemas["WithdrawalEstimate"];
export type CreateWithdrawalRequest = Schemas["CreateWithdrawalRequest"];
export type EstimateWithdrawalRequest = Schemas["EstimateWithdrawalRequest"];
export type WebhookEndpoint = Schemas["WebhookEndpoint"];
export type WebhookEndpointCreated = Schemas["WebhookEndpointCreated"];
export type CreateWebhookEndpointRequest = Schemas["CreateWebhookEndpointRequest"];
export type UpdateWebhookEndpointRequest = Schemas["UpdateWebhookEndpointRequest"];
export type WebhookDelivery = Schemas["WebhookDelivery"];
export type EmbedSettings = Schemas["EmbedSettings"];

/** One page of a cursor-paginated list. Pass `next_cursor` back as `cursor` for the next page. */
export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

export interface ClientOptions {
  /** Key id (`ck_live_…` / `ck_test_…`). Default: `process.env.CRYPTOLIKE_API_KEY_ID`. */
  keyId?: string;
  /**
   * API secret, exactly as shown once in the cabinet. Default: `process.env.CRYPTOLIKE_API_SECRET`.
   * Keep it in your secret manager / environment — never in source code, logs or a browser.
   */
  secret?: string;
  /** Default: `process.env.CRYPTOLIKE_API_URL` or `https://api.cryptolike.net`. */
  baseUrl?: string;
  /** Custom `fetch` (tests, proxies). Default: `globalThis.fetch` (Node ≥ 18). */
  fetch?: typeof fetch;
  /** Per-attempt timeout in milliseconds (default 30 000). */
  timeoutMs?: number;
  /** Retries after the first attempt on 429 / 5xx / transport errors (default 3; 0 disables). */
  maxRetries?: number;
  /** Backoff base in ms (default 500): delay = min(retryMaxMs, base · 2^attempt) with full jitter, or `Retry-After`. */
  retryBaseMs?: number;
  /** Backoff cap in ms (default 8 000). A `Retry-After` longer than `retryAfterMaxMs` stops retrying. */
  retryMaxMs?: number;
  retryAfterMaxMs?: number;
  /** Pins `X-API-Version` (default `v1`). */
  apiVersion?: string;
  /** Appended to the User-Agent, e.g. `my-shop/2.3`. */
  appInfo?: string;
  /** Clock override — Unix seconds, fractions allowed (the timestamp is the whole part). Tests. */
  now?: () => number;
  /** Sleep override — tests. */
  sleep?: (ms: number) => Promise<void>;
  /** `Idempotency-Key` generator for POSTs without an explicit key (default: random UUID). */
  idempotencyKey?: () => string;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  /** `Idempotency-Key` for POST (https://cryptolike.net/docs/auth §7). Auto-generated when omitted. */
  idempotencyKey?: string;
  headers?: Record<string, string>;
  /** Abort the whole call (all attempts). */
  signal?: AbortSignal;
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

const DEFAULT_BASE_URL = "https://api.cryptolike.net";

function buildPathQuery(path: string, query?: RequestOptions["query"]): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/** Milliseconds until the clock crosses into the next whole second (+10 ms of margin). */
function msUntilNextSecond(nowSeconds: number): number {
  return (1 - (nowSeconds % 1)) * 1000 + 10;
}

/** Lower-case names a caller-supplied header may never replace: they are the signature itself. */
const SIGNED_HEADERS = new Set(["x-api-key", "x-timestamp", "x-signature"]);

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function retryable(status: number): boolean {
  return status === 429 || (status >= 500 && status !== 501);
}

/**
 * Server-side client of the CryptoLike merchant API. One instance per API key; safe to share.
 *
 * ```ts
 * const api = new CryptoLike(); // CRYPTOLIKE_API_KEY_ID + CRYPTOLIKE_API_SECRET from the environment
 * const inv = await api.invoices.create({ amount: "10.50", currency: "USD", order_id: "A-1001" });
 * ```
 */
export class CryptoLike {
  private readonly keyId: string;
  readonly #secret: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly retryAfterMaxMs: number;
  private readonly apiVersion: string;
  private readonly userAgent: string;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly newIdempotencyKey: () => string;

  constructor(opts: ClientOptions = {}) {
    assertServerSide();
    const env = (typeof process !== "undefined" ? process.env : {}) as Record<string, string | undefined>;
    const keyId = opts.keyId ?? env.CRYPTOLIKE_API_KEY_ID;
    const secret = opts.secret ?? env.CRYPTOLIKE_API_SECRET;
    if (!keyId) throw new Error("cryptolike: keyId is required (option keyId or env CRYPTOLIKE_API_KEY_ID)");
    if (!secret) throw new Error("cryptolike: secret is required (option secret or env CRYPTOLIKE_API_SECRET)");
    this.keyId = keyId;
    this.#secret = secret;
    this.baseUrl = (opts.baseUrl ?? env.CRYPTOLIKE_API_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const f = opts.fetch ?? globalThis.fetch;
    if (typeof f !== "function") throw new Error("cryptolike: no fetch available — Node ≥ 18 or pass options.fetch");
    this.fetchImpl = f;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.retryBaseMs = opts.retryBaseMs ?? 500;
    this.retryMaxMs = opts.retryMaxMs ?? 8_000;
    this.retryAfterMaxMs = opts.retryAfterMaxMs ?? 30_000;
    this.apiVersion = opts.apiVersion ?? "v1";
    this.userAgent = opts.appInfo ? `${USER_AGENT} ${opts.appInfo}` : USER_AGENT;
    this.now = opts.now ?? (() => Date.now() / 1000);
    this.sleep = opts.sleep ?? defaultSleep;
    this.newIdempotencyKey = opts.idempotencyKey ?? randomUUID;
  }

  /** Redacts the secret from `JSON.stringify(client)`. */
  toJSON(): Record<string, unknown> {
    return { keyId: this.keyId, baseUrl: this.baseUrl, secret: "[redacted]" };
  }

  /**
   * Redacts the secret from `console.log(client)` / `util.inspect(client)`, which ignore `toJSON()`.
   * The secret also lives in a `#private` field, which `util.inspect` never prints.
   */
  [Symbol.for("nodejs.util.inspect.custom")](): Record<string, unknown> {
    return this.toJSON();
  }

  /**
   * Signed request with retries. Prefer the typed resource methods; use this for an endpoint
   * added after this SDK version. `T` is the parsed JSON (or text for CSV).
   */
  async request<T>(method: Method, path: string, o: RequestOptions = {}): Promise<T> {
    const pathQuery = buildPathQuery(path, o.query);
    const body = o.body === undefined ? "" : JSON.stringify(o.body);
    const idem = method === "POST" ? (o.idempotencyKey ?? this.newIdempotencyKey()) : o.idempotencyKey;
    let lastError: unknown;
    let lastTs: number | undefined;
    for (let attempt = 0; ; attempt++) {
      if (o.signal?.aborted) throw new NetworkError("request aborted", o.signal.reason);
      let ts = Math.floor(this.now());
      if (ts === lastTs) {
        // Timestamps are whole seconds, so a retry inside the same second would repeat the
        // signature byte for byte and the server accepts a signature once: a retry after a
        // genuine 5xx would come back as `401 auth.replay`. Wait the second out first.
        await this.sleep(msUntilNextSecond(this.now()));
        ts = Math.floor(this.now());
      }
      lastTs = ts;
      const headers: Record<string, string> = {
        Accept: "application/json, text/csv",
        "User-Agent": this.userAgent,
        "X-API-Version": this.apiVersion,
      };
      // Caller headers first: they may refine Accept, never the signed ones.
      for (const [k, v] of Object.entries(o.headers ?? {})) {
        if (!SIGNED_HEADERS.has(k.toLowerCase())) headers[k] = v;
      }
      headers["X-API-Key"] = this.keyId;
      headers["X-Timestamp"] = String(ts);
      headers["X-Signature"] = sign(this.#secret, ts, method, pathQuery, body);
      if (body !== "") headers["Content-Type"] = "application/json";
      if (idem) headers["Idempotency-Key"] = idem;

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(new Error(`timeout after ${this.timeoutMs} ms`)), this.timeoutMs);
      const onAbort = () => ac.abort(o.signal?.reason);
      o.signal?.addEventListener("abort", onAbort, { once: true });
      let res: Response;
      try {
        res = await this.fetchImpl(this.baseUrl + pathQuery, { method, headers, body: body === "" ? undefined : body, signal: ac.signal, redirect: "manual" });
      } catch (e) {
        clearTimeout(timer);
        o.signal?.removeEventListener("abort", onAbort);
        if (o.signal?.aborted) throw new NetworkError("request aborted", e);
        lastError = e;
        if (attempt >= this.maxRetries) throw new NetworkError(`${method} ${pathQuery}: ${(e as Error)?.message ?? "request failed"}`, e);
        await this.sleep(this.backoff(attempt));
        continue;
      }
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);

      if (res.ok) return parseBody<T>(res);

      const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
      const err = new ApiError(res.status, await parseErrorBody(res), { retryAfter, requestId: res.headers.get("x-request-id") ?? undefined });
      if (err.status === 401 && err.code === "auth.replay" && attempt < this.maxRetries) {
        // Timestamps are whole seconds: an identical request within the same second carries the
        // same signature and the server accepts a signature once. Wait for the next second and
        // sign afresh (POSTs keep their Idempotency-Key, so nothing is created twice).
        lastError = err;
        await this.sleep(msUntilNextSecond(this.now()));
        continue;
      }
      if (!retryable(res.status) || attempt >= this.maxRetries) throw err;
      const delay = retryAfter !== undefined ? retryAfter * 1000 : this.backoff(attempt);
      if (delay > this.retryAfterMaxMs) throw err;
      lastError = err;
      await this.sleep(delay);
    }
    // unreachable — the loop returns or throws; keeps TypeScript's control-flow analysis happy.
    throw lastError;
  }

  private backoff(attempt: number): number {
    const cap = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** attempt);
    return Math.floor(Math.random() * cap);
  }

  /** Iterates every item of a cursor-paginated list, fetching pages as needed. */
  private async *paginate<T>(fetchPage: (cursor: string | undefined) => Promise<Page<T>>): AsyncGenerator<T, void, undefined> {
    let cursor: string | undefined;
    for (;;) {
      const page = await fetchPage(cursor);
      for (const item of page.items) yield item;
      if (!page.next_cursor) return;
      cursor = page.next_cursor;
    }
  }

  // ---- catalogue ----------------------------------------------------------------------------

  readonly currencies = {
    /** Coins this key's merchant can use (`read`). */
    list: (): Promise<Result<"listCurrencies", 200>> => this.request("GET", "/v1/currencies"),
  };

  readonly rates = {
    /** Latest quote of every enabled coin against `fiat` (default: the merchant's default fiat). */
    list: (query?: Query<"listRates">): Promise<Result<"listRates", 200>> => this.request("GET", "/v1/rates", { query }),
  };

  readonly balances = {
    /** Available / pending / on-hold balance per coin. */
    list: (): Promise<Result<"listBalances", 200>> => this.request("GET", "/v1/balances"),
  };

  // ---- invoices -----------------------------------------------------------------------------

  readonly invoices = {
    /**
     * Creates a payment; send the payer to `checkout_url`. `idempotencyKey` defaults to a random UUID.
     * `allowed_coin_ids` (ids from `currencies.list()`, not with `coin_id`) narrows the coins the payer
     * may choose from; omit it to offer every coin you offer for invoices. An empty array is refused
     * here (TypeError) — a filter that found nothing never turns into "every coin".
     */
    create: async (body: CreateInvoiceRequest, idempotencyKey?: string): Promise<Invoice> => {
      if (Array.isArray(body.allowed_coin_ids) && body.allowed_coin_ids.length === 0) {
        throw new TypeError("cryptolike: allowed_coin_ids is empty — omit it to offer every coin you offer for invoices");
      }
      return this.request("POST", "/v1/invoices", { body, idempotencyKey });
    },
    /** The invoice with its status timeline (`events`). */
    get: (id: string): Promise<InvoiceDetail> => this.request("GET", `/v1/invoices/${encodeURIComponent(id)}`),
    /** One page, newest first. */
    list: (query?: Query<"listInvoices">): Promise<Page<Invoice>> => this.request("GET", "/v1/invoices", { query }),
    /** Every invoice matching the filters, page by page. */
    iterate: (query?: Omit<Query<"listInvoices">, "cursor" | "format">): AsyncGenerator<Invoice, void, undefined> =>
      this.paginate((cursor) => this.invoices.list({ ...(query ?? {}), cursor })),
    /** Only status `new` can be cancelled (otherwise `409 conflict`). */
    cancel: (id: string, idempotencyKey?: string): Promise<Invoice> => this.request("POST", `/v1/invoices/${encodeURIComponent(id)}/cancel`, { idempotencyKey }),
    /**
     * Coins the payer may choose for an invoice created without `coin_id` — the list of the payment page,
     * with the informative `≈` amount in each (`estimated_amount`; `null` with `estimate_reason` when it
     * cannot be priced now — the coin can still be chosen). Show it in your own UI and fix the choice with
     * `selectCoin`. `409 conflict` (`details.coin_id`) once the coin is chosen. Permission `read`.
     */
    coinOptions: (id: string): Promise<InvoiceCoinOptions> => this.request("GET", `/v1/invoices/${encodeURIComponent(id)}/coin-options`),
    /**
     * Fixes the coin of an invoice created without `coin_id` — the same choice as the payer's on the payment
     * page: allocates the address, prices a fiat amount now and locks the rate. Answers the invoice with
     * `address`, `payer_amount`, `payment_uri`, `qr_payload` and `required_confirmations`. Only once and only
     * while the invoice is `new` (otherwise `409`, also with the same coin); a coin outside `coinOptions` is
     * `400` (`field === "coin_id"`); `503` (rate or address not available right now) is retried with the same
     * `idempotencyKey`, which defaults to a random UUID. Permission `create_invoice`.
     */
    selectCoin: (id: string, coinId: string, idempotencyKey?: string): Promise<Invoice> =>
      this.request("POST", `/v1/invoices/${encodeURIComponent(id)}/coin`, { body: { coin_id: coinId } satisfies Schemas["SelectInvoiceCoinRequest"], idempotencyKey }),
    /** The whole filtered list as CSV text. */
    exportCsv: (query?: Omit<Query<"listInvoices">, "cursor" | "limit" | "format">): Promise<string> =>
      this.request("GET", "/v1/invoices", { query: { ...(query ?? {}), format: "csv" }, headers: { Accept: "text/csv" } }),
  };

  // ---- static addresses ---------------------------------------------------------------------

  readonly addresses = {
    /** One active address per (coin, customer); a second request is `409`. */
    create: (body: CreateAddressRequest, idempotencyKey?: string): Promise<StaticAddress> => this.request("POST", "/v1/addresses", { body, idempotencyKey }),
    /** The address with one page of its deposit history. */
    get: (id: string, query?: Query<"getAddress">): Promise<StaticAddressCard> => this.request("GET", `/v1/addresses/${encodeURIComponent(id)}`, { query }),
    list: (query?: Query<"listAddresses">): Promise<Page<StaticAddress>> => this.request("GET", "/v1/addresses", { query }),
    iterate: (query?: Omit<Query<"listAddresses">, "cursor">): AsyncGenerator<StaticAddress, void, undefined> =>
      this.paginate((cursor) => this.addresses.list({ ...(query ?? {}), cursor })),
    /**
     * Stops offering the address. Archived addresses are still checked for incoming transfers
     * regularly; a transfer is credited and restores the address automatically
     * (webhook `static_address.restored`). Archiving an archived address is a no-op.
     */
    archive: (id: string, idempotencyKey?: string): Promise<StaticAddress> => this.request("POST", `/v1/addresses/${encodeURIComponent(id)}/archive`, { idempotencyKey }),
    /**
     * Makes an archived address active again (restoring an active one is a no-op). `ApiError`
     * `409 conflict` with `details.active_address_id` when the customer already has another
     * active address for the currency — archive that one first.
     */
    restore: (id: string, idempotencyKey?: string): Promise<StaticAddress> => this.request("POST", `/v1/addresses/${encodeURIComponent(id)}/restore`, { idempotencyKey }),
  };

  // ---- static-address archive (same calls as `addresses.*`, named after the feature) --------

  /**
   * Archives a static address (`POST /v1/addresses/{id}/archive`): it is no longer offered and
   * leaves real-time scanning, but is never deleted or re-issued. The platform checks archived
   * addresses for incoming transfers regularly (every 24 h by default); a transfer found is
   * credited as usual and restores the address automatically (webhook `static_address.restored`,
   * reason `deposit`). Archiving an archived address is a no-op. Webhook `static_address.archived`.
   */
  archiveStaticAddress(id: string, idempotencyKey?: string): Promise<StaticAddress> {
    return this.addresses.archive(id, idempotencyKey);
  }

  /**
   * Restores an archived static address (`POST /v1/addresses/{id}/restore`); restoring an active
   * one is a no-op. Throws `ApiError` `409 conflict` with `details.active_address_id` when the
   * customer already has another active address for the currency — archive that one first.
   */
  restoreStaticAddress(id: string, idempotencyKey?: string): Promise<StaticAddress> {
    return this.addresses.restore(id, idempotencyKey);
  }

  /** One page of archived static addresses (`GET /v1/addresses?status=archived`), newest first; `search`, `coin_id`, `customer_id` filter. */
  listArchivedStaticAddresses(query?: Omit<Query<"listAddresses">, "status">): Promise<Page<StaticAddress>> {
    return this.addresses.list({ ...(query ?? {}), status: "archived" });
  }

  /** Every archived static address matching the filters, page by page. */
  iterateArchivedStaticAddresses(query?: Omit<Query<"listAddresses">, "status" | "cursor">): AsyncGenerator<StaticAddress, void, undefined> {
    return this.paginate((cursor) => this.listArchivedStaticAddresses({ ...(query ?? {}), cursor }));
  }

  // ---- transactions -------------------------------------------------------------------------

  readonly transactions = {
    list: (query?: Query<"listTransactions">): Promise<Page<Transaction>> => this.request("GET", "/v1/transactions", { query }),
    iterate: (query?: Omit<Query<"listTransactions">, "cursor" | "format">): AsyncGenerator<Transaction, void, undefined> =>
      this.paginate((cursor) => this.transactions.list({ ...(query ?? {}), cursor })),
    get: (id: string): Promise<Transaction> => this.request("GET", `/v1/transactions/${encodeURIComponent(id)}`),
    /** The whole filtered list as CSV text (amounts as exact decimal text). */
    exportCsv: (query?: Omit<Query<"listTransactions">, "cursor" | "limit" | "format">): Promise<string> =>
      this.request("GET", "/v1/transactions", { query: { ...(query ?? {}), format: "csv" }, headers: { Accept: "text/csv" } }),
  };

  // ---- withdrawals --------------------------------------------------------------------------

  readonly withdrawals = {
    /** Fees and the total debit for `amount` of a coin — nothing is created. */
    estimate: (body: EstimateWithdrawalRequest): Promise<WithdrawalEstimate> => this.request("POST", "/v1/withdrawals/estimate", { body }),
    /**
     * Moves `total_debit` from `available` to `hold` and queues the payout (`withdraw`; the merchant
     * must be verified). Give `payout_id` (your id) — repeating it with the same parameters returns
     * the existing withdrawal instead of creating a second one.
     */
    create: (body: CreateWithdrawalRequest, idempotencyKey?: string): Promise<Withdrawal> => this.request("POST", "/v1/withdrawals", { body, idempotencyKey }),
    get: (id: string): Promise<Withdrawal> => this.request("GET", `/v1/withdrawals/${encodeURIComponent(id)}`),
    list: (query?: Query<"listWithdrawals">): Promise<Page<Withdrawal>> => this.request("GET", "/v1/withdrawals", { query }),
    iterate: (query?: Omit<Query<"listWithdrawals">, "cursor" | "format">): AsyncGenerator<Withdrawal, void, undefined> =>
      this.paginate((cursor) => this.withdrawals.list({ ...(query ?? {}), cursor })),
    /** Only before processing starts (`pending`, `review`, `awaiting_approval`). */
    cancel: (id: string, idempotencyKey?: string): Promise<Withdrawal> => this.request("POST", `/v1/withdrawals/${encodeURIComponent(id)}/cancel`, { idempotencyKey }),
  };

  // ---- webhooks -----------------------------------------------------------------------------

  readonly webhooks = {
    endpoints: {
      list: (): Promise<Result<"listWebhookEndpoints", 200>> => this.request("GET", "/v1/webhooks/endpoints"),
      /** The response carries the signing `secret` once — store it on your server. */
      create: (body: CreateWebhookEndpointRequest, idempotencyKey?: string): Promise<WebhookEndpointCreated> =>
        this.request("POST", "/v1/webhooks/endpoints", { body, idempotencyKey }),
      get: (id: string): Promise<WebhookEndpoint> => this.request("GET", `/v1/webhooks/endpoints/${encodeURIComponent(id)}`),
      update: (id: string, body: UpdateWebhookEndpointRequest): Promise<WebhookEndpoint> =>
        this.request("PATCH", `/v1/webhooks/endpoints/${encodeURIComponent(id)}`, { body }),
      delete: (id: string): Promise<void> => this.request("DELETE", `/v1/webhooks/endpoints/${encodeURIComponent(id)}`),
      /** New secret, shown once; the old one stops verifying immediately. */
      rotateSecret: (id: string, idempotencyKey?: string): Promise<Result<"rotateWebhookSecret", 200>> =>
        this.request("POST", `/v1/webhooks/endpoints/${encodeURIComponent(id)}/rotate-secret`, { idempotencyKey }),
    },
    deliveries: {
      list: (query?: Query<"listWebhookDeliveries">): Promise<Page<WebhookDelivery>> => this.request("GET", "/v1/webhooks/deliveries", { query }),
      get: (id: string): Promise<WebhookDelivery> => this.request("GET", `/v1/webhooks/deliveries/${encodeURIComponent(id)}`),
      /** Queues the delivery again (also for an already delivered event). */
      retry: (id: string, idempotencyKey?: string): Promise<WebhookDelivery> => this.request("POST", `/v1/webhooks/deliveries/${encodeURIComponent(id)}/retry`, { idempotencyKey }),
    },
  };

  // ---- checkout widget settings (https://cryptolike.net/docs/widget §2) -----------------------------------------

  readonly embed = {
    get: (): Promise<EmbedSettings> => this.request("GET", "/v1/embed"),
    /** Replaces the allowlist as a whole (`[]` switches embedding off). */
    set: (body: EmbedSettings): Promise<EmbedSettings> => this.request("PUT", "/v1/embed", { body }),
  };
}

function parseRetryAfter(v: string | null): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

async function parseErrorBody(res: Response): Promise<ApiErrorBody | undefined> {
  try {
    const text = await res.text();
    if (!text || !(res.headers.get("content-type") ?? "").includes("application/json")) return undefined;
    return JSON.parse(text) as ApiErrorBody;
  } catch {
    return undefined;
  }
}

async function parseBody<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!text) return undefined as T;
  const ct = res.headers.get("content-type") ?? "";
  return (ct.includes("application/json") ? JSON.parse(text) : text) as T;
}
