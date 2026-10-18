import { test } from "node:test";
import assert from "node:assert/strict";
import util from "node:util";
import { CryptoLike, ApiError, WITHDRAW_PENDING_APPROVAL, NetworkError, BrowserSecretError, sign, verifyWebhook, webhookSignature, isWebhookEvent, StaticAddressEvent } from "../src/index.ts";

const SECRET = "kZ1Yv7pQ2xL9mN4tR8wE3uH6jB5cF0aD1gS2hK7lP9o";
const KEY = "ck_test_4f9k2m7p1q8r3s6t0u5v9w2x";

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
}

/** Fake fetch that records requests and answers from a queue (the last answer repeats). */
function fakeFetch(answers: (() => Response | Promise<Response>)[]) {
  const seen: Seen[] = [];
  const sleeps: number[] = [];
  const f: typeof fetch = async (input, init) => {
    seen.push({ url: String(input), method: init?.method ?? "GET", headers: init?.headers as Record<string, string>, body: init?.body as string | undefined });
    const next = answers.length > 1 ? answers.shift()! : answers[0];
    return next();
  };
  return { f, seen, sleeps, sleep: async (ms: number) => void sleeps.push(ms) };
}

function client(fx: ReturnType<typeof fakeFetch>, extra: Partial<ConstructorParameters<typeof CryptoLike>[0]> = {}) {
  return new CryptoLike({ baseUrl: "https://api.test/", keyId: KEY, secret: SECRET, fetch: fx.f, sleep: fx.sleep, now: () => 1758000000, ...extra });
}

test("signs the request target as sent, sets headers, auto-generates Idempotency-Key on POST", async () => {
  const fx = fakeFetch([() => json(201, { id: "inv-1" })]);
  const api = client(fx);
  const body = { amount: "10.50", currency: "USD", order_id: "A-1001" };
  const inv = await api.invoices.create(body);
  assert.equal(inv.id, "inv-1");
  const r = fx.seen[0];
  assert.equal(r.url, "https://api.test/v1/invoices");
  assert.equal(r.method, "POST");
  assert.equal(r.body, JSON.stringify(body));
  assert.equal(r.headers["X-API-Key"], KEY);
  assert.equal(r.headers["X-Timestamp"], "1758000000");
  assert.equal(r.headers["X-Signature"], "7878d965e6eb95b80df12e34e9466d40a8e12aa612653f72760f5dc5c06323a1"); // https://cryptolike.net/docs/auth §3 vector
  assert.equal(r.headers["Content-Type"], "application/json");
  assert.equal(r.headers["X-API-Version"], "v1");
  assert.match(r.headers["User-Agent"], /^cryptolike-sdk-typescript\/\d+\.\d+\.\d+$/);
  assert.match(r.headers["Idempotency-Key"], /^[0-9a-f-]{36}$/);

  await api.invoices.create(body, "order-A-1001");
  assert.equal(fx.seen[1].headers["Idempotency-Key"], "order-A-1001");

  await api.balances.list();
  const g = fx.seen[2];
  assert.equal(g.headers["Idempotency-Key"], undefined);
  assert.equal(g.headers["Content-Type"], undefined);
  assert.equal(g.body, undefined);
  assert.equal(g.headers["X-Signature"], sign(SECRET, 1758000000, "GET", "/v1/balances", ""));

  await api.invoices.list({ status: "paid", from: "2026-09-01T00:00:00Z", limit: 50 });
  assert.equal(fx.seen[3].url, "https://api.test/v1/invoices?status=paid&from=2026-09-01T00%3A00%3A00Z&limit=50");
  assert.equal(fx.seen[3].headers["X-Signature"], sign(SECRET, 1758000000, "GET", "/v1/invoices?status=paid&from=2026-09-01T00%3A00%3A00Z&limit=50", ""));

  await api.invoices.get("4e2bc88c-cb79-4afc-b864-c1ba8e9d50c9");
  assert.equal(fx.seen[4].url, "https://api.test/v1/invoices/4e2bc88c-cb79-4afc-b864-c1ba8e9d50c9");
  await api.invoices.cancel("inv-1");
  assert.equal(fx.seen[5].url, "https://api.test/v1/invoices/inv-1/cancel");
  assert.equal(fx.seen[5].method, "POST");
  assert.ok(fx.seen[5].headers["Idempotency-Key"]);
});

