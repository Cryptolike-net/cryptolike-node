/**
 * cryptolike — server-side SDK for the CryptoLike merchant API.
 *
 * - `CryptoLike` — signed client (`X-API-Key` / `X-Timestamp` / `X-Signature`, https://cryptolike.net/docs/auth),
 *   automatic `Idempotency-Key` on POST, retries with backoff on 429 / 5xx / transport errors,
 *   typed resources generated from the OpenAPI document of the API (https://cryptolike.net/docs/api).
 * - `verifyWebhook` — signature + timestamp check of a webhook delivery (https://cryptolike.net/docs/webhooks §3);
 *   `isWebhookEvent` narrows it to a typed event (`static_address.*`).
 * - `sign` — the request signature alone, for custom HTTP stacks.
 *
 * The API secret must stay on your server. The constructor throws `BrowserSecretError` in a browser.
 */
export { CryptoLike } from "./client.js";
export type {
  ClientOptions,
  RequestOptions,
  Page,
  Result,
  Query,
  Schemas,
  Invoice,
  InvoiceDetail,
  InvoiceStatus,
  CreateInvoiceRequest,
  StaticAddress,
  StaticAddressCard,
  CreateAddressRequest,
  Transaction,
  Balance,
  Currency,
  Rate,
  Withdrawal,
  WithdrawalStatus,
  WithdrawalEstimate,
  CreateWithdrawalRequest,
  EstimateWithdrawalRequest,
  WebhookEndpoint,
  WebhookEndpointCreated,
  CreateWebhookEndpointRequest,
  UpdateWebhookEndpointRequest,
  WebhookDelivery,
  EmbedSettings,
} from "./client.js";
export { ApiError, NetworkError, BrowserSecretError, WebhookVerificationError, WITHDRAW_PENDING_APPROVAL } from "./errors.js";
export type { ApiErrorBody, WebhookRejectReason } from "./errors.js";
export { sign, canonicalString, bodySha256, isBrowser } from "./sign.js";
export { verifyWebhook, webhookSignature, isWebhookEvent, StaticAddressEvent } from "./webhook.js";
export type {
  VerifyWebhookOptions,
  WebhookEvent,
  WebhookHeaders,
  WebhookEventType,
  WebhookEventDataMap,
  StaticAddressArchivedData,
  StaticAddressRestoredData,
  StaticAddressArchiveWarningData,
  WebhookStaticAddress,
} from "./webhook.js";
export { VERSION, USER_AGENT } from "./version.js";
export type { components, operations, paths } from "./schema.js";
