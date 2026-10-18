# cryptolike

Official **server-side** SDK for the CryptoLike merchant API (Node.js ≥ 18, TypeScript types included).

- Signed requests (`X-API-Key` / `X-Timestamp` / `X-Signature`, HMAC-SHA256 — [Authentication](https://cryptolike.net/docs/auth))
- `Idempotency-Key` generated for every `POST` (pass your own to make retries exact)
- Retries with exponential backoff and jitter on `429` (honours `Retry-After`), `5xx` and transport errors
- Typed resources generated from the [API reference](https://cryptolike.net/docs/api)
- `verifyWebhook()` — signature and timestamp check of webhook deliveries ([Webhooks](https://cryptolike.net/docs/webhooks))
- No runtime dependencies

## The secret stays on your server

> **Never load this SDK in a browser or a mobile app.** The API secret signs requests *as you*:
> whoever can read your page's JavaScript could create payments, read balances and change your
> webhooks. The constructor throws `BrowserSecretError` when it detects a browser. Your page needs
> only the invoice id / `checkout_url` that your server obtained — see [Payment widget §1](https://cryptolike.net/docs/widget).

Keep the key id and secret in your environment or secret manager; the SDK reads
`CRYPTOLIKE_API_KEY_ID` and `CRYPTOLIKE_API_SECRET` when you do not pass them and never logs them.
The secret lives in a `#private` field, so it is redacted from `console.log(client)` /
`util.inspect(client)` (which ignore `toJSON()`) as well as from `JSON.stringify(client)`.

## Install

```bash
npm install cryptolike
```

## Quickstart — to the first confirmed payment

```ts
import { CryptoLike, ApiError } from "cryptolike";

const api = new CryptoLike(); // CRYPTOLIKE_API_KEY_ID + CRYPTOLIKE_API_SECRET from the environment

// 1. Create a payment on your server; send the customer to checkout_url.
const invoice = await api.invoices.create(
  { amount: "10.50", currency: "USD", order_id: "A-1001", return_url: "https://shop.example/orders/A-1001" },
  "order-A-1001", // Idempotency-Key — a retry never creates a second payment
);
redirect(invoice.checkout_url);

// 2. Learn the outcome from the webhook (below) — or poll:
const detail = await api.invoices.get(invoice.id);
if (detail.status === "paid") fulfil(detail.order_id);
```

```ts
// 3. Webhook receiver (Express) — verify over the RAW body, dedupe by event_id, answer 2xx fast.
import express from "express";
import { verifyWebhook, WebhookVerificationError } from "cryptolike";

app.post("/hooks/cryptolike", express.raw({ type: "application/json" }), (req, res) => {
  try {
    const event = verifyWebhook(req.headers, req.body, process.env.CRYPTOLIKE_WEBHOOK_SECRET!);
    if (!alreadySeen(event.event_id)) handle(event); // event.type === "invoice.paid" → fulfil
    res.sendStatus(200);
  } catch (e) {
    if (e instanceof WebhookVerificationError) return res.sendStatus(401);
    throw e;
  }
});
```

Full examples: [`examples/create-payment.ts`](examples/create-payment.ts), [`examples/express-webhook.ts`](examples/express-webhook.ts).

## Resources

| Resource | Methods |
|---|---|
| `api.invoices` | `create(body, idempotencyKey?)`, `get(id)`, `list(query)`, `iterate(query)`, `cancel(id)`, `exportCsv(query)` |
| `api.addresses` | `create`, `get(id, {limit, cursor})`, `list`, `iterate`, `archive(id)`, `restore(id)` |
| `api` (archive) | `archiveStaticAddress(id)`, `restoreStaticAddress(id)`, `listArchivedStaticAddresses(q)`, `iterateArchivedStaticAddresses(q)` |
| `api.transactions` | `list`, `iterate`, `get`, `exportCsv` |
| `api.balances` / `api.currencies` / `api.rates` | `list()` |
| `api.withdrawals` | `estimate(body)`, `create(body)`, `get`, `list`, `iterate`, `cancel` |
| `api.webhooks.endpoints` | `list`, `create`, `get`, `update`, `delete`, `rotateSecret` |
| `api.webhooks.deliveries` | `list`, `get`, `retry` |
| `api.embed` | `get()`, `set({ allowed_origins })` — checkout widget allowlist |
| `api.request(method, path, opts)` | any endpoint, signed |

### Static-address archive

Archiving stops offering an address and takes it out of real-time scanning; it is never deleted, and its address is never issued again. The platform checks archived addresses for incoming transfers regularly (every 24 h by default): a transfer found is credited as usual and restores the address automatically (webhook `static_address.restored`, reason `deposit`). Addresses with no incoming transfers for the platform's period (180 days by default) are archived automatically after a warning 7 days earlier (`static_address.archive_warning`, then `static_address.archived` with reason `auto`).

```ts
await api.archiveStaticAddress(id);                 // POST /v1/addresses/{id}/archive — a repeat is a no-op
const page = await api.listArchivedStaticAddresses({ search: "shop" }); // status=archived; coin_id, customer_id, limit, cursor
for await (const a of api.iterateArchivedStaticAddresses()) console.log(a.id, a.archive_reason);
await api.restoreStaticAddress(id);                 // 409 conflict + details.active_address_id: the customer has another active address — archive that one first
```

The archive events come typed: `isWebhookEvent(event, StaticAddressEvent.Restored)` narrows `event.data` to `StaticAddressRestoredData` (`reason`, `deposit`, `conflict_with`, `address`); likewise `StaticAddressEvent.Archived` / `ArchiveWarning`. Full example: `examples/static-address-archive.ts`, `examples/express-webhook.ts`.

Amounts are decimal **strings** (`"10.50"`), never floats. Lists return `{ items, next_cursor }`;
`iterate()` walks every page for you.

## Payer chooses the coin

An invoice in a fiat currency (or a ticker on several networks) without `coin_id` lets the payer
choose the coin on the payment page; each option shows an estimate (≈) — the exact amount and
rate are fixed when the payer picks. `allowed_coin_ids` narrows the choice for one invoice; omit
it to offer every coin you offer for invoices:

```ts
const { currencies } = await api.currencies.list(); // signed: each coin carries invoice_enabled
const ids = currencies.filter((c) => c.invoice_enabled !== false && !c.maintenance && c.ticker === "USDT").map((c) => c.id);
const inv = await api.invoices.create({ amount: "49.90", currency: "USD", allowed_coin_ids: ids });
// inv.allowed_coin_ids — the kept set; null = every coin offered for invoices.
```

The server keeps the ids you offer for invoices («Available for invoices» in the cabinet → Coins)
that match `currency`, drops the rest; none left → `ApiError` 422 `no_allowed_coins`
(`field === "allowed_coin_ids"`). Not combinable with `coin_id` (400). An empty array is refused
before the request (`TypeError`) — a filter that found nothing never turns into "every coin".

## Errors

Every non-2xx response is an `ApiError` with `status`, `code` (stable machine code), `message`,
`details`, `field`, `retryAfter` and `requestId`. Transport failures after all retries are a
`NetworkError`. Codes: [Authentication §5](https://cryptolike.net/docs/auth), [API §5](https://cryptolike.net/docs/api).
A payout with a key whose `withdraw` a developer requested and an owner/admin has not approved yet is
`403` `WITHDRAW_PENDING_APPROVAL` (`err.withdrawPendingApproval`): nothing was created, not retried —
approve the request in the cabinet (API keys); the key's other permissions work meanwhile.

```ts
try { await api.invoices.create(body); }
catch (e) {
  if (e instanceof ApiError && e.code === "validation_error") console.log(e.field, e.message);
  else throw e;
}
```

## Retries and idempotency

`429` (after `Retry-After`, or backoff), `5xx` except `501`, and transport errors are retried up to
`maxRetries` (default 3) with `min(retryMaxMs, retryBaseMs · 2^attempt)` full-jitter backoff. Every
`POST` carries an `Idempotency-Key` (yours, or a random UUID generated once per call and reused on
each retry), so a retry never creates a second invoice, address or withdrawal. Each attempt is
signed with a fresh timestamp. A `401 auth.replay` — two identical requests signed within the
same second share a signature — waits for the next second and signs afresh.

## Options

```ts
new CryptoLike({
  keyId, secret,                // default: CRYPTOLIKE_API_KEY_ID / CRYPTOLIKE_API_SECRET
  baseUrl,                      // default: CRYPTOLIKE_API_URL or https://api.cryptolike.net
  timeoutMs: 30_000, maxRetries: 3, retryBaseMs: 500, retryMaxMs: 8_000, retryAfterMaxMs: 30_000,
  apiVersion: "v1",             // X-API-Version pin
  appInfo: "my-shop/2.3",       // appended to User-Agent: cryptolike-sdk-typescript/<version>
  fetch,                        // custom fetch (proxies, tests)
});
```

## Webhook verification

`verifyWebhook(headers, rawBody, secret, { tolerance = 300, now })` returns the parsed event or
throws `WebhookVerificationError` (`reason`: `missing_header` | `invalid_timestamp` |
`timestamp_out_of_tolerance` | `invalid_signature` | `invalid_body`). `headers` may be Node's
`req.headers`, a `Headers` instance or a plain object; `rawBody` must be the bytes as received.
Answer `401`/`400` on failure, `2xx` on success, and deduplicate by `event_id` — deliveries are
at least once and may arrive out of order.