test("every resource hits the documented route", async () => {
  const fx = fakeFetch([() => json(200, { items: [], next_cursor: null, balances: [], currencies: [], rates: [], endpoints: [], allowed_origins: [] })]);
  const api = client(fx);
  const calls: [Promise<unknown>, string, string][] = [
    [api.currencies.list(), "GET", "/v1/currencies"],
    [api.rates.list({ fiat: "EUR" }), "GET", "/v1/rates?fiat=EUR"],
    [api.balances.list(), "GET", "/v1/balances"],
    [api.addresses.create({ coin_id: "c", customer_id: "u1" }), "POST", "/v1/addresses"],
    [api.addresses.get("a1", { limit: 5 }), "GET", "/v1/addresses/a1?limit=5"],
    [api.addresses.list({ customer_id: "u1" }), "GET", "/v1/addresses?customer_id=u1"],
    [api.addresses.archive("a1"), "POST", "/v1/addresses/a1/archive"],
    [api.addresses.restore("a1"), "POST", "/v1/addresses/a1/restore"],
    [api.transactions.list({ kind: "deposit" }), "GET", "/v1/transactions?kind=deposit"],
    [api.transactions.get("t1"), "GET", "/v1/transactions/t1"],
    [api.withdrawals.estimate({ coin_id: "c", amount: "1" }), "POST", "/v1/withdrawals/estimate"],
    [api.withdrawals.create({ coin_id: "c", amount: "1", to_address: "bc1q…", payout_id: "p-1" }), "POST", "/v1/withdrawals"],
    [api.withdrawals.get("w1"), "GET", "/v1/withdrawals/w1"],
    [api.withdrawals.list({ status: "completed" }), "GET", "/v1/withdrawals?status=completed"],
    [api.withdrawals.cancel("w1"), "POST", "/v1/withdrawals/w1/cancel"],
    [api.webhooks.endpoints.list(), "GET", "/v1/webhooks/endpoints"],
    [api.webhooks.endpoints.create({ url: "https://shop.example/hook", events: ["*"] }), "POST", "/v1/webhooks/endpoints"],
    [api.webhooks.endpoints.get("e1"), "GET", "/v1/webhooks/endpoints/e1"],
    [api.webhooks.endpoints.update("e1", { enabled: false }), "PATCH", "/v1/webhooks/endpoints/e1"],
    [api.webhooks.endpoints.delete("e1"), "DELETE", "/v1/webhooks/endpoints/e1"],
    [api.webhooks.endpoints.rotateSecret("e1"), "POST", "/v1/webhooks/endpoints/e1/rotate-secret"],
    [api.webhooks.deliveries.list({ status: "failed" }), "GET", "/v1/webhooks/deliveries?status=failed"],
    [api.webhooks.deliveries.get("d1"), "GET", "/v1/webhooks/deliveries/d1"],
    [api.webhooks.deliveries.retry("d1"), "POST", "/v1/webhooks/deliveries/d1/retry"],
    [api.embed.get(), "GET", "/v1/embed"],
    [api.embed.set({ allowed_origins: ["https://shop.example"] }), "PUT", "/v1/embed"],
  ];
  await Promise.all(calls.map(([p]) => p));
  calls.forEach(([, method, path], i) => {
    assert.equal(fx.seen[i].method, method, path);
    assert.equal(fx.seen[i].url, "https://api.test" + path);
    // The signature covers the exact target and body of the request.
    assert.equal(fx.seen[i].headers["X-Signature"], sign(SECRET, 1758000000, method, path, fx.seen[i].body ?? ""), path);
  });
});

