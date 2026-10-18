import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sign, canonicalString, bodySha256, verifyWebhook, webhookSignature, WebhookVerificationError } from "../src/index.ts";

// testdata/vectors.json — the reference vectors generated from the platform's own signer
// (published at https://cryptolike.net/docs/sdk/vectors.json).
interface Vectors {
  webhook: { vectors: { name: string; secret: string; timestamp: number; body: string; headers: Record<string, string>; signature: string; valid: boolean }[] };
  api_request: { vectors: { name: string; secret: string; timestamp: number; method: string; path_query: string; body: string; body_sha256: string; canonical_string: string; signature: string }[] };
}
const vectors = JSON.parse(readFileSync(fileURLToPath(new URL("../testdata/vectors.json", import.meta.url)), "utf8")) as Vectors;

test("api_request vectors: body hash, canonical string and signature", () => {
  assert.ok(vectors.api_request.vectors.length >= 6);
  for (const v of vectors.api_request.vectors) {
    assert.equal(bodySha256(v.body), v.body_sha256, v.name);
    assert.equal(canonicalString(v.timestamp, v.method, v.path_query, v.body), v.canonical_string, v.name);
    assert.equal(sign(v.secret, v.timestamp, v.method, v.path_query, v.body), v.signature, v.name);
    // Bytes and strings sign the same.
    assert.equal(sign(v.secret, String(v.timestamp), v.method.toLowerCase(), v.path_query, Buffer.from(v.body, "utf8")), v.signature, v.name);
  }
});

test("webhook vectors: valid ones verify, invalid ones are rejected", () => {
  const valid = vectors.webhook.vectors.filter((v) => v.valid);
  const invalid = vectors.webhook.vectors.filter((v) => !v.valid);
  assert.ok(valid.length >= 5 && invalid.length >= 4);
  for (const v of valid) {
    assert.equal(webhookSignature(v.secret, v.timestamp, v.body), v.signature, v.name);
    const ev = verifyWebhook(v.headers, Buffer.from(v.body, "utf8"), v.secret, { now: () => v.timestamp });
    assert.equal(ev.event_id, v.headers["X-Event-Id"], v.name);
    assert.equal(ev.type, v.headers["X-Event-Type"], v.name);
    // Headers as Node lower-cases them, and as a Headers instance; body as a string.
    const lower = Object.fromEntries(Object.entries(v.headers).map(([k, val]) => [k.toLowerCase(), val]));
    assert.equal(verifyWebhook(lower, v.body, v.secret, { now: () => v.timestamp }).event_id, ev.event_id, v.name);
    assert.equal(verifyWebhook(new Headers(v.headers), v.body, v.secret, { tolerance: null }).event_id, ev.event_id, v.name);
  }
  for (const v of invalid) {
    assert.throws(
      () => verifyWebhook(v.headers, Buffer.from(v.body, "utf8"), v.secret, { now: () => v.timestamp }),
      (e: unknown) => e instanceof WebhookVerificationError && e.reason === "invalid_signature",
      v.name,
    );
  }
});

test("webhook: timestamp tolerance, missing headers, malformed values", () => {
  const v = vectors.webhook.vectors[0];
  const body = Buffer.from(v.body, "utf8");
  // Default tolerance 300 s: 301 s late is rejected, 300 s is accepted.
  assert.throws(() => verifyWebhook(v.headers, body, v.secret, { now: () => v.timestamp + 301 }), (e: WebhookVerificationError) => e.reason === "timestamp_out_of_tolerance");
  assert.throws(() => verifyWebhook(v.headers, body, v.secret, { now: () => v.timestamp - 301 }), (e: WebhookVerificationError) => e.reason === "timestamp_out_of_tolerance");
  assert.ok(verifyWebhook(v.headers, body, v.secret, { now: () => v.timestamp + 300 }));
  assert.throws(() => verifyWebhook(v.headers, body, v.secret, { now: () => v.timestamp + 61, tolerance: 60 }), (e: WebhookVerificationError) => e.reason === "timestamp_out_of_tolerance");
  // Wall clock: the vector is from 2023 → rejected without a clock override.
  assert.throws(() => verifyWebhook(v.headers, body, v.secret), (e: WebhookVerificationError) => e.reason === "timestamp_out_of_tolerance");

  const without = (name: string) => Object.fromEntries(Object.entries(v.headers).filter(([k]) => k !== name));
  assert.throws(() => verifyWebhook(without("X-Signature"), body, v.secret, { tolerance: null }), (e: WebhookVerificationError) => e.reason === "missing_header");
  assert.throws(() => verifyWebhook(without("X-Timestamp"), body, v.secret, { tolerance: null }), (e: WebhookVerificationError) => e.reason === "missing_header");
  assert.throws(() => verifyWebhook({ ...v.headers, "X-Timestamp": "1700000000.5" }, body, v.secret, { tolerance: null }), (e: WebhookVerificationError) => e.reason === "invalid_timestamp");
  assert.throws(() => verifyWebhook({ ...v.headers, "X-Timestamp": "1700000000000" }, body, v.secret, { tolerance: null }), (e: WebhookVerificationError) => e.reason === "invalid_signature");
  assert.throws(() => verifyWebhook({ ...v.headers, "X-Signature": "sha256=" }, body, v.secret, { tolerance: null }), (e: WebhookVerificationError) => e.reason === "invalid_signature");
  assert.throws(() => verifyWebhook(v.headers, body, "", { tolerance: null }), (e: WebhookVerificationError) => e.reason === "invalid_signature");
  // Re-serialised JSON (different bytes) must not verify.
  assert.throws(() => verifyWebhook(v.headers, JSON.stringify(JSON.parse(v.body), null, 2), v.secret, { tolerance: null }), (e: WebhookVerificationError) => e.reason === "invalid_signature");
  // A signed body that is not an event object is rejected after the signature check.
  const junk = "[1,2,3]";
  assert.throws(() => verifyWebhook({ "X-Timestamp": "1700000000", "X-Signature": webhookSignature(v.secret, 1700000000, junk) }, junk, v.secret, { tolerance: null }), (e: WebhookVerificationError) => e.reason === "invalid_body");
});
