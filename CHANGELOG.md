# Changelog

All notable changes of this SDK. Versions follow SemVer; the API contract itself (v1) changes only
additively — see https://cryptolike.net/docs/api.

## 0.2.0 — 2026-10-22

- Your own payment page (host-to-host, https://cryptolike.net/docs/h2h):
  - `invoices.coinOptions(id)` — the coins the payer may choose for an invoice created without a coin, each with an
    informative ≈ amount (`GET /v1/invoices/{id}/coin-options`).
  - `invoices.selectCoin(id, coinId, idempotencyKey?)` — fixes the payer's choice (`POST /v1/invoices/{id}/coin`) with an `Idempotency-Key`
    (yours or a generated UUID, the same on every retry) and returns the updated invoice.
  - `Invoice`: `payment_uri`, `qr_payload`, `confirmations`, `required_confirmations` (types from the API spec); exported types `InvoiceCoinOptions`, `CoinOption`.
  - README: "Your own payment page (host-to-host)".
  - `qr_payload` is the bare deposit address on every network, Bitcoin and Litecoin included (an exchange withdrawal form refuses a
    `bitcoin:…?amount=…` URI); the amount lives in `payment_uri` — "Open in wallet" and an opt-in "QR with amount" for wallets.
- README: the package is ESM only — `import`, or `await import("cryptolike")` from CommonJS.
- Request signing and webhook verification are unchanged (`testdata/vectors.json` is the same).

## 0.1.0 — 2026-10-18

- First public release on npm, as the package `cryptolike` (`npm install cryptolike`). ESM only: load it with
  `import` (Node.js ≥ 18); `require("cryptolike")` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`.