test("addresses.restore: POST /restore with Idempotency-Key, 409 conflict surfaces details", async () => {
  const restored = { id: "a1", status: "active", restored_at: "2026-10-04T10:00:00Z", restore_reason: "manual", archived_at: "2026-10-01T10:00:00Z", archive_reason: "auto" };
  const fx = fakeFetch([
    () => json(200, restored),
    () => json(409, { error: { code: "conflict", message: "customer already has an active address", details: { field: "customer_id", active_address_id: "a2" } } }),
  ]);
  const api = client(fx);
  const a = await api.addresses.restore("a1", "restore-a1");
  assert.equal(a.status, "active");
  assert.equal(a.restore_reason, "manual");
  assert.equal(a.archive_reason, "auto");
  assert.equal(fx.seen[0].method, "POST");
  assert.equal(fx.seen[0].url, "https://api.test/v1/addresses/a1/restore");
  assert.equal(fx.seen[0].headers["Idempotency-Key"], "restore-a1");
  assert.equal(fx.seen[0].body, undefined);
  assert.equal(fx.seen[0].headers["X-Signature"], sign(SECRET, 1758000000, "POST", "/v1/addresses/a1/restore", ""));
  await assert.rejects(api.addresses.restore("a1"), (e: unknown) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.status, 409);
    assert.equal(e.code, "conflict");
    assert.equal(e.field, "customer_id");
    assert.equal(e.details?.active_address_id, "a2");
    return true;
  });
  assert.equal(fx.seen.length, 2);
  assert.match(fx.seen[1].headers["Idempotency-Key"], /^[0-9a-f-]{36}$/);
  assert.deepEqual(fx.sleeps, []);
});

test("withdrawals.create: 403 withdraw_pending_approval is typed and not retried", async () => {
  const fx = fakeFetch([() => json(403, { error: { code: "withdraw_pending_approval", message: "waiting for approval", details: { required: "withdraw" } } })]);
  const api = client(fx);
  await assert.rejects(api.withdrawals.create({ coin_id: "c1", amount: "0.1", to_address: "bc1q" }), (e: unknown) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.status, 403);
    assert.equal(e.code, WITHDRAW_PENDING_APPROVAL);
    assert.equal(e.withdrawPendingApproval, true);
    return true;
  });
  assert.equal(fx.seen.length, 1);
  assert.deepEqual(fx.sleeps, []);
});

test("archiveStaticAddress / restoreStaticAddress / listArchivedStaticAddresses: same signed calls, archive filter forced", async () => {
  const archived = { id: "a1", status: "archived", archived_at: "2026-10-04T10:00:00Z", archive_reason: "manual" };
  const fx = fakeFetch([
    () => json(200, archived),
    () => json(200, { ...archived, status: "active", restored_at: "2026-10-04T11:00:00Z", restore_reason: "manual" }),
    () => json(200, { items: [archived], next_cursor: "c2" }),
    () => json(200, { items: [archived], next_cursor: "c2" }),
    () => json(200, { items: [{ ...archived, id: "a2" }], next_cursor: null }),
    () => json(409, { error: { code: "conflict", message: "customer already has an active address", details: { field: "customer_id", active_address_id: "a9" } } }),
  ]);
  const api = client(fx);
  const a = await api.archiveStaticAddress("a/1", "arch-a1");
  assert.equal(a.status, "archived");
  assert.equal(a.archive_reason, "manual");
  assert.equal(fx.seen[0].method, "POST");
  assert.equal(fx.seen[0].url, "https://api.test/v1/addresses/a%2F1/archive");
  assert.equal(fx.seen[0].headers["Idempotency-Key"], "arch-a1");
  assert.equal(fx.seen[0].body, undefined);
  assert.equal(fx.seen[0].headers["X-Signature"], sign(SECRET, 1758000000, "POST", "/v1/addresses/a%2F1/archive", ""));

  const r = await api.restoreStaticAddress("a1");
  assert.equal(r.status, "active");
  assert.equal(r.restore_reason, "manual");
  assert.equal(fx.seen[1].url, "https://api.test/v1/addresses/a1/restore");
  assert.match(fx.seen[1].headers["Idempotency-Key"], /^[0-9a-f-]{36}$/);

  // status=archived is forced even when the caller passes another one through a cast.
  const page = await api.listArchivedStaticAddresses({ search: "shop", ...({ status: "active" } as object) });
  assert.deepEqual(page.items.map((x) => x.id), ["a1"]);
  assert.equal(page.next_cursor, "c2");
  assert.equal(fx.seen[2].method, "GET");
  assert.equal(fx.seen[2].url, "https://api.test/v1/addresses?search=shop&status=archived");
  assert.equal(fx.seen[2].headers["Idempotency-Key"], undefined);
  assert.equal(fx.seen[2].headers["X-Signature"], sign(SECRET, 1758000000, "GET", "/v1/addresses?search=shop&status=archived", ""));

  const ids: string[] = [];
  for await (const x of api.iterateArchivedStaticAddresses({ coin_id: "c1" })) ids.push(x.id);
  assert.deepEqual(ids, ["a1", "a2"]);
  assert.equal(fx.seen[3].url, "https://api.test/v1/addresses?coin_id=c1&status=archived");
  assert.equal(fx.seen[4].url, "https://api.test/v1/addresses?coin_id=c1&cursor=c2&status=archived");
  assert.equal(fx.seen.length, 5);

  await assert.rejects(api.restoreStaticAddress("a1"), (e: unknown) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.status, 409);
    assert.equal(e.details?.active_address_id, "a9");
    return true;
  });
});

test("isWebhookEvent narrows static_address.* deliveries to their typed data", () => {
  const secret = "whsec_test_static_archive";
  const body = JSON.stringify({
    event_id: "e1",
    type: "static_address.restored",
    created_at: "2026-10-04T10:00:00Z",
    data: {
      address: { id: "a1", address: "TAddr", coin_id: "c1", coin: "USDT", network: "tron", customer_id: "u1", status: "active", total_received: "5", tx_count: 1, created_at: "2026-04-01T00:00:00Z", restore_reason: "deposit" },
      reason: "deposit",
      deposit: { chain_transaction_id: "t1", txid: "ab12", output_index: 0, amount: "5", block_height: 77 },
      conflict_with: "a2",
    },
  });
  const ts = 1758000000;
  const event = verifyWebhook({ "x-timestamp": String(ts), "x-signature": webhookSignature(secret, ts, body) }, body, secret, { now: () => ts });
  assert.equal(isWebhookEvent(event, StaticAddressEvent.Archived), false);
  assert.equal(isWebhookEvent(event, StaticAddressEvent.ArchiveWarning), false);
  assert.ok(isWebhookEvent(event, StaticAddressEvent.Restored));
  if (isWebhookEvent(event, StaticAddressEvent.Restored)) {
    // Typed access, no casts: the compiler checks these field names against the schema.
    assert.equal(event.data.reason, "deposit");
    assert.equal(event.data.deposit?.txid, "ab12");
    assert.equal(event.data.conflict_with, "a2");
    assert.equal(event.data.address.customer_id, "u1");
  }
  assert.deepEqual(Object.values(StaticAddressEvent), ["static_address.archived", "static_address.restored", "static_address.archive_warning"]);
});

test("maps the error envelope to ApiError and does not retry 4xx", async () => {
  const fx = fakeFetch([() => json(400, { error: { code: "validation_error", message: "amount must be positive", details: { field: "amount" } } }, { "x-request-id": "req-1" })]);
  const api = client(fx);
  await assert.rejects(api.invoices.create({ amount: "-1", currency: "USD" }), (e: unknown) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.status, 400);
    assert.equal(e.code, "validation_error");
    assert.equal(e.field, "amount");
    assert.equal(e.requestId, "req-1");
    assert.equal(e.message, "amount must be positive");
    return true;
  });
  assert.equal(fx.seen.length, 1);
  assert.deepEqual(fx.sleeps, []);
});

test("retries 429 honouring Retry-After and 5xx with backoff, same Idempotency-Key, fresh timestamp", async () => {
  let t = 1758000000;
  const fx = fakeFetch([
    () => json(429, { error: { code: "rate_limited", message: "slow down" } }, { "retry-after": "2" }),
    () => json(503, { error: { code: "unavailable", message: "try later" } }),
    () => json(201, { id: "inv-2" }),
  ]);
  const api = client(fx, { now: () => t++, retryBaseMs: 100, retryMaxMs: 400 });
  const inv = await api.invoices.create({ amount: "1", currency: "USD" });
  assert.equal(inv.id, "inv-2");
  assert.equal(fx.seen.length, 3);
  assert.equal(fx.sleeps[0], 2000);
  assert.ok(fx.sleeps[1] >= 0 && fx.sleeps[1] <= 200, `backoff ${fx.sleeps[1]}`);
  const keys = new Set(fx.seen.map((r) => r.headers["Idempotency-Key"]));
  assert.equal(keys.size, 1, "one Idempotency-Key across retries");
  assert.deepEqual(fx.seen.map((r) => r.headers["X-Timestamp"]), ["1758000000", "1758000001", "1758000002"]);
  assert.notEqual(fx.seen[0].headers["X-Signature"], fx.seen[1].headers["X-Signature"]);
});

test("gives up after maxRetries with the last error; 501 and long Retry-After are not retried", async () => {
  const fx = fakeFetch([() => json(502, { error: { code: "unavailable", message: "bad gateway" } })]);
  const api = client(fx, { maxRetries: 2, retryBaseMs: 1 });
  await assert.rejects(api.balances.list(), (e: ApiError) => e.status === 502 && e.code === "unavailable");
  assert.equal(fx.seen.length, 3);

  const fx2 = fakeFetch([() => json(501, { error: { code: "not_implemented", message: "no" } })]);
  await assert.rejects(client(fx2).balances.list(), (e: ApiError) => e.status === 501);
  assert.equal(fx2.seen.length, 1);

  const fx3 = fakeFetch([() => json(429, { error: { code: "rate_limited", message: "no" } }, { "retry-after": "120" })]);
  await assert.rejects(client(fx3).balances.list(), (e: ApiError) => e.status === 429 && e.retryAfter === 120);
  assert.equal(fx3.seen.length, 1);

  const fx4 = fakeFetch([() => json(429, { error: { code: "rate_limited", message: "no" } })]);
  await assert.rejects(client(fx4, { maxRetries: 0 }).balances.list(), (e: ApiError) => e.status === 429);
  assert.equal(fx4.seen.length, 1);
});

test("retries transport errors, then throws NetworkError", async () => {
  let n = 0;
  const fx = fakeFetch([
    () => {
      n++;
      throw new TypeError("fetch failed");
    },
  ]);
  const api = client(fx, { maxRetries: 2, retryBaseMs: 1 });
  await assert.rejects(api.balances.list(), (e: unknown) => e instanceof NetworkError && /fetch failed/.test(e.message));
  assert.equal(n, 3);

  const fx5 = fakeFetch([
    () => {
      throw new TypeError("fetch failed");
    },
    () => json(200, { balances: [] }),
  ]);
  const out = await client(fx5, { retryBaseMs: 1 }).balances.list();
  assert.deepEqual(out.balances, []);
});

test("non-JSON success bodies come back as text (CSV export); empty bodies as undefined", async () => {
  const fx = fakeFetch([
    () => new Response("id,amount\n1,2\n", { status: 200, headers: { "content-type": "text/csv; charset=utf-8" } }),
    () => new Response(null, { status: 204 }),
  ]);
  const api = client(fx);
  assert.equal(await api.transactions.exportCsv({ kind: "deposit" }), "id,amount\n1,2\n");
  assert.equal(fx.seen[0].url, "https://api.test/v1/transactions?kind=deposit&format=csv");
  assert.equal(fx.seen[0].headers.Accept, "text/csv");
  assert.equal(await api.webhooks.endpoints.delete("e1"), undefined);
});

test("iterate follows next_cursor to the end", async () => {
  const fx = fakeFetch([() => json(200, { items: [{ id: "1" }, { id: "2" }], next_cursor: "c2" }), () => json(200, { items: [{ id: "3" }], next_cursor: null })]);
  const api = client(fx);
  const ids: string[] = [];
  for await (const inv of api.invoices.iterate({ status: "paid" })) ids.push(inv.id);
  assert.deepEqual(ids, ["1", "2", "3"]);
  assert.equal(fx.seen[0].url, "https://api.test/v1/invoices?status=paid");
  assert.equal(fx.seen[1].url, "https://api.test/v1/invoices?status=paid&cursor=c2");
});

test("the secret never reaches a debug dump — util.inspect / console.log / JSON.stringify", () => {
  // util.inspect (and therefore console.log / console.dir / %o in a logger) ignores toJSON(),
  // so the secret lives in a #private field and the class has an inspect hook of its own.
  const api = client(fakeFetch([() => json(200, {})]));
  for (const dump of [util.inspect(api), util.inspect(api, { depth: 5, showHidden: true }), util.format("%o", api), util.format("%s", api), JSON.stringify(api)]) {
    assert.ok(!dump.includes(SECRET), `the secret leaked into ${dump}`);
  }
  assert.ok(util.inspect(api).includes("[redacted]"));
  assert.deepEqual(util.inspect(api), util.inspect({ keyId: KEY, baseUrl: "https://api.test", secret: "[redacted]" }));
});

test("caller headers may refine Accept but never replace the signed ones", async () => {
  const fx = fakeFetch([() => json(200, {})]);
  const api = client(fx);
  await api.request("GET", "/v1/balances", { headers: { Accept: "text/csv", "x-api-key": "ck_live_attacker", "X-Signature": "deadbeef", "x-timestamp": "1" } });
  const h = fx.seen[0].headers;
  assert.equal(h.Accept, "text/csv");
  assert.equal(h["X-API-Key"], KEY);
  assert.equal(h["X-Timestamp"], "1758000000");
  assert.equal(h["X-Signature"], sign(SECRET, 1758000000, "GET", "/v1/balances", ""));
  // No lower-case twin either: fetch would join duplicates into one comma-separated header.
  assert.deepEqual(Object.keys(h).filter((k) => /^x-(api-key|signature|timestamp)$/i.test(k)).sort(), ["X-API-Key", "X-Signature", "X-Timestamp"]);
});

test("a retry inside the same second is signed afresh (never a self-inflicted auth.replay)", async () => {
  // The server takes the replay slot before the handler runs, so a 5xx has already spent it:
  // repeating the same signature would turn a 500 into `401 auth.replay`. Only sleeping moves
  // this clock, so the backoff alone (≤ 10 ms) cannot reach the next second.
  let t = 1758000000;
  const fx = fakeFetch([() => json(503, { error: { code: "unavailable", message: "later" } }), () => json(200, { balances: [] })]);
  const api = client(fx, {
    now: () => t,
    sleep: async (ms: number) => {
      fx.sleeps.push(ms);
      t += ms / 1000;
    },
    retryBaseMs: 10,
    retryMaxMs: 10,
  });
  assert.deepEqual((await api.balances.list()).balances, []);
  assert.equal(fx.seen.length, 2);
  assert.equal(fx.seen[0].headers["X-Timestamp"], "1758000000");
  assert.equal(fx.seen[1].headers["X-Timestamp"], "1758000001");
  assert.notEqual(fx.seen[0].headers["X-Signature"], fx.seen[1].headers["X-Signature"]);
  assert.equal(fx.seen[1].headers["X-Signature"], sign(SECRET, 1758000001, "GET", "/v1/balances", ""));
  assert.ok(fx.sleeps[1] > 0 && fx.sleeps[1] <= 1010, `wait for the next second: ${fx.sleeps[1]}`);
});

test("credentials come from the environment when not given; the secret is never serialised", () => {
  process.env.CRYPTOLIKE_API_KEY_ID = KEY;
  process.env.CRYPTOLIKE_API_SECRET = SECRET;
  process.env.CRYPTOLIKE_API_URL = "https://api.env.test";
  try {
    const api = new CryptoLike({ fetch: fakeFetch([() => json(200, {})]).f });
    assert.deepEqual(api.toJSON(), { keyId: KEY, baseUrl: "https://api.env.test", secret: "[redacted]" });
    assert.ok(!JSON.stringify(api).includes(SECRET));
  } finally {
    delete process.env.CRYPTOLIKE_API_KEY_ID;
    delete process.env.CRYPTOLIKE_API_SECRET;
    delete process.env.CRYPTOLIKE_API_URL;
  }
  assert.throws(() => new CryptoLike({ keyId: KEY }), /secret is required/);
  assert.throws(() => new CryptoLike({ secret: SECRET }), /keyId is required/);
});

test("refuses to run in a browser", () => {
  const g = globalThis as { window?: unknown; document?: unknown };
  g.window = {};
  g.document = {};
  try {
    assert.throws(() => new CryptoLike({ keyId: KEY, secret: SECRET }), BrowserSecretError);
  } finally {
    delete g.window;
    delete g.document;
  }
});

test("401 auth.replay (same signature within one second) waits for the next second and re-signs; other 401s are not retried", async () => {
  let t = 1758000000;
  const fx = fakeFetch([() => json(401, { error: { code: "auth.replay", message: "this request was already accepted" } }), () => json(200, { balances: [] })]);
  const api = client(fx, { now: () => t++ });
  assert.deepEqual((await api.balances.list()).balances, []);
  assert.equal(fx.seen.length, 2);
  assert.ok(fx.sleeps[0] > 0 && fx.sleeps[0] <= 1010, `sleep ${fx.sleeps[0]}`);
  assert.notEqual(fx.seen[0].headers["X-Signature"], fx.seen[1].headers["X-Signature"]);

  const fx2 = fakeFetch([() => json(401, { error: { code: "auth.invalid_signature", message: "no" } })]);
  await assert.rejects(client(fx2).balances.list(), (e: ApiError) => e.status === 401 && e.code === "auth.invalid_signature");
  assert.equal(fx2.seen.length, 1);
});

test("allowed_coin_ids — sent as given, read back, 422 not retried, empty array refused locally", async () => {
  const fx = fakeFetch([
    () => json(201, { id: "inv-2", coin_id: null, allowed_coin_ids: ["c-1", "c-2"] }),
    () => json(201, { id: "inv-3", allowed_coin_ids: null }),
    () => json(422, { error: { code: "no_allowed_coins", message: "none left", details: { field: "allowed_coin_ids" } } }),
    () => json(200, { currencies: [{ id: "c-1", invoice_enabled: true }, { id: "c-9", invoice_enabled: false }, { id: "c-0" }] }),
  ]);
  const api = client(fx);
  const inv = await api.invoices.create({ amount: "25", currency: "USD", allowed_coin_ids: ["c-1", "c-2"] });
  assert.equal(fx.seen[0].body, '{"amount":"25","currency":"USD","allowed_coin_ids":["c-1","c-2"]}');
  assert.deepEqual(inv.allowed_coin_ids, ["c-1", "c-2"]);

  const all = await api.invoices.create({ amount: "25", currency: "USD" });
  assert.ok(!fx.seen[1].body!.includes("allowed_coin_ids"));
  assert.equal(all.allowed_coin_ids, null);

  await assert.rejects(api.invoices.create({ amount: "25", currency: "BTC", allowed_coin_ids: ["c-1"] }), (e: unknown) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.status, 422);
    assert.equal(e.code, "no_allowed_coins");
    assert.equal(e.field, "allowed_coin_ids");
    return true;
  });
  assert.equal(fx.seen.length, 3);
  assert.deepEqual(fx.sleeps, []);

  await assert.rejects(api.invoices.create({ amount: "25", currency: "USD", allowed_coin_ids: [] }), TypeError);
  assert.equal(fx.seen.length, 3, "an empty set never reaches the API (it would read as every coin)");

  const cur = await api.currencies.list();
  assert.deepEqual(cur.currencies.map((c) => c.invoice_enabled), [true, false, undefined]);
});
